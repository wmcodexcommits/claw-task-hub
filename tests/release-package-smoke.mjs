import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const outputRoot = mkdtempSync(join(tmpdir(), "claw-task-hub-release-smoke-"));
let child;
try {
  const packaged = spawnSync(process.execPath, ["scripts/package-release.mjs", "--output-dir", outputRoot, "--no-archive"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  assert(packaged.status === 0, `release packaging failed\n${packaged.stdout}\n${packaged.stderr}`);
  const resultLine = packaged.stdout.trim().split(/\r?\n/).at(-1);
  const result = JSON.parse(resultLine);
  assert(existsSync(join(result.stage, "dist", "index.html")), "package is missing the built UI");
  assert(existsSync(join(result.stage, "server", "index.ts")), "package is missing the API entrypoint");
  assert(existsSync(join(result.stage, "runtime", process.platform === "win32" ? "bun.exe" : "bun")), "package is missing its Bun runtime");
  assert(!existsSync(join(result.stage, "node_modules", "vite")), "package contains development-only dependencies");

  const port = await freePort();
  const entry = process.platform === "win32" ? join(result.stage, "start.cmd") : join(result.stage, "start.sh");
  const command = process.platform === "win32" ? "cmd.exe" : entry;
  const args = process.platform === "win32" ? ["/d", "/s", "/c", entry] : [];
  child = spawn(command, args, {
    cwd: result.stage,
    env: {
      ...process.env,
      PORT: String(port),
      CLAW_TASK_HUB_DB: join(outputRoot, "package-smoke.sqlite"),
      CLAW_TASK_HUB_REQUIRE_DB: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += chunk.toString(); });
  child.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });

  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      const health = await response.json();
      if (response.ok && health.ok && health.version === "0.2.0") {
        healthy = true;
        break;
      }
    } catch {
      // The packaged server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(healthy, `packaged server did not become healthy\n${diagnostics}`);
  const ui = await fetch(`http://127.0.0.1:${port}/`);
  const html = await ui.text();
  assert(ui.ok && html.includes("<div id=\"root\"></div>"), "packaged server did not serve the built UI");
  assert(readFileSync(join(result.stage, "package.json"), "utf8").includes('"packageManager": "bun@1.3.14"'), "package lost the pinned Bun contract");
  console.log("release package smoke passed");
} finally {
  await stop(child);
  rmSync(outputRoot, { recursive: true, force: true });
}
