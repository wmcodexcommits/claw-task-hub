import { rmSync } from "node:fs";

const retryableCleanupCodes = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);
const retryWait = new Int32Array(new SharedArrayBuffer(4));

export function removeTemporaryDirectory(path, options = {}) {
  const attempts = options.attempts ?? 8;
  const retryDelay = options.retryDelay ?? 100;
  const remove = options.remove ?? rmSync;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      remove(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!retryableCleanupCodes.has(error?.code) || attempt === attempts) throw error;
      globalThis.Bun?.gc?.(true);
      if (retryDelay > 0) Atomics.wait(retryWait, 0, 0, retryDelay * attempt);
    }
  }
  throw lastError;
}
