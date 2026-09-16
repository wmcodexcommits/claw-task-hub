// Multi-process contention harness.
//
// Everything else in this suite runs in one process, where bun:sqlite is
// synchronous and the event loop serializes access for free. That is not how the
// hub is deployed: a systemd user service, a manual `bun run dev`, the MCP
// server and the CLI tools are separate processes on one database file, and the
// guarantees the single-process tests rely on do not extend across them.
//
// This reproduces the failure this codebase has actually had. From the comment
// on enableWalMode in server/db.ts: eight hub processes starting at once turned
// the exclusive journal-mode change into a Windows file sharing violation,
// surfacing as SQLITE_IOERR_TRUNCATE out of module initialization. `PRAGMA
// busy_timeout` does not cover that class -- it retries SQLITE_BUSY only -- so
// the pragma threw and killed the process.
//
// Getting the workers to actually collide is the whole difficulty, and it is
// easy to write a version of this that passes without ever creating contention.
// Two things matter:
//
//   1. Every module is imported BEFORE the barrier. Module loading takes tens to
//      hundreds of milliseconds and varies per process, so importing after the
//      barrier would stagger the workers straight back out and leave them
//      arriving at initializeDatabase one at a time.
//   2. The barrier is a shared wall-clock instant with a spin at the end, not a
//      sleep. Sleeping the whole way leaves several milliseconds of wake-up
//      jitter, which is enough to miss the race.
//
// Because a harness that silently stops colliding is worse than no harness, the
// workers report when they entered and left the contended section and the parent
// asserts the windows really did overlap. That check is what keeps this test from
// passing vacuously.
//
// What is asserted, versus merely reported:
//
//   asserted  the contended windows overlap, no worker dies, every acknowledged
//             write is present afterwards, and N workers upserting one
//             external_id leave exactly one row
//   reported  SQLITE_BUSY and SQLITE_IOERR tallies, and the final journal mode
//
// SQLITE_BUSY under contention is ordinary back-pressure, not a defect. A write
// that was acknowledged and then vanished, or a process that died, is a defect.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { removeTemporaryDirectory } from "./temp-dir.mjs";

const WORKERS = Number(process.env.CONTENTION_WORKERS ?? 8);
const WRITES_PER_WORKER = Number(process.env.CONTENTION_WRITES ?? 12);
const SHARED_PROJECT = "contention-shared-project";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function classify(error) {
  const code = error?.code ?? "";
  const message = String(error?.message ?? error);
  if (code) return code;
  const match = /SQLITE_[A-Z_]+/.exec(message);
  return match ? match[0] : "OTHER";
}

// --------------------------------------------------------------------------
// Worker
// --------------------------------------------------------------------------

if (process.env.CONTENTION_ROLE === "worker") {
  const index = Number(process.env.CONTENTION_WORKER_INDEX);
  const startAt = Number(process.env.CONTENTION_START_AT);

  const report = {
    index,
    initialized: false,
    acknowledged: [],
    errors: {},
    journalMode: null,
    // Offsets from the barrier instant, so the parent can check for real overlap
    // without comparing raw clocks.
    enteredAt: null,
    initializedAt: null,
    finishedAt: null,
  };

  const note = (error) => {
    const key = classify(error);
    report.errors[key] = (report.errors[key] ?? 0) + 1;
  };

  try {
    // Imported before the barrier on purpose: see the note at the top. Importing
    // db.ts opens the handle, which is not the contended operation --
    // initializeDatabase is, because that is what runs the exclusive
    // journal-mode change.
    const dbModule = await import("../server/db.ts");
    const store = await import("../server/store.ts");

    const coarse = startAt - Date.now() - 25;
    if (coarse > 0) await new Promise((resolve) => setTimeout(resolve, coarse));
    while (Date.now() < startAt) {
      /* spin the last few milliseconds to the barrier */
    }

    report.enteredAt = Date.now() - startAt;

    // The stampede: configureDatabase -> enableWalMode -> createSchema ->
    // runMigrations, all of it at once from every worker on a fresh file.
    dbModule.initializeDatabase(dbModule.db);
    report.initialized = true;
    report.initializedAt = Date.now() - startAt;
    report.journalMode = dbModule.db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? null;

    await store.ensureDefaultTeam();

    // Every worker upserts the SAME external_id. Exactly one row must exist
    // afterwards no matter how the upserts interleave across processes.
    const project = await store.upsertProject({
      external_id: SHARED_PROJECT,
      name: "Contention",
      summary: "Shared across workers",
    });

    for (let sequence = 0; sequence < WRITES_PER_WORKER; sequence += 1) {
      const identifier = `CTH-93${String(index).padStart(2, "0")}${String(sequence).padStart(2, "0")}`;
      try {
        await store.upsertIssue({
          title: `Contention worker ${index} write ${sequence}`,
          identifier,
          status: "Todo",
          project_id: project.id,
        });
        // Only recorded once the write returned: this list is the set of writes
        // the worker was told had succeeded.
        report.acknowledged.push(identifier);
      } catch (error) {
        note(error);
      }
    }
    report.finishedAt = Date.now() - startAt;
  } catch (error) {
    note(error);
    report.fatal = String(error?.message ?? error);
    report.finishedAt = Date.now() - startAt;
  }

  process.stdout.write(`__CONTENTION__${JSON.stringify(report)}\n`);
  process.exit(report.fatal ? 1 : 0);
}

// --------------------------------------------------------------------------
// Parent
// --------------------------------------------------------------------------

const selfPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(selfPath));
const tempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-contention-"));
const dbPath = join(tempDir, "contention.sqlite");
let failed = false;
let verifyDb;

try {
  // Long enough for every worker to spawn and finish importing before the
  // barrier releases. Too short and the slowest worker arrives late, which shows
  // up as an overlap failure rather than a silent pass.
  const startAt = Date.now() + 2500;

  const workers = Array.from({ length: WORKERS }, (_unused, index) => {
    const child = spawn(process.execPath, [selfPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAW_TASK_HUB_DB: dbPath,
        CLAW_TASK_HUB_QUIET_DB: "1",
        CONTENTION_ROLE: "worker",
        CONTENTION_WORKER_INDEX: String(index),
        CONTENTION_START_AT: String(startAt),
        CONTENTION_WRITES: String(WRITES_PER_WORKER),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    return new Promise((resolve) => {
      child.on("exit", (code) => resolve({ index, code, stdout, stderr }));
    });
  });

  const results = await Promise.all(workers);

  // --- every worker must have survived ------------------------------------

  // A worker that fails reports the reason on stdout, inside its report, not on
  // stderr -- so read that first. Showing only stderr made a real failure arrive
  // as "stderr: (none)", which is worse than no diagnostic at all.
  const readReport = (result) => {
    const line = result.stdout.split("\n").find((candidate) => candidate.startsWith("__CONTENTION__"));
    if (!line) return null;
    try {
      return JSON.parse(line.slice("__CONTENTION__".length));
    } catch {
      return null;
    }
  };

  const dead = results.filter((result) => result.code !== 0);
  assert(
    dead.length === 0,
    `${dead.length}/${WORKERS} workers died under contention:\n` +
      dead
        .map((result) => {
          const report = readReport(result);
          const reason = report?.fatal ?? "(worker produced no report)";
          const codes = report?.errors ? JSON.stringify(report.errors) : "{}";
          const reached = report
            ? `initialized=${report.initialized} acknowledged=${report.acknowledged?.length ?? 0}`
            : "(unknown)";
          const stderr = result.stderr.trim().split("\n").slice(-3).join("\n            ") || "(none)";
          return (
            `  worker ${result.index} exit ${result.code}\n` +
            `    fatal:  ${reason}\n` +
            `    errors: ${codes}\n` +
            `    got to: ${reached}\n` +
            `    stderr: ${stderr}`
          );
        })
        .join("\n"),
  );

  const reports = results.map((result) => {
    const line = result.stdout.split("\n").find((candidate) => candidate.startsWith("__CONTENTION__"));
    assert(line, `worker ${result.index} produced no report; stderr: ${result.stderr.trim().slice(0, 400)}`);
    return JSON.parse(line.slice("__CONTENTION__".length));
  });

  for (const report of reports) {
    assert(report.initialized, `worker ${report.index} never finished initializeDatabase`);
  }

  // --- the workers must actually have collided ------------------------------

  // Arrival spread at the barrier. A wide spread means the barrier is not doing
  // its job and everything below is testing a staggered start.
  const arrivals = reports.map((report) => report.enteredAt);
  const arrivalSpread = Math.max(...arrivals) - Math.min(...arrivals);

  // Sweep the [entered, finished] windows and find the peak number open at once.
  const events = reports.flatMap((report) => [
    { at: report.enteredAt, delta: 1 },
    { at: report.finishedAt ?? report.enteredAt, delta: -1 },
  ]);
  events.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let open = 0;
  let peak = 0;
  for (const event of events) {
    open += event.delta;
    peak = Math.max(peak, open);
  }

  assert(
    peak >= 2,
    `the workers never overlapped (peak concurrency ${peak}), so this run exercised no contention ` +
      `at all and the assertions below proved nothing. Arrival spread was ${arrivalSpread}ms; ` +
      "if that is large the barrier is being missed, most likely because a worker was still " +
      "importing when it was released.",
  );

  // --- every acknowledged write must be in the database --------------------

  verifyDb = new Database(dbPath, { strict: true });
  verifyDb.exec("PRAGMA busy_timeout = 5000");

  const acknowledged = reports.flatMap((report) => report.acknowledged);
  const stored = new Set(
    verifyDb
      .prepare("SELECT identifier FROM issues WHERE identifier LIKE 'CTH-93%'")
      .all()
      .map((row) => row.identifier),
  );

  const lost = acknowledged.filter((identifier) => !stored.has(identifier));
  assert(
    lost.length === 0,
    `${lost.length} acknowledged write(s) are missing from the database -- ` +
      `a write was reported as successful and then vanished: ${lost.slice(0, 10).join(", ")}`,
  );

  assert(
    stored.size === acknowledged.length,
    `the database holds ${stored.size} contention rows but workers acknowledged ` +
      `${acknowledged.length}; a row exists that no worker was told about`,
  );

  // --- concurrent upsert of one external_id must not duplicate -------------

  const projectRows = verifyDb
    .prepare("SELECT id FROM projects WHERE external_id = @external_id")
    .all({ external_id: SHARED_PROJECT });
  assert(
    projectRows.length === 1,
    `${WORKERS} workers upserting one external_id produced ${projectRows.length} project rows; ` +
      "the upsert is not atomic across processes",
  );

  // --- report contention pressure -----------------------------------------

  const tally = {};
  for (const report of reports) {
    for (const [code, count] of Object.entries(report.errors)) {
      tally[code] = (tally[code] ?? 0) + count;
    }
  }

  const journalModes = [...new Set(reports.map((report) => report.journalMode))];
  const pressure = Object.entries(tally)
    .map(([code, count]) => `${code}=${count}`)
    .join(" ");

  console.log(`  ${WORKERS} workers x ${WRITES_PER_WORKER} writes, released from one barrier`);
  console.log(`  arrival spread: ${arrivalSpread}ms | peak workers inside the section: ${peak}/${WORKERS}`);
  console.log(`  journal mode: ${journalModes.join(", ")}`);
  console.log(`  acknowledged writes stored: ${stored.size}/${acknowledged.length}`);
  console.log(`  retryable pressure: ${pressure || "none observed"}`);
  if (acknowledged.length < WORKERS * WRITES_PER_WORKER) {
    // Not a failure: the worker was told the write failed and did not count it.
    // Worth printing, because it is the signal that contention is real here.
    console.log(
      `  note: ${WORKERS * WRITES_PER_WORKER - acknowledged.length} write(s) were refused outright ` +
        "and correctly not acknowledged",
    );
  }

  console.log("Multi-process contention passed");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  try {
    verifyDb?.close(false);
  } catch (closeError) {
    console.error("Contention harness could not close the verification handle:", closeError);
  }
  try {
    removeTemporaryDirectory(tempDir);
  } catch (cleanupError) {
    failed = true;
    console.error("Contention cleanup failed:", cleanupError);
  }
}

process.exit(failed ? 1 : 0);
