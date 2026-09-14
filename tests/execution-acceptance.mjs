// Execution acceptance regression.
//
// Drives attempts to reviewable in a temporary repository with the fake harness
// and real verification, then covers: acceptance policy validation; refusals
// without a policy or a reviewable attempt; a local acceptance that commits,
// fast-forwards and then merge-commits a local branch without touching the
// operator's checkout, records identities, settles the issue and claim, and
// releases the workspace; replay and resume after an interruption without
// repeating anything; merge conflicts rejecting with merge_conflict; stale
// verification and a checked-out merge target failing typed; review rejection
// with idempotent claim release; push to a bare remote with a pull request
// opened and merged through the fake provider, including an unavailable
// provider resumed by a later run and a provider-reported merge conflict; and
// the CLI, MCP, and HTTP surfaces.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync, existsSync } from "node:fs";
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

if (process.env.CLAW_TASK_HUB_ACCEPTANCE_WORKER !== "1") {
  const parentTempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-acceptance-"));
  const gitConfig = join(parentTempDir, "gitconfig");
  writeFileSync(gitConfig, "");
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: {
      ...withoutRedirectingGitVariables(process.env),
      CLAW_TASK_HUB_DB: join(parentTempDir, "hub", "acceptance.sqlite"),
      CLAW_TASK_HUB_WORKSPACE_ROOT: join(parentTempDir, "workspaces"),
      CLAW_TASK_HUB_ACCEPTANCE_TEMP: parentTempDir,
      CLAW_TASK_HUB_QUIET_DB: "1",
      CLAW_TASK_HUB_ACCEPTANCE_WORKER: "1",
      CLAW_TASK_HUB_ENABLE_FAKE_HARNESS: "1",
      CLAW_TASK_HUB_ENABLE_FAKE_PROVIDER: "1",
      CLAW_TASK_HUB_API_BASE: "http://127.0.0.1:9/api",
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Acceptance Test",
      GIT_AUTHOR_EMAIL: "acceptance@example.com",
      GIT_COMMITTER_NAME: "Acceptance Test",
      GIT_COMMITTER_EMAIL: "acceptance@example.com",
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
    console.error("Execution acceptance cleanup failed after the worker exited:", error);
  }
  process.exit(cleanupFailed ? 1 : result.status ?? 1);
}

const tempRoot = process.env.CLAW_TASK_HUB_ACCEPTANCE_TEMP;
assert(tempRoot && process.env.CLAW_TASK_HUB_DB, "Execution acceptance worker requires its temp directory and database");

const dbModule = await import("../server/db.ts");
const store = await import("../server/store.ts");
const attempts = await import("../server/execution-attempts.ts");
const workspaces = await import("../server/execution-workspaces.ts");
const runs = await import("../server/execution-runs.ts");
const evidence = await import("../server/execution-evidence.ts");
const acceptance = await import("../server/execution-acceptance.ts");

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
    assert(typeof error?.code === "string", `${message}: expected a typed failure, got ${error instanceof Error ? error.stack : error}`);
    assert(error.code === code && error.message.startsWith(`${code}:`), `${message}: expected ${code}, got ${error.message}`);
    return error;
  }
  throw new Error(`${message}: expected ${code}, but it succeeded`);
}

const repoDir = join(tempRoot, "repos", "service");
mkdirSync(repoDir, { recursive: true });
git(repoDir, "init", "--quiet", "-b", "main");
writeFileSync(join(repoDir, "README.md"), "base\n");
git(repoDir, "add", "-A");
git(repoDir, "commit", "--quiet", "-m", "base");
git(repoDir, "branch", "integration");
const repo = { dir: realpathSync.native(repoDir), remote: "https://example.com/claw/acceptance.git", base: git(repoDir, "rev-parse", "HEAD") };
git(repoDir, "remote", "add", "origin", repo.remote);
const bareRemote = join(tempRoot, "repos", "remote.git");
git(tempRoot, "init", "--quiet", "--bare", bareRemote);

const project = await store.upsertProject({ external_id: "acceptance-project", name: "Acceptance Project" });
await evidence.saveVerificationPolicy({ repository: repo.remote, steps: [{ name: "unit", command: [process.execPath, "-e", "0"] }], actor_kind: "operator", actor_id: "operator-1" });
let issueNumber = 960000;

async function reviewableAttempt(label, files) {
  issueNumber += 1;
  const identifier = `CTH-${issueNumber}`;
  const issue = await store.upsertIssue({ title: `Acceptance target ${label}`, identifier, status: "Todo", project_id: project.id });
  const sessionId = `session-acceptance-${label}`;
  await store.startAgentSession({ id: sessionId, agent_name: `Agent ${label}`, harness: "codex", ttl_minutes: 240 });
  const { claim } = await store.claimIssue({ issue_id: identifier, session_id: sessionId, ttl_minutes: 240 });
  const started = await workspaces.startExecutionAttempt({ issue_id: identifier, claim_id: claim.id, harness: "fake", repository: repo.remote, base_sha: repo.base, idempotency_key: `acceptance-create-${label}`, repository_path: repo.dir });
  const launched = await runs.launchExecutionAttempt({ attempt_id: started.attempt.id, adapter: "fake", prompt: JSON.stringify({ write: files }), idempotency_key: `acceptance-launch-${label}` });
  assert((await launched.completion)?.result === "completed", `the ${label} fixture run failed`);
  const verified = await evidence.verifyExecutionAttempt({ attempt_id: started.attempt.id });
  assert(verified.attempt.state === "reviewable", `the ${label} fixture must be reviewable: ${JSON.stringify(verified.verdict?.payload)}`);
  return { issue, claim, attempt: verified.attempt, worktree: started.workspace.worktree_path, branch: started.workspace.branch, verdict: verified.verdict };
}

const accept = (fixture, key, extra = {}) => acceptance.acceptExecutionAttempt({ attempt_id: fixture.attempt.id, idempotency_key: key, actor_kind: "operator", actor_id: "operator-1", ...extra });
const savePolicy = async (settings) => (await acceptance.saveAcceptancePolicy({ repository: repo.remote, settings, actor_kind: "operator", actor_id: "operator-1" })).policy;
const operatorHead = () => git(repo.dir, "rev-parse", "HEAD");

// --- policy validation and refusals -----------------------------------------------------------

{
  const save = (settings, actor_kind = "operator") => acceptance.saveAcceptancePolicy({ repository: repo.remote, settings, actor_kind, actor_id: "operator-1" });
  await expectFailure(() => save({}, "agent"), "invalid_input", "a policy from a non-operator");
  await expectFailure(() => save({ push: { remote: bareRemote } }), "invalid_input", "a push without allow_push");
  await expectFailure(() => save({ allow_push: true, push: { remote: bareRemote }, pull_request: { provider: "fake", base_branch: "main" } }), "invalid_input", "a pull request without allow_pull_request");
  await expectFailure(() => save({ allow_push: true, push: { remote: bareRemote }, allow_pull_request: true, pull_request: { provider: "fake", base_branch: "main", merge: true } }), "invalid_input", "a provider merge without allow_provider_merge");
  await expectFailure(() => save({ merge_target: "integration", allow_push: true, push: { remote: bareRemote }, allow_pull_request: true, pull_request: { provider: "fake", base_branch: "main" } }), "invalid_input", "both merge_target and pull_request");
  await expectFailure(() => save({ allow_push: true, push: { remote: "https://user:secret@example.com/claw.git" } }), "invalid_input", "a remote with credentials");
  await expectFailure(() => save({ merge_target: "bad..branch" }), "invalid_input", "an invalid branch name");
  await expectFailure(() => save({ auto_merge: true }), "invalid_input", "an unknown setting");
}

const first = await reviewableAttempt("first", [{ path: "feature-a.txt", content: "a\n" }]);
await expectFailure(() => accept(first, "no-policy"), "policy_not_found", "accepting without a policy");
assert((await acceptance.listExecutionAcceptances({ attempt_id: first.attempt.id })).length === 0, "a refusal before the run starts must record nothing");

// --- local acceptance: commit, fast-forward, settle, release ------------------------------------

const localPolicy = await savePolicy({ merge_target: "integration" });
const headBefore = operatorHead();
let firstAcceptanceId;
let firstCommit;
{
  const result = await accept(first, "accept-first", { note: "looks right" });
  const run = result.acceptance;
  firstAcceptanceId = run.id;
  firstCommit = run.commit_sha;
  assert(run.status === "accepted" && run.step === "completed" && !result.replayed, `local acceptance must complete: ${JSON.stringify(run)}`);
  assert(git(repo.dir, "rev-parse", `refs/heads/${first.branch}`) === run.commit_sha, "the commit must be on the attempt branch");
  assert(git(repo.dir, "log", "-1", "--format=%B", run.commit_sha).includes(`Claw-Task-Hub-Attempt: ${first.attempt.id}`), "the commit must carry its attempt trailer");
  assert(git(repo.dir, "log", "-1", "--format=%an <%ae>", run.commit_sha) === "Claw Task Hub <claw-task-hub@localhost>", "the commit must use the policy's author");
  assert(git(repo.dir, "rev-parse", `${run.commit_sha}^{tree}`) === first.verdict.tree_fingerprint, "the commit must hold exactly the verified tree");
  assert(run.merge_sha === run.commit_sha && run.merge_target_previous_sha === repo.base && git(repo.dir, "rev-parse", "integration") === run.commit_sha, "a merge target at the base must fast-forward");
  assert(operatorHead() === headBefore && git(repo.dir, "status", "--porcelain") === "" && git(repo.dir, "rev-parse", "--abbrev-ref", "HEAD") === "main", "the operator's checkout must be untouched");

  const accepted = result.attempt;
  const transition = accepted.transitions.at(-1);
  assert(accepted.state === "accepted" && transition.event === "accept" && transition.policy === `acceptance-policy:${localPolicy.id}@${localPolicy.revision}`, "the accept transition must name the policy");
  assert(accepted.artifacts.some((artifact) => artifact.kind === "commit" && artifact.ref === run.commit_sha) && accepted.artifacts.some((artifact) => artifact.kind === "merge_commit"), "the transition must record the identities");
  const issue = await store.getIssue(first.issue.identifier);
  assert(issue.status === "Done" && issue.comments.filter((comment) => comment.external_id === `acceptance:${run.id}`).length === 1, "the issue must be Done with one acceptance comment");
  assert((await store.listIssueClaims({ issue_id: first.issue.id, include_released: true }))[0].status === "completed", "the claim must be released as completed");
  const lease = (await workspaces.listExecutionWorkspaces({ attempt_id: first.attempt.id, include_released: true }))[0];
  assert(lease.status === "released" && !existsSync(first.worktree) && git(repo.dir, "rev-parse", "--verify", `refs/heads/${first.branch}`), "the workspace must be released and the branch kept");

  const replay = await accept(first, "accept-first");
  assert(replay.replayed && replay.acceptance.id === run.id, "repeating the key must return the finished run");
  await expectFailure(() => accept(first, "accept-first-again"), "attempt_not_reviewable", "accepting an accepted attempt with a new key");

  // An interruption after the transition: the run resumes and settles once.
  dbModule.db.prepare("UPDATE execution_acceptances SET status = 'in_progress', step = 'transitioned', completed_at = NULL WHERE id = ?").run(run.id);
  const transitionsBefore = accepted.transitions.length;
  const resumed = await accept(first, "accept-first");
  assert(!resumed.replayed && resumed.acceptance.status === "accepted" && resumed.acceptance.commit_sha === run.commit_sha, "a resumed run must finish without a new commit");
  assert(resumed.attempt.transitions.length === transitionsBefore, "a resumed run must not transition again");
  assert((await store.getIssue(first.issue.identifier)).comments.filter((comment) => comment.external_id === `acceptance:${run.id}`).length === 1, "a resumed run must not duplicate its comment");
}

// --- merge commits and merge conflicts -------------------------------------------------------------

{
  const second = await reviewableAttempt("second", [{ path: "feature-b.txt", content: "b\n" }]);
  const merged = (await accept(second, "accept-second")).acceptance;
  const parents = git(repo.dir, "rev-list", "--parents", "-n", "1", merged.merge_sha).split(" ");
  assert(merged.status === "accepted" && parents.length === 3 && parents.includes(firstCommit) && parents.includes(merged.commit_sha), `a diverged target must receive a merge commit: ${parents.join(" ")}`);
  assert(git(repo.dir, "rev-parse", "integration") === merged.merge_sha && operatorHead() === headBefore, "the target must move to the merge commit, and only the target");

  const conflicting = await reviewableAttempt("conflicting", [{ path: "feature-a.txt", content: "a different a\n" }]);
  const integrationBefore = git(repo.dir, "rev-parse", "integration");
  const rejected = await accept(conflicting, "accept-conflicting");
  assert(rejected.acceptance.status === "rejected" && rejected.acceptance.outcome.code === "merge_conflict", `a merge conflict must reject the run: ${JSON.stringify(rejected.acceptance)}`);
  assert(rejected.attempt.state === "failed" && rejected.attempt.state_reason === "merge_conflict", "a merge conflict must reject the attempt with merge_conflict");
  assert(rejected.attempt.transitions.at(-1).details.conflicted_paths.includes("feature-a.txt"), "the rejection must name the conflicted path");
  assert(git(repo.dir, "rev-parse", "integration") === integrationBefore, "a conflicted merge must not move the target");
  assert((await store.listIssueClaims({ issue_id: conflicting.issue.id })).length === 1, "a merge conflict must keep the claim for a retry");
}

// --- typed failures leave the attempt reviewable; review rejection -----------------------------------

{
  const stale = await reviewableAttempt("stale", [{ path: "feature-c.txt", content: "c\n" }]);
  writeFileSync(join(stale.worktree, "feature-c.txt"), "changed after verification\n");
  await expectFailure(() => accept(stale, "accept-stale"), "verification_stale", "accepting a worktree that changed after verification");
  const failedRun = (await acceptance.listExecutionAcceptances({ attempt_id: stale.attempt.id }))[0];
  assert(failedRun.status === "failed" && failedRun.outcome.code === "verification_stale" && (await attempts.getExecutionAttempt(stale.attempt.id)).state === "reviewable", "a stale verification must fail the run and leave the attempt reviewable");

  const rejected = await acceptance.rejectExecutionAttempt({ attempt_id: stale.attempt.id, idempotency_key: "reject-stale", actor_kind: "operator", actor_id: "operator-1", note: "needs rework" });
  assert(rejected.attempt.state === "failed" && rejected.attempt.state_reason === "review_rejected" && rejected.claim_release.released === true, "review rejection must fail the attempt and release the claim");
  const replayed = await acceptance.rejectExecutionAttempt({ attempt_id: stale.attempt.id, idempotency_key: "reject-stale", actor_kind: "operator", actor_id: "operator-1" });
  assert(replayed.outcome === "replayed" && replayed.claim_release.released === false, "a replayed rejection must not release anything again");
  assert((await evidence.listExecutionEvidence({ attempt_id: stale.attempt.id, kind: "verdict" })).length === 1, "rejection must keep the evidence");

  const checkedOut = await reviewableAttempt("checked-out", [{ path: "feature-d.txt", content: "d\n" }]);
  await savePolicy({ merge_target: "main" });
  await expectFailure(() => accept(checkedOut, "accept-checked-out"), "merge_target_checked_out", "merging into the operator's checked-out branch");
  assert(operatorHead() === headBefore && (await attempts.getExecutionAttempt(checkedOut.attempt.id)).state === "reviewable", "a checked-out target must be left alone");
}

// --- push, pull request, and provider merge through the fake provider ----------------------------------

{
  const remotePolicy = { allow_push: true, push: { remote: bareRemote }, allow_pull_request: true, pull_request: { provider: "fake", base_branch: "main", merge: true }, allow_provider_merge: true };
  await savePolicy(remotePolicy);
  const pushed = await reviewableAttempt("pushed", [{ path: "feature-e.txt", content: "e\n" }]);
  const run = (await accept(pushed, "accept-pushed")).acceptance;
  assert(run.status === "accepted" && run.pushed_refs.length === 1 && git(bareRemote, "rev-parse", `refs/heads/${pushed.branch}`) === run.commit_sha, `the branch must be pushed: ${JSON.stringify(run)}`);
  assert(run.pull_request.provider === "fake" && run.pull_request.url.startsWith("fake://") && run.pull_request.merge_commit, "the pull request must be opened and merged");
  assert((await attempts.getExecutionAttempt(pushed.attempt.id)).artifacts.some((artifact) => artifact.kind === "pull_request" && artifact.ref === run.pull_request.url), "the transition must record the pull request");

  const unavailable = await reviewableAttempt("unavailable", [{ path: "feature-f.txt", content: "f\n" }]);
  process.env.CLAW_TASK_HUB_ENABLE_FAKE_PROVIDER = "0";
  await expectFailure(() => accept(unavailable, "accept-unavailable"), "provider_unavailable", "opening a pull request without the provider");
  const failedRun = (await acceptance.listExecutionAcceptances({ attempt_id: unavailable.attempt.id }))[0];
  assert(failedRun.status === "failed" && failedRun.step === "pushed", "the failed run must record the step it reached");
  process.env.CLAW_TASK_HUB_ENABLE_FAKE_PROVIDER = "1";
  const retried = (await accept(unavailable, "accept-unavailable-retry")).acceptance;
  assert(retried.status === "accepted" && retried.commit_sha === failedRun.commit_sha, "a later run must reuse the commit and finish");
  assert((await acceptance.listExecutionAcceptances({ attempt_id: unavailable.attempt.id })).length === 2, "both runs must stay on record");

  const providerConflict = await reviewableAttempt("provider-conflict", [{ path: "feature-g.txt", content: "g\n" }]);
  process.env.CLAW_TASK_HUB_FAKE_PROVIDER_MERGE = "conflict";
  const conflicted = await accept(providerConflict, "accept-provider-conflict");
  delete process.env.CLAW_TASK_HUB_FAKE_PROVIDER_MERGE;
  assert(conflicted.acceptance.status === "rejected" && conflicted.attempt.state_reason === "merge_conflict" && conflicted.acceptance.pull_request?.number, "a provider merge conflict must reject with merge_conflict after opening the pull request");
}

// --- CLI, MCP, and HTTP -----------------------------------------------------------------------------------

function runHub(tool, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["server/hub-cli.ts", "tools/call", tool, `base64:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}`], { cwd: process.cwd(), env: process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

{
  const cli = await runHub("list_execution_acceptances", { attempt_id: first.attempt.id });
  assert(cli.status === 0 && JSON.parse(cli.stdout).acceptances[0].id === firstAcceptanceId, `CLI list_execution_acceptances failed:\n${cli.stderr}`);

  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "reject_execution_attempt", arguments: { attempt_id: first.attempt.id, idempotency_key: "mcp-reject", actor_kind: "operator", actor_id: "operator-1" } } }),
    "",
  ].join("\n");
  const mcp = spawnSync(process.execPath, ["server/mcp-server.ts"], { cwd: process.cwd(), env: process.env, input, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert(mcp.status === 0, `MCP server failed:\n${mcp.stderr}`);
  const messages = String(mcp.stdout).split(/\r?\n/).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
  const byId = (id) => messages.find((message) => message.id === id);
  const names = (byId(2)?.result?.tools ?? []).map((tool) => tool.name);
  for (const name of ["list_execution_providers", "save_acceptance_policy", "get_acceptance_policy", "accept_execution_attempt", "reject_execution_attempt", "list_execution_acceptances", "get_execution_acceptance"]) {
    assert(names.includes(name), `MCP does not describe ${name}`);
  }
  assert(byId(3)?.error?.message?.startsWith("terminal_state:") || byId(3)?.error?.message?.startsWith("invalid_transition:"), `MCP must surface typed rejection failures, got ${JSON.stringify(byId(3))}`);

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
    let result = await call("/execution-providers");
    assert(result.status === 200 && result.body.providers.some((provider) => provider.id === "fake" && provider.available), `HTTP provider list failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/acceptance-policies?repository=${encodeURIComponent(repo.remote)}`);
    assert(result.status === 200 && result.body.policy.revision >= 3, `HTTP policy read failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/execution-attempts/${first.attempt.id}/accept`, { method: "POST", body: JSON.stringify({ idempotency_key: "http-accept", actor_kind: "operator", actor_id: "operator-1" }) });
    assert(result.status === 409 && result.body.code === "attempt_not_reviewable", `HTTP accept of an accepted attempt must be 409: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/execution-attempts/${first.attempt.id}/acceptances`);
    assert(result.status === 200 && result.body.acceptances.length === 1, `HTTP acceptance list failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call("/execution-acceptances/acceptance_missing");
    assert(result.status === 404 && result.body.code === "acceptance_not_found", `HTTP missing acceptance must be 404: ${result.status} ${JSON.stringify(result.body)}`);
  } finally {
    await stopProcessTree(api);
  }
}

console.log("Execution acceptance regression passed");
