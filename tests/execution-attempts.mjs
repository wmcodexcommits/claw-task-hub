// Execution attempt persistence regression.
//
// Covers the durable attempt record: it is stored apart from issues, claims,
// sessions, and comments; it survives a process restart; a retry adds a new
// attempt instead of rewriting the old one; compare-and-set and idempotency stop
// concurrent writers -- including separate processes -- from launching twice; an
// issue's history lists every attempt; and the store, CLI, MCP, and HTTP surfaces
// expose the same operations with the same typed failures.
//
// Runs in a spawned worker with CLAW_TASK_HUB_DB pointed at a temp file, the same
// shape as statement-cache.mjs, because server/db.ts opens its handle at import.
import { mkdtempSync } from "node:fs";
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

if (process.env.CLAW_TASK_HUB_ATTEMPTS_WORKER !== "1") {
  const parentTempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-attempts-"));
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAW_TASK_HUB_DB: join(parentTempDir, "attempts.sqlite"),
      CLAW_TASK_HUB_QUIET_DB: "1",
      CLAW_TASK_HUB_ATTEMPTS_WORKER: "1",
    },
    stdio: "inherit",
    windowsHide: true,
  });
  let cleanupFailed = false;
  try {
    removeTemporaryDirectory(parentTempDir);
  } catch (error) {
    cleanupFailed = true;
    console.error("Execution attempt cleanup failed after the worker exited:", error);
  }
  process.exit(cleanupFailed ? 1 : result.status ?? 1);
}

if (!process.env.CLAW_TASK_HUB_DB) throw new Error("Execution attempt worker requires CLAW_TASK_HUB_DB");

const dbModule = await import("../server/db.ts");
const store = await import("../server/store.ts");
const attempts = await import("../server/execution-attempts.ts");
const { EXECUTION_CONTRACT_VERSION, ExecutionContractError, executionActorKinds, executionEvents } = await import("../server/execution-contract.ts");
const { ExecutionAttemptError } = attempts;

dbModule.initializeDatabase(dbModule.db);
await store.ensureDefaultTeam();

// Mixed case on purpose: the stored SHA must be normalized to lowercase.
const SHA_A = "0123456789ABCDEF0123456789ABCDEF01234567";
const SHA_B = "b".repeat(40);
const REPO = "https://example.com/claw/claw-task-hub.git";
const controlPlane = { actor_kind: "control_plane", actor_id: "hub" };
const operator = { actor_kind: "operator", actor_id: "operator-1" };

let keyCounter = 0;
const key = (label) => `${label}-${++keyCounter}`;

async function expectFailure(run, code, message) {
  try {
    await run();
  } catch (error) {
    assert(
      error instanceof ExecutionAttemptError || error instanceof ExecutionContractError,
      `${message}: expected a typed failure, got ${error instanceof Error ? error.stack : error}`,
    );
    assert(error.code === code, `${message}: expected ${code}, got ${error.code} (${error.message})`);
    assert(error.message.startsWith(`${code}:`), `${message}: the message must lead with its code for CLI and MCP callers (${error.message})`);
    return error;
  }
  throw new Error(`${message}: expected ${code}, but it succeeded`);
}

// --- schema and migration ----------------------------------------------------

const attemptSchemaNames = [
  "execution_attempts",
  "execution_attempt_transitions",
  "execution_workspace_leases",
  "verification_policies",
  "execution_evidence",
  "execution_path_declarations",
  "execution_conflict_policies",
  "execution_conflicts",
  "execution_conflict_decisions",
  "execution_acceptance_policies",
  "execution_acceptances",
  "execution_runners",
  "execution_reconciliation_runs",
  "execution_reconciliation_decisions",
  "idx_execution_attempts_live_issue",
  "idx_workspace_leases_live_attempt",
  "idx_execution_conflicts_repository_status",
];

function attemptSchemaObjects() {
  return dbModule.db
    .prepare(`SELECT name FROM sqlite_master WHERE name IN (${attemptSchemaNames.map((name) => `'${name}'`).join(", ")})`)
    .all()
    .map((row) => row.name);
}

{
  assert(attemptSchemaObjects().length === attemptSchemaNames.length, `the bootstrap schema must create the attempt, lease, evidence, and policy tables and live indexes, found ${JSON.stringify(attemptSchemaObjects())}`);
  // An existing database from before attempts existed: no tables, no ledger row.
  dbModule.db.exec("DROP TABLE execution_reconciliation_decisions; DROP TABLE execution_reconciliation_runs; DROP TABLE execution_runners; DROP TABLE execution_acceptances; DROP TABLE execution_acceptance_policies; DROP TABLE execution_conflict_decisions; DROP TABLE execution_conflicts; DROP TABLE execution_conflict_policies; DROP TABLE execution_path_declarations; DROP TABLE execution_evidence; DROP TABLE verification_policies; DROP TABLE execution_workspace_leases; DROP TABLE execution_attempt_transitions; DROP TABLE execution_attempts; DELETE FROM schema_migrations WHERE id = '0007_execution_attempts'");
  assert(attemptSchemaObjects().length === 0, "the simulated pre-attempt database still has attempt tables");
  const upgraded = dbModule.runMigrations(dbModule.db);
  assert(upgraded.applied.includes("0007_execution_attempts"), `migration 0007 must upgrade a database without attempt tables, applied ${JSON.stringify(upgraded.applied)}`);
  assert(attemptSchemaObjects().length === attemptSchemaNames.length, "migration 0007 did not create the attempt and lease tables and live indexes");
  const again = dbModule.runMigrations(dbModule.db);
  assert(again.applied.length === 0, `rerunning migrations must be a no-op, re-applied ${JSON.stringify(again.applied)}`);
}

// --- fixtures ------------------------------------------------------------------

const project = await store.upsertProject({ external_id: "attempts-project", name: "Attempts Project" });

async function openIssue(identifier, sessionId) {
  const issue = await store.upsertIssue({ title: `Attempt target ${identifier}`, identifier, status: "Todo", project_id: project.id });
  await store.startAgentSession({ id: sessionId, agent_name: `Agent ${sessionId}`, harness: "codex", ttl_minutes: 120 });
  const { claim } = await store.claimIssue({ issue_id: identifier, session_id: sessionId, ttl_minutes: 120 });
  return { issue, claim };
}

function createInput(target, overrides = {}) {
  return {
    issue_id: target.issue.identifier,
    claim_id: target.claim.id,
    harness: "codex",
    harness_version: "1.2.3",
    repository: REPO,
    base_sha: SHA_A,
    idempotency_key: key("create"),
    provenance: { requested_by: "execution attempt regression" },
    ...overrides,
  };
}

async function commentCount(issueId) {
  return (await store.getIssue(issueId)).comments.length;
}

const primary = await openIssue("CTH-950001", "session-attempts-a");
const secondary = await openIssue("CTH-950002", "session-attempts-b");

// --- creation guards ------------------------------------------------------------

{
  await expectFailure(() => attempts.createExecutionAttempt(createInput(primary, { claim_id: undefined })), "invalid_input", "creating without a claim");
  await expectFailure(() => attempts.createExecutionAttempt(createInput(primary, { base_sha: "abc123" })), "invalid_input", "an abbreviated base SHA");
  await expectFailure(() => attempts.createExecutionAttempt(createInput(primary, { repository: "https://user:token@example.com/claw.git" })), "invalid_input", "a repository URL carrying credentials");
  await expectFailure(() => attempts.createExecutionAttempt(createInput(primary, { repository: "https://ghp_token@example.com/claw.git" })), "invalid_input", "a repository URL carrying a bare token");
  await expectFailure(() => attempts.createExecutionAttempt(createInput(primary, { harness: "codex; rm -rf /" })), "invalid_input", "a harness id outside the adapter pattern");
  await expectFailure(() => attempts.createExecutionAttempt(createInput(primary, { provenance: ["not", "an", "object"] })), "invalid_input", "array provenance");
  await expectFailure(() => attempts.createExecutionAttempt(createInput(primary, { issue_id: "CTH-959999" })), "issue_not_found", "an unknown issue");
  await expectFailure(() => attempts.createExecutionAttempt(createInput(primary, { claim_id: secondary.claim.id })), "claim_not_active", "a claim that belongs to another issue");

  const released = await openIssue("CTH-950003", "session-attempts-c");
  await store.releaseIssueClaim({ claim_id: released.claim.id, status: "released" });
  await expectFailure(() => attempts.createExecutionAttempt(createInput(released)), "claim_not_active", "a released claim");

  const closing = await openIssue("CTH-950004", "session-attempts-c");
  await store.updateIssue(closing.issue.id, { status: "Done" });
  await expectFailure(() => attempts.createExecutionAttempt(createInput(closing)), "issue_closed", "an attempt on a completed issue");

  const sshRemote = await attempts.createExecutionAttempt(createInput(secondary, { repository: "ssh://git@example.com/claw/claw-task-hub.git" }));
  assert(sshRemote.created && sshRemote.attempt.repository.startsWith("ssh://git@"), "an ssh account name is not a credential and must be accepted");
}

// --- create, replay, and the one-live-attempt rule ---------------------------------

const createRequest = createInput(primary);
const first = await attempts.createExecutionAttempt(createRequest);
const attempt = first.attempt;
{
  assert(first.created === true, "the first create must report created");
  assert(attempt.state === "provisioning" && attempt.revision === 0 && attempt.terminal === false, `a new attempt must start provisioning at revision 0, got ${attempt.state}@${attempt.revision}`);
  assert(attempt.issue_identifier === "CTH-950001" && attempt.claim_id === primary.claim.id && attempt.session_id === "session-attempts-a", "the attempt must record its issue, claim, and owning session");
  assert(attempt.base_sha === SHA_A.toLowerCase(), `the base SHA must be stored normalized, got ${attempt.base_sha}`);
  assert(attempt.contract_version === EXECUTION_CONTRACT_VERSION, "the attempt must record the contract version it was created under");
  assert(attempt.harness === "codex" && attempt.harness_version === "1.2.3", "the attempt must record harness identity and version");
  assert(attempt.provenance.requested_by === "execution attempt regression" && attempt.transitions.length === 0, "the attempt must keep provenance and start with an empty ledger");

  const replay = await attempts.createExecutionAttempt({ ...createRequest });
  assert(replay.created === false && replay.attempt.id === attempt.id, "replaying a create with the same key and inputs must return the existing attempt");
  await expectFailure(() => attempts.createExecutionAttempt({ ...createRequest, base_sha: SHA_B }), "idempotency_conflict", "reusing a create key with a different base");
  const duplicate = await expectFailure(() => attempts.createExecutionAttempt(createInput(primary)), "live_attempt_exists", "a second live attempt on one issue");
  assert(duplicate.details.attempt_id === attempt.id, "live_attempt_exists must name the live attempt");
  await expectFailure(() => attempts.createExecutionAttempt(createInput(primary, { retry_of: attempt.id })), "invalid_retry", "retrying an attempt that is still live");
}

// --- transitions --------------------------------------------------------------------

const commentsBefore = await commentCount(primary.issue.id);
const launchRequest = {
  attempt_id: attempt.id,
  event: "launch",
  expected_revision: 0,
  idempotency_key: key("launch"),
  ...controlPlane,
  workspace: { branch: "cth/950001-attempt", worktree_path: "/workspaces/cth-950001", lease_id: "lease-1" },
  process: { pid: 4242, started_at: "2026-01-01T00:00:00.000Z" },
  artifacts: [{ kind: "harness_log", ref: "artifact://logs/launch" }],
};
{
  const launched = await attempts.transitionExecutionAttempt(launchRequest);
  assert(launched.outcome === "applied" && launched.attempt.state === "running" && launched.attempt.revision === 1, "launch must move the attempt to running at revision 1");
  assert(launched.attempt.workspace.branch === "cth/950001-attempt" && launched.attempt.workspace.lease_id === "lease-1", "launch must bind the workspace lease");
  assert(launched.attempt.process.pid === 4242, "launch must record process identity");
  assert(launched.attempt.artifacts.length === 1 && launched.attempt.artifacts[0].revision === 1, "artifact references must record the revision that added them");
  assert(launched.transition.from === "provisioning" && launched.transition.to === "running" && launched.transition.actor.kind === "control_plane", "the ledger must record the move and its actor");
  assert(launched.transition.details.lease_id === "lease-1" && launched.transition.details.process_id === 4242, "the ledger must record which resources the transition bound");

  const replayed = await attempts.transitionExecutionAttempt(launchRequest);
  assert(replayed.outcome === "replayed" && replayed.attempt.revision === 1 && replayed.attempt.transitions.length === 1, "resending the last transition must not apply it twice");
  await expectFailure(() => attempts.transitionExecutionAttempt({ ...launchRequest, idempotency_key: key("late-launch") }), "revision_conflict", "a launch planned against the consumed revision");
  await expectFailure(
    () => attempts.transitionExecutionAttempt({ attempt_id: attempt.id, event: "complete_run", expected_revision: 1, idempotency_key: key("rebind"), ...controlPlane, workspace: { branch: "cth/other" } }),
    "resource_conflict",
    "rebinding an attempt to another branch",
  );
  assert((await attempts.getExecutionAttempt(attempt.id)).revision === 1, "a refused transition must leave the attempt unchanged");

  const completed = await attempts.transitionExecutionAttempt({
    attempt_id: attempt.id,
    event: "complete_run",
    expected_revision: "1",
    idempotency_key: key("complete"),
    ...controlPlane,
    workspace: { branch: "cth/950001-attempt" },
    artifacts: [{ kind: "diff_summary", ref: "artifact://diffs/1" }],
  });
  assert(completed.attempt.state === "verifying" && completed.attempt.artifacts.length === 2, "complete_run must append artifacts and accept a repeat of the bound branch");
  await expectFailure(() => attempts.transitionExecutionAttempt({ ...launchRequest, expected_revision: 2 }), "idempotency_conflict", "reusing an earlier transition's key");

  await expectFailure(
    () => attempts.transitionExecutionAttempt({ attempt_id: attempt.id, event: "accept", expected_revision: 2, idempotency_key: key("early-accept"), ...operator, policy: "operator-approval" }),
    "invalid_transition",
    "accepting before verification passes",
  );
  await expectFailure(
    () => attempts.transitionExecutionAttempt({ attempt_id: attempt.id, event: "cancel", expected_revision: 2, idempotency_key: key("foreign-cancel"), actor_kind: "agent", actor_id: "session-attempts-b", reason: "agent_requested" }),
    "unauthorized_actor",
    "another session's agent canceling",
  );
  await expectFailure(
    () => attempts.transitionExecutionAttempt({ attempt_id: "attempt_missing", event: "launch", expected_revision: 0, idempotency_key: key("missing"), ...controlPlane }),
    "attempt_not_found",
    "a missing attempt",
  );

  // Two in-process writers planned against the same revision: exactly one lands.
  const racers = await Promise.allSettled([0, 1].map((index) => attempts.transitionExecutionAttempt({
    attempt_id: attempt.id,
    event: "fail_verification",
    expected_revision: 2,
    idempotency_key: key(`race-${index}`),
    ...controlPlane,
    reason: "checks_failed",
  })));
  const losers = racers.filter((result) => result.status === "rejected");
  assert(losers.length === 1, `exactly one of two concurrent transitions may apply, ${2 - losers.length} did`);
  assert(losers[0].reason.code === "revision_conflict", `the losing writer must see revision_conflict, got ${losers[0].reason.code}`);
}

const failed = await attempts.getExecutionAttempt(attempt.id);
{
  assert(failed.state === "failed" && failed.terminal === true && failed.state_reason === "checks_failed" && failed.terminal_at, "a failed attempt must record its terminal reason and time");
  assert(failed.transitions.map((transition) => transition.revision).join(",") === "1,2,3", "the ledger must hold one row per revision");
  assert(await commentCount(primary.issue.id) === commentsBefore, "attempt persistence must not write comments; comments stay a human projection");
}

// --- retries keep history --------------------------------------------------------------

const retry = await attempts.createExecutionAttempt(createInput(primary, { retry_of: attempt.id, base_sha: SHA_B }));
{
  assert(retry.created && retry.attempt.retry_of === attempt.id && retry.attempt.id !== attempt.id && retry.attempt.revision === 0, "a retry must be a new attempt that references the one it retries");
  const original = await attempts.getExecutionAttempt(attempt.id);
  assert(JSON.stringify(original) === JSON.stringify(failed), "creating a retry must leave the original attempt and its ledger untouched");

  const history = await attempts.listExecutionAttempts({ issue_id: "CTH-950001" });
  assert(history.length === 2 && history.some((item) => item.id === attempt.id) && history.some((item) => item.id === retry.attempt.id), "issue history must enumerate every attempt, terminal ones included");
  const liveOnly = await attempts.listExecutionAttempts({ issue_id: primary.issue.id, include_terminal: "false" });
  assert(liveOnly.length === 1 && liveOnly[0].id === retry.attempt.id, "include_terminal:false must list only live attempts");
  const failedOnly = await attempts.listExecutionAttempts({ state: ["failed"] });
  assert(failedOnly.length > 0 && failedOnly.every((item) => item.state === "failed"), "the state filter must match only the requested states");
  await expectFailure(() => attempts.listExecutionAttempts({ state: "paused" }), "invalid_input", "filtering by a state outside the contract");
  await expectFailure(() => attempts.listExecutionAttempts({ issue_id: "CTH-959999" }), "issue_not_found", "listing the history of an unknown issue");
}

// --- restart survival and cross-process races, through the CLI ---------------------------

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
  const reread = await runHub("get_execution_attempt", { id: attempt.id });
  assert(reread.status === 0, `CLI get_execution_attempt failed:\n${reread.stderr}`);
  const fromDisk = JSON.parse(reread.stdout).attempt;
  assert(fromDisk.state === "failed" && fromDisk.revision === 3 && fromDisk.transitions.length === 3 && fromDisk.retry_of === null, "a fresh process must read the attempt exactly as it was written");

  const contenders = 6;
  const launches = await Promise.all(Array.from({ length: contenders }, (_item, index) => runHub("transition_execution_attempt", {
    attempt_id: retry.attempt.id,
    event: "launch",
    expected_revision: 0,
    idempotency_key: `cli-launch-${index}`,
    actor_kind: "control_plane",
    actor_id: `hub-${index}`,
  })));
  const launchWinners = launches.filter((result) => result.status === 0);
  assert(launchWinners.length === 1, `exactly one of ${contenders} processes may launch the attempt, ${launchWinners.length} did:\n${launches.map((result) => result.stderr).join("\n")}`);
  assert(launches.filter((result) => result.status !== 0).every((result) => result.stderr.includes("revision_conflict")), `losing launchers must fail with revision_conflict:\n${launches.map((result) => result.stderr).join("\n")}`);
  const afterLaunchRace = await attempts.getExecutionAttempt(retry.attempt.id);
  assert(afterLaunchRace.revision === 1 && afterLaunchRace.transitions.length === 1, "a launch race must leave exactly one ledger row");

  const contested = await openIssue("CTH-950005", "session-attempts-d");
  const creates = await Promise.all(Array.from({ length: contenders }, (_item, index) => runHub("create_execution_attempt", {
    issue_id: contested.issue.identifier,
    claim_id: contested.claim.id,
    harness: "codex",
    repository: REPO,
    base_sha: SHA_A,
    idempotency_key: `cli-create-${index}`,
  })));
  const createWinners = creates.filter((result) => result.status === 0);
  assert(createWinners.length === 1, `exactly one of ${contenders} processes may create the live attempt, ${createWinners.length} did:\n${creates.map((result) => result.stderr).join("\n")}`);
  assert(creates.filter((result) => result.status !== 0).every((result) => result.stderr.includes("live_attempt_exists")), `losing creators must fail with live_attempt_exists:\n${creates.map((result) => result.stderr).join("\n")}`);
  assert((await attempts.listExecutionAttempts({ issue_id: contested.issue.identifier })).length === 1, "a create race must store exactly one attempt");
}

// --- MCP ---------------------------------------------------------------------------------

{
  const calls = [
    { method: "tools/list", params: {} },
    { method: "tools/call", params: { name: "list_execution_attempts", arguments: { issue_id: "CTH-950001" } } },
    { method: "tools/call", params: { name: "transition_execution_attempt", arguments: { attempt_id: retry.attempt.id, event: "teleport", expected_revision: 1, idempotency_key: "mcp-bad-event", actor_kind: "control_plane", actor_id: "hub" } } },
  ];
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    ...calls.map((call, index) => JSON.stringify({ jsonrpc: "2.0", id: index + 2, ...call })),
    "",
  ].join("\n");
  const result = spawnSync(process.execPath, ["server/mcp-server.ts"], { cwd: process.cwd(), env: process.env, input, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert(result.status === 0, `MCP server failed:\n${result.stderr}`);
  const messages = String(result.stdout).split(/\r?\n/).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
  const byId = (id) => messages.find((message) => message.id === id);

  const tools = byId(2)?.result?.tools ?? [];
  const schema = (name) => tools.find((tool) => tool.name === name)?.inputSchema;
  for (const name of ["create_execution_attempt", "get_execution_attempt", "list_execution_attempts", "transition_execution_attempt"]) {
    assert(schema(name), `MCP does not describe ${name}`);
  }
  for (const field of ["issue_id", "claim_id", "harness", "repository", "base_sha", "idempotency_key"]) {
    assert(schema("create_execution_attempt").required.includes(field), `MCP create_execution_attempt must require ${field}`);
  }
  for (const field of ["attempt_id", "event", "expected_revision", "idempotency_key", "actor_kind", "actor_id"]) {
    assert(schema("transition_execution_attempt").required.includes(field), `MCP transition_execution_attempt must require ${field}`);
  }
  assert(JSON.stringify(schema("transition_execution_attempt").properties.event.enum) === JSON.stringify(executionEvents), "MCP event enum must come from the contract");
  assert(JSON.stringify(schema("transition_execution_attempt").properties.actor_kind.enum) === JSON.stringify(executionActorKinds), "MCP actor_kind enum must come from the contract");

  const history = JSON.parse(byId(3)?.result?.content?.[0]?.text ?? "{}").attempts;
  assert(history?.length === 2, `MCP list_execution_attempts must return the issue history, got ${JSON.stringify(byId(3))}`);
  assert(byId(4)?.error?.message?.startsWith("unknown_event:"), `MCP must surface the typed code, got ${JSON.stringify(byId(4))}`);
}

// --- HTTP --------------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

{
  const port = await freePort();
  const api = spawn(process.execPath, ["server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let diagnostics = "";
  api.stdout.on("data", (chunk) => { diagnostics += chunk; });
  api.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const base = `http://127.0.0.1:${port}/api`;
  const call = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, { ...options, headers: { "content-type": "application/json" } });
    return { status: response.status, body: await response.json() };
  };
  try {
    for (let attemptNumber = 0; ; attemptNumber += 1) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {
        // not listening yet
      }
      if (attemptNumber >= 100) throw new Error(`API did not start\n${diagnostics}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    let result = await call("/issues/CTH-950001/execution-attempts");
    assert(result.status === 200 && result.body.attempts.length === 2, `HTTP issue history failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/execution-attempts?issue_id=CTH-950001&include_terminal=false`);
    assert(result.status === 200 && result.body.attempts.length === 1, `HTTP live attempt filter failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/execution-attempts/${retry.attempt.id}`);
    assert(result.status === 200 && result.body.attempt.transitions.length === 1, `HTTP get attempt failed: ${result.status}`);
    result = await call("/execution-attempts/attempt_missing");
    assert(result.status === 404 && result.body.code === "attempt_not_found", `HTTP missing attempt must be 404 attempt_not_found: ${result.status} ${JSON.stringify(result.body)}`);

    const transition = (body) => call(`/execution-attempts/${retry.attempt.id}/transitions`, { method: "POST", body: JSON.stringify(body) });
    result = await transition({ event: "complete_run", expected_revision: 0, idempotency_key: "http-stale", ...controlPlane });
    assert(result.status === 409 && result.body.code === "revision_conflict", `HTTP stale revision must be 409 revision_conflict: ${result.status} ${JSON.stringify(result.body)}`);
    result = await transition({ event: "cancel", expected_revision: 1, idempotency_key: "http-foreign", actor_kind: "agent", actor_id: "session-attempts-b", reason: "agent_requested" });
    assert(result.status === 403 && result.body.code === "unauthorized_actor", `HTTP foreign agent must be 403 unauthorized_actor: ${result.status} ${JSON.stringify(result.body)}`);
    result = await transition({ event: "teleport", expected_revision: 1, idempotency_key: "http-unknown", ...controlPlane });
    assert(result.status === 400 && result.body.code === "unknown_event", `HTTP unknown event must be 400 unknown_event: ${result.status} ${JSON.stringify(result.body)}`);
    result = await transition({ event: "complete_run", expected_revision: 1, idempotency_key: "http-complete", ...controlPlane });
    assert(result.status === 200 && result.body.outcome === "applied" && result.body.attempt.state === "verifying", `HTTP transition failed: ${result.status} ${JSON.stringify(result.body)}`);

    const httpTarget = await openIssue("CTH-950006", "session-attempts-e");
    const createBody = { claim_id: httpTarget.claim.id, harness: "claude-code", repository: REPO, base_sha: SHA_A, idempotency_key: "http-create" };
    result = await call(`/issues/${httpTarget.issue.identifier}/execution-attempts`, { method: "POST", body: JSON.stringify(createBody) });
    assert(result.status === 201 && result.body.created === true, `HTTP create must be 201: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/issues/${httpTarget.issue.identifier}/execution-attempts`, { method: "POST", body: JSON.stringify(createBody) });
    assert(result.status === 200 && result.body.created === false && result.body.attempt.id, `HTTP idempotent create must be 200 with the existing attempt: ${result.status}`);
    result = await call(`/issues/${httpTarget.issue.identifier}/execution-attempts`, { method: "POST", body: JSON.stringify({ ...createBody, idempotency_key: "http-create-2" }) });
    assert(result.status === 409 && result.body.code === "live_attempt_exists", `HTTP second live attempt must be 409 live_attempt_exists: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call("/issues/CTH-959999/execution-attempts", { method: "POST", body: JSON.stringify({ ...createBody, idempotency_key: "http-missing-issue" }) });
    assert(result.status === 404 && result.body.code === "issue_not_found", `HTTP create on a missing issue must be 404: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/issues/${httpTarget.issue.identifier}/execution-attempts`, { method: "POST", body: JSON.stringify({ ...createBody, base_sha: "nope", idempotency_key: "http-invalid" }) });
    assert(result.status === 400 && result.body.code === "invalid_input", `HTTP invalid create must be 400 invalid_input: ${result.status} ${JSON.stringify(result.body)}`);
  } finally {
    await stopProcessTree(api);
  }
}

// --- deleting an issue does not silently discard live work ---------------------------------

{
  await store.releaseIssueClaim({ claim_id: primary.claim.id, status: "released" });
  let refusal = "";
  try {
    await store.deleteIssue({ id: "CTH-950001", confirm: true });
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  assert(refusal.includes("live execution attempt"), `deleting an issue with a live attempt must be refused, got: ${refusal || "deleted"}`);
  assert((await attempts.listExecutionAttempts({ issue_id: "CTH-950001" })).length === 2, "a refused delete must keep the attempt history");
}

console.log("Execution attempt regression passed");
