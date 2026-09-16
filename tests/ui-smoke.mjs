import { chromium } from "playwright";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { removeTemporaryDirectory } from "./temp-dir.mjs";

const tempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-ui-smoke-"));
const apiPort = await getFreePort();
const webPort = await getFreePort();
const env = {
  ...process.env,
  CLAW_TASK_HUB_DB: join(tempDir, "ui-smoke.sqlite"),
  CLAW_TASK_HUB_API_BASE: `http://127.0.0.1:${apiPort}/api`,
  CLAW_TASK_HUB_CORS_ORIGINS: `http://127.0.0.1:${webPort},http://localhost:${webPort}`,
  VITE_CLAW_TASK_HUB_API_BASE: `http://127.0.0.1:${apiPort}/api`,
};
const spawned = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, acceptDownloads: true });
const page = await context.newPage();
const pageDiagnostics = [];
const requestedPaths = [];

page.on("console", (message) => {
  if (["error", "warning"].includes(message.type())) {
    pageDiagnostics.push(`${message.type()}: ${message.text()}`);
  }
});
page.on("pageerror", (error) => {
  pageDiagnostics.push(`pageerror: ${error.message}`);
});
page.on("request", (request) => {
  requestedPaths.push(new URL(request.url()).pathname);
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runBun(args) {
  const result = spawnBunSync(args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `bun ${args.join(" ")} failed` +
        `\nerror:\n${result.error?.message ?? ""}` +
        `\nstdout:\n${result.stdout ?? ""}` +
        `\nstderr:\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout;
}

function spawnBunSync(args, options) {
  if (process.platform !== "win32") {
    return spawnSync("bun", args, options);
  }
  return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", bunCommand(args)], {
    ...options,
    windowsHide: true,
  });
}

function spawnBun(args, options) {
  if (process.platform !== "win32") {
    return spawn("bun", args, { ...options, detached: true });
  }
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", bunCommand(args)], {
    ...options,
    windowsHide: true,
  });
}

function bunCommand(args) {
  return ["bun", ...args.map((arg) => String(arg))].join(" ");
}

function runHub(tool, payload = {}) {
  const raw = JSON.stringify(payload);
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  return JSON.parse(runBun(["run", "--silent", "hub", "--", "tools/call", tool, `base64:${b64}`]));
}

function seedBulkTodoIssues(count) {
  const database = new Database(env.CLAW_TASK_HUB_DB, { strict: true });
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
  const child = spawnBun(args, {
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
  removeTemporaryDirectory(tempDir);
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
    return Number(group?.getAttribute("data-returned") ?? 0);
  }, label);
}

async function chooseInlineOption(ariaLabel, optionLabel) {
  const trigger = page.getByRole("button", { name: ariaLabel, exact: true });
  await trigger.click();
  const menu = page.getByRole("listbox", { name: `${ariaLabel} options`, exact: true });
  await menu.waitFor({ state: "visible" });
  const [triggerBox, menuBox] = await Promise.all([trigger.boundingBox(), menu.boundingBox()]);
  assert(triggerBox && menuBox, `${ariaLabel} dropdown geometry is unavailable`);
  assert(Math.abs(triggerBox.width - menuBox.width) <= 1, `${ariaLabel} list width ${menuBox.width} does not match its ${triggerBox.width}px trigger`);
  await menu.getByRole("option", { name: optionLabel, exact: true }).click();
}

async function assertInlineSelectsAreConsistent(container, label) {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
  const styles = await container.locator(".inline-control").evaluateAll((controls) => controls.map((control) => {
    const select = control.querySelector(".inline-select-trigger");
    const controlStyle = getComputedStyle(control);
    const selectStyle = select ? getComputedStyle(select) : null;
    const selectedValue = select?.querySelector("strong");
    const controlRect = control.getBoundingClientRect();
    const selectRect = select?.getBoundingClientRect();
    return {
      height: controlStyle.height,
      radius: controlStyle.borderRadius,
      background: controlStyle.backgroundColor,
      selectBackground: selectStyle?.backgroundColor,
      selectColor: selectStyle?.color,
      controlWidth: controlRect.width,
      selectWidth: selectRect?.width ?? 0,
      cursor: selectStyle?.cursor,
      disabled: select instanceof HTMLButtonElement ? select.disabled : false,
      valueClipped: selectedValue ? selectedValue.scrollWidth > selectedValue.clientWidth : true,
    };
  }));
  assert(styles.length > 0, `${label} has no inline dropdown controls`);
  for (const key of ["height", "radius", "background", "selectBackground", "selectColor"]) {
    assert(new Set(styles.map((style) => style[key])).size === 1, `${label} dropdowns do not share ${key}: ${JSON.stringify(styles)}`);
  }
  for (const style of styles) {
    assert(Math.abs(style.controlWidth - style.selectWidth) <= 1, `${label} dropdown trigger does not fill its control width: ${JSON.stringify(style)}`);
    assert(style.disabled ? style.cursor !== "pointer" : style.cursor === "pointer", `${label} dropdown does not signal its clickability: ${JSON.stringify(style)}`);
    assert(!style.valueClipped, `${label} dropdown abbreviates its selected value despite using a fixed reusable width: ${JSON.stringify(style)}`);
  }
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
runBun(["run", "--silent", "seed"]);
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

await ensureProcess(`http://127.0.0.1:${apiPort}/api/health`, ["run", "--silent", "api"], { PORT: String(apiPort) });
await ensureProcess(`http://127.0.0.1:${webPort}/`, ["run", "--silent", "dev:web", "--", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"]);

await page.goto(`http://127.0.0.1:${webPort}/projects/project_claw_task_hub_mvp/issues`, { waitUntil: "domcontentloaded" });
await waitForAppShell();
await page.getByRole("button", { name: "Issues", exact: true }).waitFor({ state: "visible", timeout: 15000 });
assert((await page.getByRole("button", { name: "Issues", exact: true }).getAttribute("class"))?.includes("active"), "Direct project issues URL did not activate the Issues tab");
assert(await page.locator(".searchbar input").getAttribute("placeholder") === "Search Claw Task Hub MVP", "Direct project issues URL did not load the project issue view");
assert(await page.getByRole("textbox", { name: "Search Claw Task Hub MVP" }).isVisible(), "Issue search does not have an accessible name");
await page.getByRole("button", { name: "New issue", exact: true }).click();
const initialIssueDialog = page.getByRole("dialog", { name: "New issue" });
assert(await initialIssueDialog.getByRole("textbox", { name: "Issue title" }).isVisible(), "Issue title field does not have an accessible name");
assert(await initialIssueDialog.getByRole("button", { name: "New issue priority P3" }).isVisible(), "Issue priority picker does not have an accessible name");
assert(await initialIssueDialog.getByRole("textbox", { name: "Issue description" }).isVisible(), "Issue description field does not have an accessible name");
await initialIssueDialog.getByRole("button", { name: "Close new issue" }).click();

await page.goto(`http://127.0.0.1:${webPort}/contexts/${encodeURIComponent("ui-smoke:project")}/activity`, { waitUntil: "domcontentloaded" });
await waitForAppShell();
const projectUpdateBody = `UI smoke project update ${Date.now()}`;
await page.getByLabel("Project update").waitFor({ state: "visible", timeout: 15000 });
const updateComposerStyles = await page.getByLabel("Project update").evaluate((textarea) => {
  const style = getComputedStyle(textarea);
  const composerStyle = getComputedStyle(textarea.closest(".update-composer"));
  return {
    resize: style.resize,
    fieldPadding: style.padding,
    composerPadding: composerStyle.padding,
    radius: style.borderRadius,
  };
});
assert(updateComposerStyles.resize === "none", `Project update textarea remains resizable: ${JSON.stringify(updateComposerStyles)}`);
assert(updateComposerStyles.fieldPadding === "12px", `Project update textarea padding is not canonical: ${JSON.stringify(updateComposerStyles)}`);
assert(updateComposerStyles.composerPadding === "16px", `Project update composer padding is not canonical: ${JSON.stringify(updateComposerStyles)}`);
assert(updateComposerStyles.radius === "7px", `Project update textarea radius is not canonical: ${JSON.stringify(updateComposerStyles)}`);
assert((await page.getByRole("button", { name: "Activity", exact: true }).getAttribute("class"))?.includes("active"), "Context URL did not activate the requested Activity tab");
await page.getByLabel("Project health").selectOption("at_risk");
await page.getByLabel("Project update").fill(projectUpdateBody);
await page.getByRole("button", { name: "Post update", exact: true }).click();
await page.getByText(projectUpdateBody, { exact: false }).waitFor({ state: "visible", timeout: 10000 });

await page.goto(`http://127.0.0.1:${webPort}/issues/LOCAL-3`, { waitUntil: "domcontentloaded" });
await waitForAppShell();
await page.locator(".issue-detail .detail-top", { hasText: "LOCAL-3" }).waitFor({ state: "visible", timeout: 15000 });
assert(await page.locator(".issue-detail h2", { hasText: "Verify paused issue status" }).isVisible(), "Direct issue URL did not select the requested issue");
assert(await page.locator(".linear-issue-row .agent-inline").count() === 0, "Compact issue rows still expose the redundant Agent column");
assert(await page.getByLabel("Accepted").count() === 0, "Issue rows still render a Done-like acceptance glyph");
const issueDetailSpacing = await page.locator(".issue-detail").evaluate((detail) => {
  const style = getComputedStyle(detail);
  return {
    left: style.paddingLeft,
    right: style.paddingRight,
    top: style.paddingTop,
    bottom: style.paddingBottom,
    scrollWidth: detail.scrollWidth,
    clientWidth: detail.clientWidth,
  };
});
assert(issueDetailSpacing.left === issueDetailSpacing.right && issueDetailSpacing.top === issueDetailSpacing.bottom, `Issue detail inset is uneven: ${JSON.stringify(issueDetailSpacing)}`);
assert(issueDetailSpacing.scrollWidth === issueDetailSpacing.clientWidth, `Issue detail overflows horizontally: ${JSON.stringify(issueDetailSpacing)}`);
const workflowBounds = await page.locator(".issue-detail .workflow-controls").evaluate((workflow) => {
  const select = workflow.querySelector("select");
  const form = workflow.querySelector(".dependency-form");
  if (!(select instanceof HTMLElement) || !(form instanceof HTMLElement)) throw new Error("Issue workflow controls are incomplete");
  const workflowRect = workflow.getBoundingClientRect();
  const selectRect = select.getBoundingClientRect();
  const formRect = form.getBoundingClientRect();
  const style = getComputedStyle(workflow);
  const contentRight = workflowRect.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
  return {
    contentRight,
    selectRight: selectRect.right,
    formRight: formRect.right,
    selectWidth: selectRect.width,
    workflowWidth: workflowRect.width,
  };
});
assert(Math.abs(workflowBounds.contentRight - workflowBounds.selectRight) <= 1, `Issue status select does not reach the workflow content edge: ${JSON.stringify(workflowBounds)}`);
assert(Math.abs(workflowBounds.contentRight - workflowBounds.formRight) <= 1, `Issue blocker form does not reach the workflow content edge: ${JSON.stringify(workflowBounds)}`);
assert(workflowBounds.selectWidth > workflowBounds.workflowWidth / 2, `Issue status select does not fill the available row width: ${JSON.stringify(workflowBounds)}`);
const snapshotsBeforeRead = requestedPaths.filter((path) => path === "/api/snapshot").length;
runHub("get_issue", { id: "LOCAL-3" });
await page.waitForTimeout(250);
assert(requestedPaths.filter((path) => path === "/api/snapshot").length === snapshotsBeforeRead, "Read-only CLI tool emitted a UI refresh signal");
runHub("update_issue", { id: "LOCAL-3", status: "In Progress" });
await page.waitForFunction(() => document.querySelector('select[aria-label="Issue status"]')?.value === "In Progress");
assert(requestedPaths.filter((path) => path === "/api/snapshot").length > snapshotsBeforeRead, "Successful CLI mutation did not explicitly refresh the open UI");
runHub("update_issue", { id: "LOCAL-3", status: "Paused" });
await page.waitForFunction(() => document.querySelector('select[aria-label="Issue status"]')?.value === "Paused");

await page.goto(`http://127.0.0.1:${webPort}/`, { waitUntil: "domcontentloaded" });
await waitForAppShell();
await page.locator(".project-row").filter({ hasText: "Claw Task Hub MVP" }).first().waitFor({ state: "visible", timeout: 15000 });
await page.screenshot({ path: "test-results/linearish-projects.png", fullPage: true });
assert(await page.getByText("Projects", { exact: true }).first().isVisible(), "Projects heading is missing");
const publicProjectRow = page.locator(".project-row").filter({ hasText: "Claw Task Hub MVP" }).first();
assert(await publicProjectRow.isVisible(), "Project table row is missing");
const projectHeaderName = page.locator(".project-head .project-name > span:last-child");
const publicProjectName = publicProjectRow.locator(".project-name > span:last-child");
const [normalHeaderBox, normalProjectNameBox] = await Promise.all([projectHeaderName.boundingBox(), publicProjectName.boundingBox()]);
assert(normalHeaderBox && normalProjectNameBox && Math.abs(normalHeaderBox.x - normalProjectNameBox.x) <= 1, "Project Name header is not aligned with the project-title column");
await page.setViewportSize({ width: 1920, height: 1080 });
const [maxHeaderBox, maxProjectNameBox] = await Promise.all([projectHeaderName.boundingBox(), publicProjectName.boundingBox()]);
assert(maxHeaderBox && maxProjectNameBox && Math.abs(maxHeaderBox.x - maxProjectNameBox.x) <= 1, "Project Name header becomes misaligned in a maximized viewport");
assert(Math.abs(maxProjectNameBox.x - normalProjectNameBox.x) <= 1, "Project-title left inset changes when the browser is maximized");
await page.screenshot({ path: "test-results/linearish-projects-maximized.png", fullPage: true });
await page.setViewportSize({ width: 1280, height: 960 });
assert(await publicProjectRow.getByText("At risk", { exact: true }).isVisible(), "Project row does not use the latest configured health update");
assert(await publicProjectRow.getByText("High", { exact: true }).isVisible(), "Project row does not show the configured priority label");
assert(await publicProjectRow.locator(".project-lead", { hasText: "UI Smoke" }).isVisible(), "Project row does not show the configured lead");
assert(await publicProjectRow.getByText("Oct 31, 2026", { exact: true }).isVisible(), "Project row does not show the configured target date");
assert(await publicProjectRow.getByText("In Progress", { exact: true }).isVisible(), "Project row does not show the configured status");
assert(await page.locator(".view-tabs .stack-icon").count() === 0, "Duplicate database icon is still present beside the project views");
assert(await page.getByRole("button", { name: /favorite/i }).count() === 0, "Unimplemented favorite button is still present");
assert((await page.locator(".address").textContent())?.trim() === "Claw Task Hub", "Top chrome does not identify Claw Task Hub");
const navTitleStyle = await page.locator(".address").evaluate((title) => {
  const titleRect = title.getBoundingClientRect();
  const chrome = title.closest(".top-chrome");
  const chromeRect = chrome?.getBoundingClientRect();
  if (!(chrome instanceof HTMLElement)) throw new Error("Top chrome is missing");
  const rgb = (color) => (color.match(/[\d.]+/g) ?? [0, 0, 0]).slice(0, 3).map(Number);
  const luminance = (color) => rgb(color).map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const foreground = getComputedStyle(title).color;
  const background = getComputedStyle(chrome).backgroundColor;
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return {
    fontSize: parseFloat(getComputedStyle(title).fontSize),
    fontWeight: Number(getComputedStyle(title).fontWeight),
    color: foreground,
    contrast: (values[0] + 0.05) / (values[1] + 0.05),
    chromeHeight: chromeRect?.height ?? 0,
    contained: Boolean(chromeRect && titleRect.top >= chromeRect.top && titleRect.bottom <= chromeRect.bottom),
    centerOffset: chromeRect ? Math.abs((titleRect.top + titleRect.bottom) / 2 - (chromeRect.top + chromeRect.bottom) / 2) : Infinity,
  };
});
assert(Math.abs(navTitleStyle.fontSize - 32) <= 0.1, `Top navigation title is not exactly 32px: ${JSON.stringify(navTitleStyle)}`);
assert(navTitleStyle.fontWeight >= 800, `Top navigation title remains too light: ${JSON.stringify(navTitleStyle)}`);
assert(navTitleStyle.contrast >= 7, `Dark-mode navigation title contrast is below 7:1: ${JSON.stringify(navTitleStyle)}`);
assert(navTitleStyle.chromeHeight >= 56, `Top chrome does not accommodate the 32px title: ${JSON.stringify(navTitleStyle)}`);
assert(navTitleStyle.contained, `Top navigation title escapes the top chrome: ${JSON.stringify(navTitleStyle)}`);
assert(navTitleStyle.centerOffset <= 1, `Top navigation title is not vertically centered: ${JSON.stringify(navTitleStyle)}`);
await page.setViewportSize({ width: 360, height: 800 });
const mobileNavTitle = await page.locator(".address").evaluate((title) => {
  const titleRect = title.getBoundingClientRect();
  const chromeRect = title.closest(".top-chrome")?.getBoundingClientRect();
  return {
    visible: titleRect.width > 0 && titleRect.height > 0,
    fontSize: parseFloat(getComputedStyle(title).fontSize),
    contained: Boolean(chromeRect && titleRect.left >= chromeRect.left && titleRect.right <= chromeRect.right && titleRect.top >= chromeRect.top && titleRect.bottom <= chromeRect.bottom),
  };
});
assert(mobileNavTitle.visible, `Top navigation title disappears at mobile width: ${JSON.stringify(mobileNavTitle)}`);
assert(Math.abs(mobileNavTitle.fontSize - 32) <= 0.1, `Mobile navigation title is not exactly 32px: ${JSON.stringify(mobileNavTitle)}`);
assert(mobileNavTitle.contained, `Mobile navigation title escapes the top chrome: ${JSON.stringify(mobileNavTitle)}`);
assert(await page.locator(".window-tab").isHidden(), "Database chrome did not collapse before the product title at mobile width");
assert(await page.getByRole("button", { name: "Refresh data", exact: true }).isVisible(), "Refresh control disappears at mobile width");
assert(await page.locator(".top-refresh-pill span").isHidden(), "Refresh label did not collapse to its icon at mobile width");
await page.setViewportSize({ width: 1280, height: 960 });
assert((await page.locator(".window-tab span").textContent())?.trim() === "ui-smoke", "Top chrome does not show the active database name without the implied SQLite extension");
const databaseReadPaths = new Set(["/api/snapshot", "/api/refresh", "/api/projects", "/api/issues"]);
const dataReadsBeforeHealthPoll = requestedPaths.filter((path) => databaseReadPaths.has(path)).length;
const healthRequest = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/health" && response.ok());
await healthRequest;
assert((await page.getByRole("status", { name: "Server healthy" }).getAttribute("class"))?.includes("healthy"), "Health polling did not show a successful check");
assert(requestedPaths.filter((path) => databaseReadPaths.has(path)).length === dataReadsBeforeHealthPoll, "Health polling triggered a database data fetch");
  const refreshControls = page.getByRole("button", { name: "Refresh data", exact: true });
  assert(await refreshControls.count() === 1, "Refresh data must have exactly one UI control");
  await page.route("**/api/refresh", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  }, { times: 1 });
  const explicitRefreshRequest = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/refresh" && response.request().method() === "POST" && response.ok());
  await refreshControls.click({ noWaitAfter: true });
  await page.waitForFunction(() => document.querySelector(".top-refresh-pill")?.getAttribute("aria-busy") === "true");
  assert(await refreshControls.locator(".refresh-spin").count() === 1, "Refresh data icon does not animate while refresh is in flight");
  assert(await refreshControls.isDisabled(), "Refresh data allows duplicate clicks while refresh is in flight");
  await explicitRefreshRequest;
  await page.waitForFunction(() => document.querySelector(".top-refresh-pill")?.getAttribute("aria-busy") === "false");
  await page.getByRole("button", { name: "Manage databases", exact: true }).click();
  assert(await page.getByRole("menuitem", { name: "Refresh data", exact: true }).count() === 0, "Database menu duplicates the top-nav Refresh data control");
const darkModeToggle = page.getByRole("menuitemcheckbox", { name: /Dark mode/ });
assert(await darkModeToggle.getAttribute("aria-checked") === "true", "Dark theme is not the default appearance");
await darkModeToggle.click();
assert(await page.locator("html").getAttribute("data-theme") === "light", "Dark mode control did not activate the light theme");
const lightStatusStyles = await publicProjectRow.locator(".status-pill").evaluate((pill) => {
  const style = getComputedStyle(pill);
  return { background: style.backgroundColor, color: style.color };
});
assert(lightStatusStyles.background !== "rgb(23, 23, 23)", `Light-mode status pill retained a dark background: ${lightStatusStyles.background}`);
assert(lightStatusStyles.background !== lightStatusStyles.color, "Light-mode status pill has no text contrast");
await darkModeToggle.click();
assert(await page.locator("html").getAttribute("data-theme") === "dark", "Dark mode control did not restore the existing dark theme");
await page.getByRole("button", { name: "Manage databases", exact: true }).click();
const allIssuesRequest = page.waitForResponse((response) => {
  const url = new URL(response.url());
  return url.pathname === "/api/snapshot" && url.searchParams.get("include_issues") === "true" && response.ok();
});
await page.getByRole("button", { name: "All issues", exact: true }).click();
await allIssuesRequest;
await page.getByLabel("Search All issues").waitFor({ state: "visible" });
assert(await page.getByRole("button", { name: "Filter projects", exact: true }).count() === 0, "Project filters were duplicated on the issue view");
await page.getByRole("button", { name: "All projects", exact: true }).click();
await publicProjectRow.waitFor({ state: "visible" });

await page.getByRole("button", { name: "Filter projects", exact: true }).click();
await page.getByLabel("Search projects").fill("Claw Task Hub");
await chooseInlineOption("Filter projects by health", "At risk");
assert(await publicProjectRow.isVisible(), "Project filters hid a matching configured project");
await chooseInlineOption("Filter projects by health", "Off track");
await page.getByText("No projects match the current filters.", { exact: true }).waitFor({ state: "visible" });
await page.getByRole("button", { name: /Clear/i }).click();
await publicProjectRow.waitFor({ state: "visible" });
await page.getByRole("button", { name: "Configure project view", exact: true }).click();
await chooseInlineOption("Sort projects", "Issue count");
assert((await page.getByRole("button", { name: "Sort projects", exact: true }).getAttribute("data-value")) === "issues", "Project view configuration did not apply issue-count sorting");
await assertInlineSelectsAreConsistent(page.locator(".project-view-config"), "Project filter and sort controls");

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
await page.getByRole("button", { name: "Issues", exact: true }).click();
const irrelevantRowsControl = page.getByRole("button", { name: "Issues per status", exact: true });
assert(await irrelevantRowsControl.isDisabled(), "Rows/group remains clickable when every status group has 50 or fewer issues");
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
assert(await page.getByRole("button", { name: "Add issue resource", exact: true }).count() === 0, "Inert Add issue resource control is still rendered");
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
const returnedIssueCount = await page.locator(".issue-group").evaluateAll((groups) => groups.reduce((sum, group) => sum + Number(group.getAttribute("data-returned") ?? 0), 0));
assert(issueRowCount < returnedIssueCount, `Issue list is not virtualized: mounted ${issueRowCount} of ${returnedIssueCount} returned rows`);
const firstIssueGroup = page.locator(".issue-group").first();
const firstGroupRows = await firstIssueGroup.locator(".linear-issue-row").count();
const collapseGroupButton = firstIssueGroup.getByRole("button", { name: /^Collapse / });
await collapseGroupButton.click();
assert(await firstIssueGroup.locator(".linear-issue-row").count() === 0, "Status-group collapse did not hide its issue rows");
const expandGroupButton = firstIssueGroup.getByRole("button", { name: /^Expand / });
assert(await expandGroupButton.getAttribute("aria-expanded") === "false", "Collapsed status group did not expose aria-expanded=false");
await expandGroupButton.click();
assert(await firstIssueGroup.locator(".linear-issue-row").count() === firstGroupRows, "Status-group expand did not restore its issue rows");
await assertNoDuplicateVisibleIssueCodes("seed project");
const limitSelect = page.getByRole("button", { name: "Issues per status", exact: true });
assert(await limitSelect.isVisible(), "Per-status issue limit selector is missing");
assert((await limitSelect.getAttribute("data-value")) === "50", "Per-status issue limit did not default to 50");
assert(await limitSelect.isEnabled(), "Per-status issue limit was disabled even though Todo has more than 50 issues");
await assertInlineSelectsAreConsistent(page.locator(".issues-screen"), "Issue filters");
await page.getByRole("button", { name: "Todo", exact: true }).click();
const todoRowsAt50 = await countRowsInGroup("Todo");
assert(todoRowsAt50 === 50, `Todo group did not show exactly 50 rows at the default per-status limit: ${todoRowsAt50}`);
const todoGroup = page.locator(".issue-group").filter({ has: page.locator(".group-head strong", { hasText: /^Todo$/ }) }).first();
assert((await todoGroup.locator(".group-head em").textContent())?.includes("/"), "Status-only filter discarded the group total");
const projectLimitRequest = page.waitForResponse((response) => {
  const url = new URL(response.url());
  return url.pathname === "/api/projects/project_claw_task_hub_mvp" && url.searchParams.get("issues_per_status") === "100" && response.ok();
});
await chooseInlineOption("Issues per status", "100");
await projectLimitRequest;
await page.waitForFunction(() => {
  const group = [...document.querySelectorAll(".issue-group")]
    .find((node) => node.querySelector(".group-head strong")?.textContent?.trim() === "Todo");
  return Number(group?.getAttribute("data-returned") ?? 0) > 50;
});
const todoRowsAt100 = await countRowsInGroup("Todo");
assert(todoRowsAt100 > todoRowsAt50, `Todo group did not expand after selecting 100 per status: ${todoRowsAt100}`);
await assertInlineSelectsAreConsistent(page.locator(".issues-screen"), "Issue filters after changing Rows/group");
await page.getByRole("button", { name: "All statuses", exact: true }).click();
const allGroupLabelsAfterLimitChange = (await page.locator(".group-head strong").allTextContents()).map((label) => label.trim());
assert(allGroupLabelsAfterLimitChange.includes("Canceled"), "Canceled issues are not shown as a status group");
const priorityFilter = page.getByRole("button", { name: "Filter issues by priority", exact: true });
const assigneeFilter = page.getByRole("button", { name: "Filter issues by assignee", exact: true });
const labelFilter = page.getByRole("button", { name: "Filter issues by label", exact: true });
assert(await priorityFilter.isVisible(), "Priority filter is missing");
assert(await assigneeFilter.isVisible(), "Assignee filter is missing");
assert(await labelFilter.isVisible(), "Label filter is missing");
await chooseInlineOption("Filter issues by priority", "P1");
let filteredRows = await page.locator(".linear-issue-row").allTextContents();
assert(filteredRows.some((row) => row.includes("Combined filter target")), "P1 filter omitted the matching issue");
assert(filteredRows.some((row) => row.includes("Priority-only filter decoy")), "P1 filter omitted another P1 issue");
assert(!filteredRows.some((row) => row.includes("Assignee-only filter decoy")), "P1 filter included a P2 issue");
await chooseInlineOption("Filter issues by assignee", "Filter Agent");
await chooseInlineOption("Filter issues by label", "filter-target");
filteredRows = await page.locator(".linear-issue-row").allTextContents();
assert(filteredRows.length === 1 && filteredRows[0].includes("Combined filter target"), `combined filters returned the wrong rows: ${filteredRows.join(" | ")}`);
await page.locator(".issue-detail h2", { hasText: "Combined filter target" }).waitFor({ state: "visible", timeout: 10000 });
await page.waitForFunction(() => {
  const params = new URL(window.location.href).searchParams;
  return params.get("priority") === "1" && params.get("assignee") === "Filter Agent" && params.get("label") === "filter-target";
});
assert(await page.getByText("1 shown", { exact: true }).isVisible(), "Filtered result count is wrong");
await page.getByRole("button", { name: "Clear filters", exact: true }).click();
assert((await priorityFilter.getAttribute("data-value")) === "all", "Clear filters did not reset priority");
assert((await assigneeFilter.getAttribute("data-value")) === "all", "Clear filters did not reset assignee");
assert((await labelFilter.getAttribute("data-value")) === "all", "Clear filters did not reset label");
const createdTitle = `UI smoke routed issue ${Date.now()}`;
await page.getByRole("button", { name: "New issue", exact: true }).click();
const newIssueDialog = page.getByRole("dialog", { name: "New issue" });
await newIssueDialog.getByRole("button", { name: "New issue priority P3" }).click();
await newIssueDialog.getByRole("menuitemradio", { name: "P1 Urgent" }).click();
assert(await newIssueDialog.getByRole("button", { name: "New issue priority P1" }).isVisible(), "New-issue priority pill did not retain P1");
await newIssueDialog.getByLabel("Issue title").fill(createdTitle);
await newIssueDialog.getByLabel("Issue description").fill("Created from a project page to verify issue routing.");
await newIssueDialog.getByRole("button", { name: "Create issue", exact: true }).click();
const routedIssues = runHub("list_issues", {
  project_id: "project_claw_task_hub_mvp",
  query: createdTitle,
  limit: 10,
});
assert(routedIssues.issues.length === 1, `Project-page issue create did not create exactly one routed issue: ${routedIssues.issues.length}`);
assert(routedIssues.issues[0].project_id === "project_claw_task_hub_mvp", `Project-page issue was routed to the wrong project: ${routedIssues.issues[0].project_id}`);
assert(routedIssues.issues[0].priority === 1, `New-issue priority pill did not persist P1: ${routedIssues.issues[0].priority}`);
await page.getByRole("button", { name: "New issue", exact: true }).click();
assert(await page.getByRole("dialog", { name: "New issue" }).getByRole("button", { name: "New issue priority P3" }).isVisible(), "New-issue priority did not reset to P3 after creation");
await page.getByRole("dialog", { name: "New issue" }).getByRole("button", { name: "Close new issue" }).click();
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

const newDatabaseName = `UI smoke database ${Date.now()}`;
const createDatabaseRequest = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/databases" && response.request().method() === "POST" && response.status() === 201);
await page.getByRole("button", { name: "Manage databases", exact: true }).click();
await page.getByRole("menuitem", { name: "Create database", exact: true }).click();
const databaseDialog = page.getByRole("dialog", { name: "New database" });
await databaseDialog.getByLabel("Database name").fill(newDatabaseName);
const selectedDatabasePath = join(tempDir, `selected-${Date.now()}.sqlite`);
assert(await databaseDialog.getByRole("button", { name: "Browse…", exact: true }).isVisible(), "Database dialog does not expose the native filesystem picker");
await databaseDialog.getByLabel("Database location").fill(selectedDatabasePath);
await databaseDialog.getByRole("button", { name: "Create database", exact: true }).click();
const createDatabaseResponse = await createDatabaseRequest;
const createdCatalogue = await createDatabaseResponse.json();
assert(createdCatalogue.active.id.endsWith(".sqlite"), "New database API did not return an active SQLite database");
assert(createdCatalogue.active.path === selectedDatabasePath, "New database was not created at the selected filesystem path");
assert(existsSync(selectedDatabasePath), "Selected SQLite database path was not created on disk");
await page.getByText("No projects yet.", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
assert((await page.locator(".window-tab span").textContent())?.trim() === createdCatalogue.active.name, "New database did not expose its logical name in the top chrome");
await page.getByRole("button", { name: "Manage databases", exact: true }).click();
assert(await page.getByRole("menu", { name: "Databases" }).isVisible(), "Database manager did not open");
assert(await page.getByRole("menuitemradio", { name: new RegExp(`${createdCatalogue.active.fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*active`, "i") }).isVisible(), "Database manager does not identify the active database by exact filename");

const activeDeleteResponse = await fetch(`${env.VITE_CLAW_TASK_HUB_API_BASE}/databases/${encodeURIComponent(createdCatalogue.active.id)}`, {
  method: "DELETE",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ confirm: true }),
});
assert(activeDeleteResponse.status === 409, `Active database deletion returned ${activeDeleteResponse.status} instead of 409`);
assert(existsSync(selectedDatabasePath), "Active database deletion protection removed the database file");

const activateOriginalRequest = page.waitForResponse((response) => {
  const url = new URL(response.url());
  return url.pathname.endsWith("/databases/ui-smoke.sqlite/activate") && response.request().method() === "POST" && response.ok();
});
await page.getByRole("menuitemradio", { name: "ui-smoke.sqlite", exact: true }).click();
await activateOriginalRequest;
await page.waitForFunction(() => document.querySelector(".window-tab span")?.textContent?.trim() === "ui-smoke");

await page.getByRole("button", { name: "Manage databases", exact: true }).click();
await page.getByRole("menuitem", { name: `Delete ${createdCatalogue.active.fileName}`, exact: true }).click();
const deleteDatabaseDialog = page.getByRole("dialog", { name: "Delete database?" });
assert(await deleteDatabaseDialog.getByText(createdCatalogue.active.fileName, { exact: true }).isVisible(), "Delete confirmation does not identify the database filename");
assert(await deleteDatabaseDialog.getByText(selectedDatabasePath, { exact: true }).isVisible(), "Delete confirmation does not show the exact database path");
const deleteDatabaseRequest = page.waitForResponse((response) => {
  const url = new URL(response.url());
  return decodeURIComponent(url.pathname).endsWith(`/databases/${createdCatalogue.active.id}`) && response.request().method() === "DELETE" && response.ok();
});
await deleteDatabaseDialog.getByRole("button", { name: "Delete database", exact: true }).click();
const deleteDatabaseResponse = await deleteDatabaseRequest;
const deletedCatalogue = await deleteDatabaseResponse.json();
assert(!deletedCatalogue.databases.some((database) => database.id === createdCatalogue.active.id), "Deleted database remains in the API catalogue");
assert(!existsSync(selectedDatabasePath), "Confirmed database deletion did not remove the SQLite file");
await page.getByRole("button", { name: "Manage databases", exact: true }).click();
assert(await page.getByRole("menuitem", { name: `Delete ${createdCatalogue.active.fileName}`, exact: true }).count() === 0, "Deleted database still has a delete action in the database menu");
assert(await page.getByRole("menuitemradio", { name: createdCatalogue.active.fileName, exact: true }).count() === 0, "Deleted database remains selectable in the database menu");

await browser.close();
console.log("UI smoke passed");
} finally {
  await browser.close().catch(() => undefined);
  cleanup();
}
