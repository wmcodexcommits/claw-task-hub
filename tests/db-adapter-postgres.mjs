// Postgres adapter regression.
//
// Runs against a recording stand-in for postgres.js rather than a live server.
// Everything worth asserting here is about *which connection a statement went
// to*, and that is exactly what a stand-in can observe precisely and a real
// server cannot: the bug this guards against is a statement landing on the right
// server through the wrong connection, which looks like success from outside.
//
// The stand-in matches the surface the adapter actually uses -- `unsafe`,
// `reserve`, `end` -- all of which were verified present on postgres.js 3.4.9.
//
// Two properties matter most, and they pull in opposite directions:
//
//   isolation    a transaction pins one connection, and every statement inside
//                it must go there. A concurrent transaction must get its OWN
//                connection, never join someone else's.
//   concurrency  and yet concurrent transactions must genuinely overlap. Fixing
//                isolation with a lock would be easy and wrong: it would
//                serialize independent transactions and throttle the pool to one
//                writer, which is the opposite of why anyone runs Postgres.
//
// The isolation half is guarded by a negative control -- the module-global
// version of this adapter, which silently lets a concurrent transaction join
// another one's connection. The concurrency half is guarded by construction: the
// overlap test deadlocks rather than fails if serialization is ever added back.

import { toPositional, createPostgresAdapter } from "../server/db-adapter.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// --------------------------------------------------------------------------
// toPositional: @name -> $n rewriting
// --------------------------------------------------------------------------

{
  const single = toPositional("SELECT * FROM t WHERE id = @id", { id: "x" });
  assert(single.text === "SELECT * FROM t WHERE id = $1", `unexpected text: ${single.text}`);
  assert(
    single.values.length === 1 && single.values[0] === "x",
    `unexpected values: ${JSON.stringify(single.values)}`,
  );
}

{
  // A name used twice must reuse its index rather than bind the value twice:
  // postgres counts placeholders, so a duplicate would shift every later one.
  const repeated = toPositional("SELECT @a, @b, @a FROM t", { a: 1, b: 2 });
  assert(repeated.text === "SELECT $1, $2, $1 FROM t", `unexpected text: ${repeated.text}`);
  assert(
    JSON.stringify(repeated.values) === JSON.stringify([1, 2]),
    `a repeated name must bind once, saw ${JSON.stringify(repeated.values)}`,
  );
}

{
  // A missing parameter binds NULL. The alternative -- skipping it -- would
  // renumber every later placeholder and silently bind the wrong column.
  const missing = toPositional("SELECT @present, @absent FROM t", { present: 7 });
  assert(missing.text === "SELECT $1, $2 FROM t", `unexpected text: ${missing.text}`);
  assert(
    JSON.stringify(missing.values) === JSON.stringify([7, null]),
    `a missing parameter must bind NULL, saw ${JSON.stringify(missing.values)}`,
  );
}

{
  // Documented limitation, asserted so that changing it has to be deliberate:
  // the rewrite does not parse string literals, so an @word inside quotes is
  // rewritten too. No query in this codebase contains one.
  const inLiteral = toPositional("SELECT 'user@example.com' FROM t", {});
  assert(
    inLiteral.text === "SELECT 'user$1.com' FROM t",
    `the documented literal-rewriting limitation changed shape: ${inLiteral.text}`,
  );
}

// --------------------------------------------------------------------------
// A recording stand-in for postgres.js
// --------------------------------------------------------------------------

function createRecordingPostgres() {
  const log = [];
  const released = [];
  let reserveCount = 0;
  const outstanding = new Set();

  const unsafeFor = (connection) => (text) => {
    log.push({ connection, verb: String(text).trim().split(/\s+/)[0].toUpperCase() });
    const rows = [];
    rows.count = 0;
    return Promise.resolve(rows);
  };

  const sql = {
    unsafe: unsafeFor("pool"),
    async reserve() {
      reserveCount += 1;
      const name = `conn${reserveCount}`;
      outstanding.add(name);
      return {
        unsafe: unsafeFor(name),
        release() {
          outstanding.delete(name);
          released.push(name);
        },
      };
    },
    async end() {},
  };

  return {
    sql,
    log,
    released,
    outstanding,
    get reserveCount() {
      return reserveCount;
    },
    connectionsFor(verb) {
      return log.filter((entry) => entry.verb === verb).map((entry) => entry.connection);
    },
  };
}

// The adapter as it was before the fix: one module-level `reserved` field. Kept
// as a negative control, because it fails in a way that looks like success.
function createModuleGlobalAdapter(sql) {
  let reserved = null;
  const runner = () => reserved ?? sql;
  return {
    async run(text) {
      await runner().unsafe(text);
    },
    async transaction(fn) {
      // Intended for reentrancy, but with no async context this cannot tell a
      // nested call from a concurrent one.
      if (reserved) return fn();
      const connection = await sql.reserve();
      reserved = connection;
      try {
        await connection.unsafe("BEGIN");
        const result = await fn();
        await connection.unsafe("COMMIT");
        return result;
      } finally {
        reserved = null;
        connection.release();
      }
    },
  };
}

// --------------------------------------------------------------------------
// Statements outside a transaction go to the pool
// --------------------------------------------------------------------------

{
  const pg = createRecordingPostgres();
  const adapter = createPostgresAdapter(pg.sql);
  await adapter.all("SELECT 1 FROM t", {});
  await adapter.run("UPDATE t SET a = @a", { a: 1 });
  assert(pg.reserveCount === 0, "a statement outside a transaction must not reserve a connection");
  assert(
    pg.log.every((entry) => entry.connection === "pool"),
    `statements outside a transaction must use the pool, saw ${JSON.stringify(pg.log)}`,
  );
}

// --------------------------------------------------------------------------
// A transaction pins one connection, and everything inside goes there
// --------------------------------------------------------------------------

{
  const pg = createRecordingPostgres();
  const adapter = createPostgresAdapter(pg.sql);

  await adapter.transaction(async () => {
    await adapter.run("INSERT INTO t VALUES (@v)", { v: 1 });
    await adapter.get("SELECT * FROM t WHERE id = @id", { id: 1 });
  });

  assert(pg.reserveCount === 1, `expected exactly 1 reserved connection, saw ${pg.reserveCount}`);
  const connections = new Set(pg.log.map((entry) => entry.connection));
  assert(
    connections.size === 1 && !connections.has("pool"),
    `every statement in a transaction must use its reserved connection, saw ${JSON.stringify([
      ...connections,
    ])}`,
  );
  const verbs = pg.log.map((entry) => entry.verb);
  assert(
    verbs[0] === "BEGIN" && verbs.at(-1) === "COMMIT",
    `a transaction must open with BEGIN and close with COMMIT, saw ${verbs.join(",")}`,
  );
  assert(pg.outstanding.size === 0, "the reserved connection must be released");
}

// --------------------------------------------------------------------------
// Concurrent transactions: separate connections, and genuinely overlapping
// --------------------------------------------------------------------------

/**
 * Holds one transaction open while a second runs to completion.
 *
 * If the adapter serialized transactions, the second would queue behind the
 * first and this would deadlock rather than return -- which is the point. The
 * timeout turns that into a readable failure instead of a hung test.
 */
async function overlappingTransactions(adapter) {
  let releaseFirst;
  const firstHeld = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstHasBegun;
  const firstBegun = new Promise((resolve) => {
    firstHasBegun = resolve;
  });

  const first = adapter.transaction(async () => {
    await adapter.run("INSERT INTO first_table VALUES (1)");
    firstHasBegun();
    await firstHeld;
    await adapter.run("INSERT INTO first_table VALUES (2)");
  });

  await firstBegun;

  // The second transaction must finish while the first is still open.
  const second = adapter.transaction(async () => {
    await adapter.run("INSERT INTO second_table VALUES (1)");
  });

  const outcome = await Promise.race([
    second.then(() => "completed"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 1000)),
  ]);

  releaseFirst();
  await first;
  await second;
  return outcome;
}

{
  const pg = createRecordingPostgres();
  const adapter = createPostgresAdapter(pg.sql);

  const outcome = await overlappingTransactions(adapter);
  assert(
    outcome === "completed",
    "a second transaction could not finish while another was open: the Postgres path is " +
      "serializing transactions, which throttles the pool to a single writer",
  );

  assert(pg.reserveCount === 2, `two concurrent transactions must reserve 2 connections, saw ${pg.reserveCount}`);

  const begins = pg.connectionsFor("BEGIN");
  assert(begins.length === 2, `expected 2 BEGINs, saw ${begins.length}`);
  assert(new Set(begins).size === 2, `each transaction needs its own connection, saw ${begins.join(",")}`);

  // The decisive check: no connection carried statements from both transactions.
  const byConnection = new Map();
  for (const entry of pg.log) {
    if (!byConnection.has(entry.connection)) byConnection.set(entry.connection, new Set());
    byConnection.get(entry.connection).add(entry.verb);
  }
  assert(
    !pg.log.some((entry) => entry.connection === "pool"),
    "a statement inside a transaction escaped to the pool",
  );
  for (const [connection, verbs] of byConnection) {
    const commits = pg.log.filter((entry) => entry.connection === connection && entry.verb === "COMMIT");
    assert(
      commits.length === 1,
      `connection ${connection} committed ${commits.length} times; two transactions shared it ` +
        `(verbs: ${[...verbs].join(",")})`,
    );
  }
  assert(pg.outstanding.size === 0, `all connections must be released, still held: ${[...pg.outstanding]}`);
}

// Negative control: the module-global version must fail the isolation property.
{
  const pg = createRecordingPostgres();
  const control = createModuleGlobalAdapter(pg.sql);
  await overlappingTransactions(control);

  const begins = pg.connectionsFor("BEGIN");
  const joined = pg.reserveCount === 1 || new Set(begins).size < 2;
  assert(
    joined,
    "NEGATIVE CONTROL FAILED: the module-global adapter kept the two transactions apart, so this " +
      "test no longer demonstrates the bug it guards. Check that the transactions still overlap.",
  );
  console.log(
    `  negative control: module-global adapter reserved ${pg.reserveCount} connection(s) for 2 ` +
      `concurrent transactions and issued ${begins.length} BEGIN(s) -- the second silently joined the first`,
  );
}

// --------------------------------------------------------------------------
// Nested transactions join rather than reserving a second connection
// --------------------------------------------------------------------------

{
  const pg = createRecordingPostgres();
  const adapter = createPostgresAdapter(pg.sql);

  await adapter.transaction(async () => {
    await adapter.run("INSERT INTO t VALUES (1)");
    await adapter.transaction(async () => {
      await adapter.run("INSERT INTO t VALUES (2)");
    });
  });

  assert(pg.reserveCount === 1, `a nested transaction must not reserve again, saw ${pg.reserveCount}`);
  const begins = pg.connectionsFor("BEGIN");
  const commits = pg.connectionsFor("COMMIT");
  assert(begins.length === 1, `a nested transaction must not issue a second BEGIN, saw ${begins.length}`);
  assert(commits.length === 1, `a nested transaction must not COMMIT on its own, saw ${commits.length}`);
}

// --------------------------------------------------------------------------
// Failure paths: ROLLBACK, and the connection is always released
// --------------------------------------------------------------------------

{
  const pg = createRecordingPostgres();
  const adapter = createPostgresAdapter(pg.sql);

  let raised = null;
  try {
    await adapter.transaction(async () => {
      await adapter.run("INSERT INTO t VALUES (1)");
      throw new Error("body failed");
    });
  } catch (error) {
    raised = error;
  }

  assert(raised?.message === "body failed", `the body's error must propagate, saw ${raised?.message}`);
  assert(pg.connectionsFor("ROLLBACK").length === 1, "a failed transaction must ROLLBACK");
  assert(pg.connectionsFor("COMMIT").length === 0, "a failed transaction must not COMMIT");
  assert(pg.outstanding.size === 0, "a failed transaction must still release its connection");
}

{
  // A rollback that itself fails must not replace the error that caused it --
  // that error is the one describing what actually went wrong.
  const pg = createRecordingPostgres();
  const brokenRollback = {
    ...pg.sql,
    async reserve() {
      const connection = await pg.sql.reserve();
      return {
        unsafe: (text) => {
          if (String(text).trim().toUpperCase() === "ROLLBACK") {
            return Promise.reject(new Error("rollback itself failed"));
          }
          return connection.unsafe(text);
        },
        release: () => connection.release(),
      };
    },
  };
  const adapter = createPostgresAdapter(brokenRollback);

  let raised = null;
  try {
    await adapter.transaction(async () => {
      throw new Error("original failure");
    });
  } catch (error) {
    raised = error;
  }
  assert(
    raised?.message === "original failure",
    `a failed rollback must not mask the original error, saw ${raised?.message}`,
  );
  assert(pg.outstanding.size === 0, "a failed rollback must still release the connection");
}

console.log("Postgres adapter regression passed");
