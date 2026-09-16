// Execution attempt, workspace lease, evidence, and verification policy tables,
// shared by both engines.
//
// The DDL is the same on SQLite and Postgres -- TEXT timestamps, INTEGER
// revisions, CHECK constraints, and partial unique indexes -- so it lives once
// here and both schema paths include it: server/db.ts for SQLite (bootstrap and
// migration 0007) and server/db-schema-postgres.ts for Postgres. This module
// imports only the pure execution contract, so db.ts can include it while its
// own module body is still evaluating.
//
// The partial unique indexes are the cross-process guarantees. One non-terminal
// attempt per issue backs the contract's live_attempts_per_issue bound; one live
// lease per attempt, per worktree path, and per (repository, branch) means two
// hubs provisioning at the same moment cannot both own a workspace, whatever each
// one read beforehand. The transition ledger is unique per (attempt, revision)
// and per (attempt, idempotency key), evidence per (attempt, sequence), and
// policies per (repository, revision), for the same reason.
//
// The state lists are rendered from the contract. CREATE ... IF NOT EXISTS never
// alters an existing table or index, so changing a state set needs an explicit
// migration for databases created before the change.

import { executionStates, initialExecutionState, isTerminalExecutionState, resumableExecutionStates } from "./execution-contract.js";

export const liveExecutionStates = executionStates.filter((state) => !isTerminalExecutionState(state));

// A lease is live while it may own Git resources: being provisioned or active.
// A failed lease may have left resources behind and is resumed, not replaced.
export const workspaceLeaseStatuses = ["provisioning", "active", "released", "failed"] as const;
export const liveWorkspaceLeaseStatuses = ["provisioning", "active"] as const;

// Evidence kinds: a diff of the worktree, an observation of a verification step,
// a claim that is recorded but never counted as an observation, and a verdict
// from evaluating a policy. Observations carry how the step ended; diffs and
// claims are simply recorded; verdicts pass or fail.
export const executionEvidenceKinds = ["diff", "observation", "claim", "verdict"] as const;
export const observationStatuses = ["passed", "failed", "timed_out", "canceled", "error"] as const;
export const executionEvidenceStatuses = [...observationStatuses, "recorded"] as const;

// Conflicts between concurrent attempts in one repository. The method says how
// an overlap was found, the certainty how much it can be trusted (observed in
// both diffs, declared as intent, a directory heuristic, or unknown when bases
// could not be compared), and the severity what the repository's policy makes
// of it. Decisions are the append-only audit trail of every status change.
export const executionConflictMethods = ["exact_path", "declared_directory", "shared_directory", "base_divergence"] as const;
export const executionConflictCertainties = ["observed", "declared", "heuristic", "unknown"] as const;
export const executionConflictSeverities = ["info", "warning", "blocking"] as const;
export const executionConflictStatuses = ["open", "resolved", "overridden"] as const;
export const executionConflictDecisions = ["detected", "changed", "reopened", "resolved", "override", "reopen"] as const;

// Acceptance runs: write-ahead records of the post-verification path, so a run
// interrupted after committing, merging, pushing, or opening a pull request is
// resumed from the step it reached instead of repeating remote mutations.
export const executionAcceptanceStatuses = ["in_progress", "accepted", "rejected", "failed"] as const;
export const executionAcceptanceSteps = [
  "recorded",
  "committed",
  "merged",
  "pushed",
  "pull_request_opened",
  "pull_request_merged",
  "transitioned",
  "issue_settled",
  "completed",
] as const;

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

export const liveExecutionStatesSql = quoted(liveExecutionStates);
export const liveWorkspaceLeaseStatusesSql = quoted(liveWorkspaceLeaseStatuses);

export const executionAttemptsSchemaSql = `
CREATE TABLE IF NOT EXISTS execution_attempts (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  claim_id TEXT REFERENCES issue_claims(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  harness TEXT NOT NULL,
  harness_version TEXT,
  repository TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  retry_of TEXT REFERENCES execution_attempts(id) ON DELETE SET NULL,
  create_idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT '${initialExecutionState}' CHECK(state IN (${quoted(executionStates)})),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  reconciliation_origin TEXT CHECK(reconciliation_origin IS NULL OR reconciliation_origin IN (${quoted(resumableExecutionStates)})),
  last_idempotency_key TEXT,
  last_event TEXT,
  state_reason TEXT,
  branch TEXT,
  worktree_path TEXT,
  lease_id TEXT,
  process_id INTEGER,
  process_started_at TEXT,
  provenance TEXT NOT NULL DEFAULT '{}',
  artifacts TEXT NOT NULL DEFAULT '[]',
  contract_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state_changed_at TEXT NOT NULL,
  terminal_at TEXT
);

CREATE TABLE IF NOT EXISTS execution_attempt_transitions (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  event TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT,
  policy TEXT,
  note TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  contract_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(attempt_id, revision),
  UNIQUE(attempt_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS execution_workspace_leases (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  repository TEXT NOT NULL,
  repository_path TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (${quoted(workspaceLeaseStatuses)})),
  step TEXT NOT NULL CHECK(step IN ('recorded', 'worktree_created')),
  expires_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  released_at TEXT,
  retained INTEGER NOT NULL DEFAULT 0,
  failure TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_policies (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  schema_version TEXT NOT NULL,
  require_changes INTEGER NOT NULL DEFAULT 1,
  steps TEXT NOT NULL,
  created_by_kind TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(repository, revision)
);

CREATE TABLE IF NOT EXISTS execution_evidence (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  kind TEXT NOT NULL CHECK(kind IN (${quoted(executionEvidenceKinds)})),
  schema_version TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL CHECK(status IN (${quoted(executionEvidenceStatuses)})),
  attempt_revision INTEGER NOT NULL,
  base_sha TEXT NOT NULL,
  tree_fingerprint TEXT,
  supersedes TEXT REFERENCES execution_evidence(id) ON DELETE SET NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  artifacts TEXT NOT NULL DEFAULT '[]',
  provenance TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(attempt_id, sequence)
);

CREATE TABLE IF NOT EXISTS execution_path_declarations (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  paths TEXT NOT NULL,
  declared_by_kind TEXT NOT NULL,
  declared_by_id TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(issue_id, repository, revision)
);

CREATE TABLE IF NOT EXISTS execution_conflict_policies (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  schema_version TEXT NOT NULL,
  rules TEXT NOT NULL,
  created_by_kind TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(repository, revision)
);

CREATE TABLE IF NOT EXISTS execution_conflicts (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  attempt_a_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE CASCADE,
  attempt_b_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN (${quoted(executionConflictMethods)})),
  certainty TEXT NOT NULL CHECK(certainty IN (${quoted(executionConflictCertainties)})),
  severity TEXT NOT NULL CHECK(severity IN (${quoted(executionConflictSeverities)})),
  base_a TEXT NOT NULL,
  base_b TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN (${quoted(executionConflictStatuses)})),
  policy_revision INTEGER,
  resolution TEXT,
  detected_at TEXT NOT NULL,
  last_detected_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(attempt_a_id, attempt_b_id, method, path)
);

CREATE TABLE IF NOT EXISTS execution_conflict_decisions (
  id TEXT PRIMARY KEY,
  conflict_id TEXT NOT NULL REFERENCES execution_conflicts(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  decision TEXT NOT NULL CHECK(decision IN (${quoted(executionConflictDecisions)})),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT,
  note TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(conflict_id, sequence)
);

CREATE TABLE IF NOT EXISTS execution_acceptance_policies (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  schema_version TEXT NOT NULL,
  settings TEXT NOT NULL,
  created_by_kind TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(repository, revision)
);

CREATE TABLE IF NOT EXISTS execution_acceptances (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL REFERENCES execution_acceptance_policies(id),
  policy_revision INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN (${quoted(executionAcceptanceStatuses)})),
  step TEXT NOT NULL CHECK(step IN (${quoted(executionAcceptanceSteps)})),
  verdict_id TEXT,
  tree_fingerprint TEXT,
  commit_sha TEXT,
  merge_target TEXT,
  merge_target_previous_sha TEXT,
  merge_sha TEXT,
  pushed_refs TEXT NOT NULL DEFAULT '[]',
  pull_request TEXT,
  outcome_code TEXT,
  outcome_message TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_acceptances_in_progress ON execution_acceptances(attempt_id) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_execution_acceptances_attempt ON execution_acceptances(attempt_id, created_at);
CREATE INDEX IF NOT EXISTS idx_execution_acceptance_policies_repository ON execution_acceptance_policies(repository, revision);

CREATE TABLE IF NOT EXISTS execution_runners (
  run_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE CASCADE,
  adapter TEXT NOT NULL,
  supervisor_pid INTEGER NOT NULL,
  supervisor_host TEXT NOT NULL,
  harness_pid INTEGER,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT
);

CREATE TABLE IF NOT EXISTS execution_reconciliation_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK(trigger IN ('startup', 'periodic', 'manual')),
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'abandoned')),
  scope TEXT NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS execution_reconciliation_decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES execution_reconciliation_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE SET NULL,
  lease_id TEXT,
  classification TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('repaired', 'quarantined', 'released', 'reported', 'skipped', 'failed')),
  reason TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_execution_runners_attempt ON execution_runners(attempt_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_reconciliation_running ON execution_reconciliation_runs(status) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_execution_reconciliation_runs_started ON execution_reconciliation_runs(started_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_attempts_live_issue ON execution_attempts(issue_id) WHERE state IN (${liveExecutionStatesSql});
CREATE INDEX IF NOT EXISTS idx_execution_attempts_issue_created ON execution_attempts(issue_id, created_at);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_session ON execution_attempts(session_id, state);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_state_updated ON execution_attempts(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_retry_of ON execution_attempts(retry_of);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_leases_live_attempt ON execution_workspace_leases(attempt_id) WHERE status IN (${liveWorkspaceLeaseStatusesSql});
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_leases_live_path ON execution_workspace_leases(worktree_path) WHERE status IN (${liveWorkspaceLeaseStatusesSql});
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_leases_live_branch ON execution_workspace_leases(git_common_dir, branch) WHERE status IN (${liveWorkspaceLeaseStatusesSql});
CREATE INDEX IF NOT EXISTS idx_workspace_leases_issue ON execution_workspace_leases(issue_id, created_at);
CREATE INDEX IF NOT EXISTS idx_execution_evidence_attempt_kind ON execution_evidence(attempt_id, kind, name, sequence);
CREATE INDEX IF NOT EXISTS idx_verification_policies_repository ON verification_policies(repository, revision);
CREATE INDEX IF NOT EXISTS idx_execution_path_declarations_repository ON execution_path_declarations(repository, issue_id, revision);
CREATE INDEX IF NOT EXISTS idx_execution_conflict_policies_repository ON execution_conflict_policies(repository, revision);
CREATE INDEX IF NOT EXISTS idx_execution_conflicts_repository_status ON execution_conflicts(repository, status);
CREATE INDEX IF NOT EXISTS idx_execution_conflicts_attempt_a ON execution_conflicts(attempt_a_id, status);
CREATE INDEX IF NOT EXISTS idx_execution_conflicts_attempt_b ON execution_conflicts(attempt_b_id, status);
`;
