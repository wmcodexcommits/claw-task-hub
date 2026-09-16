// Touched-file conflicts between concurrent execution attempts.
//
// Two attempts in one repository conflict when the paths they touch overlap. The
// paths come from two places that are never confused: paths an issue declares it
// plans to touch (intent, which may not happen), and paths an attempt's latest
// diff evidence shows it did touch (observation). Exact overlap is found first --
// the same path, including the source of a rename and a deleted file -- then a
// declared directory containing the other side's paths. Files that merely share
// a directory are a separate, labelled heuristic. Attempts pinned to different
// bases are compared through Git: a touched path that changed between the two
// bases is at risk, and when the bases cannot be compared the record says the
// risk is unknown rather than absent.
//
// Every record names both attempts, the path, both bases, the detection method,
// its certainty, the severity the repository's operator policy assigns, and its
// resolution state. Records are never deleted by detection: an overlap that
// disappears is resolved, one that returns is reopened, and an operator override
// persists until the overlap escalates. Every status change is appended to the
// decision log, so the audit trail survives every override.

import { existsSync } from "node:fs";
import { customAlphabet } from "nanoid";
import { adapter, json, nowIso, parseJson } from "./db.js";
import { liveExecutionStates, liveExecutionStatesSql } from "./execution-attempts-schema.js";
import { executionActorKinds } from "./execution-contract.js";
import { runGit } from "./execution-workspaces.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export const CONFLICT_POLICY_SCHEMA_VERSION = "conflict-policy/v1";

export const conflictRuleKeys = ["exact_path_observed", "exact_path_declared", "declared_directory", "shared_directory", "base_divergence"] as const;
export type ConflictRuleKey = (typeof conflictRuleKeys)[number];
export const conflictRuleValues = ["ignore", "info", "warning", "blocking"] as const;
export type ConflictRuleValue = (typeof conflictRuleValues)[number];
export type ConflictSeverity = Exclude<ConflictRuleValue, "ignore">;
type Certainty = "observed" | "declared" | "heuristic" | "unknown";
type Method = "exact_path" | "declared_directory" | "shared_directory" | "base_divergence";

// Without a configured policy nothing blocks: blocking overlapping work is an
// explicit operator decision.
export const defaultConflictRules: Record<ConflictRuleKey, ConflictRuleValue> = {
  exact_path_observed: "warning",
  exact_path_declared: "warning",
  declared_directory: "warning",
  shared_directory: "info",
  base_divergence: "warning",
};

export const executionConflictErrorCodes = [
  "invalid_input",
  "issue_not_found",
  "attempt_not_found",
  "conflict_not_found",
  "revision_conflict",
  "invalid_decision",
] as const;
export type ExecutionConflictErrorCode = (typeof executionConflictErrorCodes)[number];

export class ExecutionConflictError extends Error {
  readonly code: ExecutionConflictErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ExecutionConflictErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "ExecutionConflictError";
    this.code = code;
    this.details = details;
  }
}

export type Touch = {
  path: string;
  source: "declared" | "observed";
  change: string;
  directory: boolean;
  role: "rename_source" | "rename_target" | "copy_target" | null;
  counterpart: string | null;
};
export type TouchSet = { declared: Touch[]; observed: Touch[]; observed_available: boolean; observed_truncated: boolean };
export type Overlap = { method: Method; path: string; certainty: Certainty; rule: ConflictRuleKey; a: Touch[]; b: Touch[]; extra?: Record<string, unknown> };

type LiveAttempt = { id: string; issue_id: string; issue_identifier: string | null; base_sha: string; state: string; worktree: string | null; touches: TouchSet };
export type RepositoryConflictContext = {
  repository: string;
  rules: Record<ConflictRuleKey, ConflictRuleValue>;
  policy_revision: number | null;
  attempts: LiveAttempt[];
};

type ConflictRow = {
  id: string;
  repository: string;
  attempt_a_id: string;
  attempt_b_id: string;
  path: string;
  method: Method;
  certainty: Certainty;
  severity: ConflictSeverity;
  base_a: string;
  base_b: string;
  detail: string;
  status: "open" | "resolved" | "overridden";
  policy_revision: number | string | null;
  resolution: string | null;
  detected_at: string;
  last_detected_at: string;
  resolved_at: string | null;
  updated_at: string;
};
type ConflictViewRow = ConflictRow & {
  a_issue_id: string;
  a_issue_identifier: string | null;
  a_state: string;
  b_issue_id: string;
  b_issue_identifier: string | null;
  b_state: string;
};

const certaintyRank: Record<Certainty, number> = { unknown: 0, heuristic: 1, declared: 2, observed: 3 };
const severityRank: Record<ConflictSeverity, number> = { info: 0, warning: 1, blocking: 2 };
const liveStates = new Set<string>(liveExecutionStates);
const maxDeclaredPaths = 500;
const maxDetailTouches = 20;

// --- paths ---------------------------------------------------------------------------

// A declared path is repository-relative with forward slashes; a trailing slash
// declares a whole directory. Wildcards are refused rather than guessed at.
export function normalizeDeclaredPath(value: unknown, field: string) {
  if (typeof value !== "string") throw invalid(`${field} must be a string`, { field });
  let path = value.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  const directory = path.endsWith("/");
  const bare = directory ? path.slice(0, -1) : path;
  if (
    !bare
    || bare.length > 1024
    || bare.startsWith("/")
    || /^[A-Za-z]:/.test(bare)
    || /[\0*?[\]]/.test(bare)
    || bare.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw invalid(`${field} must be a repository-relative path without "..", empty segments, or wildcards`, { field });
  }
  return directory ? `${bare}/` : bare;
}

export function declaredTouches(paths: string[]): Touch[] {
  return paths.map((path) => ({ path, source: "declared", change: "planned", directory: path.endsWith("/"), role: null, counterpart: null }));
}

// A rename touches its source (removed) and its target; a copy touches only its
// target, because the source is unchanged.
export function observedTouches(files: { status?: unknown; path?: unknown; previous_path?: unknown }[]): Touch[] {
  const touches: Touch[] = [];
  for (const file of files) {
    if (typeof file.path !== "string" || !file.path) continue;
    const change = typeof file.status === "string" ? file.status : "M";
    const previous = typeof file.previous_path === "string" && file.previous_path ? file.previous_path : null;
    if (change === "R" && previous) {
      touches.push({ path: file.path, source: "observed", change, directory: false, role: "rename_target", counterpart: previous });
      touches.push({ path: previous, source: "observed", change, directory: false, role: "rename_source", counterpart: file.path });
    } else {
      touches.push({ path: file.path, source: "observed", change, directory: false, role: change === "C" ? "copy_target" : null, counterpart: previous });
    }
  }
  return touches;
}

// --- overlap ---------------------------------------------------------------------------

export function findOverlaps(a: TouchSet, b: TouchSet): Overlap[] {
  const results = new Map<string, Overlap>();
  const add = (method: Method, path: string, certainty: Certainty, rule: ConflictRuleKey, left: Touch[], right: Touch[]) => {
    const key = `${method}\0${path}`;
    const existing = results.get(key);
    if (!existing) {
      results.set(key, { method, path, certainty, rule, a: [...left], b: [...right] });
      return;
    }
    if (certaintyRank[certainty] > certaintyRank[existing.certainty]) {
      existing.certainty = certainty;
      existing.rule = rule;
    }
    for (const touch of left) if (!existing.a.includes(touch)) existing.a.push(touch);
    for (const touch of right) if (!existing.b.includes(touch)) existing.b.push(touch);
  };
  const left = [...a.observed, ...a.declared];
  const right = [...b.observed, ...b.declared];

  const rightFiles = new Map<string, Touch[]>();
  for (const touch of right) if (!touch.directory) rightFiles.set(touch.path, [...(rightFiles.get(touch.path) ?? []), touch]);
  const exact = new Set<string>();
  for (const touch of left) {
    if (touch.directory) continue;
    for (const other of rightFiles.get(touch.path) ?? []) {
      const observed = touch.source === "observed" && other.source === "observed";
      add("exact_path", touch.path, observed ? "observed" : "declared", observed ? "exact_path_observed" : "exact_path_declared", [touch], [other]);
      exact.add(touch.path);
    }
  }

  const contains = (directory: Touch, other: Touch) => other.path.startsWith(directory.path) || (other.directory && directory.path.startsWith(other.path));
  const longer = (one: string, two: string) => (one.length >= two.length ? one : two);
  for (const touch of left.filter((candidate) => candidate.directory)) {
    for (const other of right) if (contains(touch, other)) add("declared_directory", longer(touch.path, other.path), "declared", "declared_directory", [touch], [other]);
  }
  for (const other of right.filter((candidate) => candidate.directory)) {
    for (const touch of left) if (!touch.directory && contains(other, touch)) add("declared_directory", touch.path, "declared", "declared_directory", [touch], [other]);
  }

  // Different files in the same directory: a heuristic, never presented as more.
  const byDirectory = (touches: Touch[]) => {
    const groups = new Map<string, Touch[]>();
    for (const touch of touches) {
      if (touch.directory || exact.has(touch.path)) continue;
      const slash = touch.path.lastIndexOf("/");
      if (slash <= 0) continue;
      const directory = touch.path.slice(0, slash + 1);
      groups.set(directory, [...(groups.get(directory) ?? []), touch]);
    }
    return groups;
  };
  const rightDirectories = byDirectory(right);
  for (const [directory, touches] of byDirectory(left)) {
    const others = rightDirectories.get(directory);
    if (others) add("shared_directory", directory, "heuristic", "shared_directory", touches, others);
  }

  return [...results.values()].sort((one, two) => compareText(one.method, two.method) || compareText(one.path, two.path));
}

// --- policies ------------------------------------------------------------------------------

export async function saveConflictPolicy(input: { repository?: unknown; rules?: unknown; actor_kind?: unknown; actor_id?: unknown; note?: unknown }) {
  const repository = repositoryInput(input.repository);
  const rules = rulesInput(input.rules);
  if (requiredText(input.actor_kind, "actor_kind", 40) !== "operator") {
    throw invalid("conflict policies are operator configuration; actor_kind must be operator", { field: "actor_kind" });
  }
  const actorId = requiredText(input.actor_id, "actor_id", 200);
  const note = optionalText(input.note, "note", 2000);
  const policy = await appendRevision("execution_conflict_policies", { repository }, (revision) => ({
    id: `conflict_policy_${nanoid()}`,
    repository,
    revision,
    schema_version: CONFLICT_POLICY_SCHEMA_VERSION,
    rules: json(rules),
    created_by_kind: "operator",
    created_by_id: actorId,
    note,
    created_at: nowIso(),
  }));
  return { policy: hydratePolicy(policy) };
}

export async function getConflictPolicy(input: { repository?: unknown; revision?: unknown }) {
  const repository = repositoryInput(input.repository);
  const revision = input.revision === undefined || input.revision === null || input.revision === "" ? null : integerInput(input.revision, "revision", 1);
  const row = revision === null
    ? await adapter.get<Record<string, unknown>>("SELECT * FROM execution_conflict_policies WHERE repository = @repository ORDER BY revision DESC LIMIT 1", { repository })
    : await adapter.get<Record<string, unknown>>("SELECT * FROM execution_conflict_policies WHERE repository = @repository AND revision = @revision", { repository, revision });
  const policy = row ? hydratePolicy(row) : null;
  return { policy, effective_rules: policy?.rules ?? { ...defaultConflictRules } };
}

function hydratePolicy(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    repository: String(row.repository),
    revision: Number(row.revision),
    schema_version: String(row.schema_version),
    rules: { ...defaultConflictRules, ...parseJson<Partial<Record<ConflictRuleKey, ConflictRuleValue>>>(row.rules as string, {}) },
    created_by: { kind: String(row.created_by_kind), id: String(row.created_by_id) },
    note: (row.note as string | null) ?? null,
    created_at: String(row.created_at),
  };
}

function rulesInput(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("rules must be an object mapping rule names to severities", { field: "rules" });
  const rules = { ...defaultConflictRules };
  for (const [key, rule] of Object.entries(value)) {
    if (!(conflictRuleKeys as readonly string[]).includes(key)) throw invalid(`rules.${key} is not a conflict rule; rules are ${conflictRuleKeys.join(", ")}`, { field: `rules.${key}` });
    if (!(conflictRuleValues as readonly string[]).includes(String(rule))) throw invalid(`rules.${key} must be one of ${conflictRuleValues.join(", ")}`, { field: `rules.${key}` });
    if (key === "shared_directory" && rule === "blocking") throw invalid("rules.shared_directory is a heuristic and cannot block", { field: "rules.shared_directory" });
    rules[key as ConflictRuleKey] = rule as ConflictRuleValue;
  }
  return rules;
}

// --- declarations --------------------------------------------------------------------------

export async function declareExecutionPaths(input: { issue_id?: unknown; repository?: unknown; paths?: unknown; actor_kind?: unknown; actor_id?: unknown; note?: unknown }) {
  const issue = await requireIssue(input.issue_id);
  const repository = repositoryInput(input.repository);
  if (!Array.isArray(input.paths) || input.paths.length > maxDeclaredPaths) {
    throw invalid(`paths must be an array of at most ${maxDeclaredPaths} repository-relative paths; an empty array clears the declaration`, { field: "paths" });
  }
  const paths = [...new Set(input.paths.map((path, index) => normalizeDeclaredPath(path, `paths[${index}]`)))].sort(compareText);
  const actor = requiredActor(input);
  const note = optionalText(input.note, "note", 2000);
  const row = await appendRevision("execution_path_declarations", { issue_id: issue.id, repository }, (revision) => ({
    id: `path_declaration_${nanoid()}`,
    issue_id: issue.id,
    repository,
    revision,
    paths: json(paths),
    declared_by_kind: actor.kind,
    declared_by_id: actor.id,
    note,
    created_at: nowIso(),
  }));
  return { declaration: hydrateDeclaration(row, issue.identifier), detection: await detectExecutionConflicts({ repository }) };
}

export async function getExecutionPathDeclaration(input: { issue_id?: unknown; repository?: unknown }) {
  const issue = await requireIssue(input.issue_id);
  const repository = repositoryInput(input.repository);
  const row = await adapter.get<Record<string, unknown>>(
    "SELECT * FROM execution_path_declarations WHERE issue_id = @issue_id AND repository = @repository ORDER BY revision DESC LIMIT 1",
    { issue_id: issue.id, repository },
  );
  return { declaration: row ? hydrateDeclaration(row, issue.identifier) : null };
}

function hydrateDeclaration(row: Record<string, unknown>, identifier: string | null) {
  return {
    id: String(row.id),
    issue_id: String(row.issue_id),
    issue_identifier: identifier,
    repository: String(row.repository),
    revision: Number(row.revision),
    paths: parseJson<string[]>(row.paths as string, []),
    declared_by: { kind: String(row.declared_by_kind), id: String(row.declared_by_id) },
    note: (row.note as string | null) ?? null,
    created_at: String(row.created_at),
  };
}

// The latest declaration of every issue in a repository.
async function latestDeclarations(repository: string) {
  const rows = await adapter.all<{ issue_id: string; paths: string }>(`
    SELECT d.issue_id, d.paths
    FROM execution_path_declarations d
    WHERE d.repository = @repository
      AND d.revision = (SELECT MAX(x.revision) FROM execution_path_declarations x WHERE x.issue_id = d.issue_id AND x.repository = d.repository)
  `, { repository });
  return new Map(rows.map((row) => [row.issue_id, parseJson<string[]>(row.paths, [])]));
}

// --- context ---------------------------------------------------------------------------------

// Everything detection needs about one repository, read with SQL only, so it can
// run inside a caller's snapshot transaction.
export async function loadRepositoryConflictContext(repository: string): Promise<RepositoryConflictContext & { declarations: Map<string, string[]> }> {
  const { policy, effective_rules } = await getConflictPolicy({ repository });
  const declarations = await latestDeclarations(repository);
  const attempts = await adapter.all<{ id: string; issue_id: string; issue_identifier: string | null; base_sha: string; state: string }>(`
    SELECT a.id, a.issue_id, i.identifier AS issue_identifier, a.base_sha, a.state
    FROM execution_attempts a
    JOIN issues i ON i.id = a.issue_id
    WHERE a.repository = @repository AND a.state IN (${liveExecutionStatesSql})
  `, { repository });
  if (!attempts.length) return { repository, rules: effective_rules, policy_revision: policy?.revision ?? null, attempts: [], declarations };

  const diffs = await adapter.all<{ attempt_id: string; payload: string }>(`
    SELECT e.attempt_id, e.payload
    FROM execution_evidence e
    JOIN execution_attempts a ON a.id = e.attempt_id
    WHERE a.repository = @repository AND a.state IN (${liveExecutionStatesSql}) AND e.kind = 'diff'
      AND e.sequence = (SELECT MAX(x.sequence) FROM execution_evidence x WHERE x.attempt_id = e.attempt_id AND x.kind = 'diff')
  `, { repository });
  const diffByAttempt = new Map(diffs.map((row) => [row.attempt_id, parseJson<{ files?: unknown[]; files_truncated?: boolean }>(row.payload, {})]));
  const leases = await adapter.all<{ attempt_id: string; worktree_path: string }>(`
    SELECT l.attempt_id, l.worktree_path
    FROM execution_workspace_leases l
    JOIN execution_attempts a ON a.id = l.attempt_id
    WHERE a.repository = @repository AND a.state IN (${liveExecutionStatesSql}) AND l.status <> 'released'
  `, { repository });
  const worktrees = new Map<string, string>();
  for (const lease of leases) if (!worktrees.has(lease.attempt_id) && existsSync(lease.worktree_path)) worktrees.set(lease.attempt_id, lease.worktree_path);

  return {
    repository,
    rules: effective_rules,
    policy_revision: policy?.revision ?? null,
    declarations,
    attempts: attempts
      .map((attempt) => {
        const diff = diffByAttempt.get(attempt.id);
        return {
          ...attempt,
          worktree: worktrees.get(attempt.id) ?? null,
          touches: {
            declared: declaredTouches(declarations.get(attempt.issue_id) ?? []),
            observed: diff ? observedTouches((diff.files ?? []) as { status?: unknown; path?: unknown; previous_path?: unknown }[]) : [],
            observed_available: Boolean(diff),
            observed_truncated: Boolean(diff?.files_truncated),
          },
        };
      })
      .sort((one, two) => compareText(one.id, two.id)),
  };
}

// --- detection -------------------------------------------------------------------------------

export async function detectExecutionConflicts(input: { repository?: unknown; attempt_id?: unknown }) {
  let repository = optionalText(input.repository, "repository", 2000);
  const attemptId = optionalText(input.attempt_id, "attempt_id", 200);
  if (attemptId) {
    const attempt = await adapter.get<{ repository: string }>("SELECT repository FROM execution_attempts WHERE id = @id", { id: attemptId });
    if (!attempt) throw new ExecutionConflictError("attempt_not_found", `Execution attempt not found: ${attemptId}`, { attempt_id: attemptId });
    repository = attempt.repository;
  }
  if (!repository) throw invalid("repository or attempt_id is required", { field: "repository" });
  for (let tries = 1; ; tries += 1) {
    try {
      return await detectOnce(repository);
    } catch (error) {
      // Two detections of one repository on Postgres can insert the same record
      // or decision at once; the loser runs again and finds the winner's rows.
      if (tries < 3 && (isUniqueViolation(error, "attempt_a_id") || isUniqueViolation(error, "sequence"))) continue;
      throw error;
    }
  }
}

async function detectOnce(repository: string) {
  const context = await loadRepositoryConflictContext(repository);
  const found: { a: LiveAttempt; b: LiveAttempt; overlap: Overlap; severity: ConflictSeverity }[] = [];
  for (let left = 0; left < context.attempts.length; left += 1) {
    for (let right = left + 1; right < context.attempts.length; right += 1) {
      const a = context.attempts[left];
      const b = context.attempts[right];
      const overlaps = findOverlaps(a.touches, b.touches);
      if (a.base_sha !== b.base_sha) overlaps.push(...await baseDivergence(a, b));
      for (const overlap of overlaps) {
        const rule = context.rules[overlap.rule];
        if (rule !== "ignore") found.push({ a, b, overlap, severity: rule });
      }
    }
  }

  const changes = { created: 0, changed: 0, reopened: 0, resolved: 0 };
  const actor = { kind: "control_plane", id: "conflict-detector" };
  await adapter.transaction(async () => {
    const at = nowIso();
    const existing = await adapter.all<ConflictRow>("SELECT * FROM execution_conflicts WHERE repository = @repository", { repository });
    const keyOf = (a: string, b: string, method: string, path: string) => `${a}\0${b}\0${method}\0${path}`;
    const byKey = new Map(existing.map((row) => [keyOf(row.attempt_a_id, row.attempt_b_id, row.method, row.path), row]));
    const seen = new Set<string>();

    for (const { a, b, overlap, severity } of found) {
      const key = keyOf(a.id, b.id, overlap.method, overlap.path);
      seen.add(key);
      const detail = json(detailOf(a, b, overlap));
      const row = byKey.get(key);
      if (!row) {
        const id = `conflict_${nanoid()}`;
        await adapter.run(`
          INSERT INTO execution_conflicts (
            id, repository, attempt_a_id, attempt_b_id, path, method, certainty, severity, base_a, base_b, detail,
            status, policy_revision, resolution, detected_at, last_detected_at, resolved_at, updated_at
          ) VALUES (
            @id, @repository, @attempt_a_id, @attempt_b_id, @path, @method, @certainty, @severity, @base_a, @base_b, @detail,
            'open', @policy_revision, NULL, @at, @at, NULL, @at
          )
        `, {
          id, repository, attempt_a_id: a.id, attempt_b_id: b.id, path: overlap.path, method: overlap.method, certainty: overlap.certainty,
          severity, base_a: a.base_sha, base_b: b.base_sha, detail, policy_revision: context.policy_revision, at,
        });
        await appendDecision(id, "detected", null, "open", actor, overlap.rule, null, { severity, certainty: overlap.certainty }, at);
        changes.created += 1;
        continue;
      }
      const escalated = severityRank[severity] > severityRank[row.severity] || certaintyRank[overlap.certainty] > certaintyRank[row.certainty];
      const status = row.status === "resolved" || (row.status === "overridden" && escalated) ? "open" : row.status;
      await adapter.run(`
        UPDATE execution_conflicts
        SET certainty = @certainty, severity = @severity, base_a = @base_a, base_b = @base_b, detail = @detail, status = @status,
          policy_revision = @policy_revision, resolution = @resolution, last_detected_at = @at, resolved_at = @resolved_at, updated_at = @at
        WHERE id = @id
      `, {
        id: row.id, certainty: overlap.certainty, severity, base_a: a.base_sha, base_b: b.base_sha, detail, status,
        policy_revision: context.policy_revision, resolution: status === "open" ? null : row.resolution, resolved_at: status === "open" ? null : row.resolved_at, at,
      });
      const shift = { severity: [row.severity, severity], certainty: [row.certainty, overlap.certainty] };
      if (status !== row.status) {
        await appendDecision(row.id, "reopened", row.status, status, actor, row.status === "resolved" ? "detected_again" : "escalated", null, shift, at);
        changes.reopened += 1;
      } else if (row.severity !== severity || row.certainty !== overlap.certainty) {
        await appendDecision(row.id, "changed", row.status, row.status, actor, "reclassified", null, shift, at);
        changes.changed += 1;
      }
    }

    const live = new Set(context.attempts.map((attempt) => attempt.id));
    for (const row of existing) {
      if (row.status === "resolved" || seen.has(keyOf(row.attempt_a_id, row.attempt_b_id, row.method, row.path))) continue;
      const resolution = live.has(row.attempt_a_id) && live.has(row.attempt_b_id) ? "no_longer_detected" : "attempt_not_live";
      await adapter.run(
        "UPDATE execution_conflicts SET status = 'resolved', resolution = @resolution, resolved_at = @at, updated_at = @at WHERE id = @id",
        { id: row.id, resolution, at },
      );
      await appendDecision(row.id, "resolved", row.status, "resolved", actor, resolution, null, {}, at);
      changes.resolved += 1;
    }
  });

  return {
    repository,
    policy_revision: context.policy_revision,
    rules: context.rules,
    attempts: context.attempts.map((attempt) => ({
      id: attempt.id,
      issue_id: attempt.issue_id,
      state: attempt.state,
      base_sha: attempt.base_sha,
      observed_available: attempt.touches.observed_available,
      observed_truncated: attempt.touches.observed_truncated,
      declared_paths: attempt.touches.declared.length,
    })),
    changes,
    conflicts: await listExecutionConflicts({ repository }),
  };
}

function detailOf(a: LiveAttempt, b: LiveAttempt, overlap: Overlap) {
  const view = (touch: Touch) => ({ path: touch.path, source: touch.source, change: touch.change, role: touch.role, counterpart: touch.counterpart });
  return {
    rule: overlap.rule,
    a: overlap.a.slice(0, maxDetailTouches).map(view),
    b: overlap.b.slice(0, maxDetailTouches).map(view),
    a_touches: overlap.a.length,
    b_touches: overlap.b.length,
    // Without a diff, or with a truncated one, an attempt's observed paths are
    // incomplete; say so instead of implying the record is exhaustive.
    observed_available: { a: a.touches.observed_available, b: b.touches.observed_available },
    observed_truncated: { a: a.touches.observed_truncated, b: b.touches.observed_truncated },
    ...(overlap.extra ?? {}),
  };
}

// Paths changed between two different bases, compared in either attempt's
// worktree. Each touched path among them is a base_divergence overlap; when the
// comparison is impossible, one record with unknown certainty says so.
async function baseDivergence(a: LiveAttempt, b: LiveAttempt): Promise<Overlap[]> {
  const unknown = (reason: string): Overlap[] => [{ method: "base_divergence", path: "", certainty: "unknown", rule: "base_divergence", a: [], b: [], extra: { reason } }];
  const worktree = a.worktree ?? b.worktree;
  if (!worktree) return unknown("neither attempt has a worktree in place to compare its base commits in");
  const diff = await runGit(worktree, ["diff", "--name-status", "-z", "-M", "--no-ext-diff", a.base_sha, b.base_sha], { trim: false });
  if (!diff.ok) return unknown(`the base commits could not be compared: ${diff.stderr.slice(0, 500)}`);
  const changed = new Map<string, string>();
  const tokens = diff.stdout.split("\0");
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index];
    if (!status) {
      index += 1;
      continue;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      changed.set(tokens[index + 1] ?? "", status.charAt(0));
      changed.set(tokens[index + 2] ?? "", status.charAt(0));
      index += 3;
    } else {
      changed.set(tokens[index + 1] ?? "", status.charAt(0));
      index += 2;
    }
  }
  changed.delete("");
  if (!changed.size) return [];

  const forward = await runGit(worktree, ["merge-base", "--is-ancestor", a.base_sha, b.base_sha]);
  const backward = forward.ok ? null : await runGit(worktree, ["merge-base", "--is-ancestor", b.base_sha, a.base_sha]);
  const ancestry = forward.ok ? "a_before_b" : backward?.ok ? "b_before_a" : forward.exitCode === 1 && backward?.exitCode === 1 ? "diverged" : "unknown";

  const overlaps = new Map<string, Overlap>();
  const consider = (touch: Touch, side: "a" | "b") => {
    const paths = touch.directory ? [...changed.keys()].filter((path) => path.startsWith(touch.path)) : changed.has(touch.path) ? [touch.path] : [];
    for (const path of paths) {
      const overlap: Overlap = overlaps.get(path) ?? { method: "base_divergence", path, certainty: "declared", rule: "base_divergence", a: [], b: [], extra: { between_bases: changed.get(path), ancestry } };
      overlap[side].push(touch);
      if (touch.source === "observed") overlap.certainty = "observed";
      overlaps.set(path, overlap);
    }
  };
  for (const touch of [...a.touches.observed, ...a.touches.declared]) consider(touch, "a");
  for (const touch of [...b.touches.observed, ...b.touches.declared]) consider(touch, "b");
  return [...overlaps.values()];
}

async function appendDecision(
  conflictId: string,
  decision: string,
  fromStatus: string | null,
  toStatus: string,
  actor: { kind: string; id: string },
  reason: string | null,
  note: string | null,
  details: Record<string, unknown>,
  at: string,
) {
  const last = await adapter.get<{ sequence: number | string | null }>("SELECT MAX(sequence) AS sequence FROM execution_conflict_decisions WHERE conflict_id = @conflict_id", { conflict_id: conflictId });
  await adapter.run(`
    INSERT INTO execution_conflict_decisions (id, conflict_id, sequence, decision, from_status, to_status, actor_kind, actor_id, reason, note, details, created_at)
    VALUES (@id, @conflict_id, @sequence, @decision, @from_status, @to_status, @actor_kind, @actor_id, @reason, @note, @details, @created_at)
  `, {
    id: `conflict_decision_${nanoid()}`,
    conflict_id: conflictId,
    sequence: Number(last?.sequence ?? 0) + 1,
    decision,
    from_status: fromStatus,
    to_status: toStatus,
    actor_kind: actor.kind,
    actor_id: actor.id,
    reason,
    note,
    details: json(details),
    created_at: at,
  });
}

// --- operator decisions --------------------------------------------------------------------------

export async function decideExecutionConflict(input: { conflict_id?: unknown; decision?: unknown; actor_kind?: unknown; actor_id?: unknown; reason?: unknown; note?: unknown }) {
  const conflictId = requiredText(input.conflict_id, "conflict_id", 200);
  const decision = requiredText(input.decision, "decision", 20);
  if (decision !== "override" && decision !== "reopen") throw invalid("decision must be override or reopen", { field: "decision" });
  if (requiredText(input.actor_kind, "actor_kind", 40) !== "operator") throw invalid("only an operator decides a conflict; actor_kind must be operator", { field: "actor_kind" });
  const actor = { kind: "operator", id: requiredText(input.actor_id, "actor_id", 200) };
  const reason = requiredText(input.reason, "reason", 500);
  const note = optionalText(input.note, "note", 2000);
  const [from, to] = decision === "override" ? ["open", "overridden"] as const : ["overridden", "open"] as const;

  await adapter.transaction(async () => {
    const row = await adapter.get<ConflictRow>("SELECT * FROM execution_conflicts WHERE id = @id", { id: conflictId });
    if (!row) throw new ExecutionConflictError("conflict_not_found", `Execution conflict not found: ${conflictId}`, { conflict_id: conflictId });
    if (row.status !== from) {
      throw new ExecutionConflictError("invalid_decision", `Conflict ${conflictId} is ${row.status}; ${decision} applies only to an ${from} conflict`, { conflict_id: conflictId, status: row.status });
    }
    const at = nowIso();
    const updated = await adapter.run("UPDATE execution_conflicts SET status = @to, updated_at = @at WHERE id = @id AND status = @from", { id: conflictId, from, to, at });
    if (updated.changes !== 1) throw new ExecutionConflictError("invalid_decision", `Conflict ${conflictId} changed while the decision was being recorded; re-read it`, { conflict_id: conflictId });
    await appendDecision(conflictId, decision, from, to, actor, reason, note, { severity: row.severity, certainty: row.certainty }, at);
  });
  return { conflict: await getExecutionConflict(conflictId) };
}

// --- reads -------------------------------------------------------------------------------------------

const conflictSelect = `
  SELECT c.*,
    aa.issue_id AS a_issue_id, ia.identifier AS a_issue_identifier, aa.state AS a_state,
    ab.issue_id AS b_issue_id, ib.identifier AS b_issue_identifier, ab.state AS b_state
  FROM execution_conflicts c
  JOIN execution_attempts aa ON aa.id = c.attempt_a_id
  JOIN issues ia ON ia.id = aa.issue_id
  JOIN execution_attempts ab ON ab.id = c.attempt_b_id
  JOIN issues ib ON ib.id = ab.issue_id
`;

export async function listExecutionConflicts(input: { repository?: unknown; attempt_id?: unknown; issue_id?: unknown; status?: unknown; include_resolved?: unknown; limit?: unknown } = {}) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  const repository = optionalText(input.repository, "repository", 2000);
  if (repository) {
    where.push("c.repository = @repository");
    params.repository = repository;
  }
  const attemptId = optionalText(input.attempt_id, "attempt_id", 200);
  if (attemptId) {
    where.push("(c.attempt_a_id = @attempt_id OR c.attempt_b_id = @attempt_id)");
    params.attempt_id = attemptId;
  }
  const issueReference = optionalText(input.issue_id, "issue_id", 200);
  if (issueReference) {
    const issue = await requireIssue(issueReference);
    where.push("(aa.issue_id = @issue_id OR ab.issue_id = @issue_id)");
    params.issue_id = issue.id;
  }
  const statuses = statusInput(input.status);
  if (statuses) {
    where.push(`c.status IN (${statuses.map((_, index) => `@status_${index}`).join(", ")})`);
    statuses.forEach((status, index) => { params[`status_${index}`] = status; });
  } else if (!flagInput(input.include_resolved, false)) {
    where.push("c.status <> 'resolved'");
  }
  const limit = input.limit === undefined || input.limit === null || input.limit === "" ? 200 : integerInput(input.limit, "limit", 1, 1000);
  const rows = await adapter.all<ConflictViewRow>(`${conflictSelect} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`, params);
  return rows
    .map(hydrateConflict)
    .sort((one, two) => Number(two.blocking) - Number(one.blocking)
      || severityRank[two.severity] - severityRank[one.severity]
      || compareText(one.detected_at, two.detected_at)
      || compareText(one.id, two.id))
    .slice(0, limit);
}

export async function getExecutionConflict(id: string) {
  const row = await adapter.get<ConflictViewRow>(`${conflictSelect} WHERE c.id = @id`, { id });
  if (!row) return null;
  const decisions = await adapter.all<Record<string, unknown>>("SELECT * FROM execution_conflict_decisions WHERE conflict_id = @id ORDER BY sequence", { id });
  return {
    ...hydrateConflict(row),
    decisions: decisions.map((decision) => ({
      sequence: Number(decision.sequence),
      decision: String(decision.decision),
      from_status: (decision.from_status as string | null) ?? null,
      to_status: String(decision.to_status),
      actor: { kind: String(decision.actor_kind), id: String(decision.actor_id) },
      reason: (decision.reason as string | null) ?? null,
      note: (decision.note as string | null) ?? null,
      details: parseJson<Record<string, unknown>>(decision.details as string, {}),
      created_at: String(decision.created_at),
    })),
  };
}

// Open blocking conflicts between this attempt and another live attempt: what
// stops a launch until an operator overrides them or the overlap goes away.
export async function blockingConflictsForAttempt(attemptId: string) {
  return (await listExecutionConflicts({ attempt_id: attemptId })).filter((conflict) => conflict.blocking);
}

function hydrateConflict(row: ConflictViewRow) {
  const live = liveStates.has(row.a_state) && liveStates.has(row.b_state);
  return {
    id: row.id,
    repository: row.repository,
    path: row.path,
    method: row.method,
    certainty: row.certainty,
    severity: row.severity,
    status: row.status,
    resolution: row.resolution,
    blocking: row.status === "open" && row.severity === "blocking" && live,
    live,
    attempts: [
      { id: row.attempt_a_id, issue_id: row.a_issue_id, issue_identifier: row.a_issue_identifier, state: row.a_state, base_sha: row.base_a },
      { id: row.attempt_b_id, issue_id: row.b_issue_id, issue_identifier: row.b_issue_identifier, state: row.b_state, base_sha: row.base_b },
    ],
    bases: { a: row.base_a, b: row.base_b, differ: row.base_a !== row.base_b },
    detail: parseJson<Record<string, unknown>>(row.detail, {}),
    policy_revision: row.policy_revision === null ? null : Number(row.policy_revision),
    detected_at: row.detected_at,
    last_detected_at: row.last_detected_at,
    resolved_at: row.resolved_at,
    updated_at: row.updated_at,
  };
}

// --- helpers -------------------------------------------------------------------------------------------

async function appendRevision(table: "execution_conflict_policies" | "execution_path_declarations", scope: Record<string, string>, build: (revision: number) => Record<string, unknown>) {
  const scopeSql = Object.keys(scope).map((column) => `${column} = @${column}`).join(" AND ");
  try {
    return await adapter.transaction(async () => {
      const last = await adapter.get<{ revision: number | string | null }>(`SELECT MAX(revision) AS revision FROM ${table} WHERE ${scopeSql}`, scope);
      const row = build(Number(last?.revision ?? 0) + 1);
      const columns = Object.keys(row);
      await adapter.run(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((column) => `@${column}`).join(", ")})`, row);
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error, "revision")) throw new ExecutionConflictError("revision_conflict", "Another revision was saved at the same time; retry", scope);
    throw error;
  }
}

async function requireIssue(value: unknown) {
  const reference = requiredText(value, "issue_id", 200);
  const issue = await adapter.get<{ id: string; identifier: string | null }>(
    "SELECT id, identifier FROM issues WHERE id = @reference OR external_id = @reference OR identifier = @reference",
    { reference },
  );
  if (!issue) throw new ExecutionConflictError("issue_not_found", `Issue not found: ${reference}`, { issue_id: reference });
  return issue;
}

function repositoryInput(value: unknown) {
  const repository = requiredText(value, "repository", 2000);
  if (/\/\/[^/@\s]+@/.test(repository)) throw invalid("repository must not contain credentials", { field: "repository" });
  return repository;
}

function requiredActor(input: { actor_kind?: unknown; actor_id?: unknown }) {
  const kind = requiredText(input.actor_kind, "actor_kind", 40);
  if (!(executionActorKinds as readonly string[]).includes(kind)) throw invalid(`actor_kind must be one of ${executionActorKinds.join(", ")}`, { field: "actor_kind" });
  return { kind, id: requiredText(input.actor_id, "actor_id", 200) };
}

function statusInput(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const values = Array.isArray(value) ? value : String(value).split(",");
  const statuses = values.map((status) => String(status).trim()).filter(Boolean);
  for (const status of statuses) if (!["open", "resolved", "overridden"].includes(status)) throw invalid("status must be open, resolved, or overridden", { field: "status" });
  return statuses.length ? statuses : null;
}

function integerInput(value: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) throw invalid(`${field} must be an integer from ${min} to ${max}`, { field });
  return numeric;
}

function flagInput(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["true", "1", "yes"].includes(value.trim().toLowerCase())) return true;
    if (["false", "0", "no"].includes(value.trim().toLowerCase())) return false;
  }
  return fallback;
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${field} must be a non-empty string`, { field });
  if (value.trim().length > maxLength) throw invalid(`${field} must be at most ${maxLength} characters`, { field });
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, field, maxLength);
}

function invalid(message: string, details: Record<string, unknown> = {}) {
  return new ExecutionConflictError("invalid_input", message, details);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isUniqueViolation(error: unknown, marker: string) {
  const record = (error ?? {}) as { code?: unknown; constraint_name?: unknown; message?: unknown };
  const message = String(record.message ?? "");
  if (record.code === "23505") return `${String(record.constraint_name ?? "")} ${message}`.includes(marker);
  return message.includes("UNIQUE constraint failed") && message.includes(marker);
}
