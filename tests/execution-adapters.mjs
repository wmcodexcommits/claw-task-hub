// Execution adapter and harness run regression.
//
// Uses the deterministic fake harness, which follows the Codex exec invocation
// contract, inside real leased worktrees of a temporary Git repository. Covers
// the adapter registry, executable resolution, the Codex argument vector and
// JSONL reading, the environment allowlist and secret scrubbing, launch gating
// (a duplicate launch never receives instructions), capability and readiness
// refusals before any process starts, completion and failure transitions with
// log artifacts, output bounds, wall-clock and idle timeouts, cancellation from
// another process terminating the whole process tree, and the CLI, MCP, and HTTP
// surfaces.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
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

const SECRET = "fake-harness-secret-value-0123456789";

if (process.env.CLAW_TASK_HUB_ADAPTERS_WORKER !== "1") {
  const parentTempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-adapters-"));
  const gitConfig = join(parentTempDir, "gitconfig");
  writeFileSync(gitConfig, "");
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAW_TASK_HUB_DB: join(parentTempDir, "hub", "adapters.sqlite"),
      CLAW_TASK_HUB_WORKSPACE_ROOT: join(parentTempDir, "workspaces"),
      CLAW_TASK_HUB_ADAPTERS_TEMP: parentTempDir,
      CLAW_TASK_HUB_QUIET_DB: "1",
      CLAW_TASK_HUB_ADAPTERS_WORKER: "1",
      CLAW_TASK_HUB_ENABLE_FAKE_HARNESS: "1",
      CLAW_TASK_HUB_FAKE_HARNESS_SECRET: SECRET,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Adapter Test",
      GIT_AUTHOR_EMAIL: "adapter@example.com",
      GIT_COMMITTER_NAME: "Adapter Test",
      GIT_COMMITTER_EMAIL: "adapter@example.com",
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
    console.error("Execution adapter cleanup failed after the worker exited:", error);
  }
  process.exit(cleanupFailed ? 1 : result.status ?? 1);
}

const tempRoot = process.env.CLAW_TASK_HUB_ADAPTERS_TEMP;
assert(tempRoot && process.env.CLAW_TASK_HUB_DB, "Execution adapter worker requires its temp directory and database");

const dbModule = await import("../server/db.ts");
const store = await import("../server/store.ts");
const attempts = await import("../server/execution-attempts.ts");
const workspaces = await import("../server/execution-workspaces.ts");
const adapters = await import("../server/execution-adapters.ts");
const runs = await import("../server/execution-runs.ts");
const { ExecutionContractError, executionBounds } = await import("../server/execution-contract.ts");

dbModule.initializeDatabase(dbModule.db);
await store.ensureDefaultTeam();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await sleep(50);
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: process.env, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stderr}`);
  return result.stdout.trim();
}

async function expectFailure(run, code, message) {
  try {
    await run();
  } catch (error) {
    const typed = error instanceof runs.ExecutionRunError
      || error instanceof workspaces.ExecutionWorkspaceError
      || error instanceof attempts.ExecutionAttemptError
      || error instanceof ExecutionContractError;
    assert(typed, `${message}: expected a typed failure, got ${error instanceof Error ? error.stack : error}`);
    assert(error.code === code, `${message}: expected ${code}, got ${error.code} (${error.message})`);
    assert(error.message.startsWith(`${code}:`), `${message}: the message must lead with its code (${error.message})`);
    return error;
  }
  throw new Error(`${message}: expected ${code}, but it succeeded`);
}

const repoDir = join(tempRoot, "repos", "service");
mkdirSync(repoDir, { recursive: true });
git(repoDir, "init", "--quiet", "-b", "main");
writeFileSync(join(repoDir, "README.md"), "base\n");
git(repoDir, "add", "README.md");
git(repoDir, "commit", "--quiet", "-m", "base");
git(repoDir, "remote", "add", "origin", "https://example.com/claw/service.git");
const repo = { dir: realpathSync.native(repoDir), sha: git(repoDir, "rev-parse", "HEAD"), remote: "https://example.com/claw/service.git" };

const project = await store.upsertProject({ external_id: "adapters-project", name: "Adapters Project" });
let issueNumber = 970000;
async function claimedIssue() {
  issueNumber += 1;
  const identifier = `CTH-${issueNumber}`;
  const sessionId = `session-adapters-${issueNumber}`;
  const issue = await store.upsertIssue({ title: `Adapter target ${identifier}`, identifier, status: "Todo", project_id: project.id });
  await store.startAgentSession({ id: sessionId, agent_name: `Agent ${identifier}`, harness: "codex", ttl_minutes: 240 });
  const { claim } = await store.claimIssue({ issue_id: identifier, session_id: sessionId, ttl_minutes: 240 });
  return { issue, claim };
}

function attemptInput(target) {
  return {
    issue_id: target.issue.identifier,
    claim_id: target.claim.id,
    harness: "fake",
    repository: repo.remote,
    base_sha: repo.sha,
    idempotency_key: `adapter-create-${target.issue.identifier}`,
  };
}

async function prepared() {
  const target = await claimedIssue();
  const started = await workspaces.startExecutionAttempt({ ...attemptInput(target), repository_path: repo.dir });
  return { attempt: started.attempt, workspace: started.workspace };
}

let launchCounter = 0;
function launch(target, script, overrides = {}) {
  launchCounter += 1;
  return runs.launchExecutionAttempt({
    attempt_id: target.attempt.id,
    adapter: "fake",
    prompt: JSON.stringify(script),
    idempotency_key: `adapter-launch-${launchCounter}`,
    ...overrides,
  });
}

const artifactRef = (attempt, kind) => attempt.artifacts.find((artifact) => artifact.kind === kind)?.ref;

// --- registry, executable resolution, Codex invocation ----------------------------------

{
  const listed = adapters.listExecutionAdapters();
  const fake = listed.find((adapter) => adapter.id === "fake");
  const codex = listed.find((adapter) => adapter.id === "codex");
  assert(fake?.available === true, `the fake adapter must be available when enabled: ${JSON.stringify(fake)}`);
  assert(codex?.capabilities.includes("model_selection") && codex.secret_environment.includes("OPENAI_API_KEY"), "the codex adapter must declare model selection and its credential variables");

  assert(!adapters.locateExecutable("codex", "relative/codex", "SETTING").ok, "a relative configured executable must be refused");
  assert(!adapters.locateExecutable("codex", join(tempRoot, "missing-codex.exe"), "SETTING").ok, "a configured executable that does not exist must be refused");
  assert(adapters.locateExecutable("codex", process.execPath, "SETTING").ok, "an absolute native executable must be accepted");
  if (process.platform === "win32") {
    const shimDirectory = join(tempRoot, "shim");
    mkdirSync(shimDirectory, { recursive: true });
    writeFileSync(join(shimDirectory, "codex.cmd"), "@echo off\r\n");
    assert(!adapters.locateExecutable("codex", join(shimDirectory, "codex.cmd"), "SETTING").ok, "a configured .cmd shim must be refused because it needs a shell");
    const savedPath = process.env.PATH;
    process.env.PATH = shimDirectory;
    try {
      const located = adapters.locateExecutable("codex", undefined, "SETTING");
      assert(!located.ok && located.reason.includes("shim"), `a .cmd shim found on PATH must be refused, got ${JSON.stringify(located)}`);
    } finally {
      process.env.PATH = savedPath;
    }
  }

  const codexAdapter = adapters.getExecutionAdapter("codex");
  const context = {
    attempt: { id: "attempt_example", issue_id: "issue_example", issue_identifier: "CTH-1", base_sha: "a".repeat(40) },
    workspace: { worktree_path: "/work/tree", branch: "cth/cth-1/attempt_example", lease_id: "lease_example" },
    model: "gpt-5-codex",
    final_message_path: "/logs/final.txt",
  };
  const argv = codexAdapter.buildArgs(context);
  assert(
    JSON.stringify(argv) === JSON.stringify(["exec", "--json", "--color", "never", "--cd", "/work/tree", "--sandbox", "workspace-write", "--output-last-message", "/logs/final.txt", "--model", "gpt-5-codex", "-"]),
    `unexpected codex argument vector ${JSON.stringify(argv)}`,
  );
  assert(!argv.some((arg) => /dangerous|bypass/i.test(arg)), "the codex adapter must never bypass approvals or the sandbox");

  const reader = codexAdapter.readEvents();
  for (const line of ['{"type":"thread.started","thread_id":"thread-1"}', "not an event", '{"type":"item.completed","item":{}}', '{"type":"turn.completed","usage":{}}']) reader.line(line);
  assert(JSON.stringify(reader.report()) === JSON.stringify({ events: 3, thread_id: "thread-1", completed: true, failure: null }), `unexpected codex report ${JSON.stringify(reader.report())}`);
  const failedReader = codexAdapter.readEvents();
  failedReader.line('{"type":"turn.failed","error":{"message":"quota exceeded"}}');
  assert(failedReader.report().failure === "quota exceeded" && !failedReader.report().completed, "turn.failed must be read as a failure");

  process.env.OPENAI_API_KEY = "sk-test-openai-key-value";
  try {
    const environment = adapters.buildHarnessEnvironment(codexAdapter, context);
    assert(!Object.keys(environment.env).some((name) => name.toUpperCase() === "CLAW_TASK_HUB_DB"), "the hub's own settings must not reach a harness");
    assert(environment.env.OPENAI_API_KEY === "sk-test-openai-key-value" && environment.secrets.some((secret) => secret.name === "OPENAI_API_KEY"), "declared credential variables must pass through and be marked for scrubbing");
    assert(environment.env.CLAW_TASK_HUB_ATTEMPT_ID === "attempt_example" && environment.names.some((name) => name.toUpperCase() === "PATH"), "the harness environment must carry PATH and its attempt identity");
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
}

// --- a successful run ----------------------------------------------------------------------

const success = await prepared();
{
  const launched = await launch(success, {
    write: [{ path: "agent-output.txt", content: "made by the fake harness\n" }],
    print_env: ["CLAW_TASK_HUB_FAKE_HARNESS_SECRET", "CLAW_TASK_HUB_DB", "CLAW_TASK_HUB_ATTEMPT_ID"],
    stdout: ["working"],
    stderr: ["progress on stderr"],
    last_message: "done",
  });
  assert(!launched.replayed && launched.attempt.state === "running" && launched.attempt.revision === 1, `launch must move the attempt to running, got ${JSON.stringify(launched.attempt)}`);
  assert(launched.attempt.process.pid === launched.run.pid && launched.attempt.workspace.lease_id === success.workspace.id, "launch must bind the process and the workspace lease");
  const launchDetails = launched.attempt.transitions[0].details;
  assert(launchDetails.adapter === "fake" && launchDetails.adapter_version === "fake-harness 1", `launch must record adapter identity and version: ${JSON.stringify(launchDetails)}`);
  assert(launchDetails.secret_environment.includes("CLAW_TASK_HUB_FAKE_HARNESS_SECRET"), "launch must record which credential variables were passed");
  assert(!JSON.stringify(launched.attempt).includes(SECRET), "a credential value must never enter the attempt record");

  const outcome = await launched.completion;
  assert(outcome.result === "completed" && outcome.event === "complete_run" && outcome.exit_code === 0 && outcome.thread_id?.startsWith("fake-"), `unexpected outcome ${JSON.stringify(outcome)}`);
  const finished = await attempts.getExecutionAttempt(success.attempt.id);
  assert(finished.state === "verifying" && finished.revision === 2, `a completed run must move the attempt to verifying, got ${finished.state}@${finished.revision}`);
  for (const kind of ["harness_stdout", "harness_stderr", "harness_final_message"]) assert(artifactRef(finished, kind), `the run must record a ${kind} artifact`);
  const stdoutLog = readFileSync(artifactRef(finished, "harness_stdout"), "utf8");
  assert(stdoutLog.includes("CLAW_TASK_HUB_FAKE_HARNESS_SECRET=[redacted:CLAW_TASK_HUB_FAKE_HARNESS_SECRET]") && !stdoutLog.includes(SECRET), "captured output must scrub credential values");
  assert(stdoutLog.includes("CLAW_TASK_HUB_DB=unset"), "a variable outside the allowlist must not reach the harness");
  assert(stdoutLog.includes(`CLAW_TASK_HUB_ATTEMPT_ID=${success.attempt.id}`), "the harness must receive its attempt identity");
  assert(readFileSync(artifactRef(finished, "harness_stderr"), "utf8").includes("progress on stderr"), "stderr must be captured");
  assert(readFileSync(artifactRef(finished, "harness_final_message"), "utf8") === "done", "the final message must be captured");
  assert(readFileSync(join(success.workspace.worktree_path, "agent-output.txt"), "utf8") === "made by the fake harness\n", "the harness must run inside the leased worktree");
  assert(!existsSync(join(repo.dir, "agent-output.txt")), "the harness must not write into the operator's checkout");
  const finish = finished.transitions[1];
  assert(finish.event === "complete_run" && finish.details.exit_code === 0 && finish.details.events >= 3, `the ledger must record the run: ${JSON.stringify(finish)}`);
  assert(!JSON.stringify(finished).includes(SECRET), "a credential value must never enter the ledger");
}

// --- refusals before any process starts ------------------------------------------------------

{
  const guarded = await prepared();
  const marker = { write: [{ path: "must-not-exist.txt", content: "ran" }] };
  await expectFailure(() => launch(guarded, marker, { model: "gpt-5-codex" }), "capability_unsupported", "a model for an adapter without model selection");
  await expectFailure(() => launch(guarded, marker, { requires: ["telepathy"] }), "invalid_input", "an unknown capability");
  await expectFailure(() => launch(guarded, marker, { adapter: "claude" }), "adapter_unknown", "an adapter that does not exist");
  await expectFailure(() => launch(guarded, marker, { prompt: " " }), "invalid_input", "a blank prompt");
  await expectFailure(() => launch(guarded, marker, { wall_clock_ms: executionBounds.harness_wall_clock.value + 1 }), "invalid_input", "loosening a contract bound");
  process.env.CLAW_TASK_HUB_ENABLE_FAKE_HARNESS = "0";
  try {
    await expectFailure(() => launch(guarded, marker), "adapter_unavailable", "a disabled adapter");
  } finally {
    process.env.CLAW_TASK_HUB_ENABLE_FAKE_HARNESS = "1";
  }
  const bare = await claimedIssue();
  const unprovisioned = (await attempts.createExecutionAttempt(attemptInput(bare))).attempt;
  await expectFailure(() => launch({ attempt: unprovisioned }, marker), "workspace_not_ready", "an attempt without a workspace lease");
  await expectFailure(() => launch(success, marker), "attempt_not_launchable", "an attempt that already ran");
  await expectFailure(() => launch({ attempt: { id: "attempt_missing" } }, marker), "attempt_not_found", "a missing attempt");

  const untouched = await attempts.getExecutionAttempt(guarded.attempt.id);
  assert(untouched.state === "provisioning" && untouched.revision === 0, "a refused launch must leave the attempt untouched");
  assert(!existsSync(join(guarded.workspace.worktree_path, "must-not-exist.txt")), "a refused launch must never start the harness");
}

// --- failures, bounds, and timeouts -------------------------------------------------------------

{
  const exiting = await prepared();
  const exited = await (await launch(exiting, { stderr: ["boom from the harness"], exit_code: 3 })).completion;
  assert(exited.result === "failed" && exited.reason === "harness_failed" && exited.exit_code === 3, `a non-zero exit must fail the attempt: ${JSON.stringify(exited)}`);
  const exitedAttempt = await attempts.getExecutionAttempt(exiting.attempt.id);
  assert(exitedAttempt.state === "failed" && exitedAttempt.state_reason === "harness_failed", "the attempt must record harness_failed");
  assert(readFileSync(artifactRef(exitedAttempt, "harness_stderr"), "utf8").includes("boom from the harness"), "a failed run must keep its stderr");

  const declining = await prepared();
  const declined = await (await launch(declining, { fail_turn: "the model declined" })).completion;
  assert(declined.result === "failed" && declined.exit_code === 0 && declined.failure === "the model declined", `a failed turn must fail the attempt even when the process exits 0: ${JSON.stringify(declined)}`);
  assert((await attempts.getExecutionAttempt(declining.attempt.id)).transitions.at(-1).note === "the model declined", "the failure message must be recorded on the transition");

  const flooding = await prepared();
  const flooded = await (await launch(flooding, { flood_bytes: 300_000 }, { captured_stream_bytes: 4096 })).completion;
  assert(flooded.result === "completed" && flooded.stdout_truncated && flooded.stdout_bytes > 300_000, `output beyond the bound must be counted and truncated: ${JSON.stringify(flooded)}`);
  const floodLog = readFileSync(flooded.artifacts.find((artifact) => artifact.kind === "harness_stdout").ref, "utf8");
  assert(floodLog.includes("bytes omitted") && floodLog.length < 4096 + 200, `the stored log must stay within the bound with an explicit marker (${floodLog.length} characters)`);

  const slow = await prepared();
  const startedSlow = Date.now();
  const wallClock = await (await launch(slow, { sleep_ms: 30_000, heartbeat_ms: 50 }, { wall_clock_ms: 400, cancellation_grace_ms: 200 })).completion;
  assert(wallClock.result === "failed" && wallClock.reason === "harness_timeout" && wallClock.timeout === "wall_clock", `the wall-clock bound must fail the attempt: ${JSON.stringify(wallClock)}`);
  assert(Date.now() - startedSlow < 15_000, "the wall-clock bound must stop the harness promptly");

  const silent = await prepared();
  const idle = await (await launch(silent, { sleep_ms: 30_000 }, { idle_output_ms: 400, cancellation_grace_ms: 200 })).completion;
  assert(idle.result === "failed" && idle.timeout === "idle_output" && idle.reason === "harness_timeout", `the idle-output bound must fail a silent harness: ${JSON.stringify(idle)}`);

  const chatty = await prepared();
  const alive = await (await launch(chatty, { sleep_ms: 1_200, heartbeat_ms: 100 }, { idle_output_ms: 500 })).completion;
  assert(alive.result === "completed" && alive.timeout === null, `regular output must keep the idle bound from firing: ${JSON.stringify(alive)}`);
}

// --- cancellation from another process stops the whole tree --------------------------------------

function runHub(tool, payload) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["server/hub-cli.ts", "tools/call", tool, `base64:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}`],
      { cwd: process.cwd(), env: process.env, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

{
  const cancelable = await prepared();
  const launched = await launch(cancelable, { grandchild_heartbeat: "heartbeat.txt", sleep_ms: 60_000 }, { cancellation_grace_ms: 300 });
  const heartbeat = join(cancelable.workspace.worktree_path, "heartbeat.txt");
  await waitFor(() => existsSync(heartbeat), "the harness's child process never started", 15_000);
  const canceled = await runHub("transition_execution_attempt", {
    attempt_id: cancelable.attempt.id,
    event: "cancel",
    expected_revision: 1,
    idempotency_key: "cancel-from-another-process",
    actor_kind: "operator",
    actor_id: "operator-1",
    reason: "operator_requested",
  });
  assert(canceled.status === 0, `the CLI cancel failed:\n${canceled.stderr}`);
  const stopped = await launched.completion;
  assert(stopped.result === "stopped" && stopped.stopped_by_state === "canceled" && stopped.termination !== null, `a cancellation must stop the run: ${JSON.stringify(stopped)}`);
  assert(!processAlive(launched.run.pid), "the harness process must be gone after cancellation");
  const beat = readFileSync(heartbeat, "utf8");
  await sleep(800);
  assert(readFileSync(heartbeat, "utf8") === beat, "the harness's child process must be terminated with the tree");
  assert((await attempts.getExecutionAttempt(cancelable.attempt.id)).state === "canceled", "the attempt must stay canceled");
}

// --- a duplicate launch never receives instructions -------------------------------------------------

{
  const contested = await prepared();
  const script = { append_launch: "launches.txt", sleep_ms: 300 };
  const results = await Promise.allSettled(["race-launch-a", "race-launch-b"].map((idempotency_key) => launch(contested, script, { idempotency_key })));
  const winners = results.filter((result) => result.status === "fulfilled");
  const losers = results.filter((result) => result.status === "rejected");
  assert(winners.length === 1 && losers.length === 1, `exactly one of two concurrent launches may win, got ${winners.length}`);
  assert(losers[0].reason.code === "revision_conflict", `the losing launch must see revision_conflict, got ${losers[0].reason.code}`);
  const winner = winners[0].value;
  const replay = await launch(contested, script, { idempotency_key: winner.attempt.last_idempotency_key });
  assert(replay.replayed === true && replay.run === null, "repeating the winning launch must not start another harness");
  const outcome = await winner.completion;
  assert(outcome.result === "completed", `the winning run must complete: ${JSON.stringify(outcome)}`);
  const launches = readFileSync(join(contested.workspace.worktree_path, "launches.txt"), "utf8").trim().split(/\r?\n/);
  assert(launches.length === 1 && Number(launches[0]) === winner.run.pid, `only the winning launch may receive instructions, saw ${JSON.stringify(launches)}`);
}

// --- CLI, MCP, and HTTP ---------------------------------------------------------------------------------

{
  const viaCli = await prepared();
  const cli = await runHub("launch_execution_attempt", { attempt_id: viaCli.attempt.id, adapter: "fake", prompt: JSON.stringify({ last_message: "cli done" }), idempotency_key: "cli-launch", wait: true });
  assert(cli.status === 0 && JSON.parse(cli.stdout).outcome?.event === "complete_run", `CLI launch with wait must return the outcome:\n${cli.stdout}\n${cli.stderr}`);

  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_execution_adapters", arguments: {} } }),
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "launch_execution_attempt", arguments: { attempt_id: viaCli.attempt.id, adapter: "fake", prompt: "{}", idempotency_key: "mcp-relaunch" } } }),
    "",
  ].join("\n");
  const mcp = spawnSync(process.execPath, ["server/mcp-server.ts"], { cwd: process.cwd(), env: process.env, input, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert(mcp.status === 0, `MCP server failed:\n${mcp.stderr}`);
  const messages = String(mcp.stdout).split(/\r?\n/).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
  const byId = (id) => messages.find((message) => message.id === id);
  const launchSchema = byId(2)?.result?.tools?.find((tool) => tool.name === "launch_execution_attempt")?.inputSchema;
  for (const field of ["attempt_id", "adapter", "prompt", "idempotency_key"]) assert(launchSchema?.required?.includes(field), `MCP launch_execution_attempt must require ${field}`);
  assert(JSON.parse(byId(3)?.result?.content?.[0]?.text ?? "{}").adapters?.some((adapter) => adapter.id === "fake" && adapter.available), `MCP list_execution_adapters failed: ${JSON.stringify(byId(3))}`);
  assert(byId(4)?.error?.message?.startsWith("attempt_not_launchable:"), `MCP must surface typed launch failures, got ${JSON.stringify(byId(4))}`);

  const viaHttp = await prepared();
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
    let result = await call("/execution-adapters");
    assert(result.status === 200 && result.body.adapters.some((adapter) => adapter.id === "codex"), `HTTP adapter list failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/execution-attempts/${viaHttp.attempt.id}/launch`, { method: "POST", body: JSON.stringify({ adapter: "fake", prompt: JSON.stringify({ last_message: "http done" }), idempotency_key: "http-launch", wait: true }) });
    assert(result.status === 200 && result.body.outcome?.event === "complete_run", `HTTP launch with wait failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/execution-attempts/${viaHttp.attempt.id}/launch`, { method: "POST", body: JSON.stringify({ adapter: "fake", prompt: "{}", idempotency_key: "http-relaunch" }) });
    assert(result.status === 409 && result.body.code === "attempt_not_launchable", `HTTP relaunch must be 409 attempt_not_launchable: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/execution-attempts/${viaHttp.attempt.id}/launch`, { method: "POST", body: JSON.stringify({ adapter: "claude", prompt: "{}", idempotency_key: "http-unknown" }) });
    assert(result.status === 404 && result.body.code === "adapter_unknown", `HTTP unknown adapter must be 404: ${result.status} ${JSON.stringify(result.body)}`);
  } finally {
    await stopProcessTree(api);
  }
}

console.log("Execution adapter regression passed");
