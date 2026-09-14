// Leased Git branch and worktree provisioning for execution attempts.
//
// A lease binds one execution attempt to an isolated branch and linked worktree
// rooted at the attempt's pinned base commit. The operator's own checkout is only
// ever read: provisioning runs `git worktree add`, which creates a new directory
// and branch and leaves the existing working tree, index, and HEAD untouched,
// dirty or not.
//
// Ordering is what makes partial failure recoverable. The lease row is written
// before any Git side effect (status provisioning, step recorded), the worktree is
// created, and only then does the lease become active. A crash between those
// steps leaves a lease that names exactly what it may have created, so
// provisioning the same attempt again finishes the job or reports the
// inconsistency instead of guessing. Branch and worktree names derive from the
// attempt id, so they cannot collide across attempts; a pre-existing branch or
// path with that name and no lease behind it belongs to someone else and is never
// touched.
//
// Git runs without a shell, with repository hooks and fsmonitor disabled, and
// with an environment stripped of variables that would point it at another
// repository. Cleanup never removes a dirty worktree, only forces removal of a
// worktree the same request just created, and never deletes a branch that moved
// past its base: branches outlive leases because they hold the agent's commits.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { customAlphabet } from "nanoid";
import { adapter, nowIso, resolveDbPath } from "./db.js";
import { liveWorkspaceLeaseStatusesSql } from "./execution-attempts-schema.js";
import { createExecutionAttempt, getExecutionAttempt, type CreateExecutionAttemptInput } from "./execution-attempts.js";
import { initialExecutionState, isExecutionState, isTerminalExecutionState } from "./execution-contract.js";
import { faultPoint } from "./fault-injection.js";

const execFileAsync = promisify(execFile);
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export const executionWorkspaceErrorCodes = [
  "invalid_input",
  "attempt_not_found",
  "attempt_not_provisioning",
  "attempt_terminal",
  "repository_invalid",
  "repository_mismatch",
  "repository_is_workspace",
  "workspace_root_inside_repository",
  "unsafe_path",
  "base_missing",
  "base_drift",
  "branch_exists",
  "worktree_path_exists",
  "lease_conflict",
  "lease_not_found",
  "lease_expired",
  "lease_not_active",
  "workspace_inconsistent",
  "git_failed",
] as const;
export type ExecutionWorkspaceErrorCode = (typeof executionWorkspaceErrorCodes)[number];

export class ExecutionWorkspaceError extends Error {
  readonly code: ExecutionWorkspaceErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ExecutionWorkspaceErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "ExecutionWorkspaceError";
    this.code = code;
    this.details = details;
  }
}

export type ProvisionExecutionWorkspaceInput = { attempt_id?: unknown; repository_path?: unknown; ttl_minutes?: unknown };
export type StartExecutionAttemptInput = CreateExecutionAttemptInput & { repository_path?: unknown; ttl_minutes?: unknown };
export type LeaseReferenceInput = { id?: unknown; lease_id?: unknown };
export type ListExecutionWorkspacesInput = {
  attempt_id?: unknown;
  issue_id?: unknown;
  branch?: unknown;
  worktree_path?: unknown;
  include_released?: unknown;
  limit?: unknown;
};
export type WorkspaceReleaseOutcome = "removed" | "retained" | "retained_dirty" | "missing" | "already_released";

type AttemptView = NonNullable<Awaited<ReturnType<typeof getExecutionAttempt>>>;

type LeaseRow = {
  id: string;
  attempt_id: string;
  issue_id: string;
  issue_identifier: string | null;
  session_id: string | null;
  repository: string;
  repository_path: string;
  git_common_dir: string;
  base_sha: string;
  branch: string;
  worktree_path: string;
  status: string;
  step: string;
  expires_at: string;
  renewed_at: string;
  released_at: string | null;
  retained: number | string;
  failure: string | null;
  created_at: string;
  updated_at: string;
};

type RepositoryInfo = { top: string; commonDir: string; originUrl: string | null };
type WorkspaceNames = { branch: string; worktreePath: string };
type GitResult = { ok: boolean; exitCode: number | null; stdout: string; stderr: string };
type WorktreeRecord = { path: string; branch: string | null };

const gitTimeoutMs = 120_000;
const defaultLeaseMinutes = 120;
const maxLeaseMinutes = 24 * 60;
// A provisioning lease younger than this may still have Git running in another
// process. Resuming it would race that process on the same path and branch.
const provisioningGraceMs = gitTimeoutMs + 30_000;

// Variables that would point git at a different repository, index, or object store.
const redirectingGitVariables = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

const leaseSelect = `
  SELECT l.*, i.identifier AS issue_identifier
  FROM execution_workspace_leases l
  JOIN issues i ON i.id = l.issue_id
`;

export function executionWorkspaceRoot() {
  const configured = process.env.CLAW_TASK_HUB_WORKSPACE_ROOT?.trim();
  return resolve(configured ? configured : join(dirname(resolveDbPath()), "workspaces"));
}

/** Create an attempt and, when repository_path is given, provision its workspace. */
export async function startExecutionAttempt(input: StartExecutionAttemptInput) {
  const result = await createExecutionAttempt(input);
  if (input.repository_path === undefined || input.repository_path === null || input.repository_path === "") return result;
  // The attempt is committed before any Git side effect. If provisioning fails,
  // the attempt stays in provisioning and provisioning can be retried on its own.
  try {
    const provisioned = await provisionExecutionWorkspace({
      attempt_id: result.attempt.id,
      repository_path: input.repository_path,
      ttl_minutes: input.ttl_minutes,
    });
    return { ...result, workspace: provisioned.workspace, workspace_created: provisioned.created };
  } catch (error) {
    if (error instanceof ExecutionWorkspaceError) error.details.attempt_id = result.attempt.id;
    throw error;
  }
}

/** Describe the branch and worktree provisioning would use, without side effects. */
export async function planExecutionWorkspace(input: ProvisionExecutionWorkspaceInput) {
  const { attempt, root, repository, names } = await prepareProvisioning(input);
  return {
    attempt_id: attempt.id,
    repository: attempt.repository,
    repository_path: repository.top,
    base_sha: attempt.base_sha,
    branch: names.branch,
    worktree_path: names.worktreePath,
    workspace_root: root,
  };
}

export async function provisionExecutionWorkspace(input: ProvisionExecutionWorkspaceInput) {
  const ttlMinutes = leaseMinutes(input.ttl_minutes);
  const { attempt, root, repository, names } = await prepareProvisioning(input);

  const open = await openLeaseForAttempt(attempt.id);
  if (open) {
    if (!samePath(open.repository_path, repository.top)) {
      throw new ExecutionWorkspaceError(
        "lease_conflict",
        `Attempt ${attempt.id} already leases a workspace from ${open.repository_path}`,
        { lease_id: open.id, repository_path: open.repository_path },
      );
    }
    return { workspace: await resumeLease(open, repository, root, ttlMinutes), created: false };
  }
  if (attempt.state !== initialExecutionState) {
    throw new ExecutionWorkspaceError(
      "attempt_not_provisioning",
      `Attempt ${attempt.id} is ${attempt.state}; a new workspace is provisioned only while the attempt is ${initialExecutionState}`,
      { attempt_id: attempt.id, state: attempt.state },
    );
  }

  await requireGit(repository.top, ["check-ref-format", "--branch", names.branch], "Validating the branch name");
  if (!(await commitExists(repository.top, attempt.base_sha))) throw baseMissing(attempt.base_sha);
  if (await branchHead(repository.top, names.branch)) {
    await refuseIfRacing(attempt.id);
    throw new ExecutionWorkspaceError("branch_exists", `Branch ${names.branch} already exists and no lease owns it; it was left untouched`, { branch: names.branch });
  }
  if (existsSync(names.worktreePath)) {
    await refuseIfRacing(attempt.id);
    throw new ExecutionWorkspaceError("worktree_path_exists", `${names.worktreePath} already exists and no lease owns it; it was left untouched`, { worktree_path: names.worktreePath });
  }
  prepareDirectory(root, dirname(names.worktreePath));

  const lease = await recordLease(attempt, repository, names, ttlMinutes);
  faultPoint("provision:lease_recorded");
  try {
    await addWorktree(repository.top, lease, true);
    faultPoint("provision:worktree_created");
    await verifyWorktree(lease, true);
  } catch (error) {
    const leftovers = await removeFreshProvisioning(repository.top, lease);
    await markLeaseFailed(lease.id, error, leftovers);
    throw asWorkspaceError(error, { lease_id: lease.id });
  }
  return { workspace: await activateLease(lease.id, ttlMinutes), created: true };
}

export async function getExecutionWorkspace(id: string) {
  const row = await adapter.get<LeaseRow>(`${leaseSelect} WHERE l.id = @id`, { id });
  return row ? hydrateLease(row) : null;
}

export async function listExecutionWorkspaces(input: ListExecutionWorkspacesInput = {}) {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: boundedLimit(input.limit) };
  const attemptId = optionalText(input.attempt_id, "attempt_id", 200);
  if (attemptId) {
    where.push("l.attempt_id = @attempt_id");
    params.attempt_id = attemptId;
  }
  const issue = optionalText(input.issue_id, "issue_id", 200);
  if (issue) {
    where.push("(l.issue_id = @issue OR i.identifier = @issue OR i.external_id = @issue)");
    params.issue = issue;
  }
  const branch = optionalText(input.branch, "branch", 250);
  if (branch) {
    where.push("l.branch = @branch");
    params.branch = branch;
  }
  const worktreePath = optionalText(input.worktree_path, "worktree_path", 4096);
  if (worktreePath) {
    where.push(process.platform === "win32" ? "lower(l.worktree_path) = lower(@worktree_path)" : "l.worktree_path = @worktree_path");
    params.worktree_path = canonicalPath(worktreePath);
  }
  if (!booleanInput(input.include_released, false)) where.push("l.status <> 'released'");
  const rows = await adapter.all<LeaseRow>(`
    ${leaseSelect}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT @limit
  `, params);
  return rows.map(hydrateLease);
}

export async function renewExecutionWorkspace(input: LeaseReferenceInput & { ttl_minutes?: unknown }) {
  const id = leaseIdInput(input);
  const ttlMinutes = leaseMinutes(input.ttl_minutes);
  const lease = await requireLeaseRow(id);
  if (lease.status !== "active") {
    throw new ExecutionWorkspaceError("lease_not_active", `Lease ${id} is ${lease.status}; only an active lease can be renewed`, { lease_id: id, status: lease.status });
  }
  const attempt = await getExecutionAttempt(lease.attempt_id);
  if (!attempt || (isExecutionState(attempt.state) && isTerminalExecutionState(attempt.state))) {
    throw new ExecutionWorkspaceError("attempt_terminal", `Attempt ${lease.attempt_id} is ${attempt?.state ?? "gone"}; its lease cannot be renewed`, { lease_id: id, attempt_id: lease.attempt_id });
  }
  const at = nowIso();
  const renewed = await adapter.run(`
    UPDATE execution_workspace_leases
    SET renewed_at = @at, expires_at = @expires_at, updated_at = @at
    WHERE id = @id AND status = 'active' AND expires_at > @at
  `, { id, at, expires_at: addMinutes(at, ttlMinutes) });
  if (renewed.changes !== 1) {
    throw new ExecutionWorkspaceError(
      "lease_expired",
      `Lease ${id} expired at ${lease.expires_at}; provision the attempt again to verify and reclaim its workspace`,
      { lease_id: id, expires_at: lease.expires_at },
    );
  }
  return await requireLeaseView(id);
}

export async function releaseExecutionWorkspace(input: LeaseReferenceInput & { keep_worktree?: unknown }) {
  const id = leaseIdInput(input);
  const keepWorktree = booleanInput(input.keep_worktree, false);
  const lease = await requireLeaseRow(id);
  if (lease.status === "released") {
    return { workspace: hydrateLease(lease), released: false, worktree: "already_released" as WorkspaceReleaseOutcome };
  }
  if (lease.status === "provisioning" && isRecent(lease.updated_at)) {
    throw new ExecutionWorkspaceError("lease_conflict", `Lease ${id} is being provisioned by another request; release it after that finishes`, { lease_id: id });
  }
  const worktree = await retireWorktree(lease, keepWorktree);
  const at = nowIso();
  const updated = await adapter.run(`
    UPDATE execution_workspace_leases
    SET status = 'released', released_at = @at, retained = @retained, updated_at = @at
    WHERE id = @id AND status <> 'released'
  `, { id, at, retained: worktree === "retained" || worktree === "retained_dirty" ? 1 : 0 });
  return { workspace: await requireLeaseView(id), released: updated.changes === 1, worktree };
}

async function prepareProvisioning(input: ProvisionExecutionWorkspaceInput) {
  const attemptId = requiredText(input.attempt_id, "attempt_id", 200);
  const repositoryPath = requiredText(input.repository_path, "repository_path", 4096);
  const attempt = await getExecutionAttempt(attemptId);
  if (!attempt) throw new ExecutionWorkspaceError("attempt_not_found", `Execution attempt not found: ${attemptId}`, { attempt_id: attemptId });
  if (isExecutionState(attempt.state) && isTerminalExecutionState(attempt.state)) {
    throw new ExecutionWorkspaceError("attempt_terminal", `Attempt ${attempt.id} is ${attempt.state}; a terminal attempt holds no workspace`, { attempt_id: attempt.id, state: attempt.state });
  }
  // Nothing is created until the repository has been validated against the root:
  // a root inside the operator's checkout must be refused before it is made.
  const root = canonicalPath(executionWorkspaceRoot());
  const repository = await inspectRepository(repositoryPath, attempt.repository, root);
  return { attempt, root, repository, names: workspaceNames(attempt, repository, root) };
}

async function inspectRepository(repositoryPath: string, expectedIdentity: string, root: string): Promise<RepositoryInfo> {
  if (!isAbsolute(repositoryPath)) throw invalid("repository_path must be an absolute path", { field: "repository_path" });
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync.native(repositoryPath);
  } catch {
    throw new ExecutionWorkspaceError("repository_invalid", `repository_path does not exist: ${repositoryPath}`, { repository_path: repositoryPath });
  }
  const topLevel = await runGit(resolvedPath, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok || !topLevel.stdout) {
    throw new ExecutionWorkspaceError("repository_invalid", `${repositoryPath} is not a Git working tree`, { repository_path: repositoryPath });
  }
  const top = realpathSync.native(resolve(topLevel.stdout));
  if (!samePath(top, resolvedPath)) {
    throw new ExecutionWorkspaceError("repository_invalid", `repository_path must be the top level of its working tree, ${top}`, { repository_path: repositoryPath, top });
  }
  if (samePath(top, root) || isInside(top, root)) {
    throw new ExecutionWorkspaceError("repository_is_workspace", `${top} is inside the workspace root; provision from the operator's repository, not a leased worktree`, { repository_path: top, workspace_root: root });
  }
  if (isInside(root, top)) {
    throw new ExecutionWorkspaceError(
      "workspace_root_inside_repository",
      `The workspace root ${root} is inside ${top}; worktrees there would change the operator's checkout. Set CLAW_TASK_HUB_WORKSPACE_ROOT outside the repository`,
      { repository_path: top, workspace_root: root },
    );
  }
  const commonDir = realpathSync.native(resolve(
    await requireGit(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "Resolving the Git common directory"),
  ));
  const origin = await runGit(top, ["config", "--get", "remote.origin.url"]);
  const originUrl = origin.ok && origin.stdout ? stripUrlCredentials(origin.stdout) : null;
  const repository = { top, commonDir, originUrl };
  if (!identityMatches(repository, expectedIdentity)) {
    throw new ExecutionWorkspaceError(
      "repository_mismatch",
      `${top} is not the attempt's repository ${expectedIdentity}${originUrl ? `; its origin is ${originUrl}` : ""}`,
      { repository_path: top, repository: expectedIdentity, origin: originUrl },
    );
  }
  return repository;
}

function identityMatches(repository: RepositoryInfo, expected: string) {
  const normalize = (value: string) => stripUrlCredentials(value.trim()).replace(/\/+$/, "").replace(/\.git$/, "");
  if (repository.originUrl && normalize(repository.originUrl) === normalize(expected)) return true;
  if (!isAbsolute(expected) || !existsSync(expected)) return false;
  try {
    return samePath(realpathSync.native(expected), repository.top);
  } catch {
    return false;
  }
}

function workspaceNames(attempt: AttemptView, repository: RepositoryInfo, root: string): WorkspaceNames {
  const issue = slug(attempt.issue_identifier ?? attempt.issue_id);
  const repositoryKey = createHash("sha256").update(pathKey(repository.commonDir)).digest("hex").slice(0, 10);
  return {
    branch: `cth/${issue}/${attempt.id}`,
    worktreePath: join(root, `${slug(basename(repository.top))}-${repositoryKey}`, `${issue}-${attempt.id}`),
  };
}

async function resumeLease(lease: LeaseRow, repository: RepositoryInfo, root: string, ttlMinutes: number) {
  if (lease.status === "provisioning" && isRecent(lease.updated_at)) {
    throw new ExecutionWorkspaceError("lease_conflict", `Lease ${lease.id} is being provisioned by another request; retry after it finishes`, { lease_id: lease.id });
  }
  // Take the lease with a compare-and-set on updated_at, so two resuming
  // requests never drive Git on the same path and branch at once.
  let claimed: { changes: number };
  try {
    claimed = await adapter.run(`
      UPDATE execution_workspace_leases
      SET status = 'provisioning', updated_at = @at
      WHERE id = @id AND status = @status AND updated_at = @updated_at
    `, { id: lease.id, status: lease.status, updated_at: lease.updated_at, at: nowIso() });
  } catch (error) {
    if (isLeaseUniqueViolation(error)) throw leaseConflict(lease.attempt_id);
    throw error;
  }
  if (claimed.changes !== 1) {
    throw new ExecutionWorkspaceError("lease_conflict", `Lease ${lease.id} changed while this request was resuming it; retry`, { lease_id: lease.id });
  }
  try {
    await reconcileWorktree(lease, repository, root);
    await verifyWorktree(lease, false);
  } catch (error) {
    await markLeaseFailed(lease.id, error, []);
    throw asWorkspaceError(error, { lease_id: lease.id });
  }
  return await activateLease(lease.id, ttlMinutes);
}

async function reconcileWorktree(lease: LeaseRow, repository: RepositoryInfo, root: string) {
  let registered = (await listWorktrees(repository.top)).find((entry) => samePath(entry.path, lease.worktree_path));
  if (registered && !existsSync(lease.worktree_path)) {
    // The directory is gone but Git still records it. Prune drops only records
    // whose directories no longer exist, and skips locked ones, so the lease's
    // record is unlocked first; no worktree that is present can be affected.
    await runGit(repository.top, ["worktree", "unlock", lease.worktree_path]);
    await requireGit(repository.top, ["worktree", "prune"], "Pruning the missing worktree record");
    registered = undefined;
  }
  if (registered) {
    if (registered.branch !== `refs/heads/${lease.branch}`) {
      throw inconsistent(`${lease.worktree_path} is checked out on ${registered.branch ?? "a detached HEAD"}, not ${lease.branch}`, lease);
    }
  } else {
    if (existsSync(lease.worktree_path)) throw inconsistent(`${lease.worktree_path} exists but is not a registered worktree; it was left untouched`, lease);
    prepareDirectory(root, dirname(lease.worktree_path));
    if (await branchHead(repository.top, lease.branch)) {
      await assertBaseContained(repository.top, lease);
      await addWorktree(repository.top, lease, false);
    } else {
      if (!(await commitExists(repository.top, lease.base_sha))) throw baseMissing(lease.base_sha);
      await addWorktree(repository.top, lease, true);
    }
  }
  await assertBaseContained(repository.top, lease);
}

async function assertBaseContained(top: string, lease: LeaseRow) {
  const result = await runGit(top, ["merge-base", "--is-ancestor", lease.base_sha, `refs/heads/${lease.branch}`]);
  if (result.ok) return;
  if (result.exitCode === 1) {
    throw new ExecutionWorkspaceError("base_drift", `Branch ${lease.branch} no longer contains its base ${lease.base_sha}`, { lease_id: lease.id, branch: lease.branch, base_sha: lease.base_sha });
  }
  throw new ExecutionWorkspaceError("git_failed", `Checking ${lease.branch} against its base failed: ${boundedText(result.stderr)}`, { lease_id: lease.id });
}

async function addWorktree(top: string, lease: LeaseRow, createBranch: boolean) {
  const args = ["worktree", "add", "--lock", "--reason", `claw-task-hub lease ${lease.id}`];
  args.push(...(createBranch ? ["-b", lease.branch, lease.worktree_path, lease.base_sha] : [lease.worktree_path, lease.branch]));
  await requireGit(top, args, "Creating the leased worktree");
}

async function verifyWorktree(lease: LeaseRow, fresh: boolean) {
  const branch = await requireGit(lease.worktree_path, ["symbolic-ref", "--short", "HEAD"], "Reading the worktree branch");
  if (branch !== lease.branch) throw inconsistent(`${lease.worktree_path} is on ${branch}, not ${lease.branch}`, lease);
  if (!fresh) return;
  const head = await requireGit(lease.worktree_path, ["rev-parse", "HEAD"], "Reading the worktree HEAD");
  if (head !== lease.base_sha) throw inconsistent(`${lease.worktree_path} started at ${head}, not the pinned base ${lease.base_sha}`, lease);
}

// Undo only what this request created. The path and branch were checked to be
// absent before the lease was recorded, so a worktree registered at the path is
// this request's own and may be force-removed; the branch is deleted with an
// expected old value, so it goes only if it still points at the base.
async function removeFreshProvisioning(top: string, lease: LeaseRow) {
  const leftovers: string[] = [];
  try {
    const registered = (await listWorktrees(top)).find((entry) => samePath(entry.path, lease.worktree_path));
    if (registered) {
      await runGit(top, ["worktree", "unlock", lease.worktree_path]);
      if (!(await runGit(top, ["worktree", "remove", "--force", lease.worktree_path])).ok) leftovers.push(`worktree ${lease.worktree_path}`);
    } else if (existsSync(lease.worktree_path)) {
      leftovers.push(`directory ${lease.worktree_path}`);
    }
    const head = await branchHead(top, lease.branch);
    if (head === lease.base_sha) {
      if (!(await runGit(top, ["update-ref", "-d", `refs/heads/${lease.branch}`, lease.base_sha])).ok) leftovers.push(`branch ${lease.branch}`);
    } else if (head) {
      leftovers.push(`branch ${lease.branch}`);
    }
  } catch (error) {
    leftovers.push(`cleanup failed: ${errorMessage(error)}`);
  }
  return leftovers;
}

async function retireWorktree(lease: LeaseRow, keepWorktree: boolean): Promise<WorkspaceReleaseOutcome> {
  if (!existsSync(lease.worktree_path) || !existsSync(lease.repository_path)) return "missing";
  const registered = (await listWorktrees(lease.repository_path)).find((entry) => samePath(entry.path, lease.worktree_path));
  // A path that is no longer this lease's registered worktree is not ours to remove.
  if (!registered || registered.branch !== `refs/heads/${lease.branch}`) return "retained";
  const status = await requireGit(lease.worktree_path, ["status", "--porcelain", "--untracked-files=all"], "Checking the worktree for uncommitted work");
  if (status) return "retained_dirty";
  if (keepWorktree) return "retained";
  await runGit(lease.repository_path, ["worktree", "unlock", lease.worktree_path]);
  // No --force: Git itself refuses a worktree that became dirty after the check.
  if ((await runGit(lease.repository_path, ["worktree", "remove", lease.worktree_path])).ok) return "removed";
  await runGit(lease.repository_path, ["worktree", "lock", "--reason", `claw-task-hub lease ${lease.id}`, lease.worktree_path]);
  return "retained_dirty";
}

async function recordLease(attempt: AttemptView, repository: RepositoryInfo, names: WorkspaceNames, ttlMinutes: number) {
  const at = nowIso();
  const id = `lease_${nanoid()}`;
  try {
    await adapter.run(`
      INSERT INTO execution_workspace_leases (
        id, attempt_id, issue_id, session_id, repository, repository_path, git_common_dir, base_sha, branch, worktree_path,
        status, step, expires_at, renewed_at, retained, created_at, updated_at
      ) VALUES (
        @id, @attempt_id, @issue_id, @session_id, @repository, @repository_path, @git_common_dir, @base_sha, @branch, @worktree_path,
        'provisioning', 'recorded', @expires_at, @at, 0, @at, @at
      )
    `, {
      id,
      attempt_id: attempt.id,
      issue_id: attempt.issue_id,
      session_id: attempt.session_id,
      repository: attempt.repository,
      repository_path: repository.top,
      git_common_dir: repository.commonDir,
      base_sha: attempt.base_sha,
      branch: names.branch,
      worktree_path: names.worktreePath,
      expires_at: addMinutes(at, ttlMinutes),
      at,
    });
  } catch (error) {
    if (isLeaseUniqueViolation(error)) throw leaseConflict(attempt.id);
    throw error;
  }
  return await requireLeaseRow(id);
}

async function activateLease(id: string, ttlMinutes: number) {
  const at = nowIso();
  await adapter.run(`
    UPDATE execution_workspace_leases
    SET status = 'active', step = 'worktree_created', renewed_at = @at, expires_at = @expires_at, failure = NULL, updated_at = @at
    WHERE id = @id
  `, { id, at, expires_at: addMinutes(at, ttlMinutes) });
  return await requireLeaseView(id);
}

async function markLeaseFailed(id: string, error: unknown, leftovers: string[]) {
  const failure = boundedText(`${errorMessage(error)}${leftovers.length ? `; left in place: ${leftovers.join(", ")}` : ""}`);
  await adapter.run(
    "UPDATE execution_workspace_leases SET status = 'failed', failure = @failure, updated_at = @at WHERE id = @id",
    { id, failure, at: nowIso() },
  );
}

async function openLeaseForAttempt(attemptId: string) {
  return await adapter.get<LeaseRow>(`
    ${leaseSelect}
    WHERE l.attempt_id = @attempt_id AND l.status IN (${liveWorkspaceLeaseStatusesSql}, 'failed')
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT 1
  `, { attempt_id: attemptId });
}

// A collision can be another request for the same attempt that got further:
// that is a conflict to retry, not a foreign branch or directory.
async function refuseIfRacing(attemptId: string) {
  if (await openLeaseForAttempt(attemptId)) throw leaseConflict(attemptId);
}

async function requireLeaseRow(id: string) {
  const row = await adapter.get<LeaseRow>(`${leaseSelect} WHERE l.id = @id`, { id });
  if (!row) throw new ExecutionWorkspaceError("lease_not_found", `Workspace lease not found: ${id}`, { lease_id: id });
  return row;
}

async function requireLeaseView(id: string) {
  return hydrateLease(await requireLeaseRow(id));
}

function hydrateLease(row: LeaseRow) {
  const now = nowIso();
  return {
    id: row.id,
    attempt_id: row.attempt_id,
    issue_id: row.issue_id,
    issue_identifier: row.issue_identifier,
    session_id: row.session_id,
    repository: row.repository,
    repository_path: row.repository_path,
    base_sha: row.base_sha,
    branch: row.branch,
    worktree_path: row.worktree_path,
    status: row.status,
    step: row.step,
    live: row.status === "provisioning" || row.status === "active",
    expired: row.status === "active" && row.expires_at <= now,
    expires_at: row.expires_at,
    renewed_at: row.renewed_at,
    released_at: row.released_at,
    retained: Number(row.retained) === 1,
    failure: row.failure,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listWorktrees(top: string): Promise<WorktreeRecord[]> {
  const output = await requireGit(top, ["worktree", "list", "--porcelain"], "Listing worktrees");
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: resolve(line.slice("worktree ".length)), branch: null };
      records.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  return records;
}

async function branchHead(top: string, branch: string) {
  const result = await runGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  return result.ok && result.stdout ? result.stdout : null;
}

async function commitExists(top: string, sha: string) {
  return (await runGit(top, ["cat-file", "-e", `${sha}^{commit}`])).ok;
}

async function requireGit(cwd: string, args: string[], description: string) {
  const result = await runGit(cwd, args);
  if (!result.ok) {
    throw new ExecutionWorkspaceError("git_failed", `${description} failed: ${boundedText(result.stderr || result.stdout || "no output")}`, { command: args.slice(0, 2).join(" ") });
  }
  return result.stdout;
}

// Shared by every control-plane Git caller. `env` adds variables after the
// redirecting ones are stripped, for callers that deliberately use an alternate
// index; `trim: false` keeps NUL-delimited output byte-exact.
export async function runGit(cwd: string, args: string[], options: { env?: Record<string, string>; trim?: boolean } = {}): Promise<GitResult> {
  const trim = options.trim ?? true;
  try {
    const { stdout, stderr } = await execFileAsync("git", [...gitSafetyArgs(), ...args], {
      cwd,
      env: gitEnvironment(options.env),
      timeout: gitTimeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
    });
    return { ok: true, exitCode: 0, stdout: trim ? stdout.trim() : stdout, stderr: stderr.trim() };
  } catch (error) {
    const failure = (error ?? {}) as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    if (failure.code === "ENOENT") {
      if (!existsSync(cwd)) throw new ExecutionWorkspaceError("repository_invalid", `${cwd} does not exist`, { path: cwd });
      throw new ExecutionWorkspaceError("git_failed", "git is not installed or not on PATH", {});
    }
    const stdout = String(failure.stdout ?? "");
    return {
      ok: false,
      exitCode: typeof failure.code === "number" ? failure.code : null,
      stdout: trim ? stdout.trim() : stdout,
      stderr: String(failure.stderr || failure.message || "").trim(),
    };
  }
}

// Leading arguments for every control-plane Git process: repository hooks and
// fsmonitor never run.
export function gitSafetyArgs() {
  return ["-c", `core.hooksPath=${noHooksDirectory()}`, "-c", "core.fsmonitor=false"];
}

// An empty directory the hub owns, handed to Git as core.hooksPath so no
// repository hook -- post-checkout in particular -- runs during provisioning.
function noHooksDirectory() {
  const directory = join(dirname(resolveDbPath()), ".claw-task-hub-no-hooks");
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function gitEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  for (const name of redirectingGitVariables) delete env[name];
  return { ...env, ...extra };
}

// Worktree directories are created only inside the workspace root, and a parent
// that resolves elsewhere through a symlink or junction is refused.
function prepareDirectory(root: string, directory: string) {
  if (!isInside(directory, root)) {
    throw new ExecutionWorkspaceError("unsafe_path", `${directory} is outside the workspace root ${root}`, { path: directory, workspace_root: root });
  }
  mkdirSync(directory, { recursive: true });
  const real = realpathSync.native(directory);
  if (!samePath(real, directory) || !isInside(real, realpathSync.native(root))) {
    throw new ExecutionWorkspaceError("unsafe_path", `${directory} resolves to ${real} through a link`, { path: directory, resolved: real });
  }
}

// The real path of the nearest existing ancestor plus the missing remainder, so
// containment checks compare like with like before anything is created.
function canonicalPath(path: string) {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    missing.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync.native(current), ...missing);
}

function pathKey(path: string) {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string) {
  return pathKey(left) === pathKey(right);
}

function isInside(child: string, parent: string) {
  const offset = relative(pathKey(parent), pathKey(child));
  return offset !== "" && !offset.startsWith("..") && !isAbsolute(offset);
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "issue";
}

function stripUrlCredentials(value: string) {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return value.replace(/\/\/[^/@\s]+@/, "//");
  }
}

function isRecent(timestamp: string) {
  return Date.now() - Date.parse(timestamp) < provisioningGraceMs;
}

function leaseConflict(attemptId: string) {
  return new ExecutionWorkspaceError("lease_conflict", `Attempt ${attemptId}, its branch, or its worktree path is already leased by another request`, { attempt_id: attemptId });
}

function inconsistent(message: string, lease: LeaseRow) {
  return new ExecutionWorkspaceError("workspace_inconsistent", message, { lease_id: lease.id, branch: lease.branch, worktree_path: lease.worktree_path });
}

function baseMissing(sha: string) {
  return new ExecutionWorkspaceError("base_missing", `The repository does not contain the pinned base commit ${sha}`, { base_sha: sha });
}

function asWorkspaceError(error: unknown, details: Record<string, unknown>) {
  if (error instanceof ExecutionWorkspaceError) {
    Object.assign(error.details, details);
    return error;
  }
  return new ExecutionWorkspaceError("git_failed", errorMessage(error), details);
}

function isLeaseUniqueViolation(error: unknown) {
  const record = (error ?? {}) as { code?: unknown; constraint_name?: unknown; message?: unknown };
  const message = String(record.message ?? "");
  if (record.code === "23505") return `${String(record.constraint_name ?? "")} ${message}`.includes("idx_workspace_leases_live");
  return message.includes("UNIQUE constraint failed") && message.includes("execution_workspace_leases.");
}

function leaseIdInput(input: LeaseReferenceInput) {
  return requiredText(input.id ?? input.lease_id, "id", 200);
}

function leaseMinutes(value: unknown) {
  if (value === undefined || value === null || value === "") return defaultLeaseMinutes;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) throw invalid("ttl_minutes must be a number", { field: "ttl_minutes" });
  return Math.min(Math.max(Math.trunc(numeric), 1), maxLeaseMinutes);
}

function addMinutes(iso: string, minutes: number) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function booleanInput(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }
  return fallback;
}

function boundedLimit(value: unknown) {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : 50;
  if (!Number.isFinite(numeric)) return 50;
  return Math.min(Math.max(Math.trunc(numeric), 1), 250);
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${field} must be a non-empty string`, { field });
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw invalid(`${field} must be at most ${maxLength} characters`, { field });
  return trimmed;
}

function optionalText(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, field, maxLength);
}

function invalid(message: string, details: Record<string, unknown> = {}) {
  return new ExecutionWorkspaceError("invalid_input", message, details);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(value: string, maxLength = 2000) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
