// Runnability: whether an issue can be started now and, when it cannot, every
// reason why.
//
// This module is the single owner of that answer, for schedulers and for the
// claim protocol alike. It reads an issue's status, its project, its explicit
// dependency DAG, the paths it declares against live attempts of other issues,
// its active claims, and its live execution attempts together, so
// list_runnable_issues and claim_issue cannot disagree about what is blocked.
//
// An open dependency blocks even when its blocker is finished. Resolving the
// relation is an explicit act -- the same rule behind the effective "blocked"
// status in issue lists -- and the blocker's own status is reported, so a
// scheduler can see a relation that is only waiting to be resolved. Declared
// path overlaps block only when the repository's conflict policy says so; any
// other severity is reported as a warning.
//
// Order is decided in code rather than SQL: SQLite and Postgres collate text
// differently, and the order has to be the same on both.

import { adapter, nowIso, parseJson } from "./db.js";
import { liveExecutionStatesSql } from "./execution-attempts-schema.js";
import { declaredTouches, findOverlaps, loadRepositoryConflictContext, type RepositoryConflictContext, type TouchSet } from "./execution-conflicts.js";

export const runnabilityReasonCodes = [
  "issue_archived",
  "issue_closed",
  "status_blocked",
  "status_paused",
  "project_archived",
  "project_closed",
  "blocked_by_dependencies",
  "path_conflict",
  "claimed",
  "live_attempt",
] as const;
export type RunnabilityReasonCode = (typeof runnabilityReasonCodes)[number];
export type RunnabilityReason = { code: RunnabilityReasonCode } & Record<string, unknown>;

// The reasons that make an issue blocked, as opposed to owned, paused, or
// closed. claim_issue refuses exactly these unless it is forced.
export const blockingReasonCodes: readonly RunnabilityReasonCode[] = ["status_blocked", "blocked_by_dependencies", "path_conflict"];

// An overlap between the paths an issue declares and the paths a live attempt of
// another issue declares or has touched. Blocking overlaps exclude the issue;
// the rest are reported as warnings on it.
export type PathFinding = {
  repository: string;
  attempt_id: string;
  attempt_issue_id: string;
  attempt_issue_identifier: string | null;
  path: string;
  method: string;
  certainty: string;
  severity: string;
};

export const issueRunnabilityErrorCodes = ["invalid_input", "issue_not_found", "project_not_found", "team_not_found"] as const;
export type IssueRunnabilityErrorCode = (typeof issueRunnabilityErrorCodes)[number];

export class IssueRunnabilityError extends Error {
  readonly code: IssueRunnabilityErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: IssueRunnabilityErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "IssueRunnabilityError";
    this.code = code;
    this.details = details;
  }
}

// Status words take precedence over the stored status_type, so an issue whose
// status reads "Done" is completed whatever type an import left behind. Every
// store query that classifies issues by status builds on this expression.
export function issueStatusTypeSql(prefix = "") {
  const status = `lower(COALESCE(${prefix}status, ''))`;
  return `
  CASE
    WHEN ${status} IN ('done', 'completed') THEN 'completed'
    WHEN ${status} IN ('in progress', 'started') THEN 'started'
    WHEN ${status} IN ('todo', 'to do') THEN 'unstarted'
    WHEN ${status} IN ('blocked', 'blocker') THEN 'blocked'
    WHEN ${status} IN ('paused', 'pause') THEN 'paused'
    WHEN ${status} IN ('canceled', 'cancelled') THEN 'canceled'
    ELSE ${prefix}status_type
  END
`;
}

export type ListRunnableIssuesInput = {
  project?: unknown;
  project_id?: unknown;
  team?: unknown;
  team_id?: unknown;
  issue_id?: unknown;
  session_id?: unknown;
  include_excluded?: unknown;
  limit?: unknown;
  offset?: unknown;
  excluded_limit?: unknown;
  excluded_offset?: unknown;
};

type Scope = { where: string; params: Record<string, unknown> };

type CandidateRow = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  status_type: string | null;
  priority: number | string | null;
  project_id: string | null;
  project_name: string | null;
  project_status: string | null;
  project_archived_at: string | null;
  team_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type BlockerRow = {
  dependency_id: string;
  issue_id: string;
  blocker_issue_id: string;
  reason: string | null;
  blocker_identifier: string | null;
  blocker_title: string;
  blocker_status: string;
  blocker_status_type: string | null;
  blocker_created_at: string;
};

type DependentRow = { issue_id: string; dependents: number | string };
type ClaimRow = { claim_id: string; issue_id: string; session_id: string; agent_name: string; harness: string | null; expires_at: string };
type AttemptRow = { attempt_id: string; issue_id: string; state: string; session_id: string; harness: string };
type PathFindings = { blocking: PathFinding[]; warnings: PathFinding[] };

type IssueSummary = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  status_type: string | null;
  priority: number;
  project_id: string | null;
  project_name: string | null;
  team_id: string | null;
  created_at: string;
  updated_at: string;
  open_blocker_count: number;
  unblocks_count: number;
};

type ClaimView = { claim_id: string; session_id: string; agent_name: string; harness: string | null; expires_at: string };
type Evaluation = { issue: IssueSummary; reasons: RunnabilityReason[]; own_claims: ClaimView[]; path_warnings: PathFinding[] };

const defaultPageSize = 50;
const maxPageSize = 250;
const maxOffset = 100_000;

// Lists the issues in scope that can be started now, and every other open issue
// in scope with all of the reasons it cannot. Both lists share one deterministic
// order and page independently.
export async function listRunnableIssues(input: ListRunnableIssuesInput = {}) {
  const limit = pageNumber(input.limit, "limit", defaultPageSize, 1, maxPageSize);
  const offset = pageNumber(input.offset, "offset", 0, 0, maxOffset);
  const excludedLimit = pageNumber(input.excluded_limit, "excluded_limit", defaultPageSize, 1, maxPageSize);
  const excludedOffset = pageNumber(input.excluded_offset, "excluded_offset", 0, 0, maxOffset);
  const includeExcluded = flag(input.include_excluded, "include_excluded", true);
  const sessionId = optionalText(input.session_id, "session_id");
  const at = nowIso();

  // Every read comes from one snapshot, so an issue cannot look unblocked by one
  // query and unclaimed by another taken after a concurrent write. SQLite's
  // transaction already holds the database still; Postgres needs REPEATABLE READ
  // for its statements to share a snapshot.
  const evaluations = await adapter.transaction(async () => {
    if (adapter.kind === "postgres") await adapter.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return await evaluate(await resolveScope(input), at, sessionId);
  });
  const runnable = evaluations.filter((evaluation) => evaluation.reasons.length === 0);
  const excluded = evaluations.filter((evaluation) => evaluation.reasons.length > 0);
  return {
    evaluated_at: at,
    session_id: sessionId,
    runnable: runnable
      .slice(offset, offset + limit)
      .map((evaluation) => ({ issue: evaluation.issue, own_claims: evaluation.own_claims, path_warnings: evaluation.path_warnings })),
    runnable_total: runnable.length,
    next_offset: offset + limit < runnable.length ? offset + limit : null,
    excluded: includeExcluded
      ? excluded
        .slice(excludedOffset, excludedOffset + excludedLimit)
        .map((evaluation) => ({ issue: evaluation.issue, reasons: evaluation.reasons, path_warnings: evaluation.path_warnings }))
      : [],
    excluded_total: excluded.length,
    next_excluded_offset: includeExcluded && excludedOffset + excludedLimit < excluded.length ? excludedOffset + excludedLimit : null,
  };
}

// Evaluates one issue by its internal id, inside whatever transaction the caller
// holds. A closed or archived issue is evaluated too, with reasons that say so.
export async function evaluateIssueRunnability(issueId: string, options: { session_id?: string | null; at?: string } = {}) {
  const [evaluation] = await evaluate({ where: "i.id = @scope_issue_id", params: { scope_issue_id: issueId } }, options.at ?? nowIso(), options.session_id ?? null);
  return evaluation ? { ...evaluation, runnable: evaluation.reasons.length === 0 } : null;
}

async function resolveScope(input: ListRunnableIssuesInput): Promise<Scope> {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  const issueReference = optionalText(input.issue_id, "issue_id");
  if (issueReference) {
    const issue = await adapter.get<{ id: string }>(
      "SELECT id FROM issues WHERE id = @reference OR external_id = @reference OR identifier = @reference",
      { reference: issueReference },
    );
    if (!issue) throw new IssueRunnabilityError("issue_not_found", `Issue not found: ${issueReference}`, { issue_id: issueReference });
    clauses.push("i.id = @scope_issue_id");
    params.scope_issue_id = issue.id;
  } else {
    // Closed and archived issues are never candidates; naming one with issue_id
    // is how a caller learns why.
    clauses.push("i.archived_at IS NULL", `(${issueStatusTypeSql("i.")}) NOT IN ('completed', 'canceled', 'cancelled')`);
  }

  const projectReference = optionalText(input.project_id, "project_id") ?? optionalText(input.project, "project");
  if (projectReference) {
    const projects = await adapter.all<{ id: string }>(
      "SELECT id FROM projects WHERE id = @reference OR external_id = @reference OR name = @reference",
      { reference: projectReference },
    );
    if (!projects.length) throw new IssueRunnabilityError("project_not_found", `Project not found: ${projectReference}`, { project: projectReference });
    clauses.push(inList("i.project_id", "scope_project", projects.map((project) => project.id), params));
  }

  const teamReference = optionalText(input.team_id, "team_id") ?? optionalText(input.team, "team");
  if (teamReference) {
    const teams = await adapter.all<{ id: string }>(
      "SELECT id FROM teams WHERE id = @reference OR external_id = @reference OR name = @reference",
      { reference: teamReference },
    );
    if (!teams.length) throw new IssueRunnabilityError("team_not_found", `Team not found: ${teamReference}`, { team: teamReference });
    clauses.push(inList("i.team_id", "scope_team", teams.map((team) => team.id), params));
  }

  return { where: clauses.length ? clauses.join(" AND ") : "1 = 1", params };
}

async function evaluate(scope: Scope, at: string, sessionId: string | null): Promise<Evaluation[]> {
  const params = { ...scope.params, at };
  const candidates = await adapter.all<CandidateRow>(`
    SELECT i.id, i.identifier, i.title, i.status, (${issueStatusTypeSql("i.")}) AS status_type, i.priority,
      i.project_id, p.name AS project_name, p.status AS project_status, p.archived_at AS project_archived_at,
      i.team_id, i.archived_at, i.created_at, i.updated_at
    FROM issues i
    LEFT JOIN projects p ON p.id = i.project_id
    WHERE ${scope.where}
  `, params);
  if (!candidates.length) return [];

  const blockers = groupByIssue(await adapter.all<BlockerRow>(`
    SELECT d.id AS dependency_id, d.issue_id, d.blocker_issue_id, d.reason,
      b.identifier AS blocker_identifier, b.title AS blocker_title, b.status AS blocker_status,
      (${issueStatusTypeSql("b.")}) AS blocker_status_type, b.created_at AS blocker_created_at
    FROM issue_dependencies d
    JOIN issues i ON i.id = d.issue_id
    JOIN issues b ON b.id = d.blocker_issue_id
    WHERE d.status = 'open' AND ${scope.where}
  `, params));
  const dependents = new Map((await adapter.all<DependentRow>(`
    SELECT d.blocker_issue_id AS issue_id, COUNT(*) AS dependents
    FROM issue_dependencies d
    JOIN issues i ON i.id = d.blocker_issue_id
    WHERE d.status = 'open' AND ${scope.where}
    GROUP BY d.blocker_issue_id
  `, params)).map((row) => [row.issue_id, Number(row.dependents)]));
  // A claim protects an issue only while it is unexpired and its session is
  // still active; anything else is stale and leaves the issue free.
  const claims = groupByIssue(await adapter.all<ClaimRow>(`
    SELECT c.id AS claim_id, c.issue_id, c.session_id, c.agent_name, s.harness, c.expires_at
    FROM issue_claims c
    JOIN agent_sessions s ON s.id = c.session_id
    JOIN issues i ON i.id = c.issue_id
    WHERE c.released_at IS NULL AND c.status = 'active' AND c.expires_at > @at
      AND s.status = 'active' AND s.expires_at > @at
      AND ${scope.where}
  `, params));
  const attempts = groupByIssue(await adapter.all<AttemptRow>(`
    SELECT a.id AS attempt_id, a.issue_id, a.state, a.session_id, a.harness
    FROM execution_attempts a
    JOIN issues i ON i.id = a.issue_id
    WHERE a.state IN (${liveExecutionStatesSql}) AND ${scope.where}
  `, params));
  const paths = await pathFindings(new Set(candidates.map((row) => row.id)));

  return candidates
    .map((row) => evaluateCandidate(row, {
      blockers: blockers.get(row.id) ?? [],
      dependents: dependents.get(row.id) ?? 0,
      claims: claims.get(row.id) ?? [],
      attempts: attempts.get(row.id) ?? [],
      paths: paths.get(row.id) ?? { blocking: [], warnings: [] },
    }, sessionId))
    .sort((left, right) => compareIssues(left.issue, right.issue));
}

// The latest declared paths of the candidates, compared with the live attempts
// of other issues in the same repositories under each repository's conflict
// policy. Only SQL runs here, inside the caller's snapshot; base comparisons
// through Git belong to conflict detection, not to scheduling reads.
async function pathFindings(issueIds: Set<string>) {
  const findings = new Map<string, PathFindings>();
  const declarations = (await adapter.all<{ issue_id: string; repository: string; paths: string }>(`
    SELECT d.issue_id, d.repository, d.paths
    FROM execution_path_declarations d
    WHERE d.revision = (SELECT MAX(x.revision) FROM execution_path_declarations x WHERE x.issue_id = d.issue_id AND x.repository = d.repository)
  `)).filter((row) => issueIds.has(row.issue_id));
  const contexts = new Map<string, RepositoryConflictContext>();
  for (const declaration of declarations) {
    const paths = parseJson<string[]>(declaration.paths, []);
    if (!paths.length) continue;
    let context = contexts.get(declaration.repository);
    if (!context) {
      context = await loadRepositoryConflictContext(declaration.repository);
      contexts.set(declaration.repository, context);
    }
    const declared: TouchSet = { declared: declaredTouches(paths), observed: [], observed_available: false, observed_truncated: false };
    const bucket = findings.get(declaration.issue_id) ?? { blocking: [], warnings: [] };
    for (const attempt of context.attempts) {
      if (attempt.issue_id === declaration.issue_id) continue;
      for (const overlap of findOverlaps(declared, attempt.touches)) {
        const severity = context.rules[overlap.rule];
        if (severity === "ignore") continue;
        (severity === "blocking" ? bucket.blocking : bucket.warnings).push({
          repository: declaration.repository,
          attempt_id: attempt.id,
          attempt_issue_id: attempt.issue_id,
          attempt_issue_identifier: attempt.issue_identifier,
          path: overlap.path,
          method: overlap.method,
          certainty: overlap.certainty,
          severity,
        });
      }
    }
    findings.set(declaration.issue_id, bucket);
  }
  const order = (left: PathFinding, right: PathFinding) => compareText(left.repository, right.repository)
    || compareText(left.attempt_id, right.attempt_id)
    || compareText(left.method, right.method)
    || compareText(left.path, right.path);
  for (const bucket of findings.values()) {
    bucket.blocking.sort(order);
    bucket.warnings.sort(order);
  }
  return findings;
}

function evaluateCandidate(
  row: CandidateRow,
  facts: { blockers: BlockerRow[]; dependents: number; claims: ClaimRow[]; attempts: AttemptRow[]; paths: PathFindings },
  sessionId: string | null,
): Evaluation {
  const statusType = row.status_type === "cancelled" ? "canceled" : row.status_type;
  const closed = statusType === "completed" || statusType === "canceled";
  const reasons: RunnabilityReason[] = [];

  if (row.archived_at) reasons.push({ code: "issue_archived", archived_at: row.archived_at });
  if (closed) reasons.push({ code: "issue_closed", status: row.status, status_type: statusType });
  else if (statusType === "blocked") reasons.push({ code: "status_blocked", status: row.status });
  else if (statusType === "paused") reasons.push({ code: "status_paused", status: row.status });

  if (row.project_archived_at) reasons.push({ code: "project_archived", project_id: row.project_id, archived_at: row.project_archived_at });
  else if (projectIsClosed(row.project_status)) reasons.push({ code: "project_closed", project_id: row.project_id, project_status: row.project_status });

  const blockers = [...facts.blockers]
    .sort((left, right) => compareText(left.blocker_created_at, right.blocker_created_at) || compareText(left.blocker_issue_id, right.blocker_issue_id))
    .map((blocker) => ({
      dependency_id: blocker.dependency_id,
      issue_id: blocker.blocker_issue_id,
      identifier: blocker.blocker_identifier,
      title: blocker.blocker_title,
      status: blocker.blocker_status,
      status_type: blocker.blocker_status_type === "cancelled" ? "canceled" : blocker.blocker_status_type,
      reason: blocker.reason,
    }));
  if (blockers.length) reasons.push({ code: "blocked_by_dependencies", blockers });
  if (facts.paths.blocking.length) reasons.push({ code: "path_conflict", conflicts: facts.paths.blocking });

  const claims = [...facts.claims]
    .sort((left, right) => compareText(left.claim_id, right.claim_id))
    .map((claim) => ({ claim_id: claim.claim_id, session_id: claim.session_id, agent_name: claim.agent_name, harness: claim.harness, expires_at: claim.expires_at }));
  const others = claims.filter((claim) => claim.session_id !== sessionId);
  if (others.length) reasons.push({ code: "claimed", claims: others });

  if (facts.attempts.length) {
    reasons.push({
      code: "live_attempt",
      attempts: [...facts.attempts]
        .sort((left, right) => compareText(left.attempt_id, right.attempt_id))
        .map((attempt) => ({ attempt_id: attempt.attempt_id, state: attempt.state, session_id: attempt.session_id, harness: attempt.harness })),
    });
  }

  return {
    issue: {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      // The same effective status issue lists show: an open dependency makes an
      // open issue blocked.
      status_type: !closed && blockers.length ? "blocked" : statusType,
      priority: Number(row.priority ?? 0),
      project_id: row.project_id,
      project_name: row.project_name,
      team_id: row.team_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      open_blocker_count: blockers.length,
      unblocks_count: facts.dependents,
    },
    reasons,
    own_claims: sessionId ? claims.filter((claim) => claim.session_id === sessionId) : [],
    path_warnings: facts.paths.warnings,
  };
}

// Priority first (urgent through low, then no priority), then the issue that
// unblocks the most open dependents, then the oldest, then identifier and id by
// code point, which breaks every remaining tie.
function compareIssues(left: IssueSummary, right: IssueSummary) {
  return priorityRank(left.priority) - priorityRank(right.priority)
    || right.unblocks_count - left.unblocks_count
    || compareText(left.created_at, right.created_at)
    || compareText(left.identifier ?? "", right.identifier ?? "")
    || compareText(left.id, right.id);
}

function priorityRank(priority: number) {
  return Number.isInteger(priority) && priority >= 1 && priority <= 4 ? priority : 5;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function projectIsClosed(status: string | null) {
  return ["done", "completed", "canceled", "cancelled"].includes(status?.trim().toLowerCase() ?? "");
}

function groupByIssue<T extends { issue_id: string }>(rows: T[]) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.issue_id);
    if (group) group.push(row);
    else groups.set(row.issue_id, [row]);
  }
  return groups;
}

function inList(column: string, prefix: string, values: string[], params: Record<string, unknown>) {
  const names = values.map((value, index) => {
    params[`${prefix}_${index}`] = value;
    return `@${prefix}_${index}`;
  });
  return `${column} IN (${names.join(", ")})`;
}

function pageNumber(value: unknown, field: string, fallback: number, min: number, max: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) {
    throw new IssueRunnabilityError("invalid_input", `${field} must be an integer from ${min} to ${max}`, { field });
  }
  return numeric;
}

function flag(value: unknown, field: string, fallback: boolean) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  throw new IssueRunnabilityError("invalid_input", `${field} must be true or false`, { field });
}

function optionalText(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 500) {
    throw new IssueRunnabilityError("invalid_input", `${field} must be a string of at most 500 characters`, { field });
  }
  return value.trim() || null;
}
