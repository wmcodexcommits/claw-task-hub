// Statement-cache regression.
//
// Runs in a spawned worker with CLAW_TASK_HUB_DB pointed at a temp file, the
// same shape as store-regression.mjs, because server/db.ts opens its handle at
// import time and managed databases are created next to the configured path.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { removeTemporaryDirectory } from "./temp-dir.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.env.CLAW_TASK_HUB_CACHE_WORKER !== "1") {
  const parentTempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-cache-"));
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAW_TASK_HUB_DB: join(parentTempDir, "test.sqlite"),
      CLAW_TASK_HUB_QUIET_DB: "1",
      CLAW_TASK_HUB_CACHE_WORKER: "1",
    },
    stdio: "inherit",
    windowsHide: true,
  });
  let cleanupFailed = false;
  try {
    removeTemporaryDirectory(parentTempDir);
  } catch (error) {
    cleanupFailed = true;
    console.error("Statement cache cleanup failed after the worker exited:", error);
  }
  process.exit(cleanupFailed ? 1 : result.status ?? 1);
}

if (!process.env.CLAW_TASK_HUB_DB) throw new Error("Statement cache worker requires CLAW_TASK_HUB_DB");

const {
  DEFAULT_STATEMENT_CACHE_LIMIT,
  clearStatementCache,
  prepareCached,
  statementCacheStats,
} = await import("../server/statement-cache.ts");

// --- unit: reuse, LRU eviction, and finalize-on-evict, with no database ------

{
  const key = {};
  let compiled = 0;
  const finalized = [];
  const compile = (sql) => {
    compiled += 1;
    return { all: () => [], get: () => undefined, run: () => ({ changes: 0, lastInsertRowid: 0 }), finalize: () => finalized.push(sql) };
  };

  const first = prepareCached(key, "SELECT 1", compile);
  const second = prepareCached(key, "SELECT 1", compile);
  assert(first === second, "the same SQL must return the same cached statement");
  assert(compiled === 1, `repeated SQL must compile once, compiled ${compiled} times`);
  assert(statementCacheStats(key).hits === 1, "a repeat lookup must count as a hit");

  // A cache keyed on another object must not see the first key's statements.
  const otherKey = {};
  prepareCached(otherKey, "SELECT 1", compile);
  assert(compiled === 2, "a different key must compile its own statement");
}

{
  // Eviction: least recently used goes first, and the evicted statement is
  // finalized rather than leaked.
  const key = {};
  const finalized = [];
  const compile = (sql) => ({
    all: () => [],
    get: () => undefined,
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    finalize: () => finalized.push(sql),
  });

  prepareCached(key, "A", compile, 2);
  prepareCached(key, "B", compile, 2);
  prepareCached(key, "A", compile, 2); // A is now the most recently used
  prepareCached(key, "C", compile, 2); // evicts B

  const stats = statementCacheStats(key);
  assert(stats.size === 2, `cache must stay at its limit, size ${stats.size}`);
  assert(stats.evictions === 1, `expected 1 eviction, saw ${stats.evictions}`);
  assert(finalized.length === 1 && finalized[0] === "B", `LRU must evict B, finalized ${JSON.stringify(finalized)}`);
}

{
  // A finalize that throws must not propagate: the statement is discarded either
  // way and the caller's query is unrelated to it.
  const key = {};
  const compile = () => ({
    all: () => [],
    get: () => undefined,
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    finalize: () => {
      throw new Error("finalize failed");
    },
  });
  prepareCached(key, "A", compile, 1);
  prepareCached(key, "B", compile, 1);
  clearStatementCache(key);
  assert(statementCacheStats(key).size === 0, "clear must empty the cache even when finalize throws");
}

// --- integration: the live handle caches, and survives an activation swap ----

const dbModule = await import("../server/db.ts");
const store = await import("../server/store.ts");

dbModule.initializeDatabase(dbModule.db);
dbModule.runMigrations(dbModule.db);
await store.ensureDefaultTeam();

const project = await store.upsertProject({ external_id: "cache-project", name: "Cache", summary: "Cache project" });
const issue = await store.upsertIssue({
  title: "Cache issue",
  identifier: "CTH-940001",
  status: "Todo",
  project_id: project.id,
});

// Reading the same issue repeatedly must hit the cache and keep returning the
// same row: a shared prepared statement must not carry state between runs.
const first = await store.getIssue(issue.id);
const second = await store.getIssue(issue.id);
assert(first && second, "getIssue must return the seeded issue");
assert(first.identifier === "CTH-940001", `unexpected identifier ${first.identifier}`);
assert(JSON.stringify(first) === JSON.stringify(second), "repeated getIssue must return identical rows");

const liveStats = statementCacheStats(dbModule.db);
assert(liveStats.hits > 0, "the live handle must be routing prepare() through the cache");
assert(liveStats.size > 0 && liveStats.size <= DEFAULT_STATEMENT_CACHE_LIMIT, `cache size ${liveStats.size} out of range`);

// The swap hazard: db.ts closes the outgoing handle with close(true), which
// throws rather than closing over live statements. Activating another database
// with a populated cache must still succeed, and must actually switch files.
const originalPath = dbModule.dbPath;
const originalId = dbModule.listManagedDatabases().active.id;

// createManagedDatabase also activates, so this call is itself the hazard: it
// closes a handle whose cache is populated from the getIssue reads above.
const created = dbModule.createManagedDatabase("Cache Swap Target");
const targetId = created.active.id;
assert(targetId && targetId !== originalId, `create must activate a new database, got ${JSON.stringify(created.active)}`);
assert(dbModule.dbPath !== originalPath, "creating a managed database must change the active path");

// The substantive property: the cache must not survive the swap as statements
// bound to the closed handle. A stale statement would still read the old file,
// so the new database must not see the issue written before the swap.
dbModule.initializeDatabase(dbModule.db);
dbModule.runMigrations(dbModule.db);
assert(
  !await store.getIssue(issue.id),
  "the activated database must not return the previous database's issue -- a cached statement outlived its handle",
);

// And it must be usable in its own right.
await store.ensureDefaultTeam();
assert((await store.listTeams()).length > 0, "the activated database must be queryable after the swap");
assert(statementCacheStats(dbModule.db).size > 0, "the activated handle must populate its own cache");

// Now switch back with the explicit API, again over a populated cache, and
// confirm the original database still holds the row written before the swap.
dbModule.activateManagedDatabase(originalId);
assert(dbModule.dbPath === originalPath, "activation must return to the original database path");
const afterRoundTrip = await store.getIssue(issue.id);
assert(afterRoundTrip?.identifier === "CTH-940001", "the original database must still hold its issue after a round trip");

console.log("Statement cache regression passed");
