// Launching and supervising harness runs for execution attempts.
//
// The launch order is what prevents duplicate work. The harness is spawned with
// its instructions withheld -- every adapter reads them from stdin -- and only
// then does the runner apply the contract's launch transition, a compare-and-set
// on the attempt revision that binds the workspace lease and process identity.
// The winner receives its instructions; a loser, or a replay of a launch that
// already happened, has its process tree terminated before it has anything to
// act on.
//
// While a run is live the runner enforces the contract's bounds: wall-clock and
// idle-output timeouts, and captured stdout/stderr kept to a head and tail with
// an explicit marker for what was dropped. It watches the attempt record, so a
// cancellation, failure, or quarantine applied by anyone -- another process
// included -- stops the process tree after the grace period. When the run ends,
// scrubbed logs are written as artifacts and the attempt moves to verifying or
// failed with the run's details in the ledger.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { customAlphabet } from "nanoid";
import { hostname } from "node:os";
import { adapter as database, nowIso, resolveDbPath } from "./db.js";
import {
  buildHarnessEnvironment,
  executionAdapterCapabilities,
  getExecutionAdapter,
  type AdapterContext,
  type AdapterEventReader,
  type ExecutionAdapter,
  type ExecutionAdapterCapability,
} from "./execution-adapters.js";
import { getExecutionAttempt, transitionExecutionAttempt } from "./execution-attempts.js";
import { executionBounds, initialExecutionState } from "./execution-contract.js";
import { blockingConflictsForAttempt, detectExecutionConflicts } from "./execution-conflicts.js";
import { executionWorkspaceRoot, listExecutionWorkspaces } from "./execution-workspaces.js";
import { faultPoint } from "./fault-injection.js";
import { terminateProcessTree, waitForExit, type TerminationOutcome } from "./process-tree.js";
import { notifyOpenUis } from "./refresh-notifier.js";

const execFileAsync = promisify(execFile);
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export const executionRunErrorCodes = [
  "invalid_input",
  "attempt_not_found",
  "attempt_not_launchable",
  "workspace_not_ready",
  "adapter_unknown",
  "adapter_unavailable",
  "capability_unsupported",
  "conflict_blocked",
  "launch_failed",
] as const;
export type ExecutionRunErrorCode = (typeof executionRunErrorCodes)[number];

export class ExecutionRunError extends Error {
  readonly code: ExecutionRunErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ExecutionRunErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "ExecutionRunError";
    this.code = code;
    this.details = details;
  }
}

export type LaunchExecutionAttemptInput = {
  attempt_id?: unknown;
  adapter?: unknown;
  prompt?: unknown;
  model?: unknown;
  requires?: unknown;
  idempotency_key?: unknown;
  wall_clock_ms?: unknown;
  idle_output_ms?: unknown;
  cancellation_grace_ms?: unknown;
  captured_stream_bytes?: unknown;
};

export type ExecutionRunOutcome = {
  attempt_id: string;
  adapter: string;
  pid: number | null;
  result: "completed" | "failed" | "stopped";
  event: "complete_run" | "fail" | null;
  reason: string | null;
  stopped_by_state: string | null;
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  timeout: "wall_clock" | "idle_output" | null;
  termination: TerminationOutcome | null;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  events: number;
  thread_id: string | null;
  failure: string | null;
  artifacts: { kind: string; ref: string }[];
  transition_error: string | null;
};

type RunBounds = { wall_clock_ms: number; idle_output_ms: number; cancellation_grace_ms: number; captured_stream_bytes: number };

const maxPromptCharacters = 200_000;
const statePollMs = 500;
const streamDrainMs = 2_000;
// States in which a harness keeps running. Anything else -- canceled, failed,
// stale -- was decided by someone else, and the process tree is stopped.
const runningStates = new Set(["running", "reconciling"]);

export async function launchExecutionAttempt(input: LaunchExecutionAttemptInput) {
  const attemptId = requiredText(input.attempt_id, "attempt_id", 200);
  const adapterId = requiredText(input.adapter, "adapter", 60);
  const prompt = promptInput(input.prompt);
  const model = optionalText(input.model, "model", 120);
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)) throw invalid("model must be a plain model identifier", { field: "model" });
  const idempotencyKey = requiredText(input.idempotency_key, "idempotency_key", executionBounds.idempotency_key.value);
  const bounds = runBounds(input);

  const adapter = getExecutionAdapter(adapterId);
  if (!adapter) throw new ExecutionRunError("adapter_unknown", `No execution adapter is named ${adapterId}`, { adapter: adapterId });
  const requested = requestedCapabilities(input.requires, model);
  const missing = requested.filter((capability) => !adapter.capabilities.includes(capability));
  if (missing.length) {
    throw new ExecutionRunError("capability_unsupported", `${adapter.id} does not support ${missing.join(", ")}`, { adapter: adapter.id, missing, capabilities: adapter.capabilities });
  }
  const location = adapter.locate();
  if (!location.ok) throw new ExecutionRunError("adapter_unavailable", location.reason, { adapter: adapter.id });

  const attempt = await getExecutionAttempt(attemptId);
  if (!attempt) throw new ExecutionRunError("attempt_not_found", `Execution attempt not found: ${attemptId}`, { attempt_id: attemptId });
  if (attempt.last_event === "launch" && attempt.last_idempotency_key === idempotencyKey) {
    // The same launch request again, after it already won: nothing new starts.
    return { attempt, replayed: true, run: null, completion: Promise.resolve(null) };
  }
  if (attempt.state !== initialExecutionState) {
    throw new ExecutionRunError("attempt_not_launchable", `Attempt ${attempt.id} is ${attempt.state}; only an attempt in ${initialExecutionState} can be launched`, { attempt_id: attempt.id, state: attempt.state });
  }
  const lease = (await listExecutionWorkspaces({ attempt_id: attempt.id }))[0];
  if (!lease || lease.status !== "active" || lease.expired || !existsSync(lease.worktree_path) || !insideWorkspaceRoot(lease.worktree_path)) {
    throw new ExecutionRunError(
      "workspace_not_ready",
      `Attempt ${attempt.id} has no active, unexpired workspace lease with its worktree in place; provision it first`,
      { attempt_id: attempt.id, lease_id: lease?.id ?? null, lease_status: lease?.status ?? null, expired: lease?.expired ?? null },
    );
  }
  // Conflicts are re-detected before any process starts, so a launch sees the
  // overlaps of the moment rather than whatever was last recorded.
  await detectExecutionConflicts({ attempt_id: attempt.id });
  const blocking = await blockingConflictsForAttempt(attempt.id);
  if (blocking.length) {
    throw new ExecutionRunError(
      "conflict_blocked",
      `Attempt ${attempt.id} has ${blocking.length} open blocking conflict(s) with live attempts; an operator must override them, or the overlap must go away`,
      {
        attempt_id: attempt.id,
        conflicts: blocking.map((conflict) => ({
          id: conflict.id,
          path: conflict.path,
          method: conflict.method,
          certainty: conflict.certainty,
          other_attempt_id: conflict.attempts.find((other) => other.id !== attempt.id)?.id ?? null,
        })),
      },
    );
  }

  const version = await probeVersion(adapter, location.command, location.prefixArgs);
  const runId = `run_${nanoid()}`;
  const logDirectory = join(dirname(resolveDbPath()), "attempt-logs", attempt.id);
  mkdirSync(logDirectory, { recursive: true });
  const context: AdapterContext = {
    attempt: { id: attempt.id, issue_id: attempt.issue_id, issue_identifier: attempt.issue_identifier, base_sha: attempt.base_sha },
    workspace: { worktree_path: lease.worktree_path, branch: lease.branch, lease_id: lease.id },
    model,
    final_message_path: join(logDirectory, `${runId}-final-message.txt`),
  };
  const args = [...location.prefixArgs, ...adapter.buildArgs(context)];
  const environment = buildHarnessEnvironment(adapter, context);

  const child = spawn(location.command, args, {
    cwd: lease.worktree_path,
    env: environment.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  try {
    await spawned(child);
  } catch (error) {
    throw new ExecutionRunError("launch_failed", `${adapter.id} could not start: ${errorMessage(error)}`, { adapter: adapter.id });
  }
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const capture = { stdout: new BoundedCapture(bounds.captured_stream_bytes), stderr: new BoundedCapture(bounds.captured_stream_bytes) };
  const reader = adapter.readEvents();
  const activity = { last: Date.now() };
  attachCapture(child, capture, reader, activity);

  let launched: Awaited<ReturnType<typeof transitionExecutionAttempt>>;
  try {
    launched = await transitionExecutionAttempt({
      attempt_id: attempt.id,
      event: "launch",
      expected_revision: attempt.revision,
      idempotency_key: idempotencyKey,
      actor_kind: "control_plane",
      actor_id: `adapter:${adapter.id}`,
      workspace: { branch: lease.branch, worktree_path: lease.worktree_path, lease_id: lease.id },
      process: { pid: child.pid, started_at: startedAt },
      details: {
        run_id: runId,
        adapter: adapter.id,
        adapter_version: version,
        command: basename(location.command),
        argument_count: args.length,
        model,
        environment: environment.names,
        secret_environment: environment.secrets.map((secret) => secret.name),
        capabilities: adapter.capabilities,
        requested_capabilities: requested,
        bounds,
      },
    });
  } catch (error) {
    await terminateProcessTree(child, 0);
    throw error;
  }
  if (launched.outcome === "replayed") {
    await terminateProcessTree(child, 0);
    return { attempt: launched.attempt, replayed: true, run: null, completion: Promise.resolve(null) };
  }

  // The supervisor registers before the harness gets its prompt, so
  // reconciliation can tell a supervised run from one whose hub process died.
  await registerRunner(runId, attempt.id, adapter.id, child.pid ?? null);
  // The launch is ours: only now does the harness receive its instructions.
  child.stdin?.end(prompt);
  faultPoint("run:supervising");
  const run = {
    id: runId,
    attempt_id: attempt.id,
    adapter,
    child,
    pid: child.pid ?? null,
    revision: launched.attempt.revision,
    started_ms: startedMs,
    bounds,
    capture,
    reader,
    activity,
    secrets: environment.secrets,
    log_directory: logDirectory,
    final_message_path: context.final_message_path,
  };
  return {
    attempt: launched.attempt,
    replayed: false,
    run: { id: runId, adapter: adapter.id, adapter_version: version, pid: run.pid, started_at: startedAt, worktree_path: lease.worktree_path, bounds },
    completion: superviseRun(run),
  };
}

type SupervisedRun = {
  id: string;
  attempt_id: string;
  adapter: ExecutionAdapter;
  child: ChildProcess;
  pid: number | null;
  revision: number;
  started_ms: number;
  bounds: RunBounds;
  capture: { stdout: BoundedCapture; stderr: BoundedCapture };
  reader: AdapterEventReader;
  activity: { last: number };
  secrets: { name: string; value: string }[];
  log_directory: string;
  final_message_path: string;
};

async function superviseRun(run: SupervisedRun): Promise<ExecutionRunOutcome> {
  let timeout: ExecutionRunOutcome["timeout"] = null;
  let stoppedByState: string | null = null;
  // Held in an object: the pending stop is assigned from timer and poll
  // callbacks, and a plain local would be narrowed to null where it is awaited.
  const stopping: { pending: Promise<TerminationOutcome> | null } = { pending: null };
  const stop = () => {
    stopping.pending ??= terminateProcessTree(run.child, run.bounds.cancellation_grace_ms);
  };

  // The supervisor's heartbeat is how reconciliation tells a live run from one
  // whose hub process died; a failed write is simply retried on the next beat.
  const heartbeat = setInterval(() => {
    void database.run(
      "UPDATE execution_runners SET heartbeat_at = @at WHERE run_id = @run_id AND finished_at IS NULL",
      { run_id: run.id, at: nowIso() },
    ).catch(() => undefined);
  }, runnerHeartbeatMs());
  const wallClock = setTimeout(() => {
    timeout ??= "wall_clock";
    stop();
  }, run.bounds.wall_clock_ms);
  const idleCheck = setInterval(() => {
    if (Date.now() - run.activity.last >= run.bounds.idle_output_ms) {
      timeout ??= "idle_output";
      stop();
    }
  }, Math.max(25, Math.min(250, Math.floor(run.bounds.idle_output_ms / 4))));
  let polling = false;
  const stateWatch = setInterval(() => {
    if (polling || stopping.pending) return;
    polling = true;
    void getExecutionAttempt(run.attempt_id)
      .then((current) => {
        if (current && !runningStates.has(current.state)) {
          stoppedByState = current.state;
          stop();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        polling = false;
      });
  }, statePollMs);

  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    if (run.child.exitCode !== null || run.child.signalCode !== null) resolve({ code: run.child.exitCode, signal: run.child.signalCode });
    else run.child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(wallClock);
  clearInterval(idleCheck);
  clearInterval(stateWatch);
  clearInterval(heartbeat);
  // Give the pipes a moment to drain. A descendant still holding them open after
  // the harness exited belongs to the run's tree and is stopped with it.
  const drained = await Promise.race([
    new Promise<boolean>((resolve) => run.child.once("close", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), streamDrainMs)),
  ]);
  if (!drained) {
    stop();
    run.child.stdout?.destroy();
    run.child.stderr?.destroy();
  }
  const termination = stopping.pending ? await stopping.pending : null;
  await waitForExit(run.child, 1_000);

  const report = run.reader.report();
  const artifacts = writeArtifacts(run);
  const outcome: ExecutionRunOutcome = {
    attempt_id: run.attempt_id,
    adapter: run.adapter.id,
    pid: run.pid,
    result: "stopped",
    event: null,
    reason: null,
    stopped_by_state: stoppedByState,
    exit_code: exit.code,
    signal: exit.signal,
    duration_ms: Date.now() - run.started_ms,
    timeout,
    termination,
    stdout_bytes: run.capture.stdout.total,
    stderr_bytes: run.capture.stderr.total,
    stdout_truncated: run.capture.stdout.truncated,
    stderr_truncated: run.capture.stderr.truncated,
    events: report.events,
    thread_id: report.thread_id,
    failure: report.failure ? scrub(report.failure, run.secrets).slice(0, 500) : null,
    artifacts,
    transition_error: null,
  };
  if (stoppedByState) {
    await finishRunner(run.id, { event: null, stopped_by_state: stoppedByState });
    return outcome;
  }

  const eventsRequired = run.adapter.capabilities.includes("jsonl_events");
  const succeeded = !timeout && exit.code === 0 && (!eventsRequired || (report.completed && !report.failure));
  outcome.result = succeeded ? "completed" : "failed";
  outcome.event = succeeded ? "complete_run" : "fail";
  outcome.reason = succeeded ? null : timeout ? "harness_timeout" : "harness_failed";
  const finishDetails = {
    run_id: run.id,
    exit_code: outcome.exit_code,
    signal: outcome.signal,
    duration_ms: outcome.duration_ms,
    timeout: outcome.timeout,
    termination: outcome.termination,
    stdout_bytes: outcome.stdout_bytes,
    stderr_bytes: outcome.stderr_bytes,
    stdout_truncated: outcome.stdout_truncated,
    stderr_truncated: outcome.stderr_truncated,
    events: outcome.events,
    thread_id: outcome.thread_id,
    failure: outcome.failure,
  };
  // The outcome is durable before its transition, so a supervisor that dies
  // between the two leaves reconciliation exactly what to apply.
  await finishRunner(run.id, { event: outcome.event, reason: outcome.reason, note: outcome.failure, artifacts, details: finishDetails });
  faultPoint("run:outcome_recorded");
  try {
    await transitionExecutionAttempt({
      attempt_id: run.attempt_id,
      event: outcome.event,
      expected_revision: run.revision,
      idempotency_key: `${run.id}:finish`,
      actor_kind: "control_plane",
      actor_id: `adapter:${run.adapter.id}`,
      reason: outcome.reason,
      note: outcome.failure,
      artifacts,
      details: {
        run_id: run.id,
        exit_code: outcome.exit_code,
        signal: outcome.signal,
        duration_ms: outcome.duration_ms,
        timeout: outcome.timeout,
        termination: outcome.termination,
        stdout_bytes: outcome.stdout_bytes,
        stderr_bytes: outcome.stderr_bytes,
        stdout_truncated: outcome.stdout_truncated,
        stderr_truncated: outcome.stderr_truncated,
        events: outcome.events,
        thread_id: outcome.thread_id,
        failure: outcome.failure,
      },
    });
  } catch (error) {
    outcome.transition_error = errorMessage(error);
  }
  await notifyOpenUis(`execution-run:${run.attempt_id}`);
  return outcome;
}

function runnerHeartbeatMs() {
  const configured = Number(process.env.CLAW_TASK_HUB_RUNNER_HEARTBEAT_MS ?? 10_000);
  return Number.isFinite(configured) ? Math.min(60_000, Math.max(50, configured)) : 10_000;
}

async function registerRunner(runId: string, attemptId: string, adapterId: string, harnessPid: number | null) {
  const at = nowIso();
  await database.run(`
    INSERT INTO execution_runners (run_id, attempt_id, adapter, supervisor_pid, supervisor_host, harness_pid, started_at, heartbeat_at, finished_at, outcome)
    VALUES (@run_id, @attempt_id, @adapter, @supervisor_pid, @supervisor_host, @harness_pid, @at, @at, NULL, NULL)
  `, { run_id: runId, attempt_id: attemptId, adapter: adapterId, supervisor_pid: process.pid, supervisor_host: hostname(), harness_pid: harnessPid, at });
}

async function finishRunner(runId: string, outcome: Record<string, unknown>) {
  await database.run(
    "UPDATE execution_runners SET finished_at = @at, heartbeat_at = @at, outcome = @outcome WHERE run_id = @run_id",
    { run_id: runId, at: nowIso(), outcome: JSON.stringify(outcome) },
  );
}

function attachCapture(
  child: ChildProcess,
  capture: { stdout: BoundedCapture; stderr: BoundedCapture },
  reader: AdapterEventReader,
  activity: { last: number },
) {
  let pending = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    activity.last = Date.now();
    capture.stdout.push(chunk);
    pending += chunk.toString("utf8");
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      reader.line(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    // An unterminated line longer than the capture bound cannot be an event.
    if (pending.length > capture.stdout.limit) pending = "";
  });
  child.stdout?.on("end", () => {
    if (pending) reader.line(pending);
    pending = "";
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    activity.last = Date.now();
    capture.stderr.push(chunk);
  });
  // A harness that exits without reading its instructions closes stdin under us.
  child.stdin?.on("error", () => undefined);
}

function writeArtifacts(run: SupervisedRun) {
  const artifacts: { kind: string; ref: string }[] = [];
  const write = (kind: string, name: string, text: string) => {
    const path = join(run.log_directory, `${run.id}-${name}`);
    writeFileSync(path, scrub(text, run.secrets), "utf8");
    artifacts.push({ kind, ref: path });
  };
  write("harness_stdout", "stdout.log", run.capture.stdout.text());
  write("harness_stderr", "stderr.log", run.capture.stderr.text());
  if (existsSync(run.final_message_path)) {
    const message = readFileSync(run.final_message_path);
    const bounded = message.length > run.bounds.captured_stream_bytes
      ? `${message.subarray(0, run.bounds.captured_stream_bytes).toString("utf8")}\n[claw-task-hub: ${message.length - run.bounds.captured_stream_bytes} bytes omitted]\n`
      : message.toString("utf8");
    // The harness wrote this file itself; it is rewritten scrubbed and bounded.
    writeFileSync(run.final_message_path, scrub(bounded, run.secrets), "utf8");
    artifacts.push({ kind: "harness_final_message", ref: run.final_message_path });
  }
  return artifacts;
}

// Keeps the first and last half of the bound and records how much was dropped
// between them, so neither the start of a run nor its final errors are lost.
export class BoundedCapture {
  readonly limit: number;
  total = 0;
  truncated = false;
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private tail = Buffer.alloc(0);

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer) {
    this.total += chunk.length;
    const headLimit = Math.floor(this.limit / 2);
    let rest = chunk;
    if (this.headBytes < headLimit) {
      const taken = rest.subarray(0, headLimit - this.headBytes);
      this.head.push(taken);
      this.headBytes += taken.length;
      rest = rest.subarray(taken.length);
    }
    if (!rest.length) return;
    const tailLimit = this.limit - headLimit;
    this.tail = Buffer.concat([this.tail, rest]);
    if (this.tail.length > tailLimit) {
      this.tail = this.tail.subarray(this.tail.length - tailLimit);
      this.truncated = true;
    }
  }

  text() {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = this.tail.toString("utf8");
    if (!this.truncated) return `${head}${tail}`;
    return `${head}\n[claw-task-hub: ${this.total - this.headBytes - this.tail.length} bytes omitted]\n${tail}`;
  }
}

export function scrub(text: string, secrets: { name: string; value: string }[]) {
  let result = text;
  for (const secret of secrets) result = result.split(secret.value).join(`[redacted:${secret.name}]`);
  return result;
}

async function probeVersion(adapter: ExecutionAdapter, command: string, prefixArgs: string[]) {
  try {
    const { stdout } = await execFileAsync(command, [...prefixArgs, ...adapter.versionArgs], {
      timeout: 15_000,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    return stdout.trim().split(/\r?\n/)[0]?.slice(0, 200) || null;
  } catch (error) {
    throw new ExecutionRunError("adapter_unavailable", `${adapter.id} did not report its version: ${errorMessage(error).slice(0, 500)}`, { adapter: adapter.id });
  }
}

function spawned(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

function insideWorkspaceRoot(path: string) {
  try {
    const root = realpathSync.native(executionWorkspaceRoot());
    const offset = relative(root.toLowerCase(), realpathSync.native(path).toLowerCase());
    return offset !== "" && !offset.startsWith("..") && !isAbsolute(offset);
  } catch {
    return false;
  }
}

function requestedCapabilities(value: unknown, model: string | null): ExecutionAdapterCapability[] {
  const requested = new Set<ExecutionAdapterCapability>(["stdin_prompt"]);
  if (model) requested.add("model_selection");
  if (value !== undefined && value !== null) {
    if (!Array.isArray(value)) throw invalid("requires must be an array of capability names", { field: "requires" });
    for (const entry of value) {
      if (typeof entry !== "string" || !(executionAdapterCapabilities as readonly string[]).includes(entry)) {
        throw invalid(`Unknown capability: ${String(entry)}`, { field: "requires", known: executionAdapterCapabilities });
      }
      requested.add(entry as ExecutionAdapterCapability);
    }
  }
  return [...requested];
}

function runBounds(input: LaunchExecutionAttemptInput): RunBounds {
  // Callers may tighten the contract's defaults, never loosen them.
  return {
    wall_clock_ms: boundedInteger(input.wall_clock_ms, "wall_clock_ms", 100, executionBounds.harness_wall_clock.value),
    idle_output_ms: boundedInteger(input.idle_output_ms, "idle_output_ms", 100, executionBounds.harness_idle_output.value),
    cancellation_grace_ms: boundedInteger(input.cancellation_grace_ms, "cancellation_grace_ms", 0, executionBounds.cancellation_grace.value),
    captured_stream_bytes: boundedInteger(input.captured_stream_bytes, "captured_stream_bytes", 1024, executionBounds.captured_stream.value),
  };
}

function boundedInteger(value: unknown, field: string, min: number, max: number) {
  if (value === undefined || value === null || value === "") return max;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) throw invalid(`${field} must be an integer from ${min} to ${max}`, { field });
  return numeric;
}

function promptInput(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw invalid("prompt must be a non-empty string", { field: "prompt" });
  if (value.length > maxPromptCharacters) throw invalid(`prompt must be at most ${maxPromptCharacters} characters`, { field: "prompt" });
  return value;
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
  return new ExecutionRunError("invalid_input", message, details);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
