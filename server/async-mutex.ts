// Serialization for the async data adapters.
//
// The hazard this exists to close:
//
//   bun:sqlite's db.transaction() takes a *synchronous* callback, and that is
//   what makes it safe -- nothing can interleave, because nothing else gets to
//   run. An async transaction gives that up. Between `BEGIN` and `COMMIT` every
//   `await` yields the event loop, and any other request's query then lands on
//   the same connection *inside* the open transaction. It commits with that
//   transaction, or is rolled back with it. Neither request did anything wrong.
//
// Claw Task Hub is built around concurrent agents -- sessions, claims,
// heartbeats -- so overlapping requests are the normal case here, not an edge
// case, and "one writer at a time" has to be enforced rather than inherited.
//
// A plain boolean "in transaction" flag cannot do this: every concurrent caller
// would see the flag set and bypass the queue, which is the bug rather than the
// fix. Identity has to follow the async call tree, which is what
// AsyncLocalStorage provides -- only code running inside the transaction's own
// callback sees its store.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A promise-chain mutex. Callers queue in arrival order and each waits for the
 * previous one to settle.
 */
export class AsyncMutex {
  // The tail of the queue. Every acquirer chains onto it, so ordering is FIFO.
  private tail: Promise<unknown> = Promise.resolve();

  private waiting = 0;

  get pending() {
    return this.waiting;
  }

  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    this.waiting += 1;
    // Chain onto the current tail, swallowing its rejection: one caller's
    // failure must not reject everyone queued behind it. The caller's own
    // result is returned unchanged.
    const result = this.tail.then(
      () => fn(),
      () => fn(),
    );
    // The tail must settle rather than reject, or the catch above becomes the
    // only thing keeping the chain alive.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    const settle = () => {
      this.waiting -= 1;
    };
    return result.then(
      (value) => {
        settle();
        return value;
      },
      (error) => {
        settle();
        throw error;
      },
    );
  }
}

/**
 * Per-async-context marker for "this code is running inside the exclusive
 * section", carrying whatever the holder needs to scope to it -- for Postgres,
 * the reserved connection the transaction pinned.
 */
export class ExclusiveContext<T> {
  private storage = new AsyncLocalStorage<T>();

  private mutex = new AsyncMutex();

  get pending() {
    return this.mutex.pending;
  }

  /** The current context's value, or undefined when not inside one. */
  current(): T | undefined {
    return this.storage.getStore();
  }

  /**
   * Run `fn` with exclusive access, tagged with `value`.
   *
   * Reentrant: a nested call from inside the same context runs immediately
   * instead of queueing, which would otherwise deadlock against the lock the
   * caller is already holding.
   */
  runExclusive<R>(value: T, fn: () => Promise<R> | R): Promise<R> {
    if (this.storage.getStore() !== undefined) return Promise.resolve(fn());
    return this.mutex.runExclusive(() => this.storage.run(value, fn));
  }

  /**
   * Run `fn` tagged with `value` but WITHOUT taking the lock.
   *
   * For a backend where concurrent sections are genuinely independent -- a
   * Postgres pool, where each transaction pins its own connection -- the async
   * context is the whole fix. Scoping tells a statement which connection it
   * belongs to; locking on top of that would serialize transactions that have no
   * reason to wait for each other, and throttle the pool to one writer.
   *
   * Reentrant in the same sense as runExclusive: a nested call keeps the
   * enclosing context rather than replacing it, so an inner transaction joins the
   * outer one instead of being scoped to a second connection.
   */
  runScoped<R>(value: T, fn: () => Promise<R> | R): Promise<R> {
    if (this.storage.getStore() !== undefined) return Promise.resolve(fn());
    return Promise.resolve(this.storage.run(value, fn));
  }

  /**
   * Run `fn` serialized against exclusive sections, unless it is already inside
   * one -- in which case it is part of that section and must not queue behind
   * the lock its own caller holds.
   */
  runSerialized<R>(fn: () => Promise<R> | R): Promise<R> {
    if (this.storage.getStore() !== undefined) return Promise.resolve(fn());
    return this.mutex.runExclusive(fn);
  }
}
