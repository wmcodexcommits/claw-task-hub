# External (Postgres/Supabase) Database Connections

Claw Task Hub's managed-database pipeline (`Create database` in the database
menu) can also register a Postgres-compatible connection alongside local
SQLite databases: plain Postgres, Supabase, Neon, RDS, CockroachDB, or
anything else that speaks the Postgres wire protocol.

## What this is

- A form, reachable from the same `Create database` flow as SQLite, with
  tabs for **SQLite**, **Postgres**, and **Supabase**.
- A local registry of connection targets (`data/.claw-task-hub-connections.json`,
  gitignored) that can be listed, test-pinged, and deleted from the database
  menu.
- Each registered database is independent. Creating one does not copy or
  migrate data from another; that is intentional, not a missing feature.

## Using a connection as the live database

A registered connection can be made the **active database**, exactly like a
local SQLite file: choose it under **External connections** in the database
menu (or call `activate_database` / `POST /api/databases/:id/activate` with the
id `external:<connection id>`). Projects, issues, comments, sessions, and claims
are then read and written in that Postgres database.

- **Schema.** Activation connects first and applies the Claw Task Hub schema
  (`server/db-schema-postgres.ts`, `CREATE ... IF NOT EXISTS`). A connection that
  cannot be reached is not activated; the current database stays live.
- **One active database for every client.** The selection is stored in the same
  active-database pointer as SQLite selections, so the UI server, the hub CLI,
  and the MCP server all use the selected connection. Processes that were
  already running pick it up when they restart; the one that performed the
  activation switches immediately.
- **Startup fallback.** A process that starts while a connection is selected but
  cannot reach it uses the local database it was selected from, and prints that
  on stderr. The selection is kept, so the next start tries the connection again.
- **Deletion.** The active connection cannot be deleted from the menu or the API;
  activate another database first. The local database it was selected from
  stays open as the fallback and cannot be deleted while it is open.
- **Independent data.** Activating a connection does not copy or migrate data
  from the local database. Seed or import into it the same way as any other
  Claw Task Hub database.

Postgres-specific notes:

- Issue search uses a generated `tsvector` column with
  `websearch_to_tsquery`, where SQLite uses fts5.
- Upserts that SQLite resolves with several `ON CONFLICT` clauses in one
  statement run on Postgres as a lookup of the matching key followed by a
  single-key upsert.
- Supabase's direct database host is IPv6-only. On an IPv4-only network use the
  **Session pooler** connection string instead.

## Moving an existing SQLite hub into a connection

`tools/migrate-sqlite-to-postgres.ts` is a standalone operator tool (not part
of the API, MCP server, or hub CLI) that copies a hub's SQLite history into a
registered connection:

```bash
bun run migrate:postgres -- --from path/to/claw-task-hub.sqlite --to <connection id or name> --dry-run
bun run migrate:postgres -- --from path/to/claw-task-hub.sqlite --to <connection id or name>
```

- The copy is one Postgres transaction covering schema, rows, and verification:
  it lands completely or not at all. `--dry-run` performs all of it, including
  verification, and rolls back.
- Every table is verified by row count and a content digest before commit.
- It refuses a target that already has rows, source rows that violate a foreign
  key, source columns the target has no column for, and non-empty source tables
  it does not know how to place.
- `--enable-row-level-security` enables RLS on every hub table inside the same
  transaction. Use it whenever the target schema is exposed over an HTTP API --
  Supabase publishes `public` to anyone with the project's anon key. With no
  policies, only the owning role (the one the hub connects as) can read or write.
- The source is opened read-only and read from one snapshot. Stop writers to it
  (or make sure the hub is not using it) before migrating, then activate the
  connection.

## Registering a connection

1. Open the database menu and choose `Create database`.
2. Switch to the **Postgres** or **Supabase** tab.
3. Give it a name, then provide the connection string one of two ways:
   - **Paste connection string** -- stored in `data/.claw-task-hub-connections.json`.
     That file is gitignored, but it is still a local file containing a
     credential; back up and share this folder accordingly.
   - **Use an environment variable** -- only the variable's *name* is stored;
     the value stays in your own environment (a local `.env`, which is
     gitignored -- never `.env.example`) and is read at connection time. Set
     it before testing the connection.
4. Leave `Require TLS` checked unless you know the target doesn't use it.
   Supabase requires TLS.
5. Save, then use the test button (the refresh icon next to the entry in the
   database menu) to confirm Claw Task Hub can actually reach it.

## Finding a Supabase connection string

In the Supabase dashboard: **Project Settings -> Database -> Connection
string**. Either the direct connection or the pooled (pgbouncer) connection
string works for a test ping; pick whichever your own tooling will use once
you connect application code to it.

## Secrets

Do not paste a connection string into an issue, comment, doc, test fixture,
or screenshot -- the same rule this repo already applies to every other
secret. Prefer the environment-variable mode if you want the credential to
never touch a file this app writes.
