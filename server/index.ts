import cors from "cors";
import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { activateManagedDatabase, createManagedDatabase, databaseIdFromName, dbPath, deleteManagedDatabase, listManagedDatabases } from "./db.js";
import { dataSnapshot } from "./data-snapshot.js";
import {
  dashboard,
  deleteContextBinding,
  ensureDefaultTeam,
  getContextBinding,
  getIssue,
  getProject,
  listContextBindings,
  listIssueDependencies,
  listIssueGroups,
  listIssues,
  listProjects,
  listProjectUpdates,
  listTeams,
  parseIssueDisplayLimit,
  recentSyncRuns,
  resolveContextProject,
  resolveIssueDependency,
  saveComment,
  saveIssueDependency,
  saveProjectUpdate,
  upsertContextBinding,
  upsertIssue,
  upsertProject,
} from "./store.js";

ensureDefaultTeam();

const app = express();
const execFileAsync = promisify(execFile);
const databasePickerScript = fileURLToPath(new URL("./select-database-path.py", import.meta.url));
let databasePickerActive = false;

const port = Number(process.env.PORT ?? 4781);
const host = process.env.CLAW_TASK_HUB_HOST ?? "127.0.0.1";
const unsafeBind = process.env.CLAW_TASK_HUB_UNSAFE_BIND === "1";
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopbackHost(value: string) {
  return loopbackHosts.has(value) || value.startsWith("127.");
}

if (!isLoopbackHost(host) && !unsafeBind) {
  console.error(`Refusing to bind Claw Task Hub API to ${host}. Set CLAW_TASK_HUB_UNSAFE_BIND=1 only for an explicitly secured non-local deployment.`);
  process.exit(1);
}

const allowedOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://[::1]:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://[::1]:4173",
  ...String(process.env.CLAW_TASK_HUB_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS origin not allowed: ${origin}`));
  },
}));
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, dbPath, mode: "local", host });
});

app.get("/api/databases", (_req, res) => res.json(listManagedDatabases()));
app.post("/api/filesystem/database-path", async (req, res) => {
  const schema = z.object({ name: z.string().trim().min(1).max(80).optional() });
  if (databasePickerActive) return res.status(409).json({ error: "A database location picker is already open" });
  databasePickerActive = true;
  try {
    const value = schema.parse(req.body);
    const suggestedName = databaseIdFromName(value.name ?? "claw-task-hub");
    const { stdout } = await execFileAsync("python3", [databasePickerScript, suggestedName], {
      timeout: 300_000,
      maxBuffer: 64 * 1024,
    });
    const result = JSON.parse(stdout.trim()) as { path?: string; cancelled?: boolean; error?: string };
    if (result.error) return res.status(503).json({ error: result.error });
    res.json(result.path ? { path: result.path } : { cancelled: true });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    databasePickerActive = false;
  }
});
app.post("/api/databases", (req, res) => {
  const schema = z.object({
    name: z.string().trim().min(1).max(80),
    path: z.string().trim().max(4096).optional(),
  });
  try {
    const value = schema.parse(req.body);
    const catalogue = createManagedDatabase(value.name, value.path);
    ensureDefaultTeam();
    res.status(201).json(catalogue);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/api/databases/:id/activate", (req, res) => {
  try {
    const catalogue = activateManagedDatabase(req.params.id);
    ensureDefaultTeam();
    res.json(catalogue);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.delete("/api/databases/:id", (req, res) => {
  try {
    res.json(deleteManagedDatabase(req.params.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("Database not found:") ? 404 : message.startsWith("The active database") ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

app.get("/api/snapshot", (req, res) => res.json(dataSnapshot(req.query)));
app.post("/api/refresh", (req, res) => res.json(dataSnapshot(req.body)));

app.get("/api/dashboard", (_req, res) => res.json(dashboard()));
app.get("/api/sync-runs", (_req, res) => res.json({ runs: recentSyncRuns() }));
app.get("/api/teams", (_req, res) => res.json({ teams: listTeams() }));
app.get("/api/projects", (_req, res) => res.json({ projects: listProjects() }));
app.get("/api/context-bindings", (req, res) => {
  res.json({
    bindings: listContextBindings({
      context_key: req.query.context_key as string | undefined,
      project_id: req.query.project_id as string | undefined,
      harness: req.query.harness as string | undefined,
      cwd: req.query.cwd as string | undefined,
      repo_remote: req.query.repo_remote as string | undefined,
      branch: req.query.branch as string | undefined,
      thread_id: req.query.thread_id as string | undefined,
      limit: req.query.limit as string | undefined,
    }),
  });
});
app.get("/api/context-bindings/resolve", (req, res) => {
  res.json(resolveContextProject({
    context_key: req.query.context_key as string | undefined,
    project_id: req.query.project_id as string | undefined,
    harness: req.query.harness as string | undefined,
    cwd: req.query.cwd as string | undefined,
    repo_remote: req.query.repo_remote as string | undefined,
    branch: req.query.branch as string | undefined,
    thread_id: req.query.thread_id as string | undefined,
  }));
});
app.get("/api/context-bindings/:id", (req, res) => {
  const binding = getContextBinding(req.params.id);
  if (!binding) return res.status(404).json({ error: "Context binding not found" });
  res.json({ binding });
});
app.post("/api/context-bindings", (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    context_key: z.string().min(1),
    project_id: z.string().min(1),
    default_tab: z.enum(["overview", "activity", "issues"]).optional(),
    harness: z.string().nullable().optional(),
    workspace_name: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    repo_remote: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    thread_id: z.string().nullable().optional(),
    metadata: z.unknown().optional(),
    source: z.string().optional(),
  });
  try {
    res.json({ binding: upsertContextBinding(schema.parse(req.body)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});
app.delete("/api/context-bindings/:id", (req, res) => res.json(deleteContextBinding({ id: req.params.id })));
app.get("/api/projects/:id", (req, res) => {
  const project = getProject(req.params.id, { issues_per_status: req.query.issues_per_status });
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json(project);
});

app.post("/api/projects", (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    external_id: z.string().optional(),
    name: z.string().min(1).optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    priority: z.number().int().min(0).max(4).optional(),
    lead: z.string().nullable().optional(),
    target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    source: z.string().optional(),
    archived_at: z.string().nullable().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  }).superRefine((value, ctx) => {
    if (!value.id && !value.external_id && !value.name) {
      ctx.addIssue({ code: "custom", path: ["name"], message: "name is required when creating a project" });
    }
  });
  res.json({ project: upsertProject(schema.parse(req.body)) });
});

app.get("/api/projects/:id/updates", (req, res) => {
  res.json({ updates: listProjectUpdates({ project_id: req.params.id, limit: req.query.limit as string | undefined }) });
});

app.post("/api/projects/:id/updates", (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    external_id: z.string().optional(),
    body: z.string().min(1).max(10000),
    health: z.enum(["on_track", "at_risk", "off_track", "complete"]).optional(),
    author: z.string().optional(),
  });
  res.json({ update: saveProjectUpdate({ ...schema.parse(req.body), project_id: req.params.id }) });
});

app.get("/api/issues", (req, res) => {
  const filters = {
    project: req.query.project as string | undefined,
    project_id: req.query.project_id as string | undefined,
    team: req.query.team as string | undefined,
    team_id: req.query.team_id as string | undefined,
    status: req.query.status as string | undefined,
    status_type: req.query.status_type as string | undefined,
    include_done: req.query.include_done as string | undefined,
    blocked: req.query.blocked as string | undefined,
    query: req.query.query as string | undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    offset: req.query.offset ? Number(req.query.offset) : undefined,
  };
  if (req.query.per_status_limit) {
    const issueDisplayLimit = parseIssueDisplayLimit(req.query.per_status_limit);
    const issueGroups = listIssueGroups(filters, issueDisplayLimit);
    res.json({
      issues: issueGroups.flatMap((group) => group.issues),
      issueGroups,
      issueDisplayLimit,
    });
    return;
  }
  res.json({ issues: listIssues(filters) });
});

app.get("/api/issues/:id", (req, res) => {
  const issue = getIssue(req.params.id);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  res.json({ issue });
});

app.post("/api/issues", (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    external_id: z.string().optional(),
    identifier: z.string().optional(),
    issue_id: z.string().optional(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    status_type: z.string().optional(),
    priority: z.number().int().min(0).max(4).optional(),
    project_id: z.string().nullable().optional(),
    allow_no_project: z.boolean().optional(),
    team_id: z.string().nullable().optional(),
    assignee: z.string().nullable().optional(),
    labels: z.array(z.string()).optional(),
  // Unknown keys must REACH upsertIssue's guard. Stripping them here is the same silent
  // discard the guard exists to stop — over HTTP, `state` would vanish before any check.
  }).passthrough().superRefine((value, ctx) => {
    if (!value.id && !value.external_id && !value.identifier && !value.issue_id && !value.title) {
      ctx.addIssue({ code: "custom", path: ["title"], message: "title is required when creating an issue" });
    }
  });
  try {
    res.json({ issue: upsertIssue(schema.parse(req.body)) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/issues/:id/comments", (req, res) => {
  const issue = getIssue(req.params.id);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  const schema = z.object({ body: z.string().min(1), author: z.string().optional() });
  res.json({ comment: saveComment({ ...schema.parse(req.body), issue_id: (issue as unknown as { id: string }).id }) });
});

app.get("/api/issues/:id/dependencies", (req, res) => {
  res.json({
    dependencies: listIssueDependencies({
      issue_id: req.params.id,
      include_resolved: req.query.include_resolved as string | undefined,
      limit: req.query.limit as string | undefined,
    }),
  });
});

app.post("/api/issues/:id/dependencies", (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    external_id: z.string().optional(),
    blocker_issue_id: z.string().min(1),
    reason: z.string().max(2000).optional(),
  });
  try {
    res.json({ dependency: saveIssueDependency({ ...schema.parse(req.body), issue_id: req.params.id }) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/issue-dependencies/:id/resolve", (req, res) => {
  try {
    res.json(resolveIssueDependency({ dependency_id: req.params.id }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// express fires this callback even when the bind FAILED (verified: on
// EADDRINUSE it runs with server.listening === false), so an unguarded log
// here announces a success that did not happen, one line before the error.
const server = app.listen(port, host, () => {
  if (!server.listening) return;
  console.log(`Claw Task Hub API listening on http://${host}:${port}`);
});

// A launcher that loses the port must SAY SO.
//
// app.listen had no error handler, so EADDRINUSE surfaced as an uncaught
// exception and was easily lost under concurrently. A manual `npm run dev`
// started while the systemd service held 4781 died without a visible error,
// and the already-running service went on answering with six-hour-old code
// while the files on disk were edited three times. Nothing in the UI or the
// API could show that, because the API was the stale thing.
server.on("error", async (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE") {
    console.error(`Claw Task Hub API failed to start: ${error.message}`);
    process.exit(1);
  }

  console.error(`Claw Task Hub API cannot start: ${host}:${port} is already in use.`);

  // Say WHAT holds it, where that is answerable. Another instance of this
  // server identifies itself and names the database it is serving — which is
  // the fact that matters, because a second instance on a different database
  // is a different failure from a stale instance on the same one.
  try {
    const response = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const health = (await response.json()) as { ok?: boolean; dbPath?: string };
    if (health?.ok) {
      console.error(
        `A Claw Task Hub instance is already running there, serving ${health.dbPath}.`);
      console.error(
        "If it is the systemd user service, restart it rather than starting a second one:");
      console.error("  systemctl --user restart claw-task-hub.service");
      console.error(
        "Note that a running server keeps the code it started with — restart it after editing server/.");
    } else {
      console.error("Something is listening there, but it is not a Claw Task Hub API.");
    }
  } catch {
    console.error(
      "Something is listening there and did not answer /api/health. Set PORT to use a different port.");
  }
  process.exit(1);
});
