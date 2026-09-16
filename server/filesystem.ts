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
      // Node's fs.rmSync tolerates `recursive`/`force` being explicitly
      // undefined and falls back to their documented `false` defaults; Bun's
      // implementation validates the key strictly and throws
      // `The "options.recursive" property must be of type boolean` if it is
      // present but not a real boolean. Default them here so the value is
      // always a boolean on both runtimes.
      remove(path, { recursive: options.recursive ?? false, force: options.force ?? false });
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
