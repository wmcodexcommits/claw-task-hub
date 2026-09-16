// Execution evidence and verification policy regression.
//
// Drives attempts through the fake harness in real leased worktrees, then covers:
// operator policies as revisioned argument vectors; diff capture with renames,
// deletions, binary and untracked files, and no change to the worktree's index;
// verification that passes, fails, times out, or is canceled from another
// process; required changes; steps that alter the worktree; external observations
// and claims, missing artifacts, stale fingerprints, supersession, and schema
// versions; scrubbing and bounds; and the CLI, MCP, and HTTP surfaces.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const SECRET = "evidence-secret-value-0123456789";

if (process.env.CLAW_TASK_HUB_EVIDENCE_WORKER !== "1") {
  const parentTempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-evidence-"));
  const gitConfig = join(parentTempDir, "gitconfig");
  writeFileSync(gitConfig, "");
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: {
      ...withoutRedirectingGitVariables(process.env),
      CLAW_TASK_HUB_DB: join(parentTempDir, "hub", "evidence.sqlite"),
      CLAW_TASK_HUB_WORKSPACE_ROOT: join(parentTempDir, "workspaces"),
      CLAW_TASK_HUB_EVIDENCE_TEMP: parentTempDir,
      CLAW_TASK_HUB_QUIET_DB: "1",
      CLAW_TASK_HUB_EVIDENCE_WORKER: "1",
      CLAW_TASK_HUB_ENABLE_FAKE_HARNESS: "1",
      CLAW_TASK_HUB_FAKE_HARNESS_SECRET: SECRET,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Evidence Test",
      GIT_AUTHOR_EMAIL: "evidence@example.com",
      GIT_COMMITTER_NAME: "Evidence Test",
      GIT_COMMITTER_EMAIL: "evidence@example.com",
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
    console.error("Execution evidence cleanup failed after the worker exited:", error);
  }
  process.exit(cleanupFailed ? 1 : result.status ?? 1);
}

const tempRoot = process.env.CLAW_TASK_HUB_EVIDENCE_TEMP;
assert(tempRoot && process.env.CLAW_TASK_HUB_DB, "Execution evidence worker requires its temp directory and database");

const dbModule = await import("../server/db.ts");
const store = await import("../server/store.ts");
const attempts = await import("../server/execution-attempts.ts");
const workspaces = await import("../server/execution-workspaces.ts");
const runs = await import("../server/execution-runs.ts");
const evidence = await import("../server/execution-evidence.ts");
const { ExecutionContractError, executionBounds } = await import("../server/execution-contract.ts");

dbModule.initializeDatabase(dbModule.db);
await store.ensureDefaultTeam();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: process.env, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stderr}`);
  return result.stdout.trim();
}

async function expectFailure(run, code, message) {
  try {
    await run();
  } catch (error) {
    const typed = error instanceof evidence.ExecutionEvidenceError
      || error instanceof runs.ExecutionRunError
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

function createRepository(name) {
  const dir = join(tempRoot, "repos", name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "-b", "main");
  writeFileSync(join(dir, "README.md"), "base\n");
  writeFileSync(join(dir, "old-name.txt"), "rename me\nsame content\nstays similar\n");
  writeFileSync(join(dir, "gone.txt"), "delete me\n");
  writeFileSync(join(dir, ".gitignore"), "build/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "base");
  const remote = `https://example.com/claw/${name}.git`;
  git(dir, "remote", "add", "origin", remote);
  return { dir: realpathSync.native(dir), sha: git(dir, "rev-parse", "HEAD"), remote };
}

const repo = createRepository("service");
const project = await store.upsertProject({ external_id: "evidence-project", name: "Evidence Project" });
let issueNumber = 980000;

async function claimedIssue() {
  issueNumber += 1;
  const identifier = `CTH-${issueNumber}`;
  const sessionId = `session-evidence-${issueNumber}`;
  const issue = await store.upsertIssue({ title: `Evidence target ${identifier}`, identifier, status: "Todo", project_id: project.id });
  await store.startAgentSession({ id: sessionId, agent_name: `Agent ${identifier}`, harness: "codex", ttl_minutes: 240 });
  const { claim } = await store.claimIssue({ issue_id: identifier, session_id: sessionId, ttl_minutes: 240 });
  return { issue, claim };
}

function attemptInput(target, fixture) {
  return {
    issue_id: target.issue.identifier,
    claim_id: target.claim.id,
    harness: "fake",
    repository: fixture.remote,
    base_sha: fixture.sha,
    idempotency_key: `evidence-create-${target.issue.identifier}`,
  };
}

async function verifyingAttempt(fixture = repo, files = [{ path: "feature.txt", content: "feature\n" }]) {
  const target = await claimedIssue();
  const started = await workspaces.startExecutionAttempt({ ...attemptInput(target, fixture), repository_path: fixture.dir });
  const launched = await runs.launchExecutionAttempt({
    attempt_id: started.attempt.id,
    adapter: "fake",
    prompt: JSON.stringify({ write: files }),
    idempotency_key: `evidence-launch-${target.issue.identifier}`,
  });
  const outcome = await launched.completion;
  assert(outcome?.result === "completed", `the fixture harness run failed: ${JSON.stringify(outcome)}`);
  const attempt = await attempts.getExecutionAttempt(started.attempt.id);
  assert(attempt.state === "verifying", `the fixture attempt must be verifying, got ${attempt.state}`);
  return { attempt, worktree: started.workspace.worktree_path };
}

const script = (source) => [process.execPath, "-e", source];

async function usePolicy(steps, extra = {}) {
  return (await evidence.saveVerificationPolicy({ repository: repo.remote, steps, actor_kind: "operator", actor_id: "operator-1", ...extra })).policy;
}

const artifactRef = (record, kind) => record.artifacts.find((artifact) => artifact.kind === kind)?.ref;

// --- policies: operator configuration, argument vectors, revisions ----------------------

{
  const base = { repository: repo.remote, actor_kind: "operator", actor_id: "operator-1" };
  await expectFailure(() => evidence.saveVerificationPolicy({ ...base, steps: [{ name: "unit", command: "bun test" }] }), "invalid_input", "a shell string instead of an argument vector");
  await expectFailure(() => evidence.saveVerificationPolicy({ ...base, steps: [{ name: "unit", command: script("0") }, { name: "unit", command: script("0") }] }), "invalid_input", "a step listed twice");
  await expectFailure(() => evidence.saveVerificationPolicy({ ...base, steps: [{ name: "unit", command: ["./run-tests.sh"] }] }), "invalid_input", "an executable inside the repository");
  await expectFailure(() => evidence.saveVerificationPolicy({ ...base, actor_kind: "agent", steps: [{ name: "unit", command: script("0") }] }), "invalid_input", "a policy saved by a non-operator");
  await expectFailure(
    () => evidence.saveVerificationPolicy({ ...base, steps: [{ name: "unit", command: script("0"), timeout_ms: executionBounds.verification_step.value + 1 }] }),
    "invalid_input",
    "a step timeout beyond the contract bound",
  );
  const first = await usePolicy([{ name: "unit", command: script("0") }], { note: "first revision" });
  const second = await usePolicy([{ name: "unit", command: script("0") }, { name: "lint", command: script("0"), required: false }]);
  assert(first.revision === 1 && second.revision === 2 && second.schema_version === evidence.VERIFICATION_POLICY_SCHEMA_VERSION, "saving a policy must create a new revision");
  assert((await evidence.getVerificationPolicy({ repository: repo.remote })).policy.revision === 2, "the latest revision must apply");
  const original = (await evidence.getVerificationPolicy({ repository: repo.remote, revision: 1 })).policy;
  assert(original.steps.length === 1 && original.note === "first revision" && original.created_by.id === "operator-1", "earlier revisions must stay readable and unchanged");
  assert((await evidence.getVerificationPolicy({ repository: "https://example.com/claw/unconfigured.git" })).policy === null, "a repository without a policy must read as none");
}

// --- diffs: touched files, patch hash, fingerprint, and an untouched index -----------------

{
  const { attempt, worktree } = await verifyingAttempt();
  writeFileSync(join(worktree, "README.md"), "base\nchanged by the agent\n");
  git(worktree, "mv", "old-name.txt", "new-name.txt");
  rmSync(join(worktree, "gone.txt"));
  writeFileSync(join(worktree, "blob.bin"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(worktree, "spaced name.txt"), "spaces\n");
  mkdirSync(join(worktree, "build"), { recursive: true });
  writeFileSync(join(worktree, "build", "out.txt"), "ignored output\n");
  const statusBefore = git(worktree, "status", "--porcelain");

  const captured = (await evidence.captureExecutionDiff({ attempt_id: attempt.id })).evidence;
  assert(captured.kind === "diff" && captured.status === "recorded" && captured.schema_version === evidence.EXECUTION_EVIDENCE_SCHEMA_VERSION, `unexpected diff record ${JSON.stringify(captured)}`);
  assert(/^[0-9a-f]{40}$/.test(captured.tree_fingerprint), "a diff must carry the tree fingerprint of the content");
  const files = Object.fromEntries(captured.payload.files.map((file) => [file.path, file]));
  assert(files["feature.txt"]?.status === "A" && files["feature.txt"].added === 1, "an untracked new file must be recorded as added");
  assert(files["README.md"]?.status === "M" && files["README.md"].added === 1 && files["README.md"].deleted === 0, "a modification must carry line counts");
  assert(files["new-name.txt"]?.status === "R" && files["new-name.txt"].previous_path === "old-name.txt" && files["new-name.txt"].similarity === 100, "a rename must record its source and similarity");
  assert(files["gone.txt"]?.status === "D", "a deletion must be recorded");
  assert(files["blob.bin"]?.binary === true && files["blob.bin"].added === null, "a binary file must be flagged without line counts");
  assert(files["spaced name.txt"]?.status === "A", "a path with spaces must be recorded verbatim");
  assert(!Object.keys(files).some((path) => path.startsWith("build/")), "ignored files must not count as changes");
  assert(captured.payload.totals.files === 6 && captured.payload.totals.binary === 1, `unexpected totals ${JSON.stringify(captured.payload.totals)}`);
  assert(/^[0-9a-f]{64}$/.test(captured.payload.patch.sha256) && captured.payload.patch.bytes > 0, "a diff must carry the patch hash and size");
  assert(readFileSync(artifactRef(captured, "diff_patch"), "utf8").includes("changed by the agent"), "the patch artifact must hold the change");
  assert(git(worktree, "status", "--porcelain") === statusBefore, "capturing a diff must not change the worktree's index or files");
  const again = (await evidence.captureExecutionDiff({ attempt_id: attempt.id })).evidence;
  assert(again.tree_fingerprint === captured.tree_fingerprint && again.sequence === captured.sequence + 1, "unchanged content must fingerprint the same, and evidence must append");
}

// --- verification that passes, with scrubbing and provenance ---------------------------------

let reviewableAttemptId;
{
  await usePolicy([
    { name: "unit", command: script("console.log('unit ok')") },
    { name: "secrets", command: script(`console.log('token ${SECRET}')`), version_command: [process.execPath, "--version"] },
  ]);
  const { attempt } = await verifyingAttempt();
  const result = await evidence.verifyExecutionAttempt({ attempt_id: attempt.id });
  reviewableAttemptId = attempt.id;
  assert(result.verdict?.status === "passed" && result.transition === "applied" && result.attempt.state === "reviewable", `verification must pass: ${JSON.stringify(result.verdict)} ${result.transition_error}`);
  assert(result.attempt.terminal === false, "a passing verdict must make the attempt reviewable, never accepted");
  assert(result.observations.length === 2 && result.observations.every((observation) => observation.status === "passed" && observation.tree_fingerprint === result.diff.tree_fingerprint), "observations must pass against the captured fingerprint");
  assert(readFileSync(artifactRef(result.observations[0], "step_stdout"), "utf8").includes("unit ok"), "step output must be captured");
  const secretLog = readFileSync(artifactRef(result.observations[1], "step_stdout"), "utf8");
  assert(secretLog.includes("[redacted:CLAW_TASK_HUB_FAKE_HARNESS_SECRET]") && !secretLog.includes(SECRET), "step output must be scrubbed");
  assert(result.observations[1].provenance.tool_version, "a step's version command must be recorded");
  assert(!JSON.stringify(await evidence.listExecutionEvidence({ attempt_id: attempt.id })).includes(SECRET), "a credential value must never enter evidence records");
  const transition = result.attempt.transitions.at(-1);
  assert(transition.event === "pass_verification" && transition.details.verdict_id === result.verdict.id && transition.details.policy_revision === result.policy.revision, "the ledger must link the verdict and policy revision");
  assert(result.verdict.payload.findings.every((finding) => finding.outcome === "passed"), "every finding must pass");
}

// --- checks that fail, time out, or are canceled ------------------------------------------------

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
  await usePolicy([{ name: "unit", command: script("console.error('unit failed'); process.exit(3)") }]);
  const { attempt } = await verifyingAttempt();
  const result = await evidence.verifyExecutionAttempt({ attempt_id: attempt.id });
  assert(result.verdict.status === "failed" && result.verdict.payload.reason === "checks_failed", `a failing step must fail verification: ${JSON.stringify(result.verdict.payload)}`);
  assert(result.attempt.state === "failed" && result.attempt.state_reason === "checks_failed", "the attempt must fail with checks_failed");
  assert(result.observations[0].status === "failed" && result.observations[0].payload.exit_code === 3, "the observation must record the exit code");
  assert(readFileSync(artifactRef(result.observations[0], "step_stderr"), "utf8").includes("unit failed"), "a failing step must keep its stderr");
}

{
  await usePolicy([{ name: "unit", command: script("setTimeout(() => {}, 60000)"), timeout_ms: 400 }]);
  const { attempt } = await verifyingAttempt();
  const started = Date.now();
  const result = await evidence.verifyExecutionAttempt({ attempt_id: attempt.id, cancellation_grace_ms: 200 });
  assert(result.observations[0].status === "timed_out" && result.verdict.payload.reason === "checks_failed", `a step past its timeout must be timed_out: ${JSON.stringify(result.observations[0])}`);
  assert(Date.now() - started < 20_000, "a timed-out step must be stopped promptly");
}

{
  await usePolicy([{ name: "unit", command: script("setTimeout(() => {}, 60000)") }]);
  const { attempt } = await verifyingAttempt();
  const pending = evidence.verifyExecutionAttempt({ attempt_id: attempt.id, cancellation_grace_ms: 200 });
  const deadline = Date.now() + 15_000;
  while ((await evidence.listExecutionEvidence({ attempt_id: attempt.id, kind: "diff" })).length === 0) {
    if (Date.now() > deadline) throw new Error("verification never started");
    await sleep(50);
  }
  await sleep(800);
  const canceled = await runHub("transition_execution_attempt", {
    attempt_id: attempt.id,
    event: "cancel",
    expected_revision: attempt.revision,
    idempotency_key: "evidence-cancel",
    actor_kind: "operator",
    actor_id: "operator-1",
    reason: "operator_requested",
  });
  assert(canceled.status === 0, `the CLI cancel failed:\n${canceled.stderr}`);
  const result = await pending;
  assert(result.stopped_by_state === "canceled" && result.verdict === null && result.transition === null, `a cancellation must stop verification without a verdict: ${JSON.stringify({ stopped: result.stopped_by_state, verdict: result.verdict })}`);
  assert(result.observations[0].status === "canceled", "the interrupted step must be recorded as canceled");
  assert((await attempts.getExecutionAttempt(attempt.id)).state === "canceled", "the attempt must stay canceled");
}

// --- required changes, and steps that alter the worktree ----------------------------------------

{
  await usePolicy([{ name: "unit", command: script("0") }]);
  const { attempt } = await verifyingAttempt(repo, []);
  const result = await evidence.verifyExecutionAttempt({ attempt_id: attempt.id });
  assert(result.verdict.payload.reason === "checks_failed" && result.verdict.payload.findings.some((finding) => finding.rule === "require_changes"), "an attempt without changes must fail the require_changes rule");
}

{
  await usePolicy([{ name: "unit", command: script("require('fs').writeFileSync('generated-by-step.txt', 'x')") }]);
  const { attempt } = await verifyingAttempt();
  const result = await evidence.verifyExecutionAttempt({ attempt_id: attempt.id });
  assert(result.verdict.payload.reason === "stale_base_evidence" && result.attempt.state_reason === "stale_base_evidence", `a step that changes the worktree must make its evidence stale: ${JSON.stringify(result.verdict.payload)}`);
}

// --- recorded evidence: claims, missing artifacts, stale fingerprints, corrections --------------

{
  await usePolicy([{ name: "external-ci", command: script("0") }]);
  const observation = (attempt, overrides = {}) => ({
    attempt_id: attempt.id,
    kind: "observation",
    name: "external-ci",
    status: "passed",
    actor_kind: "control_plane",
    actor_id: "ci",
    ...overrides,
  });

  const claimed = await verifyingAttempt();
  const claim = (await evidence.recordExecutionEvidence({ ...observation(claimed.attempt), kind: "claim", status: undefined, summary: "formally proven" })).evidence;
  assert(claim.kind === "claim" && claim.status === "recorded", "a claim must be recorded as a claim");
  const claimResult = await evidence.verifyExecutionAttempt({ attempt_id: claimed.attempt.id, run_steps: false });
  assert(claimResult.verdict.payload.reason === "evidence_missing", "a claim must never satisfy a required step");

  const withMissingArtifact = await verifyingAttempt();
  await evidence.recordExecutionEvidence({ ...observation(withMissingArtifact.attempt), artifacts: [{ kind: "ci_log", ref: join(tempRoot, "missing-ci.log") }] });
  const missingResult = await evidence.verifyExecutionAttempt({ attempt_id: withMissingArtifact.attempt.id, run_steps: false });
  assert(missingResult.verdict.payload.reason === "evidence_missing" && missingResult.verdict.payload.findings.some((finding) => finding.detail?.includes("missing-ci.log")), `a missing artifact must count as missing evidence: ${JSON.stringify(missingResult.verdict.payload)}`);

  const stale = await verifyingAttempt();
  const bigLog = `${SECRET}\n${"y".repeat(executionBounds.captured_stream.value + 50_000)}`;
  const observed = (await evidence.recordExecutionEvidence({ ...observation(stale.attempt), log: bigLog, exit_code: 0, duration_ms: 1200, tool_versions: { ci: "example-ci 9" } })).evidence;
  const storedLog = readFileSync(artifactRef(observed, "evidence_log"), "utf8");
  assert(storedLog.includes("bytes omitted") && !storedLog.includes(SECRET) && observed.payload.log_truncated === true, "a recorded log must be bounded and scrubbed");
  assert(observed.provenance.tool_versions.ci === "example-ci 9", "recorded tool versions must be kept");
  writeFileSync(join(stale.worktree, "feature.txt"), "changed after the observation\n");
  const staleResult = await evidence.verifyExecutionAttempt({ attempt_id: stale.attempt.id, run_steps: false });
  assert(staleResult.verdict.payload.reason === "stale_base_evidence", `evidence for older content must be stale: ${JSON.stringify(staleResult.verdict.payload)}`);

  const corrected = await verifyingAttempt();
  const failedRun = (await evidence.recordExecutionEvidence({ ...observation(corrected.attempt), status: "failed" })).evidence;
  await expectFailure(() => evidence.recordExecutionEvidence({ ...observation(corrected.attempt), supersedes: claim.id }), "invalid_input", "superseding evidence from another attempt");
  await expectFailure(() => evidence.recordExecutionEvidence({ ...observation(corrected.attempt), schema_version: "execution-evidence/v2" }), "schema_unsupported", "an unsupported schema version");
  await expectFailure(() => evidence.recordExecutionEvidence({ ...observation(corrected.attempt), kind: "verdict" }), "invalid_input", "a verdict submitted from outside the hub");
  await expectFailure(() => evidence.recordExecutionEvidence({ ...observation(corrected.attempt), status: "green" }), "invalid_input", "an unknown observation status");
  const fixedRun = (await evidence.recordExecutionEvidence({ ...observation(corrected.attempt), supersedes: failedRun.id })).evidence;
  const history = await evidence.listExecutionEvidence({ attempt_id: corrected.attempt.id, kind: "observation" });
  assert(history.length === 2 && history[0].status === "failed" && history[1].supersedes === failedRun.id, "a correction must append and leave the superseded record in place");
  assert(JSON.stringify(await evidence.getExecutionEvidence(failedRun.id)) === JSON.stringify(failedRun), "superseded evidence must stay unchanged");
  const correctedResult = await evidence.verifyExecutionAttempt({ attempt_id: corrected.attempt.id, run_steps: false });
  assert(correctedResult.verdict.status === "passed" && correctedResult.attempt.state === "reviewable", `the correcting observation must count: ${JSON.stringify(correctedResult.verdict.payload)}`);
  assert(correctedResult.verdict.payload.findings.some((finding) => finding.evidence_id === fixedRun.id), "the verdict must cite the correcting observation");
}

// --- refusals ---------------------------------------------------------------------------------------

{
  const other = createRepository("unconfigured");
  const unconfigured = await verifyingAttempt(other);
  await expectFailure(() => evidence.verifyExecutionAttempt({ attempt_id: unconfigured.attempt.id }), "policy_not_found", "verifying without a configured policy");
  assert((await attempts.getExecutionAttempt(unconfigured.attempt.id)).state === "verifying", "verification that cannot start must leave the attempt in verifying");
  await expectFailure(() => evidence.verifyExecutionAttempt({ attempt_id: "attempt_missing" }), "attempt_not_found", "a missing attempt");
  const target = await claimedIssue();
  const provisioning = (await workspaces.startExecutionAttempt({ ...attemptInput(target, repo), repository_path: repo.dir })).attempt;
  await expectFailure(() => evidence.verifyExecutionAttempt({ attempt_id: provisioning.id }), "attempt_not_verifying", "verifying an attempt that has not run");
  await expectFailure(() => evidence.listExecutionEvidence({ attempt_id: provisioning.id, kind: "rumor" }), "invalid_input", "an unknown evidence kind");
}

// --- CLI, MCP, and HTTP ---------------------------------------------------------------------------------

{
  const cli = await runHub("list_execution_evidence", { attempt_id: reviewableAttemptId, kind: "verdict" });
  assert(cli.status === 0 && JSON.parse(cli.stdout).evidence.length === 1, `CLI list_execution_evidence failed:\n${cli.stdout}\n${cli.stderr}`);

  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "verify_execution_attempt", arguments: { attempt_id: reviewableAttemptId } } }),
    "",
  ].join("\n");
  const mcp = spawnSync(process.execPath, ["server/mcp-server.ts"], { cwd: process.cwd(), env: process.env, input, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert(mcp.status === 0, `MCP server failed:\n${mcp.stderr}`);
  const messages = String(mcp.stdout).split(/\r?\n/).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
  const byId = (id) => messages.find((message) => message.id === id);
  const tools = byId(2)?.result?.tools ?? [];
  for (const name of ["save_verification_policy", "get_verification_policy", "capture_execution_diff", "record_execution_evidence", "list_execution_evidence", "get_execution_evidence", "verify_execution_attempt"]) {
    assert(tools.some((tool) => tool.name === name), `MCP does not describe ${name}`);
  }
  const recordSchema = tools.find((tool) => tool.name === "record_execution_evidence")?.inputSchema;
  assert(JSON.stringify(recordSchema?.properties?.kind?.enum) === JSON.stringify(["observation", "claim"]), "MCP record_execution_evidence must accept only observations and claims");
  assert(byId(3)?.error?.message?.startsWith("attempt_not_verifying:"), `MCP must surface typed evidence failures, got ${JSON.stringify(byId(3))}`);

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
    let result = await call(`/verification-policies?repository=${encodeURIComponent(repo.remote)}`);
    assert(result.status === 200 && result.body.policy?.steps?.[0]?.name === "external-ci", `HTTP policy read failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/execution-attempts/${reviewableAttemptId}/evidence?kind=observation`);
    assert(result.status === 200 && result.body.evidence.length === 2, `HTTP evidence list failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/execution-attempts/${reviewableAttemptId}/evidence`, { method: "POST", body: JSON.stringify({ kind: "observation", name: "unit", status: "passed", actor_kind: "control_plane", actor_id: "ci", schema_version: "execution-evidence/v9" }) });
    assert(result.status === 400 && result.body.code === "schema_unsupported", `HTTP unsupported schema must be 400: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/execution-attempts/${reviewableAttemptId}/verify`, { method: "POST", body: "{}" });
    assert(result.status === 409 && result.body.code === "attempt_not_verifying", `HTTP verify of a reviewable attempt must be 409: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call("/execution-evidence/evidence_missing");
    assert(result.status === 404 && result.body.code === "evidence_not_found", `HTTP missing evidence must be 404: ${result.status} ${JSON.stringify(result.body)}`);
  } finally {
    await stopProcessTree(api);
  }
  assert(existsSync(repo.dir), "the operator's repository must still exist");
}

console.log("Execution evidence regression passed");
