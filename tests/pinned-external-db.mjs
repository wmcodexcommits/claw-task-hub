// Pinned external connection regression.
//
// A hub started with CLAW_TASK_HUB_EXTERNAL_DB must never fall back to SQLite:
// when the pinned connection cannot be opened the process exits, and no database
// file appears at the path CLAW_TASK_HUB_DB names.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { removeTemporaryDirectory } from "./temp-dir.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-pinned-"));
try {
  const connectionsFile = join(tempDir, "connections.json");
  writeFileSync(connectionsFile, JSON.stringify([{
    id: "unreachable-00000000",
    name: "unreachable",
    kind: "postgres",
    ssl: false,
    createdAt: new Date().toISOString(),
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestError: null,
    mode: "stored",
    // Port 1 on loopback refuses immediately, so the test does not wait on a timeout.
    connectionString: "postgres://hub:hub@127.0.0.1:1/hub",
  }]));
  const localDb = join(tempDir, "must-not-exist.sqlite");

  const result = spawnSync(process.execPath, ["-e", "await import('./server/db.ts')"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAW_TASK_HUB_EXTERNAL_DB: "unreachable-00000000",
      CLAW_TASK_HUB_CONNECTIONS_FILE: connectionsFile,
      CLAW_TASK_HUB_DB: localDb,
    },
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });

  assert(result.status !== 0, `Pinned hub started without its external connection (exit ${result.status})`);
  assert(/no local fallback/.test(result.stderr), `Pinned hub failed for an unexpected reason:\n${result.stderr}`);
  assert(!/using the local database/.test(result.stderr), "Pinned hub announced a local fallback");
  assert(!existsSync(localDb), "Pinned hub created a SQLite file at CLAW_TASK_HUB_DB");
  console.log("pinned-external-db: ok");
} finally {
  removeTemporaryDirectory(tempDir);
}
