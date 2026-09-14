// Reconciliation: comparing durable execution state with real processes and Git
// resources after crashes, and repairing or quarantining what no longer agrees.
//
// Every run is recorded, and every repair, quarantine, release, or failure it
// decides is recorded with the run. What it does, by case:
//
//   interrupted acceptance     resumed with its own idempotency key, because the
//                              operator's policy already authorized it
//   running, runner outcome    the run finished and wrote its outcome but the
//   recorded, no transition    finish transition never landed: applied now with
//                              the runner's own idempotency key
//   running, heartbeat lost    quarantined as stale (heartbeat_lost). A harness
//                              process that is still alive is reported and left
//                              running: the hub cannot prove it started that pid
//   provisioning, lease failed, resumed through provisioning, which verifies
//   interrupted, or expired    before it reuses anything; quarantined if that fails
//   verifying or reviewable    a missing worktree, a branch that moved, or a base
//                              that is gone is quarantined; an expired lease on an
//                              intact worktree is renewed through provisioning
//   terminal attempt holding   released: clean worktrees are removed, dirty ones
//   a lease                    retained, and branches always kept
//   lapsed claims, worktrees   reported only
//   no lease owns
//
// Reconciliation never removes a dirty or unowned worktree and never kills a
// process. It ignores anything that changed within min_age_ms, so it does not
// race work in flight in another process, and it examines at most `limit` items
// per category. One run holds the lock at a time; a run that stopped reporting
// long ago is marked abandoned. Running it again after any crash is safe.

import { existsSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { customAlphabet } from "nanoid";
import { adapter, json, nowIso, parseJson } from "./db.js";
import { acceptExecutionAttempt } from "./execution-acceptance.js";
import { liveExecutionStatesSql } from "./execution-attempts-schema.js";
import { getExecutionAttempt, transitionExecutionAttempt } from "./execution-attempts.js";
import { ExecutionWorkspaceError, executionWorkspaceRoot, listExecutionWorkspaces, provisionExecutionWorkspace, releaseExecutionWorkspace, runGit } from "./execution-workspaces.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export const reconciliationTriggers = ["startup", "periodic", "manual"] as const;
export type ReconciliationTrigger = (typeof reconciliationTriggers)[number];
export const reconciliationActions = ["repaired", "quarantined", "released", "reported", "skipped", "failed"] as const;
type Action = (typeof reconciliationActions)[number];

const defaultMinAgeMs = 10 * 60_000;
const defaultRunnerStaleMs = 2 * 60_000;
const defaultLimit = 200;
const abandonedRunMs = 15 * 60_000;
const maxReported = 50;

export const executionReconciliationErrorCodes = ["invalid_input", "attempt_not_found", "reconciliation_in_progress", "run_not_found"] as const;
export type ExecutionReconciliationErrorCode = (typeof executionReconciliationErrorCodes)[number];

export class ExecutionReconciliationError extends Error {
  readonly code: ExecutionReconciliationErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ExecutionReconciliationErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "ExecutionReconciliationError";
    this.code = code;
    this.details = details;
  }
}

type AttemptView = NonNullable<Awaited<ReturnType<typeof getExecutionAttempt>>>;
type RunnerRow = { run_id: string; attempt_id: string; supervisor_pid: number | string; supervisor_host: string; harness_pid: number | string | null; heartbeat_at: string; finished_at: string | null; outcome: string | null };
type Options = { runId: string; actorId: string; attemptId: string | null; cutoff: string; runnerStaleMs: number; limit: number };

class DecisionLog {
  private sequence = 0;
  readonly counts: Record<Action | "examined" | "healthy" | "awaiting_operator", number> = {
    examined: 0, healthy: 0, awaiting_operator: 0, repaired: 0, quarantined: 0, released: 0, reported: 0, skipped: 0, failed: 0,
  };

  constructor(private readonly runId: string) {}

  async record(entry: { attempt_id: string | null; lease_id?: string | null; classification: string; action: Action; reason?: string | null; detail?: Record<string, unknown>; error?: unknown }) {
    this.sequence += 1;
    this.counts[entry.action] += 1;
    await adapter.run(`
      INSERT INTO execution_reconciliation_decisions (id, run_id, sequence, attempt_id, lease_id, classification, action, reason, detail, error, created_at)
      VALUES (@id, @run_id, @sequence, @attempt_id, @lease_id, @classification, @action, @reason, @detail, @error, @created_at)
    `, {
      id: `reconciliation_decision_${nanoid()}`,
      run_id: this.runId,
      sequence: this.sequence,
      attempt_id: entry.attempt_id,
      lease_id: entry.lease_id ?? null,
      classification: entry.classification,
      action: entry.action,
      reason: entry.reason ?? null,
      detail: json(entry.detail ?? {}),
      error: entry.error === undefined ? null : errorMessage(entry.error).slice(0, 2000),
      created_at: nowIso(),
    });
  }
}

// --- runs -------------------------------------------------------------------------------------

export async function reconcileExecution(input: {
  trigger?: unknown;
  attempt_id?: unknown;
  min_age_ms?: unknown;
  runner_stale_ms?: unknown;
  limit?: unknown;
  actor_kind?: unknown;
  actor_id?: unknown;
} = {}) {
  const trigger = (input.trigger ?? "manual") as ReconciliationTrigger;
  if (!reconciliationTriggers.includes(trigger)) throw invalid(`trigger must be one of ${reconciliationTriggers.join(", ")}`, { field: "trigger" });
  const attemptId = optionalText(input.attempt_id, "attempt_id");
  const minAgeMs = boundedInteger(input.min_age_ms, "min_age_ms", defaultMinAgeMs, 0, 24 * 3_600_000);
  const runnerStaleMs = boundedInteger(input.runner_stale_ms, "runner_stale_ms", defaultRunnerStaleMs, 50, 3_600_000);
  const limit = boundedInteger(input.limit, "limit", defaultLimit, 1, 1000);
  let actor = { kind: "reconciler", id: `hub-${trigger}` };
  if (trigger === "manual") {
    const kind = optionalText(input.actor_kind, "actor_kind") ?? "operator";
    if (kind !== "operator" && kind !== "reconciler") throw invalid("actor_kind must be operator or reconciler", { field: "actor_kind" });
    actor = { kind, id: optionalText(input.actor_id, "actor_id") ?? "operator" };
  }
  if (attemptId && !(await getExecutionAttempt(attemptId))) {
    throw new ExecutionReconciliationError("attempt_not_found", `Execution attempt not found: ${attemptId}`, { attempt_id: attemptId });
  }

  const scope = { attempt_id: attemptId, min_age_ms: minAgeMs, runner_stale_ms: runnerStaleMs, limit };
  const runId = await startRun(trigger, actor, scope);
  const log = new DecisionLog(runId);
  const options: Options = { runId, actorId: `reconciler:${runId}`, attemptId, cutoff: new Date(Date.now() - minAgeMs).toISOString(), runnerStaleMs, limit };
  const summary: Record<string, unknown> = {};
  try {
    await reconcileAcceptances(log, options);
    await reconcileLiveAttempts(log, options);
    await reconcileTerminalLeases(log, options);
    summary.lapsed_claims = await lapsedClaims(options);
    summary.unowned_worktrees = attemptId ? [] : await unownedWorktrees();
    Object.assign(summary, log.counts);
    await finishRun(runId, "completed", summary, null);
  } catch (error) {
    Object.assign(summary, log.counts);
    await finishRun(runId, "failed", summary, error);
    throw error;
  }
  return await getReconciliationRun(runId);
}

async function startRun(trigger: ReconciliationTrigger, actor: { kind: string; id: string }, scope: Record<string, unknown>) {
  const id = `reconciliation_${nanoid()}`;
  for (let tries = 1; ; tries += 1) {
    const at = nowIso();
    try {
      await adapter.run(`
        INSERT INTO execution_reconciliation_runs (id, trigger, actor_kind, actor_id, status, scope, summary, error, started_at, finished_at)
        VALUES (@id, @trigger, @actor_kind, @actor_id, 'running', @scope, '{}', NULL, @at, NULL)
      `, { id, trigger, actor_kind: actor.kind, actor_id: actor.id, scope: json(scope), at });
      return id;
    } catch (error) {
      if (!isUniqueViolation(error, ["execution_reconciliation_runs.status", "idx_execution_reconciliation_running"])) throw error;
      const running = await adapter.get<{ id: string; started_at: string }>("SELECT id, started_at FROM execution_reconciliation_runs WHERE status = 'running'");
      if (tries > 1 || (running && Date.parse(running.started_at) > Date.now() - abandonedRunMs)) {
        throw new ExecutionReconciliationError("reconciliation_in_progress", `Reconciliation ${running?.id ?? ""} is already running`, { run_id: running?.id ?? null });
      }
      if (running) {
        await adapter.run(
          "UPDATE execution_reconciliation_runs SET status = 'abandoned', error = @error, finished_at = @at WHERE id = @id AND status = 'running'",
          { id: running.id, error: "stopped reporting; superseded by a later run", at },
        );
      }
    }
  }
}

async function finishRun(id: string, status: "completed" | "failed", summary: Record<string, unknown>, error: unknown) {
  await adapter.run(
    "UPDATE execution_reconciliation_runs SET status = @status, summary = @summary, error = @error, finished_at = @at WHERE id = @id AND status = 'running'",
    { id, status, summary: json(summary), error: error === null ? null : errorMessage(error).slice(0, 2000), at: nowIso() },
  );
}

// --- interrupted acceptances ---------------------------------------------------------------------

async function reconcileAcceptances(log: DecisionLog, options: Options) {
  const rows = await adapter.all<{ id: string; attempt_id: string; idempotency_key: string; actor_kind: string; actor_id: string; step: string }>(`
    SELECT id, attempt_id, idempotency_key, actor_kind, actor_id, step FROM execution_acceptances
    WHERE status = 'in_progress' AND updated_at <= @cutoff ${options.attemptId ? "AND attempt_id = @attempt_id" : ""}
    ORDER BY updated_at LIMIT @limit
  `, { cutoff: options.cutoff, attempt_id: options.attemptId, limit: options.limit });
  for (const row of rows) {
    log.counts.examined += 1;
    try {
      const resumed = await acceptExecutionAttempt({ attempt_id: row.attempt_id, idempotency_key: row.idempotency_key, actor_kind: row.actor_kind, actor_id: row.actor_id });
      await log.record({ attempt_id: row.attempt_id, classification: "interrupted_acceptance", action: "repaired", detail: { acceptance_id: row.id, from_step: row.step, status: resumed.acceptance.status } });
    } catch (error) {
      await log.record({ attempt_id: row.attempt_id, classification: "interrupted_acceptance", action: "failed", detail: { acceptance_id: row.id, from_step: row.step }, error });
    }
  }
}

// --- live attempts ------------------------------------------------------------------------------------

async function reconcileLiveAttempts(log: DecisionLog, options: Options) {
  const rows = await adapter.all<{ id: string }>(`
    SELECT a.id FROM execution_attempts a
    WHERE a.state IN (${liveExecutionStatesSql}) AND a.state_changed_at <= @cutoff ${options.attemptId ? "AND a.id = @attempt_id" : ""}
      AND NOT EXISTS (SELECT 1 FROM execution_acceptances x WHERE x.attempt_id = a.id AND x.status = 'in_progress')
    ORDER BY a.state_changed_at LIMIT @limit
  `, { cutoff: options.cutoff, attempt_id: options.attemptId, limit: options.limit });
  for (const row of rows) {
    const attempt = await getExecutionAttempt(row.id);
    if (!attempt) continue;
    log.counts.examined += 1;
    try {
      if (attempt.state === "stale" || attempt.state === "reconciling") log.counts.awaiting_operator += 1;
      else if (attempt.state === "running") await reconcileRunning(log, options, attempt);
      else if (attempt.state === "provisioning") await reconcileProvisioning(log, options, attempt);
      else await reconcileWorkspace(log, options, attempt);
    } catch (error) {
      await log.record({ attempt_id: attempt.id, classification: "reconciliation_error", action: "failed", error });
    }
  }
}

async function reconcileRunning(log: DecisionLog, options: Options, attempt: AttemptView) {
  const runner = await adapter.get<RunnerRow>("SELECT * FROM execution_runners WHERE attempt_id = @attempt_id ORDER BY started_at DESC LIMIT 1", { attempt_id: attempt.id });
  if (runner && !runner.finished_at && Date.parse(runner.heartbeat_at) > Date.now() - options.runnerStaleMs) {
    log.counts.healthy += 1;
    return;
  }
  const outcome = runner?.finished_at ? parseJson<{ event?: string | null; reason?: string | null; note?: string | null; artifacts?: unknown[]; details?: Record<string, unknown> } | null>(runner.outcome, null) : null;
  if (runner && outcome?.event) {
    // The runner recorded how the harness ended, then died before its finish
    // transition. Applying it with the runner's own key makes a late runner's
    // transition a replay rather than a second outcome.
    await transitionExecutionAttempt({
      attempt_id: attempt.id,
      event: outcome.event,
      expected_revision: attempt.revision,
      idempotency_key: `${runner.run_id}:finish`,
      actor_kind: "control_plane",
      actor_id: options.actorId,
      reason: outcome.reason ?? null,
      note: outcome.note ?? null,
      artifacts: outcome.artifacts ?? [],
      details: { ...(outcome.details ?? {}), reconciliation_run: options.runId },
    });
    await log.record({ attempt_id: attempt.id, classification: "result_unrecorded", action: "repaired", reason: outcome.reason ?? null, detail: { run_id: runner.run_id, event: outcome.event } });
    return;
  }
  const pid = attempt.process.pid;
  const local = !runner || runner.supervisor_host === hostname();
  const alive = pid && local ? processAlive(Number(pid)) : null;
  const classification = alive === true ? "orphaned_process" : alive === false ? "dead_runner" : "runner_unreachable";
  await quarantine(log, options, attempt, "heartbeat_lost", classification, {
    run_id: runner?.run_id ?? null,
    supervisor_pid: runner ? Number(runner.supervisor_pid) : null,
    supervisor_host: runner?.supervisor_host ?? null,
    heartbeat_at: runner?.heartbeat_at ?? null,
    harness_pid: pid,
    harness_alive: alive,
    process_left_running: alive === true,
  });
}

async function reconcileProvisioning(log: DecisionLog, options: Options, attempt: AttemptView) {
  const lease = (await listExecutionWorkspaces({ attempt_id: attempt.id })).at(0) ?? (await listExecutionWorkspaces({ attempt_id: attempt.id, include_released: true })).find((candidate) => candidate.status === "failed");
  if (!lease || lease.updated_at > options.cutoff) {
    log.counts.healthy += 1;
    return;
  }
  const classification = lease.status === "failed"
    ? "failed_provisioning"
    : lease.status === "provisioning" ? "interrupted_provisioning" : lease.expired ? "expired_lease" : !existsSync(lease.worktree_path) ? "missing_worktree" : null;
  if (!classification) {
    log.counts.healthy += 1;
    return;
  }
  await repairThroughProvisioning(log, options, attempt, lease, classification);
}

async function reconcileWorkspace(log: DecisionLog, options: Options, attempt: AttemptView) {
  const lease = (await listExecutionWorkspaces({ attempt_id: attempt.id })).at(0);
  if (!lease) {
    if (attempt.workspace.lease_id) await quarantine(log, options, attempt, "worktree_missing", "lease_missing", { lease_id: attempt.workspace.lease_id });
    else log.counts.healthy += 1;
    return;
  }
  if (!existsSync(lease.worktree_path)) {
    await quarantine(log, options, attempt, "worktree_missing", "missing_worktree", { lease_id: lease.id, worktree_path: lease.worktree_path });
    return;
  }
  const head = await runGit(lease.worktree_path, ["symbolic-ref", "--short", "HEAD"]);
  if (!head.ok || head.stdout !== lease.branch) {
    await quarantine(log, options, attempt, "branch_moved", "branch_moved", { lease_id: lease.id, branch: lease.branch, checked_out: head.ok ? head.stdout : null });
    return;
  }
  const contained = await runGit(lease.worktree_path, ["merge-base", "--is-ancestor", lease.base_sha, "HEAD"]);
  if (!contained.ok) {
    if (contained.exitCode === 1) await quarantine(log, options, attempt, "base_drift", "base_drift", { lease_id: lease.id, base_sha: lease.base_sha });
    else await log.record({ attempt_id: attempt.id, lease_id: lease.id, classification: "base_check_failed", action: "failed", error: contained.stderr });
    return;
  }
  if (lease.expired && lease.updated_at <= options.cutoff) {
    await repairThroughProvisioning(log, options, attempt, lease, "expired_lease");
    return;
  }
  log.counts.healthy += 1;
}

async function repairThroughProvisioning(log: DecisionLog, options: Options, attempt: AttemptView, lease: { id: string; repository_path: string }, classification: string) {
  try {
    const repaired = await provisionExecutionWorkspace({ attempt_id: attempt.id, repository_path: lease.repository_path });
    await log.record({ attempt_id: attempt.id, lease_id: repaired.workspace.id, classification, action: "repaired", detail: { lease_status: repaired.workspace.status, created: repaired.created } });
  } catch (error) {
    const code = error instanceof ExecutionWorkspaceError ? error.code : null;
    if (code === "lease_conflict") {
      await log.record({ attempt_id: attempt.id, lease_id: lease.id, classification, action: "skipped", reason: code, error });
      return;
    }
    const reason = code === "base_drift" || code === "base_missing" ? "base_drift" : code === "workspace_inconsistent" || code === "branch_exists" ? "branch_moved" : code === "lease_expired" ? "lease_expired" : "worktree_missing";
    const current = await getExecutionAttempt(attempt.id);
    if (current) await quarantine(log, options, current, reason, classification, { lease_id: lease.id, repair_error: errorMessage(error).slice(0, 500) });
  }
}

async function quarantine(log: DecisionLog, options: Options, attempt: AttemptView, reason: string, classification: string, detail: Record<string, unknown>) {
  try {
    await transitionExecutionAttempt({
      attempt_id: attempt.id,
      event: "mark_stale",
      expected_revision: attempt.revision,
      idempotency_key: `reconcile:${options.runId}:${attempt.id}`,
      actor_kind: "reconciler",
      actor_id: options.actorId,
      reason,
      details: { classification, reconciliation_run: options.runId, ...detail },
    });
    await log.record({ attempt_id: attempt.id, lease_id: (detail.lease_id as string | undefined) ?? null, classification, action: "quarantined", reason, detail });
  } catch (error) {
    // A concurrent transition means another process acted on the attempt; the
    // next run sees its new state.
    await log.record({ attempt_id: attempt.id, classification, action: "skipped", reason, detail, error });
  }
}

// --- leases of terminal attempts ----------------------------------------------------------------------

async function reconcileTerminalLeases(log: DecisionLog, options: Options) {
  const rows = await adapter.all<{ id: string; attempt_id: string; state: string }>(`
    SELECT l.id, l.attempt_id, a.state FROM execution_workspace_leases l
    JOIN execution_attempts a ON a.id = l.attempt_id
    WHERE l.status <> 'released' AND a.state NOT IN (${liveExecutionStatesSql})
      AND COALESCE(a.terminal_at, a.updated_at) <= @cutoff AND l.updated_at <= @cutoff
      ${options.attemptId ? "AND a.id = @attempt_id" : ""}
    ORDER BY l.created_at LIMIT @limit
  `, { cutoff: options.cutoff, attempt_id: options.attemptId, limit: options.limit });
  for (const row of rows) {
    log.counts.examined += 1;
    try {
      const released = await releaseExecutionWorkspace({ id: row.id });
      await log.record({ attempt_id: row.attempt_id, lease_id: row.id, classification: "terminal_attempt_lease", action: "released", detail: { attempt_state: row.state, worktree: released.worktree } });
    } catch (error) {
      await log.record({ attempt_id: row.attempt_id, lease_id: row.id, classification: "terminal_attempt_lease", action: "failed", error });
    }
  }
}

// --- reports -------------------------------------------------------------------------------------------

async function lapsedClaims(options: Options) {
  const now = nowIso();
  const rows = await adapter.all<Record<string, unknown>>(`
    SELECT a.id AS attempt_id, a.state, a.claim_id, c.status AS claim_status, c.expires_at AS claim_expires_at, s.status AS session_status
    FROM execution_attempts a
    LEFT JOIN issue_claims c ON c.id = a.claim_id
    LEFT JOIN agent_sessions s ON s.id = c.session_id
    WHERE a.state IN (${liveExecutionStatesSql}) ${options.attemptId ? "AND a.id = @attempt_id" : ""}
      AND (c.id IS NULL OR c.status <> 'active' OR c.released_at IS NOT NULL OR c.expires_at <= @now OR s.id IS NULL OR s.status <> 'active' OR s.expires_at <= @now)
    LIMIT @limit
  `, { now, attempt_id: options.attemptId, limit: maxReported });
  return rows;
}

async function unownedWorktrees() {
  const root = executionWorkspaceRoot();
  if (!existsSync(root)) return [];
  const key = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
  const owned = new Set((await adapter.all<{ worktree_path: string }>("SELECT worktree_path FROM execution_workspace_leases")).map((row) => key(row.worktree_path)));
  const unowned: string[] = [];
  for (const repository of readdirSync(root, { withFileTypes: true })) {
    if (!repository.isDirectory()) continue;
    for (const entry of readdirSync(join(root, repository.name), { withFileTypes: true })) {
      const path = join(root, repository.name, entry.name);
      if (entry.isDirectory() && !owned.has(key(path))) unowned.push(path);
      if (unowned.length >= maxReported) return unowned;
    }
  }
  return unowned;
}

// --- operator actions and reads --------------------------------------------------------------------------

// An operator's quarantine: begin_reconciliation records the current state as the
// origin, so the attempt can later resume there, fail, or be canceled.
export async function quarantineExecutionAttempt(input: { attempt_id?: unknown; idempotency_key?: unknown; actor_kind?: unknown; actor_id?: unknown; note?: unknown }) {
  const attemptId = optionalText(input.attempt_id, "attempt_id");
  if (!attemptId) throw invalid("attempt_id is required", { field: "attempt_id" });
  const idempotencyKey = optionalText(input.idempotency_key, "idempotency_key");
  if (!idempotencyKey) throw invalid("idempotency_key is required", { field: "idempotency_key" });
  const attempt = await getExecutionAttempt(attemptId);
  if (!attempt) throw new ExecutionReconciliationError("attempt_not_found", `Execution attempt not found: ${attemptId}`, { attempt_id: attemptId });
  return await transitionExecutionAttempt({
    attempt_id: attempt.id,
    event: "begin_reconciliation",
    expected_revision: attempt.revision,
    idempotency_key: idempotencyKey,
    actor_kind: optionalText(input.actor_kind, "actor_kind") ?? "operator",
    actor_id: optionalText(input.actor_id, "actor_id") ?? "operator",
    note: optionalText(input.note, "note"),
  });
}

export async function listReconciliationRuns(input: { limit?: unknown } = {}) {
  const limit = boundedInteger(input.limit, "limit", 20, 1, 200);
  const rows = await adapter.all<Record<string, unknown>>("SELECT * FROM execution_reconciliation_runs ORDER BY started_at DESC LIMIT @limit", { limit });
  return rows.map(hydrateRun);
}

export async function getReconciliationRun(id: string) {
  const row = await adapter.get<Record<string, unknown>>("SELECT * FROM execution_reconciliation_runs WHERE id = @id", { id });
  if (!row) throw new ExecutionReconciliationError("run_not_found", `Reconciliation run not found: ${id}`, { run_id: id });
  const decisions = await adapter.all<Record<string, unknown>>("SELECT * FROM execution_reconciliation_decisions WHERE run_id = @id ORDER BY sequence", { id });
  return {
    ...hydrateRun(row),
    decisions: decisions.map((decision) => ({
      sequence: Number(decision.sequence),
      attempt_id: (decision.attempt_id as string | null) ?? null,
      lease_id: (decision.lease_id as string | null) ?? null,
      classification: String(decision.classification),
      action: String(decision.action),
      reason: (decision.reason as string | null) ?? null,
      detail: parseJson<Record<string, unknown>>(decision.detail as string, {}),
      error: (decision.error as string | null) ?? null,
      created_at: String(decision.created_at),
    })),
  };
}

function hydrateRun(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    trigger: String(row.trigger),
    actor: { kind: String(row.actor_kind), id: String(row.actor_id) },
    status: String(row.status),
    scope: parseJson<Record<string, unknown>>(row.scope as string, {}),
    summary: parseJson<Record<string, unknown>>(row.summary as string, {}),
    error: (row.error as string | null) ?? null,
    started_at: String(row.started_at),
    finished_at: (row.finished_at as string | null) ?? null,
  };
}

// Startup and periodic reconciliation for an API server. Periodic ticks never
// overlap in this process, and a run held by another process is skipped quietly.
export function startReconciliationLoop(report: (message: string) => void = () => undefined) {
  if (process.env.CLAW_TASK_HUB_RECONCILE === "0") return () => undefined;
  const configured = Number(process.env.CLAW_TASK_HUB_RECONCILE_INTERVAL_MS ?? 5 * 60_000);
  const intervalMs = Number.isFinite(configured) ? Math.max(10_000, configured) : 5 * 60_000;
  let running = false;
  const tick = (trigger: ReconciliationTrigger) => {
    if (running) return;
    running = true;
    void reconcileExecution({ trigger, min_age_ms: process.env.CLAW_TASK_HUB_RECONCILE_MIN_AGE_MS, runner_stale_ms: process.env.CLAW_TASK_HUB_RUNNER_STALE_MS })
      .then((run) => {
        const acted = ["repaired", "quarantined", "released", "failed"].reduce((sum, key) => sum + Number(run.summary[key] ?? 0), 0);
        if (acted) report(`execution reconciliation ${run.id} (${trigger}) recorded ${acted} decision(s)`);
      })
      .catch((error: unknown) => {
        if (!(error instanceof ExecutionReconciliationError && error.code === "reconciliation_in_progress")) report(`execution reconciliation (${trigger}) failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  tick("startup");
  const timer = setInterval(() => tick("periodic"), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// --- helpers -----------------------------------------------------------------------------------------------

// Signal 0 checks for existence without delivering anything. EPERM means the
// process exists but belongs to someone else, which still counts as alive.
function processAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

function boundedInteger(value: unknown, field: string, fallback: number, min: number, max: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) throw invalid(`${field} must be an integer from ${min} to ${max}`, { field });
  return numeric;
}

function optionalText(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > 2000) throw invalid(`${field} must be a non-empty string`, { field });
  return value.trim();
}

function invalid(message: string, details: Record<string, unknown> = {}) {
  return new ExecutionReconciliationError("invalid_input", message, details);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isUniqueViolation(error: unknown, markers: string[]) {
  const record = (error ?? {}) as { code?: unknown; constraint_name?: unknown; message?: unknown };
  const message = String(record.message ?? "");
  const text = record.code === "23505" ? `${String(record.constraint_name ?? "")} ${message}` : message.includes("UNIQUE constraint failed") ? message : "";
  return Boolean(text) && markers.some((marker) => text.includes(marker));
}
