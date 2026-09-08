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
