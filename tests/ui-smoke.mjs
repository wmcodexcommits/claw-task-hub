import { chromium } from "playwright";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import Database from "better-sqlite3";

const tempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-ui-smoke-"));
const apiPort = await getFreePort();
const webPort = await getFreePort();
const env = {
  ...process.env,
  CLAW_TASK_HUB_DB: join(tempDir, "ui-smoke.sqlite"),
  CLAW_TASK_HUB_CORS_ORIGINS: `http://127.0.0.1:${webPort},http://localhost:${webPort}`,
  VITE_CLAW_TASK_HUB_API_BASE: `http://127.0.0.1:${apiPort}/api`,
};
const spawned = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, acceptDownloads: true });
const page = await context.newPage();
const pageDiagnostics = [];

page.on("console", (message) => {
  if (["error", "warning"].includes(message.type())) {
    pageDiagnostics.push(`${message.type()}: ${message.text()}`);
  }
});
page.on("pageerror", (error) => {
  pageDiagnostics.push(`pageerror: ${error.message}`);
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNpm(args) {
  const result = spawnNpmSync(args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `npm ${args.join(" ")} failed` +
        `\nerror:\n${result.error?.message ?? ""}` +
        `\nstdout:\n${result.stdout ?? ""}` +
        `\nstderr:\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout;
}

function spawnNpmSync(args, options) {
  if (process.platform !== "win32") {
    return spawnSync("npm", args, options);
  }
  return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", npmCommand(args)], {
    ...options,
    windowsHide: true,
  });
}

function spawnNpm(args, options) {
  if (process.platform !== "win32") {
    return spawn("npm", args, { ...options, detached: true });
  }
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", npmCommand(args)], {
    ...options,
    windowsHide: true,
  });
}

function npmCommand(args) {
  return ["npm", ...args.map((arg) => String(arg))].join(" ");
}

function runHub(tool, payload = {}) {
  const raw = JSON.stringify(payload);
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  return JSON.parse(runNpm(["run", "-s", "hub", "--", "tools/call", tool, `base64:${b64}`]));
}

function seedBulkTodoIssues(count) {
  const database = new Database(env.CLAW_TASK_HUB_DB);
  try {
    const insert = database.prepare(`
      INSERT INTO issues (id, identifier, title, description, status, status_type, priority, project_id, team_id, labels, source, created_at, updated_at)
      VALUES (@id, @identifier, @title, @description, 'Todo', 'unstarted', 3, 'project_claw_task_hub_mvp', 'team_local', @labels, 'local', @created_at, @updated_at)
    `);
    const transaction = database.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const day = String((index % 28) + 1).padStart(2, "0");
        insert.run({
          id: `ui_limit_bulk_${index}`,
          identifier: `CTH-${960000 + index}`,
          title: `UI smoke per-status limit filler ${index + 1}`,
          description: "Seeded to verify per-status issue display limits.",
          labels: JSON.stringify(["ui-smoke", "display-limit"]),
          created_at: `2026-04-${day}T00:00:00.000Z`,
          updated_at: `2026-04-${day}T00:00:00.000Z`,
        });
      }
    });
    transaction();
  } finally {
    database.close();
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

async function isReachable(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForUrl(url, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isReachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function ensureProcess(url, args, extraEnv = {}) {
  const child = spawnNpm(args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, ...extraEnv },
  });
  spawned.push(child);
  child.stdout.on("data", () => undefined);
  child.stderr.on("data", () => undefined);
  await waitForUrl(url);
}

function cleanup() {
  for (const child of spawned) {
    if (!child.pid) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
  rmSync(tempDir, { recursive: true, force: true });
}

process.on("exit", cleanup);

async function assertNoDuplicateVisibleIssueCodes(scopeLabel) {
  const codes = (await page.locator(".linear-issue-row .issue-id").allTextContents())
    .map((code) => code.trim())
    .filter(Boolean);
  const duplicates = codes.filter((code, index) => codes.indexOf(code) !== index);
  assert(duplicates.length === 0, `Issue rows are duplicated in ${scopeLabel}: ${[...new Set(duplicates)].join(", ")}`);
}

async function countRowsInGroup(label) {
  return page.locator(".issue-group").evaluateAll((groups, groupLabel) => {
    const group = groups.find((node) => node.querySelector(".group-head strong")?.textContent?.trim() === groupLabel);
    return group?.querySelectorAll(".linear-issue-row").length ?? 0;
  }, label);
}

async function assertSelectOptionsAreDark(selectLocator, label) {
  const styles = await selectLocator.evaluate((select) => {
    const option = select.querySelector("option");
    const target = option ?? select;
    const computed = getComputedStyle(target);
    return { color: computed.color, backgroundColor: computed.backgroundColor };
  });
  assert(styles.color !== "rgb(154, 154, 154)", `${label} option text is still muted gray`);
  assert(styles.backgroundColor !== "rgb(255, 255, 255)", `${label} option background is still white`);
}

async function waitForAppShell() {
  try {
    await page.locator(".linear-shell").waitFor({ state: "visible", timeout: 30000 });
  } catch (error) {
    await page.screenshot({ path: "test-results/ui-smoke-shell-timeout.png", fullPage: true }).catch(() => undefined);
    const html = await page.content().catch(() => "<page content unavailable>");
    throw new Error(
      `Timed out waiting for Claw Task Hub shell.\n` +
        `URL: ${page.url()}\n` +
        `Diagnostics:\n${pageDiagnostics.join("\n") || "(none)"}\n` +
        `HTML preview:\n${html.slice(0, 2000)}`,
      { cause: error },
    );
  }
}

try {
runNpm(["run", "-s", "seed"]);
runHub("save_project", {
  id: "project_claw_task_hub_mvp",
  status: "In Progress",
  priority: 2,
  lead: "UI Smoke",
  target_date: "2026-10-31",
  source: "local",
});
seedBulkTodoIssues(70);
runHub("save_issue", {
  id: "LOCAL-3",
  external_id: "LOCAL-3",
  identifier: "LOCAL-3",
  title: "Verify paused issue status",
  description: "Seeded by UI smoke to verify paused filtering and icon semantics.",
  project_id: "project_claw_task_hub_mvp",
  status: "Paused",
  priority: 2,
  labels: ["ui-smoke"],
  source: "local",
});
runHub("save_issue", {
  id: "LOCAL-4",
  external_id: "LOCAL-4",
  identifier: "LOCAL-4",
  title: "Verify todo issue status",
  description: "Seeded by UI smoke to verify todo filtering.",
  project_id: "project_claw_task_hub_mvp",
  status: "Todo",
  priority: 3,
  labels: ["ui-smoke"],
  source: "local",
});
runHub("save_issue", {
  id: "LOCAL-5",
  external_id: "LOCAL-5",
  identifier: "LOCAL-5",
  title: "Verify canceled issue status",
  description: "Seeded by UI smoke to verify canceled grouping.",
  project_id: "project_claw_task_hub_mvp",
  status: "Canceled",
  priority: 3,
  labels: ["ui-smoke"],
  source: "local",
});
runHub("save_issue", {
  id: "LOCAL-6",
  external_id: "LOCAL-6",
  identifier: "LOCAL-6",
  title: "Combined filter target",
  description: "Matches priority, assignee, and label filters together.",
  project_id: "project_claw_task_hub_mvp",
  status: "In Progress",
  priority: 1,
  assignee: "Filter Agent",
  labels: ["filter-target", "ui-smoke"],
  source: "local",
});
runHub("save_issue", {
  id: "LOCAL-7",
  external_id: "LOCAL-7",
  identifier: "LOCAL-7",
  title: "Priority-only filter decoy",
  description: "Matches P1 but not the requested assignee.",
  project_id: "project_claw_task_hub_mvp",
  status: "Todo",
  priority: 1,
  labels: ["filter-decoy", "ui-smoke"],
  source: "local",
});
runHub("save_issue", {
  id: "LOCAL-8",
  external_id: "LOCAL-8",
  identifier: "LOCAL-8",
  title: "Assignee-only filter decoy",
  description: "Matches the assignee and label but not P1.",
  project_id: "project_claw_task_hub_mvp",
  status: "Paused",
  priority: 2,
  assignee: "Filter Agent",
  labels: ["filter-target", "ui-smoke"],
  source: "local",
});
runHub("save_issue", {
  id: "LOCAL-9",
  external_id: "LOCAL-9",
  identifier: "LOCAL-9",
  title: "Persistent blocked filter target",
  description: "Remains blocked after the dependency-backed issue is resolved.",
  project_id: "project_claw_task_hub_mvp",
  status: "Blocked",
  priority: 3,
  labels: ["blocked-filter", "ui-smoke"],
  source: "local",
});
runHub("save_comment", {
  issue_id: "LOCAL-1",
  body: "UI smoke seeded activity comment.",
  author: "UI Smoke",
  source: "local",
});
runHub("save_context_binding", {
  context_key: "ui-smoke:project",
  project_id: "project_claw_task_hub_mvp",
  default_tab: "issues",
  harness: "playwright",
  cwd: "C:/work/claw-task-hub",
  repo_remote: "https://example.com/Catfish-75/claw-task-hub.git",
  branch: "main",
  metadata: { smoke: true },
});

await ensureProcess(`http://127.0.0.1:${apiPort}/api/health`, ["run", "-s", "api"], { PORT: String(apiPort) });
await ensureProcess(`http://127.0.0.1:${webPort}/`, ["run", "-s", "dev:web", "--", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"]);

await page.goto(`http://127.0.0.1:${webPort}/projects/project_claw_task_hub_mvp/issues`, { waitUntil: "domcontentloaded" });
await waitForAppShell();
await page.getByRole("button", { name: "Issues", exact: true }).waitFor({ state: "visible", timeout: 15000 });
assert((await page.getByRole("button", { name: "Issues", exact: true }).getAttribute("class"))?.includes("active"), "Direct project issues URL did not activate the Issues tab");
assert(await page.locator(".searchbar input").getAttribute("placeholder") === "Search Claw Task Hub MVP", "Direct project issues URL did not load the project issue view");
assert(await page.getByRole("textbox", { name: "Search Claw Task Hub MVP" }).isVisible(), "Issue search does not have an accessible name");
assert(await page.getByRole("textbox", { name: "Issue title" }).isVisible(), "Issue title field does not have an accessible name");
assert(await page.getByRole("combobox", { name: "Issue priority" }).isVisible(), "Issue priority field does not have an accessible name");
assert(await page.getByRole("textbox", { name: "Issue description" }).isVisible(), "Issue description field does not have an accessible name");

await page.goto(`http://127.0.0.1:${webPort}/contexts/${encodeURIComponent("ui-smoke:project")}/activity`, { waitUntil: "domcontentloaded" });
await waitForAppShell();
const projectUpdateBody = `UI smoke project update ${Date.now()}`;
await page.getByLabel("Project update").waitFor({ state: "visible", timeout: 15000 });
assert((await page.getByRole("button", { name: "Activity", exact: true }).getAttribute("class"))?.includes("active"), "Context URL did not activate the requested Activity tab");
await page.getByLabel("Project health").selectOption("at_risk");
await page.getByLabel("Project update").fill(projectUpdateBody);
await page.getByRole("button", { name: "Post update", exact: true }).click();
await page.getByText(projectUpdateBody, { exact: false }).waitFor({ state: "visible", timeout: 10000 });

await page.goto(`http://127.0.0.1:${webPort}/issues/LOCAL-3`, { waitUntil: "domcontentloaded" });
await waitForAppShell();
await page.locator(".issue-detail .detail-top", { hasText: "LOCAL-3" }).waitFor({ state: "visible", timeout: 15000 });
assert(await page.locator(".issue-detail h2", { hasText: "Verify paused issue status" }).isVisible(), "Direct issue URL did not select the requested issue");

await page.goto(`http://127.0.0.1:${webPort}/`, { waitUntil: "domcontentloaded" });
await waitForAppShell();
await page.locator(".project-row").filter({ hasText: "Claw Task Hub MVP" }).first().waitFor({ state: "visible", timeout: 15000 });
await page.screenshot({ path: "test-results/linearish-projects.png", fullPage: true });
assert(await page.getByText("Projects", { exact: true }).first().isVisible(), "Projects heading is missing");
const publicProjectRow = page.locator(".project-row").filter({ hasText: "Claw Task Hub MVP" }).first();
assert(await publicProjectRow.isVisible(), "Project table row is missing");
assert(await publicProjectRow.getByText("At risk", { exact: true }).isVisible(), "Project row does not use the latest configured health update");
assert(await publicProjectRow.getByText("High", { exact: true }).isVisible(), "Project row does not show the configured priority label");
assert(await publicProjectRow.locator(".project-lead", { hasText: "UI Smoke" }).isVisible(), "Project row does not show the configured lead");
assert(await publicProjectRow.getByText("Oct 31, 2026", { exact: true }).isVisible(), "Project row does not show the configured target date");
assert(await publicProjectRow.getByText("In Progress", { exact: true }).isVisible(), "Project row does not show the configured status");

await page.getByRole("button", { name: "Filter projects", exact: true }).click();
await page.getByLabel("Search projects").fill("Claw Task Hub");
await page.getByLabel("Filter projects by health").selectOption("at_risk");
assert(await publicProjectRow.isVisible(), "Project filters hid a matching configured project");
await page.getByLabel("Filter projects by health").selectOption("off_track");
await page.getByText("No projects match the current filters.", { exact: true }).waitFor({ state: "visible" });
await page.getByRole("button", { name: /Clear/i }).click();
await publicProjectRow.waitFor({ state: "visible" });
await page.getByRole("button", { name: "Configure project view", exact: true }).click();
await page.getByLabel("Sort projects").selectOption("issues");
assert((await page.getByLabel("Sort projects").inputValue()) === "issues", "Project view configuration did not apply issue-count sorting");

await page.getByRole("button", { name: "New project", exact: true }).click();
const newProjectDialog = page.getByRole("dialog", { name: "New project" });
await newProjectDialog.waitFor({ state: "visible" });
assert(await page.getByLabel("Project lead").isVisible(), "New project form does not expose lead configuration");
assert(await page.getByLabel("Project target date").isVisible(), "New project form does not expose target-date configuration");
await page.getByLabel("Project name").fill("UI Configured Project");
await page.getByLabel("Project summary").fill("Created through the configured project form.");
await page.getByLabel("Project status").selectOption("Planned");
await page.getByLabel("Project priority").selectOption("4");
await page.getByLabel("Project lead").fill("UI Owner");
await page.getByLabel("Project target date").fill("2027-01-15");
await newProjectDialog.getByRole("button", { name: "Create project", exact: true }).click();
await page.locator(".project-hero h1", { hasText: "UI Configured Project" }).waitFor({ state: "visible", timeout: 10000 });
assert(await page.getByText("Jan 15, 2027", { exact: true }).isVisible(), "New project target date did not reach the overview");
await page.getByRole("button", { name: "Projects", exact: true }).click();
const configuredProjectRow = page.locator(".project-row").filter({ hasText: "UI Configured Project" }).first();
await configuredProjectRow.waitFor({ state: "visible", timeout: 10000 });
assert(await configuredProjectRow.locator(".project-lead", { hasText: "UI Owner" }).isVisible(), "New project lead did not reach the project list");
assert(await configuredProjectRow.getByText("Jan 15, 2027", { exact: true }).isVisible(), "New project target date did not reach the project list");

await publicProjectRow.scrollIntoViewIfNeeded();
await publicProjectRow.click();
await page.locator(".project-hero h1", { hasText: "Claw Task Hub MVP" }).waitFor({ state: "visible", timeout: 15000 });
assert(await page.getByRole("button", { name: "Overview", exact: true }).isVisible(), "Overview tab is missing");
assert(await page.getByRole("button", { name: "Activity", exact: true }).isVisible(), "Activity tab is missing");
assert(await page.getByRole("button", { name: "Issues", exact: true }).isVisible(), "Issues tab is missing");
assert(await page.getByText("Properties").isVisible(), "Overview properties are missing");
assert(await page.getByText("Resources").isVisible(), "Overview resources are missing");
const [shortcutDownload] = await Promise.all([
  page.waitForEvent("download"),
  page.getByRole("button", { name: "Download project shortcut" }).click(),
]);
assert(
  shortcutDownload.suggestedFilename() === "Open Claw Task Hub - Claw Task Hub MVP.url",
  `Unexpected project shortcut filename: ${shortcutDownload.suggestedFilename()}`,
);
const shortcutPath = await shortcutDownload.path();
assert(shortcutPath, "Project shortcut download did not produce a local file path");
const shortcutBody = readFileSync(shortcutPath, "utf8");
assert(
  shortcutBody.includes(`URL=http://127.0.0.1:${webPort}/projects/project_claw_task_hub_mvp/issues`),
  `Project shortcut points to the wrong URL: ${shortcutBody}`,
);
await page.screenshot({ path: "test-results/linearish-project-overview.png", fullPage: true });

await page.getByRole("button", { name: "Activity", exact: true }).click();
assert(await page.getByLabel("Project update").isVisible(), "Activity update composer is missing");
assert(await page.getByText(projectUpdateBody, { exact: false }).isVisible(), "Posted project update is missing from the activity timeline");
assert(await page.locator(".timeline-row").first().isVisible(), "Activity timeline is missing");
await page.screenshot({ path: "test-results/linearish-project-activity.png", fullPage: true });

await page.getByRole("button", { name: "Issues", exact: true }).click();
await page.locator(".group-head").first().waitFor({ state: "visible", timeout: 10000 });
const issueGroupCount = await page.locator(".group-head").count();
assert(issueGroupCount > 0, "Issue status groups are missing");
const visibleGroupLabels = await page.locator(".group-head strong").allTextContents();
assert(
  visibleGroupLabels.some((label) => label.trim().length > 0),
  `Issue status group labels are empty; saw: ${visibleGroupLabels.join(", ")}`,
);
const issueRowCount = await page.locator(".linear-issue-row").count();
assert(issueRowCount > 0, "issue rows are missing");
await assertNoDuplicateVisibleIssueCodes("seed project");
const limitSelect = page.getByLabel("Issues per status");
assert(await limitSelect.isVisible(), "Per-status issue limit selector is missing");
assert((await limitSelect.inputValue()) === "50", "Per-status issue limit did not default to 50");
await assertSelectOptionsAreDark(limitSelect, "Per-status limit");
await assertSelectOptionsAreDark(page.locator(".linear-create select[name='priority']"), "Priority");
await page.getByRole("button", { name: "Todo", exact: true }).click();
const todoRowsAt50 = await countRowsInGroup("Todo");
assert(todoRowsAt50 === 50, `Todo group did not show exactly 50 rows at the default per-status limit: ${todoRowsAt50}`);
const projectLimitRequest = page.waitForResponse((response) => {
  const url = new URL(response.url());
  return url.pathname === "/api/projects/project_claw_task_hub_mvp" && url.searchParams.get("issues_per_status") === "100" && response.ok();
});
await limitSelect.selectOption("100");
await projectLimitRequest;
await page.waitForFunction(() => {
  const group = [...document.querySelectorAll(".issue-group")]
    .find((node) => node.querySelector(".group-head strong")?.textContent?.trim() === "Todo");
  return (group?.querySelectorAll(".linear-issue-row").length ?? 0) > 50;
});
const todoRowsAt100 = await countRowsInGroup("Todo");
assert(todoRowsAt100 > todoRowsAt50, `Todo group did not expand after selecting 100 per status: ${todoRowsAt100}`);
await page.getByRole("button", { name: "All statuses", exact: true }).click();
const allGroupLabelsAfterLimitChange = (await page.locator(".group-head strong").allTextContents()).map((label) => label.trim());
assert(allGroupLabelsAfterLimitChange.includes("Canceled"), "Canceled issues are not shown as a status group");
const priorityFilter = page.getByLabel("Filter issues by priority");
const assigneeFilter = page.getByLabel("Filter issues by assignee");
const labelFilter = page.getByLabel("Filter issues by label");
assert(await priorityFilter.isVisible(), "Priority filter is missing");
assert(await assigneeFilter.isVisible(), "Assignee filter is missing");
assert(await labelFilter.isVisible(), "Label filter is missing");
await priorityFilter.selectOption("1");
let filteredRows = await page.locator(".linear-issue-row").allTextContents();
assert(filteredRows.some((row) => row.includes("Combined filter target")), "P1 filter omitted the matching issue");
assert(filteredRows.some((row) => row.includes("Priority-only filter decoy")), "P1 filter omitted another P1 issue");
assert(!filteredRows.some((row) => row.includes("Assignee-only filter decoy")), "P1 filter included a P2 issue");
await assigneeFilter.selectOption("Filter Agent");
await labelFilter.selectOption("filter-target");
filteredRows = await page.locator(".linear-issue-row").allTextContents();
assert(filteredRows.length === 1 && filteredRows[0].includes("Combined filter target"), `combined filters returned the wrong rows: ${filteredRows.join(" | ")}`);
await page.locator(".issue-detail h2", { hasText: "Combined filter target" }).waitFor({ state: "visible", timeout: 10000 });
await page.waitForFunction(() => {
  const params = new URL(window.location.href).searchParams;
  return params.get("priority") === "1" && params.get("assignee") === "Filter Agent" && params.get("label") === "filter-target";
});
assert(await page.getByText("1 shown", { exact: true }).isVisible(), "Filtered result count is wrong");
await page.getByRole("button", { name: "Clear issue filters" }).click();
assert((await priorityFilter.inputValue()) === "all", "Clear filters did not reset priority");
assert((await assigneeFilter.inputValue()) === "all", "Clear filters did not reset assignee");
assert((await labelFilter.inputValue()) === "all", "Clear filters did not reset label");
const createdTitle = `UI smoke routed issue ${Date.now()}`;
await page.locator(".linear-create input[name='title']").fill(createdTitle);
await page.locator(".linear-create input[name='description']").fill("Created from a project page to verify issue routing.");
await page.locator(".linear-create button").click();
await page.locator(".linear-issue-row").filter({ hasText: createdTitle }).first().waitFor({ state: "visible", timeout: 10000 });
const routedIssues = runHub("list_issues", {
  project_id: "project_claw_task_hub_mvp",
  query: createdTitle,
  limit: 10,
});
assert(routedIssues.issues.length === 1, `Project-page issue create did not create exactly one routed issue: ${routedIssues.issues.length}`);
assert(routedIssues.issues[0].project_id === "project_claw_task_hub_mvp", `Project-page issue was routed to the wrong project: ${routedIssues.issues[0].project_id}`);
const scopedSearchRequest = page.waitForRequest((request) => {
  const url = new URL(request.url());
  return url.pathname === "/api/issues" &&
    url.searchParams.get("project_id") === "project_claw_task_hub_mvp" &&
    url.searchParams.get("query") === createdTitle;
});
await page.locator(".searchbar input").fill(createdTitle);
await scopedSearchRequest;
const createdRow = page.locator(".linear-issue-row").filter({ hasText: createdTitle }).first();
await createdRow.waitFor({ state: "visible", timeout: 10000 });
await createdRow.dblclick();
await page.locator(".issue-dialog").waitFor({ state: "visible", timeout: 10000 });
const createdDialog = page.locator(".issue-dialog");
await createdDialog.getByLabel("Blocking issue").fill("LOCAL-4");
await createdDialog.getByLabel("Blocker reason").fill("UI smoke prerequisite");
await createdDialog.getByRole("button", { name: "Add blocker", exact: true }).click();
await createdDialog.locator(".dependency.open", { hasText: "LOCAL-4" }).waitFor({ state: "visible", timeout: 10000 });
await page.locator(".dialog-close").click();
await page.locator(".searchbar input").fill("");
await page.locator(".group-head").first().waitFor({ state: "visible", timeout: 10000 });
const firstIssueCode = (await page.locator(".linear-issue-row .issue-id").first().textContent())?.trim() ?? "";
assert(/^[A-Z][A-Z0-9]{1,8}-\d{1,6}$/.test(firstIssueCode), `Issue code is not short/local: ${firstIssueCode}`);
await page.locator(".linear-issue-row").first().dblclick();
await page.locator(".issue-dialog").waitFor({ state: "visible", timeout: 10000 });
const dialogCode = (await page.locator(".issue-dialog .detail-top span").first().textContent())?.trim() ?? "";
assert(dialogCode === firstIssueCode, `Issue dialog opened the wrong issue: ${dialogCode} !== ${firstIssueCode}`);
await page.locator(".dialog-close").click();
await page.getByRole("button", { name: /Blockers/i }).click();
const blockerClass = await page.getByRole("button", { name: /Blockers/i }).getAttribute("class");
assert(blockerClass?.includes("active"), "Blockers filter did not become active");
const blockedRow = page.locator(".linear-issue-row").filter({ hasText: createdTitle }).first();
await blockedRow.waitFor({ state: "visible", timeout: 10000 });
await blockedRow.dblclick();
await page.locator(".issue-dialog .dependency.open", { hasText: "LOCAL-4" }).waitFor({ state: "visible", timeout: 10000 });
await page.locator(".issue-dialog").getByRole("button", { name: "Resolve", exact: true }).click();
await page.locator(".issue-dialog .dependency.open", { hasText: "LOCAL-4" }).waitFor({ state: "detached", timeout: 10000 });
await page.locator(".dialog-close").click();
await page.locator(".linear-issue-row", { hasText: "Persistent blocked filter target" }).waitFor({ state: "visible", timeout: 10000 });
const remainingBlockerRows = await page.locator(".linear-issue-row").allTextContents();
assert(remainingBlockerRows.length === 1 && remainingBlockerRows[0].includes("Persistent blocked filter target"), `Blockers filter retained non-blocked rows: ${remainingBlockerRows.join(" | ")}`);
await page.locator(".issue-detail h2", { hasText: "Persistent blocked filter target" }).waitFor({ state: "visible", timeout: 10000 });
await page.setViewportSize({ width: 960, height: 900 });
const advancedFiltersBox = await page.locator(".issue-advanced-filters").boundingBox();
assert(advancedFiltersBox && advancedFiltersBox.x >= 0 && advancedFiltersBox.x + advancedFiltersBox.width <= 960, "Advanced issue filters overflow the 960px viewport");
await page.screenshot({ path: "test-results/linearish-project-issues.png", fullPage: true });
await page.setViewportSize({ width: 1280, height: 960 });

await page.getByRole("button", { name: "Paused", exact: true }).click();
const pausedButtonClass = await page.getByRole("button", { name: "Paused", exact: true }).getAttribute("class");
assert(pausedButtonClass?.includes("active"), "Paused filter did not become active");
const pausedFilterLabels = (await page.locator(".group-head strong").allTextContents()).map((label) => label.trim());
assert(pausedFilterLabels.length > 0, "Paused filter has no visible groups");
assert(
  pausedFilterLabels.every((label) => label === "Paused"),
  `Paused filter shows non-paused groups: ${pausedFilterLabels.join(", ")}`,
);
const pausedRows = await page.locator(".issue-group").evaluateAll((groups) => {
  const pausedGroup = groups.find((group) => group.querySelector(".group-head strong")?.textContent?.trim() === "Paused");
  if (!pausedGroup) return [];
  return [...pausedGroup.querySelectorAll(".linear-issue-row")]
    .map((row) => ({
      code: row.querySelector(".issue-id")?.textContent?.trim(),
      pausedIcons: row.querySelectorAll(".sicon.paused").length,
      blockerIcons: row.querySelectorAll(".sicon.blocker").length,
    }));
});
assert(pausedRows.length > 0, "seed project has no visible Paused issue to verify status icon semantics");
for (const row of pausedRows) {
  assert(row.pausedIcons === 1, `${row.code} does not show the Paused status icon`);
  assert(row.blockerIcons === 0, `${row.code} incorrectly shows a blocker icon`);
}
await page.getByRole("button", { name: "Backlog", exact: true }).click();
const backlogButtonClass = await page.getByRole("button", { name: "Backlog", exact: true }).getAttribute("class");
assert(backlogButtonClass?.includes("active"), "Backlog filter did not become active");
const backlogFilterLabels = (await page.locator(".group-head strong").allTextContents()).map((label) => label.trim());
assert(
  backlogFilterLabels.every((label) => label === "Backlog"),
  `Backlog filter shows non-backlog groups: ${backlogFilterLabels.join(", ")}`,
);
await page.getByRole("button", { name: "Todo", exact: true }).click();
const todoFilterLabels = (await page.locator(".group-head strong").allTextContents()).map((label) => label.trim());
assert(
  todoFilterLabels.every((label) => label === "Todo"),
  `Todo filter shows non-Todo groups: ${todoFilterLabels.join(", ")}`,
);

await browser.close();
console.log("UI smoke passed");
} finally {
  await browser.close().catch(() => undefined);
  cleanup();
}
