// Acceptance: the path from a reviewable attempt to an accepted one, and review
// rejection.
//
// Verification passing never accepts an attempt. Acceptance runs only under an
// operator's acceptance policy for the repository, and every step that changes
// something is explicit in that policy:
//
//   commit      always: the leased worktree is committed on the attempt's branch,
//               and only when its tree is exactly the tree verification passed on
//   merge       optional: the commit is merged into a local branch by writing the
//               merge with `git merge-tree` and moving the branch with a
//               compare-and-set, so no checkout is touched; a branch that is
//               checked out anywhere is refused
//   push        optional and remote: requires allow_push
//   pull request optional and remote: requires allow_pull_request and a push, and
//               merging it through the provider requires allow_provider_merge
//
// Each run is a write-ahead record that names the step it reached, so a run that
// is interrupted resumes with the same idempotency key instead of repeating a
// commit, push, or pull request; every step is also safe to repeat on its own.
// A failure before the accept transition marks the run failed and leaves the
// attempt reviewable. A merge conflict rejects the attempt with merge_conflict.
// After the transition, the run settles the issue -- an acceptance comment, the
// claim released as completed, the issue Done -- and releases the workspace,
// keeping the branch. Credential values never enter the record: Git and provider
// output is scrubbed before anything is stored or returned.

import { existsSync } from "node:fs";
import { customAlphabet } from "nanoid";
import { adapter, json, nowIso, parseJson } from "./db.js";
import { declaredSecretValues } from "./execution-adapters.js";
import { executionAcceptanceSteps } from "./execution-attempts-schema.js";
import { getExecutionAttempt, transitionExecutionAttempt } from "./execution-attempts.js";
import { blockingConflictsForAttempt, detectExecutionConflicts } from "./execution-conflicts.js";
import { executionProviderIds, getExecutionProvider, providerSecretValues, type PullRequestIdentity, type PullRequestRequest } from "./execution-providers.js";
import { scrub } from "./execution-runs.js";
import { listExecutionWorkspaces, releaseExecutionWorkspace, runGit } from "./execution-workspaces.js";
import { faultPoint } from "./fault-injection.js";
import { releaseIssueClaim, saveComment, updateIssue } from "./store.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export const ACCEPTANCE_POLICY_SCHEMA_VERSION = "acceptance-policy/v1";

export const executionAcceptanceErrorCodes = [
  "invalid_input",
  "attempt_not_found",
  "attempt_not_reviewable",
  "policy_not_found",
  "revision_conflict",
  "acceptance_not_found",
  "acceptance_in_progress",
  "verification_missing",
  "verification_stale",
  "conflict_blocked",
  "workspace_not_ready",
  "nothing_to_commit",
  "merge_target_missing",
  "merge_target_checked_out",
  "merge_target_moved",
  "push_rejected",
  "provider_unavailable",
  "provider_failed",
  "git_failed",
] as const;
export type ExecutionAcceptanceErrorCode = (typeof executionAcceptanceErrorCodes)[number];

export class ExecutionAcceptanceError extends Error {
  readonly code: ExecutionAcceptanceErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ExecutionAcceptanceErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "ExecutionAcceptanceError";
    this.code = code;
    this.details = details;
  }
}

export type AcceptanceSettings = {
  commit_author: { name: string; email: string };
  merge_target: string | null;
  allow_push: boolean;
  push: { remote: string; include_merge_target: boolean } | null;
  allow_pull_request: boolean;
  pull_request: { provider: string; base_branch: string; merge: boolean } | null;
  allow_provider_merge: boolean;
  complete_issue: boolean;
  release_workspace: boolean;
};

type PolicyView = { id: string; repository: string; revision: number; schema_version: string; settings: AcceptanceSettings; created_by: { kind: string; id: string }; note: string | null; created_at: string };
type AttemptView = NonNullable<Awaited<ReturnType<typeof getExecutionAttempt>>>;
type Step = (typeof executionAcceptanceSteps)[number];

type AcceptanceRow = {
  id: string;
  attempt_id: string;
  policy_id: string;
  policy_revision: number | string;
  idempotency_key: string;
  status: "in_progress" | "accepted" | "rejected" | "failed";
  step: Step;
  verdict_id: string | null;
  tree_fingerprint: string | null;
  commit_sha: string | null;
  merge_target: string | null;
  merge_target_previous_sha: string | null;
  merge_sha: string | null;
  pushed_refs: string;
  pull_request: string | null;
  outcome_code: string | null;
  outcome_message: string | null;
  actor_kind: string;
  actor_id: string;
  note: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

const defaultAuthor = { name: "Claw Task Hub", email: "claw-task-hub@localhost" };
const branchPattern = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

// --- policies ---------------------------------------------------------------------------

export async function saveAcceptancePolicy(input: { repository?: unknown; settings?: unknown; actor_kind?: unknown; actor_id?: unknown; note?: unknown }) {
  const repository = repositoryInput(input.repository);
  const settings = settingsInput(input.settings);
  if (requiredText(input.actor_kind, "actor_kind", 40) !== "operator") {
    throw invalid("acceptance policies are operator configuration; actor_kind must be operator", { field: "actor_kind" });
  }
  const actorId = requiredText(input.actor_id, "actor_id", 200);
  const note = optionalText(input.note, "note", 2000);
  try {
    const id = await adapter.transaction(async () => {
      const last = await adapter.get<{ revision: number | string | null }>("SELECT MAX(revision) AS revision FROM execution_acceptance_policies WHERE repository = @repository", { repository });
      const row = {
        id: `acceptance_policy_${nanoid()}`,
        repository,
        revision: Number(last?.revision ?? 0) + 1,
        schema_version: ACCEPTANCE_POLICY_SCHEMA_VERSION,
        settings: json(settings),
        created_by_kind: "operator",
        created_by_id: actorId,
        note,
        created_at: nowIso(),
      };
      await adapter.run(`
        INSERT INTO execution_acceptance_policies (id, repository, revision, schema_version, settings, created_by_kind, created_by_id, note, created_at)
        VALUES (@id, @repository, @revision, @schema_version, @settings, @created_by_kind, @created_by_id, @note, @created_at)
      `, row);
      return row.id;
    });
    return { policy: await requirePolicyById(id) };
  } catch (error) {
    if (isUniqueViolation(error, ["revision"])) throw new ExecutionAcceptanceError("revision_conflict", "Another acceptance policy revision was saved at the same time; retry", { repository });
    throw error;
  }
}

export async function getAcceptancePolicy(input: { repository?: unknown; revision?: unknown }) {
  const repository = repositoryInput(input.repository);
  const revision = input.revision === undefined || input.revision === null || input.revision === "" ? null : integerInput(input.revision, "revision");
  const row = revision === null
    ? await adapter.get<Record<string, unknown>>("SELECT * FROM execution_acceptance_policies WHERE repository = @repository ORDER BY revision DESC LIMIT 1", { repository })
    : await adapter.get<Record<string, unknown>>("SELECT * FROM execution_acceptance_policies WHERE repository = @repository AND revision = @revision", { repository, revision });
  return { policy: row ? hydratePolicy(row) : null };
}

function hydratePolicy(row: Record<string, unknown>): PolicyView {
  return {
    id: String(row.id),
    repository: String(row.repository),
    revision: Number(row.revision),
    schema_version: String(row.schema_version),
    settings: parseJson<AcceptanceSettings>(row.settings as string, settingsInput({})),
    created_by: { kind: String(row.created_by_kind), id: String(row.created_by_id) },
    note: (row.note as string | null) ?? null,
    created_at: String(row.created_at),
  };
}

async function requirePolicyById(id: string) {
  const row = await adapter.get<Record<string, unknown>>("SELECT * FROM execution_acceptance_policies WHERE id = @id", { id });
  if (!row) throw new ExecutionAcceptanceError("policy_not_found", `Acceptance policy not found: ${id}`, { policy_id: id });
  return hydratePolicy(row);
}

function settingsInput(value: unknown): AcceptanceSettings {
  const input = objectInput(value, "settings") ?? {};
  const known = ["commit_author", "merge_target", "allow_push", "push", "allow_pull_request", "pull_request", "allow_provider_merge", "complete_issue", "release_workspace"];
  for (const key of Object.keys(input)) if (!known.includes(key)) throw invalid(`settings.${key} is not an acceptance setting`, { field: `settings.${key}` });

  const author = objectInput(input.commit_author, "settings.commit_author");
  const commitAuthor = author
    ? { name: authorText(author.name, "settings.commit_author.name"), email: authorEmail(author.email) }
    : { ...defaultAuthor };
  const mergeTarget = input.merge_target === undefined || input.merge_target === null ? null : branchInput(input.merge_target, "settings.merge_target");
  const allowPush = booleanInput(input.allow_push, "settings.allow_push", false);
  const pushInput = objectInput(input.push, "settings.push");
  const push = pushInput ? { remote: remoteInput(pushInput.remote), include_merge_target: booleanInput(pushInput.include_merge_target, "settings.push.include_merge_target", false) } : null;
  if (push && !allowPush) throw invalid("settings.push is a remote mutation and requires settings.allow_push: true", { field: "settings.allow_push" });
  if (push?.include_merge_target && !mergeTarget) throw invalid("settings.push.include_merge_target requires settings.merge_target", { field: "settings.push.include_merge_target" });
  const allowPullRequest = booleanInput(input.allow_pull_request, "settings.allow_pull_request", false);
  const allowProviderMerge = booleanInput(input.allow_provider_merge, "settings.allow_provider_merge", false);
  const pullInput = objectInput(input.pull_request, "settings.pull_request");
  let pullRequest: AcceptanceSettings["pull_request"] = null;
  if (pullInput) {
    const provider = requiredText(pullInput.provider, "settings.pull_request.provider", 60);
    if (!executionProviderIds.includes(provider)) throw invalid(`settings.pull_request.provider must be one of ${executionProviderIds.join(", ")}`, { field: "settings.pull_request.provider" });
    pullRequest = { provider, base_branch: branchInput(pullInput.base_branch, "settings.pull_request.base_branch"), merge: booleanInput(pullInput.merge, "settings.pull_request.merge", false) };
    if (!allowPullRequest) throw invalid("settings.pull_request is a remote mutation and requires settings.allow_pull_request: true", { field: "settings.allow_pull_request" });
    if (!push) throw invalid("settings.pull_request needs settings.push so the attempt branch exists remotely", { field: "settings.push" });
    if (mergeTarget) throw invalid("settings.merge_target and settings.pull_request are alternative ways to integrate; choose one", { field: "settings.merge_target" });
    if (pullRequest.merge && !allowProviderMerge) throw invalid("settings.pull_request.merge requires settings.allow_provider_merge: true", { field: "settings.allow_provider_merge" });
  }
  return {
    commit_author: commitAuthor,
    merge_target: mergeTarget,
    allow_push: allowPush,
    push,
    allow_pull_request: allowPullRequest,
    pull_request: pullRequest,
    allow_provider_merge: allowProviderMerge,
    complete_issue: booleanInput(input.complete_issue, "settings.complete_issue", true),
    release_workspace: booleanInput(input.release_workspace, "settings.release_workspace", true),
  };
}

// --- accept -------------------------------------------------------------------------------

export async function acceptExecutionAttempt(input: {
  attempt_id?: unknown;
  idempotency_key?: unknown;
  actor_kind?: unknown;
  actor_id?: unknown;
  commit_message?: unknown;
  note?: unknown;
  policy_revision?: unknown;
}) {
  const attemptId = requiredText(input.attempt_id, "attempt_id", 200);
  const idempotencyKey = requiredText(input.idempotency_key, "idempotency_key", 200);
  const actorKind = requiredText(input.actor_kind, "actor_kind", 40);
  if (actorKind !== "operator" && actorKind !== "control_plane") throw invalid("actor_kind must be operator or control_plane", { field: "actor_kind" });
  const actorId = requiredText(input.actor_id, "actor_id", 200);
  const commitMessage = optionalText(input.commit_message, "commit_message", 2000);
  const note = optionalText(input.note, "note", 2000);
  const policyRevision = input.policy_revision === undefined || input.policy_revision === null || input.policy_revision === "" ? null : integerInput(input.policy_revision, "policy_revision");

  let record = await recordByKey(idempotencyKey);
  if (record && record.attempt_id !== attemptId) {
    throw invalid(`idempotency_key ${idempotencyKey} belongs to an acceptance of another attempt`, { field: "idempotency_key" });
  }
  if (record && record.status !== "in_progress") {
    return { acceptance: hydrateRecord(record), attempt: await getExecutionAttempt(attemptId), replayed: true, settlement: null };
  }
  const attempt = await getExecutionAttempt(attemptId);
  if (!attempt) throw new ExecutionAcceptanceError("attempt_not_found", `Execution attempt not found: ${attemptId}`, { attempt_id: attemptId });

  let policy: PolicyView;
  if (record) {
    policy = await requirePolicyById(record.policy_id);
  } else {
    if (attempt.state !== "reviewable") {
      throw new ExecutionAcceptanceError("attempt_not_reviewable", `Attempt ${attempt.id} is ${attempt.state}; only a reviewable attempt can be accepted`, { attempt_id: attempt.id, state: attempt.state });
    }
    const found = (await getAcceptancePolicy({ repository: attempt.repository, revision: policyRevision })).policy;
    if (!found) {
      throw new ExecutionAcceptanceError("policy_not_found", `No acceptance policy${policyRevision ? ` revision ${policyRevision}` : ""} is configured for ${attempt.repository}; acceptance never happens without one`, { repository: attempt.repository });
    }
    policy = found;
    record = await insertRecord(attempt, policy, idempotencyKey, { kind: actorKind, id: actorId }, note);
  }
  return await runAcceptance(record, policy, commitMessage);
}

async function insertRecord(attempt: AttemptView, policy: PolicyView, idempotencyKey: string, actor: { kind: string; id: string }, note: string | null) {
  const at = nowIso();
  const id = `acceptance_${nanoid()}`;
  try {
    await adapter.run(`
      INSERT INTO execution_acceptances (
        id, attempt_id, policy_id, policy_revision, idempotency_key, status, step, pushed_refs, actor_kind, actor_id, note, created_at, updated_at
      ) VALUES (
        @id, @attempt_id, @policy_id, @policy_revision, @idempotency_key, 'in_progress', 'recorded', '[]', @actor_kind, @actor_id, @note, @at, @at
      )
    `, { id, attempt_id: attempt.id, policy_id: policy.id, policy_revision: policy.revision, idempotency_key: idempotencyKey, actor_kind: actor.kind, actor_id: actor.id, note, at });
  } catch (error) {
    if (isUniqueViolation(error, ["idempotency_key"])) {
      const raced = await recordByKey(idempotencyKey);
      if (raced && raced.attempt_id === attempt.id) return raced;
    }
    if (isUniqueViolation(error, ["attempt_id", "in_progress"])) {
      throw new ExecutionAcceptanceError("acceptance_in_progress", `Attempt ${attempt.id} already has an acceptance in progress; resume it with its idempotency key`, { attempt_id: attempt.id });
    }
    throw error;
  }
  return await requireRecord(id);
}

async function runAcceptance(initial: AcceptanceRow, policy: PolicyView, commitMessage: string | null) {
  const settings = policy.settings;
  const actor = { kind: initial.actor_kind, id: initial.actor_id };
  let record = initial;
  const reached = (step: Step) => executionAcceptanceSteps.indexOf(record.step) >= executionAcceptanceSteps.indexOf(step);
  const settlement: { claim_release: unknown; workspace_release: unknown } = { claim_release: null, workspace_release: null };

  try {
    let attempt = await requireAttempt(record.attempt_id);
    if (!reached("transitioned")) {
      if (attempt.state !== "reviewable") {
        throw new ExecutionAcceptanceError("attempt_not_reviewable", `Attempt ${attempt.id} is ${attempt.state}; only a reviewable attempt can be accepted`, { attempt_id: attempt.id, state: attempt.state });
      }
      const verdict = await adapter.get<{ id: string; status: string; tree_fingerprint: string | null }>(
        "SELECT id, status, tree_fingerprint FROM execution_evidence WHERE attempt_id = @attempt_id AND kind = 'verdict' ORDER BY sequence DESC LIMIT 1",
        { attempt_id: attempt.id },
      );
      if (!verdict || verdict.status !== "passed" || !verdict.tree_fingerprint) {
        throw new ExecutionAcceptanceError("verification_missing", `Attempt ${attempt.id} has no passing verdict to accept`, { attempt_id: attempt.id });
      }
      await detectExecutionConflicts({ attempt_id: attempt.id });
      const blocking = await blockingConflictsForAttempt(attempt.id);
      if (blocking.length) {
        throw new ExecutionAcceptanceError("conflict_blocked", `Attempt ${attempt.id} has ${blocking.length} open blocking conflict(s); an operator must override them first`, { conflicts: blocking.map((conflict) => conflict.id) });
      }
      const lease = (await listExecutionWorkspaces({ attempt_id: attempt.id })).find((candidate) => existsSync(candidate.worktree_path));
      if (!lease) throw new ExecutionAcceptanceError("workspace_not_ready", `Attempt ${attempt.id} has no unreleased workspace with its worktree in place`, { attempt_id: attempt.id });
      const worktree = lease.worktree_path;
      const author = settings.commit_author;
      const identity = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
      const subject = commitMessage ?? `${attempt.issue_identifier ?? attempt.issue_id}: accept execution attempt ${attempt.id}`;

      if (!reached("committed")) {
        const commit = await commitWorktree(attempt, worktree, verdict as { id: string; tree_fingerprint: string }, subject, identity);
        record = await updateRecord(record.id, { step: "committed", commit_sha: commit, verdict_id: verdict.id, tree_fingerprint: verdict.tree_fingerprint });
        faultPoint("accept:committed");
      }
      const commitSha = record.commit_sha as string;

      if (settings.merge_target && !reached("merged")) {
        const merged = await mergeIntoTarget(attempt, worktree, commitSha, settings.merge_target, identity);
        if (merged.status === "conflict") return await rejectForMergeConflict(record, attempt, actor, { merge_target: settings.merge_target, conflicted_paths: merged.paths });
        record = await updateRecord(record.id, { step: "merged", merge_target: settings.merge_target, merge_target_previous_sha: merged.previous, merge_sha: merged.merge_sha });
      }

      if (settings.push && !reached("pushed")) {
        const refs = [`refs/heads/${lease.branch}:refs/heads/${lease.branch}`];
        if (settings.push.include_merge_target && settings.merge_target) refs.push(`refs/heads/${settings.merge_target}:refs/heads/${settings.merge_target}`);
        const pushed = await runGit(worktree, ["push", "--porcelain", settings.push.remote, ...refs]);
        if (!pushed.ok) throw new ExecutionAcceptanceError("push_rejected", `Pushing to ${settings.push.remote} failed: ${cleanOutput(pushed.stderr || pushed.stdout)}`, { remote: settings.push.remote });
        record = await updateRecord(record.id, { step: "pushed", pushed_refs: json(refs) });
      }

      if (settings.pull_request && !reached("pull_request_opened")) {
        const provider = requireProvider(settings.pull_request.provider);
        const request = pullRequestRequest(attempt, lease.branch, settings.pull_request.base_branch, subject, commitSha, policy, worktree);
        const opened = await providerStep(() => provider.findPullRequest(request)) ?? await providerStep(() => provider.createPullRequest(request));
        record = await updateRecord(record.id, { step: "pull_request_opened", pull_request: json(opened) });
      }

      if (settings.pull_request?.merge && !reached("pull_request_merged")) {
        const provider = requireProvider(settings.pull_request.provider);
        const request = pullRequestRequest(attempt, lease.branch, settings.pull_request.base_branch, subject, commitSha, policy, worktree);
        const opened = parseJson<PullRequestIdentity>(record.pull_request, { provider: provider.id, number: 0, url: "" });
        const merged = await providerStep(() => provider.mergePullRequest(request, opened));
        if (merged.status === "conflict") return await rejectForMergeConflict(record, attempt, actor, { pull_request: opened, detail: cleanOutput(merged.detail) });
        record = await updateRecord(record.id, { step: "pull_request_merged", pull_request: json({ ...opened, merge_commit: merged.merge_commit }) });
      }

      attempt = await requireAttempt(attempt.id);
      const pullRequest = parseJson<(PullRequestIdentity & { merge_commit?: string | null }) | null>(record.pull_request, null);
      await transitionExecutionAttempt({
        attempt_id: attempt.id,
        event: "accept",
        expected_revision: attempt.revision,
        idempotency_key: `accept:${record.id}`,
        actor_kind: actor.kind,
        actor_id: actor.id,
        policy: `acceptance-policy:${policy.id}@${policy.revision}`,
        note: record.note,
        artifacts: [
          { kind: "commit", ref: commitSha },
          ...(record.merge_sha ? [{ kind: "merge_commit", ref: record.merge_sha }] : []),
          ...(pullRequest ? [{ kind: "pull_request", ref: pullRequest.url }] : []),
          ...(pullRequest?.merge_commit ? [{ kind: "pull_request_merge_commit", ref: pullRequest.merge_commit }] : []),
        ],
        details: {
          acceptance_id: record.id,
          commit_sha: commitSha,
          merge_target: record.merge_target,
          merge_sha: record.merge_sha,
          pushed_refs: parseJson<string[]>(record.pushed_refs, []),
          pull_request: pullRequest,
        },
      });
      record = await updateRecord(record.id, { step: "transitioned" });
    }

    attempt = await requireAttempt(record.attempt_id);
    if (!reached("issue_settled")) {
      settlement.claim_release = await settleIssue(record, attempt, policy);
      record = await updateRecord(record.id, { step: "issue_settled" });
    }
    if (!reached("completed")) {
      if (settings.release_workspace) {
        const lease = (await listExecutionWorkspaces({ attempt_id: attempt.id }))[0];
        settlement.workspace_release = lease ? (await releaseExecutionWorkspace({ id: lease.id })).worktree : "already_released";
      }
      record = await updateRecord(record.id, { step: "completed", status: "accepted", outcome_code: null, outcome_message: null, completed_at: nowIso() });
    }
    return { acceptance: hydrateRecord(record), attempt: await getExecutionAttempt(record.attempt_id), replayed: false, settlement };
  } catch (error) {
    const code = error instanceof ExecutionAcceptanceError ? error.code : "git_failed";
    const message = cleanOutput(error instanceof Error ? error.message : String(error));
    // Before the accept transition nothing irreversible has been decided, so the
    // run fails and the attempt stays reviewable. After it, the attempt is
    // accepted and the run stays in progress so a retry finishes settling it.
    if (reached("transitioned")) await updateRecord(record.id, { outcome_code: code, outcome_message: message });
    else await updateRecord(record.id, { status: "failed", outcome_code: code, outcome_message: message, completed_at: nowIso() });
    throw error;
  }
}

async function commitWorktree(attempt: AttemptView, worktree: string, verdict: { id: string; tree_fingerprint: string }, subject: string, identity: Record<string, string>) {
  await gitStep(worktree, ["add", "-A"], identity, "Staging the worktree");
  const tree = await gitStep(worktree, ["write-tree"], identity, "Writing the worktree tree");
  if (tree !== verdict.tree_fingerprint) {
    throw new ExecutionAcceptanceError("verification_stale", `The worktree changed after verification passed on tree ${verdict.tree_fingerprint}; verify it again`, { tree, verified_tree: verdict.tree_fingerprint });
  }
  const head = await gitStep(worktree, ["rev-parse", "HEAD"], identity, "Reading the branch head");
  if (await gitStep(worktree, ["rev-parse", "HEAD^{tree}"], identity, "Reading the head tree") === tree) {
    // The verified tree is already committed -- by an earlier run of this
    // acceptance or by the agent itself -- so that commit is the one accepted.
    if (head !== attempt.base_sha) return head;
    throw new ExecutionAcceptanceError("nothing_to_commit", `Attempt ${attempt.id} has no changes against its base commit`, { attempt_id: attempt.id });
  }
  const trailers = `Claw-Task-Hub-Attempt: ${attempt.id}\nClaw-Task-Hub-Issue: ${attempt.issue_identifier ?? attempt.issue_id}\nClaw-Task-Hub-Verdict: ${verdict.id}`;
  await gitStep(worktree, ["-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", subject, "-m", trailers], identity, "Committing the worktree");
  const commit = await gitStep(worktree, ["rev-parse", "HEAD"], identity, "Reading the new commit");
  if (await gitStep(worktree, ["rev-parse", "HEAD^{tree}"], identity, "Reading the committed tree") !== tree) {
    throw new ExecutionAcceptanceError("verification_stale", "The committed tree differs from the verified tree", { commit });
  }
  return commit;
}

// Merges without a checkout: merge-tree writes the merged tree, commit-tree
// records the merge, and update-ref moves the branch only if it still points
// where it did when the merge was computed.
async function mergeIntoTarget(attempt: AttemptView, worktree: string, commit: string, target: string, identity: Record<string, string>) {
  await gitStep(worktree, ["check-ref-format", "--branch", target], identity, "Validating the merge target");
  const resolved = await runGit(worktree, ["rev-parse", "--verify", "--quiet", `refs/heads/${target}^{commit}`]);
  if (!resolved.ok || !resolved.stdout) throw new ExecutionAcceptanceError("merge_target_missing", `Branch ${target} does not exist`, { merge_target: target });
  const targetSha = resolved.stdout;
  if ((await runGit(worktree, ["merge-base", "--is-ancestor", commit, targetSha])).ok) {
    return { status: "merged" as const, merge_sha: targetSha, previous: null };
  }
  const worktrees = await gitStep(worktree, ["worktree", "list", "--porcelain"], identity, "Listing worktrees");
  if (worktrees.split(/\r?\n/).some((line) => line.trim() === `branch refs/heads/${target}`)) {
    throw new ExecutionAcceptanceError("merge_target_checked_out", `Branch ${target} is checked out in a worktree; moving it would change that checkout underneath it`, { merge_target: target });
  }
  let mergeSha = commit;
  if (!(await runGit(worktree, ["merge-base", "--is-ancestor", targetSha, commit])).ok) {
    const merged = await runGit(worktree, ["merge-tree", "--write-tree", "--name-only", targetSha, commit], { trim: false });
    if (!merged.ok) {
      if (merged.exitCode === 1) {
        const lines = merged.stdout.split(/\r?\n/);
        const end = lines.indexOf("", 1);
        return { status: "conflict" as const, paths: lines.slice(1, end < 0 ? undefined : end).filter(Boolean).slice(0, 200) };
      }
      throw new ExecutionAcceptanceError("git_failed", `Merging into ${target} failed: ${cleanOutput(merged.stderr)}`, { merge_target: target });
    }
    const tree = merged.stdout.split(/\r?\n/)[0].trim();
    mergeSha = await gitStep(
      worktree,
      ["-c", "commit.gpgsign=false", "commit-tree", tree, "-p", targetSha, "-p", commit, "-m", `Merge execution attempt ${attempt.id} (${attempt.issue_identifier ?? attempt.issue_id}) into ${target}`],
      identity,
      "Recording the merge",
    );
  }
  const moved = await runGit(worktree, ["update-ref", `refs/heads/${target}`, mergeSha, targetSha]);
  if (!moved.ok) throw new ExecutionAcceptanceError("merge_target_moved", `Branch ${target} moved while the merge was being written; accept again`, { merge_target: target });
  return { status: "merged" as const, merge_sha: mergeSha, previous: targetSha };
}

async function rejectForMergeConflict(record: AcceptanceRow, attempt: AttemptView, actor: { kind: string; id: string }, details: Record<string, unknown>) {
  const current = await requireAttempt(attempt.id);
  await transitionExecutionAttempt({
    attempt_id: attempt.id,
    event: "reject",
    expected_revision: current.revision,
    idempotency_key: `accept-merge-conflict:${record.id}`,
    actor_kind: actor.kind,
    actor_id: actor.id,
    reason: "merge_conflict",
    details: { acceptance_id: record.id, commit_sha: record.commit_sha, ...details },
  });
  const updated = await updateRecord(record.id, { status: "rejected", outcome_code: "merge_conflict", outcome_message: "the merge could not complete without conflicts", completed_at: nowIso() });
  return { acceptance: hydrateRecord(updated), attempt: await getExecutionAttempt(attempt.id), replayed: false, settlement: null };
}

async function settleIssue(record: AcceptanceRow, attempt: AttemptView, policy: PolicyView) {
  if (!policy.settings.complete_issue) {
    return attempt.claim_id ? await releaseIssueClaim({ claim_id: attempt.claim_id, status: "released", force: true }) : null;
  }
  const pullRequest = parseJson<(PullRequestIdentity & { merge_commit?: string | null }) | null>(record.pull_request, null);
  const facts = [
    `commit ${record.commit_sha}`,
    record.merge_sha ? `merged into ${record.merge_target} as ${record.merge_sha}` : null,
    pullRequest ? `pull request ${pullRequest.url}${pullRequest.merge_commit ? ` merged as ${pullRequest.merge_commit}` : ""}` : null,
  ].filter(Boolean).join("; ");
  // The external id makes the comment idempotent when a run resumes.
  await saveComment({
    issue_id: attempt.issue_id,
    external_id: `acceptance:${record.id}`,
    author: "Claw Task Hub",
    source: "execution-control-plane",
    body: `Acceptance: execution attempt ${attempt.id} was accepted under acceptance policy ${policy.id} revision ${policy.revision}: ${facts}.`,
    allow_closed: true,
  });
  const released = attempt.claim_id ? await releaseIssueClaim({ claim_id: attempt.claim_id, status: "completed", force: true }) : null;
  if (!released?.released) await updateIssue(attempt.issue_id, { status: "Done" });
  return released;
}

// --- reject --------------------------------------------------------------------------------

export async function rejectExecutionAttempt(input: { attempt_id?: unknown; idempotency_key?: unknown; actor_kind?: unknown; actor_id?: unknown; note?: unknown; release_claim?: unknown }) {
  const attemptId = requiredText(input.attempt_id, "attempt_id", 200);
  const idempotencyKey = requiredText(input.idempotency_key, "idempotency_key", 200);
  const actorKind = requiredText(input.actor_kind, "actor_kind", 40);
  const actorId = requiredText(input.actor_id, "actor_id", 200);
  const note = optionalText(input.note, "note", 2000);
  const releaseClaim = booleanInput(input.release_claim, "release_claim", true);
  const attempt = await requireAttempt(attemptId);
  const moved = await transitionExecutionAttempt({
    attempt_id: attempt.id,
    event: "reject",
    expected_revision: attempt.revision,
    idempotency_key: idempotencyKey,
    actor_kind: actorKind,
    actor_id: actorId,
    reason: "review_rejected",
    note,
  });
  // Releasing a claim twice is a no-op, so a replayed rejection is safe.
  const claimRelease = releaseClaim && attempt.claim_id ? await releaseIssueClaim({ claim_id: attempt.claim_id, status: "released", force: true }) : null;
  return { attempt: await getExecutionAttempt(attempt.id), outcome: moved.outcome, claim_release: claimRelease };
}

// --- reads ----------------------------------------------------------------------------------

export async function listExecutionAcceptances(input: { attempt_id?: unknown }) {
  const attemptId = requiredText(input.attempt_id, "attempt_id", 200);
  const rows = await adapter.all<AcceptanceRow>("SELECT * FROM execution_acceptances WHERE attempt_id = @attempt_id", { attempt_id: attemptId });
  return rows.map(hydrateRecord).sort((left, right) => compareText(left.created_at, right.created_at) || compareText(left.id, right.id));
}

export async function getExecutionAcceptance(id: string) {
  const row = await adapter.get<AcceptanceRow>("SELECT * FROM execution_acceptances WHERE id = @id", { id });
  return row ? hydrateRecord(row) : null;
}

function hydrateRecord(row: AcceptanceRow) {
  return {
    id: row.id,
    attempt_id: row.attempt_id,
    policy_id: row.policy_id,
    policy_revision: Number(row.policy_revision),
    idempotency_key: row.idempotency_key,
    status: row.status,
    step: row.step,
    verdict_id: row.verdict_id,
    tree_fingerprint: row.tree_fingerprint,
    commit_sha: row.commit_sha,
    merge_target: row.merge_target,
    merge_target_previous_sha: row.merge_target_previous_sha,
    merge_sha: row.merge_sha,
    pushed_refs: parseJson<string[]>(row.pushed_refs, []),
    pull_request: parseJson<Record<string, unknown> | null>(row.pull_request, null),
    outcome: row.outcome_code ? { code: row.outcome_code, message: row.outcome_message } : null,
    actor: { kind: row.actor_kind, id: row.actor_id },
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

// --- helpers ----------------------------------------------------------------------------------

async function recordByKey(key: string) {
  return await adapter.get<AcceptanceRow>("SELECT * FROM execution_acceptances WHERE idempotency_key = @key", { key });
}

async function requireRecord(id: string) {
  const row = await adapter.get<AcceptanceRow>("SELECT * FROM execution_acceptances WHERE id = @id", { id });
  if (!row) throw new ExecutionAcceptanceError("acceptance_not_found", `Acceptance not found: ${id}`, { acceptance_id: id });
  return row;
}

async function updateRecord(id: string, fields: Record<string, unknown>) {
  const columns = Object.keys(fields);
  await adapter.run(
    `UPDATE execution_acceptances SET ${columns.map((column) => `${column} = @${column}`).join(", ")}, updated_at = @updated_at WHERE id = @id`,
    { ...fields, updated_at: nowIso(), id },
  );
  return await requireRecord(id);
}

async function requireAttempt(attemptId: string) {
  const attempt = await getExecutionAttempt(attemptId);
  if (!attempt) throw new ExecutionAcceptanceError("attempt_not_found", `Execution attempt not found: ${attemptId}`, { attempt_id: attemptId });
  return attempt;
}

function requireProvider(id: string) {
  const provider = getExecutionProvider(id);
  const availability = provider?.available();
  if (!provider || !availability?.ok) {
    throw new ExecutionAcceptanceError("provider_unavailable", availability && !availability.ok ? availability.reason : `No provider is named ${id}`, { provider: id });
  }
  return provider;
}

async function providerStep<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    throw new ExecutionAcceptanceError("provider_failed", cleanOutput(error instanceof Error ? error.message : String(error)), {});
  }
}

function pullRequestRequest(attempt: AttemptView, branch: string, base: string, title: string, commit: string, policy: PolicyView, cwd: string): PullRequestRequest {
  return {
    repository: attempt.repository,
    head: branch,
    base,
    title,
    body: `Execution attempt ${attempt.id} for ${attempt.issue_identifier ?? attempt.issue_id}, commit ${commit}, accepted under acceptance policy ${policy.id} revision ${policy.revision}.`,
    cwd,
  };
}

async function gitStep(cwd: string, args: string[], env: Record<string, string>, description: string) {
  const result = await runGit(cwd, args, { env });
  if (!result.ok) throw new ExecutionAcceptanceError("git_failed", `${description} failed: ${cleanOutput(result.stderr || result.stdout)}`, {});
  return result.stdout;
}

function cleanOutput(text: string) {
  return scrub(text, [...declaredSecretValues(), ...providerSecretValues()]).slice(0, 2000);
}

function repositoryInput(value: unknown) {
  const repository = requiredText(value, "repository", 2000);
  if (/\/\/[^/@\s]+@/.test(repository)) throw invalid("repository must not contain credentials", { field: "repository" });
  return repository;
}

function remoteInput(value: unknown) {
  const remote = requiredText(value, "settings.push.remote", 2000);
  if (remote.startsWith("-") || /\s/.test(remote)) throw invalid("settings.push.remote must be a remote name, URL, or path", { field: "settings.push.remote" });
  if (/\/\/[^/@\s]+@/.test(remote)) throw invalid("settings.push.remote must not contain credentials; configure them in Git or the environment", { field: "settings.push.remote" });
  return remote;
}

function branchInput(value: unknown, field: string) {
  const branch = requiredText(value, field, 200);
  if (!branchPattern.test(branch)) throw invalid(`${field} must be a plain branch name`, { field });
  return branch;
}

function authorText(value: unknown, field: string) {
  const text = requiredText(value, field, 100);
  if (/[<>\r\n]/.test(text)) throw invalid(`${field} must not contain angle brackets or newlines`, { field });
  return text;
}

function authorEmail(value: unknown) {
  const email = requiredText(value, "settings.commit_author.email", 200);
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email)) throw invalid("settings.commit_author.email must be an email address", { field: "settings.commit_author.email" });
  return email;
}

function objectInput(value: unknown, field: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw invalid(`${field} must be an object`, { field });
  return value as Record<string, unknown>;
}

function booleanInput(value: unknown, field: string, fallback: boolean) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalid(`${field} must be true or false`, { field });
}

function integerInput(value: unknown, field: string) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 1) throw invalid(`${field} must be a positive integer`, { field });
  return numeric;
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${field} must be a non-empty string`, { field });
  if (value.trim().length > maxLength || value.includes("\0")) throw invalid(`${field} must be at most ${maxLength} characters`, { field });
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, field, maxLength);
}

function invalid(message: string, details: Record<string, unknown> = {}) {
  return new ExecutionAcceptanceError("invalid_input", message, details);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isUniqueViolation(error: unknown, markers: string[]) {
  const record = (error ?? {}) as { code?: unknown; constraint_name?: unknown; message?: unknown };
  const message = String(record.message ?? "");
  const text = record.code === "23505" ? `${String(record.constraint_name ?? "")} ${message}` : message.includes("UNIQUE constraint failed") ? message : "";
  return Boolean(text) && markers.some((marker) => text.includes(marker));
}
