// Dialect-neutral async data access.
//
// store.ts was written against bun:sqlite's synchronous prepared statements.
// Postgres clients are asynchronous, so supporting both backends needs one
// interface that is async on BOTH sides -- the SQLite implementation resolves
// immediately rather than the Postgres one pretending to be synchronous.
//
// The SQL itself is left alone. Queries in store.ts are close to ANSI standard
// (CASE/COALESCE/EXISTS, and ON CONFLICT upserts that both engines accept), so
// the adapter translates the *parameter style* rather than rewriting the
// statements: bun:sqlite binds `@name` natively, and Postgres gets the same
// text rewritten to $1..$n with a matching positional array.
//
// Serialization
// -------------
// Going async costs an atomicity guarantee that the synchronous code had for
// free, and both backends have to pay it back explicitly. bun:sqlite's
// db.transaction() wraps a *synchronous* callback, which is exactly why nothing
// can interleave inside it. Once a transaction body can await, every suspension
// point lets another request's query land on the same connection inside the
// open BEGIN -- committing, or being rolled back, as collateral.
//
// The two backends pay it differently, because the hazard is not the same:
//
//   SQLite   one handle with an ambient current transaction. Every operation is
//            serialized through an ExclusiveContext -- a transaction holds the
//            lock for its whole body and anything not already inside it queues.
//   Postgres a pool. A transaction pins one connection and a statement on any
//            other connection is already outside it, so only the async-context
//            scoping is needed. Locking would serialize transactions that have
//            no reason to wait and throttle the pool to a single writer.
//
// Either way the mechanism is async context rather than a boolean flag; see
// server/async-mutex.ts for why a flag cannot work.
//
// Statement caching is deliberately NOT layered here. server/db.ts already
// routes prepare() through the per-handle cache in server/statement-cache.ts,
// so an adapter over one of its handles inherits it. A second cache over the
// same handle would hold the very statement objects the first one finalizes on
// close, and would go on using them afterwards.

import { ExclusiveContext } from "./async-mutex.js";

export type SqlParams = Record<string, unknown> | undefined;
export type DbKind = "sqlite" | "postgres";

export type RunResult = { changes: number };

export interface DbAdapter {
  readonly kind: DbKind;
  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T | undefined>;
  run(sql: string, params?: SqlParams): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Rewrite `@name` placeholders to Postgres `$n`, returning the values in
 * matching order. A name used more than once reuses its first index rather
 * than binding the value twice.
 *
 * Limitation: this does not parse string literals, so a literal `@word` inside
 * quotes would be rewritten too. No query in this codebase contains one, and a
 * parameter that is genuinely missing binds NULL rather than silently shifting
 * every later placeholder.
 */
export function toPositional(sql: string, params: SqlParams): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const indexes = new Map<string, number>();
  const text = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    let index = indexes.get(name);
    if (index === undefined) {
      values.push(params?.[name] ?? null);
      index = values.length;
      indexes.set(name, index);
    }
    return `$${index}`;
  });
  return { text, values };
}

type SqliteLike = {
  prepare: (sql: string) => {
    all: (...bindings: unknown[]) => unknown[];
    get: (...bindings: unknown[]) => unknown;
    run: (...bindings: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  };
  exec: (sql: string) => void;
  transaction: <T>(fn: () => T) => () => T;
  close: (throwOnError?: boolean) => void;
};

// bun:sqlite rejects a bindings object it considers empty, and every call site
// in store.ts passes the whole row object even when the statement binds none of
// it, so the no-parameter case has to call through without an argument.
function bindArgs(params: SqlParams): unknown[] {
  return params && Object.keys(params).length > 0 ? [params] : [];
}

// Marker for the SQLite exclusive section. A SQLite connection has an ambient
// current transaction, so the section needs no payload -- only the fact that we
// are inside one.
const SQLITE_IN_TRANSACTION = Symbol("sqlite-transaction");

export function createSqliteAdapter(database: SqliteLike): DbAdapter {
  const exclusive = new ExclusiveContext<symbol>();

  return {
    kind: "sqlite",
    all<T>(sql: string, params?: SqlParams) {
      return exclusive.runSerialized(() => database.prepare(sql).all(...bindArgs(params)) as T[]);
    },
    get<T>(sql: string, params?: SqlParams) {
      return exclusive.runSerialized(
        () => (database.prepare(sql).get(...bindArgs(params)) ?? undefined) as T | undefined,
      );
    },
    run(sql: string, params?: SqlParams) {
      return exclusive.runSerialized(() => {
        const result = database.prepare(sql).run(...bindArgs(params));
        return { changes: Number(result.changes) };
      });
    },
    exec(sql: string) {
      return exclusive.runSerialized(() => {
        database.exec(sql);
      });
    },
    transaction<T>(fn: () => Promise<T>) {
      // bun:sqlite's transaction() wraps a synchronous callback and cannot hold
      // an async one open, so BEGIN/COMMIT are issued directly. The exclusive
      // section is what makes that safe: no query from outside this callback can
      // run between them.
      //
      // IMMEDIATE takes the write lock up front rather than on the first write,
      // so a transaction that begins by reading cannot fail to upgrade later --
      // the SQLITE_BUSY-on-upgrade failure a deferred transaction is open to.
      // Already inside one: join it. SQLite has no nested transactions, so a
      // second BEGIN is an error ("cannot start a transaction within a
      // transaction") rather than a savepoint. Joining means the inner body
      // commits and rolls back with the outer one.
      if (exclusive.current()) return fn();

      return exclusive.runExclusive(SQLITE_IN_TRANSACTION, async () => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn();
          database.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            database.exec("ROLLBACK");
          } catch {
            // A failed rollback must not mask the error that caused it.
          }
          throw error;
        }
      });
    },
    close() {
      return exclusive.runSerialized(() => {
        database.close(false);
      });
    },
  };
}

type PostgresSql = {
  unsafe: (text: string, values?: unknown[]) => Promise<unknown[]> & { count?: number };
  reserve: () => Promise<PostgresReserved>;
  end: (options?: { timeout?: number }) => Promise<void>;
};

type PostgresReserved = {
  unsafe: (text: string, values?: unknown[]) => Promise<unknown[]> & { count?: number };
  release: () => void;
};

export function createPostgresAdapter(sql: PostgresSql): DbAdapter {
  // Postgres has no ambient current statement the way a SQLite handle does, so
  // an open transaction has to pin one connection: every statement inside it
  // must run there or it lands outside the transaction entirely.
  //
  // The reserved connection is carried in the async context rather than in a
  // module-level variable. A single shared variable cannot tell a nested call
  // (which should join the transaction) from a concurrent one (which must not):
  // the concurrent caller would find the field already set and silently run
  // inside another request's transaction, then commit or roll back with it.
  // Unlike the SQLite adapter, this one does NOT serialize. The two backends
  // have genuinely different hazards:
  //
  //   SQLite   one handle with an ambient current transaction, so any statement
  //            issued while a BEGIN is open lands inside it. Serializing is the
  //            only way to keep a transaction atomic.
  //   Postgres a pool. A transaction pins one connection, and a statement on any
  //            other connection is already outside it. Nothing needs to wait, and
  //            a lock here would serialize independent transactions and throttle
  //            the pool to a single writer -- giving up the concurrency that is
  //            the reason to run Postgres in the first place.
  //
  // So the async context does all the work: it says which connection a statement
  // belongs to, and concurrent transactions each scope to their own.
  const exclusive = new ExclusiveContext<PostgresReserved>();

  const runner = () => exclusive.current() ?? sql;

  async function query(text: string, params: SqlParams) {
    const positional = toPositional(text, params);
    const rows = await runner().unsafe(positional.text, positional.values);
    return rows as unknown[] & { count?: number };
  }

  return {
    kind: "postgres",
    async all<T>(text: string, params?: SqlParams) {
      return (await query(text, params)) as T[];
    },
    async get<T>(text: string, params?: SqlParams) {
      const rows = await query(text, params);
      return (rows[0] ?? undefined) as T | undefined;
    },
    async run(text: string, params?: SqlParams) {
      const rows = await query(text, params);
      return { changes: Number(rows.count ?? rows.length ?? 0) };
    },
    async exec(text: string) {
      await runner().unsafe(text);
    },
    async transaction<T>(fn: () => Promise<T>) {
      // Already inside one: join it rather than reserving a second connection,
      // which would deadlock against the locks the first transaction holds.
      if (exclusive.current()) return fn();

      const connection = await sql.reserve();
      try {
        return await exclusive.runScoped(connection, async () => {
          await connection.unsafe("BEGIN");
          try {
            const result = await fn();
            await connection.unsafe("COMMIT");
            return result;
          } catch (error) {
            try {
              await connection.unsafe("ROLLBACK");
            } catch {
              // A failed rollback must not mask the error that caused it.
            }
            throw error;
          }
        });
      } finally {
        connection.release();
      }
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
