// Execution attempt persistence.
//
// An execution attempt is the durable record of one try at an issue: the claim
// and session that own it, the harness that runs it, the base commit it is
// pinned to, the branch/worktree lease and process it holds, the artifacts it
// produced, and every lifecycle transition it made. It is stored apart from
// issues, claims, sessions, and comments so that a retry adds history instead of
// rewriting it, and so comments stay a readable projection rather than the record.
//
// Lifecycle legality is not decided here. planExecutionTransition() in
// server/execution-contract.ts owns it; this module loads the attempt, asks the
// contract, and persists the answer with a compare-and-set on the revision, so
// two writers that planned against the same revision cannot both land. The
// rules that must hold across processes are also enforced by the schema
// (server/execution-attempts-schema.ts): one non-terminal attempt per issue, and
// one ledger row per revision and per idempotency key.
//
// Failures specific to persistence are ExecutionAttemptError; lifecycle
// failures pass through as ExecutionContractError. Both lead their message with
// the typed code, so CLI and MCP callers that only see the message can branch.

import { customAlphabet } from "nanoid";
import { adapter, json, nowIso, parseJson } from "./db.js";
import {
  EXECUTION_CONTRACT_VERSION,
  ExecutionContractError,
  executionBounds,
  initialExecutionState,
  isExecutionState,
  isTerminalExecutionState,
  planExecutionTransition,
  type ExecutionAttemptSnapshot,
  type ExecutionEvent,
  type ExecutionState,
  type ExecutionTransitionRequest,
} from "./execution-contract.js";
import { liveExecutionStatesSql } from "./execution-attempts-schema.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export const executionAttemptErrorCodes = [
  "invalid_input",
  "issue_not_found",
  "issue_closed",
  "claim_not_active",
  "attempt_not_found",
  "live_attempt_exists",
  "invalid_retry",
  "idempotency_conflict",
  "resource_conflict",
] as const;
export type ExecutionAttemptErrorCode = (typeof executionAttemptErrorCodes)[number];

export class ExecutionAttemptError extends Error {
  readonly code: ExecutionAttemptErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ExecutionAttemptErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "ExecutionAttemptError";
    this.code = code;
    this.details = details;
  }
}

export type CreateExecutionAttemptInput = {
  issue_id?: unknown;
  claim_id?: unknown;
  harness?: unknown;
  harness_version?: unknown;
  repository?: unknown;
  base_sha?: unknown;
  retry_of?: unknown;
  idempotency_key?: unknown;
  provenance?: unknown;
};

export type ListExecutionAttemptsInput = {
  issue_id?: unknown;
  session_id?: unknown;
  state?: unknown;
  include_terminal?: unknown;
  limit?: unknown;
};

export type TransitionExecutionAttemptInput = {
  attempt_id?: unknown;
  event?: unknown;
  expected_revision?: unknown;
  idempotency_key?: unknown;
  actor?: unknown;
  actor_kind?: unknown;
  actor_id?: unknown;
  reason?: unknown;
  policy?: unknown;
  note?: unknown;
  workspace?: unknown;
  process?: unknown;
  artifacts?: unknown;
  details?: unknown;
};

type IssueRow = { id: string; identifier: string | null; status: string | null; status_type: string | null; archived_at: string | null };

type ClaimRow = {
  id: string;
  issue_id: string;
  session_id: string;
  status: string;
  released_at: string | null;
  expires_at: string;
  session_status: string;
  session_expires_at: string;
};

type AttemptRow = {
  id: string;
  issue_id: string;
  issue_identifier: string | null;
  claim_id: string | null;
  session_id: string | null;
  harness: string;
  harness_version: string | null;
  repository: string;
  base_sha: string;
  retry_of: string | null;
  create_idempotency_key: string;
  state: string;
  revision: number | string;
  reconciliation_origin: string | null;
  last_idempotency_key: string | null;
  last_event: string | null;
  state_reason: string | null;
  branch: string | null;
  worktree_path: string | null;
  lease_id: string | null;
  process_id: number | string | null;
  process_started_at: string | null;
  provenance: string | null;
  artifacts: string | null;
  contract_version: string;
  created_at: string;
  updated_at: string;
  state_changed_at: string;
  terminal_at: string | null;
};

type TransitionRow = {
  id: string;
  attempt_id: string;
  revision: number | string;
  event: string;
  from_state: string;
  to_state: string;
  idempotency_key: string;
  actor_kind: string;
  actor_id: string;
  reason: string | null;
  policy: string | null;
  note: string | null;
  details: string | null;
  contract_version: string;
  created_at: string;
};

type ArtifactRef = { kind: string; ref: string; revision: number };

const resourceFields = ["branch", "worktree_path", "lease_id", "process_id", "process_started_at"] as const;
type ResourceField = (typeof resourceFields)[number];
type ResourceInput = Record<ResourceField, string | number | null> & { artifacts: { kind: string; ref: string }[] };

// Harness ids become adapter keys and may reach process construction later, so
// they are held to a conservative identifier shape rather than free text.
const harnessPattern = /^[a-z][a-z0-9-]{0,119}$/;
const baseShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const artifactKindPattern = /^[a-z][a-z0-9_]{0,49}$/;
const maxProvenanceCharacters = 16_000;
const maxTransitionDetailsCharacters = 16_000;
const maxArtifactsPerTransition = 50;
const maxArtifactsPerAttempt = 500;

const attemptSelect = `
  SELECT a.*, i.identifier AS issue_identifier
  FROM execution_attempts a
  JOIN issues i ON i.id = a.issue_id
`;

export async function createExecutionAttempt(input: CreateExecutionAttemptInput) {
  const issueReference = requiredText(input.issue_id, "issue_id", 200);
  const claimId = requiredText(input.claim_id, "claim_id", 200);
  const harness = requiredText(input.harness, "harness", 120);
  if (!harnessPattern.test(harness)) {
    throw invalid("harness must be a lowercase adapter id such as codex or claude-code", { field: "harness" });
  }
  const harnessVersion = optionalText(input.harness_version, "harness_version", 120);
  const repository = requiredText(input.repository, "repository", 2000);
  if (hasUrlCredentials(repository)) {
    throw invalid("repository must not contain credentials; pass the remote without a username, password, or token", { field: "repository" });
  }
  const baseSha = requiredText(input.base_sha, "base_sha", 64).toLowerCase();
  if (!baseShaPattern.test(baseSha)) {
    throw invalid("base_sha must be a full 40- or 64-character hexadecimal commit SHA", { field: "base_sha" });
  }
  const idempotencyKey = requiredText(input.idempotency_key, "idempotency_key", executionBounds.idempotency_key.value);
  const retryReference = optionalText(input.retry_of, "retry_of", 200);
  const provenance = provenanceJson(input.provenance);

  return await adapter.transaction(async () => {
    const issue = await findIssue(issueReference);
    const existing = await adapter.get<AttemptRow>(`${attemptSelect} WHERE a.create_idempotency_key = @key`, { key: idempotencyKey });
    if (existing) {
      const sameRequest = existing.issue_id === issue?.id
        && existing.claim_id === claimId
        && existing.harness === harness
        && existing.repository === repository
        && existing.base_sha === baseSha
        && existing.retry_of === retryReference;
      if (!sameRequest) {
        throw new ExecutionAttemptError(
          "idempotency_conflict",
          `idempotency_key ${idempotencyKey} already created attempt ${existing.id} from different inputs`,
          { idempotency_key: idempotencyKey, attempt_id: existing.id },
        );
      }
      return { attempt: await attemptWithHistory(existing), created: false };
    }

    if (!issue) throw new ExecutionAttemptError("issue_not_found", `Issue not found: ${issueReference}`, { issue_id: issueReference });
    const label = issue.identifier ?? issue.id;
    const closed = issueClosedState(issue);
    if (closed) {
      throw new ExecutionAttemptError("issue_closed", `Issue ${label} is ${closed}; attempts start only on open issues`, { issue_id: issue.id, state: closed });
    }

    const at = nowIso();
    const claim = await adapter.get<ClaimRow>(`
      SELECT c.id, c.issue_id, c.session_id, c.status, c.released_at, c.expires_at,
        s.status AS session_status, s.expires_at AS session_expires_at
      FROM issue_claims c
      JOIN agent_sessions s ON s.id = c.session_id
      WHERE c.id = @claim_id
    `, { claim_id: claimId });
    const claimIsLive = claim !== undefined
      && claim.issue_id === issue.id
      && claim.status === "active"
      && !claim.released_at
      && claim.expires_at > at
      && claim.session_status === "active"
      && claim.session_expires_at > at;
    if (!claim || !claimIsLive) {
      throw new ExecutionAttemptError("claim_not_active", `Claim ${claimId} is not an active claim on ${label}`, { claim_id: claimId, issue_id: issue.id });
    }

    let retryOf: string | null = null;
    if (retryReference) {
      const prior = await adapter.get<{ id: string; issue_id: string; state: string }>(
        "SELECT id, issue_id, state FROM execution_attempts WHERE id = @id",
        { id: retryReference },
      );
      if (!prior || prior.issue_id !== issue.id || !isExecutionState(prior.state) || !isTerminalExecutionState(prior.state)) {
        throw new ExecutionAttemptError(
          "invalid_retry",
          `retry_of must name a terminal attempt of ${label}`,
          { retry_of: retryReference, state: prior?.state ?? null },
        );
      }
      retryOf = prior.id;
    }

    const live = await adapter.get<{ id: string; state: string }>(
      `SELECT id, state FROM execution_attempts WHERE issue_id = @issue_id AND state IN (${liveExecutionStatesSql})`,
      { issue_id: issue.id },
    );
    if (live) throw liveAttemptExists(label, issue.id, live.id, live.state);

    const id = `attempt_${nanoid()}`;
    try {
      await adapter.run(`
        INSERT INTO execution_attempts (
          id, issue_id, claim_id, session_id, harness, harness_version, repository, base_sha, retry_of,
          create_idempotency_key, state, revision, provenance, artifacts, contract_version,
          created_at, updated_at, state_changed_at
        ) VALUES (
          @id, @issue_id, @claim_id, @session_id, @harness, @harness_version, @repository, @base_sha, @retry_of,
          @create_idempotency_key, @state, 0, @provenance, '[]', @contract_version,
          @at, @at, @at
        )
      `, {
        id,
        issue_id: issue.id,
        claim_id: claim.id,
        session_id: claim.session_id,
        harness,
        harness_version: harnessVersion,
        repository,
        base_sha: baseSha,
        retry_of: retryOf,
        create_idempotency_key: idempotencyKey,
        state: initialExecutionState,
        provenance,
        contract_version: EXECUTION_CONTRACT_VERSION,
        at,
      });
    } catch (error) {
      // Postgres writers do not serialize, so the checks above can pass in two
      // transactions at once; the unique indexes decide, and the loser gets the
      // same typed failure it would have got from the check.
      if (isUniqueViolation(error, "execution_attempts.issue_id") || isUniqueViolation(error, "idx_execution_attempts_live_issue")) {
        throw liveAttemptExists(label, issue.id, null, null);
      }
      if (isUniqueViolation(error, "create_idempotency_key")) {
        throw new ExecutionAttemptError(
          "idempotency_conflict",
          `idempotency_key ${idempotencyKey} was used by a concurrent create`,
          { idempotency_key: idempotencyKey },
        );
      }
      throw error;
    }
    const created = await loadAttemptRow(id);
    if (!created) throw new ExecutionAttemptError("attempt_not_found", `Execution attempt ${id} was not readable after creation`, { attempt_id: id });
    return { attempt: await attemptWithHistory(created), created: true };
  });
}

export async function getExecutionAttempt(id: string) {
  const row = await loadAttemptRow(id);
  return row ? await attemptWithHistory(row) : null;
}

export async function listExecutionAttempts(input: ListExecutionAttemptsInput = {}) {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: boundedLimit(input.limit) };
  const issueReference = optionalText(input.issue_id, "issue_id", 200);
  if (issueReference) {
    const issue = await findIssue(issueReference);
    if (!issue) throw new ExecutionAttemptError("issue_not_found", `Issue not found: ${issueReference}`, { issue_id: issueReference });
    where.push("a.issue_id = @issue_id");
    params.issue_id = issue.id;
  }
  const sessionId = optionalText(input.session_id, "session_id", 200);
  if (sessionId) {
    where.push("a.session_id = @session_id");
    params.session_id = sessionId;
  }
  const states = stateFilter(input.state);
  // State names are validated against the contract before they are rendered.
  if (states.length) where.push(`a.state IN (${states.map((state) => `'${state}'`).join(", ")})`);
  if (!booleanInput(input.include_terminal, true)) where.push(`a.state IN (${liveExecutionStatesSql})`);
  const rows = await adapter.all<AttemptRow>(`
    ${attemptSelect}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT @limit
  `, params);
  return rows.map(hydrateAttempt);
}

export async function transitionExecutionAttempt(input: TransitionExecutionAttemptInput) {
  const attemptId = requiredText(input.attempt_id, "attempt_id", 200);
  const resources = parseResources(input);
  const extraDetails = detailsInput(input.details);
  const request: ExecutionTransitionRequest = {
    event: typeof input.event === "string" ? input.event : "",
    expected_revision: revisionInput(input.expected_revision),
    idempotency_key: typeof input.idempotency_key === "string" ? input.idempotency_key : "",
    actor: actorInput(input),
    reason: typeof input.reason === "string" ? input.reason : null,
    policy: typeof input.policy === "string" ? input.policy : null,
    note: typeof input.note === "string" ? input.note : null,
  };

  return await adapter.transaction(async () => {
    const row = await loadAttemptRow(attemptId);
    if (!row) throw new ExecutionAttemptError("attempt_not_found", `Execution attempt not found: ${attemptId}`, { attempt_id: attemptId });

    // The contract recognizes a replay of the most recent request only. Reuse of
    // any earlier key is answered from the ledger: it already means something
    // else in this attempt's history.
    const key = request.idempotency_key.trim();
    if (key && key !== row.last_idempotency_key) {
      const earlier = await adapter.get<{ revision: number | string; event: string }>(
        "SELECT revision, event FROM execution_attempt_transitions WHERE attempt_id = @attempt_id AND idempotency_key = @key",
        { attempt_id: row.id, key },
      );
      if (earlier) {
        throw new ExecutionContractError(
          "idempotency_conflict",
          `Idempotency key ${key} already applied ${earlier.event} at revision ${Number(earlier.revision)}; a new transition needs a new key`,
          { idempotency_key: key, applied_event: earlier.event, applied_revision: Number(earlier.revision) },
        );
      }
    }

    const plan = planExecutionTransition(snapshotOf(row), request);
    if (plan.outcome === "replayed") return { outcome: "replayed" as const, attempt: await attemptWithHistory(row) };

    const { record, snapshot } = plan;
    const merged = mergeResources(row, resources, record.revision);
    const updated = await adapter.run(`
      UPDATE execution_attempts
      SET state = @state,
        revision = @revision,
        reconciliation_origin = @reconciliation_origin,
        last_idempotency_key = @last_idempotency_key,
        last_event = @last_event,
        state_reason = @state_reason,
        branch = @branch,
        worktree_path = @worktree_path,
        lease_id = @lease_id,
        process_id = @process_id,
        process_started_at = @process_started_at,
        artifacts = @artifacts,
        terminal_at = @terminal_at,
        state_changed_at = @at,
        updated_at = @at
      WHERE id = @id AND revision = @expected_revision
    `, {
      id: row.id,
      expected_revision: Number(row.revision),
      state: snapshot.state,
      revision: snapshot.revision,
      reconciliation_origin: snapshot.reconciliation_origin,
      last_idempotency_key: record.idempotency_key,
      last_event: record.event,
      state_reason: record.reason,
      ...merged.values,
      terminal_at: isTerminalExecutionState(snapshot.state) ? record.at : null,
      at: record.at,
    });
    if (updated.changes !== 1) {
      const current = await loadAttemptRow(row.id);
      const currentRevision = current ? Number(current.revision) : null;
      throw new ExecutionContractError(
        "revision_conflict",
        `Attempt ${row.id} moved to revision ${currentRevision ?? "unknown"} before this transition landed; re-read before retrying`,
        { revision: currentRevision, expected_revision: Number(row.revision) },
      );
    }

    try {
      await adapter.run(`
        INSERT INTO execution_attempt_transitions (
          id, attempt_id, revision, event, from_state, to_state, idempotency_key, actor_kind, actor_id,
          reason, policy, note, details, contract_version, created_at
        ) VALUES (
          @id, @attempt_id, @revision, @event, @from_state, @to_state, @idempotency_key, @actor_kind, @actor_id,
          @reason, @policy, @note, @details, @contract_version, @created_at
        )
      `, {
        id: `transition_${nanoid()}`,
        attempt_id: row.id,
        revision: record.revision,
        event: record.event,
        from_state: record.from,
        to_state: record.to,
        idempotency_key: record.idempotency_key,
        actor_kind: record.actor.kind,
        actor_id: record.actor.id,
        reason: record.reason,
        policy: record.policy,
        note: record.note,
        details: json({ ...extraDetails, ...merged.recorded }),
        contract_version: record.contract_version,
        created_at: record.at,
      });
    } catch (error) {
      if (isUniqueViolation(error, "idempotency_key")) {
        throw new ExecutionContractError("idempotency_conflict", `Idempotency key ${record.idempotency_key} was used by a concurrent transition`, { idempotency_key: record.idempotency_key });
      }
      if (isUniqueViolation(error, "revision")) {
        throw new ExecutionContractError("revision_conflict", `Revision ${record.revision} of attempt ${row.id} was recorded by a concurrent transition`, { revision: record.revision });
      }
      throw error;
    }

    const saved = await loadAttemptRow(row.id);
    if (!saved) throw new ExecutionAttemptError("attempt_not_found", `Execution attempt ${row.id} disappeared during its transition`, { attempt_id: row.id });
    const attempt = await attemptWithHistory(saved);
    return { outcome: "applied" as const, attempt, transition: attempt.transitions[attempt.transitions.length - 1] };
  });
}

async function findIssue(reference: string) {
  return await adapter.get<IssueRow>(
    "SELECT id, identifier, status, status_type, archived_at FROM issues WHERE id = @reference OR external_id = @reference OR identifier = @reference",
    { reference },
  );
}

async function loadAttemptRow(id: string) {
  return await adapter.get<AttemptRow>(`${attemptSelect} WHERE a.id = @id`, { id });
}

async function attemptWithHistory(row: AttemptRow) {
  const transitions = await adapter.all<TransitionRow>(
    "SELECT * FROM execution_attempt_transitions WHERE attempt_id = @attempt_id ORDER BY revision",
    { attempt_id: row.id },
  );
  return { ...hydrateAttempt(row), transitions: transitions.map(hydrateTransition) };
}

function hydrateAttempt(row: AttemptRow) {
  return {
    id: row.id,
    issue_id: row.issue_id,
    issue_identifier: row.issue_identifier,
    claim_id: row.claim_id,
    session_id: row.session_id,
    harness: row.harness,
    harness_version: row.harness_version,
    repository: row.repository,
    base_sha: row.base_sha,
    retry_of: row.retry_of,
    create_idempotency_key: row.create_idempotency_key,
    state: row.state,
    terminal: isExecutionState(row.state) && isTerminalExecutionState(row.state),
    revision: Number(row.revision),
    reconciliation_origin: row.reconciliation_origin,
    state_reason: row.state_reason,
    last_event: row.last_event,
    last_idempotency_key: row.last_idempotency_key,
    workspace: { branch: row.branch, worktree_path: row.worktree_path, lease_id: row.lease_id },
    process: { pid: row.process_id === null ? null : Number(row.process_id), started_at: row.process_started_at },
    artifacts: parseJson<ArtifactRef[]>(row.artifacts, []),
    provenance: parseJson<Record<string, unknown>>(row.provenance, {}),
    contract_version: row.contract_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    state_changed_at: row.state_changed_at,
    terminal_at: row.terminal_at,
  };
}

function hydrateTransition(row: TransitionRow) {
  return {
    id: row.id,
    attempt_id: row.attempt_id,
    revision: Number(row.revision),
    event: row.event,
    from: row.from_state,
    to: row.to_state,
    idempotency_key: row.idempotency_key,
    actor: { kind: row.actor_kind, id: row.actor_id },
    reason: row.reason,
    policy: row.policy,
    note: row.note,
    details: parseJson<Record<string, unknown>>(row.details, {}),
    contract_version: row.contract_version,
    at: row.created_at,
  };
}

function snapshotOf(row: AttemptRow): ExecutionAttemptSnapshot {
  return {
    state: row.state as ExecutionState,
    revision: Number(row.revision),
    session_id: row.session_id,
    reconciliation_origin: row.reconciliation_origin as ExecutionState | null,
    last_idempotency_key: row.last_idempotency_key,
    last_event: row.last_event as ExecutionEvent | null,
  };
}

// Workspace and process identity are bound once per attempt: a different branch,
// worktree, lease, or process is a different attempt, so a transition may fill a
// blank field or repeat the recorded value but never replace it.
function mergeResources(row: AttemptRow, resources: ResourceInput, revision: number) {
  const values: Record<ResourceField, string | number | null> = {
    branch: row.branch,
    worktree_path: row.worktree_path,
    lease_id: row.lease_id,
    process_id: row.process_id === null ? null : Number(row.process_id),
    process_started_at: row.process_started_at,
  };
  const recorded: Record<string, unknown> = {};
  for (const field of resourceFields) {
    const requested = resources[field];
    if (requested === null) continue;
    if (values[field] !== null && values[field] !== requested) {
      throw new ExecutionAttemptError(
        "resource_conflict",
        `${field} is already recorded as ${String(values[field])}; it cannot change within an attempt`,
        { field, recorded: values[field], requested },
      );
    }
    if (values[field] === null) recorded[field] = requested;
    values[field] = requested;
  }
  const artifacts = parseJson<ArtifactRef[]>(row.artifacts, []);
  if (artifacts.length + resources.artifacts.length > maxArtifactsPerAttempt) {
    throw invalid(`an attempt holds at most ${maxArtifactsPerAttempt} artifact references`, { field: "artifacts" });
  }
  const added = resources.artifacts.map((artifact) => ({ ...artifact, revision }));
  if (added.length) recorded.artifacts = added;
  return { values: { ...values, artifacts: json([...artifacts, ...added]) }, recorded };
}

function parseResources(input: TransitionExecutionAttemptInput): ResourceInput {
  const workspace = objectInput(input.workspace, "workspace");
  const processInput = objectInput(input.process, "process");
  let processId: number | null = null;
  if (processInput && processInput.pid !== undefined && processInput.pid !== null) {
    if (typeof processInput.pid !== "number" || !Number.isSafeInteger(processInput.pid) || processInput.pid < 1) {
      throw invalid("process.pid must be a positive integer", { field: "process.pid" });
    }
    processId = processInput.pid;
  }
  const artifactsInput = input.artifacts === undefined || input.artifacts === null ? [] : input.artifacts;
  if (!Array.isArray(artifactsInput)) throw invalid("artifacts must be an array", { field: "artifacts" });
  if (artifactsInput.length > maxArtifactsPerTransition) {
    throw invalid(`a transition records at most ${maxArtifactsPerTransition} artifact references`, { field: "artifacts" });
  }
  const artifacts = artifactsInput.map((entry, index) => {
    const item = objectInput(entry, `artifacts[${index}]`);
    if (!item) throw invalid(`artifacts[${index}] must be an object`, { field: `artifacts[${index}]` });
    const kind = requiredText(item.kind, `artifacts[${index}].kind`, 50);
    if (!artifactKindPattern.test(kind)) {
      throw invalid(`artifacts[${index}].kind must be a lowercase identifier such as harness_log`, { field: `artifacts[${index}].kind` });
    }
    return { kind, ref: requiredText(item.ref, `artifacts[${index}].ref`, 2000) };
  });
  return {
    branch: optionalText(workspace?.branch, "workspace.branch", 250),
    worktree_path: optionalText(workspace?.worktree_path, "workspace.worktree_path", 4096),
    lease_id: optionalText(workspace?.lease_id, "workspace.lease_id", 200),
    process_id: processId,
    process_started_at: optionalText(processInput?.started_at, "process.started_at", 40),
    artifacts,
  };
}

// Run details recorded in the ledger alongside a transition. Resource bindings
// recorded by the same transition take precedence over keys of the same name.
function detailsInput(value: unknown) {
  const details = objectInput(value, "details") ?? {};
  if (json(details).length > maxTransitionDetailsCharacters) {
    throw invalid(`details must serialize to at most ${maxTransitionDetailsCharacters} characters`, { field: "details" });
  }
  return details;
}

function actorInput(input: TransitionExecutionAttemptInput) {
  if (input.actor && typeof input.actor === "object" && !Array.isArray(input.actor)) {
    const actor = input.actor as Record<string, unknown>;
    return { kind: typeof actor.kind === "string" ? actor.kind : "", id: typeof actor.id === "string" ? actor.id : "" };
  }
  return {
    kind: typeof input.actor_kind === "string" ? input.actor_kind : "",
    id: typeof input.actor_id === "string" ? input.actor_id : "",
  };
}

// HTTP query strings and CLI JSON may carry the revision as a numeric string; any
// other shape goes through unchanged so the contract rejects it as invalid_request.
function revisionInput(value: unknown) {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return value as number;
}

function liveAttemptExists(label: string, issueId: string, attemptId: string | null, state: string | null) {
  return new ExecutionAttemptError(
    "live_attempt_exists",
    `Issue ${label} already has a live execution attempt${attemptId ? ` (${attemptId}, ${state})` : ""}; end it before starting another`,
    { issue_id: issueId, attempt_id: attemptId, state },
  );
}

function issueClosedState(issue: IssueRow) {
  if (issue.archived_at) return "archived";
  const status = String(issue.status ?? "").trim().toLowerCase();
  if (issue.status_type === "completed" || status === "done" || status === "completed") return "completed";
  if (issue.status_type === "canceled" || status === "canceled" || status === "cancelled") return "canceled";
  return null;
}

// Attempt records must never hold credentials. A remote carrying them is refused
// rather than silently stripped, so the caller learns it was about to store one.
// An ssh:// username such as git@ is an account name, not a secret, and stays.
function hasUrlCredentials(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.password) return true;
    return Boolean(parsed.username) && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(value);
  }
}

function provenanceJson(value: unknown) {
  if (value === undefined || value === null) return "{}";
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("provenance must be an object", { field: "provenance" });
  const serialized = json(value);
  if (serialized.length > maxProvenanceCharacters) {
    throw invalid(`provenance must serialize to at most ${maxProvenanceCharacters} characters`, { field: "provenance" });
  }
  return serialized;
}

function stateFilter(value: unknown): ExecutionState[] {
  if (value === undefined || value === null || value === "") return [];
  const values = Array.isArray(value) ? value : String(value).split(",");
  return values.map((entry) => {
    const state = typeof entry === "string" ? entry.trim() : entry;
    if (!isExecutionState(state)) throw invalid(`Unknown execution state: ${String(entry)}`, { field: "state" });
    return state;
  });
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

function objectInput(value: unknown, field: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw invalid(`${field} must be an object`, { field });
  return value as Record<string, unknown>;
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
  return new ExecutionAttemptError("invalid_input", message, details);
}

// SQLite reports "UNIQUE constraint failed: <table>.<columns>"; Postgres reports
// SQLSTATE 23505 with the constraint name. The marker matches either spelling.
function isUniqueViolation(error: unknown, marker: string) {
  const record = (error ?? {}) as { code?: unknown; constraint_name?: unknown; message?: unknown };
  const message = String(record.message ?? "");
  if (record.code === "23505") return `${String(record.constraint_name ?? "")} ${message}`.includes(marker);
  return message.includes("UNIQUE constraint failed") && message.includes(marker);
}
