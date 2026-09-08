import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { removeTemporaryDirectory } from "./temp-dir.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-harness-"));
const env = { ...process.env, CLAW_TASK_HUB_DB: join(tempDir, "harness-smoke.sqlite") };
const bun = process.platform === "win32" ? "bun.exe" : "bun";

function runBun(args, input) {
  if (process.platform === "win32") {
    return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", ["bun", ...args].join(" ")], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      input,
    });
  }
  return spawnSync(bun, args, { cwd: process.cwd(), env, encoding: "utf8", input });
}

function runBunAsync(args) {
  const child = process.platform === "win32"
    ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", ["bun", ...args].join(" ")], {
      cwd: process.cwd(),
      env,
      windowsHide: true,
    })
    : spawn(bun, args, { cwd: process.cwd(), env });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve) => {
    child.on("error", (error) => resolve({ status: null, error, stdout, stderr }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function runHub(mode, tool, payload = {}) {
  const raw = JSON.stringify(payload);
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  const args = mode === "tools/list"
    ? ["run", "--silent", "hub", "--", "tools/list"]
    : ["run", "--silent", "hub", "--", "tools/call", tool, `base64:${b64}`];
  const result = runBun(args);
  if (result.status !== 0) {
    throw new Error(`hub ${tool ?? mode} failed\nerror:\n${result.error ?? ""}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`);
  }
  return JSON.parse(result.stdout);
}

async function runHubAsync(tool, payload = {}) {
  const raw = JSON.stringify(payload);
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  const result = await runBunAsync(["run", "--silent", "hub", "--", "tools/call", tool, `base64:${b64}`]);
  if (result.status !== 0) {
    throw new Error(`hub ${tool} failed\nerror:\n${result.error ?? ""}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`);
  }
  return JSON.parse(result.stdout);
}

function runHubExpectFailure(tool, payload = {}) {
  const raw = JSON.stringify(payload);
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  const started = Date.now();
  const result = runBun(["run", "--silent", "hub", "--", "tools/call", tool, `base64:${b64}`]);
  return { ...result, elapsedMs: Date.now() - started };
}

function runMigrationExpectFailure(args = ["import", "--pages", "1"]) {
  const started = Date.now();
  const result = runBun(["run", "--silent", "migrate:linear", "--", ...args]);
  return { ...result, elapsedMs: Date.now() - started };
}

function runMcpToolsList() {
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    "",
  ].join("\n");
  const result = runBun(["run", "--silent", "mcp"], input);
  if (result.status !== 0) {
    throw new Error(`mcp tools/list failed\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`);
  }
  const messages = String(result.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  const toolsList = messages.find((message) => message.id === 2);
  if (!toolsList?.result?.tools) throw new Error(`mcp tools/list response missing tools:\n${result.stdout ?? ""}`);
  return toolsList.result.tools;
}

function runMcpTool(tool, payload = {}) {
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: payload } }),
    "",
  ].join("\n");
  const started = Date.now();
  const result = runBun(["run", "--silent", "mcp"], input);
  if (result.status !== 0) {
    throw new Error(`mcp ${tool} process failed\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`);
  }
  const messages = String(result.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  const call = messages.find((message) => message.id === 2);
  return { message: call, elapsedMs: Date.now() - started };
}

function runMcpToolResult(tool, payload = {}) {
  const call = runMcpTool(tool, payload);
  if (call.message?.error) throw new Error(`MCP ${tool} failed: ${call.message.error.message}`);
  const text = call.message?.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error(`MCP ${tool} returned no text result`);
  return JSON.parse(text);
}

function spawnBun(args, extraEnv = {}) {
  const childEnv = { ...env, ...extraEnv };
  if (process.platform === "win32") {
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", ["bun", ...args].join(" ")], {
      cwd: process.cwd(),
      env: childEnv,
      windowsHide: true,
    });
  }
  return spawn(bun, args, { cwd: process.cwd(), env: childEnv, detached: true });
}

async function stopProcessTree(child) {
  if (!child.pid) return;
  let settled = false;
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("close", resolve);
  });
  exited.then(() => {
    settled = true;
  });
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (!settled && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function assertApiLinearImportAbsent() {
  const port = await getFreePort();
  const child = spawnBun(["run", "--silent", "api"], { PORT: String(port) });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (attempt === 59) throw new Error(`API did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/import/linear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert(response.status === 404, `normal API exposed Linear import route with ${response.status}`);
  } finally {
    await stopProcessTree(child);
  }
}

async function assertApiRejectsUnsafeBind() {
  const child = spawnBun(["run", "--silent", "api"], { CLAW_TASK_HUB_HOST: "0.0.0.0" });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const status = await new Promise((resolve) => {
    child.on("close", resolve);
  });
  assert(status !== 0, "API unexpectedly allowed non-loopback bind without unsafe flag");
  assert(stderr.includes("Refusing to bind Claw Task Hub API"), "unsafe bind failure did not explain the local-first guard");
}

async function assertUnsafeBindStillChecksCors() {
  const port = await getFreePort();
  const allowedOrigin = "https://trusted.example";
  const child = spawnBun(["run", "--silent", "api"], {
    PORT: String(port),
    CLAW_TASK_HUB_HOST: "0.0.0.0",
    CLAW_TASK_HUB_UNSAFE_BIND: "1",
    CLAW_TASK_HUB_CORS_ORIGINS: allowedOrigin,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (attempt === 59) throw new Error(`API did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }

    const rejected = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: "https://evil.example" },
    });
    assert(!rejected.headers.has("access-control-allow-origin"), "unsafe bind allowed an unconfigured browser origin");

    const allowed = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: allowedOrigin },
    });
    assert(allowed.ok, `configured browser origin failed with ${allowed.status}`);
    assert(allowed.headers.get("access-control-allow-origin") === allowedOrigin, "configured browser origin was not allowed");
  } finally {
    await stopProcessTree(child);
  }
}

async function assertApiCrudParity() {
  const port = await getFreePort();
  const child = spawnBun(["run", "--silent", "api"], { PORT: String(port) });
  let diagnostics = "";
  child.stdout?.on("data", (chunk) => { diagnostics += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { diagnostics += chunk.toString(); });
  const base = `http://127.0.0.1:${port}/api`;
  const request = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { "content-type": "application/json", ...options.headers },
    });
    const body = await response.json();
    return { response, body };
  };
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`${base}/health`);
        if (response.ok) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (attempt === 59) throw new Error(`API did not start\n${diagnostics}`);
    }

    const projectId = "api-crud-project";
    let result = await request("/projects", {
      method: "POST",
      body: JSON.stringify({ id: projectId, name: "API CRUD Project", status: "Todo", priority: 2 }),
    });
    assert(result.response.status === 201 && result.body.project.id === projectId, "HTTP create project failed");
    result = await request(`/projects/${projectId}`);
    assert(result.response.ok && result.body.project.name === "API CRUD Project", "HTTP get project failed");
    result = await request(`/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ status: "In Progress" }) });
    assert(result.response.ok && result.body.project.status === "In Progress", "HTTP update project failed");

    result = await request("/issues", {
      method: "POST",
      body: JSON.stringify({ id: "api-crud-issue", identifier: "API-1", title: "API CRUD Issue", project_id: projectId, status: "Todo", priority: 2 }),
    });
    assert(result.response.ok && result.body.issue.id === "api-crud-issue", "HTTP create issue failed");
    result = await request("/issues/API-1");
    assert(result.response.ok && result.body.issue.title === "API CRUD Issue", "HTTP get issue failed");
    result = await request("/issues/API-1", { method: "PATCH", body: JSON.stringify({ status: "In Progress" }) });
    assert(result.response.ok && result.body.issue.status === "In Progress", "HTTP update issue failed");
    result = await request("/issues/API-1", { method: "DELETE", body: JSON.stringify({ confirm: false }) });
    assert(result.response.status === 400, "HTTP issue deletion did not fail closed without confirmation");
    result = await request("/issues/API-1", { method: "DELETE", body: JSON.stringify({ confirm: true }) });
    assert(result.response.ok && result.body.deleted === true, "HTTP delete issue failed");
    result = await request(`/projects/${projectId}`, { method: "DELETE", body: JSON.stringify({ confirm: true }) });
    assert(result.response.ok && result.body.deleted === true, "HTTP delete project failed");

    result = await request("/databases", { method: "POST", body: JSON.stringify({ name: "API CRUD Database" }) });
    assert(result.response.status === 201 && result.body.active.id === "api-crud-database.sqlite", "HTTP create database failed");
    result = await request("/databases/api-crud-database.sqlite");
    assert(result.response.ok && result.body.database.active === true, "HTTP get database failed");
    result = await request("/databases/harness-smoke.sqlite", { method: "PATCH", body: JSON.stringify({ active: true }) });
    assert(result.response.ok && result.body.active.id === "harness-smoke.sqlite", "HTTP update database failed");
    result = await request("/databases/api-crud-database.sqlite", { method: "DELETE", body: JSON.stringify({ confirm: false }) });
    assert(result.response.status === 400, "HTTP database deletion did not fail closed without confirmation");
    result = await request("/databases/api-crud-database.sqlite", { method: "DELETE", body: JSON.stringify({ confirm: true }) });
    assert(
      result.response.ok && !result.body.databases.some((database) => database.id === "api-crud-database.sqlite"),
      `HTTP delete database failed: ${result.response.status} ${JSON.stringify(result.body)}`,
    );
  } finally {
    await stopProcessTree(child);
  }
}

try {
  const tools = runHub("tools/list");
  assert(!tools.tools.includes("import_linear"), "import_linear must not be exposed to normal harness tools");
  assert(!tools.tools.includes("backfill_linear_descriptions"), "backfill_linear_descriptions must not be exposed to normal harness tools");
  for (const name of [
    "dashboard", "refresh_data", "list_databases", "get_database", "create_database", "update_database", "activate_database", "delete_database",
    "list_projects", "get_project", "create_project", "update_project", "save_project", "delete_project", "list_project_updates", "save_project_update",
    "list_issues", "get_issue", "create_issue", "update_issue", "save_issue", "delete_issue", "save_comment", "list_issue_dependencies", "save_issue_dependency",
    "resolve_issue_dependency", "start_agent_session", "claim_issue", "release_issue_claim",
    "save_context_binding", "resolve_context_project",
  ]) {
    assert(tools.tools.includes(name), `expected harness tool is missing: ${name}`);
  }
  const mcpTools = runMcpToolsList();
  const mcpRefreshTool = mcpTools.find((tool) => tool.name === "refresh_data");
  assert(mcpRefreshTool, "MCP refresh_data tool is missing");
  const mcpRefreshCall = runMcpTool("refresh_data", { include_issues: false });
  assert(!mcpRefreshCall.message?.result?.isError, `MCP refresh_data failed: ${JSON.stringify(mcpRefreshCall.message)}`);
  const mcpRefreshSnapshot = JSON.parse(mcpRefreshCall.message.result.content[0].text);
  assert(Array.isArray(mcpRefreshSnapshot.projects), "MCP refresh_data did not return the shared project snapshot");
  assert(mcpRefreshSnapshot.includes_issues === false, "MCP refresh_data ignored include_issues:false");
  const listIssuesSchema = mcpTools.find((tool) => tool.name === "list_issues")?.inputSchema?.properties;
  assert(listIssuesSchema?.include_done?.type === "boolean", "MCP list_issues schema does not advertise include_done:boolean");
  assert(listIssuesSchema?.blocked?.type === "boolean", "MCP list_issues schema does not advertise blocked:boolean");
  const saveIssueSchema = mcpTools.find((tool) => tool.name === "save_issue")?.inputSchema?.properties;
  assert(saveIssueSchema?.issue_id?.type === "string", "MCP save_issue schema does not advertise issue_id:string");
  assert(saveIssueSchema?.allow_no_project?.type === "boolean", "MCP save_issue schema does not advertise allow_no_project:boolean");
  const acceptIssueSchema = mcpTools.find((tool) => tool.name === "accept_issue")?.inputSchema;
  assert(acceptIssueSchema?.required?.includes("issue_id"), "MCP accept_issue schema does not require issue_id");
  assert(acceptIssueSchema?.required?.includes("body"), "MCP accept_issue schema does not require acceptance evidence");
  const releaseClaimSchema = mcpTools.find((tool) => tool.name === "release_issue_claim")?.inputSchema?.properties;
  assert(releaseClaimSchema?.claim_id?.type === "string", "MCP release_issue_claim schema does not advertise claim_id:string");
  const saveContextBindingSchema = mcpTools.find((tool) => tool.name === "save_context_binding")?.inputSchema;
  assert(saveContextBindingSchema?.required?.includes("context_key"), "MCP save_context_binding schema does not require context_key");
  assert(saveContextBindingSchema?.properties?.project_id?.type === "string", "MCP save_context_binding schema does not advertise project_id:string");
  const saveProjectUpdateSchema = mcpTools.find((tool) => tool.name === "save_project_update")?.inputSchema;
  assert(saveProjectUpdateSchema?.required?.includes("project_id"), "MCP save_project_update schema does not require project_id");
  assert(saveProjectUpdateSchema?.required?.includes("body"), "MCP save_project_update schema does not require body");
  assert(saveProjectUpdateSchema?.properties?.body?.maxLength === 10000, "MCP save_project_update schema does not bound body length");
  const saveProjectSchema = mcpTools.find((tool) => tool.name === "save_project")?.inputSchema?.properties;
  assert(saveProjectSchema?.lead?.anyOf?.some((shape) => shape.type === "string"), "MCP save_project schema does not advertise lead");
  assert(saveProjectSchema?.target_date?.anyOf?.some((shape) => shape.format === "date"), "MCP save_project schema does not advertise target_date");
  assert(saveProjectSchema?.source?.type === "string", "MCP save_project schema does not advertise source");
  const saveDependencySchema = mcpTools.find((tool) => tool.name === "save_issue_dependency")?.inputSchema;
  assert(saveDependencySchema?.required?.includes("issue_id"), "MCP save_issue_dependency schema does not require issue_id");
  assert(saveDependencySchema?.required?.includes("blocker_issue_id"), "MCP save_issue_dependency schema does not require blocker_issue_id");
  for (const destructiveTool of ["delete_database", "delete_project", "delete_issue"]) {
    const schema = mcpTools.find((tool) => tool.name === destructiveTool)?.inputSchema;
    assert(schema?.required?.includes("confirm"), `MCP ${destructiveTool} does not require explicit confirmation`);
    assert(schema?.properties?.confirm?.const === true, `MCP ${destructiveTool} confirmation is not constrained to true`);
  }

  const dashboard = runHub("tools/call", "dashboard");
  assert(dashboard.counts.projects === 0, "fresh harness DB should start with no projects");

  const crudProject = runMcpToolResult("create_project", {
    id: "mcp-crud-project",
    name: "MCP CRUD Project",
    status: "Backlog",
    priority: 2,
  }).project;
  assert(crudProject.id === "mcp-crud-project", "MCP create_project returned the wrong project");
  assert(runMcpToolResult("get_project", { id: crudProject.id }).project.project.name === "MCP CRUD Project", "MCP get_project missed the created project");
  const updatedCrudProject = runMcpToolResult("update_project", { id: crudProject.id, status: "In Progress" }).project;
  assert(updatedCrudProject.status === "In Progress", "MCP update_project did not update the existing project");
  const missingProjectUpdate = runMcpTool("update_project", { id: "missing-project", status: "Done" });
  assert(missingProjectUpdate.message?.error?.message?.includes("Project not found"), "MCP update_project silently created a missing project");
  const crudIssue = runMcpToolResult("create_issue", {
    id: "mcp-crud-issue",
    identifier: "CRUD-1",
    title: "MCP CRUD Issue",
    project_id: crudProject.id,
    status: "Todo",
    priority: 2,
  }).issue;
  assert(crudIssue.id === "mcp-crud-issue", "MCP create_issue returned the wrong issue");
  assert(runMcpToolResult("get_issue", { id: "CRUD-1" }).issue.title === "MCP CRUD Issue", "MCP get_issue missed the created issue");
  const updatedCrudIssue = runMcpToolResult("update_issue", { id: "CRUD-1", status: "In Progress" }).issue;
  assert(updatedCrudIssue.status === "In Progress", "MCP update_issue did not update the existing issue");
  const rejectedAcceptance = runMcpTool("accept_issue", { issue_id: "CRUD-1", body: " " });
  assert(rejectedAcceptance.message?.error?.message?.includes("requires body"), "MCP accept_issue accepted empty evidence");
  assert(runMcpToolResult("get_issue", { id: "CRUD-1" }).issue.status === "In Progress", "Failed MCP acceptance closed the issue");
  const acceptedCrudIssue = runMcpToolResult("accept_issue", { issue_id: "CRUD-1", body: "CRUD lifecycle evidence passed." });
  assert(acceptedCrudIssue.issue.status_type === "completed", "MCP accept_issue did not complete the issue");
  assert(acceptedCrudIssue.comment.body.startsWith("Acceptance:"), "MCP accept_issue did not normalize the acceptance trail");
  assert(runMcpToolResult("get_issue", { id: "CRUD-1" }).issue.last_acceptance_comment.id === acceptedCrudIssue.comment.id, "MCP accept_issue did not persist evidence before completion");
  const unconfirmedIssueDelete = runMcpTool("delete_issue", { id: "CRUD-1" });
  assert(unconfirmedIssueDelete.message?.error?.message?.includes("confirm=true"), "MCP delete_issue did not fail closed without confirmation");
  assert(runMcpToolResult("delete_issue", { id: "CRUD-1", confirm: true }).deleted === true, "MCP delete_issue did not delete the issue");
  assert(runMcpToolResult("get_issue", { id: "CRUD-1" }).issue === null, "MCP deleted issue is still readable");
  assert(runMcpToolResult("delete_project", { id: crudProject.id, confirm: true }).deleted === true, "MCP delete_project did not delete the empty project");
  assert(runMcpToolResult("get_project", { id: crudProject.id }).project === null, "MCP deleted project is still readable");

  const createdDatabaseCatalogue = runMcpToolResult("create_database", { name: "Harness CRUD Database" });
  const createdDatabaseId = createdDatabaseCatalogue.active.id;
  assert(createdDatabaseId === "harness-crud-database.sqlite", `MCP create_database returned unexpected id ${createdDatabaseId}`);
  assert(runMcpToolResult("get_database", { id: createdDatabaseId }).database?.active === true, "MCP get_database missed the active created database");
  const restoredDatabaseCatalogue = runMcpToolResult("update_database", { id: "harness-smoke.sqlite", active: true });
  assert(restoredDatabaseCatalogue.active.id === "harness-smoke.sqlite", "MCP update_database did not activate the requested database");
  const unconfirmedDatabaseDelete = runMcpTool("delete_database", { id: createdDatabaseId });
  assert(unconfirmedDatabaseDelete.message?.error?.message?.includes("confirm=true"), "MCP delete_database did not fail closed without confirmation");
  const deletedDatabaseCatalogue = runMcpToolResult("delete_database", { id: createdDatabaseId, confirm: true });
  assert(!deletedDatabaseCatalogue.databases.some((database) => database.id === createdDatabaseId), "MCP delete_database left the database registered");

  const project = runHub("tools/call", "save_project", {
    external_id: "harness-smoke-project",
    name: "Harness Smoke Project",
    summary: "Temp project created by harness smoke.",
    status: "In Progress",
    priority: 2,
    lead: "Harness Agent",
    target_date: "2026-11-30",
    source: "local",
  }).project;
  assert(project.id, "save_project did not return an id");
  const projectUpdateByExternalId = runHub("tools/call", "save_project", {
    external_id: "harness-smoke-project",
    summary: "Updated without duplicating the project.",
  }).project;
  assert(projectUpdateByExternalId.id === project.id, "save_project external_id update created a duplicate project");
  assert(projectUpdateByExternalId.name === project.name, "save_project partial update discarded the existing project name");
  assert(projectUpdateByExternalId.lead === "Harness Agent", "save_project partial update discarded the configured lead");
  assert(projectUpdateByExternalId.target_date === "2026-11-30", "save_project partial update discarded the configured target date");
  const projects = runHub("tools/call", "list_projects").projects;
  assert(projects.some((item) => item.id === project.id), "list_projects did not return the saved project");
  assert(projects.filter((item) => item.external_id === "harness-smoke-project").length === 1, "save_project external_id update duplicated a project");
  const cliAcceptanceTarget = runHub("tools/call", "create_issue", {
    id: "cli-acceptance-target",
    identifier: "SAFE-1",
    title: "CLI acceptance target",
    project_id: project.id,
    status: "In Progress",
  }).issue;
  const cliAcceptance = runHub("tools/call", "accept_issue", {
    issue_id: cliAcceptanceTarget.identifier,
    body: "CLI acceptance-safe completion passed.",
  });
  assert(cliAcceptance.issue.status_type === "completed", "CLI accept_issue did not complete its target");
  assert(cliAcceptance.issue.last_acceptance_comment.id === cliAcceptance.comment.id, "CLI accept_issue did not return the stored acceptance trail");
  const firstProjectUpdate = runHub("tools/call", "save_project_update", {
    external_id: "harness-smoke-update",
    project_id: project.id,
    body: "Harness status update one.",
    health: "on_track",
    author: "Harness Smoke",
  }).update;
  const secondProjectUpdate = runHub("tools/call", "save_project_update", {
    external_id: "harness-smoke-update",
    project_id: project.id,
    body: "Harness status update revised.",
    health: "at_risk",
    author: "Harness Smoke",
  }).update;
  assert(secondProjectUpdate.id === firstProjectUpdate.id, "save_project_update external_id was not idempotent");
  const projectsAfterHealthUpdate = runHub("tools/call", "list_projects").projects;
  const configuredProject = projectsAfterHealthUpdate.find((item) => item.id === project.id);
  assert(configuredProject?.health === "at_risk", "list_projects did not expose the latest configured project health");
  assert(configuredProject?.target_date === "2026-11-30", "list_projects did not expose the configured project target date");
  const projectUpdates = runHub("tools/call", "list_project_updates", { project_id: project.id }).updates;
  assert(projectUpdates.length === 1 && projectUpdates[0].body === "Harness status update revised.", "list_project_updates missed the idempotent update");
  const projectDetail = runHub("tools/call", "get_project", { id: project.id }).project;
  assert(projectDetail.projectUpdates?.[0]?.id === firstProjectUpdate.id, "get_project did not expose first-class project updates");
  const contextBinding = runHub("tools/call", "save_context_binding", {
    context_key: "codex:harness-smoke",
    project_id: project.id,
    default_tab: "issues",
    harness: "codex",
    workspace_name: "Harness Smoke",
    cwd: "C:/work/claw-task-hub",
    repo_remote: "https://user:secret@example.com/Catfish-75/claw-task-hub.git",
    branch: "main",
    thread_id: "thread-harness-smoke",
    metadata: { smoke: true },
  }).binding;
  assert(contextBinding.project_id === project.id, "save_context_binding returned the wrong project");
  assert(contextBinding.url_path === `/projects/${encodeURIComponent(project.id)}/issues`, `save_context_binding returned the wrong URL path: ${contextBinding.url_path}`);
  assert(!String(contextBinding.repo_remote).includes("secret"), "save_context_binding leaked repository credentials");
  const resolvedContext = runHub("tools/call", "resolve_context_project", {
    repo_remote: "https://other:credential@example.com/Catfish-75/claw-task-hub.git",
    branch: "main",
  });
  assert(resolvedContext.project?.id === project.id, "resolve_context_project did not map repo_remote+branch to the saved project");
  const listedContextBindings = runHub("tools/call", "list_context_bindings", { harness: "codex" }).bindings;
  assert(listedContextBindings.some((binding) => binding.id === contextBinding.id), "list_context_bindings did not include the saved context binding");
  const fetchedContextBinding = runHub("tools/call", "get_context_binding", { context_key: "codex:harness-smoke" }).binding;
  assert(fetchedContextBinding.id === contextBinding.id, "get_context_binding(context_key) returned the wrong binding");
  const deletedContextBinding = runHub("tools/call", "delete_context_binding", { context_key: "codex:harness-smoke" });
  assert(deletedContextBinding.deleted === true, "delete_context_binding did not delete the saved binding");

  const missingProjectFailure = runHubExpectFailure("save_issue", {
    title: "Harness issue without project must fail",
    status: "Todo",
  });
  assert(missingProjectFailure.status !== 0, "save_issue without project_id unexpectedly succeeded");
  assert(missingProjectFailure.stderr.includes("project_id is required when creating an issue"), "save_issue without project_id did not explain the project requirement");
  const invalidProjectFailure = runHubExpectFailure("save_issue", {
    title: "Harness issue with invalid project must fail",
    project_id: "missing-project",
    status: "Todo",
  });
  assert(invalidProjectFailure.status !== 0, "save_issue with invalid project_id unexpectedly succeeded");
  assert(invalidProjectFailure.stderr.includes("Project not found: missing-project"), "save_issue invalid project_id did not explain the missing project");

  const createdIssue = runHub("tools/call", "save_issue", {
    title: "Harness smoke issue",
    description: "Created through CLI fallback by an agentic harness smoke.",
    project_id: project.id,
    status: "Todo",
    priority: 2,
    labels: ["harness-smoke"],
    source: "local",
  }).issue;
  assert(/^[A-Z][A-Z0-9]{1,8}-\d{1,6}$/.test(createdIssue.identifier), `issue identifier is not short: ${createdIssue.identifier}`);

  const blockerIssue = runHub("tools/call", "save_issue", {
    title: "Harness smoke prerequisite",
    description: "Explicit blocker used by harness smoke.",
    project_id: project.id,
    status: "Todo",
    priority: 2,
    labels: ["harness-smoke"],
    source: "local",
  }).issue;
  const dependency = runHub("tools/call", "save_issue_dependency", {
    external_id: "harness-smoke-dependency",
    issue_id: createdIssue.identifier,
    blocker_issue_id: blockerIssue.identifier,
    reason: "Prerequisite must land first.",
  }).dependency;
  assert(dependency.status === "open", "save_issue_dependency did not create an open blocker");
  const blockedIssue = runHub("tools/call", "get_issue", { id: createdIssue.identifier }).issue;
  assert(blockedIssue.status_type === "blocked" && blockedIssue.blocker_count === 1, "get_issue did not derive Blocked from an unresolved dependency");
  const blockerFilter = runHub("tools/call", "list_issues", { project_id: project.id, blocked: true }).issues;
  assert(blockerFilter.some((issue) => issue.id === createdIssue.id), "list_issues blocked:true missed the dependency-blocked issue");
  const dependencies = runHub("tools/call", "list_issue_dependencies", { issue_id: createdIssue.identifier }).dependencies;
  assert(dependencies.length === 1 && dependencies[0].id === dependency.id, "list_issue_dependencies missed the open blocker");
  const fetched = runHub("tools/call", "get_issue", { id: createdIssue.identifier }).issue;
  assert(fetched.id === createdIssue.id, "get_issue did not resolve the visible identifier");
  const issueIdAliasUpdate = runHub("tools/call", "save_issue", {
    issue_id: createdIssue.identifier,
    status: "In Progress",
    description: "Updated through save_issue issue_id alias.",
  }).issue;
  assert(issueIdAliasUpdate.id === createdIssue.id, "save_issue issue_id alias updated the wrong issue");
  assert(issueIdAliasUpdate.description === "Updated through save_issue issue_id alias.", "save_issue issue_id alias did not update description");
  const issueIdFailure = runHubExpectFailure("save_issue", {
    issue_id: "CTH-DOES-NOT-EXIST",
    title: "Wrong locator must not create a duplicate",
  });
  assert(issueIdFailure.status !== 0, "save_issue issue_id not-found unexpectedly succeeded");
  assert(issueIdFailure.stderr.includes("Issue not found: CTH-DOES-NOT-EXIST"), "save_issue issue_id not-found did not explain the missing issue");

  const firstComment = runHub("tools/call", "save_comment", {
    issue_id: createdIssue.identifier,
    external_id: "harness-smoke-comment",
    body: "First harness smoke comment.",
    author: "Harness Smoke",
    source: "local",
  }).comment;
  const secondComment = runHub("tools/call", "save_comment", {
    issue_id: createdIssue.identifier,
    external_id: "harness-smoke-comment",
    body: "Updated harness smoke comment.",
    author: "Harness Smoke",
    source: "local",
  }).comment;
  assert(secondComment.id === firstComment.id, "save_comment external_id was not idempotent");
  assert(secondComment.body === "Updated harness smoke comment.", "save_comment did not update the idempotent comment body");

  const session = runHub("tools/call", "start_agent_session", {
    id: "session-harness-smoke",
    agent_name: "Harness Smoke",
    harness: "CLI",
    ttl_minutes: 30,
  }).session;
  assert(session.id === "session-harness-smoke", "start_agent_session did not preserve requested session id");
  const blockedClaimFailure = runHubExpectFailure("claim_issue", {
    issue_id: createdIssue.identifier,
    session_id: session.id,
  });
  assert(blockedClaimFailure.status !== 0, "claim_issue unexpectedly accepted dependency-blocked work");
  assert(blockedClaimFailure.stderr.includes("is blocked; resolve its dependencies"), "claim_issue blocker guard did not explain the unresolved dependency");
  runHub("tools/call", "resolve_issue_dependency", { dependency_id: dependency.id });
  assert(runHub("tools/call", "list_issue_dependencies", { issue_id: createdIssue.identifier }).dependencies.length === 0, "resolve_issue_dependency left the blocker open");
  const claim = runHub("tools/call", "claim_issue", {
    issue_id: createdIssue.identifier,
    session_id: session.id,
    note: "Harness smoke owns this temp issue.",
    ttl_minutes: 30,
  }).claim;
  assert(claim.identifier === createdIssue.identifier, "claim_issue did not claim the expected issue");
  const claims = runHub("tools/call", "list_issue_claims", { issue_id: createdIssue.identifier }).claims;
  assert(claims.length === 1 && claims[0].id === claim.id, "list_issue_claims did not return the active smoke claim");
  const release = runHub("tools/call", "release_issue_claim", {
    claim_id: claim.id,
    status: "completed",
  });
  assert(release.released === true && release.claim.id === claim.id && release.claim.status === "completed", "release_issue_claim did not complete the claim by claim_id");
  const claimsAfterRelease = runHub("tools/call", "list_issue_claims", { issue_id: createdIssue.identifier }).claims;
  assert(!claimsAfterRelease.some((item) => item.id === claim.id), "list_issue_claims returned a completed claim after release");
  const claimsAfterStringFalse = runHub("tools/call", "list_issue_claims", {
    issue_id: createdIssue.identifier,
    include_released: "false",
  }).claims;
  assert(!claimsAfterStringFalse.some((item) => item.id === claim.id), "list_issue_claims include_released:\"false\" returned a completed claim");
  const claimHistory = runHub("tools/call", "list_issue_claims", {
    issue_id: createdIssue.identifier,
    include_released: "true",
  }).claims;
  assert(claimHistory.some((item) => item.id === claim.id && item.status === "completed" && item.released_at), "list_issue_claims include_released:\"true\" missed completed claim history");

  const completed = runHub("tools/call", "save_issue", {
    id: createdIssue.identifier,
    status: "Done",
  }).issue;
  assert(completed.status_type === "completed", "save_issue did not derive completed status_type");
  const completedClaimFailure = runHubExpectFailure("claim_issue", {
    issue_id: completed.identifier,
    session_id: session.id,
  });
  assert(completedClaimFailure.status !== 0, "claim_issue on a completed issue unexpectedly succeeded");
  assert(completedClaimFailure.stderr.includes(`Issue ${completed.identifier} is completed`), "claim_issue completed guard did not explain the closed issue");
  const completedCommentFailure = runHubExpectFailure("save_comment", {
    issue_id: completed.identifier,
    body: "This should not silently attach to completed work.",
  });
  assert(completedCommentFailure.status !== 0, "save_comment on a completed issue unexpectedly succeeded");
  assert(completedCommentFailure.stderr.includes(`Issue ${completed.identifier} is completed`), "save_comment completed guard did not explain the closed issue");
  const completedCommentOverride = runHub("tools/call", "save_comment", {
    issue_id: completed.identifier,
    body: "Deliberate historical maintenance note.",
    allow_closed: true,
  }).comment;
  assert(completedCommentOverride.issue_id === completed.id, "save_comment allow_closed did not target the completed issue");
  const completedClaimOverride = runHub("tools/call", "claim_issue", {
    issue_id: completed.identifier,
    session_id: session.id,
    allow_closed: true,
    ttl_minutes: 30,
  }).claim;
  assert(completedClaimOverride.identifier === completed.identifier, "claim_issue allow_closed did not target the completed issue");
  runHub("tools/call", "release_issue_claim", {
    claim_id: completedClaimOverride.id,
    status: "released",
  });

  const activeIssue = runHub("tools/call", "save_issue", {
    title: "Harness active discovery issue",
    description: "Stays active so include_done:false can prove completed rows are excluded.",
    project_id: project.id,
    status: "In Progress",
    priority: 2,
    labels: ["harness-smoke"],
    source: "local",
  }).issue;
  const activeDiscovery = runHub("tools/call", "list_issues", {
    project_id: project.id,
    include_done: false,
    limit: 20,
  }).issues;
  assert(activeDiscovery.some((issue) => issue.id === activeIssue.id), "include_done:false missed an active issue");
  assert(!activeDiscovery.some((issue) => issue.id === completed.id), "include_done:false returned a completed issue");
  assert(activeDiscovery.every((issue) => issue.status_type !== "completed"), "include_done:false active discovery included completed status_type");
  const mixedActiveDiscovery = runHub("tools/call", "list_issues", {
    project_id: project.id,
    status_type: ["started", "backlog"],
    include_done: false,
    limit: 20,
  }).issues;
  assert(mixedActiveDiscovery.some((issue) => issue.id === activeIssue.id), "status_type array with include_done:false missed active issue");
  assert(!mixedActiveDiscovery.some((issue) => issue.id === completed.id), "status_type array with include_done:false returned completed issue");
  const completedSuppressed = runHub("tools/call", "list_issues", {
    project_id: project.id,
    status_type: ["completed"],
    include_done: false,
    limit: 20,
  }).issues;
  assert(completedSuppressed.length === 0, "include_done:false did not suppress explicit completed status_type");

  const concurrentCreates = await Promise.all(
    Array.from({ length: 8 }, (_item, index) =>
      runHubAsync("save_issue", {
        title: `Concurrent harness issue ${index + 1}`,
        description: "Created in parallel to verify automatic CTH identifier allocation is serialized.",
        project_id: project.id,
        status: "Todo",
        priority: 3,
        labels: ["harness-smoke", "concurrency"],
        source: "local",
      }),
    ),
  );
  const concurrentIdentifiers = concurrentCreates.map((result) => result.issue?.identifier);
  assert(concurrentIdentifiers.every((identifier) => /^[A-Z][A-Z0-9]{1,8}-\d{1,6}$/.test(identifier)), "concurrent create returned a non-short identifier");
  assert(new Set(concurrentIdentifiers).size === concurrentIdentifiers.length, `concurrent creates reused identifiers: ${concurrentIdentifiers.join(", ")}`);

  const linearFailure = runHubExpectFailure("import_linear", {});
  assert(linearFailure.status !== 0, "import_linear unexpectedly succeeded");
  assert(linearFailure.elapsedMs < 5000, "import_linear did not fail fast locally");
  assert(linearFailure.stderr.includes("Unknown tool: import_linear"), "import_linear failure did not explain missing normal-runtime tool");
  const linearMcpFailure = runMcpTool("import_linear", {});
  assert(linearMcpFailure.message?.error?.message?.includes("Unknown tool: import_linear"), "MCP import_linear failure did not explain missing normal-runtime tool");
  assert(linearMcpFailure.elapsedMs < 5000, "MCP import_linear did not fail fast locally");
  const backfillFailure = runHubExpectFailure("backfill_linear_descriptions", {});
  assert(backfillFailure.status !== 0, "backfill_linear_descriptions unexpectedly succeeded");
  assert(backfillFailure.elapsedMs < 5000, "backfill_linear_descriptions did not fail fast locally");
  assert(backfillFailure.stderr.includes("Unknown tool: backfill_linear_descriptions"), "backfill_linear_descriptions failure did not explain missing normal-runtime tool");
  const backfillMcpFailure = runMcpTool("backfill_linear_descriptions", {});
  assert(backfillMcpFailure.message?.error?.message?.includes("Unknown tool: backfill_linear_descriptions"), "MCP backfill_linear_descriptions failure did not explain missing normal-runtime tool");
  assert(backfillMcpFailure.elapsedMs < 5000, "MCP backfill_linear_descriptions did not fail fast locally");
  const migrationFailure = runMigrationExpectFailure();
  assert(migrationFailure.status !== 0, "standalone Linear migration unexpectedly succeeded without explicit gate");
  assert(migrationFailure.elapsedMs < 5000, "standalone Linear migration did not fail fast locally");
  assert(migrationFailure.stderr.includes("CLAW_TASK_HUB_ALLOW_LINEAR_IMPORT=1"), "standalone Linear migration failure did not explain the explicit gate");
  const migrationBackfillFailure = runMigrationExpectFailure(["backfill-descriptions", "--limit", "1"]);
  assert(migrationBackfillFailure.status !== 0, "standalone Linear backfill unexpectedly succeeded without explicit gate");
  assert(migrationBackfillFailure.elapsedMs < 5000, "standalone Linear backfill did not fail fast locally");
  assert(migrationBackfillFailure.stderr.includes("CLAW_TASK_HUB_ALLOW_LINEAR_IMPORT=1"), "standalone Linear backfill failure did not explain the explicit gate");
  await assertApiLinearImportAbsent();
  await assertApiRejectsUnsafeBind();
  await assertUnsafeBindStillChecksCors();
  await assertApiCrudParity();

  console.log("Harness smoke passed");
} finally {
  removeTemporaryDirectory(tempDir);
}
