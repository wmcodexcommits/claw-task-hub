// Execution reconciliation regression.
//
// Crashes real processes at each provisioning, run, and acceptance boundary with
// the fault points, in a temporary repository, and reconciles what they leave:
// interrupted provisioning (skipped while it may still be in flight, then
// repaired); a run whose outcome was recorded without its transition (repaired);
// a supervisor that died mid-run (quarantined, with a live harness reported and
// never killed); an interrupted acceptance (resumed); missing worktrees, moved
// branches, and drifted bases (quarantined); an expired lease (renewed); leases
// of terminal attempts (released, keeping dirty worktrees); a healthy run left
// alone; the minimum age; the single-run lock and abandoned runs; repeat runs;
// lapsed claims and unowned worktrees reported; operator quarantine; and the
// CLI, MCP, and HTTP surfaces.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { withoutRedirectingGitVariables } from "./git-environment.mjs";
import { stopProcessTree } from "./process-tree.mjs";
import { removeTemporaryDirectory } from "./temp-dir.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeWritable(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  try {
    chmodSync(path, stat.isDirectory() ? 0o777 : 0o666);
  } catch {
    // best effort
  }
  if (stat.isDirectory()) for (const entry of readdirSync(path)) makeWritable(join(path, entry));
}

if (process.env.CLAW_TASK_HUB_RECONCILIATION_WORKER !== "1") {
  const parentTempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-reconciliation-"));
  const gitConfig = join(parentTempDir, "gitconfig");
  writeFileSync(gitConfig, "");
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: {
      ...withoutRedirectingGitVariables(process.env),
      CLAW_TASK_HUB_DB: join(parentTempDir, "hub", "reconciliation.sqlite"),
      CLAW_TASK_HUB_WORKSPACE_ROOT: join(parentTempDir, "workspaces"),
      CLAW_TASK_HUB_RECONCILIATION_TEMP: parentTempDir,
      CLAW_TASK_HUB_QUIET_DB: "1",
      CLAW_TASK_HUB_RECONCILIATION_WORKER: "1",
      CLAW_TASK_HUB_ENABLE_FAKE_HARNESS: "1",
      CLAW_TASK_HUB_RUNNER_HEARTBEAT_MS: "200",
      CLAW_TASK_HUB_RECONCILE: "0",
      CLAW_TASK_HUB_API_BASE: "http://127.0.0.1:9/api",
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Reconciliation Test",
      GIT_AUTHOR_EMAIL: "reconciliation@example.com",
      GIT_COMMITTER_NAME: "Reconciliation Test",
      GIT_COMMITTER_EMAIL: "reconciliation@example.com",
    },
    stdio: "inherit",
    windowsHide: true,
  });
  let cleanupFailed = false;
  try {
    makeWritable(parentTempDir);
    removeTemporaryDirectory(parentTempDir);
  } catch (error) {
    cleanupFailed = true;
    console.error("Execution reconciliation cleanup failed after the worker exited:", error);
  }
  process.exit(cleanupFailed ? 1 : result.status ?? 1);
}

const tempRoot = process.env.CLAW_TASK_HUB_RECONCILIATION_TEMP;
assert(tempRoot && process.env.CLAW_TASK_HUB_DB, "Execution reconciliation worker requires its temp directory and database");

const dbModule = await import("../server/db.ts");
const store = await import("../server/store.ts");
const attempts = await import("../server/execution-attempts.ts");
const workspaces = await import("../server/execution-workspaces.ts");
const runs = await import("../server/execution-runs.ts");
const evidence = await import("../server/execution-evidence.ts");
const acceptance = await import("../server/execution-acceptance.ts");
const reconciliation = await import("../server/execution-reconciliation.ts");

dbModule.initializeDatabase(dbModule.db);
await store.ensureDefaultTeam();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sql = (statement, ...values) => dbModule.db.prepare(statement).run(...values);
const past = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: process.env, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stderr}`);
  return result.stdout.trim();
}

async function expectFailure(run, code, message) {
  try {
    await run();
  } catch (error) {
    assert(error?.code === code && error.message.startsWith(`${code}:`), `${message}: expected ${code}, got ${error instanceof Error ? error.message : error}`);
    return;
  }
  throw new Error(`${message}: expected ${code}, but it succeeded`);
}

const repoDir = join(tempRoot, "repos", "service");
mkdirSync(repoDir, { recursive: true });
git(repoDir, "init", "--quiet", "-b", "main");
writeFileSync(join(repoDir, "README.md"), "base\n");
git(repoDir, "add", "-A");
git(repoDir, "commit", "--quiet", "-m", "base");
const repo = { dir: realpathSync.native(repoDir), remote: "https://example.com/claw/reconciliation.git", base: git(repoDir, "rev-parse", "HEAD") };
git(repoDir, "remote", "add", "origin", repo.remote);

const project = await store.upsertProject({ external_id: "reconciliation-project", name: "Reconciliation Project" });
await evidence.saveVerificationPolicy({ repository: repo.remote, steps: [{ name: "unit", command: [process.execPath, "-e", "0"] }], actor_kind: "operator", actor_id: "operator-1" });
await acceptance.saveAcceptancePolicy({ repository: repo.remote, settings: {}, actor_kind: "operator", actor_id: "operator-1" });
let issueNumber = 950000;

async function claimedIssue(label) {
  issueNumber += 1;
  const identifier = `CTH-${issueNumber}`;
  const issue = await store.upsertIssue({ title: `Reconciliation ${label}`, identifier, status: "Todo", project_id: project.id });
  const sessionId = `session-reconciliation-${label}`;
  await store.startAgentSession({ id: sessionId, agent_name: `Agent ${label}`, harness: "codex", ttl_minutes: 240 });
  const { claim } = await store.claimIssue({ issue_id: identifier, session_id: sessionId, ttl_minutes: 240 });
  return { issue, claim, sessionId };
}

async function bareAttempt(label) {
  const target = await claimedIssue(label);
  const { attempt } = await attempts.createExecutionAttempt({ issue_id: target.issue.identifier, claim_id: target.claim.id, harness: "fake", repository: repo.remote, base_sha: repo.base, idempotency_key: `reconciliation-create-${label}` });
  return { ...target, attempt };
}

async function provisioned(label) {
  const target = await claimedIssue(label);
  const started = await workspaces.startExecutionAttempt({ issue_id: target.issue.identifier, claim_id: target.claim.id, harness: "fake", repository: repo.remote, base_sha: repo.base, idempotency_key: `reconciliation-create-${label}`, repository_path: repo.dir });
  return { ...target, attempt: started.attempt, worktree: started.workspace.worktree_path, branch: started.workspace.branch, leaseId: started.workspace.id };
}

async function verifying(label, instructions = { write: [{ path: `${label}.txt`, content: `${label}\n` }] }) {
  const fixture = await provisioned(label);
  const launched = await runs.launchExecutionAttempt({ attempt_id: fixture.attempt.id, adapter: "fake", prompt: JSON.stringify(instructions), idempotency_key: `reconciliation-launch-${label}` });
  assert((await launched.completion)?.result === "completed", `the ${label} fixture run failed`);
  return fixture;
}

const crashScript = join(tempRoot, "crash-step.mjs");
const moduleUrl = (path) => pathToFileURL(join(process.cwd(), path)).href;
writeFileSync(crashScript, `
const db = await import(${JSON.stringify(moduleUrl("server/db.ts"))});
db.initializeDatabase(db.db);
const step = JSON.parse(process.env.CRASH_STEP);
if (step.op === "provision") await (await import(${JSON.stringify(moduleUrl("server/execution-workspaces.ts"))})).provisionExecutionWorkspace(step.input);
if (step.op === "launch") await (await (await import(${JSON.stringify(moduleUrl("server/execution-runs.ts"))})).launchExecutionAttempt(step.input)).completion;
if (step.op === "accept") await (await import(${JSON.stringify(moduleUrl("server/execution-acceptance.ts"))})).acceptExecutionAttempt(step.input);
process.exit(0);
`);

// Runs one operation in a separate process that the named fault point kills.
async function crash(op, input, point) {
  const child = spawn(process.execPath, [crashScript], {
    cwd: process.cwd(),
    env: { ...process.env, CRASH_STEP: JSON.stringify({ op, input }), CLAW_TASK_HUB_ENABLE_FAULT_INJECTION: "1", CLAW_TASK_HUB_FAULT_INJECTION: point },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // "exit", not "close": an orphaned harness may keep the pipe open.
  const status = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  assert(status === 86, `the ${point} crash must stop the process there (exit ${status}):\n${stderr}`);
}

const reconcile = (input = {}) => reconciliation.reconcileExecution({ min_age_ms: 0, runner_stale_ms: 1000, actor_kind: "operator", actor_id: "operator-1", ...input });
const decisionFor = (run, attemptId) => run.decisions.find((decision) => decision.attempt_id === attemptId);
const state = async (attemptId) => (await attempts.getExecutionAttempt(attemptId)).state;

// --- interrupted provisioning -------------------------------------------------------------------

{
  const afterLease = await bareAttempt("after-lease");
  await crash("provision", { attempt_id: afterLease.attempt.id, repository_path: repo.dir }, "provision:lease_recorded");
  const lease = (await workspaces.listExecutionWorkspaces({ attempt_id: afterLease.attempt.id }))[0];
  assert(lease.status === "provisioning" && !existsSync(lease.worktree_path), "the crash must leave a recorded lease and no worktree");

  const untouched = await reconciliation.reconcileExecution({ attempt_id: afterLease.attempt.id, actor_kind: "operator", actor_id: "operator-1" });
  assert(untouched.status === "completed" && untouched.decisions.length === 0 && untouched.summary.examined === 0, "the default minimum age must leave fresh work alone");
  const skipped = await reconcile({ attempt_id: afterLease.attempt.id });
  assert(decisionFor(skipped, afterLease.attempt.id)?.action === "skipped" && decisionFor(skipped, afterLease.attempt.id).reason === "lease_conflict", `a lease that may still be provisioning must be skipped: ${JSON.stringify(skipped.decisions)}`);

  sql("UPDATE execution_workspace_leases SET updated_at = ? WHERE id = ?", past(10), lease.id);
  const repaired = await reconcile({ attempt_id: afterLease.attempt.id });
  const decision = decisionFor(repaired, afterLease.attempt.id);
  assert(decision?.classification === "interrupted_provisioning" && decision.action === "repaired", `interrupted provisioning must be repaired: ${JSON.stringify(repaired.decisions)}`);
  const active = (await workspaces.listExecutionWorkspaces({ attempt_id: afterLease.attempt.id }))[0];
  assert(active.status === "active" && existsSync(active.worktree_path), "the repaired lease must be active with its worktree");

  const afterWorktree = await bareAttempt("after-worktree");
  await crash("provision", { attempt_id: afterWorktree.attempt.id, repository_path: repo.dir }, "provision:worktree_created");
  const half = (await workspaces.listExecutionWorkspaces({ attempt_id: afterWorktree.attempt.id }))[0];
  assert(half.status === "provisioning" && existsSync(half.worktree_path), "the crash must leave a created worktree on a provisioning lease");
  sql("UPDATE execution_workspace_leases SET updated_at = ? WHERE id = ?", past(10), half.id);
  const resumed = await reconcile({ attempt_id: afterWorktree.attempt.id });
  assert(decisionFor(resumed, afterWorktree.attempt.id)?.action === "repaired" && (await workspaces.listExecutionWorkspaces({ attempt_id: afterWorktree.attempt.id }))[0].status === "active", "a created but unactivated worktree must be verified and activated");
}

// --- runs: recorded outcome, dead supervisor, healthy supervisor --------------------------------------

{
  const recorded = await provisioned("outcome-recorded");
  await crash("launch", { attempt_id: recorded.attempt.id, adapter: "fake", prompt: JSON.stringify({ write: [{ path: "done.txt", content: "done\n" }] }), idempotency_key: "crash-launch-recorded" }, "run:outcome_recorded");
  assert(await state(recorded.attempt.id) === "running", "the crash must leave the attempt running with its outcome recorded");
  const repaired = await reconcile({ attempt_id: recorded.attempt.id });
  const decision = decisionFor(repaired, recorded.attempt.id);
  assert(decision?.classification === "result_unrecorded" && decision.action === "repaired", `a recorded outcome must be applied: ${JSON.stringify(repaired.decisions)}`);
  const finished = await attempts.getExecutionAttempt(recorded.attempt.id);
  assert(finished.state === "verifying" && finished.transitions.at(-1).idempotency_key === `${decision.detail.run_id}:finish`, "the repair must use the runner's own finish key");

  const orphan = await provisioned("orphan");
  await crash("launch", { attempt_id: orphan.attempt.id, adapter: "fake", prompt: JSON.stringify({ sleep_ms: 20_000 }), idempotency_key: "crash-launch-orphan" }, "run:supervising");
  const pid = (await attempts.getExecutionAttempt(orphan.attempt.id)).process.pid;
  await sleep(1500);
  const quarantined = await reconcile({ attempt_id: orphan.attempt.id });
  const lost = decisionFor(quarantined, orphan.attempt.id);
  assert(lost?.action === "quarantined" && lost.reason === "heartbeat_lost" && ["orphaned_process", "dead_runner"].includes(lost.classification), `a lost supervisor must be quarantined: ${JSON.stringify(quarantined.decisions)}`);
  assert(await state(orphan.attempt.id) === "stale", "the attempt must be stale");
  if (lost.classification === "orphaned_process") {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert(alive && lost.detail.process_left_running === true, "reconciliation must leave a live harness process running");
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  }
  const again = await reconcile({ attempt_id: orphan.attempt.id });
  assert(again.decisions.length === 0 && again.summary.awaiting_operator === 1, "a quarantined attempt must wait for an operator on later runs");

  const healthy = await provisioned("healthy");
  const launched = await runs.launchExecutionAttempt({ attempt_id: healthy.attempt.id, adapter: "fake", prompt: JSON.stringify({ sleep_ms: 2500 }), idempotency_key: "reconciliation-launch-healthy" });
  await sleep(1200);
  const left = await reconcile({ attempt_id: healthy.attempt.id });
  assert(left.decisions.length === 0 && left.summary.healthy === 1 && await state(healthy.attempt.id) === "running", "a supervised run with a fresh heartbeat must be left alone");
  assert((await launched.completion)?.result === "completed", "the healthy run must finish normally");
}

// --- interrupted acceptance ------------------------------------------------------------------------------

{
  const fixture = await verifying("accept-crash");
  assert((await evidence.verifyExecutionAttempt({ attempt_id: fixture.attempt.id })).attempt.state === "reviewable", "the acceptance fixture must be reviewable");
  await crash("accept", { attempt_id: fixture.attempt.id, idempotency_key: "crash-accept", actor_kind: "operator", actor_id: "operator-1" }, "accept:committed");
  const interrupted = (await acceptance.listExecutionAcceptances({ attempt_id: fixture.attempt.id }))[0];
  assert(interrupted.status === "in_progress" && interrupted.step === "committed", "the crash must leave a committed, unfinished acceptance");
  const resumed = await reconcile({ attempt_id: fixture.attempt.id });
  assert(decisionFor(resumed, fixture.attempt.id)?.classification === "interrupted_acceptance" && decisionFor(resumed, fixture.attempt.id).action === "repaired", `an interrupted acceptance must be resumed: ${JSON.stringify(resumed.decisions)}`);
  const finished = (await acceptance.listExecutionAcceptances({ attempt_id: fixture.attempt.id }))[0];
  assert(finished.status === "accepted" && finished.commit_sha === interrupted.commit_sha && await state(fixture.attempt.id) === "accepted", "the resumed acceptance must finish on the same commit");
}

// --- workspace health: missing worktree, moved branch, drifted base, expired lease ---------------------------

{
  const missing = await verifying("missing-worktree");
  git(repo.dir, "worktree", "unlock", missing.worktree);
  rmSync(missing.worktree, { recursive: true, force: true });
  const missingRun = await reconcile({ attempt_id: missing.attempt.id });
  assert(decisionFor(missingRun, missing.attempt.id)?.reason === "worktree_missing" && await state(missing.attempt.id) === "stale", `a missing worktree must be quarantined: ${JSON.stringify(missingRun.decisions)}`);

  const moved = await verifying("moved-branch");
  git(moved.worktree, "checkout", "--quiet", "-b", "somewhere-else");
  const movedRun = await reconcile({ attempt_id: moved.attempt.id });
  assert(decisionFor(movedRun, moved.attempt.id)?.reason === "branch_moved", `a worktree off its branch must be quarantined: ${JSON.stringify(movedRun.decisions)}`);
  assert(existsSync(moved.worktree), "quarantine must not remove the worktree");

  const drifted = await verifying("drifted-base");
  const emptyTree = git(drifted.worktree, "hash-object", "-t", "tree", "-w", "--stdin");
  const unrelated = git(drifted.worktree, "commit-tree", emptyTree, "-m", "unrelated history");
  git(drifted.worktree, "reset", "--quiet", "--hard", unrelated);
  const driftRun = await reconcile({ attempt_id: drifted.attempt.id });
  assert(decisionFor(driftRun, drifted.attempt.id)?.reason === "base_drift", `a branch without its base must be quarantined: ${JSON.stringify(driftRun.decisions)}`);

  const expired = await verifying("expired-lease");
  sql("UPDATE execution_workspace_leases SET expires_at = ?, updated_at = ? WHERE id = ?", past(30), past(30), expired.leaseId);
  const expiredRun = await reconcile({ attempt_id: expired.attempt.id });
  const lease = (await workspaces.listExecutionWorkspaces({ attempt_id: expired.attempt.id }))[0];
  assert(decisionFor(expiredRun, expired.attempt.id)?.classification === "expired_lease" && decisionFor(expiredRun, expired.attempt.id).action === "repaired" && lease.status === "active" && !lease.expired, `an expired lease on an intact worktree must be renewed: ${JSON.stringify(expiredRun.decisions)}`);
  assert(await state(expired.attempt.id) === "verifying", "renewal must not change the attempt");

  // Operator quarantine of healthy work.
  const quarantined = await reconciliation.quarantineExecutionAttempt({ attempt_id: expired.attempt.id, idempotency_key: "operator-quarantine", actor_id: "operator-1", note: "inspect before review" });
  assert(quarantined.attempt.state === "reconciling" && quarantined.attempt.reconciliation_origin === "verifying", "operator quarantine must record the origin");
}

// --- leases of terminal attempts ----------------------------------------------------------------------------

{
  const clean = await provisioned("terminal-clean");
  const dirty = await verifying("terminal-dirty");
  for (const fixture of [clean, dirty]) {
    const current = await attempts.getExecutionAttempt(fixture.attempt.id);
    await attempts.transitionExecutionAttempt({ attempt_id: fixture.attempt.id, event: "cancel", expected_revision: current.revision, idempotency_key: `cancel-${fixture.attempt.id}`, actor_kind: "operator", actor_id: "operator-1", reason: "operator_requested" });
  }
  await sleep(20);
  const cleanRun = await reconcile({ attempt_id: clean.attempt.id });
  assert(decisionFor(cleanRun, clean.attempt.id)?.action === "released" && decisionFor(cleanRun, clean.attempt.id).detail.worktree === "removed" && !existsSync(clean.worktree), `a clean terminal worktree must be released: ${JSON.stringify(cleanRun.decisions)}`);
  const dirtyRun = await reconcile({ attempt_id: dirty.attempt.id });
  assert(decisionFor(dirtyRun, dirty.attempt.id)?.detail.worktree === "retained_dirty" && existsSync(dirty.worktree), `a dirty terminal worktree must be kept: ${JSON.stringify(dirtyRun.decisions)}`);
  assert(git(repo.dir, "rev-parse", "--verify", `refs/heads/${clean.branch}`), "released leases must keep their branches");
  const repeat = await reconcile({ attempt_id: dirty.attempt.id });
  assert(repeat.decisions.length === 0, "a second run must find nothing left to do");
}

// --- reports, lock, and surfaces -----------------------------------------------------------------------------

{
  const lapsed = await provisioned("lapsed-claim");
  await store.endAgentSession({ session_id: lapsed.sessionId, release_claims: false });
  mkdirSync(join(process.env.CLAW_TASK_HUB_WORKSPACE_ROOT, "stray-repository", "stray-worktree"), { recursive: true });
  const reportRun = await reconciliation.reconcileExecution({ actor_kind: "operator", actor_id: "operator-1" });
  assert(reportRun.summary.lapsed_claims.some((claim) => claim.attempt_id === lapsed.attempt.id), `a lapsed claim must be reported: ${JSON.stringify(reportRun.summary.lapsed_claims)}`);
  assert(reportRun.summary.unowned_worktrees.some((path) => path.endsWith("stray-worktree")), "a directory no lease owns must be reported");
  assert(await state(lapsed.attempt.id) === "provisioning", "reports must not change attempts");

  sql("INSERT INTO execution_reconciliation_runs (id, trigger, actor_kind, actor_id, status, scope, summary, started_at) VALUES ('reconciliation_held', 'manual', 'operator', 'other', 'running', '{}', '{}', ?)", new Date().toISOString());
  await expectFailure(() => reconcile(), "reconciliation_in_progress", "a second concurrent run");
  sql("UPDATE execution_reconciliation_runs SET started_at = ? WHERE id = 'reconciliation_held'", past(20));
  const takeover = await reconciliation.reconcileExecution({ actor_kind: "operator", actor_id: "operator-1" });
  assert(takeover.status === "completed" && (await reconciliation.getReconciliationRun("reconciliation_held")).status === "abandoned", "a run that stopped reporting must be abandoned and replaced");
  assert((await reconciliation.listReconciliationRuns({ limit: 200 })).some((run) => run.id === takeover.id), "runs must be listed");
}

function runHub(tool, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["server/hub-cli.ts", "tools/call", tool, `base64:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}`], { cwd: process.cwd(), env: process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (status) => setTimeout(() => resolve({ status, stdout, stderr }), 50));
  });
}

{
  const cli = await runHub("reconcile_execution", { actor_kind: "operator", actor_id: "operator-cli" });
  assert(cli.status === 0 && JSON.parse(cli.stdout).status === "completed", `CLI reconcile_execution failed:\n${cli.stderr}`);

  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_reconciliation_run", arguments: { id: "reconciliation_missing" } } }),
    "",
  ].join("\n");
  const mcp = spawnSync(process.execPath, ["server/mcp-server.ts"], { cwd: process.cwd(), env: process.env, input, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert(mcp.status === 0, `MCP server failed:\n${mcp.stderr}`);
  const messages = String(mcp.stdout).split(/\r?\n/).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
  const byId = (id) => messages.find((message) => message.id === id);
  const names = (byId(2)?.result?.tools ?? []).map((tool) => tool.name);
  for (const name of ["reconcile_execution", "list_reconciliation_runs", "get_reconciliation_run", "quarantine_execution_attempt"]) assert(names.includes(name), `MCP does not describe ${name}`);
  assert(byId(3)?.error?.message?.startsWith("run_not_found:"), `MCP must surface typed reconciliation failures, got ${JSON.stringify(byId(3))}`);

  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
  const api = spawn(process.execPath, ["server/index.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, windowsHide: true, detached: process.platform !== "win32" });
  let diagnostics = "";
  api.stdout.on("data", (chunk) => { diagnostics += chunk; });
  api.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const base = `http://127.0.0.1:${port}/api`;
  const call = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, { ...options, headers: { "content-type": "application/json" } });
    return { status: response.status, body: await response.json() };
  };
  try {
    for (let tries = 0; ; tries += 1) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {
        // not listening yet
      }
      if (tries >= 100) throw new Error(`API did not start\n${diagnostics}`);
      await sleep(100);
    }
    let result = await call("/execution-reconciliation", { method: "POST", body: JSON.stringify({ actor_kind: "operator", actor_id: "operator-http" }) });
    assert(result.status === 200 && result.body.run.status === "completed", `HTTP reconcile failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call("/execution-reconciliation/runs?limit=5");
    assert(result.status === 200 && result.body.runs.length > 0, `HTTP run list failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call("/execution-reconciliation/runs/reconciliation_missing");
    assert(result.status === 404 && result.body.code === "run_not_found", `HTTP missing run must be 404: ${result.status} ${JSON.stringify(result.body)}`);
    const terminal = (await attempts.listExecutionAttempts({ state: "canceled" }))[0];
    result = await call(`/execution-attempts/${terminal.id}/quarantine`, { method: "POST", body: JSON.stringify({ idempotency_key: "http-quarantine", actor_id: "operator-http" }) });
    assert(result.status === 409 && result.body.code === "terminal_state", `HTTP quarantine of a terminal attempt must be 409: ${result.status} ${JSON.stringify(result.body)}`);
  } finally {
    await stopProcessTree(api);
  }
}

console.log("Execution reconciliation regression passed");
