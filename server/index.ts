import cors from "cors";
import express from "express";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { activateDatabase, activeDatabaseLabel, activeExternalConnectionId, createManagedDatabase, databaseIdFromName, dbPath, deleteManagedDatabase, getManagedDatabase, listManagedDatabases, onActiveDatabaseChange, openExternalListenerClient } from "./db.js";
import { deleteExternalConnection, listExternalConnections, registerExternalConnection, testExternalConnection } from "./db-connections.js";
import { createDataChangeRelay, type DataChangeRelay } from "./data-change-relay.js";
import { dataSnapshot } from "./data-snapshot.js";
import {
  dashboard,
  deleteIssue,
  deleteProject,
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
  updateIssue,
  updateProject,
  upsertContextBinding,
  upsertIssue,
  upsertProject,
} from "./store.js";
import { ExecutionAttemptError, getExecutionAttempt, listExecutionAttempts, transitionExecutionAttempt } from "./execution-attempts.js";
import {
  decideExecutionConflict,
  declareExecutionPaths,
  detectExecutionConflicts,
  ExecutionConflictError,
  getConflictPolicy,
  getExecutionConflict,
  getExecutionPathDeclaration,
  listExecutionConflicts,
  saveConflictPolicy,
} from "./execution-conflicts.js";
import {
  acceptExecutionAttempt,
  ExecutionAcceptanceError,
  getAcceptancePolicy,
  getExecutionAcceptance,
  listExecutionAcceptances,
  rejectExecutionAttempt,
  saveAcceptancePolicy,
} from "./execution-acceptance.js";
import { listExecutionProviders } from "./execution-providers.js";
import {
  ExecutionReconciliationError,
  getReconciliationRun,
  listReconciliationRuns,
  quarantineExecutionAttempt,
  reconcileExecution,
  startReconciliationLoop,
} from "./execution-reconciliation.js";
import { ExecutionContractError } from "./execution-contract.js";
import {
  captureExecutionDiff,
  ExecutionEvidenceError,
  getExecutionEvidence,
  getVerificationPolicy,
  listExecutionEvidence,
  recordExecutionEvidence,
  saveVerificationPolicy,
  verifyExecutionAttempt,
} from "./execution-evidence.js";
import {
  ExecutionWorkspaceError,
  getExecutionWorkspace,
  listExecutionWorkspaces,
  planExecutionWorkspace,
  provisionExecutionWorkspace,
  releaseExecutionWorkspace,
  renewExecutionWorkspace,
  startExecutionAttempt,
} from "./execution-workspaces.js";
import { listExecutionAdapters } from "./execution-adapters.js";
import { IssueRunnabilityError, listRunnableIssues } from "./issue-runnability.js";
import { ExecutionRunError } from "./execution-runs.js";
import { launchAndReport } from "./tool-dispatch.js";
import { APP_VERSION } from "./version.js";

await ensureDefaultTeam();

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

const refreshClients = new Set<express.Response>();

// One change often arrives as several signals: this API's own mutation, an MCP
// process posting to /events/refresh, and the Postgres notification for the same
// commit. They are coalesced so a UI re-reads once per burst instead of once per
// signal. The window bounds the added latency and is never extended, so a steady
// stream of writes cannot postpone a refresh indefinitely.
const refreshCoalesceMs = 100;
let pendingRefresh: ReturnType<typeof setTimeout> | null = null;

function broadcastRefresh() {
  if (pendingRefresh) return;
  pendingRefresh = setTimeout(() => {
    pendingRefresh = null;
    for (const client of refreshClients) client.write("event: data-refresh\ndata: {}\n\n");
  }, refreshCoalesceMs);
}

// Writes made by hubs in other processes or on other machines reach this
// server's UIs through Postgres notifications (server/data-change-relay.ts).
// The relay follows whichever external connection is active; a SQLite database
// has no other writers to hear from, so none runs then.
let dataChangeRelay: { connectionId: string; relay: DataChangeRelay } | null = null;

function followActiveDatabase() {
  const connectionId = activeExternalConnectionId();
  if (dataChangeRelay?.connectionId === connectionId) return;
  void dataChangeRelay?.relay.stop();
  dataChangeRelay = null;
  if (!connectionId) return;
  dataChangeRelay = {
    connectionId,
    relay: createDataChangeRelay({
      connect: () => openExternalListenerClient(connectionId),
      onChange: broadcastRefresh,
    }),
  };
}

onActiveDatabaseChange(followActiveDatabase);
followActiveDatabase();

app.get("/api/events", (req, res) => {
  res.set({
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
  });
  res.flushHeaders();
  res.write("event: connected\ndata: {}\n\n");
  refreshClients.add(res);
  req.on("close", () => refreshClients.delete(res));
});

app.post("/api/events/refresh", (_req, res) => {
  broadcastRefresh();
  res.status(204).end();
});

app.use("/api", (req, res, next) => {
  const signalsMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !["/refresh", "/events/refresh"].includes(req.path);
  if (signalsMutation) {
    res.once("finish", () => {
      if (res.statusCode < 400) broadcastRefresh();
    });
  }
  next();
});

const projectInputSchema = z.object({
  id: z.string().optional(),
  external_id: z.string().optional(),
  name: z.string().min(1).optional(),
  summary: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  status: z.string().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  lead: z.string().nullable().optional(),
  target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  source: z.string().optional(),
  archived_at: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

const issueInputSchema = z.object({
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
  parent_id: z.string().nullable().optional(),
  assignee: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  source: z.string().optional(),
  url: z.string().nullable().optional(),
  archived_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
// Unknown keys must reach upsertIssue's precise field guard instead of being stripped.
}).passthrough();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, dbPath, database: activeDatabaseLabel(), mode: "local", host, version: APP_VERSION });
});

app.get("/api/databases", (_req, res) => res.json(listManagedDatabases()));
app.get("/api/databases/:id", (req, res) => {
  const database = getManagedDatabase(req.params.id);
  if (!database) return res.status(404).json({ error: "Database not found" });
  res.json({ database });
});
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
app.post("/api/databases", async (req, res) => {
  const schema = z.object({
    name: z.string().trim().min(1).max(80),
    path: z.string().trim().max(4096).optional(),
  });
  try {
    const value = schema.parse(req.body);
    const catalogue = createManagedDatabase(value.name, value.path);
    await ensureDefaultTeam();
    res.status(201).json(catalogue);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/api/databases/:id/activate", async (req, res) => {
  try {
    const catalogue = await activateDatabase(req.params.id);
    await ensureDefaultTeam();
    res.json(catalogue);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.patch("/api/databases/:id", async (req, res) => {
  const schema = z.object({ active: z.literal(true) });
  try {
    schema.parse(req.body);
    res.json(await activateDatabase(req.params.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.startsWith("Database not found:") ? 404 : 400).json({ error: message });
  }
});
app.delete("/api/databases/:id", (req, res) => {
  const schema = z.object({ confirm: z.literal(true) });
  try {
    const value = schema.parse(req.body);
    res.json(deleteManagedDatabase(req.params.id, value.confirm));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("Database not found:") ? 404 : message.startsWith("The active database") ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

// External (Postgres/Supabase) connections are registered and testable here.
// Activation goes through the same /api/databases/:id/activate route as SQLite,
// with the id "external:<connection id>", so there is one activation path and
// one notion of "active" for every client.
app.get("/api/db-connections", (_req, res) => res.json({ connections: listExternalConnections() }));
app.post("/api/db-connections", (req, res) => {
  const schema = z.object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(["postgres", "supabase"]),
    connectionString: z.string().trim().min(1).max(4096).optional(),
    connectionStringEnv: z.string().trim().min(1).max(200).optional(),
    ssl: z.boolean().optional(),
  });
  try {
    const value = schema.parse(req.body);
    const connection = registerExternalConnection(value);
    res.status(201).json({ connection });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/api/db-connections/:id/test", async (req, res) => {
  try {
    const result = await testExternalConnection(req.params.id);
    res.status(result.ok ? 200 : 502).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.startsWith("Connection not found:") ? 404 : 400).json({ error: message });
  }
});
app.delete("/api/db-connections/:id", (req, res) => {
  const schema = z.object({ confirm: z.literal(true) });
  try {
    const value = schema.parse(req.body);
    if (activeExternalConnectionId() === req.params.id) {
      return res.status(409).json({ error: "The active database cannot be deleted. Activate another database first." });
    }
    res.json({ connections: deleteExternalConnection(req.params.id, value.confirm) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("Connection not found:") ? 404 : 400;
    res.status(status).json({ error: message });
  }
});

app.get("/api/snapshot", async (req, res) => res.json(await dataSnapshot(req.query)));
app.post("/api/refresh", async (req, res) => res.json(await dataSnapshot(req.body)));

app.get("/api/dashboard", async (_req, res) => res.json(await dashboard()));
app.get("/api/sync-runs", async (_req, res) => res.json({ runs: await recentSyncRuns() }));
app.get("/api/teams", async (_req, res) => res.json({ teams: await listTeams() }));
app.get("/api/projects", async (_req, res) => res.json({ projects: await listProjects() }));
app.get("/api/context-bindings", async (req, res) => {
  res.json({
    bindings: await listContextBindings({
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
app.get("/api/context-bindings/resolve", async (req, res) => {
  res.json(await resolveContextProject({
    context_key: req.query.context_key as string | undefined,
    project_id: req.query.project_id as string | undefined,
    harness: req.query.harness as string | undefined,
    cwd: req.query.cwd as string | undefined,
    repo_remote: req.query.repo_remote as string | undefined,
    branch: req.query.branch as string | undefined,
    thread_id: req.query.thread_id as string | undefined,
  }));
});
app.get("/api/context-bindings/:id", async (req, res) => {
  const binding = await getContextBinding(req.params.id);
  if (!binding) return res.status(404).json({ error: "Context binding not found" });
  res.json({ binding });
});
app.post("/api/context-bindings", async (req, res) => {
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
    res.json({ binding: await upsertContextBinding(schema.parse(req.body)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});
app.delete("/api/context-bindings/:id", async (req, res) => res.json(await deleteContextBinding({ id: req.params.id })));
app.get("/api/projects/:id", async (req, res) => {
  const project = await getProject(req.params.id, { issues_per_status: req.query.issues_per_status });
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json(project);
});

app.post("/api/projects", async (req, res) => {
  const schema = projectInputSchema.superRefine((value, ctx) => {
    if (!value.id && !value.external_id && !value.name) {
      ctx.addIssue({ code: "custom", path: ["name"], message: "name is required when creating a project" });
    }
  });
  try {
    res.status(201).json({ project: await upsertProject(schema.parse(req.body)) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.patch("/api/projects/:id", async (req, res) => {
  try {
    const value = projectInputSchema.parse(req.body);
    delete value.id;
    res.json({ project: await updateProject(req.params.id, value) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.startsWith("Project not found:") ? 404 : 400).json({ error: message });
  }
});

app.delete("/api/projects/:id", async (req, res) => {
  const schema = z.object({ confirm: z.literal(true), delete_issues: z.boolean().optional(), force: z.boolean().optional() });
  try {
    res.json(await deleteProject({ id: req.params.id, ...schema.parse(req.body) }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.startsWith("Project not found:") ? 404 : message.includes("active issue claim") || message.includes("has ") ? 409 : 400).json({ error: message });
  }
});

app.get("/api/projects/:id/updates", async (req, res) => {
  res.json({ updates: await listProjectUpdates({ project_id: req.params.id, limit: req.query.limit as string | undefined }) });
});

app.post("/api/projects/:id/updates", async (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    external_id: z.string().optional(),
    body: z.string().min(1).max(10000),
    health: z.enum(["on_track", "at_risk", "off_track", "complete"]).optional(),
    author: z.string().optional(),
  });
  res.json({ update: await saveProjectUpdate({ ...schema.parse(req.body), project_id: req.params.id }) });
});

app.get("/api/issues", async (req, res) => {
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
    const issueGroups = await listIssueGroups(filters, issueDisplayLimit);
    res.json({
      issues: issueGroups.flatMap((group) => group.issues),
      issueGroups,
      issueDisplayLimit,
    });
    return;
  }
  res.json({ issues: await listIssues(filters) });
});

app.get("/api/issues/:id", async (req, res) => {
  const issue = await getIssue(req.params.id);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  res.json({ issue });
});

app.post("/api/issues", async (req, res) => {
  const schema = issueInputSchema.superRefine((value, ctx) => {
    if (!value.id && !value.external_id && !value.identifier && !value.issue_id && !value.title) {
      ctx.addIssue({ code: "custom", path: ["title"], message: "title is required when creating an issue" });
    }
  });
  try {
    res.json({ issue: await upsertIssue(schema.parse(req.body)) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.patch("/api/issues/:id", async (req, res) => {
  try {
    const value = issueInputSchema.parse(req.body);
    delete value.id;
    delete value.issue_id;
    res.json({ issue: await updateIssue(req.params.id, value) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.startsWith("Issue not found:") ? 404 : 400).json({ error: message });
  }
});

app.delete("/api/issues/:id", async (req, res) => {
  const schema = z.object({ confirm: z.literal(true), force: z.boolean().optional() });
  try {
    res.json(await deleteIssue({ id: req.params.id, ...schema.parse(req.body) }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const guarded = message.includes("active claim") || message.includes("live execution attempt");
    res.status(message.startsWith("Issue not found:") ? 404 : guarded ? 409 : 400).json({ error: message });
  }
});

app.post("/api/issues/:id/comments", async (req, res) => {
  const issue = await getIssue(req.params.id);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  const schema = z.object({ body: z.string().min(1), author: z.string().optional() });
  res.json({ comment: await saveComment({ ...schema.parse(req.body), issue_id: (issue as unknown as { id: string }).id }) });
});

app.get("/api/issues/:id/dependencies", async (req, res) => {
  res.json({
    dependencies: await listIssueDependencies({
      issue_id: req.params.id,
      include_resolved: req.query.include_resolved as string | undefined,
      limit: req.query.limit as string | undefined,
    }),
  });
});

app.post("/api/issues/:id/dependencies", async (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    external_id: z.string().optional(),
    blocker_issue_id: z.string().min(1),
    reason: z.string().max(2000).optional(),
  });
  try {
    res.json({ dependency: await saveIssueDependency({ ...schema.parse(req.body), issue_id: req.params.id }) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/issue-dependencies/:id/resolve", async (req, res) => {
  try {
    res.json(await resolveIssueDependency({ dependency_id: req.params.id }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Execution attempts and workspaces. Typed failures carry their code and details
// in the body, so HTTP callers branch on the same codes CLI and MCP callers read
// from the message.
const executionNotFoundCodes = new Set([
  "issue_not_found",
  "attempt_not_found",
  "lease_not_found",
  "policy_not_found",
  "evidence_not_found",
  "project_not_found",
  "team_not_found",
  "conflict_not_found",
  "acceptance_not_found",
  "run_not_found",
]);
const executionConflictCodes = new Set([
  "live_attempt_exists",
  "idempotency_conflict",
  "resource_conflict",
  "revision_conflict",
  "terminal_state",
  "attempt_not_provisioning",
  "attempt_terminal",
  "branch_exists",
  "worktree_path_exists",
  "lease_conflict",
  "lease_expired",
  "lease_not_active",
  "base_drift",
  "workspace_inconsistent",
  "attempt_not_launchable",
  "attempt_not_verifying",
  "workspace_not_ready",
  "policy_conflict",
  "conflict_blocked",
  "invalid_decision",
  "attempt_not_reviewable",
  "acceptance_in_progress",
  "verification_missing",
  "verification_stale",
  "nothing_to_commit",
  "merge_target_missing",
  "merge_target_checked_out",
  "merge_target_moved",
  "reconciliation_in_progress",
]);

function executionFailureStatus(code: string) {
  if (executionNotFoundCodes.has(code) || code === "adapter_unknown") return 404;
  if (code === "unauthorized_actor") return 403;
  if (executionConflictCodes.has(code)) return 409;
  if (code === "adapter_unavailable" || code === "provider_unavailable") return 503;
  if (code === "push_rejected" || code === "provider_failed") return 502;
  if (code === "git_failed" || code === "launch_failed") return 500;
  return 400;
}

function sendExecutionFailure(res: express.Response, error: unknown) {
  if (
    error instanceof ExecutionAttemptError
    || error instanceof ExecutionContractError
    || error instanceof ExecutionWorkspaceError
    || error instanceof ExecutionRunError
    || error instanceof ExecutionEvidenceError
    || error instanceof IssueRunnabilityError
    || error instanceof ExecutionConflictError
    || error instanceof ExecutionAcceptanceError
    || error instanceof ExecutionReconciliationError
  ) {
    res.status(executionFailureStatus(error.code)).json({ error: error.message, code: error.code, details: error.details });
    return;
  }
  res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
}

app.get("/api/execution-providers", (_req, res) => {
  res.json({ providers: listExecutionProviders() });
});

app.get("/api/acceptance-policies", async (req, res) => {
  try {
    res.json(await getAcceptancePolicy(req.query));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/acceptance-policies", async (req, res) => {
  try {
    res.status(201).json(await saveAcceptancePolicy(req.body ?? {}));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/execution-attempts/:id/accept", async (req, res) => {
  try {
    res.json(await acceptExecutionAttempt({ ...(req.body ?? {}), attempt_id: req.params.id }));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/execution-attempts/:id/reject", async (req, res) => {
  try {
    res.json(await rejectExecutionAttempt({ ...(req.body ?? {}), attempt_id: req.params.id }));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/execution-attempts/:id/acceptances", async (req, res) => {
  try {
    res.json({ acceptances: await listExecutionAcceptances({ attempt_id: req.params.id }) });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/execution-acceptances/:id", async (req, res) => {
  try {
    const found = await getExecutionAcceptance(req.params.id);
    if (!found) {
      res.status(404).json({ error: `acceptance_not_found: Acceptance not found: ${req.params.id}`, code: "acceptance_not_found", details: { acceptance_id: req.params.id } });
      return;
    }
    res.json({ acceptance: found });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/execution-reconciliation", async (req, res) => {
  try {
    res.json({ run: await reconcileExecution({ ...(req.body ?? {}), trigger: "manual" }) });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/execution-reconciliation/runs", async (req, res) => {
  try {
    res.json({ runs: await listReconciliationRuns(req.query) });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/execution-reconciliation/runs/:id", async (req, res) => {
  try {
    res.json({ run: await getReconciliationRun(req.params.id) });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/execution-attempts/:id/quarantine", async (req, res) => {
  try {
    res.json(await quarantineExecutionAttempt({ ...(req.body ?? {}), attempt_id: req.params.id }));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/runnable-issues", async (req, res) => {
  try {
    res.json(await listRunnableIssues(req.query));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/issues/:id/execution-paths", async (req, res) => {
  try {
    res.json(await getExecutionPathDeclaration({ ...req.query, issue_id: req.params.id }));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/issues/:id/execution-paths", async (req, res) => {
  try {
    res.status(201).json(await declareExecutionPaths({ ...(req.body ?? {}), issue_id: req.params.id }));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/conflict-policies", async (req, res) => {
  try {
    res.json(await getConflictPolicy(req.query));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/conflict-policies", async (req, res) => {
  try {
    res.status(201).json(await saveConflictPolicy(req.body ?? {}));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/execution-conflicts/detect", async (req, res) => {
  try {
    res.json(await detectExecutionConflicts(req.body ?? {}));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/execution-conflicts", async (req, res) => {
  try {
    res.json({ conflicts: await listExecutionConflicts(req.query) });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/execution-conflicts/:id", async (req, res) => {
  try {
    const conflict = await getExecutionConflict(req.params.id);
    if (!conflict) {
      res.status(404).json({ error: `conflict_not_found: Execution conflict not found: ${req.params.id}`, code: "conflict_not_found", details: { conflict_id: req.params.id } });
      return;
    }
    res.json({ conflict });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/execution-conflicts/:id/decisions", async (req, res) => {
  try {
    res.status(201).json(await decideExecutionConflict({ ...(req.body ?? {}), conflict_id: req.params.id }));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/execution-adapters", (_req, res) => {
  res.json({ adapters: listExecutionAdapters() });
});

app.post("/api/execution-attempts/:id/launch", async (req, res) => {
  try {
    res.json(await launchAndReport({ ...(req.body ?? {}), attempt_id: req.params.id }));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/execution-attempts", async (req, res) => {
  try {
    res.json({ attempts: await listExecutionAttempts(req.query) });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/execution-attempts/:id", async (req, res) => {
  try {
    const attempt = await getExecutionAttempt(req.params.id);
    if (!attempt) {
      res.status(404).json({ error: `attempt_not_found: Execution attempt not found: ${req.params.id}`, code: "attempt_not_found", details: { attempt_id: req.params.id } });
      return;
    }
    res.json({ attempt });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/execution-attempts/:id/transitions", async (req, res) => {
  try {
    res.json(await transitionExecutionAttempt({ ...(req.body ?? {}), attempt_id: req.params.id }));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/issues/:id/execution-attempts", async (req, res) => {
  try {
    res.json({ attempts: await listExecutionAttempts({ ...req.query, issue_id: req.params.id }) });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/issues/:id/execution-attempts", async (req, res) => {
  try {
    const result = await startExecutionAttempt({ ...(req.body ?? {}), issue_id: req.params.id });
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/execution-attempts/:id/workspace/plan", async (req, res) => {
  try {
    res.json({ plan: await planExecutionWorkspace({ ...(req.body ?? {}), attempt_id: req.params.id }) });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/execution-attempts/:id/workspace", async (req, res) => {
  try {
    const result = await provisionExecutionWorkspace({ ...(req.body ?? {}), attempt_id: req.params.id });
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/execution-workspaces", async (req, res) => {
  try {
    res.json({ workspaces: await listExecutionWorkspaces(req.query) });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/execution-workspaces/:id", async (req, res) => {
  try {
    const workspace = await getExecutionWorkspace(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: `lease_not_found: Workspace lease not found: ${req.params.id}`, code: "lease_not_found", details: { lease_id: req.params.id } });
      return;
    }
    res.json({ workspace });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/execution-workspaces/:id/renew", async (req, res) => {
  try {
    res.json({ workspace: await renewExecutionWorkspace({ ...(req.body ?? {}), id: req.params.id }) });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/execution-workspaces/:id/release", async (req, res) => {
  try {
    res.json(await releaseExecutionWorkspace({ ...(req.body ?? {}), id: req.params.id }));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/verification-policies", async (req, res) => {
  try {
    res.json(await getVerificationPolicy(req.query));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/verification-policies", async (req, res) => {
  try {
    res.status(201).json(await saveVerificationPolicy(req.body ?? {}));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/execution-attempts/:id/diff", async (req, res) => {
  try {
    res.status(201).json(await captureExecutionDiff({ ...(req.body ?? {}), attempt_id: req.params.id }));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/execution-attempts/:id/evidence", async (req, res) => {
  try {
    res.json({ evidence: await listExecutionEvidence({ ...req.query, attempt_id: req.params.id }) });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/execution-attempts/:id/evidence", async (req, res) => {
  try {
    res.status(201).json(await recordExecutionEvidence({ ...(req.body ?? {}), attempt_id: req.params.id }));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.post("/api/execution-attempts/:id/verify", async (req, res) => {
  try {
    res.json(await verifyExecutionAttempt({ ...(req.body ?? {}), attempt_id: req.params.id }));
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

app.get("/api/execution-evidence/:id", async (req, res) => {
  try {
    const evidence = await getExecutionEvidence(req.params.id);
    if (!evidence) {
      res.status(404).json({ error: `evidence_not_found: Execution evidence not found: ${req.params.id}`, code: "evidence_not_found", details: { evidence_id: req.params.id } });
      return;
    }
    res.json({ evidence });
  } catch (error) {
    sendExecutionFailure(res, error);
  }
});

if (process.env.CLAW_TASK_HUB_SERVE_UI === "1") {
  const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
  const indexFile = fileURLToPath(new URL("../dist/index.html", import.meta.url));
  if (!existsSync(indexFile)) throw new Error(`Built UI is missing: ${indexFile}`);
  app.use(express.static(distDirectory));
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => res.sendFile(indexFile));
}

// express fires this callback even when the bind FAILED (verified: on
// EADDRINUSE it runs with server.listening === false), so an unguarded log
// here announces a success that did not happen, one line before the error.
const server = app.listen(port, host, () => {
  if (!server.listening) return;
  console.log(`Claw Task Hub API listening on http://${host}:${port}`);
  // Startup and periodic reconciliation only once the server really listens, so
  // a hub that lost its port does not repair anything.
  startReconciliationLoop((message) => console.log(`claw-task-hub: ${message}`));
});


// A launcher that loses the port must SAY SO.
//
// app.listen had no error handler, so EADDRINUSE surfaced as an uncaught
// exception and was easily lost under concurrently. A manual `bun run dev`
// started while the systemd service held 4781 died without a visible error,
// and the already-running service went on answering with six-hour-old code
// while the files on disk were edited three times. Nothing in the UI or the
// API could show that, because the API was the stale thing.
//
// The listener is deliberately synchronous. An async EventEmitter listener that
// rejects drops its rejection on the floor, and this listener is the one thing
// standing between a lost port and a silent death -- so the async probe runs in
// an IIFE whose failure still reaches the exit below, and the exit lives in a
// finally so no path can skip it.
server.on("error", (error: NodeJS.ErrnoException) => {
  void (async () => {
    try {
      await reportStartupFailure(error);
    } catch (reportingError) {
      console.error(
        `Claw Task Hub API could not report its startup failure: ${
          reportingError instanceof Error ? reportingError.message : String(reportingError)
        }`,
      );
    } finally {
      process.exit(1);
    }
  })();
});

async function reportStartupFailure(error: NodeJS.ErrnoException) {
  if (error.code !== "EADDRINUSE") {
    console.error(`Claw Task Hub API failed to start: ${error.message}`);
    return;
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
    const health = (await response.json()) as { ok?: boolean; dbPath?: string; database?: string };
    if (health?.ok) {
      console.error(
        `A Claw Task Hub instance is already running there, serving ${health.database ?? health.dbPath}.`);
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
}
