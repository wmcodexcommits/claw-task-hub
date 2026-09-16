// Runnable issue regression.
//
// Covers the single owner of runnability in server/issue-runnability.ts:
// dependency chains, diamonds, cycles, and resolved blockers; explicit Blocked
// and Paused statuses; closed and archived issues and projects; claims held by
// other sessions, the caller's own claims, and stale claims; live, quarantined,
// and terminal execution attempts; project and team scoping; deterministic
// ordering and pagination; claim_issue refusing exactly what the listing calls
// blocked; claim races within one process and across processes; and the CLI,
// MCP, and HTTP surfaces.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { stopProcessTree } from "./process-tree.mjs";
import { removeTemporaryDirectory } from "./temp-dir.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.env.CLAW_TASK_HUB_RUNNABLE_WORKER !== "1") {
  const parentTempDir = mkdtempSync(join(tmpdir(), "claw-task-hub-runnable-"));
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAW_TASK_HUB_DB: join(parentTempDir, "runnable.sqlite"),
      CLAW_TASK_HUB_QUIET_DB: "1",
      CLAW_TASK_HUB_RUNNABLE_WORKER: "1",
      // Refresh notifications from CLI writes go nowhere rather than to a hub
      // that may be running on the default port.
      CLAW_TASK_HUB_API_BASE: "http://127.0.0.1:9/api",
    },
    stdio: "inherit",
    windowsHide: true,
  });
  let cleanupFailed = false;
  try {
    removeTemporaryDirectory(parentTempDir);
  } catch (error) {
    cleanupFailed = true;
    console.error("Runnable issue cleanup failed after the worker exited:", error);
  }
  process.exit(cleanupFailed ? 1 : result.status ?? 1);
}

assert(process.env.CLAW_TASK_HUB_DB, "Runnable issue worker requires its temporary database");

const dbModule = await import("../server/db.ts");
const store = await import("../server/store.ts");
const runnability = await import("../server/issue-runnability.ts");
const attempts = await import("../server/execution-attempts.ts");

dbModule.initializeDatabase(dbModule.db);
await store.ensureDefaultTeam();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const codes = (entry) => entry.reasons.map((reason) => reason.code);
const reason = (entry, code) => entry?.reasons.find((candidate) => candidate.code === code);
const runnableIds = (result) => result.runnable.map((entry) => entry.issue.id);
const excludedEntry = (result, issue) => result.excluded.find((entry) => entry.issue.id === issue.id);
const runnableEntry = (result, issue) => result.runnable.find((entry) => entry.issue.id === issue.id);
const listing = (input) => runnability.listRunnableIssues({ limit: 250, excluded_limit: 250, ...input });
const withoutClock = (result) => JSON.stringify({ ...result, evaluated_at: null });

async function expectCode(run, code, message) {
  try {
    await run();
  } catch (error) {
    assert(error instanceof runnability.IssueRunnabilityError, `${message}: expected a typed failure, got ${error instanceof Error ? error.stack : error}`);
    assert(error.code === code && error.message.startsWith(`${code}:`), `${message}: expected ${code}, got ${error.message}`);
    return;
  }
  throw new Error(`${message}: expected ${code}, but it succeeded`);
}

async function expectMessage(run, pattern, message) {
  try {
    await run();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    assert(pattern.test(text), `${message}: unexpected failure ${text}`);
    return;
  }
  throw new Error(`${message}: expected a failure matching ${pattern}, but it succeeded`);
}

let created = 0;
const clockBase = Date.parse("2026-01-01T00:00:00.000Z");

async function issue(project, title, extra = {}) {
  created += 1;
  return await store.upsertIssue({ title, status: "Todo", project_id: project.id, created_at: new Date(clockBase + created * 1000).toISOString(), ...extra });
}

async function session(id) {
  return await store.startAgentSession({ id, agent_name: `Agent ${id}`, harness: "codex", ttl_minutes: 240 });
}

// --- chains, finished blockers, and resolved blockers ---------------------------------

const dag = await store.upsertProject({ external_id: "runnable-dag", name: "Runnable DAG" });
const c1 = await issue(dag, "Chain root");
const c2 = await issue(dag, "Chain middle");
const c3 = await issue(dag, "Chain leaf");
const c2OnC1 = await store.saveIssueDependency({ issue_id: c2.id, blocker_issue_id: c1.id });
await store.saveIssueDependency({ issue_id: c3.id, blocker_issue_id: c2.id });
{
  let result = await listing({ project_id: dag.id });
  assert(JSON.stringify(runnableIds(result)) === JSON.stringify([c1.id]), `only the chain root may be runnable: ${JSON.stringify(result.runnable)}`);
  assert(codes(excludedEntry(result, c2)).join() === "blocked_by_dependencies", "the chain middle must be blocked by its dependency");
  assert(JSON.stringify(reason(excludedEntry(result, c2), "blocked_by_dependencies").blockers.map((blocker) => blocker.issue_id)) === JSON.stringify([c1.id]), "the middle must name the root as its blocker");
  assert(JSON.stringify(reason(excludedEntry(result, c3), "blocked_by_dependencies").blockers.map((blocker) => blocker.issue_id)) === JSON.stringify([c2.id]), "the leaf must name only its direct blocker");
  assert(excludedEntry(result, c2).issue.status_type === "blocked" && runnableEntry(result, c1).issue.unblocks_count === 1, "summaries must carry the effective status and dependent count");

  // A finished blocker still blocks until the relation is resolved, and says so.
  await store.updateIssue(c1.id, { status: "Done" });
  result = await listing({ project_id: dag.id });
  assert(!runnableEntry(result, c1) && !excludedEntry(result, c1), "a closed issue must not be a candidate");
  assert(reason(excludedEntry(result, c2), "blocked_by_dependencies").blockers[0].status_type === "completed", "a finished blocker must be reported with its status");
  const closed = await listing({ issue_id: c1.identifier });
  assert(JSON.stringify(codes(closed.excluded[0])) === JSON.stringify(["issue_closed"]), `evaluating a closed issue must explain it: ${JSON.stringify(closed.excluded)}`);

  await store.resolveIssueDependency({ dependency_id: c2OnC1.id });
  result = await listing({ project_id: dag.id });
  assert(JSON.stringify(runnableIds(result)) === JSON.stringify([c2.id]), "resolving the relation must make the middle runnable");
  assert(codes(excludedEntry(result, c3)).join() === "blocked_by_dependencies", "the leaf must stay blocked by the open middle relation");
}

// --- diamonds ---------------------------------------------------------------------------

const d1 = await issue(dag, "Diamond top");
const d2 = await issue(dag, "Diamond left");
const d3 = await issue(dag, "Diamond right");
const d4 = await issue(dag, "Diamond bottom");
const d2OnD1 = await store.saveIssueDependency({ issue_id: d2.id, blocker_issue_id: d1.id });
const d3OnD1 = await store.saveIssueDependency({ issue_id: d3.id, blocker_issue_id: d1.id });
const d4OnD2 = await store.saveIssueDependency({ issue_id: d4.id, blocker_issue_id: d2.id });
const d4OnD3 = await store.saveIssueDependency({ issue_id: d4.id, blocker_issue_id: d3.id });
{
  let result = await listing({ project_id: dag.id });
  assert(runnableIds(result).includes(d1.id) && !runnableIds(result).includes(d2.id) && !runnableIds(result).includes(d3.id), "only the top of the diamond may be runnable");
  assert(JSON.stringify(reason(excludedEntry(result, d4), "blocked_by_dependencies").blockers.map((blocker) => blocker.issue_id)) === JSON.stringify([d2.id, d3.id]), "the bottom must list both blockers in creation order");
  assert(runnableEntry(result, d1).issue.unblocks_count === 2, "the top must count both dependents");

  await expectMessage(() => store.saveIssueDependency({ issue_id: d1.id, blocker_issue_id: d4.id }), /cycle/, "a dependency closing the diamond into a cycle");
  await expectMessage(() => store.saveIssueDependency({ issue_id: d1.id, blocker_issue_id: d1.id }), /cannot block itself/, "a self-dependency");

  await store.resolveIssueDependency({ dependency_id: d2OnD1.id });
  await store.resolveIssueDependency({ dependency_id: d3OnD1.id });
  result = await listing({ project_id: dag.id });
  assert(runnableIds(result).includes(d2.id) && runnableIds(result).includes(d3.id), "both sides must be runnable once the top relations resolve");
  assert(reason(excludedEntry(result, d4), "blocked_by_dependencies").blockers.length === 2, "the bottom must stay blocked by both sides");
  await store.resolveIssueDependency({ dependency_id: d4OnD2.id });
  result = await listing({ project_id: dag.id });
  assert(JSON.stringify(reason(excludedEntry(result, d4), "blocked_by_dependencies").blockers.map((blocker) => blocker.issue_id)) === JSON.stringify([d3.id]), "one resolved side must leave the other blocker");
  await store.resolveIssueDependency({ dependency_id: d4OnD3.id });
  result = await listing({ project_id: dag.id });
  assert(runnableIds(result).includes(d4.id), "the bottom must be runnable once both sides resolve");
}

// --- cycles through resolved relations --------------------------------------------------

{
  // The resolved root relation no longer connects the chain, so the root may
  // now wait on the leaf; reopening the resolved relation would close a cycle.
  await store.updateIssue(c1.id, { status: "Todo" });
  await store.saveIssueDependency({ issue_id: c1.id, blocker_issue_id: c3.id });
  await expectMessage(() => store.saveIssueDependency({ issue_id: c2.id, blocker_issue_id: c1.id }), /cycle/, "reopening a resolved relation that would close a cycle");
  const result = await listing({ project_id: dag.id });
  assert(reason(excludedEntry(result, c1), "blocked_by_dependencies")?.blockers[0].issue_id === c3.id, "the root must now wait on the leaf");
}

// --- explicit statuses, closed and archived issues and projects ----------------------------

const policy = await store.upsertProject({ external_id: "runnable-policy", name: "Runnable Policy" });
const explicitBlocked = await issue(policy, "Explicitly blocked", { status: "Blocked" });
const paused = await issue(policy, "Paused work", { status: "Paused" });
const backlog = await issue(policy, "Backlog work", { status: "Backlog" });
await issue(policy, "Done work", { status: "Done" });
await issue(policy, "Canceled work", { status: "Canceled" });
const archived = await issue(policy, "Archived work", { archived_at: "2026-01-02T00:00:00.000Z" });
const closedProject = await store.upsertProject({ external_id: "runnable-closed", name: "Runnable Closed Project", status: "Completed" });
const closedProjectWork = await issue(closedProject, "Work in a closed project");
const archivedProject = await store.upsertProject({ external_id: "runnable-archived", name: "Runnable Archived Project" });
const archivedProjectWork = await issue(archivedProject, "Work in an archived project");
await store.upsertProject({ id: archivedProject.id, archived_at: "2026-01-03T00:00:00.000Z" });
{
  const result = await listing({ project_id: policy.id });
  assert(JSON.stringify(runnableIds(result)) === JSON.stringify([backlog.id]), `only backlog work may be runnable: ${JSON.stringify(result.runnable)}`);
  assert(codes(excludedEntry(result, explicitBlocked)).join() === "status_blocked", "an explicit Blocked status must exclude");
  assert(codes(excludedEntry(result, paused)).join() === "status_paused", "a Paused status must exclude");
  assert(result.excluded_total === 2, `closed and archived issues must not be candidates: ${JSON.stringify(result.excluded)}`);
  const archivedEvaluation = await listing({ issue_id: archived.identifier });
  assert(codes(archivedEvaluation.excluded[0]).join() === "issue_archived", "evaluating an archived issue must explain it");
  assert(codes(excludedEntry(await listing({ project_id: closedProject.id }), closedProjectWork)).join() === "project_closed", "a closed project must exclude its work");
  assert(codes(excludedEntry(await listing({ project_id: archivedProject.id }), archivedProjectWork)).join() === "project_archived", "an archived project must exclude its work");

  // claim_issue refuses exactly the blocking reasons, and not the others.
  await session("session-probe");
  await expectMessage(() => store.claimIssue({ issue_id: explicitBlocked.id, session_id: "session-probe" }), /is blocked/, "claiming an explicitly blocked issue");
  const dagResult = await listing({ project_id: dag.id });
  for (const entry of dagResult.excluded) {
    if (!entry.reasons.some((candidate) => runnability.blockingReasonCodes.includes(candidate.code))) continue;
    await expectMessage(() => store.claimIssue({ issue_id: entry.issue.id, session_id: "session-probe" }), /is blocked/, `claiming ${entry.issue.identifier}, which the listing calls blocked`);
  }
  // Claiming moves Todo, Backlog, and Paused issues to In Progress, so the probe
  // uses work that stays excluded for a reason that is not blocking.
  const closedProjectClaim = await store.claimIssue({ issue_id: closedProjectWork.id, session_id: "session-probe", ttl_minutes: 30 });
  assert(closedProjectClaim.claim.status === "active", "claim_issue must not refuse an issue excluded for a reason that is not blocking");
  await store.releaseIssueClaim({ claim_id: closedProjectClaim.claim.id, session_id: "session-probe" });
}

// --- scoping ----------------------------------------------------------------------------------

{
  const byId = await listing({ project_id: policy.id });
  const byName = await listing({ project: "Runnable Policy" });
  assert(withoutClock(byId) === withoutClock(byName), "a project named by id and by name must scope the same issues");
  assert(!byId.runnable.concat(byId.excluded).some((entry) => entry.issue.project_id !== policy.id), "project scope must not leak other projects");
  const everything = await listing({});
  assert(runnableIds(everything).includes(backlog.id) && runnableIds(everything).includes(d4.id), "an unscoped listing must span projects");
  const team = (await store.listTeams())[0];
  assert(team, "the default team must exist");
  await expectCode(() => listing({ project_id: "project-missing" }), "project_not_found", "an unknown project");
  await expectCode(() => listing({ team_id: "team-missing" }), "team_not_found", "an unknown team");
  await expectCode(() => listing({ issue_id: "CTH-999999" }), "issue_not_found", "an unknown issue");
  await expectCode(() => listing({ limit: "many" }), "invalid_input", "a non-numeric limit");
  await expectCode(() => runnability.listRunnableIssues({ limit: 251 }), "invalid_input", "a limit beyond the maximum");
  await expectCode(() => listing({ include_excluded: "sometimes" }), "invalid_input", "an unreadable flag");
}

// --- claims: other sessions, the caller's own, and stale ones ----------------------------------

const owned = await store.upsertProject({ external_id: "runnable-owned", name: "Runnable Ownership" });
const claimedWork = await issue(owned, "Claimed by A");
const expiredWork = await issue(owned, "Claim expired");
const endedWork = await issue(owned, "Claiming session ended");
await session("session-a");
await session("session-b");
await session("session-ended");
const claimA = (await store.claimIssue({ issue_id: claimedWork.id, session_id: "session-a", ttl_minutes: 240 })).claim;
const expiredClaim = (await store.claimIssue({ issue_id: expiredWork.id, session_id: "session-b", ttl_minutes: 240 })).claim;
await dbModule.adapter.run("UPDATE issue_claims SET expires_at = @past WHERE id = @id", { id: expiredClaim.id, past: "2026-01-01T00:00:00.000Z" });
await store.claimIssue({ issue_id: endedWork.id, session_id: "session-ended", ttl_minutes: 240 });
await store.endAgentSession({ session_id: "session-ended", release_claims: false });
{
  const anonymous = await listing({ project_id: owned.id });
  const claimed = reason(excludedEntry(anonymous, claimedWork), "claimed");
  assert(claimed?.claims.length === 1 && claimed.claims[0].claim_id === claimA.id && claimed.claims[0].session_id === "session-a", `an active claim must exclude: ${JSON.stringify(anonymous.excluded)}`);
  assert(runnableEntry(anonymous, expiredWork) && runnableEntry(anonymous, endedWork), "expired claims and claims of ended sessions must not protect an issue");
  const asA = await listing({ project_id: owned.id, session_id: "session-a" });
  assert(runnableEntry(asA, claimedWork)?.own_claims[0]?.claim_id === claimA.id, "the caller's own claim must not exclude, and must be reported");
  assert(codes(excludedEntry(await listing({ project_id: owned.id, session_id: "session-b" }), claimedWork)).join() === "claimed", "another session's claim must exclude");
}

// --- execution attempts: live, quarantined, and terminal ------------------------------------------

const attemptWork = await issue(owned, "Attempt in flight");
{
  const claim = (await store.claimIssue({ issue_id: attemptWork.id, session_id: "session-a", ttl_minutes: 240 })).claim;
  const attempt = (await attempts.createExecutionAttempt({
    issue_id: attemptWork.identifier,
    claim_id: claim.id,
    harness: "fake",
    repository: "https://example.com/claw/runnable.git",
    base_sha: "a".repeat(40),
    idempotency_key: "runnable-attempt",
  })).attempt;
  let asA = await listing({ project_id: owned.id, session_id: "session-a" });
  const live = reason(excludedEntry(asA, attemptWork), "live_attempt");
  assert(codes(excludedEntry(asA, attemptWork)).join() === "live_attempt" && live.attempts[0].attempt_id === attempt.id && live.attempts[0].state === "provisioning", `a live attempt must exclude even for its own session: ${JSON.stringify(asA.excluded)}`);
  assert(JSON.stringify(codes(excludedEntry(await listing({ project_id: owned.id }), attemptWork))) === JSON.stringify(["claimed", "live_attempt"]), "every reason must be reported");

  await attempts.transitionExecutionAttempt({ attempt_id: attempt.id, event: "mark_stale", expected_revision: 0, idempotency_key: "runnable-stale", actor_kind: "control_plane", actor_id: "runnable-test", reason: "lease_expired" });
  asA = await listing({ project_id: owned.id, session_id: "session-a" });
  assert(reason(excludedEntry(asA, attemptWork), "live_attempt")?.attempts[0].state === "stale", "a quarantined attempt must still protect its issue");

  await attempts.transitionExecutionAttempt({ attempt_id: attempt.id, event: "cancel", expected_revision: 1, idempotency_key: "runnable-cancel", actor_kind: "operator", actor_id: "operator-1", reason: "operator_requested" });
  asA = await listing({ project_id: owned.id, session_id: "session-a" });
  assert(runnableEntry(asA, attemptWork), "a terminal attempt must not protect its issue");
}

// --- deterministic order and pagination ------------------------------------------------------------

const ordering = await store.upsertProject({ external_id: "runnable-order", name: "Runnable Ordering" });
const noPriority = await issue(ordering, "No priority", { priority: 0 });
const low = await issue(ordering, "Low", { priority: 4 });
const highPlain = await issue(ordering, "High plain", { priority: 2 });
const highUnblocker = await issue(ordering, "High unblocker", { priority: 2 });
const medium = await issue(ordering, "Medium", { priority: 3 });
const dependent = await issue(ordering, "Waits on the unblocker", { priority: 1 });
await store.saveIssueDependency({ issue_id: dependent.id, blocker_issue_id: highUnblocker.id });
const urgentFirst = await issue(ordering, "Urgent first", { priority: 1 });
const urgentSecond = await issue(ordering, "Urgent second", { priority: 1 });
{
  const expected = [urgentFirst, urgentSecond, highUnblocker, highPlain, medium, low, noPriority].map((item) => item.id);
  const full = await listing({ project_id: ordering.id });
  assert(JSON.stringify(runnableIds(full)) === JSON.stringify(expected), `runnable order must be priority, unblocking, age: ${JSON.stringify(full.runnable.map((entry) => entry.issue.title))}`);
  assert(full.runnable_total === 7 && full.next_offset === null, "a complete page must report its total and no next offset");
  assert(withoutClock(full) === withoutClock(await listing({ project_id: ordering.id })), "repeated evaluation must be identical");

  const paged = [];
  let offset = 0;
  for (;;) {
    const page = await runnability.listRunnableIssues({ project_id: ordering.id, limit: 2, offset });
    assert(page.runnable_total === 7, "every page must report the same total");
    paged.push(...runnableIds(page));
    if (page.next_offset === null) break;
    assert(page.next_offset === offset + 2, "next_offset must advance by the page size");
    offset = page.next_offset;
  }
  assert(JSON.stringify(paged) === JSON.stringify(expected), "pages must concatenate to the full order");

  const excludedPages = [];
  for (const excludedOffset of [0, 1]) {
    const page = await runnability.listRunnableIssues({ project_id: policy.id, excluded_limit: 1, excluded_offset: excludedOffset });
    excludedPages.push(...page.excluded.map((entry) => entry.issue.id));
    assert(page.next_excluded_offset === (excludedOffset === 0 ? 1 : null), "excluded paging must report its next offset");
  }
  assert(JSON.stringify(excludedPages) === JSON.stringify([explicitBlocked.id, paused.id]), "excluded pages must follow the same order");
  const bare = await runnability.listRunnableIssues({ project_id: policy.id, include_excluded: false });
  assert(bare.excluded.length === 0 && bare.excluded_total === 2 && bare.next_excluded_offset === null, "include_excluded=false must omit excluded issues but keep their count");
}

// --- claim races ------------------------------------------------------------------------------------

function runHub(tool, payload) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["server/hub-cli.ts", "tools/call", tool, `base64:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}`],
      { cwd: process.cwd(), env: process.env, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

{
  const raceWork = await issue(owned, "In-process claim race");
  const racers = ["race-0", "race-1", "race-2", "race-3", "race-4"];
  for (const id of racers) await session(id);
  const outcomes = await Promise.allSettled(racers.map((id) => store.claimIssue({ issue_id: raceWork.id, session_id: id, ttl_minutes: 60 })));
  const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
  assert(winners.length === 1, `exactly one concurrent claim may win, saw ${winners.length}`);
  assert(outcomes.filter((outcome) => outcome.status === "rejected").every((outcome) => /already claimed/.test(outcome.reason.message)), "losing claims must see the winner");
  const active = await store.listIssueClaims({ issue_id: raceWork.id });
  assert(active.length === 1 && active[0].id === winners[0].value.claim.id, "one active claim must remain");

  const crossWork = await issue(owned, "Cross-process claim race");
  const crossRacers = ["cross-0", "cross-1", "cross-2", "cross-3"];
  for (const id of crossRacers) await session(id);
  const processes = await Promise.all(crossRacers.map((id) => runHub("claim_issue", { issue_id: crossWork.id, session_id: id, ttl_minutes: 60 })));
  const succeeded = processes.filter((result) => result.status === 0);
  assert(succeeded.length === 1, `exactly one process may win the claim, saw ${succeeded.length}:\n${processes.map((result) => result.stderr).join("\n")}`);
  assert(processes.filter((result) => result.status !== 0).every((result) => /already claimed/.test(result.stderr)), `losing processes must see the winner:\n${processes.map((result) => result.stderr).join("\n")}`);
  assert((await store.listIssueClaims({ issue_id: crossWork.id })).length === 1, "one active claim must remain across processes");
}

// --- CLI, MCP, and HTTP -----------------------------------------------------------------------------

{
  const expected = runnableIds(await listing({ project_id: ordering.id }));
  const cli = await runHub("list_runnable_issues", { project_id: ordering.id, limit: 3 });
  assert(cli.status === 0, `CLI list_runnable_issues failed:\n${cli.stderr}`);
  const cliResult = JSON.parse(cli.stdout);
  assert(JSON.stringify(runnableIds(cliResult)) === JSON.stringify(expected.slice(0, 3)) && cliResult.next_offset === 3, "CLI must return the first page");
  const cliMissing = await runHub("list_runnable_issues", { project_id: "project-missing" });
  assert(cliMissing.status !== 0 && cliMissing.stderr.includes("project_not_found:"), `CLI must surface typed failures:\n${cliMissing.stderr}`);

  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_runnable_issues", arguments: { project_id: ordering.id } } }),
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_runnable_issues", arguments: { issue_id: "CTH-999999" } } }),
    "",
  ].join("\n");
  const mcp = spawnSync(process.execPath, ["server/mcp-server.ts"], { cwd: process.cwd(), env: process.env, input, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert(mcp.status === 0, `MCP server failed:\n${mcp.stderr}`);
  const messages = String(mcp.stdout).split(/\r?\n/).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
  const byId = (id) => messages.find((message) => message.id === id);
  const described = (byId(2)?.result?.tools ?? []).find((tool) => tool.name === "list_runnable_issues");
  assert(described?.inputSchema?.properties?.session_id, "MCP must describe list_runnable_issues");
  assert(JSON.stringify(runnableIds(JSON.parse(byId(3).result.content[0].text))) === JSON.stringify(expected), "MCP must return the same order");
  assert(byId(4)?.error?.message?.startsWith("issue_not_found:"), `MCP must surface typed failures, got ${JSON.stringify(byId(4))}`);

  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
  const api = spawn(process.execPath, ["server/index.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, windowsHide: true, detached: process.platform !== "win32" });
  let diagnostics = "";
  api.stdout.on("data", (chunk) => { diagnostics += chunk; });
  api.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const base = `http://127.0.0.1:${port}/api`;
  const call = async (path) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: await response.json() };
  };
  try {
    for (let tries = 0; ; tries += 1) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {
        // not listening yet
      }
      if (tries >= 100) throw new Error(`API did not start\n${diagnostics}`);
      await sleep(100);
    }
    let result = await call(`/runnable-issues?project_id=${encodeURIComponent(ordering.id)}&limit=2&offset=2`);
    assert(result.status === 200 && JSON.stringify(runnableIds(result.body)) === JSON.stringify(expected.slice(2, 4)), `HTTP paging failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call(`/runnable-issues?project_id=${encodeURIComponent(owned.id)}&session_id=session-a&include_excluded=false`);
    assert(result.status === 200 && result.body.runnable.some((entry) => entry.issue.id === claimedWork.id) && result.body.excluded.length === 0, `HTTP session scoping failed: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call("/runnable-issues?issue_id=CTH-999999");
    assert(result.status === 404 && result.body.code === "issue_not_found", `HTTP unknown issue must be 404: ${result.status} ${JSON.stringify(result.body)}`);
    result = await call("/runnable-issues?limit=0");
    assert(result.status === 400 && result.body.code === "invalid_input", `HTTP invalid paging must be 400: ${result.status} ${JSON.stringify(result.body)}`);
  } finally {
    await stopProcessTree(api);
  }
}

console.log("Runnable issue regression passed");
