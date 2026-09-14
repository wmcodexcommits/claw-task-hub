// Execution workspace lease regression.
//
// Drives real temporary Git repositories through the lease lifecycle: two agents
// on different issues get isolated worktrees and branches at the pinned base;
// the operator's dirty checkout, HEAD, and hooks are left alone; repeated and
// concurrent provisioning is idempotent; ownership is queryable; collisions with
// foreign branches and directories are refused without touching them; partial
// and expired provisioning is recovered; base drift is detected; cancellation and
// release keep uncommitted work and branches; and a restarted process sees the
// same leases through the CLI, MCP, and HTTP surfaces.
//
// Runs in a spawned worker with its own database, workspace root, and an empty
// global Git configuration, so the developer's Git settings cannot change what
// the test observes.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

// Git writes object files read-only; make the tree removable on Windows.
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

if (process.env.CLAW_TASK_HUB_WORKSPACES_WORKER !== "1") {
  const parentTempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-workspaces-"));
  const gitConfig = join(parentTempDir, "gitconfig");
  writeFileSync(gitConfig, "");
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAW_TASK_HUB_DB: join(parentTempDir, "hub", "workspaces.sqlite"),
      CLAW_TASK_HUB_WORKSPACE_ROOT: join(parentTempDir, "workspaces"),
      CLAW_TASK_HUB_WORKSPACES_TEMP: parentTempDir,
      CLAW_TASK_HUB_QUIET_DB: "1",
      CLAW_TASK_HUB_WORKSPACES_WORKER: "1",
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Workspace Test",
      GIT_AUTHOR_EMAIL: "workspace@example.com",
      GIT_COMMITTER_NAME: "Workspace Test",
      GIT_COMMITTER_EMAIL: "workspace@example.com",
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
    console.error("Execution workspace cleanup failed after the worker exited:", error);
  }
  process.exit(cleanupFailed ? 1 : result.status ?? 1);
}

const tempRoot = process.env.CLAW_TASK_HUB_WORKSPACES_TEMP;
assert(tempRoot && process.env.CLAW_TASK_HUB_DB, "Execution workspace worker requires its temp directory and database");

const dbModule = await import("../server/db.ts");
const store = await import("../server/store.ts");
const attempts = await import("../server/execution-attempts.ts");
const workspaces = await import("../server/execution-workspaces.ts");
const { ExecutionContractError } = await import("../server/execution-contract.ts");

dbModule.initializeDatabase(dbModule.db);
await store.ensureDefaultTeam();

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: process.env, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stderr}`);
  return result.stdout.trim();
}

const reposRoot = join(tempRoot, "repos");
mkdirSync(reposRoot, { recursive: true });

function createRepository(name) {
  const dir = join(reposRoot, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "-b", "main");
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "--quiet", "-m", "base");
  const remote = `https://example.com/claw/${name}.git`;
  git(dir, "remote", "add", "origin", remote);
  return { dir: realpathSync.native(dir), sha: git(dir, "rev-parse", "HEAD"), remote };
}

async function expectFailure(run, code, message) {
  try {
    await run();
  } catch (error) {
    const typed = error instanceof workspaces.ExecutionWorkspaceError || error instanceof attempts.ExecutionAttemptError || error instanceof ExecutionContractError;
    assert(typed, `${message}: expected a typed failure, got ${error instanceof Error ? error.stack : error}`);
    assert(error.code === code, `${message}: expected ${code}, got ${error.code} (${error.message})`);
    assert(error.message.startsWith(`${code}:`), `${message}: the message must lead with its code (${error.message})`);
    return error;
  }
  throw new Error(`${message}: expected ${code}, but it succeeded`);
}

const lowerStartsWith = (value, prefix) => value.toLowerCase().startsWith(prefix.toLowerCase());

const repo = createRepository("service");
const hookMarker = join(tempRoot, "hook-ran");
writeFileSync(join(repo.dir, ".git", "hooks", "post-checkout"), `#!/bin/sh\necho ran > "${hookMarker.replace(/\\/g, "/")}"\n`);
chmodSync(join(repo.dir, ".git", "hooks", "post-checkout"), 0o755);
{
  // Positive control: this hook really runs on an ordinary checkout, so its
  // absence after provisioning means something.
  git(repo.dir, "checkout", "--quiet", "-b", "hook-probe");
  assert(existsSync(hookMarker), "the fixture hook did not run on a normal checkout, so its absence later would prove nothing");
  git(repo.dir, "checkout", "--quiet", "main");
  git(repo.dir, "branch", "--quiet", "-D", "hook-probe");
  rmSync(hookMarker);
}
// The operator is mid-edit: a modified tracked file and an untracked one.
writeFileSync(join(repo.dir, "README.md"), "operator edit in progress\n");
writeFileSync(join(repo.dir, "scratch.txt"), "untracked operator file\n");
const operatorStatus = git(repo.dir, "status", "--porcelain");
const operatorBranch = git(repo.dir, "rev-parse", "--abbrev-ref", "HEAD");

const project = await store.upsertProject({ external_id: "workspaces-project", name: "Workspaces Project" });
let issueNumber = 960000;
async function claimedIssue(sessionId) {
  issueNumber += 1;
  const identifier = `CTH-${issueNumber}`;
  const issue = await store.upsertIssue({ title: `Workspace target ${identifier}`, identifier, status: "Todo", project_id: project.id });
  await store.startAgentSession({ id: sessionId, agent_name: `Agent ${sessionId}`, harness: "codex", ttl_minutes: 240 });
  const { claim } = await store.claimIssue({ issue_id: identifier, session_id: sessionId, ttl_minutes: 240 });
  return { issue, claim };
}

let keyCounter = 0;
function attemptInput(target, overrides = {}) {
  keyCounter += 1;
  return {
    issue_id: target.issue.identifier,
    claim_id: target.claim.id,
    harness: "codex",
    repository: repo.remote,
    base_sha: repo.sha,
    idempotency_key: `workspace-create-${keyCounter}`,
    ...overrides,
  };
}

// --- two agents, two isolated workspaces ----------------------------------------

const agentA = await claimedIssue("session-workspace-a");
const agentB = await claimedIssue("session-workspace-b");
const startedA = await workspaces.startExecutionAttempt(attemptInput(agentA, { repository_path: repo.dir }));
const startedB = await workspaces.startExecutionAttempt(attemptInput(agentB, { repository_path: repo.dir }));
const leaseA = startedA.workspace;
const leaseB = startedB.workspace;
const workspaceRoot = realpathSync.native(process.env.CLAW_TASK_HUB_WORKSPACE_ROOT);
{
  assert(startedA.created && startedA.workspace_created && startedB.workspace_created, "starting an attempt with repository_path must create its workspace");
  assert(leaseA.status === "active" && leaseA.live && !leaseA.expired && leaseA.step === "worktree_created", `a provisioned lease must be active, got ${JSON.stringify(leaseA)}`);
  assert(leaseA.worktree_path !== leaseB.worktree_path && leaseA.branch !== leaseB.branch, "two attempts must get distinct worktrees and branches");
  assert(leaseA.branch === `cth/${agentA.issue.identifier.toLowerCase()}/${startedA.attempt.id}`, `unexpected branch name ${leaseA.branch}`);
  for (const lease of [leaseA, leaseB]) {
    assert(lowerStartsWith(lease.worktree_path, workspaceRoot), `${lease.worktree_path} is outside the workspace root`);
    assert(readFileSync(join(lease.worktree_path, "README.md"), "utf8").replace(/\r\n/g, "\n") === "base\n", "a worktree must hold the pinned base, not the operator's uncommitted edit");
    assert(git(lease.worktree_path, "rev-parse", "HEAD") === repo.sha, "a worktree must start at the pinned base");
    assert(git(lease.worktree_path, "symbolic-ref", "--short", "HEAD") === lease.branch, "a worktree must be on its leased branch");
  }
  writeFileSync(join(leaseA.worktree_path, "agent-a.txt"), "a\n");
  assert(!existsSync(join(leaseB.worktree_path, "agent-a.txt")), "one agent's files must not appear in another agent's worktree");
  rmSync(join(leaseA.worktree_path, "agent-a.txt"));

  assert(git(repo.dir, "status", "--porcelain") === operatorStatus, "provisioning must leave the operator's dirty checkout exactly as it was");
  assert(git(repo.dir, "rev-parse", "--abbrev-ref", "HEAD") === operatorBranch, "provisioning must not move the operator's HEAD");
  assert(readFileSync(join(repo.dir, "README.md"), "utf8").includes("operator edit in progress"), "the operator's uncommitted edit must survive provisioning");
  assert(!existsSync(hookMarker), "provisioning must not run repository hooks");
  assert(git(repo.dir, "worktree", "list", "--porcelain").includes("locked claw-task-hub lease"), "leased worktrees must be locked with the lease as the reason");
}

// --- idempotency and ownership ------------------------------------------------------

{
  const again = await workspaces.provisionExecutionWorkspace({ attempt_id: startedA.attempt.id, repository_path: repo.dir });
  assert(again.created === false && again.workspace.id === leaseA.id && again.workspace.worktree_path === leaseA.worktree_path, "repeating provisioning must return the same lease and worktree");
  assert((await workspaces.listExecutionWorkspaces({ attempt_id: startedA.attempt.id })).length === 1, "an attempt must hold exactly one lease");
  assert((await workspaces.listExecutionWorkspaces({ branch: leaseB.branch }))[0]?.attempt_id === startedB.attempt.id, "branch ownership must be queryable");
  assert((await workspaces.listExecutionWorkspaces({ worktree_path: leaseA.worktree_path }))[0]?.id === leaseA.id, "worktree ownership must be queryable");
  assert((await workspaces.listExecutionWorkspaces({ issue_id: agentB.issue.identifier })).length === 1, "an issue's workspaces must be queryable");
  await expectFailure(() => workspaces.provisionExecutionWorkspace({ attempt_id: "attempt_missing", repository_path: repo.dir }), "attempt_not_found", "provisioning a missing attempt");
}

// --- repository and path validation, collisions, missing base ----------------------------

const agentC = await claimedIssue("session-workspace-c");
const attemptC = (await attempts.createExecutionAttempt(attemptInput(agentC))).attempt;
let leaseC;
{
  const request = (overrides = {}) => workspaces.provisionExecutionWorkspace({ attempt_id: attemptC.id, repository_path: repo.dir, ...overrides });
  await expectFailure(() => request({ repository_path: "relative/service" }), "invalid_input", "a relative repository path");
  await expectFailure(() => request({ repository_path: join(tempRoot, "missing-repository") }), "repository_invalid", "a repository path that does not exist");
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  await expectFailure(() => request({ repository_path: join(repo.dir, "src") }), "repository_invalid", "a subdirectory instead of the working tree top");
  await expectFailure(() => request({ repository_path: leaseA.worktree_path }), "repository_is_workspace", "a leased worktree used as the source repository");
  const other = createRepository("other-service");
  await expectFailure(() => request({ repository_path: other.dir }), "repository_mismatch", "a repository whose origin is not the attempt's");

  const outer = createRepository("outer");
  const agentOuter = await claimedIssue("session-workspace-outer");
  const outerAttempt = (await attempts.createExecutionAttempt(attemptInput(agentOuter, { repository: outer.remote, base_sha: outer.sha }))).attempt;
  const configuredRoot = process.env.CLAW_TASK_HUB_WORKSPACE_ROOT;
  process.env.CLAW_TASK_HUB_WORKSPACE_ROOT = join(outer.dir, "workspaces");
  try {
    await expectFailure(() => workspaces.provisionExecutionWorkspace({ attempt_id: outerAttempt.id, repository_path: outer.dir }), "workspace_root_inside_repository", "a workspace root inside the repository");
    assert(!existsSync(join(outer.dir, "workspaces")), "a refused root must not be created inside the operator's checkout");
  } finally {
    process.env.CLAW_TASK_HUB_WORKSPACE_ROOT = configuredRoot;
  }

  const plan = await workspaces.planExecutionWorkspace({ attempt_id: attemptC.id, repository_path: repo.dir });
  assert(plan.base_sha === repo.sha && plan.branch.endsWith(attemptC.id) && lowerStartsWith(plan.worktree_path, workspaceRoot), `unexpected plan ${JSON.stringify(plan)}`);

  git(repo.dir, "branch", plan.branch, repo.sha);
  await expectFailure(() => request(), "branch_exists", "a branch with the leased name that no lease owns");
  assert(git(repo.dir, "rev-parse", plan.branch) === repo.sha, "a colliding branch must be left untouched");
  assert((await workspaces.listExecutionWorkspaces({ attempt_id: attemptC.id, include_released: true })).length === 0, "a refused collision must not record a lease");
  git(repo.dir, "branch", "--quiet", "-D", plan.branch);

  mkdirSync(plan.worktree_path, { recursive: true });
  writeFileSync(join(plan.worktree_path, "foreign.txt"), "not ours\n");
  await expectFailure(() => request(), "worktree_path_exists", "a directory at the leased path that no lease owns");
  assert(readFileSync(join(plan.worktree_path, "foreign.txt"), "utf8") === "not ours\n", "a colliding directory must be left untouched");
  rmSync(plan.worktree_path, { recursive: true, force: true });

  const agentMissingBase = await claimedIssue("session-workspace-base");
  const missingBaseAttempt = (await attempts.createExecutionAttempt(attemptInput(agentMissingBase, { base_sha: "d".repeat(40) }))).attempt;
  await expectFailure(() => workspaces.provisionExecutionWorkspace({ attempt_id: missingBaseAttempt.id, repository_path: repo.dir }), "base_missing", "a base commit the repository does not contain");

  const provisioned = await request();
  leaseC = provisioned.workspace;
  assert(provisioned.created && leaseC.branch === plan.branch && leaseC.worktree_path === plan.worktree_path, "provisioning must create exactly what the plan described");
}

// --- interrupted provisioning is recovered --------------------------------------------------

{
  // Simulate a crash after Git created the worktree but before the lease became
  // active, followed by the directory going missing.
  rmSync(leaseC.worktree_path, { recursive: true, force: true });
  const markProvisioning = (updatedAt) => dbModule.adapter.run(
    "UPDATE execution_workspace_leases SET status = 'provisioning', step = 'recorded', updated_at = @updated_at WHERE id = @id",
    { id: leaseC.id, updated_at: updatedAt },
  );
  await markProvisioning(new Date().toISOString());
  await expectFailure(
    () => workspaces.provisionExecutionWorkspace({ attempt_id: attemptC.id, repository_path: repo.dir }),
    "lease_conflict",
    "resuming a lease that may still be provisioning in another process",
  );
  await markProvisioning("2020-01-01T00:00:00.000Z");
  const recovered = await workspaces.provisionExecutionWorkspace({ attempt_id: attemptC.id, repository_path: repo.dir });
  assert(recovered.created === false && recovered.workspace.id === leaseC.id, "recovery must reuse the interrupted lease");
  assert(recovered.workspace.status === "active" && recovered.workspace.step === "worktree_created", `recovery must finish the lease, got ${JSON.stringify(recovered.workspace)}`);
  assert(existsSync(join(leaseC.worktree_path, "README.md")) && git(leaseC.worktree_path, "rev-parse", "HEAD") === repo.sha, "recovery must restore the worktree at the base");
}

// --- stale leases -----------------------------------------------------------------------------

{
  await dbModule.adapter.run("UPDATE execution_workspace_leases SET expires_at = @past WHERE id = @id", { id: leaseA.id, past: "2020-01-01T00:00:00.000Z" });
  const stale = await workspaces.getExecutionWorkspace(leaseA.id);
  assert(stale.expired === true && stale.live === true, "an expired active lease must read as expired");
  await expectFailure(() => workspaces.renewExecutionWorkspace({ id: leaseA.id }), "lease_expired", "renewing an expired lease");
  const reclaimed = await workspaces.provisionExecutionWorkspace({ attempt_id: startedA.attempt.id, repository_path: repo.dir, ttl_minutes: 30 });
  assert(reclaimed.workspace.id === leaseA.id && reclaimed.workspace.expired === false, "re-provisioning must verify and reclaim a stale lease");
  const renewed = await workspaces.renewExecutionWorkspace({ id: leaseA.id, ttl_minutes: 90 });
  assert(renewed.expires_at > reclaimed.workspace.expires_at, "renewal must extend the lease");
}

// --- base drift -------------------------------------------------------------------------------

{
  const tree = git(repo.dir, "rev-parse", `${repo.sha}^{tree}`);
  const unrelated = git(repo.dir, "commit-tree", tree, "-m", "history that does not contain the base");
  git(repo.dir, "update-ref", `refs/heads/${leaseB.branch}`, unrelated);
  await expectFailure(() => workspaces.provisionExecutionWorkspace({ attempt_id: startedB.attempt.id, repository_path: repo.dir }), "base_drift", "a leased branch rewritten without its base");
  const drifted = await workspaces.getExecutionWorkspace(leaseB.id);
  assert(drifted.status === "failed" && drifted.failure.includes("base_drift"), "a drifted lease must be recorded as failed with its reason");
  assert(existsSync(leaseB.worktree_path), "a drifted worktree must be left in place for inspection");
  git(repo.dir, "update-ref", `refs/heads/${leaseB.branch}`, repo.sha);
}

// --- cancellation and release -------------------------------------------------------------------

{
  const canceled = await attempts.transitionExecutionAttempt({
    attempt_id: startedA.attempt.id,
    event: "cancel",
    expected_revision: 0,
    idempotency_key: "workspace-cancel-a",
    actor_kind: "operator",
    actor_id: "operator-1",
    reason: "operator_requested",
  });
  assert(canceled.attempt.state === "canceled", "the fixture attempt must cancel");
  await expectFailure(() => workspaces.provisionExecutionWorkspace({ attempt_id: startedA.attempt.id, repository_path: repo.dir }), "attempt_terminal", "provisioning a canceled attempt");
  await expectFailure(() => workspaces.renewExecutionWorkspace({ id: leaseA.id }), "attempt_terminal", "renewing the lease of a canceled attempt");

  const released = await workspaces.releaseExecutionWorkspace({ id: leaseA.id });
  assert(released.released && released.worktree === "removed" && released.workspace.status === "released" && released.workspace.retained === false, `releasing a clean worktree must remove it, got ${JSON.stringify(released)}`);
  assert(!existsSync(leaseA.worktree_path), "a removed worktree's directory must be gone");
  assert(git(repo.dir, "rev-parse", "--verify", leaseA.branch) === repo.sha, "release must keep the branch, which may hold the agent's commits");
  const releasedAgain = await workspaces.releaseExecutionWorkspace({ id: leaseA.id });
  assert(releasedAgain.released === false && releasedAgain.worktree === "already_released", "releasing twice must be a no-op");

  writeFileSync(join(leaseB.worktree_path, "agent-work.txt"), "uncommitted agent work\n");
  const retained = await workspaces.releaseExecutionWorkspace({ id: leaseB.id });
  assert(retained.worktree === "retained_dirty" && retained.workspace.retained === true && retained.workspace.status === "released", `a dirty worktree must be retained, got ${JSON.stringify(retained)}`);
  assert(readFileSync(join(leaseB.worktree_path, "agent-work.txt"), "utf8") === "uncommitted agent work\n", "release must never discard uncommitted work");
  assert(git(repo.dir, "status", "--porcelain") === operatorStatus, "release must leave the operator's checkout untouched");
}

// --- a restarted process, and concurrent provisioning, through the CLI --------------------------------

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
  const reread = await runHub("get_execution_workspace", { id: leaseC.id });
  assert(reread.status === 0 && JSON.parse(reread.stdout).workspace.status === "active", `a fresh process must see the active lease:\n${reread.stderr}`);
  const repeated = await runHub("provision_execution_workspace", { attempt_id: attemptC.id, repository_path: repo.dir });
  assert(repeated.status === 0 && JSON.parse(repeated.stdout).created === false, `provisioning from a fresh process must be idempotent:\n${repeated.stderr}`);

  const agentRace = await claimedIssue("session-workspace-race");
  const raceAttempt = (await attempts.createExecutionAttempt(attemptInput(agentRace))).attempt;
  const racers = await Promise.all([0, 1, 2, 3].map(() => runHub("provision_execution_workspace", { attempt_id: raceAttempt.id, repository_path: repo.dir })));
  const creators = racers.filter((result) => result.status === 0 && JSON.parse(result.stdout).created === true);
  assert(creators.length === 1, `exactly one of four processes may create the workspace, ${creators.length} did:\n${racers.map((result) => result.stderr).join("\n")}`);
  assert(racers.every((result) => result.status === 0 || result.stderr.includes("lease_conflict")), `losing provisioners must fail with lease_conflict:\n${racers.map((result) => result.stderr).join("\n")}`);
  const raceLeases = await workspaces.listExecutionWorkspaces({ attempt_id: raceAttempt.id, include_released: true });
  assert(raceLeases.length === 1 && raceLeases[0].status === "active", `a provisioning race must leave exactly one active lease, got ${JSON.stringify(raceLeases)}`);
  assert(git(raceLeases[0].worktree_path, "rev-parse", "HEAD") === repo.sha, "the raced worktree must be intact at the base");
}

// --- MCP ------------------------------------------------------------------------------------------------

{
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_execution_workspaces", arguments: { attempt_id: attemptC.id } } }),
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "provision_execution_workspace", arguments: { attempt_id: startedA.attempt.id, repository_path: repo.dir } } }),
    "",
  ].join("\n");
  const result = spawnSync(process.execPath, ["server/mcp-server.ts"], { cwd: process.cwd(), env: process.env, input, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert(result.status === 0, `MCP server failed:\n${result.stderr}`);
  const messages = String(result.stdout).split(/\r?\n/).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
  const byId = (id) => messages.find((message) => message.id === id);
  const tools = byId(2)?.result?.tools ?? [];
  for (const name of ["plan_execution_workspace", "provision_execution_workspace", "get_execution_workspace", "list_execution_workspaces", "renew_execution_workspace", "release_execution_workspace"]) {
    assert(tools.some((tool) => tool.name === name), `MCP does not describe ${name}`);
  }
  const createSchema = tools.find((tool) => tool.name === "create_execution_attempt")?.inputSchema;
  assert(createSchema?.properties?.repository_path?.type === "string", "MCP create_execution_attempt must accept repository_path");
  assert(JSON.parse(byId(3)?.result?.content?.[0]?.text ?? "{}").workspaces?.[0]?.id === leaseC.id, `MCP list_execution_workspaces failed: ${JSON.stringify(byId(3))}`);
  assert(byId(4)?.error?.message?.startsWith("attempt_terminal:"), `MCP must surface typed workspace failures, got ${JSON.stringify(byId(4))}`);
}

// --- HTTP ------------------------------------------------------------------------------------------------

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
    for (let tries = 0; ; tries += 1) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {
        // not listening yet
      }
      if (tries >= 100) throw new Error(`API did not start\n${diagnostics}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const agentHttp = await claimedIssue("session-workspace-http");
    let result = await call(`/issues/${agentHttp.issue.identifier}/execution-attempts`, {
      method: "POST",
      body: JSON.stringify({ ...attemptInput(agentHttp), issue_id: undefined, repository_path: repo.dir }),
    });
    assert(result.status === 201 && result.body.workspace?.status === "active", `HTTP start with repository_path must create the workspace: ${result.status} ${JSON.stringify(result.body)}`);
    const httpLease = result.body.workspace;
    result = await call(`/execution-workspaces?attempt_id=${encodeURIComponent(result.body.attempt.id)}`);
    assert(result.status === 200 && result.body.workspaces.length === 1 && result.body.workspaces[0].id === httpLease.id, `HTTP list failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/execution-workspaces/${httpLease.id}/renew`, { method: "POST", body: JSON.stringify({ ttl_minutes: 60 }) });
    assert(result.status === 200 && result.body.workspace.id === httpLease.id, `HTTP renew failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/execution-attempts/${startedA.attempt.id}/workspace`, { method: "POST", body: JSON.stringify({ repository_path: repo.dir }) });
    assert(result.status === 409 && result.body.code === "attempt_terminal", `HTTP provisioning a canceled attempt must be 409 attempt_terminal: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call("/execution-workspaces/lease_missing");
    assert(result.status === 404 && result.body.code === "lease_not_found", `HTTP missing lease must be 404: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/execution-workspaces/${httpLease.id}/release`, { method: "POST", body: "{}" });
    assert(result.status === 200 && result.body.worktree === "removed" && !existsSync(httpLease.worktree_path), `HTTP release failed: ${result.status} ${JSON.stringify(result.body)}`);
  } finally {
    await stopProcessTree(api);
  }
}

console.log("Execution workspace regression passed");
