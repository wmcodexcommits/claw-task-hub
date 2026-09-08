import { chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.env.CI || !existsSync(join(root, ".git"))) {
  console.log("Git hook installation skipped outside a local Git worktree.");
  process.exit(0);
}

const result = spawnSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
  cwd: root,
  encoding: "utf8",
});
if (result.status !== 0) {
  throw new Error(`Unable to configure repository hooks: ${result.stderr || result.stdout}`);
}

if (process.platform !== "win32") {
  for (const name of ["pre-commit", "pre-push", "verification"]) chmodSync(join(root, ".githooks", name), 0o755);
}
console.log("Repository hooks installed from .githooks/.");
