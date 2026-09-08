import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outputFlag = process.argv.indexOf("--output-dir");
const requestedOutput = outputFlag >= 0 ? process.argv[outputFlag + 1] : join(root, "release");
if (!requestedOutput) throw new Error("--output-dir requires a path");
const outputRoot = resolve(root, requestedOutput);
const relativeToRoot = relative(root, outputRoot);
if (!isAbsolute(outputRoot) || outputRoot === root || outputRoot === dirname(root) || relativeToRoot === "") {
  throw new Error(`Unsafe release output directory: ${outputRoot}`);
}

const platform = process.platform === "win32" ? "windows" : process.platform;
const artifactName = `claw-task-hub-v${packageJson.version}-${platform}-${process.arch}`;
const stage = join(outputRoot, artifactName);
mkdirSync(outputRoot, { recursive: true });
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "runtime"), { recursive: true });
mkdirSync(join(stage, "scripts"), { recursive: true });

for (const directory of ["dist", "server"]) {
  const source = join(root, directory);
  if (!existsSync(source)) throw new Error(`Release input is missing: ${source}`);
  cpSync(source, join(stage, directory), { recursive: true });
}
for (const file of ["package.json", "bun.lock", "README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md"]) {
  copyFileSync(join(root, file), join(stage, file));
}
copyFileSync(join(root, "scripts", "install-git-hooks.mjs"), join(stage, "scripts", "install-git-hooks.mjs"));
copyFileSync(join(root, "packaging", "start.sh"), join(stage, "start.sh"));
copyFileSync(join(root, "packaging", "start.cmd"), join(stage, "start.cmd"));

const runtimeName = process.platform === "win32" ? "bun.exe" : "bun";
copyFileSync(process.execPath, join(stage, "runtime", runtimeName));
if (process.platform !== "win32") {
  chmodSync(join(stage, "runtime", runtimeName), 0o755);
  chmodSync(join(stage, "start.sh"), 0o755);
}

const install = spawnSync(join(stage, "runtime", runtimeName), ["install", "--production", "--frozen-lockfile"], {
  cwd: stage,
  encoding: "utf8",
  env: { ...process.env, CI: "1" },
});
if (install.status !== 0) throw new Error(`Release dependency install failed:\n${install.stdout}\n${install.stderr}`);

let archive = null;
if (!process.argv.includes("--no-archive")) {
  const extension = process.platform === "win32" ? ".zip" : ".tar.gz";
  archive = join(outputRoot, `${artifactName}${extension}`);
  rmSync(archive, { force: true });
  const archiveArgs = process.platform === "win32"
    ? ["-a", "-cf", archive, artifactName]
    : ["-czf", archive, artifactName];
  const archived = spawnSync("tar", archiveArgs, { cwd: outputRoot, encoding: "utf8" });
  if (archived.status !== 0) throw new Error(`Release archive failed:\n${archived.stdout}\n${archived.stderr}`);
}

const result = { name: artifactName, stage, archive };
writeFileSync(join(outputRoot, `${artifactName}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result));
