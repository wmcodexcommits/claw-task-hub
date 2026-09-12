import {
  activateManagedDatabase,
  createManagedDatabase,
  deleteManagedDatabase,
  getManagedDatabase,
  listManagedDatabases,
} from "./db.js";
import { dataSnapshot } from "./data-snapshot.js";
import { notifyOpenUis } from "./refresh-notifier.js";
import {
  claimIssue,
  dashboard,
  deleteContextBinding,
  deleteIssue,
  deleteProject,
  endAgentSession,
  ensureDefaultTeam,
  getContextBinding,
  getIssue,
  getProject,
  heartbeatAgentSession,
  listAgentSessions,
  listContextBindings,
  listIssueClaims,
  listIssueDependencies,
  listIssues,
  listProjectUpdates,
  listProjects,
  listTeams,
  releaseIssueClaim,
  repairIssueInvariants,
  resolveContextProject,
  resolveIssueDependency,
  saveComment,
  saveIssueDependency,
  saveProjectUpdate,
  startAgentSession,
  updateIssue,
  updateProject,
  upsertContextBinding,
  upsertIssue,
  upsertProject,
} from "./store.js";

export const hubToolNames = [
  "dashboard",
  "list_teams",
  "refresh_data",
  "list_databases",
  "get_database",
  "create_database",
  "update_database",
  "activate_database",
  "delete_database",
  "list_projects",
  "get_project",
  "create_project",
  "update_project",
  "save_project",
  "delete_project",
  "list_project_updates",
  "save_project_update",
  "list_issues",
  "get_issue",
  "create_issue",
  "update_issue",
  "save_issue",
  "delete_issue",
  "save_comment",
  "accept_issue",
  "list_issue_dependencies",
  "save_issue_dependency",
  "resolve_issue_dependency",
  "start_agent_session",
  "heartbeat_agent_session",
  "end_agent_session",
  "list_agent_sessions",
  "claim_issue",
  "release_issue_claim",
  "list_issue_claims",
  "repair_issue_invariants",
  "save_context_binding",
  "upsert_context_binding",
  "get_context_binding",
  "list_context_bindings",
  "resolve_context_project",
  "delete_context_binding",
] as const;

export type HubToolName = (typeof hubToolNames)[number];

const hubWriteTools = new Set<HubToolName>([
  "refresh_data",
  "create_database", "update_database", "activate_database", "delete_database",
  "create_project", "update_project", "save_project", "delete_project", "save_project_update",
  "create_issue", "update_issue", "save_issue", "delete_issue", "save_comment", "accept_issue",
  "save_issue_dependency", "resolve_issue_dependency",
  "start_agent_session", "heartbeat_agent_session", "end_agent_session", "claim_issue", "release_issue_claim", "repair_issue_invariants",
  "save_context_binding", "upsert_context_binding", "delete_context_binding",
]);

function requiredString(input: Record<string, unknown>, key: string, tool: string) {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${tool} requires ${key}`);
  return value;
}

function splitId(input: Record<string, unknown>, tool: string) {
  const id = requiredString(input, "id", tool);
  const value = { ...input };
  delete value.id;
  return { id, value };
}

export async function callHubTool(name: string, args: Record<string, unknown>) {
  if (!hubToolNames.includes(name as HubToolName)) throw new Error(`Unknown tool: ${name}`);
  const result = await dispatchHubTool(name as HubToolName, args);
  if (hubWriteTools.has(name as HubToolName)) await notifyOpenUis(`tool:${name}`);
  return result;
}

async function dispatchHubTool(name: HubToolName, args: Record<string, unknown>) {
  if (name === "dashboard") return await dashboard();
  if (name === "list_teams") return { teams: await listTeams() };
  if (name === "refresh_data") return await dataSnapshot(args);

  if (name === "list_databases") return listManagedDatabases();
  if (name === "get_database") return { database: getManagedDatabase(requiredString(args, "id", name)) };
  if (name === "create_database") {
    const catalogue = createManagedDatabase(requiredString(args, "name", name), typeof args.path === "string" ? args.path : undefined);
    await ensureDefaultTeam();
    return catalogue;
  }
  if (name === "update_database" || name === "activate_database") {
    if (name === "update_database" && args.active !== true) throw new Error("update_database currently requires active=true");
    const catalogue = activateManagedDatabase(requiredString(args, "id", name));
    await ensureDefaultTeam();
    return catalogue;
  }
  if (name === "delete_database") {
    return deleteManagedDatabase(requiredString(args, "id", name), args.confirm === true);
  }

  if (name === "list_projects") return { projects: await listProjects() };
  if (name === "get_project") return { project: await getProject(requiredString(args, "id", name), { issues_per_status: args.issues_per_status }) };
  if (name === "create_project" || name === "save_project") return { project: await upsertProject(args) };
  if (name === "update_project") {
    const { id, value } = splitId(args, name);
    return { project: await updateProject(id, value) };
  }
  if (name === "delete_project") {
    return await deleteProject({
      id: requiredString(args, "id", name),
      confirm: args.confirm === true,
      delete_issues: args.delete_issues === true,
      force: args.force === true,
    });
  }
  if (name === "list_project_updates") return { updates: await listProjectUpdates(args as { project_id: string }) };
  if (name === "save_project_update") return { update: await saveProjectUpdate(args as { project_id: string; body: string }) };

  if (name === "list_issues") return { issues: await listIssues(args) };
  if (name === "get_issue") return { issue: await getIssue(requiredString(args, "id", name)) };
  if (name === "create_issue" || name === "save_issue") return { issue: await upsertIssue(args) };
  if (name === "update_issue") {
    const { id, value } = splitId(args, name);
    delete value.issue_id;
    return { issue: await updateIssue(id, value) };
  }
  if (name === "delete_issue") {
    return await deleteIssue({ id: requiredString(args, "id", name), confirm: args.confirm === true, force: args.force === true });
  }
  if (name === "save_comment") return { comment: await saveComment(args as { issue_id: string; body: string; author?: string }) };
  if (name === "accept_issue") {
    const issueId = requiredString(args, "issue_id", name);
    const body = requiredString(args, "body", name);
    const acceptanceBody = /^accept(?:ance|ed)\b/i.test(body) ? body : `Acceptance: ${body}`;
    const comment = await saveComment({
      issue_id: issueId,
      body: acceptanceBody,
      author: typeof args.author === "string" ? args.author : undefined,
      source: typeof args.source === "string" ? args.source : undefined,
      external_id: typeof args.external_id === "string" ? args.external_id : undefined,
    });
    return { comment, issue: await updateIssue(issueId, { status: "Done" }) };
  }
  if (name === "list_issue_dependencies") return { dependencies: await listIssueDependencies(args as { issue_id: string }) };
  if (name === "save_issue_dependency") return { dependency: await saveIssueDependency(args as { issue_id: string; blocker_issue_id: string }) };
  if (name === "resolve_issue_dependency") return await resolveIssueDependency(args);

  if (name === "start_agent_session") return { session: await startAgentSession(args as { agent_name: string }) };
  if (name === "heartbeat_agent_session") return { session: await heartbeatAgentSession(args as { session_id: string }) };
  if (name === "end_agent_session") return await endAgentSession(args as { session_id: string });
  if (name === "list_agent_sessions") return { sessions: await listAgentSessions(args) };
  if (name === "claim_issue") return await claimIssue(args as { issue_id: string; session_id: string });
  if (name === "release_issue_claim") return await releaseIssueClaim(args as Parameters<typeof releaseIssueClaim>[0]);
  if (name === "list_issue_claims") return { claims: await listIssueClaims(args) };
  if (name === "repair_issue_invariants") return await repairIssueInvariants();

  if (name === "save_context_binding" || name === "upsert_context_binding") {
    return { binding: await upsertContextBinding(args as { context_key: string; project_id: string }) };
  }
  if (name === "get_context_binding") {
    const locator = typeof args.context_key === "string" && args.context_key ? args.context_key : args.id;
    if (typeof locator !== "string" || !locator) throw new Error("get_context_binding requires id or context_key");
    return { binding: await getContextBinding(locator) };
  }
  if (name === "list_context_bindings") return { bindings: await listContextBindings(args) };
  if (name === "resolve_context_project") return await resolveContextProject(args);
  if (name === "delete_context_binding") return await deleteContextBinding(args as { id?: string; context_key?: string });
  throw new Error(`Unknown tool: ${name}`);
}
