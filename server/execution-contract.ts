// Execution control plane contract.
//
// This module is the single owner of execution-attempt lifecycle rules. An
// attempt carries one issue from claim to acceptance: pinned base commit,
// leased branch and worktree, harness run, verification, review, and the
// accept/reject decision. Persistence, provisioning, harness adapters,
// verifiers, reconciliation, and the API/CLI/MCP/UI surfaces all ask
// planExecutionTransition() whether a move is legal instead of re-deriving it,
// so a lifecycle rule changes in exactly one place.
//
// It is deliberately pure: no database, no processes, no Git. That is what lets
// every layer share it, and what lets the rules be checked exhaustively without
// fixtures. Callers persist the returned snapshot and transition record
// themselves, using expected_revision as the compare-and-set guard.
//
// docs/AGENTIC_HARNESS.md renders the tables below between generated markers
// (bun run contract:generate); bun run contract:check fails on drift.

export const EXECUTION_CONTRACT_VERSION = "execution-contract/v1";

export const executionStates = [
  "provisioning",
  "running",
  "verifying",
  "reviewable",
  "accepted",
  "failed",
  "canceled",
  "stale",
  "reconciling",
] as const;
export type ExecutionState = (typeof executionStates)[number];

export const terminalExecutionStates: readonly ExecutionState[] = ["accepted", "failed", "canceled"];

// The state every attempt is created in.
export const initialExecutionState: ExecutionState = "provisioning";

// The states reconciliation may hand an attempt back to. A stale attempt was
// quarantined because something real changed underneath it -- its base, lease,
// heartbeat, or Git resources -- so recovery can end it but never resume it.
export const resumableExecutionStates: readonly ExecutionState[] = ["provisioning", "running", "verifying", "reviewable"];

export const executionStateDescriptions: Record<ExecutionState, string> = {
  provisioning: "The attempt exists with its base commit SHA pinned; the leased branch and worktree are being created. No harness process runs yet.",
  running: "The branch and worktree lease is recorded and a harness adapter process runs inside the leased worktree.",
  verifying: "The harness process tree has exited and configured verification steps run against the attempt's changes.",
  reviewable: "Recorded evidence satisfies the verification policy. The attempt waits for an acceptance decision; passing verification never accepts it.",
  accepted: "The named acceptance policy succeeded and the resulting commit, PR, or merge identity is recorded.",
  failed: "The attempt cannot reach acceptance and its reason code is recorded. A retry is a new attempt.",
  canceled: "An authorized actor stopped the attempt; its process tree is terminated and its resources are released or quarantined.",
  stale: "Quarantined: the pinned base drifted, the lease expired, the owning session stopped heartbeating, or Git resources went missing. Work is preserved but cannot advance.",
  reconciling: "Recovery is comparing the durable record with real process and Git state after a crash, restart, or operator request.",
};

export const executionEvents = [
  "launch",
  "complete_run",
  "pass_verification",
  "fail_verification",
  "accept",
  "reject",
  "fail",
  "cancel",
  "mark_stale",
  "begin_reconciliation",
  "resume",
] as const;
export type ExecutionEvent = (typeof executionEvents)[number];

export const executionActorKinds = ["agent", "operator", "control_plane", "reconciler"] as const;
export type ExecutionActorKind = (typeof executionActorKinds)[number];

export const executionActorDescriptions: Record<ExecutionActorKind, string> = {
  agent: "The agent session that owns the attempt's claim. It may act only on attempts whose `session_id` is its own.",
  operator: "A human acting through the local UI, CLI, or MCP with explicit intent. Required for quarantine-breaking and destructive actions.",
  control_plane: "The hub's orchestration: provisioning, harness adapters, verifiers, and explicitly configured acceptance policy.",
  reconciler: "Startup or periodic recovery. It quarantines work when intent is unclear and never cancels live work on its own.",
};

export type ExecutionTransitionRule = {
  event: ExecutionEvent;
  from: readonly ExecutionState[];
  // "origin" is the state recorded when reconciliation began.
  to: ExecutionState | "origin";
  actors: readonly ExecutionActorKind[];
  requires?: "policy" | "origin";
  // A rule that takes an attempt off the happy path names the reason codes it
  // accepts, so reconciliation, scheduling, and reporting branch on codes rather
  // than prose. Codes belong to the rule, not the event: failing live work and
  // abandoning quarantined work are both "fail", but accept different reasons.
  // A rule without reasons takes no reason code.
  reasons?: readonly string[];
  summary: string;
};

// The authoritative transition table. An (event, from) pair appears at most
// once, so every request resolves to exactly one rule or to invalid_transition.
export const executionTransitions: readonly ExecutionTransitionRule[] = [
  {
    event: "launch",
    from: ["provisioning"],
    to: "running",
    actors: ["control_plane"],
    summary: "The branch and worktree lease is recorded and the adapter started the harness inside the leased worktree.",
  },
  {
    event: "complete_run",
    from: ["running"],
    to: "verifying",
    actors: ["control_plane"],
    summary: "The harness process tree exited and its bounded output was captured.",
  },
  {
    event: "pass_verification",
    from: ["verifying"],
    to: "reviewable",
    actors: ["control_plane"],
    summary: "Recorded evidence satisfies the configured verification policy.",
  },
  {
    event: "fail_verification",
    from: ["verifying"],
    to: "failed",
    actors: ["control_plane"],
    reasons: ["checks_failed", "evidence_missing", "stale_base_evidence"],
    summary: "Recorded evidence does not satisfy the verification policy.",
  },
  {
    event: "accept",
    from: ["reviewable"],
    to: "accepted",
    actors: ["operator", "control_plane"],
    requires: "policy",
    summary: "The named acceptance policy succeeded. The control plane accepts only under an explicitly configured policy.",
  },
  {
    event: "reject",
    from: ["reviewable"],
    to: "failed",
    actors: ["operator", "control_plane"],
    reasons: ["review_rejected", "merge_conflict"],
    summary: "Review rejected the attempt or its merge could not complete.",
  },
  {
    event: "fail",
    from: ["provisioning", "running", "verifying"],
    to: "failed",
    actors: ["agent", "operator", "control_plane"],
    reasons: ["provisioning_failed", "harness_failed", "harness_timeout", "verification_error", "abandoned"],
    summary: "Live work cannot continue. Any retry is a new attempt.",
  },
  {
    event: "fail",
    from: ["stale", "reconciling"],
    to: "failed",
    actors: ["operator", "reconciler"],
    reasons: ["reconciliation_failed", "abandoned"],
    summary: "Quarantined or recovering work is abandoned after inspection.",
  },
  {
    event: "cancel",
    from: ["provisioning", "running", "verifying", "reviewable"],
    to: "canceled",
    actors: ["agent", "operator", "control_plane"],
    reasons: ["agent_requested", "operator_requested", "claim_released", "superseded"],
    summary: "An authorized actor stopped the attempt; the harness process tree is terminated.",
  },
  {
    event: "cancel",
    from: ["stale", "reconciling"],
    to: "canceled",
    actors: ["operator"],
    reasons: ["operator_requested"],
    summary: "Only an operator cancels quarantined or recovering work.",
  },
  {
    event: "mark_stale",
    from: ["provisioning", "running", "verifying", "reviewable", "reconciling"],
    to: "stale",
    actors: ["control_plane", "reconciler"],
    reasons: ["base_drift", "lease_expired", "heartbeat_lost", "worktree_missing", "branch_moved"],
    summary: "Quarantine without deleting work when the base, lease, heartbeat, or Git resources no longer hold.",
  },
  {
    event: "begin_reconciliation",
    from: ["provisioning", "running", "verifying", "reviewable", "stale"],
    to: "reconciling",
    actors: ["operator", "reconciler"],
    summary: "Recovery starts comparing durable state with real process and Git state; the current state is recorded as the origin.",
  },
  {
    event: "resume",
    from: ["reconciling"],
    to: "origin",
    actors: ["operator", "reconciler"],
    requires: "origin",
    summary: "Reconciliation confirmed that real state matches the recorded origin, so the attempt continues there.",
  },
];

// Ordered by precedence: planExecutionTransition checks in this order and throws
// the first code that applies. A stale revision is reported before an illegal
// event so a writer that lost a race re-reads instead of acting on an old view.
export const executionContractErrorCodes = [
  "unknown_state",
  "invalid_request",
  "unknown_event",
  "idempotency_conflict",
  "revision_conflict",
  "terminal_state",
  "invalid_transition",
  "unauthorized_actor",
  "invalid_reason",
  "policy_required",
  "origin_not_resumable",
] as const;
export type ExecutionContractErrorCode = (typeof executionContractErrorCodes)[number];

export const executionContractErrorDescriptions: Record<ExecutionContractErrorCode, string> = {
  unknown_state: "The attempt record holds a state this contract version does not define.",
  invalid_request: "The request or attempt record is malformed: blank or oversized idempotency key, non-integer revision, unknown actor kind, blank actor id, or oversized note.",
  unknown_event: "The event is not defined by this contract version.",
  idempotency_conflict: "The idempotency key already applied a different event to this attempt.",
  revision_conflict: "`expected_revision` is not the attempt's current revision because another writer moved it first. Re-read before retrying.",
  terminal_state: "The attempt is `accepted`, `failed`, or `canceled`. Terminal attempts never change; retry with a new attempt.",
  invalid_transition: "The event is not allowed from the current state. The failure lists the events that are.",
  unauthorized_actor: "The actor kind may not perform this event, or an agent acted on an attempt owned by another session.",
  invalid_reason: "The matched transition requires one of its listed reason codes and got none or another value, or a reason code was given to a transition that takes none.",
  policy_required: "Acceptance must name the policy that authorized it.",
  origin_not_resumable: "`resume` needs a recorded reconciliation origin of `provisioning`, `running`, `verifying`, or `reviewable`.",
};

export class ExecutionContractError extends Error {
  readonly code: ExecutionContractErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ExecutionContractErrorCode, message: string, details: Record<string, unknown> = {}) {
    // The code leads the message: CLI and MCP callers see only the message, and
    // must still be able to branch on the typed failure.
    super(`${code}: ${message}`);
    this.name = "ExecutionContractError";
    this.code = code;
    this.details = details;
  }
}

type ExecutionBound = {
  value: number;
  unit: "ms" | "bytes" | "count" | "characters";
  description: string;
};

// Defaults that runtime slices enforce until they become configurable. Crossing
// a time bound fails the attempt with a typed reason; captured output beyond
// its bound is truncated with an explicit marker, never silently.
export const executionBounds = {
  harness_wall_clock: {
    value: 2 * 60 * 60 * 1000,
    unit: "ms",
    description: "Longest a harness process tree may run before the attempt fails with `harness_timeout`.",
  },
  harness_idle_output: {
    value: 15 * 60 * 1000,
    unit: "ms",
    description: "Longest a running harness may produce no output before it is treated as hung.",
  },
  captured_stream: {
    value: 1024 * 1024,
    unit: "bytes",
    description: "Captured stdout or stderr per stream; output beyond it is truncated with an explicit marker.",
  },
  verification_step: {
    value: 30 * 60 * 1000,
    unit: "ms",
    description: "Longest a single verification step may run.",
  },
  cancellation_grace: {
    value: 10 * 1000,
    unit: "ms",
    description: "Wait between the cooperative stop signal and termination of the whole process tree.",
  },
  concurrent_attempts_per_repository: {
    value: 4,
    unit: "count",
    description: "Non-terminal attempts sharing one repository.",
  },
  live_attempts_per_issue: {
    value: 1,
    unit: "count",
    description: "Non-terminal attempts per issue. Another launch is refused, not queued, until the live one ends.",
  },
  idempotency_key: {
    value: 200,
    unit: "characters",
    description: "Maximum idempotency key length.",
  },
  transition_note: {
    value: 2000,
    unit: "characters",
    description: "Maximum transition note length.",
  },
} as const satisfies Record<string, ExecutionBound>;

export type ExecutionAttemptSnapshot = {
  state: ExecutionState;
  revision: number;
  session_id: string | null;
  reconciliation_origin: ExecutionState | null;
  last_idempotency_key: string | null;
  last_event: ExecutionEvent | null;
};

export type ExecutionActor = { kind: ExecutionActorKind; id: string };

// Loosely typed on purpose: requests arrive from HTTP, CLI, and MCP input, and
// planExecutionTransition is where they are validated.
export type ExecutionTransitionRequest = {
  event: string;
  expected_revision: number;
  idempotency_key: string;
  actor: { kind: string; id: string };
  reason?: string | null;
  policy?: string | null;
  note?: string | null;
  at?: string;
};

export type ExecutionTransitionRecord = {
  contract_version: typeof EXECUTION_CONTRACT_VERSION;
  event: ExecutionEvent;
  from: ExecutionState;
  to: ExecutionState;
  revision: number;
  idempotency_key: string;
  actor: ExecutionActor;
  reason: string | null;
  policy: string | null;
  note: string | null;
  at: string;
};

export type ExecutionTransitionPlan =
  | { outcome: "applied"; snapshot: ExecutionAttemptSnapshot; record: ExecutionTransitionRecord }
  | { outcome: "replayed"; snapshot: ExecutionAttemptSnapshot };

export function isExecutionState(value: unknown): value is ExecutionState {
  return typeof value === "string" && (executionStates as readonly string[]).includes(value);
}

export function isExecutionEvent(value: unknown): value is ExecutionEvent {
  return typeof value === "string" && (executionEvents as readonly string[]).includes(value);
}

export function isExecutionActorKind(value: unknown): value is ExecutionActorKind {
  return typeof value === "string" && (executionActorKinds as readonly string[]).includes(value);
}

export function isTerminalExecutionState(state: ExecutionState) {
  return terminalExecutionStates.includes(state);
}

export function allowedExecutionEvents(state: ExecutionState): ExecutionEvent[] {
  return [...new Set(executionTransitions.filter((rule) => rule.from.includes(state)).map((rule) => rule.event))];
}

export function planExecutionTransition(snapshot: ExecutionAttemptSnapshot, request: ExecutionTransitionRequest): ExecutionTransitionPlan {
  if (!isExecutionState(snapshot.state)) {
    throw new ExecutionContractError("unknown_state", `Unknown execution state: ${String(snapshot.state)}`, { state: snapshot.state });
  }
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new ExecutionContractError("invalid_request", "Attempt revision must be a non-negative integer", { revision: snapshot.revision });
  }
  const idempotencyKey = typeof request.idempotency_key === "string" ? request.idempotency_key.trim() : "";
  if (!idempotencyKey || idempotencyKey.length > executionBounds.idempotency_key.value) {
    throw new ExecutionContractError("invalid_request", `idempotency_key must be 1-${executionBounds.idempotency_key.value} characters`);
  }
  if (!Number.isSafeInteger(request.expected_revision)) {
    throw new ExecutionContractError("invalid_request", "expected_revision must be an integer", { expected_revision: request.expected_revision });
  }
  const actorKind = request.actor?.kind;
  const actorId = typeof request.actor?.id === "string" ? request.actor.id.trim() : "";
  if (!isExecutionActorKind(actorKind) || !actorId) {
    throw new ExecutionContractError("invalid_request", "actor must name a known kind and a non-empty id", { actor: request.actor });
  }
  const note = request.note === undefined || request.note === null ? null : String(request.note);
  if (note !== null && note.length > executionBounds.transition_note.value) {
    throw new ExecutionContractError("invalid_request", `note must be at most ${executionBounds.transition_note.value} characters`);
  }
  if (!isExecutionEvent(request.event)) {
    throw new ExecutionContractError("unknown_event", `Unknown execution event: ${String(request.event)}`, { event: request.event });
  }
  const event = request.event;
  const state = snapshot.state;

  // Replay comes before the revision and terminal checks: a caller that lost the
  // response to its last request resends it against the already-moved attempt,
  // possibly now terminal, and must get that attempt back rather than an error.
  if (snapshot.last_idempotency_key === idempotencyKey) {
    if (snapshot.last_event === event) return { outcome: "replayed", snapshot };
    throw new ExecutionContractError(
      "idempotency_conflict",
      `Idempotency key ${idempotencyKey} already applied ${snapshot.last_event ?? "another event"}`,
      { idempotency_key: idempotencyKey, applied_event: snapshot.last_event, requested_event: event },
    );
  }
  if (request.expected_revision !== snapshot.revision) {
    throw new ExecutionContractError(
      "revision_conflict",
      `Attempt is at revision ${snapshot.revision}, not ${request.expected_revision}`,
      { revision: snapshot.revision, expected_revision: request.expected_revision },
    );
  }
  if (isTerminalExecutionState(state)) {
    throw new ExecutionContractError("terminal_state", `Attempt is ${state}; terminal attempts never change`, { state });
  }
  const rule = executionTransitions.find((candidate) => candidate.event === event && candidate.from.includes(state));
  if (!rule) {
    throw new ExecutionContractError(
      "invalid_transition",
      `${event} is not allowed from ${state}`,
      { state, event, allowed: allowedExecutionEvents(state) },
    );
  }
  if (!rule.actors.includes(actorKind)) {
    throw new ExecutionContractError("unauthorized_actor", `${actorKind} may not ${event}`, { event, actor: actorKind, allowed: rule.actors });
  }
  if (actorKind === "agent" && snapshot.session_id !== actorId) {
    throw new ExecutionContractError(
      "unauthorized_actor",
      "An agent may act only on attempts owned by its own session",
      { event, actor_id: actorId, session_id: snapshot.session_id },
    );
  }
  const reason = request.reason === undefined || request.reason === null || request.reason === "" ? null : String(request.reason);
  if (rule.reasons ? !reason || !rule.reasons.includes(reason) : reason !== null) {
    throw new ExecutionContractError(
      "invalid_reason",
      rule.reasons ? `${event} from ${state} requires one of: ${rule.reasons.join(", ")}` : `${event} from ${state} takes no reason code`,
      { event, state, reason, allowed: rule.reasons ?? [] },
    );
  }
  const policy = typeof request.policy === "string" && request.policy.trim() ? request.policy.trim() : null;
  if (rule.requires === "policy" && !policy) {
    throw new ExecutionContractError("policy_required", `${event} must name the policy that authorized it`, { event });
  }
  let to: ExecutionState;
  if (rule.to === "origin") {
    const origin = snapshot.reconciliation_origin;
    if (!origin || !resumableExecutionStates.includes(origin)) {
      throw new ExecutionContractError(
        "origin_not_resumable",
        `Cannot resume to ${origin ?? "an unrecorded origin"}`,
        { origin, resumable: resumableExecutionStates },
      );
    }
    to = origin;
  } else {
    to = rule.to;
  }

  const revision = snapshot.revision + 1;
  const record: ExecutionTransitionRecord = {
    contract_version: EXECUTION_CONTRACT_VERSION,
    event,
    from: state,
    to,
    revision,
    idempotency_key: idempotencyKey,
    actor: { kind: actorKind, id: actorId },
    reason,
    policy,
    note,
    at: request.at ?? new Date().toISOString(),
  };
  return {
    outcome: "applied",
    record,
    snapshot: {
      state: to,
      revision,
      session_id: snapshot.session_id,
      reconciliation_origin: to === "reconciling" ? state : null,
      last_idempotency_key: idempotencyKey,
      last_event: event,
    },
  };
}

function formatBound(bound: ExecutionBound) {
  if (bound.unit === "ms") {
    if (bound.value % 3_600_000 === 0) return `${bound.value / 3_600_000} h`;
    if (bound.value % 60_000 === 0) return `${bound.value / 60_000} min`;
    return `${bound.value / 1000} s`;
  }
  if (bound.unit === "bytes") return bound.value % 1_048_576 === 0 ? `${bound.value / 1_048_576} MiB` : `${bound.value / 1024} KiB`;
  if (bound.unit === "characters") return `${bound.value} characters`;
  return String(bound.value);
}

export function renderExecutionContractMarkdown(): string {
  const cell = (value: string) => value.replace(/\|/g, "\\|");
  const code = (value: string) => `\`${value}\``;
  const list = (values: readonly string[]) => (values.length ? values.map(code).join(", ") : "none");
  const requirement = (rule: ExecutionTransitionRule) => {
    if (rule.requires === "policy") return code("policy");
    if (rule.requires === "origin") return "resumable origin";
    return "none";
  };
  const lines = [
    `Contract version: ${code(EXECUTION_CONTRACT_VERSION)}. Generated from \`server/execution-contract.ts\` by \`bun run contract:generate\`; edit that module, not this block.`,
    "",
    "#### States",
    "",
    "| State | Terminal | Allowed events | Meaning |",
    "| --- | --- | --- | --- |",
    ...executionStates.map((state) =>
      `| ${code(state)} | ${isTerminalExecutionState(state) ? "yes" : "no"} | ${list(allowedExecutionEvents(state))} | ${cell(executionStateDescriptions[state])} |`),
    "",
    "#### Transitions",
    "",
    "| Event | From | To | Actors | Requires | Reason codes | Effect |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...executionTransitions.map((rule) =>
      `| ${code(rule.event)} | ${list(rule.from)} | ${rule.to === "origin" ? "recorded origin" : code(rule.to)} | ${list(rule.actors)} | ${requirement(rule)} | ${list(rule.reasons ?? [])} | ${cell(rule.summary)} |`),
    "",
    "#### Actors",
    "",
    "| Actor | Authority |",
    "| --- | --- |",
    ...executionActorKinds.map((kind) => `| ${code(kind)} | ${cell(executionActorDescriptions[kind])} |`),
    "",
    "#### Typed failures",
    "",
    "Requests are checked in this order and fail with the first code that applies.",
    "",
    "| Code | Meaning |",
    "| --- | --- |",
    ...executionContractErrorCodes.map((errorCode) => `| ${code(errorCode)} | ${cell(executionContractErrorDescriptions[errorCode])} |`),
    "",
    "#### Default bounds",
    "",
    "| Bound | Default | Meaning |",
    "| --- | --- | --- |",
    ...Object.entries(executionBounds).map(([name, bound]) => `| ${code(name)} | ${formatBound(bound)} | ${cell(bound.description)} |`),
  ];
  return `${lines.join("\n")}\n`;
}
