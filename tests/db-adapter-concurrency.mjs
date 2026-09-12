// Concurrency regression for the async data adapter.
//
// The whole point of serializing the adapter is a guarantee the synchronous code
// had for free: a transaction is atomic with respect to everything else. An
// async transaction body yields the event loop at every await, so without
// serialization an unrelated write lands inside the open BEGIN and is committed
// -- or rolled back -- as collateral.
//
// The atomicity check does not try to provoke that by hand. Hand-timed races
// test one interleaving and quietly stop testing anything when the timing
// shifts, so the ordering is handed to fast-check's scheduler instead: it picks
// the interleaving, explores many of them per run, and on failure shrinks to the
// smallest schedule that breaks the invariant and prints the seed to replay it.
//
// The test is self-validating. The same property is run against a deliberately
// unserialized adapter built right here, and fast-check MUST find a schedule
// that breaks it. If it cannot, the property has stopped describing the hazard
// it guards and the test says so rather than passing quietly.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import fc from "fast-check";
import { removeTemporaryDirectory } from "./temp-dir.mjs";

const { createSqliteAdapter } = await import("../server/db-adapter.ts");
const { AsyncMutex } = await import("../server/async-mutex.ts");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const INSERT = "INSERT INTO t (id) VALUES (@id)";

const tempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-adapter-"));
let failed = false;
// Declared out here so the finally block can close it: an assertion failure must
// still release the file, or Windows reports EBUSY removing the temp directory
// and the real error is buried under a cleanup error.
let database;

try {
  database = new Database(join(tempDir, "adapter.sqlite"), { strict: true });
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");

  const reset = () => database.exec("DELETE FROM t");
  const ids = () =>
    database
      .prepare("SELECT id FROM t ORDER BY id")
      .all()
      .map((row) => row.id);

  // An adapter with the serialization removed and nothing else changed. This is
  // what the shipped adapter would be if the exclusive section were dropped.
  const unserialized = {
    async run(sql, params) {
      return database.prepare(sql).run(params);
    },
    async transaction(fn) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Keep the original error.
        }
        throw error;
      }
    },
  };

  const adapter = createSqliteAdapter(database);

  // --- the invariant: a rollback takes its own writes and nothing else --------

  /**
   * A transaction that rolls back, racing an unrelated write, with the ordering
   * chosen by the scheduler.
   *
   * Both actors await a scheduled gate, so the scheduler decides whether the
   * unrelated write is attempted before, during, or after the transaction's open
   * BEGIN. Exactly one of those orderings is the dangerous one, which is why
   * picking the timing by hand is not good enough.
   */
  const atomicityProperty = (target) =>
    fc.asyncProperty(fc.scheduler(), async (scheduler) => {
      reset();
      const gate = scheduler.scheduleFunction(async (label) => label);

      const transaction = target.transaction(async () => {
        await target.run(INSERT, { id: "inside-transaction" });
        await gate("transaction-midpoint");
        throw new Error("forced rollback");
      });

      const unrelated = (async () => {
        await gate("unrelated-start");
        await target.run(INSERT, { id: "unrelated-write" });
      })();

      const settled = await scheduler.waitFor(Promise.allSettled([transaction, unrelated]));

      assert(settled[0].status === "rejected", "the transaction under test was supposed to roll back");

      const rows = ids();
      assert(
        !rows.includes("inside-transaction"),
        `a rolled-back transaction's own row must not survive, saw ${JSON.stringify(rows)}`,
      );
      assert(
        rows.includes("unrelated-write"),
        "an unrelated write was rolled back with someone else's transaction, " +
          `rows: ${JSON.stringify(rows)}, write outcome: ${settled[1].status}`,
      );
    });

  // The shipped adapter: no interleaving may break the invariant.
  await fc.assert(atomicityProperty(adapter), { numRuns: 100 });

  // The negative control: fast-check must be able to break the unserialized one.
  let controlFailure = null;
  try {
    await fc.assert(atomicityProperty(unserialized), { numRuns: 100 });
  } catch (error) {
    controlFailure = error;
  }
  assert(
    controlFailure,
    "NEGATIVE CONTROL FAILED: fast-check could not find any schedule where the unserialized " +
      "adapter loses an unrelated write, so this property no longer describes the hazard it " +
      "guards. Check that the transaction body still yields before verifying the serialized case.",
  );
  // Surface the shrunk schedule and seed: it is the reproduction recipe for the
  // bug this test exists to prevent.
  // Only the replay coordinates. The counterexample itself is a multi-line
  // scheduler transcript that does not survive being clipped.
  const controlSummary = String(controlFailure.message ?? controlFailure)
    .split("\n")
    .filter((line) => /failed after|seed:/i.test(line))
    .map((line) => line.trim())
    .slice(0, 2)
    .join("  ");
  console.log("  negative control broke the unserialized adapter, as required:");
  console.log(`    ${controlSummary || "(fast-check reported a failure without a parseable summary)"}`);

  // --- overlapping transactions must not collide on one connection -----------

  {
    reset();
    const attempts = 12;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_unused, index) =>
        adapter.transaction(async () => {
          await adapter.run(INSERT, { id: `concurrent-${index}` });
          await tick();
          return index;
        }),
      ),
    );

    const rejected = results.filter((result) => result.status === "rejected");
    assert(
      rejected.length === 0,
      `overlapping transactions must all commit, ${rejected.length} failed: ${rejected
        .map((result) => String(result.reason?.message ?? result.reason))
        .join("; ")}`,
    );
    assert(ids().length === attempts, `expected ${attempts} committed rows, saw ${ids().length}`);
  }

  // --- reentrancy must not deadlock against its own lock ---------------------

  {
    reset();
    // A query inside a transaction must run immediately: queueing it behind the
    // lock its own caller holds would never resolve.
    const nested = await adapter.transaction(async () => {
      await adapter.run(INSERT, { id: "reentrant" });
      const row = await adapter.get("SELECT id FROM t WHERE id = @id", { id: "reentrant" });
      const all = await adapter.all("SELECT id FROM t");
      // A transaction nested inside a transaction joins the open one.
      await adapter.transaction(async () => {
        await adapter.run(INSERT, { id: "nested" });
      });
      return { row, count: all.length };
    });
    assert(nested.row?.id === "reentrant", "a read inside its own transaction must see the write");
    assert(ids().includes("nested"), "a nested transaction's write must commit with the outer one");
  }

  // A rolled-back nested transaction must take the outer one with it rather than
  // committing half the work: joining means there is only one transaction.
  {
    reset();
    const outcome = await Promise.allSettled([
      adapter.transaction(async () => {
        await adapter.run(INSERT, { id: "outer" });
        await adapter.transaction(async () => {
          await adapter.run(INSERT, { id: "inner" });
          throw new Error("inner failed");
        });
      }),
    ]);
    assert(outcome[0].status === "rejected", "a failing nested transaction must reject the outer one");
    assert(ids().length === 0, `a joined rollback must discard every row, saw ${JSON.stringify(ids())}`);
  }

  // --- the mutex itself: ordering, and isolation of a rejecting task ---------

  {
    const mutex = new AsyncMutex();
    const order = [];
    const tasks = [
      mutex.runExclusive(async () => {
        await tick();
        order.push("first");
      }),
      mutex.runExclusive(async () => {
        throw new Error("second failed");
      }),
      mutex.runExclusive(async () => {
        order.push("third");
      }),
    ];

    const settled = await Promise.allSettled(tasks);
    assert(settled[0].status === "fulfilled", "the first task should succeed");
    assert(settled[1].status === "rejected", "the second task should surface its own rejection");
    assert(
      settled[2].status === "fulfilled",
      "a rejecting task must not poison the queue behind it: the third task failed",
    );
    assert(order.join(",") === "first,third", `tasks must run in arrival order, saw ${order.join(",")}`);
    assert(mutex.pending === 0, `the queue must drain, ${mutex.pending} still pending`);
  }

  // Exclusivity: a slow holder must fully finish before the next one starts.
  {
    const mutex = new AsyncMutex();
    let active = 0;
    let overlaps = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        mutex.runExclusive(async () => {
          active += 1;
          if (active > 1) overlaps += 1;
          await tick();
          active -= 1;
        }),
      ),
    );
    assert(overlaps === 0, `exclusive sections must not overlap, saw ${overlaps} overlaps`);
  }

  console.log("Adapter concurrency regression passed");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  try {
    database?.close(false);
  } catch (closeError) {
    console.error("Adapter concurrency could not close the database:", closeError);
  }
  try {
    removeTemporaryDirectory(tempDir);
  } catch (cleanupError) {
    failed = true;
    console.error("Adapter concurrency cleanup failed:", cleanupError);
  }
}

process.exit(failed ? 1 : 0);
