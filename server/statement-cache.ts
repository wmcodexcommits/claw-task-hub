// Prepared-statement cache for the synchronous bun:sqlite handles.
//
// store.ts calls `db.prepare(...)` inline on every query -- 91 call sites -- so
// each request recompiles its SQL from scratch. Compilation, not execution,
// dominates the cost of the small single-row reads this app makes constantly
// (issue lookups, claim checks, session heartbeats).
//
// Three properties drive the design:
//
//   1. The cache is keyed by an explicit key object -- in practice the database
//      instance -- and compiles through a caller-supplied function. server/db.ts
//      shadows `prepare` on the handle to route through this cache, so the cache
//      cannot call `database.prepare` itself without recursing into its own
//      wrapper. Taking the compile step as an argument keeps that unambiguous
//      and keeps `clearStatementCache(database)` keyed on the same object.
//
//   2. The cache is per-instance, not a module global. server/db.ts exports `db`
//      as a mutable binding and swaps it when a managed database is activated,
//      closing the old handle. A statement belongs to the handle that compiled
//      it, so a per-instance cache means an activation starts empty instead of
//      handing out statements pointing at a closed database.
//
//   3. The cache is bounded. Most SQL here is a string literal, but listIssues()
//      assembles `WHERE ... ORDER BY ...` from the active filters, so the text
//      varies with the filter combination and the key space is combinatorial
//      rather than fixed. An unbounded map would hold a compiled statement for
//      every combination anyone ever filtered by.

export type CachedStatement = {
  all: (...bindings: unknown[]) => unknown[];
  get: (...bindings: unknown[]) => unknown;
  run: (...bindings: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  finalize?: () => void;
};

export const DEFAULT_STATEMENT_CACHE_LIMIT = 256;

type CacheEntry = {
  statements: Map<string, CachedStatement>;
  limit: number;
  hits: number;
  misses: number;
  evictions: number;
};

// WeakMap so a closed-and-dropped database takes its cache with it. Holding the
// handles strongly would keep every database a long-lived process ever
// activated alive for the life of the process.
const caches = new WeakMap<object, CacheEntry>();

function entryFor(key: object, limit: number): CacheEntry {
  let entry = caches.get(key);
  if (!entry) {
    entry = { statements: new Map(), limit, hits: 0, misses: 0, evictions: 0 };
    caches.set(key, entry);
  }
  return entry;
}

// A finalize that throws must not take the caller's query with it. The statement
// is being discarded either way, and bun:sqlite also finalizes outstanding
// statements itself when the database closes.
function finalizeQuietly(statement: CachedStatement) {
  try {
    statement.finalize?.();
  } catch {
    // Discarded regardless.
  }
}

/**
 * Return a prepared statement for `sql`, calling `compile` only on a miss.
 *
 * Statements are shared between callers, which is safe here because every call
 * site runs the statement to completion synchronously (`all`/`get`/`run`, never
 * `iterate`), so no two executions of one statement can overlap. A caller that
 * needs to hold a cursor open across a suspension point must prepare its own.
 */
export function prepareCached(
  key: object,
  sql: string,
  compile: (sql: string) => CachedStatement,
  limit = DEFAULT_STATEMENT_CACHE_LIMIT,
): CachedStatement {
  const entry = entryFor(key, limit);
  const existing = entry.statements.get(sql);
  if (existing) {
    // Re-insert so insertion order tracks recency: Map iteration yields the
    // least recently used key first, which is what eviction takes.
    entry.statements.delete(sql);
    entry.statements.set(sql, existing);
    entry.hits += 1;
    return existing;
  }

  const statement = compile(sql);
  entry.misses += 1;
  entry.statements.set(sql, statement);

  while (entry.statements.size > entry.limit) {
    const oldest = entry.statements.keys().next();
    if (oldest.done) break;
    const evicted = entry.statements.get(oldest.value);
    entry.statements.delete(oldest.value);
    if (evicted) finalizeQuietly(evicted);
    entry.evictions += 1;
  }

  return statement;
}

/**
 * Finalize and drop every statement cached under `key`.
 *
 * Call this before closing a handle. server/db.ts closes with `close(true)`,
 * which throws rather than closing over live statements, so a populated cache
 * would turn an activation into an error.
 */
export function clearStatementCache(key: object) {
  const entry = caches.get(key);
  if (!entry) return;
  for (const statement of entry.statements.values()) finalizeQuietly(statement);
  entry.statements.clear();
}

export type StatementCacheStats = {
  size: number;
  limit: number;
  hits: number;
  misses: number;
  evictions: number;
};

export function statementCacheStats(key: object): StatementCacheStats {
  const entry = caches.get(key);
  if (!entry) return { size: 0, limit: DEFAULT_STATEMENT_CACHE_LIMIT, hits: 0, misses: 0, evictions: 0 };
  return {
    size: entry.statements.size,
    limit: entry.limit,
    hits: entry.hits,
    misses: entry.misses,
    evictions: entry.evictions,
  };
}
