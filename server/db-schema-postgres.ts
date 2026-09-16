// Postgres translation of the SQLite bootstrap schema in db.ts.
//
// Column types are kept deliberately literal: timestamps stay TEXT holding ISO
// strings and `force` stays INTEGER, exactly as SQLite stores them. Using
// timestamptz/boolean here would be more idiomatic Postgres but would hand
// store.ts a different shape back from one backend than the other -- Date
// objects instead of strings, true instead of 1 -- and every read path would
// then need per-backend coercion. Matching the existing shapes keeps one set of
// queries correct against both engines.
//
// The one structural difference is full-text search. SQLite uses an external
// content fts5 virtual table kept in sync by three triggers; Postgres gets a
// generated tsvector column with a GIN index, which needs no triggers because
// the column is derived. searchIssuesClausePostgres below is the matching
// predicate for that column.

import { executionAttemptsSchemaSql } from "./execution-attempts-schema.js";

export const postgresSchemaSql = `
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  name TEXT NOT NULL,
  key TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  name TEXT NOT NULL,
  summary TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'Backlog',
  priority INTEGER NOT NULL DEFAULT 3,
  lead TEXT,
  target_date TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  identifier TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'Backlog',
  status_type TEXT NOT NULL DEFAULT 'backlog',
  priority INTEGER NOT NULL DEFAULT 3,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
  assignee TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'local',
  url TEXT,
  archived_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) STORED
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  cursor TEXT,
  stats TEXT NOT NULL DEFAULT '{}',
  error TEXT
);

CREATE TABLE IF NOT EXISTS sync_checkpoints (
  source TEXT PRIMARY KEY,
  cursor TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  harness TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS issue_claims (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  claimed_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  force INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS context_bindings (
  id TEXT PRIMARY KEY,
  context_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  default_tab TEXT NOT NULL DEFAULT 'issues',
  harness TEXT,
  workspace_name TEXT,
  cwd TEXT,
  repo_remote TEXT,
  branch TEXT,
  thread_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_updates (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(length(body) <= 10000),
  health TEXT NOT NULL DEFAULT 'on_track' CHECK(health IN ('on_track', 'at_risk', 'off_track', 'complete')),
  author TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_dependencies (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  blocker_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  reason TEXT CHECK(reason IS NULL OR length(reason) <= 2000),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
  resolved_at TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(issue_id, blocker_issue_id),
  CHECK(issue_id <> blocker_issue_id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_search ON issues USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_issues_team_updated ON issues(team_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_project_status ON issues(project_id, status);
CREATE INDEX IF NOT EXISTS idx_issues_identifier ON issues(identifier);
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_identifier_unique ON issues(identifier) WHERE identifier IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_issues_assignee_status ON issues(assignee, status);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_issue_created ON comments(issue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status_expires ON agent_sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_issue_claims_issue_active ON issue_claims(issue_id, released_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_issue_claims_session ON issue_claims(session_id, released_at);
CREATE INDEX IF NOT EXISTS idx_context_bindings_project ON context_bindings(project_id);
CREATE INDEX IF NOT EXISTS idx_context_bindings_lookup ON context_bindings(harness, repo_remote, branch, cwd, thread_id);
CREATE INDEX IF NOT EXISTS idx_project_updates_project_created ON project_updates(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issue_dependencies_issue_status ON issue_dependencies(issue_id, status);
CREATE INDEX IF NOT EXISTS idx_issue_dependencies_blocker_status ON issue_dependencies(blocker_issue_id, status);
${executionAttemptsSchemaSql}
`;

/**
 * SQLite matches issue text through the fts5 table (`i.rowid IN (SELECT rowid
 * FROM issue_fts WHERE issue_fts MATCH @query)`). Postgres has no rowid and no
 * fts5, so the equivalent predicate queries the generated tsvector instead.
 * websearch_to_tsquery is used because it never throws on user input --
 * plainto_/to_tsquery raise a syntax error on stray operators, which would turn
 * a mistyped search box into a 500.
 */
export const searchIssuesClausePostgres = "i.search_vector @@ websearch_to_tsquery('english', @query)";

export const searchIssuesClauseSqlite = "i.rowid IN (SELECT rowid FROM issue_fts WHERE issue_fts MATCH @query)";

/** The LISTEN/NOTIFY channel every hub table announces its changes on. */
export const dataChangeChannel = "claw_task_hub_data_changed";

/** Tables whose writes are visible to a UI, so each one announces changes. */
export const dataChangeTables = [
  "teams",
  "projects",
  "issues",
  "comments",
  "documents",
  "sync_runs",
  "sync_checkpoints",
  "agent_sessions",
  "issue_claims",
  "context_bindings",
  "project_updates",
  "issue_dependencies",
  "execution_attempts",
  "execution_attempt_transitions",
  "execution_workspace_leases",
  "verification_policies",
  "execution_evidence",
  "execution_path_declarations",
  "execution_conflict_policies",
  "execution_conflicts",
  "execution_conflict_decisions",
  "execution_acceptance_policies",
  "execution_acceptances",
  "execution_runners",
  "execution_reconciliation_runs",
  "execution_reconciliation_decisions",
] as const;

// Change announcements for UIs served by OTHER processes and machines.
//
// A UI refreshes when its own API server tells it to, and that server only
// hears about writes it made itself or that a local MCP process posted to it.
// Two hubs sharing one Postgres database would otherwise never see each other's
// writes. The triggers live in the database rather than in store.ts so that
// every writer announces its changes -- a hub on another machine, an older hub
// build, the CLI, or an operator tool -- without having to opt in.
//
// Statement-level triggers keep this cheap: one notification per statement, not
// per row. Postgres delivers a notification only when its transaction commits
// (a rolled-back write announces nothing), and collapses identical channel and
// payload pairs within one transaction, so a bulk import produces one event per
// table. The payload is only the table name; listeners re-read what they need.
//
// Applied separately from postgresSchemaSql because not every Postgres-wire
// server supports triggers or NOTIFY. A server that rejects this still works as
// a hub; it just cannot push live refreshes.
//
// Existence is checked before each CREATE TRIGGER instead of dropping and
// recreating the triggers: every process that opens the connection runs this,
// and DROP TRIGGER takes an exclusive lock on the table each time. The
// duplicate_object handler covers two processes creating the same trigger at once.
export const postgresChangeNotificationSql = `
CREATE OR REPLACE FUNCTION claw_task_hub_notify_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('${dataChangeChannel}', TG_TABLE_NAME);
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  hub_table text;
BEGIN
  FOREACH hub_table IN ARRAY ARRAY[${dataChangeTables.map((table) => `'${table}'`).join(", ")}] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'claw_task_hub_notify_change' AND tgrelid = to_regclass(hub_table)
    ) THEN
      BEGIN
        EXECUTE format(
          'CREATE TRIGGER claw_task_hub_notify_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I '
          'FOR EACH STATEMENT EXECUTE FUNCTION claw_task_hub_notify_change()',
          hub_table
        );
      EXCEPTION WHEN duplicate_object THEN
        NULL;
      END;
    END IF;
  END LOOP;
END;
$$;
`;
