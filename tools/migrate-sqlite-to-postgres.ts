// Copy a Claw Task Hub SQLite database into a registered Postgres connection.
//
// A standalone operator tool, like tools/linear-migration: nothing in the API,
// MCP server, or hub CLI calls it. Moving a hub's history to Postgres is a
// one-off operation that must land completely or not at all, so the whole copy
// is ONE Postgres transaction -- schema, emptiness check, rows, and verification.
// Postgres DDL is transactional, which is what makes --dry-run honest: it runs
// every step, including verification, and then rolls all of it back.
//
// Refused rather than attempted:
//   - a target that already holds rows (a second run would duplicate history);
//   - source rows violating a foreign key (Postgres enforces what SQLite let by);
//   - a source column the target has no column for (it would be silently lost);
//   - a non-empty source table this tool does not know how to place.
//
// --enable-row-level-security is for targets that publish a schema over an HTTP
// API -- Supabase exposes `public` to anyone holding the project's anon key. It
// enables RLS on every hub table INSIDE the copy transaction, so no row is ever
// visible through that API, not even between the copy and a later fix-up. With
// no policies, only the owning role (the one the hub connects as) can read or
// write; verification runs after RLS is on, which proves the hub still can.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { listExternalConnections, resolveExternalConnection } from "../server/db-connections.js";
import { postgresSchemaSql } from "../server/db-schema-postgres.js";

type Row = Record<string, unknown>;
type TablePlan = { table: string; key: string; rename?: Record<string, string> };

// Foreign-key order: every table comes after the tables it references.
// issues.parent_id references issues itself, so parents are linked in a second
// pass once every issue exists.
const plan: TablePlan[] = [
  { table: "teams", key: "id" },
  { table: "projects", key: "id" },
  { table: "agent_sessions", key: "id" },
  { table: "issues", key: "id" },
  { table: "comments", key: "id" },
  { table: "documents", key: "id" },
  { table: "issue_claims", key: "id" },
  { table: "context_bindings", key: "id" },
  { table: "project_updates", key: "id" },
  { table: "issue_dependencies", key: "id" },
  { table: "sync_runs", key: "id" },
  { table: "sync_checkpoints", key: "source" },
  // The SQLite migration ledger calls the column `name`; the Postgres schema
  // calls it `description` and requires it.
  { table: "schema_migrations", key: "id", rename: { name: "description" } },
];

const batchSize = 200;

class DryRunRollback extends Error {}

function usage() {
  process.stdout.write(`Claw Task Hub SQLite -> Postgres migration

Usage:
  bun run migrate:postgres -- --from <path/to/hub.sqlite> --to <connection id or name> [--dry-run] [--enable-row-level-security]

  --from     SQLite database to copy. Opened read-only; every table is read from one snapshot.
  --to       A connection registered in the database menu (Postgres or Supabase).
  --dry-run  Run the complete migration and its verification, then roll everything back.
  --enable-row-level-security
             Enable RLS on every hub table in the same transaction. Use it for any schema exposed
             over an HTTP API (for example Supabase's public schema); the connecting role must own
             the tables, as it does when this tool creates them.

The target must be empty. The copy is one transaction: it lands completely or not at all.
`);
}

function flag(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function resolveTargetConnection(reference: string) {
  const connections = listExternalConnections();
  const byId = connections.find((connection) => connection.id === reference);
  if (byId) return resolveExternalConnection(byId.id);
  const byName = connections.filter((connection) => connection.name === reference);
  if (byName.length === 1) return resolveExternalConnection(byName[0].id);
  if (byName.length > 1) throw new Error(`More than one connection is named "${reference}"; pass its id instead`);
  throw new Error(`No registered connection has the id or name "${reference}"`);
}

function toTargetRow(row: Row, entry: TablePlan): Row {
  const mapped: Row = {};
  for (const [column, value] of Object.entries(row)) {
    mapped[entry.rename?.[column] ?? column] = value ?? null;
  }
  if (entry.table === "schema_migrations" && mapped.description == null) mapped.description = mapped.id;
  return mapped;
}

// Engine-neutral content digest: rows ordered by key in JS (the two engines
// collate text differently) and values compared as text.
function digest(rows: Row[], key: string, columns: string[]) {
  const ordered = [...rows].sort((left, right) => {
    const a = String(left[key]);
    const b = String(right[key]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const hash = createHash("sha256");
  for (const row of ordered) {
    hash.update(JSON.stringify(columns.map((column) => (row[column] == null ? null : String(row[column])))));
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("help")) {
    usage();
    return;
  }
  const fromArg = flag(args, "--from");
  const toArg = flag(args, "--to");
  const dryRun = args.includes("--dry-run");
  const enableRowLevelSecurity = args.includes("--enable-row-level-security");
  if (!fromArg || !toArg) throw new Error("--from and --to are both required (see --help)");
  const fromPath = resolve(fromArg);
  if (!existsSync(fromPath)) throw new Error(`SQLite database not found: ${fromPath}`);
  const target = resolveTargetConnection(toArg);

  // --- read the source: one snapshot, then refuse anything that cannot land ---

  const source = new Database(fromPath, { readonly: true });
  const sourceRows = new Map<string, Row[]>();
  try {
    source.exec("BEGIN");
    const knownTables = new Set(plan.map((entry) => entry.table));
    const sourceTables = (source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
      .map((row) => row.name)
      .filter((name) => !name.startsWith("issue_fts"));
    for (const name of sourceTables) {
      if (knownTables.has(name)) continue;
      const count = (source.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n;
      if (count > 0) throw new Error(`Source table ${name} has ${count} rows and this tool has no place for it; nothing was copied`);
    }
    const violations = source.prepare("PRAGMA foreign_key_check").all() as { table: string; parent: string }[];
    if (violations.length > 0) {
      const summary = new Map<string, number>();
      for (const violation of violations) {
        const label = `${violation.table} -> ${violation.parent}`;
        summary.set(label, (summary.get(label) ?? 0) + 1);
      }
      throw new Error(`Source has ${violations.length} foreign-key violations Postgres would reject (${[...summary].map(([label, n]) => `${label}: ${n}`).join(", ")}); nothing was copied`);
    }
    for (const entry of plan) {
      const exists = sourceTables.includes(entry.table);
      sourceRows.set(entry.table, exists ? (source.prepare(`SELECT * FROM "${entry.table}"`).all() as Row[]).map((row) => toTargetRow(row, entry)) : []);
    }
    source.exec("COMMIT");
  } finally {
    source.close();
  }

  // --- write the target: one transaction -------------------------------------

  const sql = postgres(target.connectionString, {
    ssl: target.ssl ? "require" : false,
    max: 1,
    connect_timeout: 15,
    idle_timeout: 5,
    onnotice: () => undefined,
  });
  const report: Record<string, { rows: number; verified: boolean }> = {};
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(postgresSchemaSql);

      const targetColumns = new Map<string, Set<string>>();
      for (const row of await tx.unsafe(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND is_generated = 'NEVER'",
      ) as { table_name: string; column_name: string }[]) {
        if (!targetColumns.has(row.table_name)) targetColumns.set(row.table_name, new Set());
        targetColumns.get(row.table_name)!.add(row.column_name);
      }

      for (const entry of plan) {
        const [{ n }] = await tx.unsafe(`SELECT count(*)::int AS n FROM ${entry.table}`) as { n: number }[];
        if (n > 0) throw new Error(`Target table ${entry.table} already has ${n} rows; migrate only into an empty database. Nothing was copied`);
        const rows = sourceRows.get(entry.table)!;
        const columns = rows.length ? Object.keys(rows[0]) : [];
        const missing = columns.filter((column) => !targetColumns.get(entry.table)?.has(column));
        if (missing.length) throw new Error(`Target ${entry.table} has no column for ${missing.join(", ")}; those values would be lost. Nothing was copied`);
      }

      if (enableRowLevelSecurity) {
        // Before any row lands: nothing is ever readable through an exposed API.
        for (const entry of plan) await tx.unsafe(`ALTER TABLE ${entry.table} ENABLE ROW LEVEL SECURITY`);
        const unprotected = await tx.unsafe(
          `SELECT relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r' AND relname = ANY($1) AND NOT relrowsecurity`,
          [plan.map((entry) => entry.table)],
        ) as { relname: string }[];
        if (unprotected.length) throw new Error(`Row-level security did not take effect on ${unprotected.map((row) => row.relname).join(", ")}. Nothing was copied`);
      }

      for (const entry of plan) {
        const rows = sourceRows.get(entry.table)!;
        if (!rows.length) {
          report[entry.table] = { rows: 0, verified: true };
          continue;
        }
        const columns = Object.keys(rows[0]);
        const insertRows = entry.table === "issues" ? rows.map((row) => ({ ...row, parent_id: null })) : rows;
        for (let start = 0; start < insertRows.length; start += batchSize) {
          const batch = insertRows.slice(start, start + batchSize);
          await tx`INSERT INTO ${tx(entry.table)} ${tx(batch, ...columns)}`;
        }
        if (entry.table === "issues") {
          for (const row of rows.filter((candidate) => candidate.parent_id != null)) {
            await tx`UPDATE issues SET parent_id = ${row.parent_id as string} WHERE id = ${row.id as string}`;
          }
        }

        const copied = await tx.unsafe(`SELECT ${columns.join(", ")} FROM ${entry.table}`) as Row[];
        const verified = copied.length === rows.length && digest(copied, entry.key, columns) === digest(rows, entry.key, columns);
        if (!verified) throw new Error(`Verification failed for ${entry.table}: ${rows.length} source rows, ${copied.length} copied, contents ${copied.length === rows.length ? "differ" : "incomplete"}. Rolled back`);
        report[entry.table] = { rows: rows.length, verified };
      }

      if (dryRun) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }

  process.stdout.write(`${JSON.stringify({
    mode: dryRun ? "dry-run (rolled back)" : "committed",
    row_level_security: enableRowLevelSecurity ? "enabled on every hub table" : "not changed",
    from: fromPath,
    to: { id: target.summary.id, name: target.summary.name, target: target.summary.target },
    tables: report,
    total_rows: Object.values(report).reduce((sum, entry) => sum + entry.rows, 0),
  }, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
