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

## What this is not

Registering a Postgres/Supabase connection does **not** make it the live
application database. `server/store.ts` is the data-access layer behind every
issue, project, comment, and session in the app, and it is close to 100
synchronous calls through `bun:sqlite`. A Postgres client is asynchronous by
nature. Pointing the app's live reads and writes at Postgres/Supabase requires
porting that layer to an async, dialect-neutral store -- a larger, separate
piece of work that has not been done. There is deliberately no `/activate`
route for an external connection; see the comment in `server/db-connections.ts`
and `server/index.ts`.

Until that port happens, a registered connection is a place you can verify
Claw Task Hub can *reach* your database. Applying schema and running your own
migrations against it is on you, same as any other Postgres database.

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
