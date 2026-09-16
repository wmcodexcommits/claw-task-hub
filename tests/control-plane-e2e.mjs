// Control-plane end-to-end acceptance.
//
// One temporary hub, real Git repositories, the real API server and hub CLI, the
// deterministic fake harness, and the served UI in a browser:
//
//   1. claim an issue, pin the base, provision a leased worktree and branch,
//      launch the harness, record diff and verification evidence, reach
//      reviewable, accept under a local policy, and release the claim
//   2. restart the service during a run: startup reconciliation quarantines the
//      attempt, and the operator cancels it and retries to acceptance
//   3. in the browser, the execution panel shows attempt states and its controls
//      call the real handlers, including a typed error, keyboard activation, a
//      stale attempt canceled from the panel, the phone-width layout, and the
//      runnable queue
import { chromium } from "playwright";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { withoutRedirectingGitVariables } from "./git-environment.mjs";
import { stopProcessTree } from "./process-tree.mjs";
import { removeTemporaryDirectory } from "./temp-dir.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

const tempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-e2e-"));
const apiPort = await freePort();
const webPort = await freePort();
const gitConfig = join(tempDir, "gitconfig");
writeFileSync(gitConfig, "");
const env = {
  ...withoutRedirectingGitVariables(process.env),
  CLAW_TASK_HUB_DB: join(tempDir, "hub", "e2e.sqlite"),
  CLAW_TASK_HUB_WORKSPACE_ROOT: join(tempDir, "workspaces"),
  CLAW_TASK_HUB_API_BASE: `http://127.0.0.1:${apiPort}/api`,
  CLAW_TASK_HUB_CORS_ORIGINS: `http://127.0.0.1:${webPort},http://localhost:${webPort}`,
  VITE_CLAW_TASK_HUB_API_BASE: `http://127.0.0.1:${apiPort}/api`,
  CLAW_TASK_HUB_QUIET_DB: "1",
  CLAW_TASK_HUB_ENABLE_FAKE_HARNESS: "1",
  CLAW_TASK_HUB_RUNNER_HEARTBEAT_MS: "200",
  GIT_CONFIG_GLOBAL: gitConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "E2E Test",
  GIT_AUTHOR_EMAIL: "e2e@example.com",
  GIT_COMMITTER_NAME: "E2E Test",
  GIT_COMMITTER_EMAIL: "e2e@example.com",
};
const children = [];
let browser = null;

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stderr}`);
  return result.stdout.trim();
}

function createRepository(name, remote) {
  const dir = join(tempDir, "repos", name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "-b", "main");
  writeFileSync(join(dir, "README.md"), `${name}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "base");
  git(dir, "remote", "add", "origin", remote);
  return { dir: realpathSync.native(dir), remote, base: git(dir, "rev-parse", "HEAD") };
}

function cli(tool, payload) {
  const result = spawnSync(process.execPath, ["server/hub-cli.ts", "tools/call", tool, `base64:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}`], { cwd: process.cwd(), env, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`hub ${tool} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function http(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api${path}`, { ...options, headers: { "content-type": "application/json" } });
  const body = await response.json();
  return { status: response.status, body };
}

const post = (path, body) => http(path, { method: "POST", body: JSON.stringify(body) });

async function expectOk(promise, message) {
  const result = await promise;
  assert(result.status >= 200 && result.status < 300, `${message}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function waitFor(check, message, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out: ${message}`);
    await sleep(200);
  }
}

async function startApi(extraEnv = {}) {
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: process.cwd(), env: { ...env, PORT: String(apiPort), ...extraEnv }, windowsHide: true, detached: process.platform !== "win32" });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok;
    } catch {
      return false;
    }
  }, `API start\n${output}`);
  return child;
}

function startWeb() {
  const args = ["run", "--silent", "dev:web", "--", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"];
  const child = process.platform === "win32"
    ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", ["bun", ...args].join(" ")], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    : spawn("bun", args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.on("data", () => undefined);
  child.stderr.on("data", () => undefined);
  children.push(child);
  return child;
}

async function claimedIssue(projectId, title, sessionId) {
  const { issue } = cli("save_issue", { title, project_id: projectId, status: "Todo" });
  const { claim } = cli("claim_issue", { issue_id: issue.id, session_id: sessionId, ttl_minutes: 240 });
  return { issue, claim };
}

async function reviewable(repo, target, label) {
  const created = await expectOk(post(`/issues/${target.issue.id}/execution-attempts`, {
    claim_id: target.claim.id, harness: "fake", repository: repo.remote, base_sha: repo.base, idempotency_key: `e2e-create-${label}`, repository_path: repo.dir,
  }), `creating the ${label} attempt`);
  const launched = await expectOk(post(`/execution-attempts/${created.attempt.id}/launch`, {
    adapter: "fake", prompt: JSON.stringify({ write: [{ path: "feature.txt", content: `${label}\n` }] }), idempotency_key: `e2e-launch-${label}`, wait: true,
  }), `launching the ${label} attempt`);
  assert(launched.outcome?.event === "complete_run", `the ${label} run must complete: ${JSON.stringify(launched.outcome)}`);
  const verified = await expectOk(post(`/execution-attempts/${created.attempt.id}/verify`, {}), `verifying the ${label} attempt`);
  assert(verified.attempt.state === "reviewable", `the ${label} attempt must be reviewable: ${JSON.stringify(verified.verdict?.payload)}`);
  return { attempt: verified.attempt, workspace: created.workspace };
}

try {
  const repo = createRepository("service", "https://example.com/claw/e2e.git");
  const uiRepo = createRepository("ui-service", "https://example.com/claw/e2e-ui.git");
  const unitStep = [{ name: "unit", command: [process.execPath, "-e", "require('fs').accessSync('feature.txt')"] }];
  let api = await startApi({ CLAW_TASK_HUB_RECONCILE: "0" });

  // --- 1. the accepted path ------------------------------------------------------------------------

  const { project } = cli("save_project", { name: "E2E Control Plane" });
  cli("start_agent_session", { id: "session-e2e", agent_name: "E2E Agent", harness: "codex", ttl_minutes: 240 });
  for (const repository of [repo.remote, uiRepo.remote]) {
    await expectOk(post("/verification-policies", { repository, steps: unitStep, actor_kind: "operator", actor_id: "operator-e2e" }), "saving a verification policy");
  }
  await expectOk(post("/acceptance-policies", { repository: repo.remote, settings: {}, actor_kind: "operator", actor_id: "operator-e2e" }), "saving an acceptance policy");

  const first = await claimedIssue(project.id, "E2E accepted path", "session-e2e");
  const queue = await expectOk(http(`/runnable-issues?project_id=${project.id}&session_id=session-e2e`), "reading the runnable queue");
  assert(queue.runnable.some((entry) => entry.issue.id === first.issue.id), "the claimed issue must be runnable for its own session");

  const accepted = await reviewable(repo, first, "first");
  assert(accepted.workspace.status === "active" && accepted.attempt.base_sha === repo.base, "the attempt must pin the base and lease a worktree");
  const evidence = await expectOk(http(`/execution-attempts/${accepted.attempt.id}/evidence`), "reading evidence");
  const kinds = new Set(evidence.evidence.map((record) => record.kind));
  assert(kinds.has("diff") && kinds.has("observation") && kinds.has("verdict"), `diff, test, and verdict evidence must be recorded: ${[...kinds]}`);
  assert(evidence.evidence.find((record) => record.kind === "diff").payload.files.some((file) => file.path === "feature.txt"), "the diff must record the harness's change");

  const acceptance = await expectOk(post(`/execution-attempts/${accepted.attempt.id}/accept`, { idempotency_key: "e2e-accept-first", actor_kind: "operator", actor_id: "operator-e2e" }), "accepting");
  assert(acceptance.acceptance.status === "accepted" && acceptance.attempt.state === "accepted", `the attempt must be accepted: ${JSON.stringify(acceptance.acceptance)}`);
  assert(git(repo.dir, "show", `${acceptance.acceptance.commit_sha}:feature.txt`) === "first", "the accepted commit must hold the change");
  const claims = cli("list_issue_claims", { issue_id: first.issue.id, include_released: true }).claims;
  assert(claims[0].status === "completed", "the claim must be released as completed");
  assert((await expectOk(http(`/issues/${first.issue.id}`), "reading the issue")).issue.status === "Done", "the issue must be Done");

  // --- 2. recovery after a service restart --------------------------------------------------------------

  const second = await claimedIssue(project.id, "E2E recovery path", "session-e2e");
  const interrupted = await expectOk(post(`/issues/${second.issue.id}/execution-attempts`, {
    claim_id: second.claim.id, harness: "fake", repository: repo.remote, base_sha: repo.base, idempotency_key: "e2e-create-interrupted", repository_path: repo.dir,
  }), "creating the interrupted attempt");
  await expectOk(post(`/execution-attempts/${interrupted.attempt.id}/launch`, { adapter: "fake", prompt: JSON.stringify({ sleep_ms: 60_000 }), idempotency_key: "e2e-launch-interrupted" }), "launching the long run");
  await waitFor(async () => (await http(`/execution-attempts/${interrupted.attempt.id}`)).body.attempt.state === "running", "the long run to start");

  await stopProcessTree(api);
  await sleep(1500);
  api = await startApi({ CLAW_TASK_HUB_RECONCILE_MIN_AGE_MS: "0", CLAW_TASK_HUB_RUNNER_STALE_MS: "1000" });
  const stale = await waitFor(async () => {
    const { body } = await http(`/execution-attempts/${interrupted.attempt.id}`);
    return body.attempt.state === "stale" ? body.attempt : null;
  }, "startup reconciliation to quarantine the interrupted run");
  assert(stale.state_reason === "heartbeat_lost", `the interrupted run must be quarantined for its lost heartbeat: ${stale.state_reason}`);
  const runs = (await expectOk(http("/execution-reconciliation/runs?limit=5"), "listing reconciliation runs")).runs;
  const startup = await expectOk(http(`/execution-reconciliation/runs/${runs.find((run) => run.trigger === "startup").id}`), "reading the startup run");
  assert(startup.run.decisions.some((decision) => decision.attempt_id === interrupted.attempt.id && decision.action === "quarantined"), "the startup run must record the quarantine");
  assert((await http(`/execution-attempts/${accepted.attempt.id}`)).body.attempt.state === "accepted", "accepted work must survive the restart");

  await expectOk(post(`/execution-attempts/${interrupted.attempt.id}/transitions`, { event: "cancel", expected_revision: stale.revision, idempotency_key: "e2e-cancel-stale", actor_kind: "operator", actor_id: "operator-e2e", reason: "operator_requested" }), "canceling the stale attempt");
  const retry = await expectOk(post(`/issues/${second.issue.id}/execution-attempts`, {
    claim_id: second.claim.id, harness: "fake", repository: repo.remote, base_sha: repo.base, retry_of: interrupted.attempt.id, idempotency_key: "e2e-create-retry", repository_path: repo.dir,
  }), "creating the retry");
  await expectOk(post(`/execution-attempts/${retry.attempt.id}/launch`, { adapter: "fake", prompt: JSON.stringify({ write: [{ path: "feature.txt", content: "retry\n" }] }), idempotency_key: "e2e-launch-retry", wait: true }), "launching the retry");
  await expectOk(post(`/execution-attempts/${retry.attempt.id}/verify`, {}), "verifying the retry");
  const retried = await expectOk(post(`/execution-attempts/${retry.attempt.id}/accept`, { idempotency_key: "e2e-accept-retry", actor_kind: "operator", actor_id: "operator-e2e" }), "accepting the retry");
  assert(retried.attempt.state === "accepted" && retried.attempt.retry_of === interrupted.attempt.id, "the retry must be accepted and linked to the attempt it retries");

  // --- 3. the served UI ------------------------------------------------------------------------------------

  const uiTarget = await claimedIssue(project.id, "E2E browser review", "session-e2e");
  await reviewable(uiRepo, uiTarget, "browser");
  const staleTarget = await claimedIssue(project.id, "E2E browser stale", "session-e2e");
  const staleAttempt = await expectOk(post(`/issues/${staleTarget.issue.id}/execution-attempts`, {
    claim_id: staleTarget.claim.id, harness: "fake", repository: uiRepo.remote, base_sha: uiRepo.base, idempotency_key: "e2e-create-browser-stale", repository_path: uiRepo.dir,
  }), "creating the stale fixture");
  await expectOk(post(`/execution-attempts/${staleAttempt.attempt.id}/transitions`, { event: "mark_stale", expected_revision: 0, idempotency_key: "e2e-mark-stale", actor_kind: "reconciler", actor_id: "e2e", reason: "lease_expired" }), "quarantining the fixture");

  startWeb();
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${webPort}/`)).ok;
    } catch {
      return false;
    }
  }, "the web server to start");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`http://127.0.0.1:${webPort}/issues/${uiTarget.issue.identifier}`, { waitUntil: "domcontentloaded" });
  const panel = page.getByRole("region", { name: "Execution control" }).first();
  await panel.locator('.execution-attempt[data-state="reviewable"]').waitFor({ state: "visible", timeout: 30_000 });
  assert((await panel.locator(".execution-state").textContent())?.trim() === "Reviewable", "the panel must name the state");
  const unnamed = await panel.locator("button").evaluateAll((buttons) => buttons.filter((button) => !(button.getAttribute("aria-label") || button.textContent || "").trim()).length);
  assert(unnamed === 0, "every panel control must have an accessible name");

  // No acceptance policy for this repository yet: the typed refusal is shown.
  await panel.getByRole("button", { name: "Accept attempt" }).focus();
  await page.keyboard.press("Enter");
  const alert = panel.getByRole("alert");
  await alert.waitFor({ state: "visible", timeout: 30_000 });
  assert((await alert.textContent())?.includes("policy_not_found"), `the refusal must show its code: ${await alert.textContent()}`);
  await expectOk(post("/acceptance-policies", { repository: uiRepo.remote, settings: {}, actor_kind: "operator", actor_id: "operator-e2e" }), "saving the UI acceptance policy");
  await panel.getByRole("button", { name: "Accept attempt" }).click();
  await panel.locator('.execution-attempt[data-state="accepted"]').waitFor({ state: "visible", timeout: 60_000 });
  assert(await panel.getByRole("status").filter({ hasText: "Attempt accepted." }).isVisible(), "the panel must confirm the acceptance");

  await page.goto(`http://127.0.0.1:${webPort}/issues/${staleTarget.issue.identifier}`, { waitUntil: "domcontentloaded" });
  const stalePanel = page.getByRole("region", { name: "Execution control" }).first();
  await stalePanel.locator('.execution-attempt[data-state="stale"]').waitFor({ state: "visible", timeout: 30_000 });
  assert(await stalePanel.getByRole("button", { name: "Quarantine attempt" }).isVisible(), "a stale attempt must offer quarantine");
  await stalePanel.getByRole("button", { name: "Cancel attempt" }).click();
  await stalePanel.locator('.execution-attempt[data-state="canceled"]').waitFor({ state: "visible", timeout: 30_000 });
  assert(await stalePanel.getByRole("button", { name: "Retry attempt" }).isVisible(), "a canceled attempt must offer a retry");
  assert((await http(`/execution-attempts/${staleAttempt.attempt.id}`)).body.attempt.state === "canceled", "the panel's cancel must reach the hub");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${webPort}/issues/${uiTarget.issue.identifier}`, { waitUntil: "domcontentloaded" });
  const narrowPanel = page.getByRole("region", { name: "Execution control" }).first();
  await narrowPanel.locator('.execution-attempt[data-state="accepted"]').waitFor({ state: "visible", timeout: 30_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const box = await narrowPanel.boundingBox();
  assert(overflow <= 1 && box && box.width <= 390, `the panel must fit a phone-width viewport (overflow ${overflow}, width ${box?.width})`);

  await page.setViewportSize({ width: 1280, height: 960 });
  await page.goto(`http://127.0.0.1:${webPort}/projects/${project.id}/overview`, { waitUntil: "domcontentloaded" });
  const queuePanel = page.getByRole("region", { name: "Runnable queue" });
  await queuePanel.getByText(/runnable, \d+ waiting/).waitFor({ state: "visible", timeout: 30_000 });
  assert(pageErrors.length === 0, `the UI must not raise page errors: ${pageErrors.join("; ")}`);

  console.log("Control-plane end-to-end acceptance passed");
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) await stopProcessTree(child);
  if (process.platform === "win32") {
    for (const child of children) if (child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  }
  await sleep(500);
  try {
    removeTemporaryDirectory(tempDir);
  } catch (error) {
    console.error("Control-plane end-to-end cleanup failed:", error);
  }
}
