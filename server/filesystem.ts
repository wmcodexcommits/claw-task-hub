import { rmSync } from "node:fs";

const retryableRemoveCodes = new Set(["EACCES", "EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);
const retryWait = new Int32Array(new SharedArrayBuffer(4));

/** Block the current thread. Retry backoff here has to be synchronous: it runs
 * inside module initialization and inside `rmSync` loops, neither of which can
 * await. */
export function waitSync(milliseconds: number) {
  if (milliseconds > 0) Atomics.wait(retryWait, 0, 0, milliseconds);
}

type RemovePathOptions = {
  recursive?: boolean;
  force?: boolean;
  attempts?: number;
  retryDelay?: number;
  remove?: typeof rmSync;
};

export function removePathWithRetries(path: string, options: RemovePathOptions = {}) {
  const attempts = options.attempts ?? 8;
  const retryDelay = options.retryDelay ?? 100;
  const remove = options.remove ?? rmSync;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      remove(path, { recursive: options.recursive, force: options.force });
      return;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (!retryableRemoveCodes.has(code) || attempt === attempts) throw error;
      Bun.gc(true);
      waitSync(retryDelay * attempt);
    }
  }
  throw lastError;
}
