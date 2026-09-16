import { executionAdapterCapabilities } from "./execution-adapters.js";
import { executionEvidenceKinds, observationStatuses } from "./execution-attempts-schema.js";
import { executionActorKinds, executionEvents } from "./execution-contract.js";
import { callHubTool, hubToolNames } from "./tool-dispatch.js";
import { APP_VERSION } from "./version.js";

let stdin = Buffer.alloc(0);

function write(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

const tools = [
  tool("dashboard", "Return local Claw Task Hub dashboard counts."),
  tool("list_teams", "List local teams."),
  tool("list_projects", "List local projects."),
  tool("refresh_data", "Explicitly read a fresh UI data snapshot from the active local database. This does not poll or mutate data.", {
    issues_per_status: { oneOf: [{ type: "number", enum: [50, 100, 200] }, { type: "string", enum: ["50", "100", "200", "all"] }] },
    include_issues: { type: "boolean" },
  }),
  tool("list_databases", "List managed SQLite databases and identify the active database."),
  tool("get_database", "Get one managed SQLite database by id.", {
    id: { type: "string" },
  }, ["id"]),
  tool("create_database", "Create, initialize, register, and activate a local SQLite database.", {
    name: { type: "string", minLength: 1, maxLength: 80 },
    path: { type: "string", maxLength: 4096 },
  }, ["name"]),
  tool("update_database", "Update mutable database state. The only mutable field is active=true.", {
    id: { type: "string" },
    active: { type: "boolean", const: true },
  }, ["id", "active"]),
  tool("activate_database", "Compatibility alias for update_database with active=true.", {
    id: { type: "string" },
  }, ["id"]),
  tool("delete_database", "Permanently delete an inactive SQLite database and its sidecars. Requires confirm=true.", {
    id: { type: "string" },
    confirm: { type: "boolean", const: true },
  }, ["id", "confirm"]),
  tool("get_project", "Get one project with status counts, blockers, updates, and activity.", {
    id: { type: "string" },
    issues_per_status: { anyOf: [{ type: "number" }, { type: "string" }] },
  }, ["id"]),
  tool("save_project", "Create or update a local project. Updates should pass id or external_id; creation requires name.", {
    id: { type: "string" },
    external_id: { type: "string" },
    name: { type: "string" },
    summary: { type: "string" },
    description: { type: "string" },
    status: { type: "string" },
    priority: { type: "number" },
    lead: { anyOf: [{ type: "string" }, { type: "null" }] },
    target_date: { anyOf: [{ type: "string", format: "date" }, { type: "null" }] },
    source: { type: "string" },
    archived_at: { anyOf: [{ type: "string" }, { type: "null" }] },
    created_at: { type: "string" },
    updated_at: { type: "string" },
  }),
  tool("create_project", "Create a local project under an explicit name.", {
    id: { type: "string" }, external_id: { type: "string" }, name: { type: "string", minLength: 1 },
    summary: { anyOf: [{ type: "string" }, { type: "null" }] }, description: { anyOf: [{ type: "string" }, { type: "null" }] },
    status: { type: "string" }, priority: { type: "number" }, lead: { anyOf: [{ type: "string" }, { type: "null" }] },
    target_date: { anyOf: [{ type: "string", format: "date" }, { type: "null" }] }, source: { type: "string" },
  }, ["name"]),
  tool("update_project", "Update an existing project. This never creates a missing project.", {
    id: { type: "string" }, external_id: { type: "string" }, name: { type: "string", minLength: 1 },
    summary: { anyOf: [{ type: "string" }, { type: "null" }] }, description: { anyOf: [{ type: "string" }, { type: "null" }] },
    status: { type: "string" }, priority: { type: "number" }, lead: { anyOf: [{ type: "string" }, { type: "null" }] },
    target_date: { anyOf: [{ type: "string", format: "date" }, { type: "null" }] }, source: { type: "string" },
    archived_at: { anyOf: [{ type: "string" }, { type: "null" }] },
  }, ["id"]),
  tool("delete_project", "Permanently delete an existing project. Projects with issues require delete_issues=true; active claims additionally require force=true.", {
    id: { type: "string" }, confirm: { type: "boolean", const: true }, delete_issues: { type: "boolean" }, force: { type: "boolean" },
  }, ["id", "confirm"]),
  tool("list_project_updates", "List first-class status updates for one project.", {
    project_id: { type: "string" },
    limit: { type: "number" },
  }, ["project_id"]),
  tool("save_project_update", "Post or idempotently update a project status update.", {
    id: { type: "string" },
    external_id: { type: "string" },
    project_id: { type: "string" },
    body: { type: "string", maxLength: 10000 },
    health: { type: "string", enum: ["on_track", "at_risk", "off_track", "complete"] },
    author: { type: "string" },
    source: { type: "string" },
  }, ["project_id", "body"]),
  tool("list_issues", "List local issues with optional filters.", {
    project: { type: "string" },
    project_id: { type: "string" },
    team: { type: "string" },
    team_id: { type: "string" },
    status: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    status_type: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    include_done: { type: "boolean" },
    blocked: { type: "boolean" },
    query: { type: "string" },
    limit: { type: "number" },
    offset: { type: "number" },
  }),
  tool("get_issue", "Get one local issue by id, external id, or identifier.", {
    id: { type: "string" },
  }, ["id"]),
  tool("save_issue", "Create or update a local issue. New issues require the owning project_id from list_projects; Claw Task Hub never guesses a default project. Title is the human-readable task name, not an issue code. Short local identifiers like CTH-001 are assigned automatically unless a valid imported identifier is provided. Updates can use issue_id, id, external_id, or identifier with partial fields. Use allow_no_project:true only for a deliberate unassigned inbox issue.", {
    id: { type: "string" },
    external_id: { type: "string" },
    identifier: { type: "string" },
    issue_id: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    status: { type: "string" },
    status_type: { type: "string" },
    priority: { type: "number" },
    project_id: { type: "string" },
    allow_no_project: { type: "boolean" },
    team_id: { type: "string" },
    labels: { type: "array", items: { type: "string" } },
  }),
  tool("create_issue", "Create a ticket in an explicit owning project.", {
    id: { type: "string" }, external_id: { type: "string" }, identifier: { type: "string" }, title: { type: "string", minLength: 1 },
    description: { type: "string" }, status: { type: "string" }, status_type: { type: "string" }, priority: { type: "number" },
    project_id: { type: "string" }, team_id: { anyOf: [{ type: "string" }, { type: "null" }] }, parent_id: { anyOf: [{ type: "string" }, { type: "null" }] },
    assignee: { anyOf: [{ type: "string" }, { type: "null" }] }, labels: { type: "array", items: { type: "string" } }, source: { type: "string" },
  }, ["title", "project_id"]),
  tool("update_issue", "Update an existing ticket by internal id, external id, or visible identifier. This never creates a missing issue.", {
    id: { type: "string" }, external_id: { type: "string" }, identifier: { type: "string" }, title: { type: "string", minLength: 1 },
    description: { type: "string" }, status: { type: "string" }, status_type: { type: "string" }, priority: { type: "number" },
    project_id: { anyOf: [{ type: "string" }, { type: "null" }] }, team_id: { anyOf: [{ type: "string" }, { type: "null" }] },
    parent_id: { anyOf: [{ type: "string" }, { type: "null" }] }, assignee: { anyOf: [{ type: "string" }, { type: "null" }] },
    labels: { type: "array", items: { type: "string" } }, source: { type: "string" },
  }, ["id"]),
  tool("delete_issue", "Permanently delete an existing ticket. Active claims require force=true.", {
    id: { type: "string" }, confirm: { type: "boolean", const: true }, force: { type: "boolean" },
  }, ["id", "confirm"]),
  tool("save_comment", "Create a local comment on an open issue. issue_id accepts the internal id, external id, or visible identifier such as CTH-212. Done, Canceled, and archived issues require allow_closed=true for deliberate historical maintenance.", {
    id: { type: "string" },
    external_id: { type: "string" },
    issue_id: { type: "string" },
    body: { type: "string" },
    author: { type: "string" },
    source: { type: "string" },
    allow_closed: { type: "boolean" },
  }, ["issue_id", "body"]),
  tool("accept_issue", "Complete an open issue safely: require evidence, save it as an acceptance comment, then move the issue to Done. If evidence validation or persistence fails, the status is not changed.", {
    issue_id: { type: "string" },
    body: { type: "string", minLength: 1 },
    external_id: { type: "string" },
    author: { type: "string" },
    source: { type: "string" },
  }, ["issue_id", "body"]),
  tool("list_issue_dependencies", "List explicit blockers for an issue.", {
    issue_id: { type: "string" },
    include_resolved: { type: "boolean" },
    limit: { type: "number" },
  }, ["issue_id"]),
  tool("save_issue_dependency", "Record that issue_id is blocked by blocker_issue_id. Self-dependencies and cycles are rejected.", {
    id: { type: "string" },
    external_id: { type: "string" },
    issue_id: { type: "string" },
    blocker_issue_id: { type: "string" },
    reason: { type: "string", maxLength: 2000 },
    source: { type: "string" },
  }, ["issue_id", "blocker_issue_id"]),
  tool("resolve_issue_dependency", "Resolve one blocker relation by dependency_id or the issue/blocker pair.", {
    dependency_id: { type: "string" },
    issue_id: { type: "string" },
    blocker_issue_id: { type: "string" },
  }),
  tool("list_runnable_issues", "List the issues an execution scheduler can start now, and why every other open issue in scope cannot. An issue is runnable when it is open and not archived, its status is not explicitly Blocked or Paused, its project is not archived or closed, it has no open dependency (an open relation blocks even when its blocker is finished), no other session holds an active claim on it, and no execution attempt for it is live. Pass session_id so the caller's own claims do not exclude its issues. Excluded issues carry every applicable reason code: status_blocked, status_paused, project_archived, project_closed, blocked_by_dependencies, claimed, live_attempt, and, when issue_id names a closed or archived issue, issue_closed or issue_archived. Both lists share one deterministic order (priority with urgent first and no priority last, then issues that unblock more open dependents, then oldest first) and page with limit/offset and excluded_limit/excluded_offset.", {
    project: { type: "string" },
    project_id: { type: "string" },
    team: { type: "string" },
    team_id: { type: "string" },
    issue_id: { type: "string" },
    session_id: { type: "string" },
    include_excluded: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: 250 },
    offset: { type: "integer", minimum: 0, maximum: 100000 },
    excluded_limit: { type: "integer", minimum: 1, maximum: 250 },
    excluded_offset: { type: "integer", minimum: 0, maximum: 100000 },
  }),
  tool("start_agent_session", "Start or renew an agent work session for claim coordination.", {
    id: { type: "string" },
    agent_name: { type: "string" },
    harness: { type: "string" },
    ttl_minutes: { type: "number" },
    metadata: { type: "object" },
  }, ["agent_name"]),
  tool("heartbeat_agent_session", "Renew an active agent session lease.", {
    session_id: { type: "string" },
    ttl_minutes: { type: "number" },
  }, ["session_id"]),
  tool("end_agent_session", "End an agent session and release its active claims by default.", {
    session_id: { type: "string" },
    release_claims: { type: "boolean" },
  }, ["session_id"]),
  tool("list_agent_sessions", "List agent sessions.", {
    include_ended: { type: "boolean" },
    limit: { type: "number" },
  }),
  tool("claim_issue", "Claim an open issue for an active agent session. Fails if the issue is Done, Canceled, or archived unless allow_closed=true is passed for deliberate historical maintenance. Fails if another live claim exists unless force=true.", {
    issue_id: { type: "string" },
    session_id: { type: "string" },
    note: { type: "string" },
    ttl_minutes: { type: "number" },
    force: { type: "boolean" },
    allow_closed: { type: "boolean" },
  }, ["issue_id", "session_id"]),
  tool("release_issue_claim", "Release or complete an active issue claim. Agents may pass claim_id directly, or issue_id plus session_id.", {
    claim_id: { type: "string" },
    issue_id: { type: "string" },
    session_id: { type: "string" },
    status: { type: "string" },
    force: { type: "boolean" },
  }),
  tool("list_issue_claims", "List active or historical issue claims.", {
    issue_id: { type: "string" },
    session_id: { type: "string" },
    include_released: { type: "boolean" },
    limit: { type: "number" },
  }),
  tool("repair_issue_invariants", "Normalize stored issue status_type, completed_at, and labels for legacy rows."),
  tool("save_context_binding", "Create or update a durable harness context binding to a Claw Task Hub project. Use this to bind a repo, working directory, thread, or harness context to the project that should open by default.", {
    id: { type: "string" },
    context_key: { type: "string" },
    project_id: { type: "string" },
    default_tab: { type: "string", enum: ["overview", "activity", "issues"] },
    harness: { type: "string" },
    workspace_name: { type: "string" },
    cwd: { type: "string" },
    repo_remote: { type: "string" },
    branch: { type: "string" },
    thread_id: { type: "string" },
    metadata: { type: "object" },
    source: { type: "string" },
  }, ["context_key", "project_id"]),
  tool("upsert_context_binding", "Alias for save_context_binding.", {
    id: { type: "string" },
    context_key: { type: "string" },
    project_id: { type: "string" },
    default_tab: { type: "string", enum: ["overview", "activity", "issues"] },
    harness: { type: "string" },
    workspace_name: { type: "string" },
    cwd: { type: "string" },
    repo_remote: { type: "string" },
    branch: { type: "string" },
    thread_id: { type: "string" },
    metadata: { type: "object" },
    source: { type: "string" },
  }, ["context_key", "project_id"]),
  tool("get_context_binding", "Get one harness context binding by id or context_key.", {
    id: { type: "string" },
    context_key: { type: "string" },
  }),
  tool("list_context_bindings", "List durable harness context bindings.", {
    context_key: { type: "string" },
    project_id: { type: "string" },
    harness: { type: "string" },
    cwd: { type: "string" },
    repo_remote: { type: "string" },
    branch: { type: "string" },
    thread_id: { type: "string" },
    limit: { type: "number" },
  }),
  tool("resolve_context_project", "Resolve the Claw Task Hub project for a harness context. Prefer exact context_key; otherwise pass thread_id, cwd, repo_remote, branch, and/or harness.", {
    context_key: { type: "string" },
    project_id: { type: "string" },
    harness: { type: "string" },
    cwd: { type: "string" },
    repo_remote: { type: "string" },
    branch: { type: "string" },
    thread_id: { type: "string" },
  }),
  tool("delete_context_binding", "Delete a durable harness context binding by id or context_key.", {
    id: { type: "string" },
    context_key: { type: "string" },
  }),
  tool("create_execution_attempt", "Create a durable execution attempt for an open issue under an active claim, pinned to an immutable base commit SHA. Only one non-terminal attempt may exist per issue; a retry passes retry_of with a terminal attempt of the same issue and creates a new attempt. Repeating idempotency_key with the same inputs returns the existing attempt. repository must not contain credentials. Pass repository_path, the top level of a local clone whose origin or path is repository, to also provision the attempt's leased branch and worktree.", {
    issue_id: { type: "string" },
    claim_id: { type: "string" },
    harness: { type: "string", pattern: "^[a-z][a-z0-9-]{0,119}$" },
    harness_version: { type: "string", maxLength: 120 },
    repository: { type: "string", minLength: 1, maxLength: 2000 },
    base_sha: { type: "string", pattern: "^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$" },
    retry_of: { type: "string" },
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
    provenance: { type: "object" },
    repository_path: { type: "string", maxLength: 4096 },
    ttl_minutes: { type: "number", minimum: 1, maximum: 1440 },
  }, ["issue_id", "claim_id", "harness", "repository", "base_sha", "idempotency_key"]),
  tool("plan_execution_workspace", "Describe the branch and worktree path provisioning would use for an attempt, after validating the repository, without creating anything.", {
    attempt_id: { type: "string" },
    repository_path: { type: "string", maxLength: 4096 },
  }, ["attempt_id", "repository_path"]),
  tool("provision_execution_workspace", "Provision, or verify and resume, the leased Git branch and worktree for an execution attempt at its pinned base commit. repository_path is the top level of the operator's local clone; it is only read, and its hooks do not run. Repeating the call returns the same lease; an expired or interrupted lease is verified and reclaimed.", {
    attempt_id: { type: "string" },
    repository_path: { type: "string", maxLength: 4096 },
    ttl_minutes: { type: "number", minimum: 1, maximum: 1440 },
  }, ["attempt_id", "repository_path"]),
  tool("get_execution_workspace", "Get one workspace lease by id, including whether it is live or expired.", {
    id: { type: "string" },
  }, ["id"]),
  tool("list_execution_workspaces", "List workspace leases, newest first. Filter by attempt_id, issue_id, branch, or worktree_path to find who owns a workspace; released leases are included only with include_released=true.", {
    attempt_id: { type: "string" },
    issue_id: { type: "string" },
    branch: { type: "string" },
    worktree_path: { type: "string" },
    include_released: { type: "boolean" },
    limit: { type: "number" },
  }),
  tool("renew_execution_workspace", "Extend an active, unexpired workspace lease of a non-terminal attempt.", {
    id: { type: "string" },
    ttl_minutes: { type: "number", minimum: 1, maximum: 1440 },
  }, ["id"]),
  tool("release_execution_workspace", "Release a workspace lease. A clean worktree is removed unless keep_worktree=true; a worktree with uncommitted or untracked work is always retained. The branch is always kept.", {
    id: { type: "string" },
    keep_worktree: { type: "boolean" },
  }, ["id"]),
  tool("list_execution_adapters", "List the harness adapters this hub can launch, with their capabilities, the credential variables they pass through, and whether each is available on this machine."),
  tool("launch_execution_attempt", "Launch a harness inside an attempt's leased worktree. The attempt must be provisioning with an active, unexpired workspace lease. The prompt reaches the harness on stdin only after the launch transition wins its compare-and-set, so a duplicate launch never starts work; repeating the winning idempotency_key starts nothing. The harness environment is an allowlist, and the adapter's credential variables are passed through but scrubbed from captured output. Output, wall-clock time, and idle time are bounded (the optional limits may only tighten the contract defaults), and canceling the attempt terminates the harness process tree. wait=true returns the run outcome; otherwise the run finishes in the background and records its own transition.", {
    attempt_id: { type: "string" },
    adapter: { type: "string" },
    prompt: { type: "string", minLength: 1, maxLength: 200000 },
    model: { type: "string", maxLength: 120 },
    requires: { type: "array", items: { type: "string", enum: [...executionAdapterCapabilities] } },
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
    wait: { type: "boolean" },
    wall_clock_ms: { type: "integer", minimum: 100 },
    idle_output_ms: { type: "integer", minimum: 100 },
    cancellation_grace_ms: { type: "integer", minimum: 0 },
    captured_stream_bytes: { type: "integer", minimum: 1024 },
  }, ["attempt_id", "adapter", "prompt", "idempotency_key"]),
  tool("save_verification_policy", "Save a new revision of a repository's verification policy. Policies are operator configuration (actor_kind must be operator); a repository's own files never define verification. Each step is an argument vector run without a shell whose executable is an absolute path or a program on PATH, never a path inside the repository, with an optional version_command recorded as provenance, a timeout within the contract's verification_step bound, and required (default true). require_changes (default true) fails verification when the worktree has no changes against its base.", {
    repository: { type: "string", minLength: 1, maxLength: 2000 },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          name: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,59}$" },
          command: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
          version_command: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
          timeout_ms: { type: "integer", minimum: 100 },
          required: { type: "boolean" },
        },
        required: ["name", "command"],
        additionalProperties: false,
      },
    },
    require_changes: { type: "boolean" },
    actor_kind: { type: "string", const: "operator" },
    actor_id: { type: "string", minLength: 1, maxLength: 200 },
    note: { type: "string", maxLength: 2000 },
  }, ["repository", "steps", "actor_kind", "actor_id"]),
  tool("get_verification_policy", "Get a repository's verification policy: the latest revision, or the given revision. policy is null when none is configured.", {
    repository: { type: "string" },
    revision: { type: "integer", minimum: 1 },
  }, ["repository"]),
  tool("capture_execution_diff", "Record diff evidence for an attempt's leased worktree against its pinned base commit: touched files with status, rename source and similarity, modes, blobs, and line counts; the SHA-256 of the complete patch; a bounded, scrubbed patch artifact; and the Git tree fingerprint of the exact content. Untracked files count, ignored files do not, and the worktree's own index is never touched.", {
    attempt_id: { type: "string" },
    actor_kind: { type: "string", enum: [...executionActorKinds] },
    actor_id: { type: "string", minLength: 1, maxLength: 200 },
  }, ["attempt_id"]),
  tool("record_execution_evidence", "Append an observation or a claim to an attempt's evidence. An observation reports a verification step with its status, command, exit code, duration, log (scrubbed and bounded into an artifact), artifact references, and tool versions. A claim, such as a formal proof or an external attestation, is recorded but never satisfies a verification policy. Evidence is tied to the worktree's tree fingerprint, captured now unless given, and never changes; a correction passes supersedes naming earlier evidence of the same kind and name on the same attempt. Diffs and verdicts are produced only by the hub.", {
    attempt_id: { type: "string" },
    kind: { type: "string", enum: ["observation", "claim"] },
    schema_version: { type: "string", const: "execution-evidence/v1" },
    name: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,59}$" },
    status: { type: "string", enum: [...observationStatuses] },
    exit_code: { type: "integer" },
    duration_ms: { type: "integer", minimum: 0 },
    command: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
    summary: { type: "string", maxLength: 2000 },
    log: { type: "string" },
    artifacts: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        properties: { kind: { type: "string", pattern: "^[a-z][a-z0-9_]{0,49}$" }, ref: { type: "string", minLength: 1, maxLength: 2000 } },
        required: ["kind", "ref"],
        additionalProperties: false,
      },
    },
    tool_versions: { type: "object", additionalProperties: { type: "string", maxLength: 200 } },
    tree_fingerprint: { type: "string", pattern: "^([0-9a-f]{40}|[0-9a-f]{64})$" },
    supersedes: { type: "string" },
    actor_kind: { type: "string", enum: [...executionActorKinds] },
    actor_id: { type: "string", minLength: 1, maxLength: 200 },
  }, ["attempt_id", "kind", "name", "actor_kind", "actor_id"]),
  tool("list_execution_evidence", "List an attempt's evidence in the order it was recorded, including superseded records. Filter by kind (diff, observation, claim, verdict) and name.", {
    attempt_id: { type: "string" },
    kind: { type: "string", enum: [...executionEvidenceKinds] },
    name: { type: "string" },
  }, ["attempt_id"]),
  tool("get_execution_evidence", "Get one evidence record by id.", {
    id: { type: "string" },
  }, ["id"]),
  tool("declare_execution_paths", "Declare the repository-relative paths an issue plans to touch in a repository, as a new revision that replaces the previous declaration; an empty array clears it. A trailing slash declares a directory; wildcards and \"..\" are refused. Declared paths are intent, never treated as observed changes. Conflicts for the repository are re-detected and returned.", {
    issue_id: { type: "string" },
    repository: { type: "string", minLength: 1, maxLength: 2000 },
    paths: { type: "array", maxItems: 500, items: { type: "string", minLength: 1, maxLength: 1025 } },
    actor_kind: { type: "string", enum: [...executionActorKinds] },
    actor_id: { type: "string", minLength: 1, maxLength: 200 },
    note: { type: "string", maxLength: 2000 },
  }, ["issue_id", "repository", "paths", "actor_kind", "actor_id"]),
  tool("get_execution_path_declaration", "Get an issue's latest declared paths for a repository; declaration is null when none was made.", {
    issue_id: { type: "string" },
    repository: { type: "string" },
  }, ["issue_id", "repository"]),
  tool("save_conflict_policy", "Save a new revision of a repository's conflict policy (operator only). rules maps exact_path_observed, exact_path_declared, declared_directory, shared_directory, and base_divergence to ignore, info, warning, or blocking; unspecified rules keep their defaults (warning, and info for the shared_directory heuristic, which can never block). Without a policy nothing blocks.", {
    repository: { type: "string", minLength: 1, maxLength: 2000 },
    rules: {
      type: "object",
      properties: {
        exact_path_observed: { type: "string", enum: ["ignore", "info", "warning", "blocking"] },
        exact_path_declared: { type: "string", enum: ["ignore", "info", "warning", "blocking"] },
        declared_directory: { type: "string", enum: ["ignore", "info", "warning", "blocking"] },
        shared_directory: { type: "string", enum: ["ignore", "info", "warning"] },
        base_divergence: { type: "string", enum: ["ignore", "info", "warning", "blocking"] },
      },
      additionalProperties: false,
    },
    actor_kind: { type: "string", const: "operator" },
    actor_id: { type: "string", minLength: 1, maxLength: 200 },
    note: { type: "string", maxLength: 2000 },
  }, ["repository", "rules", "actor_kind", "actor_id"]),
  tool("get_conflict_policy", "Get a repository's conflict policy (latest or a given revision) and the effective rules, which are the defaults when no policy exists.", {
    repository: { type: "string" },
    revision: { type: "integer", minimum: 1 },
  }, ["repository"]),
  tool("detect_execution_conflicts", "Detect touched-file conflicts between the live execution attempts of a repository (or of attempt_id's repository) and record them. Compares declared paths and each attempt's latest diff evidence: exact paths including rename sources and deletions (certainty observed or declared), declared directories, the shared_directory heuristic, and, for different base commits, paths changed between the bases (certainty unknown when the bases cannot be compared). Overlaps that disappear are resolved, returning ones are reopened, and an override persists until the overlap escalates; every change is logged as a decision.", {
    repository: { type: "string" },
    attempt_id: { type: "string" },
  }),
  tool("list_execution_conflicts", "List conflict records with both attempts, the path, both bases, method, certainty, severity, status, and whether the conflict currently blocks. Resolved conflicts are included only with include_resolved=true or an explicit status.", {
    repository: { type: "string" },
    attempt_id: { type: "string" },
    issue_id: { type: "string" },
    status: { anyOf: [{ type: "string", enum: ["open", "resolved", "overridden"] }, { type: "array", items: { type: "string", enum: ["open", "resolved", "overridden"] } }] },
    include_resolved: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: 1000 },
  }),
  tool("get_execution_conflict", "Get one conflict record with its complete decision log.", {
    id: { type: "string" },
  }, ["id"]),
  tool("decide_execution_conflict", "Record an operator decision on a conflict: override an open conflict so it no longer blocks, or reopen an overridden one. reason is required, and the decision is appended to the conflict's audit log; nothing is erased.", {
    conflict_id: { type: "string" },
    decision: { type: "string", enum: ["override", "reopen"] },
    actor_kind: { type: "string", const: "operator" },
    actor_id: { type: "string", minLength: 1, maxLength: 200 },
    reason: { type: "string", minLength: 1, maxLength: 500 },
    note: { type: "string", maxLength: 2000 },
  }, ["conflict_id", "decision", "actor_kind", "actor_id", "reason"]),
  tool("list_execution_providers", "List the pull request providers an acceptance policy can name, whether each is available on this machine, and the names of the credential variables each reads."),
  tool("save_acceptance_policy", "Save a new revision of a repository's acceptance policy (operator only). Acceptance always commits the verified worktree on the attempt branch. merge_target merges that commit into a local branch without touching any checkout. push and pull_request are remote mutations: push requires allow_push, pull_request requires allow_pull_request and push, and merging the pull request requires allow_provider_merge. complete_issue (default true) releases the claim as completed and marks the issue Done; release_workspace (default true) releases the lease and keeps the branch.", {
    repository: { type: "string", minLength: 1, maxLength: 2000 },
    settings: {
      type: "object",
      properties: {
        commit_author: { type: "object", properties: { name: { type: "string", maxLength: 100 }, email: { type: "string", maxLength: 200 } }, required: ["name", "email"], additionalProperties: false },
        merge_target: { type: "string", maxLength: 200 },
        allow_push: { type: "boolean" },
        push: { type: "object", properties: { remote: { type: "string", maxLength: 2000 }, include_merge_target: { type: "boolean" } }, required: ["remote"], additionalProperties: false },
        allow_pull_request: { type: "boolean" },
        pull_request: { type: "object", properties: { provider: { type: "string" }, base_branch: { type: "string", maxLength: 200 }, merge: { type: "boolean" } }, required: ["provider", "base_branch"], additionalProperties: false },
        allow_provider_merge: { type: "boolean" },
        complete_issue: { type: "boolean" },
        release_workspace: { type: "boolean" },
      },
      additionalProperties: false,
    },
    actor_kind: { type: "string", const: "operator" },
    actor_id: { type: "string", minLength: 1, maxLength: 200 },
    note: { type: "string", maxLength: 2000 },
  }, ["repository", "settings", "actor_kind", "actor_id"]),
  tool("get_acceptance_policy", "Get a repository's acceptance policy, the latest revision or a given one; policy is null when none is configured.", {
    repository: { type: "string" },
    revision: { type: "integer", minimum: 1 },
  }, ["repository"]),
  tool("accept_execution_attempt", "Accept a reviewable execution attempt under its repository's acceptance policy. The attempt needs a passing verdict for exactly the current worktree tree and no open blocking conflicts. The run commits, then merges, pushes, and opens or merges a pull request only as the policy allows, records those identities on the accept transition, comments on the issue, releases the claim, and releases the workspace. Runs are write-ahead: repeating idempotency_key resumes an interrupted run or returns a finished one without repeating any step. Failures before the transition leave the attempt reviewable; a merge conflict rejects it with merge_conflict.", {
    attempt_id: { type: "string" },
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
    actor_kind: { type: "string", enum: ["operator", "control_plane"] },
    actor_id: { type: "string", minLength: 1, maxLength: 200 },
    commit_message: { type: "string", maxLength: 2000 },
    note: { type: "string", maxLength: 2000 },
    policy_revision: { type: "integer", minimum: 1 },
  }, ["attempt_id", "idempotency_key", "actor_kind", "actor_id"]),
  tool("reject_execution_attempt", "Reject a reviewable execution attempt with review_rejected. Its evidence and branch are kept, and its claim is released unless release_claim=false; releasing an already released claim does nothing.", {
    attempt_id: { type: "string" },
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
    actor_kind: { type: "string", enum: ["operator", "control_plane"] },
    actor_id: { type: "string", minLength: 1, maxLength: 200 },
    note: { type: "string", maxLength: 2000 },
    release_claim: { type: "boolean" },
  }, ["attempt_id", "idempotency_key", "actor_kind", "actor_id"]),
  tool("list_execution_acceptances", "List an attempt's acceptance runs, oldest first, with the step each reached, their commit, merge, push, and pull request identities, and any typed outcome.", {
    attempt_id: { type: "string" },
  }, ["attempt_id"]),
  tool("get_execution_acceptance", "Get one acceptance run by id.", {
    id: { type: "string" },
  }, ["id"]),
  tool("reconcile_execution", "Reconcile durable execution state with real processes and Git resources, for every attempt or one attempt_id, and record every decision. It resumes interrupted acceptances; applies run outcomes whose finish transition was lost; quarantines as stale running attempts whose supervisor heartbeat stopped (a harness process still alive is reported, never killed), missing worktrees, moved branches, and drifted bases; resumes failed, interrupted, or expired leases through provisioning; and releases leases of terminal attempts without removing dirty worktrees. Anything changed within min_age_ms (default 10 minutes) is left alone. Lapsed claims and worktrees no lease owns are reported.", {
    attempt_id: { type: "string" },
    min_age_ms: { type: "integer", minimum: 0, maximum: 86400000 },
    runner_stale_ms: { type: "integer", minimum: 50, maximum: 3600000 },
    limit: { type: "integer", minimum: 1, maximum: 1000 },
    actor_kind: { type: "string", enum: ["operator", "reconciler"] },
    actor_id: { type: "string", minLength: 1, maxLength: 200 },
  }),
  tool("list_reconciliation_runs", "List reconciliation runs, newest first, with their trigger, status, scope, and summary counts.", {
    limit: { type: "integer", minimum: 1, maximum: 200 },
  }),
  tool("get_reconciliation_run", "Get one reconciliation run with every decision it recorded.", {
    id: { type: "string" },
  }, ["id"]),
  tool("quarantine_execution_attempt", "Quarantine a live execution attempt for inspection as an operator: begin_reconciliation records its current state as the origin, so it can later resume there, fail, or be canceled through transition_execution_attempt.", {
    attempt_id: { type: "string" },
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
    actor_kind: { type: "string", enum: ["operator"] },
    actor_id: { type: "string", minLength: 1, maxLength: 200 },
    note: { type: "string", maxLength: 2000 },
  }, ["attempt_id", "idempotency_key", "actor_id"]),
  tool("verify_execution_attempt","Verify an attempt in verifying against its repository's latest verification policy. Captures a diff, runs each policy step in the leased worktree without a shell under the contract's step, output, and cancellation bounds, records an observation per step, then records a verdict and moves the attempt to reviewable, or to failed with checks_failed, evidence_missing, or stale_base_evidence. Each required step counts only the latest non-superseded observation made against the current tree fingerprint; claims never count, and a passing verdict never accepts the attempt. run_steps=false evaluates recorded evidence without running anything. If the attempt leaves verifying while a step runs, the step is stopped and no verdict is recorded.", {
    attempt_id: { type: "string" },
    run_steps: { type: "boolean" },
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
    step_timeout_ms: { type: "integer", minimum: 100 },
    cancellation_grace_ms: { type: "integer", minimum: 0 },
    captured_stream_bytes: { type: "integer", minimum: 1024 },
  }, ["attempt_id"]),
  tool("get_execution_attempt", "Get one execution attempt with its complete transition ledger.", {
    id: { type: "string" },
  }, ["id"]),
  tool("list_execution_attempts", "List execution attempts, newest first. Pass issue_id to enumerate an issue's complete attempt history, including retries and terminal attempts; include_terminal=false lists only live attempts.", {
    issue_id: { type: "string" },
    session_id: { type: "string" },
    state: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    include_terminal: { type: "boolean" },
    limit: { type: "number" },
  }),
  tool("transition_execution_attempt", "Apply one lifecycle event to an execution attempt under the execution contract in docs/AGENTIC_HARNESS.md. expected_revision is a compare-and-set guard; resending the latest request with the same idempotency_key returns the attempt unchanged. workspace and process identity bind once per attempt, and artifacts append references. Failures lead with a typed code such as invalid_transition, revision_conflict, or unauthorized_actor.", {
    attempt_id: { type: "string" },
    event: { type: "string", enum: [...executionEvents] },
    expected_revision: { type: "integer", minimum: 0 },
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
    actor_kind: { type: "string", enum: [...executionActorKinds] },
    actor_id: { type: "string", minLength: 1 },
    reason: { type: "string" },
    policy: { type: "string" },
    note: { type: "string", maxLength: 2000 },
    workspace: {
      type: "object",
      properties: { branch: { type: "string" }, worktree_path: { type: "string" }, lease_id: { type: "string" } },
      additionalProperties: false,
    },
    process: {
      type: "object",
      properties: { pid: { type: "integer", minimum: 1 }, started_at: { type: "string" } },
      additionalProperties: false,
    },
    artifacts: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        properties: { kind: { type: "string", pattern: "^[a-z][a-z0-9_]{0,49}$" }, ref: { type: "string", maxLength: 2000 } },
        required: ["kind", "ref"],
        additionalProperties: false,
      },
    },
  }, ["attempt_id", "event", "expected_revision", "idempotency_key", "actor_kind", "actor_id"]),
];

const describedToolNames = new Set(tools.map((entry) => entry.name));
for (const name of hubToolNames) {
  if (!describedToolNames.has(name)) throw new Error(`MCP tool schema missing for canonical tool: ${name}`);
}

async function handle(message: { id?: number; method?: string; params?: Record<string, unknown> }) {
  if (!message.id && message.method === "notifications/initialized") {
    return;
  }
  try {
    if (message.method === "initialize") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "claw-task-hub", version: APP_VERSION },
        },
      });
    } else if (message.method === "tools/list") {
      write({ jsonrpc: "2.0", id: message.id, result: { tools } });
    } else if (message.method === "tools/call") {
      const params = message.params as { name: string; arguments?: Record<string, unknown> };
      const result = await callHubTool(params.name, params.arguments ?? {});
      write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } else {
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
    }
  } catch (error) {
    write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
}

process.stdin.on("data", (chunk) => {
  stdin = Buffer.concat([stdin, chunk]);
  while (true) {
    const lineEnd = stdin.indexOf(Buffer.from("\n"));
    if (lineEnd < 0) return;
    const line = stdin.subarray(0, lineEnd).toString("utf8").replace(/\r$/, "");
    stdin = stdin.subarray(lineEnd + 1);
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      void handle(message);
    } catch (error) {
      write({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: error instanceof Error ? `Parse error: ${error.message}` : "Parse error",
        },
      });
    }
  }
});

process.stderr.write("Claw Task Hub MCP server ready.\n");
