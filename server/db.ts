import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removePathWithRetries } from "./filesystem.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });

const legacyDbPath = join(dataDir, "codex-task-hub.sqlite");
const clawDbPath = join(dataDir, "claw-task-hub.sqlite");
type SqliteStatement = {
  all: (...bindings: unknown[]) => unknown[];
  get: (...bindings: unknown[]) => unknown;
  run: (...bindings: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
};

type SqliteDatabase = Omit<Database, "prepare" | "query"> & {
  prepare: (sql: string) => SqliteStatement;
  query: (sql: string) => SqliteStatement;
};

function openDatabase(path: string): SqliteDatabase {
  return new Database(path, { strict: true }) as unknown as SqliteDatabase;
}

export type ManagedDatabase = {
  id: string;
  name: string;
  fileName: string;
  path: string;
  active: boolean;
};

export function resolveDbPath(env: NodeJS.ProcessEnv = process.env, legacyExists = existsSync(legacyDbPath)) {
  const explicit = env.CLAW_TASK_HUB_DB ?? env.CODEX_TASK_HUB_DB;
  if (explicit) return explicit;

  // Falling back is correct on a first run, and dangerous for an agent. The
  // repo-local default is NOT necessarily the database anyone is looking at:
  // a deployment that runs from .stack, or any other explicit path, leaves this
  // file present, writable and empty of the work in progress. Writing here
  // SUCCEEDS — same schema, same tool surface, plausible responses — and shows
  // up nowhere. A project and eleven issues were created in it before anyone
  // noticed.
  //
  // A caller that knows it must not guess sets CLAW_TASK_HUB_REQUIRE_DB=1 and
  // gets an error instead of a silent second database.
  if (isTruthyEnv(env.CLAW_TASK_HUB_REQUIRE_DB)) {
    throw new Error(
      "CLAW_TASK_HUB_REQUIRE_DB is set but no database was named. Set " +
      "CLAW_TASK_HUB_DB to the database this process should use. Refusing to " +
      "fall back to the repository default, which may not be the database in " +
      "use: " + (legacyExists ? legacyDbPath : clawDbPath));
  }
  return legacyExists ? legacyDbPath : clawDbPath;
}

function isTruthyEnv(value: string | undefined) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

const configuredDbPath = resolveDbPath();
const databaseDir = dirname(configuredDbPath);
const activeDatabasePointer = join(databaseDir, ".claw-task-hub-active-db");
const databaseRegistryPath = join(databaseDir, ".claw-task-hub-databases.json");

export let dbPath = resolveInitialDbPath();
mkdirSync(dirname(dbPath), { recursive: true });
export let db = openDatabase(dbPath);

export function listManagedDatabases(): { active: ManagedDatabase; databases: ManagedDatabase[] } {
  const databasePaths = new Set(
    readdirSync(databaseDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".sqlite")
      .map((entry) => resolve(databaseDir, entry.name)),
  );
  for (const registeredPath of readDatabaseRegistry()) {
    if (existsSync(registeredPath)) databasePaths.add(registeredPath);
  }
  databasePaths.add(resolve(dbPath));
  const activePath = resolve(dbPath);
  const databases = [...databasePaths]
    .map((path) => ({
      id: databaseId(path),
      name: databaseDisplayName(basename(path)),
      fileName: basename(path),
      path,
      active: path === activePath,
    }))
    .sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name));
  const active = databases.find((entry) => entry.active);
  if (!active) throw new Error("Active database is missing from the database catalogue");
  return { active, databases };
}

export function getManagedDatabase(id: string) {
  return listManagedDatabases().databases.find((database) => database.id === id) ?? null;
}

export function createManagedDatabase(name: string, requestedPath?: string) {
  const nextPath = resolveNewDatabasePath(name, requestedPath);
  if (existsSync(nextPath)) throw new Error(`Database already exists: ${nextPath}`);
  const nextDatabase = openDatabase(nextPath);
  try {
    initializeDatabase(nextDatabase);
    activateOpenDatabase(nextDatabase, nextPath);
  } catch (error) {
    closeDatabase(nextDatabase);
    removePathWithRetries(nextPath, { force: true });
    removePathWithRetries(`${nextPath}-wal`, { force: true });
    removePathWithRetries(`${nextPath}-shm`, { force: true });
    throw error;
  }
  return listManagedDatabases();
}

export function activateManagedDatabase(id: string) {
  const registered = listManagedDatabases().databases.find((database) => database.id === id);
  if (!registered) throw new Error(`Database not found: ${id}`);
  const nextPath = registered.path;
  if (resolve(nextPath) === resolve(dbPath)) return listManagedDatabases();
  const nextDatabase = openDatabase(nextPath);
  try {
    initializeDatabase(nextDatabase);
    activateOpenDatabase(nextDatabase, nextPath);
  } catch (error) {
    closeDatabase(nextDatabase);
    throw error;
  }
  return listManagedDatabases();
}

export function deleteManagedDatabase(id: string, confirm = false) {
  if (confirm !== true) throw new Error("delete_database requires confirm=true. Nothing was deleted.");
  const catalogue = listManagedDatabases();
  const target = catalogue.databases.find((database) => database.id === id);
  if (!target) throw new Error(`Database not found: ${id}`);
  if (target.active) throw new Error("The active database cannot be deleted. Activate another database first.");

  removePathWithRetries(target.path);
  removePathWithRetries(`${target.path}-wal`, { force: true });
  removePathWithRetries(`${target.path}-shm`, { force: true });
  removePathWithRetries(`${target.path}-journal`, { force: true });
  unregisterDatabasePath(target.path);
  return listManagedDatabases();
}

function resolveInitialDbPath() {
  mkdirSync(databaseDir, { recursive: true });
  if (!existsSync(activeDatabasePointer)) return configuredDbPath;
  try {
    const selectedId = readFileSync(activeDatabasePointer, "utf8").trim();
    const selectedPath = isAbsolute(selectedId) ? resolve(selectedId) : managedDatabasePath(selectedId);
    return existsSync(selectedPath) ? selectedPath : configuredDbPath;
  } catch {
    return configuredDbPath;
  }
}

export function databaseIdFromName(name: string) {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) throw new Error("Database name must contain a letter or number");
  return `${slug}.sqlite`;
}

function databaseDisplayName(id: string) {
  return id.replace(/\.sqlite$/i, "");
}

function databaseId(path: string) {
  if (dirname(resolve(path)) === resolve(databaseDir)) return basename(path);
  return `external-${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16)}`;
}

function resolveNewDatabasePath(name: string, requestedPath?: string) {
  if (!requestedPath?.trim()) return managedDatabasePath(databaseIdFromName(name));
  if (!isAbsolute(requestedPath)) throw new Error("Database location must be an absolute filesystem path");
  const requested = resolve(requestedPath);
  const extension = extname(requested).toLowerCase();
  if (extension && extension !== ".sqlite") throw new Error("Database location must end in .sqlite");
  const nextPath = extension ? requested : `${requested}.sqlite`;
  if (!existsSync(dirname(nextPath))) throw new Error(`Database directory does not exist: ${dirname(nextPath)}`);
  return nextPath;
}

function readDatabaseRegistry(): string[] {
  if (!existsSync(databaseRegistryPath)) return [];
  try {
    const value = JSON.parse(readFileSync(databaseRegistryPath, "utf8"));
    if (!Array.isArray(value)) return [];
    return value
      .filter((path): path is string => typeof path === "string" && isAbsolute(path) && extname(path).toLowerCase() === ".sqlite")
      .map((path) => resolve(path));
  } catch {
    return [];
  }
}

function registerDatabasePath(path: string) {
  const paths = [...new Set([...readDatabaseRegistry(), resolve(path)])].sort();
  writeDatabaseRegistry(paths);
}

function unregisterDatabasePath(path: string) {
  const target = resolve(path);
  writeDatabaseRegistry(readDatabaseRegistry().filter((registeredPath) => registeredPath !== target));
}

function writeDatabaseRegistry(paths: string[]) {
  const temporaryRegistry = `${databaseRegistryPath}.${process.pid}.tmp`;
  writeFileSync(temporaryRegistry, `${JSON.stringify(paths, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryRegistry, databaseRegistryPath);
}

function managedDatabasePath(id: string) {
  if (basename(id) !== id || !/^[a-z0-9][a-z0-9._-]*\.sqlite$/i.test(id)) {
    throw new Error("Invalid database identifier");
  }
  return join(databaseDir, id);
}

function activateOpenDatabase(nextDatabase: SqliteDatabase, nextPath: string) {
  const previousDatabase = db;
  const previousPath = dbPath;
  closeDatabase(previousDatabase);
  const temporaryPointer = `${activeDatabasePointer}.${process.pid}.tmp`;
  try {
    registerDatabasePath(nextPath);
    writeFileSync(temporaryPointer, `${resolve(nextPath)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPointer, activeDatabasePointer);
    db = nextDatabase;
    dbPath = nextPath;
  } catch (error) {
    db = openDatabase(previousPath);
    dbPath = previousPath;
    throw error;
  }
}

function closeDatabase(database: SqliteDatabase) {
  Bun.gc(true);
  database.close(true);
}

// Say which database this process is using, always, on stderr so it cannot be
// confused with tool output. The wrong-database incident cost an hour and would
// have been one line to spot.
if (!isTruthyEnv(process.env.CLAW_TASK_HUB_QUIET_DB)) {
  const source = process.env.CLAW_TASK_HUB_DB
    ? "CLAW_TASK_HUB_DB"
    : process.env.CODEX_TASK_HUB_DB
      ? "CODEX_TASK_HUB_DB"
      : "repository default (no CLAW_TASK_HUB_DB set)";
  process.stderr.write(`claw-task-hub: database ${dbPath} [${source}]\n`);
}

export function initializeDatabase(database: SqliteDatabase) {
  configureDatabase(database);
  createSchema(database);
  return runMigrations(database);
}

function configureDatabase(database: SqliteDatabase) {
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA synchronous = NORMAL");
}

function createSchema(database: SqliteDatabase) {
  database.exec(`
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
  updated_at TEXT NOT NULL
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

CREATE VIRTUAL TABLE IF NOT EXISTS issue_fts USING fts5(
  title,
  description,
  content='issues',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS issues_ai AFTER INSERT ON issues BEGIN
  INSERT INTO issue_fts(rowid, title, description) VALUES (new.rowid, new.title, coalesce(new.description, ''));
END;
CREATE TRIGGER IF NOT EXISTS issues_ad AFTER DELETE ON issues BEGIN
  INSERT INTO issue_fts(issue_fts, rowid, title, description) VALUES('delete', old.rowid, old.title, coalesce(old.description, ''));
END;
CREATE TRIGGER IF NOT EXISTS issues_au AFTER UPDATE ON issues BEGIN
  INSERT INTO issue_fts(issue_fts, rowid, title, description) VALUES('delete', old.rowid, old.title, coalesce(old.description, ''));
  INSERT INTO issue_fts(rowid, title, description) VALUES (new.rowid, new.title, coalesce(new.description, ''));
END;

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
`);
}

const migrations: {
  id: string;
  description: string;
  up: (database: SqliteDatabase) => void;
}[] = [
  {
    id: "0001_baseline_schema",
    description: "Record the bootstrap schema managed by server/db.ts",
    up: (database) => {
      database.exec("INSERT INTO issue_fts(issue_fts) VALUES('rebuild')");
    },
  },
  {
    id: "0002_comments_issue_created_index",
    description: "Index comments by issue and creation time for agent acceptance lookups",
    up: (database) => {
      database.exec("CREATE INDEX IF NOT EXISTS idx_comments_issue_created ON comments(issue_id, created_at DESC)");
    },
  },
  {
    id: "0003_context_bindings",
    description: "Create project context bindings for agentic harness routing",
    up: (database) => {
      database.exec(`
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
        CREATE INDEX IF NOT EXISTS idx_context_bindings_project ON context_bindings(project_id);
        CREATE INDEX IF NOT EXISTS idx_context_bindings_lookup ON context_bindings(harness, repo_remote, branch, cwd, thread_id);
      `);
    },
  },
  {
    id: "0004_project_updates_and_issue_dependencies",
    description: "Add first-class project updates and explicit issue blockers",
    up: (database) => {
      database.exec(`
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
        CREATE INDEX IF NOT EXISTS idx_project_updates_project_created ON project_updates(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_issue_dependencies_issue_status ON issue_dependencies(issue_id, status);
        CREATE INDEX IF NOT EXISTS idx_issue_dependencies_blocker_status ON issue_dependencies(blocker_issue_id, status);
      `);
    },
  },
  {
    id: "0005_project_target_date",
    description: "Store configured project target dates",
    up: (database) => {
      const columns = database.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
      if (!columns.some((column) => column.name === "target_date")) {
        database.exec("ALTER TABLE projects ADD COLUMN target_date TEXT");
      }
    },
  },
  {
    id: "0006_issue_dependency_source",
    description: "Bring existing issue dependency tables up to the source contract",
    up: (database) => {
      const columns = database.prepare("PRAGMA table_info(issue_dependencies)").all() as { name: string }[];
      if (!columns.some((column) => column.name === "source")) {
        database.exec("ALTER TABLE issue_dependencies ADD COLUMN source TEXT NOT NULL DEFAULT 'local'");
      }
    },
  },
];

export function runMigrations(database: SqliteDatabase = db) {
  ensureSchemaMigrationsTable(database);
  const applied: string[] = [];
  const tx = database.transaction(() => {
    normalizeLegacyMigrationRows(database);
    const exists = database.prepare("SELECT 1 FROM schema_migrations WHERE id = @id");
    const record = prepareMigrationRecord(database);
    for (const migration of migrations) {
      if (exists.get({ id: migration.id })) continue;
      migration.up(database);
      record.run({
        id: migration.id,
        name: migration.description,
        description: migration.description,
        applied_at: nowIso(),
      });
      applied.push(migration.id);
    }
  });
  tx.immediate();
  return { applied, current: migrations.at(-1)?.id ?? null };
}

function ensureSchemaMigrationsTable(database: SqliteDatabase) {
  database.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
  `);
  const columns = database.prepare("PRAGMA table_info(schema_migrations)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "name")) {
    try {
      database.exec("ALTER TABLE schema_migrations ADD COLUMN name TEXT");
    } catch (error) {
      if (!isDuplicateColumnError(error)) throw error;
    }
    if (columns.some((column) => column.name === "description")) {
      database.exec("UPDATE schema_migrations SET name = description WHERE name IS NULL");
    }
  }
}

function normalizeLegacyMigrationRows(database: SqliteDatabase) {
  database.prepare(`
    UPDATE schema_migrations
    SET id = '0001_baseline_schema',
        name = COALESCE(name, 'Record the bootstrap schema managed by server/db.ts')
    WHERE id = '0001_bootstrap_schema'
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = '0001_baseline_schema')
  `).run();
  database.prepare(`
    DELETE FROM schema_migrations
    WHERE id = '0001_bootstrap_schema'
      AND EXISTS (SELECT 1 FROM schema_migrations WHERE id = '0001_baseline_schema')
  `).run();
}

function prepareMigrationRecord(database: SqliteDatabase) {
  const columns = database.prepare("PRAGMA table_info(schema_migrations)").all() as { name: string }[];
  if (columns.some((column) => column.name === "description")) {
    return database.prepare(`
      INSERT INTO schema_migrations (id, name, description, applied_at)
      VALUES (@id, @name, @description, @applied_at)
    `);
  }
  return database.prepare(`
    INSERT INTO schema_migrations (id, name, applied_at)
    VALUES (@id, @name, @applied_at)
  `);
}

function isDuplicateColumnError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("duplicate column name");
}

initializeDatabase(db);

export function nowIso() {
  return new Date().toISOString();
}

export function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
