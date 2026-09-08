import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (!semver.test(packageJson.version)) throw new Error(`package.json version is not valid SemVer: ${packageJson.version}`);
if (packageJson.packageManager !== "bun@1.3.14") throw new Error(`packageManager must be pinned to bun@1.3.14, got ${packageJson.packageManager}`);
if (!existsSync(join(root, "bun.lock"))) throw new Error("bun.lock is required");
for (const staleLock of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
  if (existsSync(join(root, staleLock))) throw new Error(`${staleLock} is redundant after the Bun migration`);
}
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## [${packageJson.version}]`)) throw new Error(`CHANGELOG.md has no ${packageJson.version} release section`);

if (process.argv.includes("--tag")) {
  const tag = process.env.GITHUB_REF_NAME || process.argv[process.argv.indexOf("--tag") + 1];
  if (tag !== `v${packageJson.version}`) throw new Error(`Release tag ${tag || "(missing)"} must equal v${packageJson.version}`);
}
console.log(`Release version valid: ${packageJson.version}`);
