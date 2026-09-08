import { removePathWithRetries } from "../server/filesystem.ts";

export function removeTemporaryDirectory(path, options = {}) {
  removePathWithRetries(path, { ...options, recursive: true, force: true });
}
