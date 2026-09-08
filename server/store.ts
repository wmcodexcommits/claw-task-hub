import { customAlphabet } from "nanoid";
import { db, json, nowIso, parseJson } from "./db.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);
const localIssuePrefix = "CTH";
let issueIdentifiersChecked = false;
const normalizedStatusTypeSql = `
  CASE
    WHEN lower(COALESCE(status, '')) IN ('done', 'completed') THEN 'completed'
    WHEN lower(COALESCE(status, '')) IN ('in progress', 'started') THEN 'started'
    WHEN lower(COALESCE(status, '')) IN ('todo', 'to do') THEN 'unstarted'
    WHEN lower(COALESCE(status, '')) IN ('blocked', 'blocker') THEN 'blocked'
    WHEN lower(COALESCE(status, '')) IN ('paused', 'pause') THEN 'paused'
    WHEN lower(COALESCE(status, '')) IN ('canceled', 'cancelled') THEN 'canceled'
    ELSE status_type
  END
`;
const normalizedIssueStatusTypeSql = `
  CASE
    WHEN lower(COALESCE(i.status, '')) IN ('done', 'completed') THEN 'completed'
    WHEN lower(COALESCE(i.status, '')) IN ('in progress', 'started') THEN 'started'
    WHEN lower(COALESCE(i.status, '')) IN ('todo', 'to do') THEN 'unstarted'
    WHEN lower(COALESCE(i.status, '')) IN ('blocked', 'blocker') THEN 'blocked'
    WHEN lower(COALESCE(i.status, '')) IN ('paused', 'pause') THEN 'paused'
    WHEN lower(COALESCE(i.status, '')) IN ('canceled', 'cancelled') THEN 'canceled'
    ELSE i.status_type
  END
`;
const effectiveIssueStatusTypeSql = `
  CASE
    WHEN (${normalizedIssueStatusTypeSql}) IN ('completed', 'canceled') THEN (${normalizedIssueStatusTypeSql})
    WHEN EXISTS (
      SELECT 1 FROM issue_dependencies dependency
      WHERE dependency.issue_id = i.id AND dependency.status = 'open'
    ) THEN 'blocked'
    ELSE (${normalizedIssueStatusTypeSql})
  END
`;
const acceptanceCommentSql = (column: string) => `
  (
    lower(trim(${column})) LIKE 'acceptance%'
    OR lower(trim(${column})) LIKE 'accepted%'
    OR lower(trim(${column})) LIKE 'plan/fact acceptance%'
    OR lower(trim(${column})) LIKE 'repeat % acceptance%'
    OR lower(trim(${column})) LIKE 'reviewer-opponent acceptance%'
    OR lower(trim(${column})) LIKE 'closure note:%acceptance was already reached%'
  )
`;

export type IssueInput = {
  id?: string;
  external_id?: string;
  identifier?: string;
  issue_id?: string | null;
  title?: string;
  description?: string;
  status?: string;
  status_type?: string;
  priority?: number;
  project_id?: string | null;
  allow_no_project?: boolean | string | number | null;
  team_id?: string | null;
  parent_id?: string | null;
  assignee?: string | null;
  labels?: string[] | string;
  source?: string;
  url?: string | null;
  archived_at?: string | null;
  completed_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type ProjectInput = {
  id?: string;
  external_id?: string;
  name?: string;
  summary?: string | null;
  description?: string | null;
  status?: string;
  priority?: number;
  lead?: string | null;
  target_date?: string | null;
  source?: string;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

// A field save_issue does not understand must not look like a write that worked.
//
// save_issue was called with {id: "...", state: "Done"} and returned the full issue
// object with no error. The column is `status`; `state` is not a field, so the row was
// never touched — and the response still carried "status": "Todo", which reads as success
// to anyone checking that the call did not throw. A caller believed it had closed a ticket
// that was still open.
const ISSUE_INPUT_FIELDS = [
  "id", "external_id", "identifier", "issue_id", "title", "description", "status",
  "status_type", "priority", "project_id", "allow_no_project", "team_id", "parent_id",
  "assignee", "labels", "source", "url", "archived_at", "completed_at", "created_at",
  "updated_at",
] as const satisfies readonly (keyof IssueInput)[];

// Adding a field to IssueInput without listing it above is a BUILD error, not a field
// that silently stops being accepted. The list cannot drift from the type.
type UnlistedIssueField = Exclude<keyof IssueInput, (typeof ISSUE_INPUT_FIELDS)[number]>;
const _issueFieldsAreExhaustive: UnlistedIssueField extends never ? true : never = true;
void _issueFieldsAreExhaustive;

// get_issue returns these; they are computed at read time and cannot be written. Rejecting
// them by NAME beats a generic "unknown field", because the caller is round-tripping a read
// and needs to be told the field is derived rather than misspelled.
const ISSUE_DERIVED_FIELDS = new Set([
  "project_name", "team_name", "comments", "dependencies", "blocking", "blocker_count",
  "blocking_count", "active_claims", "active_claim_count", "active_claim_agent",
  "active_claim_harness", "last_acceptance_comment",
]);

function nearestIssueField(name: string) {
  const lower = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of ISSUE_INPUT_FIELDS) {
    const distance = editDistance(lower, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Only suggest a genuinely close name. "state" -> "status" is worth saying; a suggestion
  // for an unrelated word is noise that sends the caller down the wrong path.
  return best && bestDistance <= Math.max(2, Math.floor(lower.length / 2)) ? best : undefined;
}

function editDistance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

export function assertKnownIssueFields(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const known = new Set<string>(ISSUE_INPUT_FIELDS);
  const rejected: string[] = [];
  for (const key of Object.keys(input as Record<string, unknown>)) {
    if (known.has(key)) continue;
    if (ISSUE_DERIVED_FIELDS.has(key)) {
      rejected.push(`${key} (read-only; it is computed by get_issue and cannot be written)`);
      continue;
    }
    const suggestion = nearestIssueField(key);
    rejected.push(suggestion ? `${key} (did you mean ${suggestion}?)` : key);
  }
  if (rejected.length === 0) return;
  throw new Error(
    `save_issue does not accept ${rejected.length === 1 ? "this field" : "these fields"}: ` +
      `${rejected.join(", ")}. Nothing was written. Accepted fields: ${ISSUE_INPUT_FIELDS.join(", ")}.`,
  );
}

type FilterValue = string | string[] | null | undefined;
type ListIssueFilters = {
  project?: string;
  project_id?: string;
  team?: string;
  team_id?: string;
  status?: FilterValue;
  status_type?: FilterValue;
  include_done?: boolean | string | number | null;
  blocked?: boolean | string | number | null;
  query?: string;
  limit?: number;
  offset?: number;
};
type ProjectUpdateInput = {
  id?: string;
  external_id?: string;
  project_id: string;
  body: string;
  health?: string;
  author?: string | null;
  source?: string;
  created_at?: string;
  updated_at?: string;
};
type IssueDependencyInput = {
  id?: string;
  external_id?: string;
  issue_id: string;
  blocker_issue_id: string;
  reason?: string | null;
  source?: string;
  created_at?: string;
  updated_at?: string;
};
export type IssueDisplayLimit = 50 | 100 | 200 | "all";
export type IssueGroup = {
  key: string;
  status_type: string;
  label: string;
  total: number;
  returned: number;
  truncated: boolean;
  issues: unknown[];
};
type AgentSessionInput = { id?: string; agent_name: string; harness?: string | null; ttl_minutes?: number; metadata?: unknown };
type ClaimIssueInput = {
  issue_id: string;
  session_id: string;
  note?: string | null;
  ttl_minutes?: number;
  force?: boolean | string | number | null;
  allow_closed?: boolean | string | number | null;
};
type ReleaseIssueClaimInput = {
  issue_id?: string;
  claim_id?: string;
  session_id?: string;
  status?: "released" | "completed";
  force?: boolean | string | number | null;
};
type ContextBindingInput = {
  id?: string;
  context_key: string;
  project_id: string;
  default_tab?: string | null;
  harness?: string | null;
  workspace_name?: string | null;
  cwd?: string | null;
  repo_remote?: string | null;
  branch?: string | null;
  thread_id?: string | null;
  metadata?: unknown;
  source?: string;
  created_at?: string;
  updated_at?: string;
};
type ContextBindingFilters = {
  context_key?: string | null;
  project_id?: string | null;
  harness?: string | null;
  cwd?: string | null;
  repo_remote?: string | null;
  branch?: string | null;
  thread_id?: string | null;
  limit?: number | string | null;
};
type HydratedIssueClaim = Record<string, unknown> & {
  id: string;
  issue_id: string;
  session_id: string;
  status?: string;
  expires_at?: string;
  released_at?: string | null;
};
const issueStatusGroups = [
  { status_type: "started", label: "In Progress" },
  { status_type: "blocked", label: "Blocked" },
  { status_type: "paused", label: "Paused" },
  { status_type: "backlog", label: "Backlog" },
  { status_type: "unstarted", label: "Todo" },
  { status_type: "completed", label: "Done" },
  { status_type: "canceled", label: "Canceled" },
];
const issueDisplayLimitChoices = new Set(["50", "100", "200", "all"]);
const groupedIssueAllLimit = 100000;

export function makeId(prefix: string) {
  return `${prefix}_${nanoid()}`;
}

export function ensureDefaultTeam() {
  const existing = db.prepare("SELECT * FROM teams LIMIT 1").get();
  if (existing) return existing as Record<string, unknown>;
  const at = nowIso();
  db.prepare(`
    INSERT INTO teams (id, name, key, source, created_at, updated_at)
    VALUES (@id, @name, @key, 'local', @created_at, @updated_at)
  `).run({ id: "team_local", name: "Local Agents", key: "LOC", created_at: at, updated_at: at });
  return db.prepare("SELECT * FROM teams WHERE id = 'team_local'").get() as Record<string, unknown>;
}

export function listTeams() {
  return db.prepare("SELECT * FROM teams ORDER BY name").all();
}

export function upsertTeam(input: { id?: string; external_id?: string; name: string; key?: string; source?: string; created_at?: string; updated_at?: string }) {
  const at = nowIso();
  const row = {
    id: input.id ?? input.external_id ?? makeId("team"),
    external_id: input.external_id ?? null,
    name: input.name,
    key: input.key ?? null,
    source: input.source ?? "local",
    created_at: input.created_at ?? at,
    updated_at: input.updated_at ?? at,
  };
  db.prepare(`
    INSERT INTO teams (id, external_id, name, key, source, created_at, updated_at)
    VALUES (@id, @external_id, @name, @key, @source, @created_at, @updated_at)
    ON CONFLICT(external_id) DO UPDATE SET
      name=excluded.name, key=excluded.key, updated_at=excluded.updated_at
  `).run(row);
  if (row.external_id) return db.prepare("SELECT * FROM teams WHERE external_id = @external_id").get(row);
  return db.prepare("SELECT * FROM teams WHERE id = @id").get(row);
}

export function listProjects() {
  ensureIssueIdentifiers();
  return db.prepare(`
    SELECT
      p.*,
      COUNT(i.id) AS issue_count,
      SUM(CASE WHEN ${effectiveIssueStatusTypeSql} = 'completed' THEN 1 ELSE 0 END) AS done_count,
      SUM(CASE WHEN ${effectiveIssueStatusTypeSql} IN ('started', 'blocked', 'paused') THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN ${effectiveIssueStatusTypeSql} = 'blocked' THEN 1 ELSE 0 END) AS blocker_count,
      (
        SELECT u.health
        FROM project_updates u
        WHERE u.project_id = p.id
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT 1
      ) AS health,
      (
        SELECT u.body
        FROM project_updates u
        WHERE u.project_id = p.id
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT 1
      ) AS latest_update_body,
      (
        SELECT u.created_at
        FROM project_updates u
        WHERE u.project_id = p.id
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT 1
      ) AS latest_update_at
    FROM projects p
    LEFT JOIN issues i ON i.project_id = p.id AND i.archived_at IS NULL
    WHERE p.archived_at IS NULL
    GROUP BY p.id
    ORDER BY COALESCE(latest_update_at, p.updated_at) DESC
  `).all();
}

export function getProject(id: string, options: { issues_per_status?: unknown } = {}) {
  ensureIssueIdentifiers();
  const project = db.prepare(`
    SELECT
      p.*,
      (
        SELECT u.health
        FROM project_updates u
        WHERE u.project_id = p.id
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT 1
      ) AS health,
      (
        SELECT u.body
        FROM project_updates u
        WHERE u.project_id = p.id
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT 1
      ) AS latest_update_body,
      (
        SELECT u.created_at
        FROM project_updates u
        WHERE u.project_id = p.id
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT 1
      ) AS latest_update_at
    FROM projects p
    WHERE p.id = @id OR p.external_id = @id
    ORDER BY CASE WHEN p.id = @id THEN 0 ELSE 1 END
    LIMIT 1
  `).get({ id }) as Record<string, unknown> | undefined;
  if (!project) return null;
  const issueDisplayLimit = parseIssueDisplayLimit(options.issues_per_status, 50);
  const issueGroups = listIssueGroups({ project: String(project.id) }, issueDisplayLimit);
  const issues = listIssues({ project: String(project.id), limit: 250 });
  const statusCounts = db.prepare(`
    SELECT i.status, ${effectiveIssueStatusTypeSql} AS status_type, COUNT(*) AS count
    FROM issues i
    WHERE i.project_id = @project_id AND i.archived_at IS NULL
    GROUP BY i.status, ${effectiveIssueStatusTypeSql}
    ORDER BY count DESC
  `).all({ project_id: project.id });
  const priorityCounts = db.prepare(`
    SELECT priority, COUNT(*) AS count
    FROM issues
    WHERE project_id = @project_id AND archived_at IS NULL
    GROUP BY priority
    ORDER BY priority
  `).all({ project_id: project.id });
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN ${effectiveIssueStatusTypeSql} = 'completed' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN ${effectiveIssueStatusTypeSql} = 'started' THEN 1 ELSE 0 END) AS started,
      SUM(CASE WHEN ${effectiveIssueStatusTypeSql} IN ('backlog','unstarted','blocked','paused') THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN ${effectiveIssueStatusTypeSql} = 'blocked' THEN 1 ELSE 0 END) AS blockers
    FROM issues i
    WHERE i.project_id = @project_id AND i.archived_at IS NULL
  `).get({ project_id: project.id });
  const issueEvents = db.prepare(`
    SELECT
      i.id,
      i.identifier,
      i.title,
      i.status,
      ${effectiveIssueStatusTypeSql} AS status_type,
      i.priority,
      i.updated_at,
      'issue' AS type,
      CASE
        WHEN ${effectiveIssueStatusTypeSql} = 'completed' THEN 'completed'
        WHEN ${effectiveIssueStatusTypeSql} = 'started' THEN 'started'
        WHEN ${effectiveIssueStatusTypeSql} = 'blocked' THEN 'blocker'
        ELSE 'updated'
      END AS verb
    FROM issues i
    WHERE i.project_id = @project_id AND i.archived_at IS NULL
    ORDER BY i.updated_at DESC
    LIMIT 40
  `).all({ project_id: project.id });
  const commentEvents = db.prepare(`
    SELECT
      c.id,
      i.identifier,
      i.title,
      i.status,
      ${normalizedStatusTypeSql} AS status_type,
      i.priority,
      c.updated_at,
      'comment' AS type,
      'commented' AS verb,
      c.author,
      c.body
    FROM comments c
    JOIN issues i ON i.id = c.issue_id
    WHERE i.project_id = @project_id AND i.archived_at IS NULL
    ORDER BY c.updated_at DESC
    LIMIT 20
  `).all({ project_id: project.id });
  const dependencyEvents = db.prepare(`
    SELECT
      d.id,
      i.identifier,
      i.title,
      i.status,
      CASE WHEN d.status = 'open' THEN 'blocked' ELSE ${effectiveIssueStatusTypeSql} END AS status_type,
      i.priority,
      d.updated_at,
      'dependency' AS type,
      CASE WHEN d.status = 'open' THEN 'blocked' ELSE 'unblocked' END AS verb,
      NULL AS author,
      d.reason AS body,
      blocker.identifier AS blocker_identifier,
      blocker.title AS blocker_title
    FROM issue_dependencies d
    JOIN issues i ON i.id = d.issue_id
    JOIN issues blocker ON blocker.id = d.blocker_issue_id
    WHERE i.project_id = @project_id AND i.archived_at IS NULL
    ORDER BY d.updated_at DESC
    LIMIT 20
  `).all({ project_id: project.id });
  const projectUpdateEvents = db.prepare(`
    SELECT
      u.id,
      NULL AS identifier,
      p.name AS title,
      p.status,
      CASE
        WHEN u.health = 'complete' THEN 'completed'
        WHEN u.health IN ('at_risk', 'off_track') THEN 'blocked'
        ELSE 'started'
      END AS status_type,
      p.priority,
      u.updated_at,
      'project_update' AS type,
      'project_updated' AS verb,
      u.author,
      u.body,
      u.health
    FROM project_updates u
    JOIN projects p ON p.id = u.project_id
    WHERE u.project_id = @project_id
    ORDER BY u.updated_at DESC
    LIMIT 20
  `).all({ project_id: project.id });
  const projectUpdates = listProjectUpdates({ project_id: String(project.id), limit: 50 });
  const activity = [...issueEvents, ...commentEvents, ...dependencyEvents, ...projectUpdateEvents]
    .sort((a, b) => String((b as { updated_at: string }).updated_at).localeCompare(String((a as { updated_at: string }).updated_at)))
    .slice(0, 50);
  return { project, counts, statusCounts, priorityCounts, issues, issueGroups, issueDisplayLimit, projectUpdates, activity };
}

export function upsertProject(input: ProjectInput) {
  const at = nowIso();
  const internalId = nonEmptyString(input.id);
  const externalId = nonEmptyString(input.external_id);
  const existing = internalId || externalId
    ? db.prepare(`
        SELECT * FROM projects
        WHERE (@id IS NOT NULL AND id = @id)
           OR (@external_id IS NOT NULL AND external_id = @external_id)
        ORDER BY CASE WHEN id = @id THEN 0 ELSE 1 END
        LIMIT 1
      `).get({ id: internalId ?? null, external_id: externalId ?? null }) as Record<string, unknown> | undefined
    : undefined;
  if (!existing && !nonEmptyString(input.name)) throw new Error("name is required when creating a project");
  const row = {
    id: stringValue(existing?.id) ?? input.id ?? input.external_id ?? makeId("project"),
    external_id: hasOwn(input, "external_id") ? input.external_id ?? null : stringValue(existing?.external_id),
    name: input.name ?? stringValue(existing?.name) ?? "Untitled project",
    summary: hasOwn(input, "summary") ? input.summary ?? null : stringValue(existing?.summary),
    description: hasOwn(input, "description") ? input.description ?? null : stringValue(existing?.description),
    status: input.status ?? stringValue(existing?.status) ?? "Backlog",
    priority: input.priority ?? numberValue(existing?.priority) ?? 3,
    lead: hasOwn(input, "lead") ? input.lead ?? null : stringValue(existing?.lead),
    target_date: hasOwn(input, "target_date") ? nonEmptyString(input.target_date) ?? null : stringValue(existing?.target_date),
    source: input.source ?? stringValue(existing?.source) ?? "local",
    archived_at: hasOwn(input, "archived_at") ? input.archived_at ?? null : stringValue(existing?.archived_at),
    created_at: input.created_at ?? stringValue(existing?.created_at) ?? at,
    updated_at: input.updated_at ?? at,
  };
  db.prepare(`
    INSERT INTO projects (id, external_id, name, summary, description, status, priority, lead, target_date, source, archived_at, created_at, updated_at)
    VALUES (@id, @external_id, @name, @summary, @description, @status, @priority, @lead, @target_date, @source, @archived_at, @created_at, @updated_at)
    ON CONFLICT(external_id) DO UPDATE SET
      name=excluded.name, summary=excluded.summary, description=excluded.description, status=excluded.status,
      priority=excluded.priority, lead=excluded.lead, target_date=excluded.target_date,
      source=excluded.source, archived_at=excluded.archived_at, updated_at=excluded.updated_at
    ON CONFLICT(id) DO UPDATE SET
      external_id=excluded.external_id, name=excluded.name, summary=excluded.summary, description=excluded.description,
      status=excluded.status, priority=excluded.priority, lead=excluded.lead, target_date=excluded.target_date,
      source=excluded.source, archived_at=excluded.archived_at,
      updated_at=excluded.updated_at
  `).run(row);
  if (row.external_id) return db.prepare("SELECT * FROM projects WHERE external_id = @external_id").get(row);
  return db.prepare("SELECT * FROM projects WHERE id = @id").get(row);
}

export function listProjectUpdates(input: { project_id: string; limit?: number | string | null }) {
  const projectId = resolveProjectId(input.project_id);
  if (!projectId) throw new Error(`Project not found: ${input.project_id}`);
  return db.prepare(`
    SELECT u.*, p.name AS project_name
    FROM project_updates u
    JOIN projects p ON p.id = u.project_id
    WHERE u.project_id = @project_id
    ORDER BY u.created_at DESC
    LIMIT @limit
  `).all({ project_id: projectId, limit: boundedNumber(input.limit, 20, 1, 100) });
}

export function saveProjectUpdate(input: ProjectUpdateInput) {
  const projectId = resolveProjectId(input.project_id);
  if (!projectId) throw new Error(`Project not found: ${input.project_id}`);
  const body = boundedRequiredString(input.body, "body", 10000);
  const health = normalizeProjectHealth(input.health);
  const at = nowIso();
  const externalId = nonEmptyString(input.external_id);
  const row = {
    id: input.id ?? externalId ?? makeId("project_update"),
    external_id: externalId,
    project_id: projectId,
    body,
    health,
    author: nonEmptyString(input.author) ?? "Agent",
    source: nonEmptyString(input.source) ?? "local",
    created_at: input.created_at ?? at,
    updated_at: input.updated_at ?? at,
  };
  db.prepare(`
    INSERT INTO project_updates (id, external_id, project_id, body, health, author, source, created_at, updated_at)
    VALUES (@id, @external_id, @project_id, @body, @health, @author, @source, @created_at, @updated_at)
    ON CONFLICT(external_id) DO UPDATE SET
      project_id=excluded.project_id, body=excluded.body, health=excluded.health,
      author=excluded.author, source=excluded.source, updated_at=excluded.updated_at
    ON CONFLICT(id) DO UPDATE SET
      external_id=excluded.external_id, project_id=excluded.project_id, body=excluded.body,
      health=excluded.health, author=excluded.author, source=excluded.source, updated_at=excluded.updated_at
  `).run(row);
  return db.prepare(`
    SELECT u.*, p.name AS project_name
    FROM project_updates u JOIN projects p ON p.id = u.project_id
    WHERE u.id = @id OR (@external_id IS NOT NULL AND u.external_id = @external_id)
    ORDER BY CASE WHEN u.id = @id THEN 0 ELSE 1 END
    LIMIT 1
  `).get({ id: row.id, external_id: externalId });
}

export function upsertContextBinding(input: ContextBindingInput) {
  const contextKey = normalizedRequiredString(input.context_key, "context_key");
  const projectId = resolveProjectId(input.project_id);
  if (!projectId) throw new Error(`Project not found: ${input.project_id}`);
  const at = nowIso();
  const row = {
    id: input.id ?? makeId("context"),
    context_key: contextKey,
    project_id: projectId,
    default_tab: normalizeDefaultTab(input.default_tab),
    harness: nonEmptyString(input.harness),
    workspace_name: nonEmptyString(input.workspace_name),
    cwd: nonEmptyString(input.cwd),
    repo_remote: normalizeRepoRemote(input.repo_remote),
    branch: nonEmptyString(input.branch),
    thread_id: nonEmptyString(input.thread_id),
    metadata: json(input.metadata ?? {}),
    source: input.source ?? "local",
    created_at: input.created_at ?? at,
    updated_at: input.updated_at ?? at,
  };
  db.prepare(`
    INSERT INTO context_bindings (id, context_key, project_id, default_tab, harness, workspace_name, cwd, repo_remote, branch, thread_id, metadata, source, created_at, updated_at)
    VALUES (@id, @context_key, @project_id, @default_tab, @harness, @workspace_name, @cwd, @repo_remote, @branch, @thread_id, @metadata, @source, @created_at, @updated_at)
    ON CONFLICT(context_key) DO UPDATE SET
      project_id=excluded.project_id,
      default_tab=excluded.default_tab,
      harness=excluded.harness,
      workspace_name=excluded.workspace_name,
      cwd=excluded.cwd,
      repo_remote=excluded.repo_remote,
      branch=excluded.branch,
      thread_id=excluded.thread_id,
      metadata=excluded.metadata,
      source=excluded.source,
      updated_at=excluded.updated_at
  `).run(row);
  return getContextBinding(contextKey);
}

export function getContextBinding(contextKey: string) {
  const row = db.prepare(`
    SELECT cb.*, p.name AS project_name
    FROM context_bindings cb
    JOIN projects p ON p.id = cb.project_id
    WHERE (cb.context_key = @id OR cb.id = @id)
      AND p.archived_at IS NULL
  `).get({ id: contextKey });
  return row ? hydrateContextBinding(row) : null;
}

export function listContextBindings(filters: ContextBindingFilters = {}) {
  const where = ["p.archived_at IS NULL"];
  const params: Record<string, unknown> = { limit: boundedNumber(filters.limit, 50, 1, 250) };
  if (filters.context_key) {
    where.push("cb.context_key = @context_key");
    params.context_key = filters.context_key;
  }
  if (filters.project_id) {
    const projectId = resolveProjectId(filters.project_id);
    if (!projectId) throw new Error(`Project not found: ${filters.project_id}`);
    where.push("cb.project_id = @project_id");
    params.project_id = projectId;
  }
  for (const key of ["harness", "cwd", "thread_id"] as const) {
    const value = nonEmptyString(filters[key]);
    if (!value) continue;
    where.push(`cb.${key} = @${key}`);
    params[key] = value;
  }
  const repoRemote = normalizeRepoRemote(filters.repo_remote);
  if (repoRemote) {
    where.push("cb.repo_remote = @repo_remote");
    params.repo_remote = repoRemote;
  }
  const branch = nonEmptyString(filters.branch);
  if (branch) {
    where.push("cb.branch = @branch");
    params.branch = branch;
  }
  return db.prepare(`
    SELECT cb.*, p.name AS project_name
    FROM context_bindings cb
    JOIN projects p ON p.id = cb.project_id
    WHERE ${where.join(" AND ")}
    ORDER BY cb.updated_at DESC
    LIMIT @limit
  `).all(params).map(hydrateContextBinding);
}

export function resolveContextProject(filters: ContextBindingFilters) {
  const binding = findContextBinding(filters);
  if (!binding) return { binding: null, project: null, url_path: null };
  const project = db.prepare("SELECT * FROM projects WHERE id = @id AND archived_at IS NULL").get({ id: binding.project_id }) ?? null;
  return { binding, project, url_path: contextBindingUrlPath(binding) };
}

export function deleteContextBinding(input: { id?: string; context_key?: string }) {
  const locator = nonEmptyString(input.id) ?? nonEmptyString(input.context_key);
  if (!locator) throw new Error("delete_context_binding requires id or context_key");
  const binding = getContextBinding(locator);
  if (!binding) return { deleted: false, binding: null };
  db.prepare("DELETE FROM context_bindings WHERE id = @id").run({ id: binding.id });
  return { deleted: true, binding };
}

function findContextBinding(filters: ContextBindingFilters) {
  const exactKey = nonEmptyString(filters.context_key);
  if (exactKey) return getContextBinding(exactKey);
  const candidates: ContextBindingFilters[] = [];
  const threadId = nonEmptyString(filters.thread_id);
  if (threadId) candidates.push({ thread_id: threadId });
  const cwd = nonEmptyString(filters.cwd);
  if (cwd) candidates.push({ cwd });
  const repoRemote = normalizeRepoRemote(filters.repo_remote);
  const branch = nonEmptyString(filters.branch);
  if (repoRemote && branch) candidates.push({ repo_remote: repoRemote, branch });
  if (repoRemote) candidates.push({ repo_remote: repoRemote });
  const harness = nonEmptyString(filters.harness);
  if (harness && cwd) candidates.push({ harness, cwd });
  if (harness && repoRemote) candidates.push({ harness, repo_remote: repoRemote });
  for (const candidate of candidates) {
    const [binding] = listContextBindings({ ...candidate, limit: 1 });
    if (binding) return binding;
  }
  return null;
}

function hydrateContextBinding(row: unknown): Record<string, unknown> & { id: string; project_id: string; metadata: unknown; url_path: string } {
  const item = row as Record<string, unknown>;
  return {
    ...item,
    id: String(item.id),
    project_id: String(item.project_id),
    metadata: parseJson(item.metadata as string | null | undefined, {}),
    url_path: contextBindingUrlPath(item),
  };
}

function contextBindingUrlPath(binding: Record<string, unknown>) {
  const projectId = encodeURIComponent(String(binding.project_id));
  const tab = normalizeDefaultTab(binding.default_tab);
  return `/projects/${projectId}/${tab}`;
}

function normalizeDefaultTab(value: unknown) {
  const tab = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["overview", "activity", "issues"].includes(tab) ? tab : "issues";
}

function normalizedRequiredString(value: unknown, field: string) {
  const normalized = nonEmptyString(value);
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > 500) throw new Error(`${field} is too long`);
  return normalized;
}

function normalizeRepoRemote(value: unknown) {
  const remote = nonEmptyString(value);
  if (!remote) return null;
  try {
    const parsed = new URL(remote);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return remote.replace(/\/\/[^/@\s]+:[^/@\s]+@/, "//");
  }
}

export function listIssues(filters: ListIssueFilters) {
  return listIssuesInternal(filters, 250);
}

export function listIssueGroups(filters: ListIssueFilters, limitInput: unknown = 50): IssueGroup[] {
  const issueDisplayLimit = parseIssueDisplayLimit(limitInput, 50);
  const effectiveLimit = issueDisplayLimit === "all" ? groupedIssueAllLimit : issueDisplayLimit;
  const includeDone = booleanValue(filters.include_done, true);
  const requestedStatusTypes = groupedRequestedStatusTypes(filters);
  return issueStatusGroups
    .filter((group) => includeDone || !["completed", "canceled"].includes(group.status_type))
    .filter((group) => !requestedStatusTypes || requestedStatusTypes.has(group.status_type))
    .map((group) => {
      const groupFilters = {
        ...filters,
        status: undefined,
        status_type: group.status_type,
        limit: effectiveLimit,
        offset: 0,
      };
      const total = countIssues(groupFilters);
      const issues = total ? listIssuesInternal(groupFilters, groupedIssueAllLimit) : [];
      return {
        key: group.status_type,
        status_type: group.status_type,
        label: group.label,
        total,
        returned: issues.length,
        truncated: total > issues.length,
        issues,
      };
    })
    .filter((group) => group.total > 0);
}

function groupedRequestedStatusTypes(filters: ListIssueFilters) {
  const values = [...filterValues(filters.status), ...filterValues(filters.status_type)];
  const normalized = unique(values.map((value) => inferStatusType(value) ?? knownStatusType(value) ?? value).filter(isString));
  return normalized.length ? new Set(normalized) : null;
}

export function parseIssueDisplayLimit(value: unknown, fallback: IssueDisplayLimit = 50): IssueDisplayLimit {
  const normalized = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().toLowerCase() : "";
  if (issueDisplayLimitChoices.has(normalized)) return normalized === "all" ? "all" : (Number(normalized) as IssueDisplayLimit);
  return fallback;
}

function listIssuesInternal(filters: ListIssueFilters, maxLimit: number) {
  ensureIssueIdentifiers();
  const limit = boundedNumber(filters.limit, 50, 1, maxLimit);
  const offset = boundedNumber(filters.offset, 0, 0, 100000);
  const { where, params, orderBy } = issueQueryParts(filters);
  params.limit = limit;
  params.offset = offset;
  let sql = `
    SELECT
      i.*,
      p.name AS project_name,
      t.name AS team_name,
      (
        SELECT COUNT(*)
        FROM issue_claims c
        JOIN agent_sessions s ON s.id = c.session_id
        WHERE c.issue_id = i.id
          AND c.released_at IS NULL
          AND c.status = 'active'
          AND c.expires_at > @active_at
          AND s.status = 'active'
          AND s.expires_at > @active_at
      ) AS active_claim_count,
      (
        SELECT c.agent_name
        FROM issue_claims c
        JOIN agent_sessions s ON s.id = c.session_id
        WHERE c.issue_id = i.id
          AND c.released_at IS NULL
          AND c.status = 'active'
          AND c.expires_at > @active_at
          AND s.status = 'active'
          AND s.expires_at > @active_at
        ORDER BY c.heartbeat_at DESC, c.claimed_at DESC
        LIMIT 1
      ) AS active_claim_agent,
      (
        SELECT s.harness
        FROM issue_claims c
        JOIN agent_sessions s ON s.id = c.session_id
        WHERE c.issue_id = i.id
          AND c.released_at IS NULL
          AND c.status = 'active'
          AND c.expires_at > @active_at
          AND s.status = 'active'
          AND s.expires_at > @active_at
        ORDER BY c.heartbeat_at DESC, c.claimed_at DESC
        LIMIT 1
      ) AS active_claim_harness,
      (
        SELECT c.created_at
        FROM comments c
        WHERE c.issue_id = i.id
          AND ${acceptanceCommentSql("c.body")}
        ORDER BY c.created_at DESC
        LIMIT 1
      ) AS last_acceptance_at,
      (
        SELECT COUNT(*) FROM issue_dependencies d
        WHERE d.issue_id = i.id AND d.status = 'open'
      ) AS blocker_count,
      (
        SELECT COUNT(*) FROM issue_dependencies d
        WHERE d.blocker_issue_id = i.id AND d.status = 'open'
      ) AS blocking_count
    FROM issues i
    LEFT JOIN projects p ON p.id = i.project_id
    LEFT JOIN teams t ON t.id = i.team_id
  `;
  sql += ` WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`;
  return db.prepare(sql).all(params).map(hydrateIssue);
}

function countIssues(filters: ListIssueFilters) {
  ensureIssueIdentifiers();
  const { where, params } = issueQueryParts(filters);
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM issues i
    LEFT JOIN projects p ON p.id = i.project_id
    LEFT JOIN teams t ON t.id = i.team_id
    WHERE ${where.join(" AND ")}
  `).get(params) as { count: number };
  return Number(row.count ?? 0);
}

function issueQueryParts(filters: ListIssueFilters) {
  const query = typeof filters.query === "string" ? filters.query.trim() : "";
  const projectFilter = filters.project ?? filters.project_id;
  const teamFilter = filters.team ?? filters.team_id;
  const where: string[] = ["i.archived_at IS NULL"];
  const params: Record<string, unknown> = { active_at: nowIso() };
  if (projectFilter) {
    where.push("(i.project_id = @project OR p.name = @project OR p.external_id = @project)");
    params.project = projectFilter;
  }
  if (teamFilter) {
    where.push("(i.team_id = @team OR t.name = @team OR t.external_id = @team)");
    params.team = teamFilter;
  }
  const statusValues = filterValues(filters.status);
  if (statusValues.length) {
    const statusTypes = unique(statusValues.map((value) => inferStatusType(value) ?? knownStatusType(value)).filter(isString));
    const rawStatuses = statusValues.filter((value) => !inferStatusType(value) && !knownStatusType(value));
    const clauses: string[] = [];
    if (statusTypes.length) clauses.push(inClause(effectiveIssueStatusTypeSql, "status_type", statusTypes, params));
    if (rawStatuses.length) clauses.push(inClause("i.status", "status", rawStatuses, params));
    where.push(`(${clauses.join(" OR ")})`);
  }
  const statusTypeValues = filterValues(filters.status_type);
  if (statusTypeValues.length) {
    const normalized = unique(statusTypeValues.map((value) => inferStatusType(value) ?? knownStatusType(value) ?? value));
    where.push(inClause(effectiveIssueStatusTypeSql, "status_type_filter", normalized, params));
  }
  if (!booleanValue(filters.include_done, true)) {
    where.push(`${effectiveIssueStatusTypeSql} NOT IN ('completed', 'canceled')`);
  }
  if (booleanValue(filters.blocked, false)) {
    where.push(`${effectiveIssueStatusTypeSql} = 'blocked'`);
  }
  let orderBy = "i.updated_at DESC";
  if (query) {
    where.push(`(
      i.rowid IN (SELECT rowid FROM issue_fts WHERE issue_fts MATCH @query)
      OR lower(coalesce(i.identifier, '')) LIKE @query_like ESCAPE '\\'
      OR lower(coalesce(i.external_id, '')) LIKE @query_like ESCAPE '\\'
      OR lower(i.id) LIKE @query_like ESCAPE '\\'
    )`);
    params.query = ftsQuery(query);
    params.query_exact = query;
    params.query_like = `%${escapeLike(query.toLowerCase())}%`;
    orderBy = `
      CASE
        WHEN lower(coalesce(i.identifier, '')) = lower(@query_exact)
          OR lower(coalesce(i.external_id, '')) = lower(@query_exact)
          OR lower(i.id) = lower(@query_exact)
        THEN 0
        WHEN lower(coalesce(i.identifier, '')) LIKE @query_like ESCAPE '\\'
          OR lower(coalesce(i.external_id, '')) LIKE @query_like ESCAPE '\\'
          OR lower(i.id) LIKE @query_like ESCAPE '\\'
        THEN 1
        ELSE 2
      END,
      i.updated_at DESC
    `;
  }
  return { where, params, orderBy };
}

function ftsQuery(value: string) {
  const tokens = value
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/"/g, '""'))
    .filter(Boolean);
  return tokens.map((token) => `"${token}"`).join(" ");
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function getIssue(id: string) {
  ensureIssueIdentifiers();
  const issue = db.prepare(`
    SELECT i.*, p.name AS project_name, t.name AS team_name,
      (SELECT COUNT(*) FROM issue_dependencies d WHERE d.issue_id=i.id AND d.status='open') AS blocker_count,
      (SELECT COUNT(*) FROM issue_dependencies d WHERE d.blocker_issue_id=i.id AND d.status='open') AS blocking_count
    FROM issues i
    LEFT JOIN projects p ON p.id = i.project_id
    LEFT JOIN teams t ON t.id = i.team_id
    WHERE i.id = @id OR i.external_id = @id OR i.identifier = @id
  `).get({ id });
  if (!issue) return null;
  const comments = db.prepare("SELECT * FROM comments WHERE issue_id = @issue_id ORDER BY created_at").all({ issue_id: (issue as { id: string }).id });
  const issueId = (issue as { id: string }).id;
  const activeClaims = activeIssueClaims(issueId);
  return {
    ...hydrateIssue(issue),
    comments,
    active_claims: activeClaims,
    active_claim_count: activeClaims.length,
    active_claim_agent: activeClaims[0]?.agent_name ?? null,
    active_claim_harness: activeClaims[0]?.harness ?? null,
    last_acceptance_comment: latestAcceptanceComment(issueId),
    dependencies: listIssueDependencies({ issue_id: issueId, include_resolved: true }),
    blocking: listBlockingIssues({ issue_id: issueId, include_resolved: true }),
  };
}

export function listTruncatedLinearIssues(limit = 500) {
  return db.prepare(
    "SELECT id, external_id, identifier, title, updated_at " +
      "FROM issues " +
      "WHERE source = 'linear' " +
      "AND description LIKE '%truncated, use `get_issue` for full description%' " +
      "ORDER BY updated_at DESC " +
      "LIMIT @limit",
  ).all({ limit: Math.min(limit, 1000) }) as {
    id: string;
    external_id: string | null;
    identifier: string | null;
    title: string;
    updated_at: string;
  }[];
}

export function upsertIssue(input: IssueInput) {
  assertKnownIssueFields(input);
  const retryAutomaticIdentifier = shouldRetryAutomaticIdentifier(input);
  const maxAttempts = retryAutomaticIdentifier ? 3 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const issueKey = upsertIssueTransaction.immediate(input);
      const issue = getIssue(issueKey);
      if (!issue) throw new Error(`Saved issue not found: ${issueKey}`);
      return issue;
    } catch (error) {
      if (attempt < maxAttempts && retryAutomaticIdentifier && isIdentifierUniqueConstraintError(error)) continue;
      throw error;
    }
  }
  throw new Error("save_issue failed after retrying automatic identifier allocation");
}

const upsertIssueTransaction = db.transaction((input: IssueInput) => upsertIssueLocked(input));

function upsertIssueLocked(input: IssueInput) {
  const at = nowIso();
  const existing = resolveIssueForUpsert(input);
  if (!existing && !input.title) {
    throw new Error("title is required when creating an issue");
  }
  const existingStatus = stringValue(existing?.status);
  const status = hasOwn(input, "status") ? input.status ?? "Backlog" : existingStatus ?? "Backlog";
  const statusType =
    inferStatusType(status) ??
    (hasOwn(input, "status") ? statusTypeFromStatusFallback(status) : undefined) ??
    (hasOwn(input, "status_type") ? input.status_type : stringValue(existing?.status_type)) ??
    "backlog";
  const completedAt = hasOwn(input, "completed_at")
    ? input.completed_at ?? null
    : statusType === "completed"
      ? stringValue(existing?.completed_at) ?? at
      : null;
  // A caller-supplied `id` that is really a visible identifier (CTH-nnn) must
  // never become a row's primary key. When a save intended as an update fell
  // through to a create, this adopted "CTH-015" as the new row's id — so a row
  // whose IDENTIFIER was CTH-730 had ROW ID "CTH-015", and every later lookup
  // for CTH-015 resolved to the wrong issue, permanently and self-reinforcingly.
  // Identifiers are allocated by resolveIssueIdentifier; they are not addresses.
  const requestedId = isShortIssueIdentifier(input.id) ? undefined : input.id;
  const row = {
    id: stringValue(existing?.id) ?? requestedId ?? input.external_id ?? makeId("issue"),
    external_id: hasOwn(input, "external_id") ? input.external_id ?? null : stringValue(existing?.external_id),
    identifier: resolveIssueIdentifier(input, existing),
    title: input.title ?? stringValue(existing?.title) ?? "Untitled issue",
    description: hasOwn(input, "description") ? input.description ?? null : stringValue(existing?.description),
    status,
    status_type: statusType,
    priority: input.priority ?? numberValue(existing?.priority) ?? 3,
    project_id: resolveIssueProjectId(input, existing),
    team_id: hasOwn(input, "team_id") ? resolveIssueTeamId(input.team_id) : stringValue(existing?.team_id) ?? defaultTeamId(),
    parent_id: hasOwn(input, "parent_id") ? resolveIssueParentId(input.parent_id) : stringValue(existing?.parent_id),
    assignee: hasOwn(input, "assignee") ? input.assignee ?? null : stringValue(existing?.assignee),
    labels: json(hasOwn(input, "labels") ? normalizeLabels(input.labels) : normalizeLabels(existing?.labels)),
    source: input.source ?? stringValue(existing?.source) ?? "local",
    url: hasOwn(input, "url") ? input.url ?? null : stringValue(existing?.url),
    archived_at: hasOwn(input, "archived_at") ? input.archived_at ?? null : stringValue(existing?.archived_at),
    completed_at: completedAt ?? (statusType === "completed" ? at : null),
    created_at: input.created_at ?? stringValue(existing?.created_at) ?? at,
    updated_at: input.updated_at ?? at,
  };
  db.prepare(`
    INSERT INTO issues (id, external_id, identifier, title, description, status, status_type, priority, project_id, team_id, parent_id, assignee, labels, source, url, archived_at, completed_at, created_at, updated_at)
    VALUES (@id, @external_id, @identifier, @title, @description, @status, @status_type, @priority, @project_id, @team_id, @parent_id, @assignee, @labels, @source, @url, @archived_at, @completed_at, @created_at, @updated_at)
    ON CONFLICT(external_id) DO UPDATE SET
      identifier=excluded.identifier, title=excluded.title, description=excluded.description, status=excluded.status,
      status_type=excluded.status_type, priority=excluded.priority, project_id=excluded.project_id, team_id=excluded.team_id,
      parent_id=excluded.parent_id, assignee=excluded.assignee, labels=excluded.labels, url=excluded.url,
      archived_at=excluded.archived_at, completed_at=excluded.completed_at, updated_at=excluded.updated_at
    ON CONFLICT(id) DO UPDATE SET
      external_id=excluded.external_id, identifier=excluded.identifier, title=excluded.title, description=excluded.description, status=excluded.status,
      status_type=excluded.status_type, priority=excluded.priority, project_id=excluded.project_id, team_id=excluded.team_id,
      parent_id=excluded.parent_id, assignee=excluded.assignee, labels=excluded.labels, url=excluded.url,
      archived_at=excluded.archived_at, completed_at=excluded.completed_at, updated_at=excluded.updated_at
  `).run(row);
  return row.id;
}

export function saveComment(input: { id?: string; external_id?: string; issue_id: string; body: string; author?: string; source?: string; created_at?: string; updated_at?: string; allow_closed?: boolean | string | number | null }) {
  const at = nowIso();
  const issueId = resolveParentId(input.issue_id);
  if (!issueId) throw new Error(`Issue not found: ${input.issue_id}`);
  const issue = getClaimableIssue(issueId);
  assertIssueOpenForAgentWrite(issue, input.allow_closed, "comment on");
  const externalId = nonEmptyString(input.external_id);
  const row = {
    id: input.id ?? makeId("comment"),
    external_id: externalId,
    issue_id: issueId,
    body: input.body,
    author: input.author ?? "Agent",
    source: input.source ?? "local",
    created_at: input.created_at ?? at,
    updated_at: input.updated_at ?? at,
  };
  db.prepare(`
    INSERT INTO comments (id, external_id, issue_id, body, author, source, created_at, updated_at)
    VALUES (@id, @external_id, @issue_id, @body, @author, @source, @created_at, @updated_at)
    ON CONFLICT(external_id) DO UPDATE SET body=excluded.body, author=excluded.author, updated_at=excluded.updated_at
  `).run(row);
  if (row.external_id) {
    return db.prepare("SELECT * FROM comments WHERE external_id = @external_id").get(row);
  }
  return db.prepare("SELECT * FROM comments WHERE id = @id").get(row);
}

export function listIssueDependencies(input: { issue_id: string; include_resolved?: boolean | string | number | null; limit?: number | string | null }) {
  const issueId = resolveParentId(input.issue_id);
  if (!issueId) throw new Error(`Issue not found: ${input.issue_id}`);
  const includeResolved = booleanValue(input.include_resolved, false);
  return db.prepare(`
    SELECT d.*, issue.identifier AS issue_identifier, issue.title AS issue_title,
      blocker.identifier AS blocker_identifier, blocker.title AS blocker_title
    FROM issue_dependencies d
    JOIN issues issue ON issue.id = d.issue_id
    JOIN issues blocker ON blocker.id = d.blocker_issue_id
    WHERE d.issue_id = @issue_id
      AND (@include_resolved = 1 OR d.status = 'open')
    ORDER BY CASE d.status WHEN 'open' THEN 0 ELSE 1 END, d.updated_at DESC
    LIMIT @limit
  `).all({ issue_id: issueId, include_resolved: includeResolved ? 1 : 0, limit: boundedNumber(input.limit, 50, 1, 250) });
}

export function listBlockingIssues(input: { issue_id: string; include_resolved?: boolean | string | number | null; limit?: number | string | null }) {
  const issueId = resolveParentId(input.issue_id);
  if (!issueId) throw new Error(`Issue not found: ${input.issue_id}`);
  const includeResolved = booleanValue(input.include_resolved, false);
  return db.prepare(`
    SELECT d.*, issue.identifier AS issue_identifier, issue.title AS issue_title,
      blocker.identifier AS blocker_identifier, blocker.title AS blocker_title
    FROM issue_dependencies d
    JOIN issues issue ON issue.id = d.issue_id
    JOIN issues blocker ON blocker.id = d.blocker_issue_id
    WHERE d.blocker_issue_id = @issue_id
      AND (@include_resolved = 1 OR d.status = 'open')
    ORDER BY CASE d.status WHEN 'open' THEN 0 ELSE 1 END, d.updated_at DESC
    LIMIT @limit
  `).all({ issue_id: issueId, include_resolved: includeResolved ? 1 : 0, limit: boundedNumber(input.limit, 50, 1, 250) });
}

export function saveIssueDependency(input: IssueDependencyInput) {
  const issueId = resolveParentId(input.issue_id);
  if (!issueId) throw new Error(`Issue not found: ${input.issue_id}`);
  const blockerIssueId = resolveParentId(input.blocker_issue_id);
  if (!blockerIssueId) throw new Error(`Issue not found: ${input.blocker_issue_id}`);
  if (issueId === blockerIssueId) throw new Error("An issue cannot block itself");
  const blocker = getClaimableIssue(blockerIssueId);
  const blockerStatus = inferStatusType(stringValue(blocker.status) ?? undefined) ?? knownStatusType(stringValue(blocker.status_type) ?? undefined);
  if (blockerStatus === "completed" || blockerStatus === "canceled") {
    throw new Error(`Completed or canceled issue ${issueLabel(blocker)} cannot be added as an open blocker`);
  }
  if (dependencyWouldCycle(issueId, blockerIssueId)) {
    throw new Error("Adding this blocker would create a dependency cycle");
  }
  const reason = optionalBoundedString(input.reason, "reason", 2000);
  const at = nowIso();
  const externalId = nonEmptyString(input.external_id);
  const row = {
    id: input.id ?? externalId ?? makeId("dependency"),
    external_id: externalId,
    issue_id: issueId,
    blocker_issue_id: blockerIssueId,
    reason,
    status: "open",
    resolved_at: null,
    source: nonEmptyString(input.source) ?? "local",
    created_at: input.created_at ?? at,
    updated_at: input.updated_at ?? at,
  };
  db.prepare(`
    INSERT INTO issue_dependencies (id, external_id, issue_id, blocker_issue_id, reason, status, resolved_at, source, created_at, updated_at)
    VALUES (@id, @external_id, @issue_id, @blocker_issue_id, @reason, @status, @resolved_at, @source, @created_at, @updated_at)
    ON CONFLICT(external_id) DO UPDATE SET
      issue_id=excluded.issue_id, blocker_issue_id=excluded.blocker_issue_id, reason=excluded.reason,
      status='open', resolved_at=NULL, source=excluded.source, updated_at=excluded.updated_at
    ON CONFLICT(issue_id, blocker_issue_id) DO UPDATE SET
      reason=excluded.reason, status='open', resolved_at=NULL, source=excluded.source, updated_at=excluded.updated_at
    ON CONFLICT(id) DO UPDATE SET
      external_id=excluded.external_id, issue_id=excluded.issue_id, blocker_issue_id=excluded.blocker_issue_id,
      reason=excluded.reason, status='open', resolved_at=NULL, source=excluded.source, updated_at=excluded.updated_at
  `).run(row);
  return getIssueDependency(row.id, issueId, blockerIssueId);
}

export function resolveIssueDependency(input: { dependency_id?: string; issue_id?: string; blocker_issue_id?: string }) {
  const dependency = resolveIssueDependencyRow(input);
  if (!dependency) throw new Error("Issue dependency not found");
  if (dependency.status === "resolved") return { resolved: false, dependency };
  const at = nowIso();
  db.prepare("UPDATE issue_dependencies SET status='resolved', resolved_at=@at, updated_at=@at WHERE id=@id").run({ id: dependency.id, at });
  return { resolved: true, dependency: getIssueDependency(String(dependency.id)) };
}

export function startAgentSession(input: AgentSessionInput) {
  if (!nonEmptyString(input.agent_name)) throw new Error("agent_name is required");
  const at = nowIso();
  const row = {
    id: input.id ?? makeId("session"),
    agent_name: input.agent_name,
    harness: nonEmptyString(input.harness),
    status: "active",
    started_at: at,
    last_heartbeat_at: at,
    expires_at: addMinutes(at, ttlMinutes(input.ttl_minutes)),
    ended_at: null,
    metadata: json(input.metadata ?? {}),
  };
  db.prepare(`
    INSERT INTO agent_sessions (id, agent_name, harness, status, started_at, last_heartbeat_at, expires_at, ended_at, metadata)
    VALUES (@id, @agent_name, @harness, @status, @started_at, @last_heartbeat_at, @expires_at, @ended_at, @metadata)
    ON CONFLICT(id) DO UPDATE SET
      agent_name=excluded.agent_name,
      harness=excluded.harness,
      status='active',
      last_heartbeat_at=excluded.last_heartbeat_at,
      expires_at=excluded.expires_at,
      ended_at=NULL,
      metadata=excluded.metadata
  `).run(row);
  return getAgentSession(row.id);
}

export function heartbeatAgentSession(input: { session_id: string; ttl_minutes?: number }) {
  const session = getAgentSession(input.session_id);
  if (!session) throw new Error(`Agent session not found: ${input.session_id}`);
  const at = nowIso();
  db.prepare(`
    UPDATE agent_sessions
    SET status='active', last_heartbeat_at=@last_heartbeat_at, expires_at=@expires_at, ended_at=NULL
    WHERE id=@id
  `).run({ id: input.session_id, last_heartbeat_at: at, expires_at: addMinutes(at, ttlMinutes(input.ttl_minutes)) });
  return getAgentSession(input.session_id);
}

export function endAgentSession(input: { session_id: string; release_claims?: boolean | string | number | null }) {
  const session = getAgentSession(input.session_id);
  if (!session) throw new Error(`Agent session not found: ${input.session_id}`);
  const at = nowIso();
  const releaseClaims = booleanValue(input.release_claims, true);
  const tx = db.transaction(() => {
    const claimedIssueIds = releaseClaims
      ? db.prepare("SELECT DISTINCT issue_id FROM issue_claims WHERE session_id=@session_id AND released_at IS NULL AND status='active'").all({ session_id: input.session_id }) as { issue_id: string }[]
      : [];
    db.prepare(`
      UPDATE agent_sessions
      SET status='ended', ended_at=@ended_at, last_heartbeat_at=@ended_at, expires_at=@ended_at
      WHERE id=@id
    `).run({ id: input.session_id, ended_at: at });
    if (releaseClaims) {
      db.prepare(`
        UPDATE issue_claims
        SET status='released', released_at=@released_at
        WHERE session_id=@session_id AND released_at IS NULL
      `).run({ session_id: input.session_id, released_at: at });
      for (const claim of claimedIssueIds) settleIssueAfterClaimRelease(claim.issue_id, false, at);
    }
  });
  tx();
  return { session: getAgentSession(input.session_id), released_claims: releaseClaims ? listIssueClaims({ session_id: input.session_id, include_released: true }) : [] };
}

export function listAgentSessions(input: { include_ended?: boolean | string | number | null; limit?: number } = {}) {
  const now = nowIso();
  const where = booleanValue(input.include_ended, false) ? "" : "WHERE status = 'active' AND expires_at > @now";
  return db.prepare(`
    SELECT *
    FROM agent_sessions
    ${where}
    ORDER BY last_heartbeat_at DESC
    LIMIT @limit
  `).all({ limit: boundedNumber(input.limit, 50, 1, 250), now }).map(hydrateAgentSession);
}

export function claimIssue(input: ClaimIssueInput) {
  const at = nowIso();
  const issueId = resolveParentId(input.issue_id);
  if (!issueId) throw new Error(`Issue not found: ${input.issue_id}`);
  const issue = getClaimableIssue(issueId);
  assertIssueOpenForAgentWrite(issue, input.allow_closed, "claim");
  if (!booleanValue(input.force, false) && issueIsBlocked(issueId, issue)) {
    throw new Error(`Issue ${issueLabel(issue)} is blocked; resolve its dependencies or explicit Blocked status before claiming it`);
  }
  const session = getActiveAgentSession(input.session_id, at);
  if (!session) throw new Error(`Active agent session not found: ${input.session_id}`);
  heartbeatAgentSession({ session_id: input.session_id, ttl_minutes: input.ttl_minutes });
  const expiredReleased = expireIssueClaims(issueId, at);
  const activeClaims = activeIssueClaims(issueId, at);
  const active = activeClaims[0];
  const expiresAt = addMinutes(at, ttlMinutes(input.ttl_minutes));
  const sameSessionActive = activeClaims.find((claim) => claim.session_id === input.session_id);
  if (sameSessionActive) {
    supersedeOtherActiveIssueClaims(issueId, sameSessionActive.id, at);
    db.prepare(`
      UPDATE issue_claims
      SET status='active', note=@note, heartbeat_at=@heartbeat_at, expires_at=@expires_at
      WHERE id=@id
    `).run({ id: sameSessionActive.id, note: input.note ?? sameSessionActive.note ?? null, heartbeat_at: at, expires_at: expiresAt });
    markIssueInProgress(issueId, at);
    return { claim: getIssueClaim(sameSessionActive.id), idempotent: true, forced: false, expired_released: expiredReleased };
  }
  let forced = false;
  if (active) {
    if (!booleanValue(input.force, false)) {
      throw new Error(`Issue already claimed by ${active.agent_name} (${active.session_id}) until ${active.expires_at}`);
    }
    forced = true;
    supersedeActiveIssueClaims(issueId, at);
  }
  const row = {
    id: makeId("claim"),
    issue_id: issueId,
    session_id: input.session_id,
    agent_name: session.agent_name,
    status: "active",
    note: input.note ?? null,
    claimed_at: at,
    heartbeat_at: at,
    expires_at: expiresAt,
    released_at: null,
    force: forced ? 1 : 0,
  };
  db.prepare(`
    INSERT INTO issue_claims (id, issue_id, session_id, agent_name, status, note, claimed_at, heartbeat_at, expires_at, released_at, force)
    VALUES (@id, @issue_id, @session_id, @agent_name, @status, @note, @claimed_at, @heartbeat_at, @expires_at, @released_at, @force)
  `).run(row);
  markIssueInProgress(issueId, at);
  return { claim: getIssueClaim(row.id), idempotent: false, forced, expired_released: expiredReleased };
}

export function releaseIssueClaim(input: ReleaseIssueClaimInput) {
  const at = nowIso();
  const claimById = input.claim_id ? getIssueClaim(input.claim_id) as HydratedIssueClaim | null : null;
  if (input.claim_id && !claimById) throw new Error(`Issue claim not found: ${input.claim_id}`);
  const issueId = claimById?.issue_id ?? resolveParentId(input.issue_id);
  if (!issueId) {
    if (input.claim_id) throw new Error(`Issue claim has no issue_id: ${input.claim_id}`);
    if (!input.issue_id) throw new Error("release_issue_claim requires either claim_id or issue_id");
    throw new Error(`Issue not found: ${input.issue_id}`);
  }
  expireIssueClaims(issueId, at);
  if (claimById) {
    const refreshedClaim = getIssueClaim(claimById.id) as HydratedIssueClaim | null;
    if (!refreshedClaim) throw new Error(`Issue claim not found: ${claimById.id}`);
    const forced = booleanValue(input.force, false);
    if (input.session_id && refreshedClaim.session_id !== input.session_id && !forced) {
      throw new Error(`Issue claim belongs to ${refreshedClaim.session_id}; release with that session_id or force=true`);
    }
    if (refreshedClaim.released_at || refreshedClaim.status !== "active" || !refreshedClaim.expires_at || refreshedClaim.expires_at <= at) {
      return { released: false, claim: refreshedClaim };
    }
    const status = input.status === "completed" ? "completed" : "released";
    db.prepare("UPDATE issue_claims SET status=@status, released_at=@released_at WHERE id=@id").run({ id: refreshedClaim.id, status, released_at: at });
    const supersededActiveDuplicates = supersedeOtherActiveIssueClaims(issueId, refreshedClaim.id, at);
    settleIssueAfterClaimRelease(issueId, status === "completed", at);
    return { released: true, claim: getIssueClaim(refreshedClaim.id), superseded_active_duplicates: supersededActiveDuplicates };
  }
  if (!input.session_id) throw new Error("release_issue_claim requires session_id when claim_id is not provided");
  const activeClaims = activeIssueClaims(issueId, at);
  if (!activeClaims.length) return { released: false, claim: null };
  const forced = booleanValue(input.force, false);
  const claim = activeClaims.find((item) => item.session_id === input.session_id) ?? (forced ? activeClaims[0] : undefined);
  if (!claim) {
    const active = activeClaims[0];
    throw new Error(`Issue claim belongs to ${active.session_id}; release with that session_id or force=true`);
  }
  const status = input.status === "completed" ? "completed" : "released";
  db.prepare("UPDATE issue_claims SET status=@status, released_at=@released_at WHERE id=@id").run({ id: claim.id, status, released_at: at });
  const supersededActiveDuplicates = supersedeOtherActiveIssueClaims(issueId, claim.id, at);
  settleIssueAfterClaimRelease(issueId, status === "completed", at);
  return { released: true, claim: getIssueClaim(claim.id), superseded_active_duplicates: supersededActiveDuplicates };
}

export function listIssueClaims(input: { issue_id?: string; session_id?: string; include_released?: boolean | string | number | null; limit?: number } = {}) {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: boundedNumber(input.limit, 50, 1, 250), now: nowIso() };
  if (input.issue_id) {
    const issueId = resolveParentId(input.issue_id);
    if (!issueId) throw new Error(`Issue not found: ${input.issue_id}`);
    where.push("c.issue_id = @issue_id");
    params.issue_id = issueId;
  }
  if (input.session_id) {
    where.push("c.session_id = @session_id");
    params.session_id = input.session_id;
  }
  if (!booleanValue(input.include_released, false)) where.push("c.released_at IS NULL AND c.status='active' AND c.expires_at > @now");
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db.prepare(`
    SELECT c.*, i.identifier, i.title, s.harness
    FROM issue_claims c
    JOIN issues i ON i.id = c.issue_id
    JOIN agent_sessions s ON s.id = c.session_id
    ${whereSql}
    ORDER BY c.claimed_at DESC
    LIMIT @limit
  `).all(params).map(hydrateIssueClaim);
}

export function dashboard() {
  ensureIssueIdentifiers();
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM projects WHERE archived_at IS NULL) AS projects,
      (SELECT COUNT(*) FROM issues WHERE archived_at IS NULL) AS issues,
      (SELECT COUNT(*) FROM issues WHERE ${normalizedStatusTypeSql} = 'completed' AND archived_at IS NULL) AS done,
      (SELECT COUNT(*) FROM issues WHERE ${normalizedStatusTypeSql} IN ('started','unstarted','blocked','paused') AND archived_at IS NULL) AS active
  `).get();
  const byStatus = db.prepare("SELECT status, COUNT(*) AS count FROM issues WHERE archived_at IS NULL GROUP BY status ORDER BY count DESC").all();
  const recent = listIssues({ limit: 12 });
  return { counts, byStatus, recent };
}

export function startSyncRun(source: string) {
  const id = makeId("sync");
  db.prepare("INSERT INTO sync_runs (id, source, status, started_at) VALUES (@id, @source, 'running', @started_at)").run({
    id,
    source,
    started_at: nowIso(),
  });
  return id;
}

export function finishSyncRun(id: string, status: "completed" | "failed", stats: unknown, cursor?: string, error?: string) {
  const run = db.prepare("SELECT source FROM sync_runs WHERE id = @id").get({ id }) as { source?: string } | undefined;
  db.prepare(`
    UPDATE sync_runs
    SET status=@status, finished_at=@finished_at, stats=@stats, cursor=@cursor, error=@error
    WHERE id=@id
  `).run({
    id,
    status,
    finished_at: nowIso(),
    stats: json(stats),
    cursor: cursor ?? null,
    error: error ?? null,
  });
  if (status === "completed" && run?.source === "linear" && cursor) {
    db.prepare(`
      INSERT INTO sync_checkpoints (source, cursor, updated_at)
      VALUES (@source, @cursor, @updated_at)
      ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at
    `).run({ source: run.source, cursor, updated_at: nowIso() });
  }
}

export function recentSyncRuns(limit = 10) {
  return db.prepare("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT @limit").all({ limit });
}

export function repairIssueInvariants() {
  const rows = db.prepare(`
    SELECT id, status, status_type, completed_at, updated_at, labels
    FROM issues
  `).all() as {
    id: string;
    status: string;
    status_type: string;
    completed_at: string | null;
    updated_at: string;
    labels: string;
  }[];
  const stats = {
    issuesChecked: rows.length,
    statusTypeFixed: 0,
    completedAtFixed: 0,
    labelsFixed: 0,
    issuesChanged: 0,
  };
  const update = db.prepare(`
    UPDATE issues
    SET status_type = @status_type,
        completed_at = @completed_at,
        labels = @labels
    WHERE id = @id
  `);
  const tx = db.transaction(() => {
    for (const row of rows) {
      const statusType = inferStatusType(row.status) ?? knownStatusType(row.status_type) ?? row.status_type;
      const completedAt = statusType === "completed" && !row.completed_at ? row.updated_at || nowIso() : row.completed_at;
      const labels = json(normalizeLabels(row.labels));
      const statusTypeChanged = statusType !== row.status_type;
      const completedAtChanged = completedAt !== row.completed_at;
      const labelsChanged = labels !== row.labels;
      if (!statusTypeChanged && !completedAtChanged && !labelsChanged) continue;
      if (statusTypeChanged) stats.statusTypeFixed += 1;
      if (completedAtChanged) stats.completedAtFixed += 1;
      if (labelsChanged) stats.labelsFixed += 1;
      stats.issuesChanged += 1;
      update.run({ id: row.id, status_type: statusType, completed_at: completedAt, labels });
    }
  });
  tx();
  return stats;
}

export function getSyncCheckpoint(source: string) {
  return db.prepare("SELECT * FROM sync_checkpoints WHERE source = @source").get({ source }) as { source: string; cursor: string | null; updated_at: string } | undefined;
}

function hydrateIssue(row: unknown) {
  const item = row as Record<string, unknown>;
  const status = typeof item.status === "string" ? item.status : undefined;
  const statusType = typeof item.status_type === "string" ? item.status_type : undefined;
  const normalized = inferStatusType(status) ?? statusType;
  const effective = !["completed", "canceled"].includes(normalized ?? "") && Number(item.blocker_count ?? 0) > 0 ? "blocked" : normalized;
  return { ...item, status_type: effective, labels: normalizeLabels(item.labels) };
}

function hydrateAgentSession(row: unknown) {
  const item = row as Record<string, unknown>;
  return { ...item, metadata: parseJson(item.metadata as string | null | undefined, {}) };
}

function hydrateIssueClaim(row: unknown) {
  const item = row as Record<string, unknown>;
  return { ...item, force: Boolean(item.force) };
}

function getAgentSession(id: string) {
  const row = db.prepare("SELECT * FROM agent_sessions WHERE id = @id").get({ id });
  return row ? hydrateAgentSession(row) : null;
}

function getActiveAgentSession(id: string, at = nowIso()) {
  const session = getAgentSession(id) as { status?: string; expires_at?: string } | null;
  if (!session || session.status !== "active" || !session.expires_at || session.expires_at <= at) return null;
  return session as Record<string, unknown> & { agent_name: string };
}

function getIssueClaim(id: string) {
  const row = db.prepare(`
    SELECT c.*, i.identifier, i.title, s.harness
    FROM issue_claims c
    JOIN issues i ON i.id = c.issue_id
    JOIN agent_sessions s ON s.id = c.session_id
    WHERE c.id = @id
  `).get({ id });
  return row ? hydrateIssueClaim(row) : null;
}

function getClaimableIssue(issueId: string) {
  return db.prepare("SELECT id, identifier, status, status_type, archived_at FROM issues WHERE id = @id").get({ id: issueId }) as Record<string, unknown>;
}

function assertIssueOpenForAgentWrite(issue: Record<string, unknown>, allowClosed: unknown, action: string) {
  if (booleanValue(allowClosed, false)) return;
  const label = issueLabel(issue);
  if (issue.archived_at) {
    throw new Error(`Issue ${label} is archived; restore it before trying to ${action} it, or pass allow_closed:true for deliberate historical maintenance.`);
  }
  const statusType = inferStatusType(stringValue(issue.status) ?? undefined) ?? knownStatusType(stringValue(issue.status_type) ?? undefined);
  if (statusType === "completed" || statusType === "canceled") {
    throw new Error(`Issue ${label} is ${statusType}; reopen it with save_issue before trying to ${action} it, or pass allow_closed:true for deliberate historical maintenance.`);
  }
}

function activeIssueClaims(issueId: string, at = nowIso()) {
  return db.prepare(`
    SELECT c.*, s.harness
    FROM issue_claims c
    JOIN agent_sessions s ON s.id = c.session_id
    WHERE c.issue_id=@issue_id
      AND c.released_at IS NULL
      AND c.status='active'
      AND c.expires_at > @at
      AND s.status='active'
      AND s.expires_at > @at
    ORDER BY c.heartbeat_at DESC, c.claimed_at DESC
  `).all({ issue_id: issueId, at }) as { id: string; session_id: string; agent_name: string; harness?: string | null; note: string | null; expires_at: string }[];
}

function issueIsBlocked(issueId: string, issue?: Record<string, unknown>) {
  const stored = issue ?? getClaimableIssue(issueId);
  const statusType = inferStatusType(stringValue(stored.status) ?? undefined) ?? knownStatusType(stringValue(stored.status_type) ?? undefined);
  if (statusType === "blocked") return true;
  const dependency = db.prepare("SELECT 1 FROM issue_dependencies WHERE issue_id=@issue_id AND status='open' LIMIT 1").get({ issue_id: issueId });
  return Boolean(dependency);
}

function markIssueInProgress(issueId: string, at = nowIso()) {
  db.prepare(`
    UPDATE issues
    SET status='In Progress', status_type='started', completed_at=NULL, updated_at=@at
    WHERE id=@issue_id
      AND ${normalizedStatusTypeSql} IN ('backlog', 'unstarted', 'paused')
  `).run({ issue_id: issueId, at });
}

function settleIssueAfterClaimRelease(issueId: string, completed: boolean, at = nowIso()) {
  if (completed) {
    db.prepare(`
      UPDATE issues
      SET status='Done', status_type='completed', completed_at=coalesce(completed_at, @at), updated_at=@at
      WHERE id=@issue_id
    `).run({ issue_id: issueId, at });
    return;
  }
  const active = activeIssueClaims(issueId, at);
  if (active.length) return;
  db.prepare(`
    UPDATE issues
    SET status='Todo', status_type='unstarted', completed_at=NULL, updated_at=@at
    WHERE id=@issue_id AND ${normalizedStatusTypeSql} = 'started'
  `).run({ issue_id: issueId, at });
}

function latestAcceptanceComment(issueId: string) {
  return db.prepare(`
    SELECT *
    FROM comments
    WHERE issue_id = @issue_id
      AND ${acceptanceCommentSql("body")}
    ORDER BY created_at DESC
    LIMIT 1
  `).get({ issue_id: issueId }) ?? null;
}

function supersedeActiveIssueClaims(issueId: string, at = nowIso()) {
  return db.prepare(`
    UPDATE issue_claims
    SET status='superseded', released_at=@released_at
    WHERE issue_id=@issue_id AND released_at IS NULL AND status='active' AND expires_at > @released_at
  `).run({ issue_id: issueId, released_at: at }).changes;
}

function supersedeOtherActiveIssueClaims(issueId: string, keepClaimId: string, at = nowIso()) {
  return db.prepare(`
    UPDATE issue_claims
    SET status='superseded', released_at=@released_at
    WHERE issue_id=@issue_id AND id != @keep_claim_id AND released_at IS NULL AND status='active' AND expires_at > @released_at
  `).run({ issue_id: issueId, keep_claim_id: keepClaimId, released_at: at }).changes;
}

function expireIssueClaims(issueId: string, at = nowIso()) {
  const result = db.prepare(`
    UPDATE issue_claims
    SET status='expired', released_at=@released_at
    WHERE issue_id=@issue_id AND released_at IS NULL AND expires_at <= @released_at
  `).run({ issue_id: issueId, released_at: at });
  return result.changes;
}

function ttlMinutes(value: unknown) {
  return boundedNumber(value, 60, 1, 24 * 60);
}

function addMinutes(iso: string, minutes: number) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function inferStatusType(status?: string) {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["done", "completed"].includes(normalized)) return "completed";
  if (["in progress", "started"].includes(normalized)) return "started";
  if (["todo", "to do"].includes(normalized)) return "unstarted";
  if (["blocked", "blocker"].includes(normalized)) return "blocked";
  if (["paused", "pause"].includes(normalized)) return "paused";
  if (["canceled", "cancelled"].includes(normalized)) return "canceled";
  return undefined;
}

function knownStatusType(status?: string) {
  const normalized = status?.trim().toLowerCase();
  if (["backlog", "unstarted", "started", "completed", "blocked", "paused", "canceled", "cancelled"].includes(normalized ?? "")) {
    return normalized === "cancelled" ? "canceled" : normalized;
  }
  return undefined;
}

export function ensureIssueIdentifiers() {
  if (issueIdentifiersChecked) return;
  const tx = db.transaction(() => {
    const rows = db.prepare(`
      SELECT id, identifier
      FROM issues
      ORDER BY created_at, rowid
    `).all() as { id: string; identifier: string | null }[];
    const used = new Set(rows.map((row) => row.identifier).filter(isShortIssueIdentifier));
    let next = nextLocalIssueNumber(used);
    const update = db.prepare("UPDATE issues SET identifier = @identifier WHERE id = @id");
    for (const row of rows) {
      if (isShortIssueIdentifier(row.identifier)) continue;
      const identifier = formatLocalIssueIdentifier(next++);
      used.add(identifier);
      update.run({ id: row.id, identifier });
    }
  });
  tx.immediate();
  issueIdentifiersChecked = true;
}

function resolveIssueIdentifier(input: IssueInput, existing?: Record<string, unknown>) {
  const requested = hasOwn(input, "identifier") ? input.identifier ?? null : undefined;
  if (isShortIssueIdentifier(requested)) return requested;
  const current = stringValue(existing?.identifier);
  if (isShortIssueIdentifier(current)) return current;
  return nextLocalIssueIdentifier();
}

function nextLocalIssueIdentifier() {
  const rows = db.prepare("SELECT identifier FROM issues WHERE identifier LIKE @prefix").all({ prefix: `${localIssuePrefix}-%` }) as { identifier: string | null }[];
  return formatLocalIssueIdentifier(nextLocalIssueNumber(new Set(rows.map((row) => row.identifier).filter(isShortIssueIdentifier))));
}

function nextLocalIssueNumber(used: Set<string>) {
  let max = 0;
  for (const identifier of used) {
    const match = new RegExp(`^${localIssuePrefix}-(\\d+)$`).exec(identifier);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function formatLocalIssueIdentifier(value: number) {
  return `${localIssuePrefix}-${String(value).padStart(3, "0")}`;
}

function isShortIssueIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9]{1,8}-\d{1,6}$/.test(value);
}

function statusTypeFromStatusFallback(status?: string) {
  return status?.trim() ? "backlog" : undefined;
}

function shouldRetryAutomaticIdentifier(input: IssueInput) {
  return !isShortIssueIdentifier(input.identifier);
}

function isIdentifierUniqueConstraintError(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_CONSTRAINT_UNIQUE" && message.includes("issues.identifier");
}

function hasOwn<T extends object>(input: T, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : value == null ? null : String(value);
}

function lowerString(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function booleanValue(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = lowerString(value);
  if (!normalized) return fallback;
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : undefined;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), min), max);
}

function filterValues(value: FilterValue) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function inClause(expression: string, prefix: string, values: string[], params: Record<string, unknown>) {
  const names = values.map((value, index) => {
    const key = `${prefix}_${Object.keys(params).length}_${index}`;
    params[key] = value;
    return `@${key}`;
  });
  return `${expression} IN (${names.join(", ")})`;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function boundedRequiredString(value: unknown, field: string, maxLength: number) {
  const normalized = nonEmptyString(value);
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > maxLength) throw new Error(`${field} is too long (maximum ${maxLength} characters)`);
  return normalized;
}

function optionalBoundedString(value: unknown, field: string, maxLength: number) {
  const normalized = nonEmptyString(value);
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new Error(`${field} is too long (maximum ${maxLength} characters)`);
  return normalized;
}

function normalizeProjectHealth(value: unknown) {
  const normalized = lowerString(value)?.replace(/[ -]+/g, "_") ?? "on_track";
  if (!["on_track", "at_risk", "off_track", "complete"].includes(normalized)) {
    throw new Error("health must be on_track, at_risk, off_track, or complete");
  }
  return normalized;
}

function resolveIssueForUpsert(input: IssueInput) {
  if (hasOwn(input, "issue_id")) {
    const issueId = nonEmptyString(input.issue_id);
    if (!issueId) throw new Error(`Issue not found: ${stringValue(input.issue_id) ?? ""}`);
    const existing = getIssueRowByLocator(issueId);
    if (!existing) throw new Error(`Issue not found: ${issueId}`);
    assertCompatibleIssueLocators(input, existing);
    return existing;
  }
  // An explicitly supplied `id` decides whether this is a create or an update.
  // Other locators may CONFIRM that decision; they must never retarget it.
  //
  // This was `external_id ?? id ?? identifier`, which made external_id outrank
  // id. Calling save_issue with {id: "CTH-015", external_id: "..."} to ADD an
  // external_id to an existing issue looked up the external_id, did not find
  // it, and CREATED a second issue — silently, returning a plausible one. It
  // compounded because the new row adopted the caller's id as its primary key,
  // so a row whose identifier was CTH-730 had row id "CTH-015" and every later
  // lookup for CTH-015 resolved to the wrong issue.
  //
  // Resolving by ANY locator is not the fix either: a caller naming a NEW id
  // alongside an identifier that already exists is asking for a row that cannot
  // be created, and must hit the unique constraint rather than quietly updating
  // whatever the identifier happened to match (tests/store-regression.mjs:417).
  if (hasOwn(input, "id")) {
    const id = nonEmptyString(input.id);
    const existing = id ? getIssueRowByLocator(id) : undefined;
    // A supplied id that does not resolve means "create". Say so plainly rather
    // than letting another locator take over.
    if (existing) assertCompatibleIssueLocators(input, existing);
    return existing;
  }

  const lookupId = input.external_id ?? input.identifier;
  const existing = lookupId ? getIssueRowByLocator(lookupId) : undefined;
  if (existing) assertCompatibleIssueLocators(input, existing);
  return existing;
}

function assertCompatibleIssueLocators(input: IssueInput, existing: Record<string, unknown>) {
  for (const field of ["id", "external_id", "identifier"] as const) {
    if (!hasOwn(input, field)) continue;
    const value = nonEmptyString(input[field]);
    if (!value) continue;
    const resolved = getIssueRowByLocator(value);
    if (resolved && stringValue(resolved.id) !== stringValue(existing.id)) {
      throw new Error(`Conflicting issue locator ${field}: ${value} resolves to ${issueLabel(resolved)}, but issue_id resolves to ${issueLabel(existing)}`);
    }
  }
}

function getIssueRowByLocator(value: string) {
  return db.prepare("SELECT * FROM issues WHERE id = @id OR external_id = @id OR identifier = @id").get({ id: value }) as Record<string, unknown> | undefined;
}

function getIssueDependency(id: string, issueId?: string, blockerIssueId?: string) {
  return db.prepare(`
    SELECT d.*, issue.identifier AS issue_identifier, issue.title AS issue_title,
      blocker.identifier AS blocker_identifier, blocker.title AS blocker_title
    FROM issue_dependencies d
    JOIN issues issue ON issue.id = d.issue_id
    JOIN issues blocker ON blocker.id = d.blocker_issue_id
    WHERE d.id = @id
      OR (@issue_id IS NOT NULL AND @blocker_issue_id IS NOT NULL
        AND d.issue_id = @issue_id AND d.blocker_issue_id = @blocker_issue_id)
    LIMIT 1
  `).get({ id, issue_id: issueId ?? null, blocker_issue_id: blockerIssueId ?? null }) as Record<string, unknown> | undefined;
}

function resolveIssueDependencyRow(input: { dependency_id?: string; issue_id?: string; blocker_issue_id?: string }) {
  const dependencyId = nonEmptyString(input.dependency_id);
  if (dependencyId) return getIssueDependency(dependencyId);
  const issueId = resolveParentId(input.issue_id);
  const blockerIssueId = resolveParentId(input.blocker_issue_id);
  if (!issueId || !blockerIssueId) return undefined;
  return getIssueDependency("", issueId, blockerIssueId);
}

function dependencyWouldCycle(issueId: string, blockerIssueId: string) {
  const row = db.prepare(`
    WITH RECURSIVE blocker_chain(issue_id) AS (
      SELECT @blocker_issue_id
      UNION
      SELECT dependency.blocker_issue_id
      FROM issue_dependencies dependency
      JOIN blocker_chain chain ON dependency.issue_id = chain.issue_id
      WHERE dependency.status = 'open'
    )
    SELECT 1 AS cycle FROM blocker_chain WHERE issue_id = @issue_id LIMIT 1
  `).get({ issue_id: issueId, blocker_issue_id: blockerIssueId });
  return Boolean(row);
}

function issueLabel(issue: Record<string, unknown>) {
  return stringValue(issue.identifier) ?? stringValue(issue.id) ?? "unknown issue";
}

function resolveIssueProjectId(input: IssueInput, existing?: Record<string, unknown>) {
  if (hasOwn(input, "project_id")) {
    if (input.project_id == null) {
      if (booleanValue(input.allow_no_project, false)) return null;
      throw new Error("project_id:null requires allow_no_project:true. Use list_projects and pass the owning project_id for normal issues.");
    }
    const resolved = resolveProjectId(input.project_id);
    if (!resolved) throw new Error(`Project not found: ${input.project_id}`);
    return resolved;
  }
  if (existing) return stringValue(existing.project_id);
  if (booleanValue(input.allow_no_project, false)) return null;
  throw new Error("project_id is required when creating an issue. Use list_projects first and pass the owning project_id; pass allow_no_project:true only for a deliberate unassigned inbox issue.");
}

function normalizeLabels(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string" || !value) return [];
  const parsed = parseJson<unknown>(value, []);
  if (typeof parsed === "string" && parsed !== value) return normalizeLabels(parsed);
  if (Array.isArray(parsed)) return normalizeLabels(parsed);
  return [];
}

function resolveProjectId(value: string | null | undefined) {
  const project = value ? db.prepare("SELECT id FROM projects WHERE id = @id OR external_id = @id").get({ id: value }) as { id: string } | undefined : undefined;
  return project?.id ?? null;
}

function resolveTeamId(value: string | null | undefined) {
  const team = value ? db.prepare("SELECT id FROM teams WHERE id = @id OR external_id = @id").get({ id: value }) as { id: string } | undefined : undefined;
  return team?.id ?? null;
}

function resolveIssueTeamId(value: string | null | undefined) {
  if (value == null) return null;
  const teamId = resolveTeamId(value);
  if (!teamId) throw new Error(`Team not found: ${value}`);
  return teamId;
}

function defaultTeamId() {
  return String((ensureDefaultTeam() as { id: string }).id);
}

function resolveParentId(value: string | null | undefined) {
  const issue = value ? db.prepare("SELECT id FROM issues WHERE id = @id OR external_id = @id OR identifier = @id").get({ id: value }) as { id: string } | undefined : undefined;
  return issue?.id ?? null;
}

function resolveIssueParentId(value: string | null | undefined) {
  if (value == null) return null;
  const parentId = resolveParentId(value);
  if (!parentId) throw new Error(`Parent issue not found: ${value}`);
  return parentId;
}
