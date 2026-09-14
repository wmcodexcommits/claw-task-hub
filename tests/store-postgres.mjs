// Postgres store regression -- opt-in, needs a live server.
//
// The SQLite suites cannot see the ways the store layer breaks on Postgres,
// because every one of them is a Postgres-only failure: a stacked ON CONFLICT is
// a syntax error there, a nullable parameter used first in IS NOT NULL cannot be
// typed, COUNT(*) arrives as a string, and fts5 does not exist. A stand-in
// client cannot reproduce any of that, so this runs the real store functions
// against a real server through the same activation path the UI uses.
//
// Set CLAW_TASK_HUB_PG_TEST_URL to an EMPTY database whose name starts with
// "cth_test". The name check is a guard: this suite writes rows and must never
// be pointed at a database someone is using. Without the variable it skips, so
// the canonical gate stays runnable on machines with no Postgres.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { removeTemporaryDirectory } from "./temp-dir.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const testUrl = process.env.CLAW_TASK_HUB_PG_TEST_URL?.trim();
if (!testUrl) {
  console.log("Postgres store regression skipped: set CLAW_TASK_HUB_PG_TEST_URL to an empty cth_test* database to run it");
  process.exit(0);
}
const databaseName = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ""));
if (!databaseName.startsWith("cth_test")) {
  console.error(`Refusing to run: CLAW_TASK_HUB_PG_TEST_URL names database "${databaseName}", not a cth_test* database`);
  process.exit(1);
}

if (process.env.CLAW_TASK_HUB_STORE_WORKER !== "1") {
  const parentTempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-store-postgres-"));
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAW_TASK_HUB_DB: join(parentTempDir, "local.sqlite"),
      CLAW_TASK_HUB_CONNECTIONS_FILE: join(parentTempDir, "connections.json"),
      CLAW_TASK_HUB_STORE_WORKER: "1",
    },
    stdio: "inherit",
    windowsHide: true,
  });
  removeTemporaryDirectory(parentTempDir);
  process.exit(result.status ?? 1);
}

const tempDir = dirname(process.env.CLAW_TASK_HUB_DB);
const dbModule = await import("../server/db.ts");
const connections = await import("../server/db-connections.ts");
const store = await import("../server/store.ts");

let failed = false;
try {
  // --- activation --------------------------------------------------------

  const localId = dbModule.listManagedDatabases().active.id;
  const registered = connections.registerExternalConnection({
    name: "store-postgres",
    kind: "postgres",
    connectionStringEnv: "CLAW_TASK_HUB_PG_TEST_URL",
    ssl: process.env.CLAW_TASK_HUB_PG_TEST_SSL !== "0",
  });
  const externalId = `external:${registered.id}`;
  const activated = await dbModule.activateDatabase(externalId);
  assert(activated.active.id === externalId, `activation did not make the connection active: ${JSON.stringify(activated.active)}`);
  assert(activated.active.engine === "postgres", "active external database is not reported as postgres");
  assert(!activated.active.path.includes("://"), "the catalogue exposed a connection string");
  assert(!activated.databases.some((database) => database.active), "a local database is still marked active beside the external one");
  assert(dbModule.adapter.kind === "postgres", "store adapter did not switch to Postgres");

  // Every process reads the one selection: a fresh process opens the external
  // connection at startup, and the one-shot CLI exits instead of hanging on the
  // open pool.
  const probe = spawnSync(process.execPath, ["-e", 'const m = await import("./server/db.ts"); console.log(`kind=${m.adapter.kind}`); await m.closeActiveDatabase();'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert(probe.status === 0 && probe.stdout.includes("kind=postgres"), `a new process did not pick up the selected connection:\n${probe.stdout}\n${probe.stderr}`);
  assert(probe.stderr.includes("[selected external connection]"), `startup did not announce the selected connection:\n${probe.stderr}`);
  const cli = spawnSync(process.execPath, ["server/hub-cli.ts", "tools/call", "list_databases", "{}"], {
    cwd: process.cwd(),
    env: { ...process.env, CLAW_TASK_HUB_QUIET_DB: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert(cli.status === 0, `hub CLI did not exit cleanly on the external connection (status ${cli.status}, signal ${cli.signal}):\n${cli.stderr}`);
  assert(JSON.parse(cli.stdout).active.id === externalId, "hub CLI did not report the selected external connection as active");

  // --- teams and projects: multi-key upserts ------------------------------

  await store.ensureDefaultTeam();
  await store.ensureDefaultTeam();

  const project = await store.upsertProject({
    external_id: "pg-project",
    name: "Postgres Project",
    status: "In Progress",
    priority: 2,
    lead: "Postgres Agent",
    target_date: "2026-12-15",
  });
  const partial = await store.upsertProject({ external_id: "pg-project", summary: "Partial by external id" });
  assert(partial.id === project.id, "upsert by external_id created a duplicate project");
  assert(partial.lead === "Postgres Agent" && partial.summary === "Partial by external id", "partial project upsert lost fields");
  const renamed = await store.upsertProject({ id: project.id, external_id: "pg-project-renamed", summary: "Assigned by id" });
  assert(renamed.id === project.id && renamed.external_id === "pg-project-renamed", "upsert by id did not update external_id in place");
  const nullA = await store.upsertProject({ id: "pg_null_external_a", name: "Null External A" });
  const nullB = await store.upsertProject({ id: "pg_null_external_b", name: "Null External B" });
  assert(nullA.id !== nullB.id && nullB.name === "Null External B", "null external ids collided");

  const update = await store.saveProjectUpdate({ external_id: "pg-update", project_id: project.id, body: "First", health: "on_track" });
  const updateAgain = await store.saveProjectUpdate({ external_id: "pg-update", project_id: project.id, body: "Second", health: "at_risk" });
  assert(updateAgain.id === update.id && updateAgain.body === "Second", "project update upsert by external_id created a duplicate");

  // --- issues -------------------------------------------------------------

  const target = await store.upsertIssue({ title: "Postgres dependency target", status: "Todo", project_id: project.id, labels: ["pg"] });
  const blocker = await store.upsertIssue({ title: "Postgres blocker issue", status: "Todo", project_id: project.id });
  assert(/^[A-Z][A-Z0-9]{1,8}-\d{1,6}$/.test(String(target.identifier)), `issue identifier was not allocated: ${target.identifier}`);
  assert(target.identifier !== blocker.identifier, "two issues received the same identifier");
  const started = await store.upsertIssue({ id: target.id, status: "In Progress" });
  assert(started.status_type === "started", `status_type was not derived on update: ${started.status_type}`);
  const externalIssue = await store.upsertIssue({ external_id: "pg-issue", title: "External issue", status: "Todo", project_id: project.id });
  const externalAgain = await store.upsertIssue({ external_id: "pg-issue", title: "External issue renamed", project_id: project.id });
  assert(externalAgain.id === externalIssue.id && externalAgain.title === "External issue renamed", "issue upsert by external_id created a duplicate");

  // --- dependencies: all three conflict keys, and the recursive cycle CTE ---

  const dependency = await store.saveIssueDependency({ external_id: "pg-dependency", issue_id: target.identifier, blocker_issue_id: blocker.identifier, reason: "First" });
  const samePair = await store.saveIssueDependency({ issue_id: target.identifier, blocker_issue_id: blocker.identifier, reason: "Second" });
  assert(samePair.id === dependency.id && samePair.reason === "Second", "re-saving the same dependency pair created a duplicate");
  let cycleMessage = "";
  try {
    await store.saveIssueDependency({ issue_id: blocker.identifier, blocker_issue_id: target.identifier });
  } catch (error) {
    cycleMessage = error instanceof Error ? error.message : String(error);
  }
  assert(cycleMessage.includes("cycle"), `dependency cycle was not rejected: ${cycleMessage}`);
  assert((await store.getIssue(target.identifier))?.status_type === "blocked", "an open dependency did not block its target");
  assert((await store.listIssues({ project_id: project.id, blocked: true })).some((issue) => issue.id === target.id), "blocked filter missed the target");
  const detail = await store.getProject(project.id);
  assert(detail?.counts.blockers === 1, `project blocker count is wrong or not a number: ${JSON.stringify(detail?.counts)}`);
  assert((await store.resolveIssueDependency({ dependency_id: dependency.id })).resolved === true, "dependency did not resolve");

  // --- comments -------------------------------------------------------------

  const comment = await store.saveComment({ issue_id: target.id, external_id: "pg-comment", body: "First", author: "Postgres Agent" });
  const commentAgain = await store.saveComment({ issue_id: target.id, external_id: "pg-comment", body: "Second", author: "Postgres Agent" });
  assert(commentAgain.id === comment.id && commentAgain.body === "Second", "comment upsert by external_id created a duplicate");

  // --- search and value shapes ----------------------------------------------

  assert((await store.listIssues({ project_id: project.id, query: "blocker", limit: 10 })).some((issue) => issue.id === blocker.id), "full-text search missed a title word");
  const byIdentifier = await store.listIssues({ project_id: project.id, query: String(target.identifier), limit: 10 });
  assert(byIdentifier[0]?.id === target.id, "identifier search did not rank the exact identifier first");
  await store.listIssues({ query: 'blocker "unterminated -x OR (', limit: 10 });

  const listed = (await store.listProjects()).find((row) => row.id === project.id);
  assert(typeof listed?.issue_count === "number" && listed.issue_count === 3, `issue_count must be the number 3, saw ${JSON.stringify(listed?.issue_count)}`);
  assert(typeof listed?.done_count === "number", `done_count must be a number, saw ${JSON.stringify(listed?.done_count)}`);
  await store.dashboard();

  assert((await store.deleteIssue({ id: externalIssue.id, confirm: true })).deleted === true, "issue delete did not report deletion");

  // --- back to local, and an unreachable connection is refused --------------

  const local = await dbModule.activateDatabase(localId);
  assert(local.active.id === localId && local.active.engine === "sqlite", "switching back did not make the local database active");
  assert(dbModule.adapter.kind === "sqlite", "store adapter did not switch back to SQLite");

  const unreachable = connections.registerExternalConnection({ name: "unset", kind: "postgres", connectionStringEnv: "CLAW_TASK_HUB_PG_TEST_UNSET_VARIABLE" });
  let refused = "";
  try {
    await dbModule.activateDatabase(`external:${unreachable.id}`);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  assert(refused.includes("is not set"), `an unusable connection was not refused: ${refused}`);
  assert(dbModule.listManagedDatabases().active.id === localId, "a refused activation changed the active database");
  assert(dbModule.adapter.kind === "sqlite", "a refused activation changed the store adapter");
} catch (error) {
  failed = true;
  console.error("Postgres store regression failed:", error);
} finally {
  await dbModule.closeActiveDatabase().catch(() => undefined);
}

if (!failed) console.log(`Postgres store regression passed (database ${databaseName}, scratch ${tempDir})`);
process.exit(failed ? 1 : 0);
