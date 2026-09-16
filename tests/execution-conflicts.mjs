// Execution conflict regression.
//
// Runs real attempts in leased worktrees of a temporary repository through the
// fake harness and covers: declared-path validation and operator policies;
// declared overlaps that block a launch until an operator overrides them;
// observed overlaps on modified, renamed, and deleted files; the directory
// heuristic kept separate; escalation reopening an override while the decision
// log keeps every step; resolution when an overlap disappears or an attempt stops
// being live, and reopening when it returns; base divergence between different
// pinned bases, and unknown certainty when bases cannot be compared; blocking
// declared overlaps in runnable scheduling and claims; conflicts in verification
// verdicts; and the CLI, MCP, and HTTP surfaces.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

if (process.env.CLAW_TASK_HUB_CONFLICT_WORKER !== "1") {
  const parentTempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-conflicts-"));
  const gitConfig = join(parentTempDir, "gitconfig");
  writeFileSync(gitConfig, "");
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: {
      ...withoutRedirectingGitVariables(process.env),
      CLAW_TASK_HUB_DB: join(parentTempDir, "hub", "conflicts.sqlite"),
      CLAW_TASK_HUB_WORKSPACE_ROOT: join(parentTempDir, "workspaces"),
      CLAW_TASK_HUB_CONFLICT_TEMP: parentTempDir,
      CLAW_TASK_HUB_QUIET_DB: "1",
      CLAW_TASK_HUB_CONFLICT_WORKER: "1",
      CLAW_TASK_HUB_ENABLE_FAKE_HARNESS: "1",
      CLAW_TASK_HUB_API_BASE: "http://127.0.0.1:9/api",
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Conflict Test",
      GIT_AUTHOR_EMAIL: "conflicts@example.com",
      GIT_COMMITTER_NAME: "Conflict Test",
      GIT_COMMITTER_EMAIL: "conflicts@example.com",
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
    console.error("Execution conflict cleanup failed after the worker exited:", error);
  }
  process.exit(cleanupFailed ? 1 : result.status ?? 1);
}

const tempRoot = process.env.CLAW_TASK_HUB_CONFLICT_TEMP;
assert(tempRoot && process.env.CLAW_TASK_HUB_DB, "Execution conflict worker requires its temp directory and database");

const dbModule = await import("../server/db.ts");
const store = await import("../server/store.ts");
const attempts = await import("../server/execution-attempts.ts");
const workspaces = await import("../server/execution-workspaces.ts");
const runs = await import("../server/execution-runs.ts");
const evidence = await import("../server/execution-evidence.ts");
const conflicts = await import("../server/execution-conflicts.ts");
const runnability = await import("../server/issue-runnability.ts");

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
mkdirSync(join(repoDir, "lib"), { recursive: true });
git(repoDir, "init", "--quiet", "-b", "main");
for (const [path, content] of [["README.md", "base\n"], ["shared.txt", "shared\n"], ["old-name.txt", "rename me\nsame content\n"], ["gone.txt", "delete me\n"], ["lib/keep.txt", "keep\n"]]) {
  writeFileSync(join(repoDir, path), content);
}
git(repoDir, "add", "-A");
git(repoDir, "commit", "--quiet", "-m", "base");
const repo = { dir: realpathSync.native(repoDir), remote: "https://example.com/claw/conflicts.git", base1: git(repoDir, "rev-parse", "HEAD") };
git(repoDir, "remote", "add", "origin", repo.remote);

const project = await store.upsertProject({ external_id: "conflict-project", name: "Conflict Project" });
let issueNumber = 970000;

async function issue(title) {
  issueNumber += 1;
  return await store.upsertIssue({ title, identifier: `CTH-${issueNumber}`, status: "Todo", project_id: project.id });
}

async function claim(target) {
  const sessionId = `session-conflicts-${target.identifier}`;
  await store.startAgentSession({ id: sessionId, agent_name: `Agent ${target.identifier}`, harness: "codex", ttl_minutes: 240 });
  return (await store.claimIssue({ issue_id: target.id, session_id: sessionId, ttl_minutes: 240, force: true })).claim;
}

async function startAttempt(target, baseSha) {
  const claimed = await claim(target);
  return await workspaces.startExecutionAttempt({
    issue_id: target.identifier,
    claim_id: claimed.id,
    harness: "fake",
    repository: repo.remote,
    base_sha: baseSha,
    idempotency_key: `conflicts-create-${target.identifier}`,
    repository_path: repo.dir,
  });
}

async function launch(attempt, files) {
  const launched = await runs.launchExecutionAttempt({ attempt_id: attempt.id, adapter: "fake", prompt: JSON.stringify({ write: files }), idempotency_key: `conflicts-launch-${attempt.id}` });
  const outcome = await launched.completion;
  assert(outcome?.result === "completed", `the fixture run failed: ${JSON.stringify(outcome)}`);
}

const declare = (target, paths) => conflicts.declareExecutionPaths({ issue_id: target.id, repository: repo.remote, paths, actor_kind: "agent", actor_id: "planner" });
const listed = (input = {}) => conflicts.listExecutionConflicts({ repository: repo.remote, ...input });
const find = (records, method, path) => records.find((record) => record.method === method && record.path === path);
const pairOf = (record) => new Set(record.attempts.map((attempt) => attempt.id));

// --- validation ------------------------------------------------------------------------------

{
  const target = await issue("Validation target");
  for (const path of ["../outside.txt", "/absolute.txt", "C:/drive.txt", "src/*.ts", "a//b.txt", ""]) {
    await expectFailure(() => declare(target, [path]), "invalid_input", `declaring ${JSON.stringify(path)}`);
  }
  await expectFailure(() => conflicts.declareExecutionPaths({ issue_id: "CTH-999999", repository: repo.remote, paths: [], actor_kind: "agent", actor_id: "planner" }), "issue_not_found", "declaring for a missing issue");
  await expectFailure(() => conflicts.saveConflictPolicy({ repository: repo.remote, rules: {}, actor_kind: "agent", actor_id: "a" }), "invalid_input", "a policy from a non-operator");
  await expectFailure(() => conflicts.saveConflictPolicy({ repository: repo.remote, rules: { exact: "blocking" }, actor_kind: "operator", actor_id: "op" }), "invalid_input", "an unknown rule");
  await expectFailure(() => conflicts.saveConflictPolicy({ repository: repo.remote, rules: { shared_directory: "blocking" }, actor_kind: "operator", actor_id: "op" }), "invalid_input", "a blocking heuristic");
  const saved = await declare(target, ["./docs\\guide.md", "src/", "docs/guide.md"]);
  assert(JSON.stringify(saved.declaration.paths) === JSON.stringify(["docs/guide.md", "src/"]), `paths must be normalized, deduplicated, and sorted: ${JSON.stringify(saved.declaration.paths)}`);
  assert((await conflicts.getConflictPolicy({ repository: repo.remote })).effective_rules.exact_path_observed === "warning", "without a policy the defaults must apply");
}

// --- declared overlaps block a launch until overridden -------------------------------------------

const issueX = await issue("Attempt X");
const issueY = await issue("Attempt Y");
await declare(issueX, ["shared.txt", "docs/"]);
await declare(issueY, ["shared.txt", "docs/guide.md"]);
const startedX = await startAttempt(issueX, repo.base1);
const startedY = await startAttempt(issueY, repo.base1);
const attemptX = startedX.attempt;
const attemptY = startedY.attempt;
let sharedConflictId;
{
  const detection = await conflicts.detectExecutionConflicts({ repository: repo.remote });
  const shared = find(detection.conflicts, "exact_path", "shared.txt");
  assert(shared && shared.certainty === "declared" && shared.severity === "warning" && shared.status === "open" && !shared.blocking, `a declared exact overlap must be a declared warning: ${JSON.stringify(detection.conflicts)}`);
  assert(pairOf(shared).has(attemptX.id) && pairOf(shared).has(attemptY.id) && shared.bases.differ === false, "the record must name both attempts and their bases");
  assert(find(detection.conflicts, "declared_directory", "docs/guide.md")?.certainty === "declared", "a declared directory must contain the other side's declared file");
  sharedConflictId = shared.id;

  await launch(attemptX, [{ path: "shared.txt", content: "shared by X\n" }, { path: "lib/a.txt", content: "a\n" }]);
  const policy = await conflicts.saveConflictPolicy({ repository: repo.remote, rules: { exact_path_observed: "blocking", exact_path_declared: "blocking" }, actor_kind: "operator", actor_id: "operator-1", note: "no overlapping work" });
  assert(policy.policy.revision === 1 && policy.policy.rules.shared_directory === "info", "a policy must keep defaults for unspecified rules");

  const refused = await expectFailure(() => launch(attemptY, []), "conflict_blocked", "launching into a blocking declared overlap");
  assert(refused.details.conflicts.some((conflict) => conflict.id === sharedConflictId && conflict.other_attempt_id === attemptX.id), "the refusal must name the conflict and the other attempt");
  assert((await attempts.getExecutionAttempt(attemptY.id)).state === "provisioning", "a refused launch must start nothing");

  await expectFailure(() => conflicts.decideExecutionConflict({ conflict_id: sharedConflictId, decision: "override", actor_kind: "agent", actor_id: "a", reason: "mine" }), "invalid_input", "an override from a non-operator");
  const overridden = await conflicts.decideExecutionConflict({ conflict_id: sharedConflictId, decision: "override", actor_kind: "operator", actor_id: "operator-1", reason: "planned coordination" });
  assert(overridden.conflict.status === "overridden" && !overridden.conflict.blocking, "an override must stop the conflict blocking");
  await launch(attemptY, [{ path: "shared.txt", content: "shared by Y\n" }, { path: "lib/b.txt", content: "b\n" }, { path: "old-name.txt", content: "changed by Y\n" }, { path: "gone.txt", content: "kept by Y\n" }]);
}

// --- observed overlaps: modifications, renames, deletions, and the heuristic --------------------------

const worktreeX = startedX.workspace.worktree_path;
const worktreeY = startedY.workspace.worktree_path;
{
  git(worktreeX, "mv", "old-name.txt", "moved.txt");
  rmSync(join(worktreeX, "gone.txt"));
  writeFileSync(join(worktreeX, "README.md"), "base\nchanged by X\n");
  await evidence.captureExecutionDiff({ attempt_id: attemptX.id });
  const captured = await evidence.captureExecutionDiff({ attempt_id: attemptY.id });
  assert(Array.isArray(captured.conflicts) && captured.conflicts.length > 0, "capturing a diff must return the attempt's conflicts");

  const records = await listed();
  const shared = find(records, "exact_path", "shared.txt");
  assert(shared.id === sharedConflictId && shared.certainty === "observed" && shared.severity === "blocking" && shared.status === "open" && shared.blocking, `observing both sides must escalate and reopen the override: ${JSON.stringify(shared)}`);
  const renamed = find(records, "exact_path", "old-name.txt");
  assert(renamed?.certainty === "observed" && [...renamed.detail.a, ...renamed.detail.b].some((touch) => touch.role === "rename_source" && touch.counterpart === "moved.txt"), `a rename source must overlap a modification: ${JSON.stringify(renamed)}`);
  const deleted = find(records, "exact_path", "gone.txt");
  assert(deleted?.certainty === "observed" && [...deleted.detail.a, ...deleted.detail.b].some((touch) => touch.change === "D"), `a deletion must overlap a modification: ${JSON.stringify(deleted)}`);
  const heuristic = find(records, "shared_directory", "lib/");
  assert(heuristic?.certainty === "heuristic" && heuristic.severity === "info" && !heuristic.blocking, `different files in one directory must stay a non-blocking heuristic: ${JSON.stringify(heuristic)}`);
  assert(!records.some((record) => record.method === "base_divergence"), "attempts on the same base must not report base divergence");

  const history = (await conflicts.getExecutionConflict(sharedConflictId)).decisions.map((decision) => `${decision.decision}:${decision.to_status}`);
  assert(JSON.stringify(history) === JSON.stringify(["detected:open", "changed:open", "override:overridden", "reopened:open"]), `the decision log must keep every step: ${JSON.stringify(history)}`);
  await expectFailure(() => conflicts.decideExecutionConflict({ conflict_id: sharedConflictId, decision: "reopen", actor_kind: "operator", actor_id: "operator-1", reason: "again" }), "invalid_decision", "reopening an open conflict");
}

// --- resolution and reopening -----------------------------------------------------------------------

{
  git(worktreeY, "checkout", "--", "gone.txt");
  await evidence.captureExecutionDiff({ attempt_id: attemptY.id });
  const resolved = find(await listed({ include_resolved: true }), "exact_path", "gone.txt");
  assert(resolved.status === "resolved" && resolved.resolution === "no_longer_detected" && !find(await listed(), "exact_path", "gone.txt"), "an overlap that disappears must resolve and leave the default listing");
  await expectFailure(() => conflicts.decideExecutionConflict({ conflict_id: resolved.id, decision: "override", actor_kind: "operator", actor_id: "operator-1", reason: "late" }), "invalid_decision", "overriding a resolved conflict");
  writeFileSync(join(worktreeY, "gone.txt"), "changed by Y again\n");
  await evidence.captureExecutionDiff({ attempt_id: attemptY.id });
  const reopened = await conflicts.getExecutionConflict(resolved.id);
  assert(reopened.status === "open" && reopened.decisions.at(-1).decision === "reopened" && reopened.decisions.at(-1).reason === "detected_again", "a returning overlap must reopen its record");
}

// --- runnable scheduling and claims ------------------------------------------------------------------

{
  const waiting = await issue("Waiting on shared work");
  await declare(waiting, ["shared.txt"]);
  const listing = await runnability.listRunnableIssues({ issue_id: waiting.id });
  const entry = listing.excluded[0];
  const pathConflict = entry?.reasons.find((reason) => reason.code === "path_conflict");
  assert(pathConflict?.conflicts.some((finding) => finding.attempt_id === attemptX.id && finding.path === "shared.txt" && finding.severity === "blocking"), `a blocking declared overlap must exclude the issue: ${JSON.stringify(listing)}`);
  await store.startAgentSession({ id: "session-waiting", agent_name: "Waiting Agent", harness: "codex", ttl_minutes: 60 });
  const refusal = await store.claimIssue({ issue_id: waiting.id, session_id: "session-waiting" }).then(() => null, (error) => error);
  assert(refusal && /is blocked; resolve its dependencies/.test(refusal.message) && refusal.message.includes("path_conflict"), `claiming must refuse a blocking path conflict: ${refusal?.message}`);
  const forced = await store.claimIssue({ issue_id: waiting.id, session_id: "session-waiting", force: true });
  assert(forced.claim.status === "active", "force must still claim");

  const nearby = await issue("Nearby work");
  await declare(nearby, ["lib/c.txt"]);
  const nearbyListing = await runnability.listRunnableIssues({ issue_id: nearby.id });
  assert(nearbyListing.runnable[0]?.path_warnings.some((finding) => finding.method === "shared_directory" && finding.certainty === "heuristic"), `non-blocking overlaps must be warnings: ${JSON.stringify(nearbyListing)}`);
}

// --- base divergence ---------------------------------------------------------------------------------

let attemptZ;
{
  writeFileSync(join(repo.dir, "README.md"), "base\nchanged on main\n");
  writeFileSync(join(repo.dir, "base-only.txt"), "new on main\n");
  git(repo.dir, "add", "-A");
  git(repo.dir, "commit", "--quiet", "-m", "second base");
  const base2 = git(repo.dir, "rev-parse", "HEAD");
  const issueZ = await issue("Attempt Z on a newer base");
  attemptZ = (await startAttempt(issueZ, base2)).attempt;
  await launch(attemptZ, [{ path: "notes.txt", content: "z\n" }]);
  await evidence.captureExecutionDiff({ attempt_id: attemptZ.id });
  const divergence = find(await listed(), "base_divergence", "README.md");
  assert(divergence && pairOf(divergence).has(attemptX.id) && pairOf(divergence).has(attemptZ.id), `a path changed between bases must be reported for the attempt touching it: ${JSON.stringify(await listed())}`);
  assert(divergence.certainty === "observed" && divergence.bases.differ && divergence.detail.between_bases === "M" && ["a_before_b", "b_before_a"].includes(divergence.detail.ancestry), `base divergence must carry the change and ancestry: ${JSON.stringify(divergence)}`);

  // Attempts without worktrees cannot compare their bases, and must say so.
  const otherRepository = "https://example.com/claw/no-worktrees.git";
  const bare = [];
  for (const [index, sha] of [repo.base1, base2].entries()) {
    const target = await issue(`Worktree-less attempt ${index}`);
    const claimed = await claim(target);
    bare.push((await attempts.createExecutionAttempt({ issue_id: target.identifier, claim_id: claimed.id, harness: "fake", repository: otherRepository, base_sha: sha, idempotency_key: `conflicts-bare-${index}` })).attempt);
  }
  const unknown = find((await conflicts.detectExecutionConflicts({ repository: otherRepository })).conflicts, "base_divergence", "");
  assert(unknown?.certainty === "unknown" && /worktree/.test(unknown.detail.reason), `uncomparable bases must be recorded as unknown: ${JSON.stringify(unknown)}`);
}

// --- verification records conflicts; terminal attempts resolve theirs ----------------------------------

{
  await evidence.saveVerificationPolicy({ repository: repo.remote, steps: [{ name: "unit", command: [process.execPath, "-e", "0"] }], actor_kind: "operator", actor_id: "operator-1" });
  const verified = await evidence.verifyExecutionAttempt({ attempt_id: attemptZ.id });
  assert(verified.attempt.state === "reviewable", `conflicts must not change a verdict: ${JSON.stringify(verified.verdict?.payload)}`);
  assert(verified.verdict.payload.conflicts.some((conflict) => conflict.method === "base_divergence" && conflict.other_attempt_id === attemptX.id), "the verdict must record the attempt's conflicts for review");

  const current = await attempts.getExecutionAttempt(attemptY.id);
  await attempts.transitionExecutionAttempt({ attempt_id: attemptY.id, event: "cancel", expected_revision: current.revision, idempotency_key: "conflicts-cancel-y", actor_kind: "operator", actor_id: "operator-1", reason: "operator_requested" });
  await conflicts.detectExecutionConflicts({ repository: repo.remote });
  const afterCancel = await listed({ attempt_id: attemptY.id, include_resolved: true });
  assert(afterCancel.length > 0 && afterCancel.every((record) => record.status === "resolved" && record.resolution === "attempt_not_live"), `a canceled attempt's conflicts must resolve: ${JSON.stringify(afterCancel.map((record) => [record.path, record.status, record.resolution]))}`);
  assert((await conflicts.getExecutionConflict(sharedConflictId)).decisions.some((decision) => decision.decision === "override"), "resolution must not erase earlier overrides");
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
  const cli = await runHub("list_execution_conflicts", { repository: repo.remote, include_resolved: true });
  assert(cli.status === 0 && JSON.parse(cli.stdout).conflicts.some((record) => record.id === sharedConflictId), `CLI list_execution_conflicts failed:\n${cli.stderr}`);

  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "decide_execution_conflict", arguments: { conflict_id: "conflict_missing", decision: "override", actor_kind: "operator", actor_id: "operator-1", reason: "none" } } }),
    "",
  ].join("\n");
  const mcp = spawnSync(process.execPath, ["server/mcp-server.ts"], { cwd: process.cwd(), env: process.env, input, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert(mcp.status === 0, `MCP server failed:\n${mcp.stderr}`);
  const messages = String(mcp.stdout).split(/\r?\n/).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
  const byId = (id) => messages.find((message) => message.id === id);
  const names = (byId(2)?.result?.tools ?? []).map((tool) => tool.name);
  for (const name of ["declare_execution_paths", "get_execution_path_declaration", "save_conflict_policy", "get_conflict_policy", "detect_execution_conflicts", "list_execution_conflicts", "get_execution_conflict", "decide_execution_conflict"]) {
    assert(names.includes(name), `MCP does not describe ${name}`);
  }
  assert(byId(3)?.error?.message?.startsWith("conflict_not_found:"), `MCP must surface typed conflict failures, got ${JSON.stringify(byId(3))}`);

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
    let result = await call(`/execution-conflicts?repository=${encodeURIComponent(repo.remote)}&include_resolved=true`);
    assert(result.status === 200 && result.body.conflicts.length > 0, `HTTP conflict list failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call("/execution-conflicts/conflict_missing");
    assert(result.status === 404 && result.body.code === "conflict_not_found", `HTTP missing conflict must be 404: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/execution-conflicts/${sharedConflictId}/decisions`, { method: "POST", body: JSON.stringify({ decision: "override", actor_kind: "operator", actor_id: "operator-1", reason: "too late" }) });
    assert(result.status === 409 && result.body.code === "invalid_decision", `HTTP override of a resolved conflict must be 409: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/conflict-policies?repository=${encodeURIComponent(repo.remote)}`);
    assert(result.status === 200 && result.body.policy.revision === 1, `HTTP policy read failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/issues/${issueX.identifier}/execution-paths?repository=${encodeURIComponent(repo.remote)}`);
    assert(result.status === 200 && JSON.stringify(result.body.declaration.paths) === JSON.stringify(["docs/", "shared.txt"]), `HTTP declaration read failed: ${result.status} ${JSON.stringify(result.body)}`);
  } finally {
    await stopProcessTree(api);
  }
}

console.log("Execution conflict regression passed");
