import {
  activateDatabase,
  createManagedDatabase,
  deleteManagedDatabase,
  getManagedDatabase,
  listManagedDatabases,
} from "./db.js";
import { dataSnapshot } from "./data-snapshot.js";
import { listExecutionAdapters } from "./execution-adapters.js";
import {
  getExecutionAttempt,
  listExecutionAttempts,
  transitionExecutionAttempt,
} from "./execution-attempts.js";
import {
  decideExecutionConflict,
  declareExecutionPaths,
  detectExecutionConflicts,
  getConflictPolicy,
  getExecutionConflict,
  getExecutionPathDeclaration,
  listExecutionConflicts,
  saveConflictPolicy,
} from "./execution-conflicts.js";
import {
  acceptExecutionAttempt,
  getAcceptancePolicy,
  getExecutionAcceptance,
  listExecutionAcceptances,
  rejectExecutionAttempt,
  saveAcceptancePolicy,
} from "./execution-acceptance.js";
import { listExecutionProviders } from "./execution-providers.js";
import {
  getReconciliationRun,
  listReconciliationRuns,
  quarantineExecutionAttempt,
  reconcileExecution,
} from "./execution-reconciliation.js";
import {
  captureExecutionDiff,
  getExecutionEvidence,
  getVerificationPolicy,
  listExecutionEvidence,
  recordExecutionEvidence,
  saveVerificationPolicy,
  verifyExecutionAttempt,
} from "./execution-evidence.js";
import { launchExecutionAttempt } from "./execution-runs.js";
import {
  getExecutionWorkspace,
  listExecutionWorkspaces,
  planExecutionWorkspace,
  provisionExecutionWorkspace,
  releaseExecutionWorkspace,
  renewExecutionWorkspace,
  startExecutionAttempt,
} from "./execution-workspaces.js";
import { listRunnableIssues } from "./issue-runnability.js";
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
  "list_runnable_issues",
  "repair_issue_invariants",
  "save_context_binding",
  "upsert_context_binding",
  "get_context_binding",
  "list_context_bindings",
  "resolve_context_project",
  "delete_context_binding",
  "create_execution_attempt",
  "get_execution_attempt",
  "list_execution_attempts",
  "transition_execution_attempt",
  "plan_execution_workspace",
  "provision_execution_workspace",
  "get_execution_workspace",
  "list_execution_workspaces",
  "renew_execution_workspace",
  "release_execution_workspace",
  "list_execution_adapters",
  "launch_execution_attempt",
  "save_verification_policy",
  "get_verification_policy",
  "capture_execution_diff",
  "record_execution_evidence",
  "list_execution_evidence",
  "get_execution_evidence",
  "verify_execution_attempt",
  "declare_execution_paths",
  "get_execution_path_declaration",
  "save_conflict_policy",
  "get_conflict_policy",
  "detect_execution_conflicts",
  "list_execution_conflicts",
  "get_execution_conflict",
  "decide_execution_conflict",
  "list_execution_providers",
  "save_acceptance_policy",
  "get_acceptance_policy",
  "accept_execution_attempt",
  "reject_execution_attempt",
  "list_execution_acceptances",
  "get_execution_acceptance",
  "reconcile_execution",
  "list_reconciliation_runs",
  "get_reconciliation_run",
  "quarantine_execution_attempt",
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
  "create_execution_attempt", "transition_execution_attempt",
  "provision_execution_workspace", "renew_execution_workspace", "release_execution_workspace",
  "launch_execution_attempt",
  "save_verification_policy", "capture_execution_diff", "record_execution_evidence", "verify_execution_attempt",
  "declare_execution_paths", "save_conflict_policy", "detect_execution_conflicts", "decide_execution_conflict",
  "save_acceptance_policy", "accept_execution_attempt", "reject_execution_attempt",
  "reconcile_execution", "quarantine_execution_attempt",
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
    const catalogue = await activateDatabase(requiredString(args, "id", name));
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
  if (name === "list_runnable_issues") return await listRunnableIssues(args);
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

  if (name === "create_execution_attempt") return await startExecutionAttempt(args);
  if (name === "get_execution_attempt") {
    const locator = typeof args.id === "string" && args.id ? args.id : args.attempt_id;
    if (typeof locator !== "string" || !locator) throw new Error("get_execution_attempt requires id");
    return { attempt: await getExecutionAttempt(locator) };
  }
  if (name === "list_execution_attempts") return { attempts: await listExecutionAttempts(args) };
  if (name === "transition_execution_attempt") return await transitionExecutionAttempt(args);

  if (name === "plan_execution_workspace") return { plan: await planExecutionWorkspace(args) };
  if (name === "provision_execution_workspace") return await provisionExecutionWorkspace(args);
  if (name === "get_execution_workspace") return { workspace: await getExecutionWorkspace(requiredString(args, "id", name)) };
  if (name === "list_execution_workspaces") return { workspaces: await listExecutionWorkspaces(args) };
  if (name === "renew_execution_workspace") return { workspace: await renewExecutionWorkspace(args) };
  if (name === "release_execution_workspace") return await releaseExecutionWorkspace(args);

  if (name === "list_execution_adapters") return { adapters: listExecutionAdapters() };
  if (name === "launch_execution_attempt") return await launchAndReport(args);

  if (name === "save_verification_policy") return await saveVerificationPolicy(args);
  if (name === "get_verification_policy") return await getVerificationPolicy(args);
  if (name === "capture_execution_diff") return await captureExecutionDiff(args);
  if (name === "record_execution_evidence") return await recordExecutionEvidence(args);
  if (name === "list_execution_evidence") return { evidence: await listExecutionEvidence(args) };
  if (name === "get_execution_evidence") return { evidence: await getExecutionEvidence(requiredString(args, "id", name)) };
  if (name === "verify_execution_attempt") return await verifyExecutionAttempt(args);

  if (name === "declare_execution_paths") return await declareExecutionPaths(args);
  if (name === "get_execution_path_declaration") return await getExecutionPathDeclaration(args);
  if (name === "save_conflict_policy") return await saveConflictPolicy(args);
  if (name === "get_conflict_policy") return await getConflictPolicy(args);
  if (name === "detect_execution_conflicts") return await detectExecutionConflicts(args);
  if (name === "list_execution_conflicts") return { conflicts: await listExecutionConflicts(args) };
  if (name === "get_execution_conflict") return { conflict: await getExecutionConflict(requiredString(args, "id", name)) };
  if (name === "decide_execution_conflict") return await decideExecutionConflict(args);

  if (name === "list_execution_providers") return { providers: listExecutionProviders() };
  if (name === "save_acceptance_policy") return await saveAcceptancePolicy(args);
  if (name === "get_acceptance_policy") return await getAcceptancePolicy(args);
  if (name === "accept_execution_attempt") return await acceptExecutionAttempt(args);
  if (name === "reject_execution_attempt") return await rejectExecutionAttempt(args);
  if (name === "list_execution_acceptances") return { acceptances: await listExecutionAcceptances(args) };
  if (name === "get_execution_acceptance") return { acceptance: await getExecutionAcceptance(requiredString(args, "id", name)) };

  if (name === "reconcile_execution") return await reconcileExecution({ ...args, trigger: "manual" });
  if (name === "list_reconciliation_runs") return { runs: await listReconciliationRuns(args) };
  if (name === "get_reconciliation_run") return { run: await getReconciliationRun(requiredString(args, "id", name)) };
  if (name === "quarantine_execution_attempt") return await quarantineExecutionAttempt(args);
  throw new Error(`Unknown tool: ${name}`);
}

// A launched run keeps supervising its harness after the call returns unless the
// caller waits for it. The process that launched it keeps the harness's pipes
// open, so even a one-shot CLI call stays alive until the run finishes and
// records its outcome.
export async function launchAndReport(args: Record<string, unknown>) {
  const { completion, ...started } = await launchExecutionAttempt(args);
  if (args.wait === true) return { ...started, outcome: await completion };
  void completion.catch((error: unknown) => {
    process.stderr.write(`claw-task-hub: execution run for ${started.attempt.id} did not finish cleanly: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  return started;
}
