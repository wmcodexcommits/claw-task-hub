// Structured, schema-versioned evidence for execution attempts.
//
// Prose cannot be checked by a machine, so an attempt's evidence is stored as
// typed, append-only records: the diff of the leased worktree against the pinned
// base (touched files, line counts, a patch hash, and the Git tree fingerprint of
// the exact content), observations of verification steps (command, exit status,
// duration, bounded and scrubbed logs, tool versions), claims that are recorded
// but never counted as observations (formal proofs, external attestations), and
// verdicts from evaluating a verification policy. Records are never updated; a
// correction is a new record that supersedes the old one.
//
// Observation is kept apart from judgment. A verdict is the only record that says
// whether evidence satisfied a policy, and even a passing verdict only makes an
// attempt reviewable -- acceptance is a separate decision. Policies are operator
// configuration keyed by repository and revisioned the same way; the repository's
// own files never define what verification means or which programs it runs.
//
// Staleness is decided by content, not time: every observation carries the tree
// fingerprint it was made against, and evidence for any other fingerprint does
// not count toward the worktree's current state. Fingerprints and diffs come from
// a scratch index, so the worktree's own index and files are never touched.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { customAlphabet } from "nanoid";
import { adapter, json, nowIso, parseJson, resolveDbPath } from "./db.js";
import { allowlistedEnvironment, declaredSecretValues, locateExecutable } from "./execution-adapters.js";
import { executionEvidenceKinds, observationStatuses } from "./execution-attempts-schema.js";
import { getExecutionAttempt, transitionExecutionAttempt } from "./execution-attempts.js";
import { detectExecutionConflicts, listExecutionConflicts } from "./execution-conflicts.js";
import { executionActorKinds, executionBounds } from "./execution-contract.js";
import { BoundedCapture, scrub } from "./execution-runs.js";
import { gitEnvironment, gitSafetyArgs, listExecutionWorkspaces, runGit } from "./execution-workspaces.js";
import { terminateProcessTree, waitForExit, type TerminationOutcome } from "./process-tree.js";

const execFileAsync = promisify(execFile);
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export const EXECUTION_EVIDENCE_SCHEMA_VERSION = "execution-evidence/v1";
export const VERIFICATION_POLICY_SCHEMA_VERSION = "verification-policy/v1";

export const executionEvidenceErrorCodes = [
  "invalid_input",
  "attempt_not_found",
  "attempt_not_verifying",
  "workspace_not_ready",
  "policy_not_found",
  "policy_conflict",
  "schema_unsupported",
  "evidence_not_found",
  "git_failed",
] as const;
export type ExecutionEvidenceErrorCode = (typeof executionEvidenceErrorCodes)[number];

export class ExecutionEvidenceError extends Error {
  readonly code: ExecutionEvidenceErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ExecutionEvidenceErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "ExecutionEvidenceError";
    this.code = code;
    this.details = details;
  }
}

export type SaveVerificationPolicyInput = {
  repository?: unknown;
  steps?: unknown;
  require_changes?: unknown;
  actor_kind?: unknown;
  actor_id?: unknown;
  note?: unknown;
};

export type RecordExecutionEvidenceInput = {
  attempt_id?: unknown;
  kind?: unknown;
  schema_version?: unknown;
  name?: unknown;
  status?: unknown;
  exit_code?: unknown;
  duration_ms?: unknown;
  command?: unknown;
  summary?: unknown;
  log?: unknown;
  artifacts?: unknown;
  tool_versions?: unknown;
  tree_fingerprint?: unknown;
  supersedes?: unknown;
  actor_kind?: unknown;
  actor_id?: unknown;
};

export type VerifyExecutionAttemptInput = {
  attempt_id?: unknown;
  run_steps?: unknown;
  idempotency_key?: unknown;
  step_timeout_ms?: unknown;
  cancellation_grace_ms?: unknown;
  captured_stream_bytes?: unknown;
};

type AttemptView = NonNullable<Awaited<ReturnType<typeof getExecutionAttempt>>>;
type Actor = { kind: string; id: string };
type ArtifactRef = { kind: string; ref: string };
type PolicyStep = { name: string; command: string[]; version_command: string[] | null; timeout_ms: number; required: boolean };
type StepBounds = { timeout_ms: number; grace_ms: number; capture_bytes: number };
type FindingOutcome = "passed" | "checks_failed" | "evidence_missing" | "stale_base_evidence";
type Finding = { rule: string; step: string | null; outcome: FindingOutcome; evidence_id: string | null; detail: string | null };

type PolicyRow = {
  id: string;
  repository: string;
  revision: number | string;
  schema_version: string;
  require_changes: number | string;
  steps: string;
  created_by_kind: string;
  created_by_id: string;
  note: string | null;
  created_at: string;
};

type EvidenceRow = {
  id: string;
  attempt_id: string;
  sequence: number | string;
  kind: string;
  schema_version: string;
  name: string | null;
  status: string;
  attempt_revision: number | string;
  base_sha: string;
  tree_fingerprint: string | null;
  supersedes: string | null;
  payload: string | null;
  artifacts: string | null;
  provenance: string | null;
  created_at: string;
};

type EvidenceEntry = {
  id: string;
  attempt: AttemptView;
  kind: string;
  name: string | null;
  status: string;
  tree_fingerprint: string | null;
  supersedes: string | null;
  payload: Record<string, unknown>;
  artifacts: ArtifactRef[];
  provenance: Record<string, unknown>;
};

const stepNamePattern = /^[a-z][a-z0-9_-]{0,59}$/;
const fingerprintPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const artifactKindPattern = /^[a-z][a-z0-9_]{0,49}$/;
const maxPolicySteps = 20;
const maxArguments = 100;
const maxArgumentCharacters = 4096;
const maxDiffFiles = 5000;
const statePollMs = 500;
const streamDrainMs = 2_000;
const versionProbeMs = 15_000;
const patchTimeoutMs = 120_000;

// --- verification policies ------------------------------------------------------

export async function saveVerificationPolicy(input: SaveVerificationPolicyInput) {
  const repository = requiredText(input.repository, "repository", 2000);
  const steps = policySteps(input.steps);
  const requireChanges = booleanInput(input.require_changes, true);
  const actorKind = requiredText(input.actor_kind, "actor_kind", 40);
  if (actorKind !== "operator") {
    throw invalid("verification policies are operator configuration; actor_kind must be operator", { field: "actor_kind" });
  }
  const actorId = requiredText(input.actor_id, "actor_id", 200);
  const note = optionalText(input.note, "note", 2000);

  return await adapter.transaction(async () => {
    const latest = await adapter.get<{ revision: number | string | null }>(
      "SELECT MAX(revision) AS revision FROM verification_policies WHERE repository = @repository",
      { repository },
    );
    const id = `policy_${nanoid()}`;
    try {
      await adapter.run(`
        INSERT INTO verification_policies (
          id, repository, revision, schema_version, require_changes, steps, created_by_kind, created_by_id, note, created_at
        ) VALUES (
          @id, @repository, @revision, @schema_version, @require_changes, @steps, @created_by_kind, @created_by_id, @note, @created_at
        )
      `, {
        id,
        repository,
        revision: Number(latest?.revision ?? 0) + 1,
        schema_version: VERIFICATION_POLICY_SCHEMA_VERSION,
        require_changes: requireChanges ? 1 : 0,
        steps: json(steps),
        created_by_kind: actorKind,
        created_by_id: actorId,
        note,
        created_at: nowIso(),
      });
    } catch (error) {
      if (isUniqueViolation(error, "revision")) {
        throw new ExecutionEvidenceError("policy_conflict", `Another revision of the policy for ${repository} was saved at the same time; retry`, { repository });
      }
      throw error;
    }
    const row = await adapter.get<PolicyRow>("SELECT * FROM verification_policies WHERE id = @id", { id });
    if (!row) throw new ExecutionEvidenceError("policy_not_found", `Policy ${id} was not readable after it was saved`, { policy_id: id });
    return { policy: hydratePolicy(row) };
  });
}

export async function getVerificationPolicy(input: { repository?: unknown; revision?: unknown }) {
  const repository = requiredText(input.repository, "repository", 2000);
  const revision = input.revision === undefined || input.revision === null || input.revision === ""
    ? null
    : boundedInteger(input.revision, "revision", 1, Number.MAX_SAFE_INTEGER);
  const row = revision === null
    ? await adapter.get<PolicyRow>("SELECT * FROM verification_policies WHERE repository = @repository ORDER BY revision DESC LIMIT 1", { repository })
    : await adapter.get<PolicyRow>("SELECT * FROM verification_policies WHERE repository = @repository AND revision = @revision", { repository, revision });
  return { policy: row ? hydratePolicy(row) : null };
}

function hydratePolicy(row: PolicyRow) {
  return {
    id: row.id,
    repository: row.repository,
    revision: Number(row.revision),
    schema_version: row.schema_version,
    require_changes: Number(row.require_changes) === 1,
    steps: parseJson<PolicyStep[]>(row.steps, []),
    created_by: { kind: row.created_by_kind, id: row.created_by_id },
    note: row.note,
    created_at: row.created_at,
  };
}

type PolicyView = ReturnType<typeof hydratePolicy>;

function policySteps(value: unknown): PolicyStep[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxPolicySteps) {
    throw invalid(`steps must be an array of 1 to ${maxPolicySteps} steps`, { field: "steps" });
  }
  const names = new Set<string>();
  return value.map((entry, index) => {
    const field = `steps[${index}]`;
    const step = objectInput(entry, field);
    if (!step) throw invalid(`${field} must be an object`, { field });
    const name = requiredText(step.name, `${field}.name`, 60);
    if (!stepNamePattern.test(name)) throw invalid(`${field}.name must be a lowercase identifier such as unit or lint`, { field: `${field}.name` });
    if (names.has(name)) throw invalid(`step ${name} is listed twice`, { field: `${field}.name` });
    names.add(name);
    return {
      name,
      command: executableCommand(step.command, `${field}.command`),
      version_command: step.version_command === undefined || step.version_command === null
        ? null
        : executableCommand(step.version_command, `${field}.version_command`),
      timeout_ms: boundedInteger(step.timeout_ms, `${field}.timeout_ms`, 100, executionBounds.verification_step.value),
      required: booleanInput(step.required, true),
    };
  });
}

// A command the hub will run: an argument vector, never a shell string, whose
// executable is absolute or found on PATH -- never a path inside the repository,
// whose contents are untrusted.
function executableCommand(value: unknown, field: string) {
  const vector = argumentVector(value, field);
  if (!isAbsolute(vector[0]) && /[\\/]/.test(vector[0])) {
    throw invalid(`${field}[0] must be an absolute path or a program name found on PATH, not a path inside the repository`, { field });
  }
  return vector;
}

function argumentVector(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxArguments) {
    throw invalid(`${field} must be an argument vector (an array of 1 to ${maxArguments} strings), not a shell command`, { field });
  }
  return value.map((argument, index) => {
    if (typeof argument !== "string" || argument.length > maxArgumentCharacters || (index === 0 && !argument.trim())) {
      throw invalid(`${field}[${index}] must be a string of at most ${maxArgumentCharacters} characters`, { field });
    }
    return argument;
  });
}

// --- evidence ---------------------------------------------------------------------

export async function captureExecutionDiff(input: { attempt_id?: unknown; actor_kind?: unknown; actor_id?: unknown }) {
  const attemptId = requiredText(input.attempt_id, "attempt_id", 200);
  const actor = input.actor_kind === undefined ? { kind: "control_plane", id: "evidence" } : requiredActor(input);
  const attempt = await requireAttempt(attemptId);
  const worktree = await requireWorktree(attempt);
  const evidence = await createDiffEvidence(attempt, worktree, actor, executionBounds.captured_stream.value);
  // A new diff changes what the attempt has touched, so its repository's
  // conflicts are re-detected against it.
  await detectExecutionConflicts({ attempt_id: attempt.id });
  return { evidence, conflicts: await listExecutionConflicts({ attempt_id: attempt.id }) };
}

export async function recordExecutionEvidence(input: RecordExecutionEvidenceInput) {
  const attemptId = requiredText(input.attempt_id, "attempt_id", 200);
  const schemaVersion = optionalText(input.schema_version, "schema_version", 60) ?? EXECUTION_EVIDENCE_SCHEMA_VERSION;
  if (schemaVersion !== EXECUTION_EVIDENCE_SCHEMA_VERSION) {
    throw new ExecutionEvidenceError(
      "schema_unsupported",
      `schema_version ${schemaVersion} is not supported; this hub records ${EXECUTION_EVIDENCE_SCHEMA_VERSION}`,
      { schema_version: schemaVersion, supported: [EXECUTION_EVIDENCE_SCHEMA_VERSION] },
    );
  }
  const kind = requiredText(input.kind, "kind", 20);
  if (kind !== "observation" && kind !== "claim") {
    throw invalid("kind must be observation or claim; diffs and verdicts are produced by the hub itself", { field: "kind" });
  }
  const name = requiredText(input.name, "name", 60);
  if (!stepNamePattern.test(name)) throw invalid("name must be a lowercase identifier such as unit or external-ci", { field: "name" });
  let status = "recorded";
  if (kind === "observation") {
    status = requiredText(input.status, "status", 20);
    if (!(observationStatuses as readonly string[]).includes(status)) {
      throw invalid(`status must be one of ${observationStatuses.join(", ")}`, { field: "status" });
    }
  }
  const actor = requiredActor(input);
  const exitCode = optionalInteger(input.exit_code, "exit_code", -2_147_483_648, 2_147_483_647);
  const durationMs = optionalInteger(input.duration_ms, "duration_ms", 0, Number.MAX_SAFE_INTEGER);
  const command = input.command === undefined || input.command === null ? null : argumentVector(input.command, "command");
  const summary = optionalText(input.summary, "summary", 2000);
  if (input.log !== undefined && input.log !== null && typeof input.log !== "string") throw invalid("log must be a string", { field: "log" });
  const log = typeof input.log === "string" ? input.log : null;
  const artifacts = artifactReferences(input.artifacts);
  const toolVersionsInput = stringMap(input.tool_versions, "tool_versions");
  const fingerprintInput = optionalText(input.tree_fingerprint, "tree_fingerprint", 64);
  if (fingerprintInput && !fingerprintPattern.test(fingerprintInput)) throw invalid("tree_fingerprint must be a Git tree id", { field: "tree_fingerprint" });
  const supersedes = optionalText(input.supersedes, "supersedes", 200);

  const attempt = await requireAttempt(attemptId);
  if (supersedes) {
    const prior = await adapter.get<EvidenceRow>("SELECT * FROM execution_evidence WHERE id = @id", { id: supersedes });
    if (!prior || prior.attempt_id !== attempt.id || prior.kind !== kind || prior.name !== name) {
      throw invalid(`supersedes must name earlier ${kind} evidence called ${name} on the same attempt`, { field: "supersedes" });
    }
  }
  const fingerprint = fingerprintInput ?? await worktreeFingerprint(attempt, await requireWorktree(attempt));
  const secrets = declaredSecretValues();
  const id = `evidence_${nanoid()}`;
  let logBytes: number | null = null;
  let logTruncated: boolean | null = null;
  if (log !== null) {
    const capture = new BoundedCapture(executionBounds.captured_stream.value);
    capture.push(Buffer.from(log, "utf8"));
    const path = join(evidenceDirectory(attempt.id), `${id}-log.txt`);
    writeFileSync(path, scrub(capture.text(), secrets), "utf8");
    artifacts.push({ kind: "evidence_log", ref: path });
    logBytes = capture.total;
    logTruncated = capture.truncated;
  }
  const evidence = await appendEvidence({
    id,
    attempt,
    kind,
    name,
    status,
    tree_fingerprint: fingerprint,
    supersedes,
    payload: {
      exit_code: exitCode,
      duration_ms: durationMs,
      command: command ? command.map((argument) => scrub(argument, secrets)) : null,
      summary: summary ? scrub(summary, secrets) : null,
      log_bytes: logBytes,
      log_truncated: logTruncated,
    },
    artifacts,
    provenance: { actor, source: "recorded", tool_versions: toolVersionsInput },
  });
  return { evidence };
}

export async function listExecutionEvidence(input: { attempt_id?: unknown; kind?: unknown; name?: unknown }) {
  const attemptId = requiredText(input.attempt_id, "attempt_id", 200);
  const where = ["attempt_id = @attempt_id"];
  const params: Record<string, unknown> = { attempt_id: attemptId };
  const kind = optionalText(input.kind, "kind", 20);
  if (kind) {
    if (!(executionEvidenceKinds as readonly string[]).includes(kind)) throw invalid(`kind must be one of ${executionEvidenceKinds.join(", ")}`, { field: "kind" });
    where.push("kind = @kind");
    params.kind = kind;
  }
  const name = optionalText(input.name, "name", 60);
  if (name) {
    where.push("name = @name");
    params.name = name;
  }
  const rows = await adapter.all<EvidenceRow>(`SELECT * FROM execution_evidence WHERE ${where.join(" AND ")} ORDER BY sequence`, params);
  return rows.map(hydrateEvidence);
}

export async function getExecutionEvidence(id: string) {
  const row = await adapter.get<EvidenceRow>("SELECT * FROM execution_evidence WHERE id = @id", { id });
  return row ? hydrateEvidence(row) : null;
}

// --- verification -------------------------------------------------------------------

export async function verifyExecutionAttempt(input: VerifyExecutionAttemptInput) {
  const attemptId = requiredText(input.attempt_id, "attempt_id", 200);
  const runSteps = booleanInput(input.run_steps, true);
  const idempotencyKey = optionalText(input.idempotency_key, "idempotency_key", executionBounds.idempotency_key.value);
  const bounds: StepBounds = {
    timeout_ms: boundedInteger(input.step_timeout_ms, "step_timeout_ms", 100, executionBounds.verification_step.value),
    grace_ms: boundedInteger(input.cancellation_grace_ms, "cancellation_grace_ms", 0, executionBounds.cancellation_grace.value),
    capture_bytes: boundedInteger(input.captured_stream_bytes, "captured_stream_bytes", 1024, executionBounds.captured_stream.value),
  };

  const attempt = await requireAttempt(attemptId);
  if (attempt.state !== "verifying") {
    throw new ExecutionEvidenceError("attempt_not_verifying", `Attempt ${attempt.id} is ${attempt.state}; only an attempt in verifying can be verified`, { attempt_id: attempt.id, state: attempt.state });
  }
  const { policy } = await getVerificationPolicy({ repository: attempt.repository });
  if (!policy) {
    throw new ExecutionEvidenceError(
      "policy_not_found",
      `No verification policy is configured for ${attempt.repository}; an attempt cannot become reviewable without one`,
      { repository: attempt.repository },
    );
  }
  const worktree = await requireWorktree(attempt);
  const verifier: Actor = { kind: "control_plane", id: "verifier" };
  const diff = await createDiffEvidence(attempt, worktree, verifier, bounds.capture_bytes);
  const startFingerprint = diff.tree_fingerprint ?? "";
  // Review needs to see what this attempt's changes overlap. Conflicts never
  // change the verdict here; acceptance is where blocking conflicts are decided.
  await detectExecutionConflicts({ attempt_id: attempt.id });
  const conflicts = await listExecutionConflicts({ attempt_id: attempt.id });

  const observations: ReturnType<typeof hydrateEvidence>[] = [];
  let stoppedByState: string | null = null;
  if (runSteps) {
    for (const step of policy.steps) {
      const observed = await runPolicyStep(attempt, worktree, step, startFingerprint, bounds);
      observations.push(observed.evidence);
      if (observed.stoppedByState) {
        stoppedByState = observed.stoppedByState;
        break;
      }
    }
  }
  if (stoppedByState) {
    return { attempt: await getExecutionAttempt(attempt.id), policy, diff, conflicts, observations, verdict: null, transition: null, transition_error: null, stopped_by_state: stoppedByState };
  }

  const fingerprint = runSteps ? await worktreeFingerprint(attempt, worktree) : startFingerprint;
  const evaluation = await evaluatePolicy(attempt, policy, fingerprint, diff.payload, runSteps && fingerprint !== startFingerprint);
  const verdict = await appendEvidence({
    id: `evidence_${nanoid()}`,
    attempt,
    kind: "verdict",
    name: null,
    status: evaluation.passed ? "passed" : "failed",
    tree_fingerprint: fingerprint,
    supersedes: null,
    payload: {
      policy_id: policy.id,
      policy_revision: policy.revision,
      require_changes: policy.require_changes,
      reason: evaluation.reason,
      findings: evaluation.findings,
      diff_evidence_id: diff.id,
      observation_ids: observations.map((observation) => observation.id),
      ran_steps: runSteps,
      conflicts: conflicts.map((conflict) => ({
        id: conflict.id,
        path: conflict.path,
        method: conflict.method,
        certainty: conflict.certainty,
        severity: conflict.severity,
        status: conflict.status,
        blocking: conflict.blocking,
        other_attempt_id: conflict.attempts.find((other) => other.id !== attempt.id)?.id ?? null,
      })),
    },
    artifacts: [],
    provenance: { actor: verifier, tools: await toolVersions() },
  });

  let transition: "applied" | "replayed" | null = null;
  let transitionError: string | null = null;
  try {
    const moved = await transitionExecutionAttempt({
      attempt_id: attempt.id,
      event: evaluation.passed ? "pass_verification" : "fail_verification",
      expected_revision: attempt.revision,
      idempotency_key: idempotencyKey ?? `verify:${verdict.id}`,
      actor_kind: verifier.kind,
      actor_id: verifier.id,
      reason: evaluation.reason,
      details: {
        verdict_id: verdict.id,
        policy_id: policy.id,
        policy_revision: policy.revision,
        tree_fingerprint: fingerprint,
        findings: evaluation.findings.slice(0, 50),
      },
    });
    transition = moved.outcome;
  } catch (error) {
    transitionError = errorMessage(error);
  }
  return { attempt: await getExecutionAttempt(attempt.id), policy, diff, conflicts, observations, verdict, transition, transition_error: transitionError, stopped_by_state: null };
}

async function evaluatePolicy(attempt: AttemptView, policy: PolicyView, fingerprint: string, diffPayload: Record<string, unknown>, stepsChangedWorktree: boolean) {
  const findings: Finding[] = [];
  if (stepsChangedWorktree) {
    findings.push({ rule: "steps_leave_worktree_unchanged", step: null, outcome: "stale_base_evidence", evidence_id: null, detail: "verification steps changed tracked or unignored files, so the evidence describes content that no longer exists" });
  }
  const totals = (diffPayload.totals ?? {}) as { files?: number };
  if (policy.require_changes && (totals.files ?? 0) === 0) {
    findings.push({ rule: "require_changes", step: null, outcome: "checks_failed", evidence_id: null, detail: "the worktree has no changes against the base commit" });
  }
  const observations = (await listExecutionEvidence({ attempt_id: attempt.id, kind: "observation" }));
  const superseded = new Set(observations.map((observation) => observation.supersedes).filter((id): id is string => Boolean(id)));
  for (const step of policy.steps.filter((candidate) => candidate.required)) {
    const candidates = observations.filter((observation) => observation.name === step.name && !superseded.has(observation.id));
    const current = candidates.filter((observation) => observation.tree_fingerprint === fingerprint);
    const latest = (current.length ? current : candidates).at(-1);
    if (!latest) {
      findings.push({ rule: "required_step", step: step.name, outcome: "evidence_missing", evidence_id: null, detail: "no observation was recorded for this step" });
      continue;
    }
    if (latest.tree_fingerprint !== fingerprint) {
      findings.push({ rule: "required_step", step: step.name, outcome: "stale_base_evidence", evidence_id: latest.id, detail: `observed against tree ${latest.tree_fingerprint}, not ${fingerprint}` });
      continue;
    }
    if (latest.status !== "passed") {
      findings.push({ rule: "required_step", step: step.name, outcome: "checks_failed", evidence_id: latest.id, detail: `the step ${latest.status}` });
      continue;
    }
    // Local artifact paths must still exist; other references (URLs) are recorded as given.
    const missing = latest.artifacts.find((artifact) => isAbsolute(artifact.ref) && !existsSync(artifact.ref));
    if (missing) {
      findings.push({ rule: "required_step", step: step.name, outcome: "evidence_missing", evidence_id: latest.id, detail: `artifact ${missing.kind} is missing at ${missing.ref}` });
      continue;
    }
    findings.push({ rule: "required_step", step: step.name, outcome: "passed", evidence_id: latest.id, detail: null });
  }
  const failed = findings.filter((finding) => finding.outcome !== "passed");
  const reason = failed.some((finding) => finding.outcome === "checks_failed")
    ? "checks_failed"
    : failed.some((finding) => finding.outcome === "stale_base_evidence")
      ? "stale_base_evidence"
      : failed.length ? "evidence_missing" : null;
  return { passed: failed.length === 0, reason, findings };
}

async function runPolicyStep(attempt: AttemptView, worktree: string, step: PolicyStep, fingerprint: string, bounds: StepBounds) {
  const id = `evidence_${nanoid()}`;
  const secrets = declaredSecretValues();
  const command = step.command.map((argument) => scrub(argument, secrets));
  const executable = step.command[0];
  const location = locateExecutable(executable, isAbsolute(executable) ? executable : undefined, `step ${step.name}`);
  const provenance: Record<string, unknown> = { actor: { kind: "control_plane", id: "verifier" }, tools: await toolVersions() };
  if (!location.ok) {
    const evidence = await appendEvidence({
      id, attempt, kind: "observation", name: step.name, status: "error", tree_fingerprint: fingerprint, supersedes: null,
      payload: { command, exit_code: null, duration_ms: 0, error: location.reason, required: step.required },
      artifacts: [],
      provenance,
    });
    return { evidence, stoppedByState: null };
  }
  const env = { ...allowlistedEnvironment(), CLAW_TASK_HUB_ATTEMPT_ID: attempt.id, CLAW_TASK_HUB_WORKTREE: worktree };
  provenance.executable = basename(location.command);
  provenance.tool_version = step.version_command ? await probeVersion(step.version_command, worktree, env) : null;
  const timeoutMs = Math.min(step.timeout_ms, bounds.timeout_ms);
  const run = await runBounded(location.command, step.command.slice(1), worktree, env, timeoutMs, bounds, attempt.id);
  const directory = evidenceDirectory(attempt.id);
  const stdoutPath = join(directory, `${id}-stdout.log`);
  const stderrPath = join(directory, `${id}-stderr.log`);
  writeFileSync(stdoutPath, scrub(run.stdout.text(), secrets), "utf8");
  writeFileSync(stderrPath, scrub(run.stderr.text(), secrets), "utf8");
  const status = run.error ? "error" : run.stoppedByState ? "canceled" : run.timedOut ? "timed_out" : run.exitCode === 0 ? "passed" : "failed";
  const evidence = await appendEvidence({
    id,
    attempt,
    kind: "observation",
    name: step.name,
    status,
    tree_fingerprint: fingerprint,
    supersedes: null,
    payload: {
      command,
      exit_code: run.exitCode,
      signal: run.signal,
      duration_ms: run.durationMs,
      timeout_ms: timeoutMs,
      termination: run.termination,
      stdout_bytes: run.stdout.total,
      stderr_bytes: run.stderr.total,
      stdout_truncated: run.stdout.truncated,
      stderr_truncated: run.stderr.truncated,
      error: run.error,
      required: step.required,
    },
    artifacts: [{ kind: "step_stdout", ref: stdoutPath }, { kind: "step_stderr", ref: stderrPath }],
    provenance,
  });
  return { evidence, stoppedByState: run.stoppedByState };
}

// Runs one command with the contract's bounds: no shell, the process tree as the
// unit of termination, captured output kept to a head and tail, and the attempt
// watched so a cancellation from any process stops the step.
async function runBounded(command: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number, bounds: StepBounds, attemptId: string) {
  const stdout = new BoundedCapture(bounds.capture_bytes);
  const stderr = new BoundedCapture(bounds.capture_bytes);
  const started = Date.now();
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  const closed = new Promise<boolean>((resolve) => child.once("close", () => resolve(true)));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
  } catch (error) {
    return { stdout, stderr, exitCode: null, signal: null, durationMs: Date.now() - started, timedOut: false, stoppedByState: null, termination: null, error: errorMessage(error) };
  }
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  // Held in an object: these are assigned from timer and poll callbacks, and plain
  // locals would be narrowed to their initial values where they are read below.
  const state: { timedOut: boolean; stoppedByState: string | null; stopping: Promise<TerminationOutcome> | null; polling: boolean } = {
    timedOut: false,
    stoppedByState: null,
    stopping: null,
    polling: false,
  };
  const stop = () => {
    state.stopping ??= terminateProcessTree(child, bounds.grace_ms);
  };
  const timer = setTimeout(() => {
    state.timedOut = true;
    stop();
  }, timeoutMs);
  const watch = setInterval(() => {
    if (state.polling || state.stopping) return;
    state.polling = true;
    void getExecutionAttempt(attemptId)
      .then((current) => {
        if (current && current.state !== "verifying") {
          state.stoppedByState = current.state;
          stop();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        state.polling = false;
      });
  }, statePollMs);

  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  clearInterval(watch);
  const drained = await Promise.race([closed, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), streamDrainMs))]);
  if (!drained) {
    stop();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  const termination = state.stopping ? await state.stopping : null;
  await waitForExit(child, 1_000);
  return {
    stdout,
    stderr,
    exitCode: exit.code,
    signal: exit.signal,
    durationMs: Date.now() - started,
    timedOut: state.timedOut,
    stoppedByState: state.stoppedByState,
    termination,
    error: null,
  };
}

async function probeVersion(vector: string[], cwd: string, env: Record<string, string>) {
  const location = locateExecutable(vector[0], isAbsolute(vector[0]) ? vector[0] : undefined, "version_command");
  if (!location.ok) return null;
  try {
    const { stdout } = await execFileAsync(location.command, vector.slice(1), { cwd, env, timeout: versionProbeMs, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 });
    return stdout.trim().split(/\r?\n/)[0]?.slice(0, 200) || null;
  } catch {
    return null;
  }
}

// --- diffs and fingerprints ------------------------------------------------------------

async function createDiffEvidence(attempt: AttemptView, worktree: string, actor: Actor, captureBytes: number) {
  const scratch = await stageScratchIndex(attempt, worktree);
  try {
    const raw = await gitStep(worktree, ["diff", "--cached", "--raw", "-z", "-M", "--no-abbrev", attempt.base_sha], scratch.env, "Listing touched files", false);
    const numstat = await gitStep(worktree, ["diff", "--cached", "--numstat", "-z", "-M", attempt.base_sha], scratch.env, "Counting changed lines", false);
    const files = parseDiff(raw, numstat);
    const patch = await streamPatch(worktree, attempt.base_sha, scratch.env, captureBytes);
    const id = `evidence_${nanoid()}`;
    const patchPath = join(evidenceDirectory(attempt.id), `${id}.patch`);
    writeFileSync(patchPath, scrub(patch.text, declaredSecretValues()), "utf8");
    return await appendEvidence({
      id,
      attempt,
      kind: "diff",
      name: null,
      status: "recorded",
      tree_fingerprint: scratch.fingerprint,
      supersedes: null,
      payload: {
        files: files.slice(0, maxDiffFiles),
        files_truncated: files.length > maxDiffFiles,
        totals: {
          files: files.length,
          added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
          deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
          binary: files.filter((file) => file.binary).length,
        },
        // The hash covers the complete patch; the stored artifact is bounded and scrubbed.
        patch: { sha256: patch.sha256, bytes: patch.bytes, truncated: patch.truncated },
      },
      artifacts: [{ kind: "diff_patch", ref: patchPath }],
      provenance: { actor, tools: await toolVersions() },
    });
  } finally {
    scratch.cleanup();
  }
}

// Stages the worktree into a throwaway index seeded from the base commit. Its
// tree id is the fingerprint of the exact content (ignored files excluded), and
// diffing it against the base covers new files without touching the real index.
async function stageScratchIndex(attempt: AttemptView, worktree: string) {
  const indexPath = join(evidenceDirectory(attempt.id), `scratch-${nanoid()}.index`);
  const env = { GIT_INDEX_FILE: indexPath };
  const cleanup = () => {
    rmSync(indexPath, { force: true });
    rmSync(`${indexPath}.lock`, { force: true });
  };
  try {
    await gitStep(worktree, ["read-tree", attempt.base_sha], env, "Loading the base commit into a scratch index");
    await gitStep(worktree, ["add", "-A"], env, "Staging the worktree into the scratch index");
    const fingerprint = await gitStep(worktree, ["write-tree"], env, "Fingerprinting the worktree");
    return { env, fingerprint, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function worktreeFingerprint(attempt: AttemptView, worktree: string) {
  const scratch = await stageScratchIndex(attempt, worktree);
  scratch.cleanup();
  return scratch.fingerprint;
}

type TouchedFile = {
  status: string;
  path: string;
  previous_path: string | null;
  similarity: number | null;
  old_mode: string;
  new_mode: string;
  old_blob: string;
  new_blob: string;
  added: number | null;
  deleted: number | null;
  binary: boolean;
};

// `--raw -z` records are ":<old mode> <new mode> <old blob> <new blob> <status>"
// then NUL, the path, NUL, and for renames and copies a second path and NUL.
// `--numstat -z` records are "<added>\t<deleted>\t<path>" then NUL, with "-" for
// binary counts; renames leave the path empty and follow with old NUL new NUL.
function parseDiff(raw: string, numstat: string): TouchedFile[] {
  const files: TouchedFile[] = [];
  const tokens = raw.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const meta = tokens[index];
    if (!meta.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldBlob = "", newBlob = "", statusField = ""] = meta.slice(1).split(" ");
    const letter = statusField.charAt(0);
    const paired = letter === "R" || letter === "C";
    const first = tokens[index + 1] ?? "";
    const second = paired ? tokens[index + 2] ?? "" : "";
    index += paired ? 2 : 1;
    files.push({
      status: letter,
      path: paired ? second : first,
      previous_path: paired ? first : null,
      similarity: paired && statusField.length > 1 ? Number(statusField.slice(1)) : null,
      old_mode: oldMode,
      new_mode: newMode,
      old_blob: oldBlob,
      new_blob: newBlob,
      added: null,
      deleted: null,
      binary: false,
    });
  }
  const counts = new Map<string, { added: number | null; deleted: number | null; binary: boolean }>();
  const records = numstat.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(records[index]);
    if (!match) continue;
    let path = match[3];
    if (path === "") {
      path = records[index + 2] ?? "";
      index += 2;
    }
    const binary = match[1] === "-";
    counts.set(path, { added: binary ? null : Number(match[1]), deleted: binary ? null : Number(match[2]), binary });
  }
  for (const file of files) Object.assign(file, counts.get(file.path) ?? {});
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

async function streamPatch(worktree: string, base: string, env: Record<string, string>, captureBytes: number) {
  const hash = createHash("sha256");
  const capture = new BoundedCapture(captureBytes);
  const errors = new BoundedCapture(64 * 1024);
  const child = spawn("git", [...gitSafetyArgs(), "diff", "--cached", "--binary", "-M", base], {
    cwd: worktree,
    env: gitEnvironment(env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    capture.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
  const timer = setTimeout(() => child.kill(), patchTimeoutMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode));
    });
    if (code !== 0) throw new ExecutionEvidenceError("git_failed", `Writing the patch failed: ${errors.text().slice(0, 2000)}`, {});
  } catch (error) {
    throw error instanceof ExecutionEvidenceError ? error : new ExecutionEvidenceError("git_failed", `Writing the patch failed: ${errorMessage(error)}`, {});
  } finally {
    clearTimeout(timer);
  }
  return { sha256: hash.digest("hex"), bytes: capture.total, truncated: capture.truncated, text: capture.text() };
}

async function gitStep(cwd: string, args: string[], env: Record<string, string>, description: string, trim = true) {
  const result = await runGit(cwd, args, { env, trim });
  if (!result.ok) {
    throw new ExecutionEvidenceError("git_failed", `${description} failed: ${result.stderr.slice(0, 2000)}`, { command: args.slice(0, 2).join(" ") });
  }
  return result.stdout;
}

let toolVersionsCache: Promise<Record<string, string | null>> | null = null;

function toolVersions() {
  toolVersionsCache ??= (async () => {
    const git = await runGit(process.cwd(), ["--version"]);
    return {
      git: git.ok ? git.stdout.split(/\r?\n/)[0] ?? null : null,
      runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`,
    };
  })();
  return toolVersionsCache;
}

// --- storage ---------------------------------------------------------------------------

async function appendEvidence(entry: EvidenceEntry) {
  for (let tries = 1; ; tries += 1) {
    try {
      return await adapter.transaction(async () => {
        const last = await adapter.get<{ sequence: number | string | null }>(
          "SELECT MAX(sequence) AS sequence FROM execution_evidence WHERE attempt_id = @attempt_id",
          { attempt_id: entry.attempt.id },
        );
        await adapter.run(`
          INSERT INTO execution_evidence (
            id, attempt_id, sequence, kind, schema_version, name, status, attempt_revision, base_sha,
            tree_fingerprint, supersedes, payload, artifacts, provenance, created_at
          ) VALUES (
            @id, @attempt_id, @sequence, @kind, @schema_version, @name, @status, @attempt_revision, @base_sha,
            @tree_fingerprint, @supersedes, @payload, @artifacts, @provenance, @created_at
          )
        `, {
          id: entry.id,
          attempt_id: entry.attempt.id,
          sequence: Number(last?.sequence ?? 0) + 1,
          kind: entry.kind,
          schema_version: EXECUTION_EVIDENCE_SCHEMA_VERSION,
          name: entry.name,
          status: entry.status,
          attempt_revision: entry.attempt.revision,
          base_sha: entry.attempt.base_sha,
          tree_fingerprint: entry.tree_fingerprint,
          supersedes: entry.supersedes,
          payload: json(entry.payload),
          artifacts: json(entry.artifacts),
          provenance: json(entry.provenance),
          created_at: nowIso(),
        });
        const row = await adapter.get<EvidenceRow>("SELECT * FROM execution_evidence WHERE id = @id", { id: entry.id });
        if (!row) throw new ExecutionEvidenceError("evidence_not_found", `Evidence ${entry.id} was not readable after it was recorded`, { evidence_id: entry.id });
        return hydrateEvidence(row);
      });
    } catch (error) {
      // Postgres writers do not serialize: two appends can read the same last
      // sequence, and the unique index sends the loser around again.
      if (tries < 3 && isUniqueViolation(error, "sequence")) continue;
      throw error;
    }
  }
}

function hydrateEvidence(row: EvidenceRow) {
  return {
    id: row.id,
    attempt_id: row.attempt_id,
    sequence: Number(row.sequence),
    kind: row.kind,
    schema_version: row.schema_version,
    name: row.name,
    status: row.status,
    attempt_revision: Number(row.attempt_revision),
    base_sha: row.base_sha,
    tree_fingerprint: row.tree_fingerprint,
    supersedes: row.supersedes,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    artifacts: parseJson<ArtifactRef[]>(row.artifacts, []),
    provenance: parseJson<Record<string, unknown>>(row.provenance, {}),
    created_at: row.created_at,
  };
}

async function requireAttempt(attemptId: string) {
  const attempt = await getExecutionAttempt(attemptId);
  if (!attempt) throw new ExecutionEvidenceError("attempt_not_found", `Execution attempt not found: ${attemptId}`, { attempt_id: attemptId });
  return attempt;
}

async function requireWorktree(attempt: AttemptView) {
  const lease = (await listExecutionWorkspaces({ attempt_id: attempt.id, include_released: true }))
    .find((candidate) => candidate.status !== "released" && existsSync(candidate.worktree_path));
  if (!lease) {
    throw new ExecutionEvidenceError("workspace_not_ready", `Attempt ${attempt.id} has no unreleased workspace with its worktree in place`, { attempt_id: attempt.id });
  }
  return lease.worktree_path;
}

function evidenceDirectory(attemptId: string) {
  const directory = join(dirname(resolveDbPath()), "attempt-logs", attemptId);
  mkdirSync(directory, { recursive: true });
  return directory;
}

// --- input validation ---------------------------------------------------------------------

function artifactReferences(value: unknown): ArtifactRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) throw invalid("artifacts must be an array of at most 50 references", { field: "artifacts" });
  return value.map((entry, index) => {
    const artifact = objectInput(entry, `artifacts[${index}]`);
    if (!artifact) throw invalid(`artifacts[${index}] must be an object`, { field: `artifacts[${index}]` });
    const kind = requiredText(artifact.kind, `artifacts[${index}].kind`, 50);
    if (!artifactKindPattern.test(kind)) throw invalid(`artifacts[${index}].kind must be a lowercase identifier`, { field: `artifacts[${index}].kind` });
    return { kind, ref: requiredText(artifact.ref, `artifacts[${index}].ref`, 2000) };
  });
}

function stringMap(value: unknown, field: string) {
  const map = objectInput(value, field) ?? {};
  const entries = Object.entries(map);
  if (entries.length > 50) throw invalid(`${field} holds at most 50 entries`, { field });
  return Object.fromEntries(entries.map(([key, entry]) => {
    if (key.length > 60 || typeof entry !== "string" || entry.length > 200) throw invalid(`${field} must map short names to version strings`, { field });
    return [key, entry];
  }));
}

function requiredActor(input: { actor_kind?: unknown; actor_id?: unknown }): Actor {
  const kind = requiredText(input.actor_kind, "actor_kind", 40);
  if (!(executionActorKinds as readonly string[]).includes(kind)) throw invalid(`actor_kind must be one of ${executionActorKinds.join(", ")}`, { field: "actor_kind" });
  return { kind, id: requiredText(input.actor_id, "actor_id", 200) };
}

function boundedInteger(value: unknown, field: string, min: number, max: number) {
  if (value === undefined || value === null || value === "") return max;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) throw invalid(`${field} must be an integer from ${min} to ${max}`, { field });
  return numeric;
}

function optionalInteger(value: unknown, field: string, min: number, max: number) {
  if (value === undefined || value === null || value === "") return null;
  return boundedInteger(value, field, min, max);
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
  return new ExecutionEvidenceError("invalid_input", message, details);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// SQLite reports "UNIQUE constraint failed: <table>.<columns>"; Postgres reports
// SQLSTATE 23505 with the constraint name. The marker matches either spelling.
function isUniqueViolation(error: unknown, marker: string) {
  const record = (error ?? {}) as { code?: unknown; constraint_name?: unknown; message?: unknown };
  const message = String(record.message ?? "");
  if (record.code === "23505") return `${String(record.constraint_name ?? "")} ${message}`.includes(marker);
  return message.includes("UNIQUE constraint failed") && message.includes(marker);
}
