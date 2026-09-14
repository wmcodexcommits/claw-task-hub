// External (Postgres/Supabase) database connections.
//
// This registry holds connection TARGETS, never a live handle. An entry can be
// registered and test-pinged here, and server/db.ts can make one the active data
// layer (activateDatabase("external:<id>")), after which store.ts reads and
// writes it through the Postgres adapter. The registry stays free of any
// database handle so that listing, testing, or deleting an entry can never
// disturb whichever database is active -- that guard lives with the handle, in
// db.ts and the routes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(root, "data");
// Overridable so tests can register connections without touching the operator's
// real registry.
const connectionsRegistryPath = process.env.CLAW_TASK_HUB_CONNECTIONS_FILE
  ? resolve(process.env.CLAW_TASK_HUB_CONNECTIONS_FILE)
  : join(dataDir, ".claw-task-hub-connections.json");

export type ExternalDatabaseKind = "postgres" | "supabase";

type StoredConnectionBase = {
  id: string;
  name: string;
  kind: ExternalDatabaseKind;
  ssl: boolean;
  createdAt: string;
  lastTestedAt: string | null;
  lastTestStatus: "ok" | "error" | null;
  lastTestError: string | null;
};

type StoredConnection =
  | (StoredConnectionBase & { mode: "stored"; connectionString: string })
  | (StoredConnectionBase & { mode: "env"; connectionStringEnv: string });

export type ExternalConnectionSummary = {
  id: string;
  name: string;
  kind: ExternalDatabaseKind;
  ssl: boolean;
  // Never the credential itself: host[:port][/database] for a stored string,
  // or "env:VAR_NAME" when the secret lives outside this file entirely.
  target: string;
  secretSource: "stored" | "env";
  createdAt: string;
  lastTestedAt: string | null;
  lastTestStatus: "ok" | "error" | null;
  lastTestError: string | null;
};

export type RegisterExternalConnectionInput = {
  name: string;
  kind: ExternalDatabaseKind;
  connectionString?: string;
  connectionStringEnv?: string;
  ssl?: boolean;
};

export type TestConnectionResult = { ok: boolean; error?: string };

function isStoredConnection(value: unknown): value is StoredConnection {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.name !== "string") return false;
  if (record.kind !== "postgres" && record.kind !== "supabase") return false;
  if (typeof record.ssl !== "boolean" || typeof record.createdAt !== "string") return false;
  if (record.mode === "stored") return typeof record.connectionString === "string";
  if (record.mode === "env") return typeof record.connectionStringEnv === "string";
  return false;
}

function readRegistry(): StoredConnection[] {
  if (!existsSync(connectionsRegistryPath)) return [];
  try {
    const value = JSON.parse(readFileSync(connectionsRegistryPath, "utf8"));
    return Array.isArray(value) ? value.filter(isStoredConnection) : [];
  } catch {
    return [];
  }
}

function writeRegistry(entries: StoredConnection[]) {
  mkdirSync(dirname(connectionsRegistryPath), { recursive: true });
  const temporaryRegistry = `${connectionsRegistryPath}.${process.pid}.tmp`;
  writeFileSync(temporaryRegistry, `${JSON.stringify(entries, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryRegistry, connectionsRegistryPath);
}

function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!slug) throw new Error("Connection name must contain a letter or number");
  return slug;
}

function nextConnectionId(name: string, existing: StoredConnection[]): string {
  const base = slugify(name);
  const existingIds = new Set(existing.map((entry) => entry.id));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = createHash("sha256").update(`${base}:${Date.now()}:${attempt}:${Math.random()}`).digest("hex").slice(0, 8);
    const candidate = `${base}-${suffix}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique connection id");
}

function redactConnectionTarget(raw: string): string {
  try {
    const url = new URL(raw);
    const host = url.hostname || "unknown-host";
    const port = url.port ? `:${url.port}` : "";
    const database = url.pathname && url.pathname !== "/" ? url.pathname : "";
    return `${host}${port}${database}`;
  } catch {
    return "(unparseable connection string)";
  }
}

function toSummary(entry: StoredConnection): ExternalConnectionSummary {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    ssl: entry.ssl,
    target: entry.mode === "stored" ? redactConnectionTarget(entry.connectionString) : `env:${entry.connectionStringEnv}`,
    secretSource: entry.mode,
    createdAt: entry.createdAt,
    lastTestedAt: entry.lastTestedAt,
    lastTestStatus: entry.lastTestStatus,
    lastTestError: entry.lastTestError,
  };
}

export function listExternalConnections(): ExternalConnectionSummary[] {
  return readRegistry()
    .map(toSummary)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getExternalConnection(id: string): ExternalConnectionSummary | null {
  const entry = readRegistry().find((item) => item.id === id);
  return entry ? toSummary(entry) : null;
}

export function registerExternalConnection(input: RegisterExternalConnectionInput): ExternalConnectionSummary {
  const name = input.name.trim();
  if (!name) throw new Error("Connection name is required");
  if (input.kind !== "postgres" && input.kind !== "supabase") throw new Error("Unsupported connection kind");

  const connectionString = input.connectionString?.trim();
  const connectionStringEnv = input.connectionStringEnv?.trim();
  const hasStored = Boolean(connectionString);
  const hasEnvRef = Boolean(connectionStringEnv);
  if (hasStored === hasEnvRef) {
    throw new Error("Provide exactly one of a connection string or an environment variable name");
  }

  const existing = readRegistry();
  const id = nextConnectionId(name, existing);
  const base: StoredConnectionBase = {
    id,
    name,
    kind: input.kind,
    ssl: input.ssl ?? true,
    createdAt: new Date().toISOString(),
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestError: null,
  };
  const entry: StoredConnection = hasStored
    ? { ...base, mode: "stored", connectionString: connectionString! }
    : { ...base, mode: "env", connectionStringEnv: connectionStringEnv! };

  writeRegistry([...existing, entry]);
  return toSummary(entry);
}

export function deleteExternalConnection(id: string, confirm = false): ExternalConnectionSummary[] {
  if (confirm !== true) throw new Error("delete_connection requires confirm=true. Nothing was deleted.");
  const existing = readRegistry();
  if (!existing.some((entry) => entry.id === id)) throw new Error(`Connection not found: ${id}`);
  writeRegistry(existing.filter((entry) => entry.id !== id));
  return listExternalConnections();
}

export type ExternalConnectionTarget = {
  summary: ExternalConnectionSummary;
  connectionString: string;
  ssl: boolean;
};

/** The credential-bearing view of one entry, for opening it. Never serialize it. */
export function resolveExternalConnection(id: string): ExternalConnectionTarget {
  const entry = readRegistry().find((item) => item.id === id);
  if (!entry) throw new Error(`Connection not found: ${id}`);
  return { summary: toSummary(entry), connectionString: resolveConnectionString(entry), ssl: entry.ssl };
}

function resolveConnectionString(entry: StoredConnection): string {
  if (entry.mode === "stored") return entry.connectionString;
  const value = process.env[entry.connectionStringEnv];
  if (!value) throw new Error(`Environment variable ${entry.connectionStringEnv} is not set`);
  return value;
}

// Dynamically imported so a checkout that never touches this feature does not
// need the `postgres` package installed just to boot the server.
export async function testExternalConnection(id: string): Promise<TestConnectionResult> {
  const existing = readRegistry();
  const entry = existing.find((item) => item.id === id);
  if (!entry) throw new Error(`Connection not found: ${id}`);

  let result: TestConnectionResult;
  try {
    const connectionString = resolveConnectionString(entry);
    const postgresModule = await import("postgres").catch(() => {
      throw new Error("The 'postgres' package is not installed. Run `bun install` after pulling this change.");
    });
    const postgres = postgresModule.default;
    const sql = postgres(connectionString, {
      ssl: entry.ssl ? "require" : false,
      max: 1,
      connect_timeout: 10,
      idle_timeout: 1,
    });
    try {
      await sql`select 1`;
      result = { ok: true };
    } finally {
      await sql.end({ timeout: 1 });
    }
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  writeRegistry(existing.map((item) => (item.id === id
    ? {
        ...item,
        lastTestedAt: new Date().toISOString(),
        lastTestStatus: result.ok ? "ok" : "error",
        lastTestError: result.error ?? null,
      }
    : item)));
  return result;
}
