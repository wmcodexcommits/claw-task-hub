# Agentic Harness Contract

Claw Task Hub is a local, Linear-like task system for AI agents first and human operators second. Humans get a familiar issue-tracker flow, but the durable contract is built for agentic harnesses, MCP-compatible clients, CLIs, and other local automation runtimes.

This document is the canonical contract for agents and harness authors.

## Source Of Truth

- The local SQLite database is the durable source of truth.
- Normal operation is independent of external ticketing services. Do not connect to external trackers as an active fallback during Claw Task Hub work.
- Imported records from prior systems are local history and can still be updated locally when work continues.
- New work should be created in Claw Task Hub with local identifiers.

## Local Deployment Boundary

- The public MVP is local-first and binds the API to loopback by default.
- Non-loopback binding requires `CLAW_TASK_HUB_UNSAFE_BIND=1` and is not a secure hosted deployment by itself.
- Harnesses should connect through local stdio MCP or local HTTP only unless the operator has added separate authentication and network controls.
- The browser UI expects the local API unless a downstream distribution intentionally changes that deployment model.

## One-Click Human Opening

Humans should not need to type commands for normal use.

- On Windows, double-click `Launch Claw Task Hub.vbs` from the repository folder.
- On macOS/Linux, double-click `Launch Claw Task Hub.command` where the desktop environment supports command files.
- On a project page, click the `Shortcut` button in the header to download a project-specific `.url` shortcut.
- Save that shortcut next to the local repository, on the desktop, or in a bookmarks folder.
- Reopen the project later by double-clicking the shortcut.
- If a harness local-app picker does not show Claw Task Hub, open `OPEN_CLAW_TASK_HUB.md` from the workspace files and click `Open Claw Task Hub project`.

This is the preferred human-facing path. CLI launchers and MCP calls are for agents, harnesses, automation, and troubleshooting.

## Controlled Pilot Startup

For interactive development, `bun run dev` is enough. For a controlled pilot on Linux or macOS, harnesses should not launch `bun run dev` through plain `nohup`: some parent shells still terminate the process tree when the shell exits.

Use the supplied detached pilot launcher:

```bash
bun run pilot:start
bun run pilot:status
bun run pilot:stop
```

Launcher behavior:

- prefers `setsid` to detach the server from the parent shell;
- falls back to `nohup` only when `setsid` is unavailable;
- writes logs and the PID file under `logs/`;
- waits for both UI and API readiness;
- stops the process group first, then the parent PID if needed.

Optional environment overrides:

- `CLAW_TASK_HUB_LOG_DIR`
- `CLAW_TASK_HUB_PID_FILE`
- `CLAW_TASK_HUB_UI_URL`
- `CLAW_TASK_HUB_API_URL`

## Identity Model

Each issue has three identity fields:

- `id`: internal stable row id, often `issue_*` for local rows.
- `identifier`: short visible code such as `CTH-267`, `LOCAL-1`, or another imported legacy identifier.
- `external_id`: optional foreign-system id for imported or mirrored records.

Agents should use the visible `identifier` in conversation and comments. Tool calls may pass `id`, `external_id`, or `identifier` when updating or reading an existing issue.

New local issues should normally omit `identifier`; Claw Task Hub assigns the next short local code. The issue title must be a short human-readable task name, not a synthetic code.

## Issue Lifecycle

Use these statuses unless a project has a documented local exception:

- `Backlog`: valid work that is not ready to start.
- `Todo`: ready to start when an agent or human takes it.
- `In Progress`: currently owned by an active worker.
- `Blocked`: cannot continue without an explicit external dependency.
- `Paused`: intentionally suspended by policy, timing, owner decision, or a non-urgent dependency.
- `Done`: accepted and no longer active.
- `Canceled`: closed because it should not be done.

`status_type` must match the status:

- `backlog`: `Backlog`
- `unstarted`: `Todo`
- `started`: `In Progress`
- `blocked`: `Blocked`
- `paused`: `Paused`
- `completed`: `Done`
- `canceled`: `Canceled`

When a task is done, use `accept_issue` so acceptance evidence is persisted before the issue moves to `Done`. Direct `save_comment` plus `save_issue` remains available for staged or imported workflows, but callers must fail fast between those operations.

Claims enforce this workflow: claiming ready work moves it to `In Progress`, releasing unfinished work moves it to `Todo`, and completing a claim moves it to `Done`. Record real blockers with `save_issue_dependency`; an unresolved dependency makes the issue effectively `Blocked` without discarding its underlying ready/in-progress state. Resolve it with `resolve_issue_dependency`. Priority is urgency, not blocker state.

Use `save_project_update` for durable project-level reporting. Every update carries an explicit health value (`on_track`, `at_risk`, `off_track`, or `complete`) and appears in project activity; issue comments remain issue-level evidence.

Configure project metadata with `save_project`: `status`, `priority`, `lead`, `target_date` (`YYYY-MM-DD`), and `source` are preserved by partial updates and displayed by the Projects UI. Project health is not guessed from status; the Projects UI uses the most recent `save_project_update` health value and shows `No update` until one exists.

## Agent Write Rules

Agents must:

- Create an issue before doing non-trivial work.
- Set `parent_id` when the task is a slice of a larger issue or epic.
- Keep titles concise and task-like.
- Put detailed context, acceptance criteria, evidence, and blockers in `description` or comments.
- Use comments as the acceptance trail.
- Preserve existing project, team, parent, source, URL, and imported metadata unless intentionally changing them.
- Prefer idempotent updates with stable `external_id` for repeated comments or generated records.
- End work by setting the final issue status and writing verification evidence.

Agents must not:

- Store passwords, OAuth tokens, private keys, cookies, or raw secret values in issues or comments.
- Store passwords, OAuth tokens, private keys, cookies, or raw secret values in context binding metadata.
- Reconnect to an external tracker as an active fallback for Claw Task Hub work.
- Invent long code-like issue titles such as `LOCAL_SAV_...` when a short identifier already exists.
- Mark work `Done` without verification or an explicit owner decision.
- Reassign or close another active agent's issue without reading the current comments and status.

## Project Context Binding

Harnesses should bind their local execution context to a Claw Task Hub project once, then resolve that binding on every new or resumed session. This prevents agents from filing work into the wrong project and lets the UI open directly to the correct project after a browser refresh.

### Codex Workspace Launcher

Codex users should not rely on opening bare `http://localhost:5173` from the side panel. That URL is intentionally the global Projects page. For humans, use the downloaded project `.url` shortcut. For agents and harness integrations, use the workspace launcher so Codex opens the project that matches the current working directory and can also write the one-click shortcut for future human use.

Create a local project for a workspace, bind it, write a shortcut, and open the UI:

```powershell
bun run open:context -- --harness codex --cwd C:/work/my-repo --project-name "My Repo" --create-project --write-shortcut --open
```

Bind an existing Claw Task Hub project:

```powershell
bun run open:context -- --harness codex --cwd C:/work/my-repo --project-id project_my_repo --write-shortcut --open
```

Open an already-bound workspace:

```powershell
bun run codex:open -- --cwd C:/work/my-repo
```

The command returns JSON with the resolved `url`, `url_path`, `project`, and `context_key`. Agents can read that URL and hand it to the harness browser. Humans can use the generated `Open Claw Task Hub.url` shortcut or the generated `OPEN_CLAW_TASK_HUB.md` file when a harness exposes project files more reliably than local-app suggestions. Other harnesses can use the same command by changing `--harness`.

A context binding can include:

- `context_key`: a stable harness-defined key, for example `codex:C:/work/my-repo` or `claude-code:repo:example/my-repo`.
- `project_id`: the owning Claw Task Hub project id from `list_projects`.
- `default_tab`: `overview`, `activity`, or `issues`; use `issues` for most agent work.
- `harness`: the agentic harness name.
- `cwd`: current working directory.
- `repo_remote`: repository remote URL; URL credentials are stripped before storage.
- `branch`: branch name.
- `thread_id`: optional harness thread/session id.
- `metadata`: non-secret structured hints for the harness.

Create or update a binding:

```powershell
$json = '{"context_key":"codex:C:/work/my-repo","project_id":"project_my_repo","default_tab":"issues","harness":"codex","cwd":"C:/work/my-repo","repo_remote":"https://github.com/example/my-repo.git","branch":"main"}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
bun run hub -- tools/call save_context_binding "base64:$b64"
```

Resolve by exact key:

```powershell
$json = '{"context_key":"codex:C:/work/my-repo"}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
bun run hub -- tools/call resolve_context_project "base64:$b64"
```

Resolve by repository or working directory when the exact key is unavailable:

```powershell
$json = '{"harness":"codex","cwd":"C:/work/my-repo","repo_remote":"https://github.com/example/my-repo.git","branch":"main"}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
bun run hub -- tools/call resolve_context_project "base64:$b64"
```

Resolution order is deterministic: exact `context_key`, then `thread_id`, `cwd`, `repo_remote + branch`, `repo_remote`, and finally harness-scoped fallbacks. A resolved binding returns `project`, `binding`, and `url_path`.

UI deep links:

- `/projects/<project-id>/overview`
- `/projects/<project-id>/activity`
- `/projects/<project-id>/issues`
- `/issues/<issue-id-or-identifier>`
- `/contexts/<context-key>/issues`
- `/workspace/issues`

## CLI Fallback

When MCP tools are not injected, run commands from the repository root.

PowerShell rule: never pass raw JSON to `tools/call` when the payload contains human-written text, Markdown, quotes, or newlines. Do not retry by hand-escaping quotes. Use `base64:<json>` or the wrapper below:

```powershell
$payload = @{
  issue_id = "CTH-267"
  body = @'
Accepted: comments can contain "quotes", `ticks`, and multiple lines.
'@
  author = "Demo Agent"
  source = "local"
}
.\tools\cth-call.ps1 -Tool save_comment -InputObject $payload
```

Dashboard:

```powershell
bun run hub -- tools/call dashboard "{}"
```

List projects:

```powershell
bun run hub -- tools/call list_projects "{}"
```

Project routing is mandatory for new issues. Always select the owning project from `list_projects` and pass its `project_id` to `save_issue`. Do not copy a project id from an unrelated example or another project. Claw Task Hub intentionally rejects new issues with no project or an unknown project; `allow_no_project:true` is only for a deliberate unassigned inbox issue.

List open issues in a selected project:

```powershell
$json = '{"project_id":"<target-project-id>","include_done":false,"limit":50}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
bun run hub -- tools/call list_issues "base64:$b64"
```

For active-work discovery, pass `include_done:false`. This excludes normalized `completed` issues even if old imported rows have inconsistent raw status metadata.

Create a local issue:

```powershell
$json = '{"title":"Document agentic harness contract","description":"Write the canonical harness contract and link it from README and AGENTS.","project_id":"<target-project-id>","team_id":"team_local","parent_id":"LOCAL-1","priority":1,"status":"Todo","status_type":"unstarted","labels":["agentic-harness","docs"],"source":"local"}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
bun run hub -- tools/call save_issue "base64:$b64"
```

Move an issue to active work:

```powershell
$json = '{"id":"CTH-267","status":"In Progress","status_type":"started"}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
bun run hub -- tools/call save_issue "base64:$b64"
```

Add an acceptance comment:

```powershell
$json = '{"issue_id":"CTH-267","body":"Accepted: documentation exists, links are updated, build and regression checks pass.","author":"Demo Agent","source":"local"}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
bun run hub -- tools/call save_comment "base64:$b64"
```

Close an issue:

```powershell
$json = '{"id":"CTH-267","status":"Done","status_type":"completed"}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
bun run hub -- tools/call save_issue "base64:$b64"
```

## MCP Tool Surface

Harnesses should prefer MCP when the server is available.

Canonical tool names:

- `dashboard`
- `list_projects`
- `get_project`
- `save_project`
- `list_project_updates`
- `save_project_update`
- `list_issues`
- `get_issue`
- `save_issue`
- `save_comment`
- `accept_issue`
- `list_issue_dependencies`
- `save_issue_dependency`
- `resolve_issue_dependency`
- `list_teams`
- `start_agent_session`
- `heartbeat_agent_session`
- `end_agent_session`
- `list_agent_sessions`
- `claim_issue`
- `release_issue_claim`
- `list_issue_claims`
- `list_runnable_issues`
- `repair_issue_invariants`
- `save_context_binding`
- `upsert_context_binding`
- `get_context_binding`
- `list_context_bindings`
- `resolve_context_project`
- `delete_context_binding`
- `create_execution_attempt`
- `get_execution_attempt`
- `list_execution_attempts`
- `transition_execution_attempt`
- `plan_execution_workspace`
- `provision_execution_workspace`
- `get_execution_workspace`
- `list_execution_workspaces`
- `renew_execution_workspace`
- `release_execution_workspace`
- `list_execution_adapters`
- `launch_execution_attempt`
- `save_verification_policy`
- `get_verification_policy`
- `capture_execution_diff`
- `record_execution_evidence`
- `list_execution_evidence`
- `get_execution_evidence`
- `verify_execution_attempt`
- `declare_execution_paths`
- `get_execution_path_declaration`
- `save_conflict_policy`
- `get_conflict_policy`
- `detect_execution_conflicts`
- `list_execution_conflicts`
- `get_execution_conflict`
- `decide_execution_conflict`
- `list_execution_providers`
- `save_acceptance_policy`
- `get_acceptance_policy`
- `accept_execution_attempt`
- `reject_execution_attempt`
- `list_execution_acceptances`
- `get_execution_acceptance`
- `reconcile_execution`
- `list_reconciliation_runs`
- `get_reconciliation_run`
- `quarantine_execution_attempt`

Optional history import from Linear is an operator-only tool under `tools/linear-migration`. It is not part of the normal API, MCP server, or hub CLI, and it still requires `CLAW_TASK_HUB_ALLOW_LINEAR_IMPORT=1` for an explicit one-off import run. Harnesses must not call it during normal Claw Task Hub work.

For the operator-facing migration procedure, see [LINEAR_MIGRATION.md](LINEAR_MIGRATION.md). That guide is for planned history transfer only, not active task work.

## Multi-Agent Coordination

Use the claim protocol when CLI/MCP tools are available:

```powershell
$json = '{"id":"session-demo-agent-001","agent_name":"Demo Agent","harness":"CLI","ttl_minutes":60,"metadata":{"thread":"local"}}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
bun run hub -- tools/call start_agent_session "base64:$b64"

$json = '{"session_id":"session-demo-agent-001","ttl_minutes":60}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
bun run hub -- tools/call heartbeat_agent_session "base64:$b64"

$json = '{"issue_id":"CTH-268","session_id":"session-demo-agent-001","note":"Implement claim protocol","ttl_minutes":60}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
bun run hub -- tools/call claim_issue "base64:$b64"

$json = '{"issue_id":"CTH-268","session_id":"session-demo-agent-001"}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
bun run hub -- tools/call list_issue_claims "base64:$b64"

$json = '{"issue_id":"CTH-268","session_id":"session-demo-agent-001","status":"completed"}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
bun run hub -- tools/call release_issue_claim "base64:$b64"
```

Claim rules:

- One active claim may own an issue at a time.
- The same session can renew its claim idempotently.
- A different session must wait for expiry or use `force=true` with a clear comment.
- `Done`, `Canceled`, and archived issues cannot be claimed or commented on by default. Reopen the issue first; use `allow_closed:true` only for deliberate historical maintenance.
- Ending a session releases its active claims by default.
- Completing work should release the claim with `status:"completed"` and leave acceptance evidence.

When claim tools are not available, use issue status and comments:

1. Read the issue and recent comments.
2. Add a comment that names the agent, scope, and intended next step.
3. Set the issue to `In Progress` only for the slice being actively worked.
4. Avoid touching unrelated files or records owned by another active agent.
5. On handoff, leave a comment with exact state, verification, and remaining work.

### Runnable Issues

`server/issue-runnability.ts` is the single owner of whether an issue can be started now. `list_runnable_issues` (`GET /api/runnable-issues`) and `claim_issue` both ask it, so a listing and a claim refusal cannot disagree.

- An issue is runnable when every one of these holds:
  - it is open and not archived;
  - its status is not explicitly `Blocked` or `Paused`;
  - its project is not archived or closed (`Done`, `Completed`, or `Canceled`);
  - it has no open dependency;
  - its declared paths have no overlap that its repository's conflict policy makes blocking with a live attempt of another issue (see Execution Conflicts); other overlaps are reported as `path_warnings`;
  - no other session holds an active claim on it;
  - it has no live execution attempt, including a `stale` or `reconciling` one.
- An open dependency blocks even when its blocker is finished. Resolving the relation is an explicit act, and each blocker is reported with its status, so a scheduler can see a relation that is only waiting to be resolved. `save_issue_dependency` still rejects self-dependencies and cycles; only open relations count toward a cycle.
- Expired claims, and claims whose session has ended or expired, do not protect an issue. Pass `session_id` so the caller's own claims do not exclude the issues it holds; they are reported as `own_claims`.
- Every other open issue in scope is listed in `excluded` with all of its reason codes:
  - `status_blocked`, `status_paused`
  - `project_archived`, `project_closed`
  - `blocked_by_dependencies`, with each blocker
  - `claimed`, with each claim
  - `live_attempt`, with each attempt

  Closed and archived issues are not candidates. `issue_id` evaluates one issue and explains a closed or archived one with `issue_closed` or `issue_archived`.
- `project` or `project_id` (an id, external id, or name) and `team` or `team_id` scope the listing. An unknown project, team, or issue is `project_not_found`, `team_not_found`, or `issue_not_found` (HTTP 404); invalid paging is `invalid_input` (400).
- Ordering is the same on SQLite and Postgres:
  1. priority, urgent first and no priority last;
  2. issues that unblock more open dependents;
  3. oldest first;
  4. identifier, then id, by code point.

  `limit` and `offset` page runnable issues, and `excluded_limit` and `excluded_offset` page excluded ones. `next_offset` and `next_excluded_offset` are null on the last page. Every read in one call comes from one snapshot.
- `claim_issue` runs in one transaction and refuses a blocked issue (`status_blocked` or `blocked_by_dependencies`) unless `force=true`. On Postgres it locks the issue row first, so when sessions race for an unclaimed issue exactly one wins and the others see its claim.

## Execution Control Plane Contract

Claim tracking is being extended into an execution control plane: issue, claim, execution attempt, pinned base commit SHA, leased branch and worktree, harness run, structured evidence, review, commit/PR/merge, claim release, and acceptance. This section is the authoritative model for that path. Runtime slices implement this contract; they do not restate it.

### Single Owner

`server/execution-contract.ts` owns every lifecycle rule: states, events, the transition table, actor authority, reason codes, typed failures, and default bounds. Persistence, provisioning, harness adapters, verification, reconciliation, and the API/CLI/MCP/UI surfaces call `planExecutionTransition` and must not re-derive which moves are legal. The tables below are generated from that module with `bun run contract:generate`, and `bun run contract:check` fails verification when they drift.

### Attempts And Ownership

- An execution attempt belongs to one issue, one claim, and one agent session, and records the harness adapter that runs it.
- The base commit SHA is pinned when the attempt is created and never changes. Work on a different base is a new attempt.
- Attempts are append-only history. A retry creates a new attempt that references the one it retries; terminal attempts are never rewritten or reopened.
- Comments remain the readable projection for humans. The attempt record and its transition history are the authority.

### Inputs, Outputs, And Provenance

- Inputs: issue, claim, and session identity; repository identity; the pinned base SHA; harness adapter identity; and the selected verification and acceptance policies.
- Outputs: the leased branch and worktree, bounded process output, structured diffs and verification evidence, and the resulting commit, PR, or merge identity.
- Every applied transition produces a record with the contract version, event, from and to states, new revision, idempotency key, actor kind and id, reason code, policy, note, and timestamp.

### Transition Requests

A request names an `event`, the attempt's `expected_revision`, an `idempotency_key`, and the `actor`, plus a `reason` code or `policy` where the table requires one and an optional bounded `note`.

- Compare-and-set: a request applies only when `expected_revision` equals the attempt's current revision, and each applied transition increments the revision by one. Concurrent requests against the same revision cannot both apply, which is what prevents duplicate launches.
- Idempotency: resending the most recent request with the same `idempotency_key` and `event` is a replay. It returns the current attempt unchanged, even when that attempt is now terminal, so a caller that lost a response can retry safely. Reusing that key for a different event is an `idempotency_conflict`. Persistence must also reject reuse of any earlier key on the same attempt.
- Reconciliation records the state it started from. `resume` returns only to that recorded origin, and only when the origin is `provisioning`, `running`, `verifying`, or `reviewable`. Stale work never resumes.

### Execution Attempt Records

Attempts are stored in `execution_attempts`, with one `execution_attempt_transitions` ledger row per applied transition. `server/execution-attempts.ts` loads an attempt, asks `planExecutionTransition`, and writes the answer with a compare-and-set on the revision, so it adds persistence without restating lifecycle rules.

- `create_execution_attempt` (`POST /api/issues/<issue>/execution-attempts`) needs an open issue, an active claim on that issue, a harness adapter id, a repository without credentials, a full base commit SHA, and an `idempotency_key`. The attempt starts in `provisioning` at revision 0 and records the claim's session. Repeating the key with the same inputs returns the existing attempt. Only one non-terminal attempt may exist per issue; a partial unique index enforces that across processes (`live_attempt_exists`). A retry passes `retry_of` naming a terminal attempt of the same issue.
- `transition_execution_attempt` (`POST /api/execution-attempts/<attempt>/transitions`) takes `event`, `expected_revision`, `idempotency_key`, `actor_kind`, `actor_id`, and the `reason`, `policy`, or `note` the table calls for. It can also bind `workspace` (`branch`, `worktree_path`, `lease_id`) and `process` (`pid`, `started_at`), each once per attempt (`resource_conflict` for a different value), and append `artifacts` references. Reusing an earlier transition's key is an `idempotency_conflict`.
- `get_execution_attempt` (`GET /api/execution-attempts/<attempt>`) returns the attempt with its complete ledger. `list_execution_attempts` (`GET /api/execution-attempts`, or `GET /api/issues/<issue>/execution-attempts`) lists attempts newest first; with an issue it enumerates that issue's full history, and `include_terminal=false` keeps only live attempts.
- Persistence failures are `invalid_input`, `issue_not_found`, `issue_closed`, `claim_not_active`, `attempt_not_found`, `live_attempt_exists`, `invalid_retry`, `idempotency_conflict`, and `resource_conflict`; lifecycle failures keep their contract codes. Every failure message starts with its code, and HTTP responses also carry `code` and `details` with status 404, 403, 409, or 400.
- Attempt writes never create comments. Deleting an issue that has a live attempt requires `force=true`, because the attempt history is deleted with the issue.

### Execution Workspaces

A workspace lease binds one attempt to its own branch and linked worktree at the attempt's pinned base commit. `server/execution-workspaces.ts` owns provisioning, renewal, and release. It requires Git 2.35 or newer.

- `provision_execution_workspace` (`POST /api/execution-attempts/<attempt>/workspace`), or `create_execution_attempt` with `repository_path`, takes the top level of the operator's local clone. Its `remote.origin.url` with credentials stripped, or its path, must match the attempt's `repository` (`repository_mismatch`). The hub runs `git worktree add --lock -b cth/<issue>/<attempt> <path> <base>` without a shell, with repository hooks and fsmonitor disabled. The operator's working tree, index, HEAD, and uncommitted work are only read.
- Worktrees live under `CLAW_TASK_HUB_WORKSPACE_ROOT`, by default `workspaces` next to the database. A root inside the repository (`workspace_root_inside_repository`), a source repository inside the root (`repository_is_workspace`), and a directory that resolves outside the root through a link (`unsafe_path`) are refused before anything is created.
- The lease is recorded before Git runs and becomes `active` only after the worktree is verified at the base. Provisioning the same attempt again returns the same lease: it re-verifies an active lease, reclaims an expired one, and finishes an interrupted one. A lease that is still `provisioning` and younger than the Git timeout is a `lease_conflict`, because another process may be running Git on it.
- A branch or directory with the leased name that no lease owns is `branch_exists` or `worktree_path_exists` and is left untouched; a base commit the repository lacks is `base_missing`. A leased branch that no longer contains its base is `base_drift`: the lease is marked `failed` and the worktree stays for inspection. `plan_execution_workspace` returns the branch and path without creating them.
- `renew_execution_workspace` (`POST /api/execution-workspaces/<lease>/renew`) extends an active, unexpired lease of a non-terminal attempt; otherwise it fails with `lease_expired`, `lease_not_active`, or `attempt_terminal`. `release_execution_workspace` (`POST /api/execution-workspaces/<lease>/release`) removes a clean worktree without `--force` unless `keep_worktree=true`, always retains a worktree holding uncommitted or untracked work, and always keeps the branch.
- `get_execution_workspace` and `list_execution_workspaces` (`GET /api/execution-workspaces`, filterable by `attempt_id`, `issue_id`, `branch`, and `worktree_path`) answer who owns a branch or worktree. Failures lead with their code; over HTTP, missing attempts and leases are 404, lease and Git-state conflicts are 409, `git_failed` is 500, and invalid input or repositories are 400.

### Harness Adapters And Runs

`server/execution-adapters.ts` defines what an adapter knows about one harness: how to invoke it, which capabilities it has, which environment variables it needs, and how to read what it reports. `server/execution-runs.ts` owns everything else, so supporting another harness means adding an adapter, not a branch in lifecycle code.

- `list_execution_adapters` (`GET /api/execution-adapters`) reports each adapter's capabilities (`stdin_prompt`, `jsonl_events`, `final_message_file`, `model_selection`), the names of the credential variables it passes through, and whether it is available. `codex` runs `codex exec --json --color never --cd <worktree> --sandbox workspace-write --output-last-message <file> -`, located through `CLAW_TASK_HUB_CODEX_BIN` or `PATH`; a `.cmd`, `.bat`, or `.ps1` shim is refused because it would need a shell. `fake` is a deterministic harness that follows the same invocation contract without a model, available only with `CLAW_TASK_HUB_ENABLE_FAKE_HARNESS=1`.
- `launch_execution_attempt` (`POST /api/execution-attempts/<attempt>/launch`) needs an attempt in `provisioning` with an active, unexpired workspace lease whose worktree is in place (`attempt_not_launchable`, `workspace_not_ready`). An unknown adapter (`adapter_unknown`), a capability the adapter lacks (`capability_unsupported`, including `model` without `model_selection`), and an adapter that cannot be located (`adapter_unavailable`) are refused before any process starts.
- The harness is spawned in the leased worktree without a shell and with its instructions withheld. The runner then applies `launch`, binding the process identity and workspace lease; only when that compare-and-set wins does the harness receive its prompt on stdin. A losing launch, or a repeat of the winning `idempotency_key`, has its process tree terminated before it receives anything.
- The environment is an allowlist of system variables, the adapter's declared variables, and `CLAW_TASK_HUB_ATTEMPT_ID`, `CLAW_TASK_HUB_ISSUE`, and `CLAW_TASK_HUB_WORKTREE`; the hub's own settings never reach a harness. Credential variables are passed through, their values are scrubbed from captured output and the final message, and only their names are recorded.
- Captured stdout and stderr keep the head and tail of `captured_stream` bytes with an explicit marker for what was dropped. Exceeding `harness_wall_clock` or `harness_idle_output` fails the attempt with `harness_timeout`. A launch may tighten these limits and `cancellation_grace`, never loosen them.
- The runner watches the attempt. When anyone moves it out of `running` -- a cancel, fail, or quarantine, from any process -- the harness process tree receives a cooperative stop, then the grace period, then a forced stop. On Windows the cooperative stop is best effort and the forced stop terminates the tree.
- When the harness exits, scrubbed logs are written under `attempt-logs/<attempt>/` next to the database and recorded as `harness_stdout`, `harness_stderr`, and `harness_final_message` artifacts. The attempt moves to `verifying` with `complete_run` when the process exits 0 and, for adapters with `jsonl_events`, the turn completed; otherwise it moves to `failed` with `harness_failed` or `harness_timeout`. The ledger records the adapter and its version, the command name and argument count, environment variable names, bounds, exit code, signal, duration, byte counts, truncation, timeout, event count, and thread id.
- With `wait=true` the call returns the run outcome. Otherwise the run finishes in the process that launched it, which stays alive until the harness exits and its outcome is recorded.

### Execution Evidence And Verification

`server/execution-evidence.ts` records what was observed about an attempt as typed, append-only evidence (`execution-evidence/v1`) and decides verification from it. Observation and judgment stay apart: only a verdict says whether evidence satisfied a policy, and a passing verdict makes an attempt `reviewable`, never `accepted`.

- Verification policies are operator configuration keyed by repository; a repository's own files never define what verification means or which programs run. `save_verification_policy` (`POST /api/verification-policies`) requires `actor_kind` `operator` and saves a new revision each time. `get_verification_policy` (`GET /api/verification-policies?repository=<repository>`) returns the latest or a named revision. A step has a `name`; a `command` argument vector run without a shell, whose executable is an absolute path or a program on `PATH` and never a path inside the repository; an optional `version_command`; a `timeout_ms` within `verification_step`; and `required` (default true). `require_changes` (default true) fails an attempt whose worktree has no changes.
- `capture_execution_diff` (`POST /api/execution-attempts/<attempt>/diff`) stages the worktree into a scratch index seeded from the base commit. Untracked files count, ignored files do not, and the worktree's own index is untouched. The record lists touched files (status, rename or copy source and similarity, modes, blobs, line counts, binary flag) and totals. It also holds the SHA-256 and size of the complete patch, a bounded, scrubbed `diff_patch` artifact, and the tree fingerprint, which is the Git tree id of the exact content.
- `record_execution_evidence` (`POST /api/execution-attempts/<attempt>/evidence`) appends an `observation` or a `claim`. An observation has a status of `passed`, `failed`, `timed_out`, `canceled`, or `error`, and carries its command, exit code, duration, a scrubbed and bounded log artifact, artifact references, and tool versions. A claim, such as a formal proof or an external attestation, is recorded but never satisfies a policy. Evidence carries the fingerprint it was made against, captured at recording time when not given. Records never change. A correction names the record it `supersedes`, which must be earlier evidence of the same kind and name on the same attempt. Diffs and verdicts come only from the hub, and an unknown `schema_version` is `schema_unsupported`.
- `verify_execution_attempt` (`POST /api/execution-attempts/<attempt>/verify`) has three preconditions:
  - the attempt is in `verifying` (otherwise `attempt_not_verifying`);
  - it has an unreleased workspace whose worktree is in place (otherwise `workspace_not_ready`);
  - a policy exists for its repository (otherwise `policy_not_found`).

  It captures a diff and runs each policy step in the worktree. Each step gets the harness environment allowlist, the `verification_step` and `captured_stream` bounds, and process-tree termination. Each step is recorded as an observation with scrubbed stdout and stderr artifacts. `run_steps=false` evaluates recorded evidence without running anything.
- For each required step, the verdict counts the latest observation that has not been superseded, preferring one made against the current fingerprint. The failure reasons are:
  - `checks_failed`: a step failed, timed out, was canceled, or errored, or the diff is empty under `require_changes`.
  - `stale_base_evidence`: the evidence was made against other content, including content a step itself changed.
  - `evidence_missing`: there is no observation, or a local artifact no longer exists.

  The verdict is recorded with its findings. It then applies `pass_verification` or `fail_verification` as `control_plane`/`verifier`, recording the verdict id, policy revision, fingerprint, and findings in the ledger. If that transition loses its compare-and-set, the verdict stays recorded and the result reports `transition_error`.
- If the attempt leaves `verifying` while a step runs, for example through a cancel from any process, the step's process tree is stopped. The step is recorded as `canceled`, and verification ends without a verdict (`stopped_by_state`). Logs and patches live under `attempt-logs/<attempt>/` next to the database, and declared credential values are scrubbed from every stored log, patch, command, and summary.
- `list_execution_evidence` (`GET /api/execution-attempts/<attempt>/evidence`, filterable by `kind` and `name`) and `get_execution_evidence` (`GET /api/execution-evidence/<evidence>`) read the history. HTTP statuses:
  - 404: missing attempts, policies, and evidence.
  - 409: `attempt_not_verifying`, `workspace_not_ready`, and `policy_conflict`.
  - 500: `git_failed`.
  - 400: invalid input and `schema_unsupported`.

### Execution Conflicts

`server/execution-conflicts.ts` detects touched-file overlaps between live attempts in the same repository and keeps an auditable record of each one.

- Paths come from two sources that are never confused. Declared paths are intent: `declare_execution_paths` (`POST /api/issues/<issue>/execution-paths`) saves a revision of the repository-relative paths an issue plans to touch; a trailing slash declares a directory, and wildcards and `..` are refused. Observed paths are the files in an attempt's latest diff evidence, where a rename touches both its source and its target and a deletion touches the deleted path.
- Detection methods, strongest first:
  - `exact_path`: the same path on both sides. Its certainty is `observed` when both sides observed it and `declared` otherwise.
  - `declared_directory`: a declared directory contains the other side's paths (`declared`).
  - `shared_directory`: different files in one directory. This is a `heuristic` and is always labelled as one.
  - `base_divergence`: the attempts are pinned to different bases, and a touched path changed between them, found with `git diff` in either attempt's worktree along with the bases' ancestry. When the bases cannot be compared, one record with certainty `unknown` says so instead of implying there is no risk.
- Records never claim more than was seen. When an attempt has no diff yet, or its diff was truncated, the record's `detail` says its observed paths are incomplete.
- Severity comes from the repository's operator conflict policy. `save_conflict_policy` (`POST /api/conflict-policies`) maps `exact_path_observed`, `exact_path_declared`, `declared_directory`, `shared_directory`, and `base_divergence` to `ignore`, `info`, `warning`, or `blocking`. The defaults are `warning`, and `info` for the heuristic, which can never block. Without a policy nothing blocks.
- `detect_execution_conflicts` (`POST /api/execution-conflicts/detect`) records each overlap once per attempt pair, method, and path. Every record names both attempts, the path, both bases, the method, the certainty, the severity, and the status (`open`, `resolved`, or `overridden`).
  - Detection also runs when paths are declared, when a diff is captured, during verification, and before every launch.
  - An overlap that disappears, or whose attempt is no longer live, is resolved. One that returns is reopened.
- `decide_execution_conflict` (`POST /api/execution-conflicts/<conflict>/decisions`) lets an operator `override` an open conflict or `reopen` an overridden one, with a required reason.
  - An override persists until the overlap escalates in severity or certainty, which reopens it.
  - Every status change is appended to the conflict's decision log (`get_execution_conflict`), so overrides never erase the audit trail.
- Surfaces:
  - `launch_execution_attempt` refuses an attempt with an open blocking conflict against another live attempt (`conflict_blocked`, HTTP 409).
  - `list_runnable_issues` compares an issue's declared paths with the live attempts of other issues. Blocking overlaps exclude it with `path_conflict`, and other overlaps are listed as `path_warnings`.
  - `claim_issue` refuses a `path_conflict` unless `force=true`, and returns `path_warnings`.
  - `capture_execution_diff` and `verify_execution_attempt` return the attempt's conflicts, and verdicts record them for review without changing the outcome.
- `list_execution_conflicts` (`GET /api/execution-conflicts`, filterable by `repository`, `attempt_id`, `issue_id`, and `status`) lists blocking conflicts first; resolved ones appear only with `include_resolved=true` or an explicit status. Missing issues, attempts, and conflicts are 404; `invalid_decision` and `revision_conflict` are 409.

### Execution Acceptance

`server/execution-acceptance.ts` owns the path after verification. A passing verdict makes an attempt `reviewable`, and only an operator's acceptance policy turns reviewable work into accepted work.

- `save_acceptance_policy` (`POST /api/acceptance-policies`, operator only) saves a revision of a repository's acceptance settings (`acceptance-policy/v1`):
  - `commit_author`: the name and email for the acceptance commit.
  - `merge_target`: a local branch to merge into.
  - `push` with `remote`, which requires `allow_push`.
  - `pull_request` with `provider`, `base_branch`, and `merge`. It requires `allow_pull_request` and `push`, and `merge` requires `allow_provider_merge`.
  - `complete_issue` and `release_workspace`, both on by default.

  `merge_target` and `pull_request` are alternatives. Remotes never contain credentials; Git and the provider take them from the operator's environment. `get_acceptance_policy` reads a revision. `list_execution_providers` (`GET /api/execution-providers`) reports `github`, which uses the GitHub CLI with `GH_TOKEN` or `GITHUB_TOKEN`, and `fake`, which is deterministic and available only with `CLAW_TASK_HUB_ENABLE_FAKE_PROVIDER=1`.
- `accept_execution_attempt` (`POST /api/execution-attempts/<attempt>/accept`) needs a `reviewable` attempt, a policy, and an `idempotency_key`. The run is recorded before it does anything, then:
  1. It requires the latest verdict to have passed (`verification_missing`), re-detects conflicts and refuses open blocking ones (`conflict_blocked`), and needs the worktree in place (`workspace_not_ready`).
  2. It commits the worktree on the attempt branch with hooks and signing disabled. The staged tree must equal the verified tree (`verification_stale`); an already committed verified tree is reused, and no changes is `nothing_to_commit`.
  3. With `merge_target`, it merges the commit without a checkout. `git merge-tree --write-tree` writes the merge, `commit-tree` records it (or the branch fast-forwards), and `update-ref` moves the branch only from the commit the merge was computed on. A missing branch is `merge_target_missing`, a branch checked out in any worktree is `merge_target_checked_out`, and a branch that moved is `merge_target_moved`.
  4. With `push`, it pushes the attempt branch, and the merge target when configured (`push_rejected`).
  5. With `pull_request`, it finds or opens the pull request and, if configured, merges it through the provider (`provider_unavailable`, `provider_failed`).
  6. It applies `accept`, naming `acceptance-policy:<policy>@<revision>` and recording `commit`, `merge_commit`, and `pull_request` artifacts with their identities.
  7. It settles the issue: an idempotent acceptance comment, the claim released as `completed`, and the issue marked Done. Then it releases the workspace lease, removing the clean worktree and keeping the branch.
- Every step records the point it reached (`execution_acceptances`). Repeating the idempotency key returns a finished run or resumes an interrupted one without repeating a commit, merge, push, or pull request, and every step is also safe to repeat on its own.
  - A failure before `accept` marks the run `failed` with its typed outcome, and the attempt stays reviewable.
  - A merge conflict, locally or through the provider, applies `reject` with `merge_conflict`, marks the run `rejected`, and keeps the claim so the work can be retried on a new attempt.
  - A failure after `accept` keeps the run `in_progress` so that retrying finishes settling it.
  - Only one run per attempt can be in progress (`acceptance_in_progress`).
- `reject_execution_attempt` (`POST /api/execution-attempts/<attempt>/reject`) applies `reject` with `review_rejected`, keeps the evidence and branch, and releases the claim unless `release_claim=false`. Releasing a released claim does nothing.
- `list_execution_acceptances` (`GET /api/execution-attempts/<attempt>/acceptances`) and `get_execution_acceptance` (`GET /api/execution-acceptances/<acceptance>`) read the runs. Git and provider output is scrubbed of every declared credential value before it is stored or returned.
- HTTP statuses:
  - 404: missing attempts, policies, and runs.
  - 409: failed preconditions and state conflicts.
  - 502: rejected pushes and failed provider calls.
  - 503: an unavailable provider.
  - 500: `git_failed`.

### Execution Reconciliation

`server/execution-reconciliation.ts` compares durable execution state with real processes and Git resources after crashes. It records a run for every reconciliation and a decision for every repair, quarantine, release, skip, or failure (`execution_reconciliation_runs`, `execution_reconciliation_decisions`).

- Runs keep a supervisor heartbeat (`execution_runners`, every `CLAW_TASK_HUB_RUNNER_HEARTBEAT_MS`, 10 seconds by default). They record their outcome before applying the finish transition, so a supervisor that dies between the two leaves exactly what to apply.
- `reconcile_execution` (`POST /api/execution-reconciliation`) examines every attempt or one `attempt_id`:
  - **Interrupted acceptances** are resumed with their own idempotency key, because the operator's policy already authorized them.
  - **`running` attempts:**
    - If the runner's heartbeat is fresh, nothing happens.
    - If the runner recorded an outcome but its transition never landed, that outcome is applied with the runner's own idempotency key (`result_unrecorded`).
    - Otherwise the attempt is quarantined as `stale` with `heartbeat_lost` (`dead_runner`, `orphaned_process`, or `runner_unreachable`). A harness process that is still alive is reported and left running, because the hub cannot prove it started that process ID.
  - **`provisioning` attempts** whose lease failed, was interrupted, expired, or lost its worktree are resumed through provisioning, which verifies before reusing anything. If that fails, the attempt is quarantined with `base_drift`, `branch_moved`, `lease_expired`, or `worktree_missing`, and a lease still being provisioned by another process is skipped.
  - **`verifying` and `reviewable` attempts** are quarantined when their worktree is missing (`worktree_missing`), the worktree is no longer on the leased branch (`branch_moved`), or the branch no longer contains the base (`base_drift`). An expired lease on an intact worktree is renewed through provisioning.
  - **`stale` and `reconciling` attempts** are counted as awaiting an operator.
  - **Leases still held by terminal attempts** are released: clean worktrees are removed, dirty ones retained, and branches always kept.
  - **Reported only:** attempts whose claim or session lapsed, and directories under the workspace root that no lease owns.
- Reconciliation never removes a dirty or unowned worktree and never kills a process.
- It is bounded and ignores anything changed within `min_age_ms` (10 minutes by default), so it does not race work in flight in another process. `runner_stale_ms` (2 minutes by default) decides when a heartbeat is lost, and `limit` caps each category.
- One run holds the lock at a time (`reconciliation_in_progress`, HTTP 409). A run that stopped reporting for 15 minutes is marked `abandoned`. Repeating a run after any crash is safe.
- The API server reconciles at startup and every five minutes. `CLAW_TASK_HUB_RECONCILE=0` disables this, and `CLAW_TASK_HUB_RECONCILE_INTERVAL_MS` changes the interval.
- Operators inspect runs with `list_reconciliation_runs` and `get_reconciliation_run` (`GET /api/execution-reconciliation/runs[/<run>]`). They quarantine a live attempt with `quarantine_execution_attempt` (`POST /api/execution-attempts/<attempt>/quarantine`), which applies `begin_reconciliation` with the current state as the origin. After that they can:
  - resume, fail, or cancel it with `transition_execution_attempt`;
  - retry the work as a new attempt with `retry_of`;
  - release its workspace with `release_execution_workspace`.
- `CLAW_TASK_HUB_RECONCILE_MIN_AGE_MS` and `CLAW_TASK_HUB_RUNNER_STALE_MS` override `min_age_ms` and `runner_stale_ms` for startup and periodic runs.
- Test-only fault points crash a real process at a named boundary: `provision:lease_recorded`, `provision:worktree_created`, `run:supervising`, `run:outcome_recorded`, and `accept:committed`. They are active only when both `CLAW_TASK_HUB_ENABLE_FAULT_INJECTION=1` and `CLAW_TASK_HUB_FAULT_INJECTION=<point>` are set.

### Control-Plane Surfaces

Agents and operators reach the same domain rules through the API, MCP, the hub CLI, and the UI; no surface has its own path around them.

- **Execution panel.** Issue detail, both the side panel and the dialog, has an Execution panel (region "Execution control").
  - It shows the latest attempt's state: provisioning, running, verifying, reviewable, accepted, failed, canceled, stale, or reconciling.
  - It also shows the workspace lease, the latest verdict, open conflicts, the latest acceptance run, the issue's runnability, and earlier attempts.
- **Panel controls.** Each control calls the HTTP handler behind the matching tool, and a refusal is shown with its typed code:
  - Launch (adapter and prompt) for a provisioned attempt
  - Verify for a verifying attempt
  - Accept and Reject for a reviewable attempt
  - Cancel and Quarantine for live attempts
  - Resume for a reconciling attempt
  - Reconcile for live attempts
  - Retry, which creates a `retry_of` attempt under the issue's active claim, for failed and canceled attempts
- **Runnable queue.** The project overview shows the project's runnable queue, with the reason codes of waiting issues.
- **End-to-end test.** `tests/control-plane-e2e.mjs` is the acceptance test for this path. In a temporary Git repository it:
  1. claims an issue, provisions a worktree and branch at a pinned base, launches the fake adapter, records diff and verification evidence, reaches `reviewable`, accepts under a local policy, and releases the claim;
  2. restarts the API server during a run and checks that startup reconciliation quarantines the attempt, then cancels it, retries it, and accepts the retry;
  3. drives the served UI in a browser, including a typed error, keyboard activation, a real accept, a stale attempt canceled from the panel, the phone-width layout, and the runnable queue.

<!-- execution-contract:generated:start -->

Contract version: `execution-contract/v1`. Generated from `server/execution-contract.ts` by `bun run contract:generate`; edit that module, not this block.

#### States

| State | Terminal | Allowed events | Meaning |
| --- | --- | --- | --- |
| `provisioning` | no | `launch`, `fail`, `cancel`, `mark_stale`, `begin_reconciliation` | The attempt exists with its base commit SHA pinned; the leased branch and worktree are being created. No harness process runs yet. |
| `running` | no | `complete_run`, `fail`, `cancel`, `mark_stale`, `begin_reconciliation` | The branch and worktree lease is recorded and a harness adapter process runs inside the leased worktree. |
| `verifying` | no | `pass_verification`, `fail_verification`, `fail`, `cancel`, `mark_stale`, `begin_reconciliation` | The harness process tree has exited and configured verification steps run against the attempt's changes. |
| `reviewable` | no | `accept`, `reject`, `cancel`, `mark_stale`, `begin_reconciliation` | Recorded evidence satisfies the verification policy. The attempt waits for an acceptance decision; passing verification never accepts it. |
| `accepted` | yes | none | The named acceptance policy succeeded and the resulting commit, PR, or merge identity is recorded. |
| `failed` | yes | none | The attempt cannot reach acceptance and its reason code is recorded. A retry is a new attempt. |
| `canceled` | yes | none | An authorized actor stopped the attempt; its process tree is terminated and its resources are released or quarantined. |
| `stale` | no | `fail`, `cancel`, `begin_reconciliation` | Quarantined: the pinned base drifted, the lease expired, the owning session stopped heartbeating, or Git resources went missing. Work is preserved but cannot advance. |
| `reconciling` | no | `fail`, `cancel`, `mark_stale`, `resume` | Recovery is comparing the durable record with real process and Git state after a crash, restart, or operator request. |

#### Transitions

| Event | From | To | Actors | Requires | Reason codes | Effect |
| --- | --- | --- | --- | --- | --- | --- |
| `launch` | `provisioning` | `running` | `control_plane` | none | none | The branch and worktree lease is recorded and the adapter started the harness inside the leased worktree. |
| `complete_run` | `running` | `verifying` | `control_plane` | none | none | The harness process tree exited and its bounded output was captured. |
| `pass_verification` | `verifying` | `reviewable` | `control_plane` | none | none | Recorded evidence satisfies the configured verification policy. |
| `fail_verification` | `verifying` | `failed` | `control_plane` | none | `checks_failed`, `evidence_missing`, `stale_base_evidence` | Recorded evidence does not satisfy the verification policy. |
| `accept` | `reviewable` | `accepted` | `operator`, `control_plane` | `policy` | none | The named acceptance policy succeeded. The control plane accepts only under an explicitly configured policy. |
| `reject` | `reviewable` | `failed` | `operator`, `control_plane` | none | `review_rejected`, `merge_conflict` | Review rejected the attempt or its merge could not complete. |
| `fail` | `provisioning`, `running`, `verifying` | `failed` | `agent`, `operator`, `control_plane` | none | `provisioning_failed`, `harness_failed`, `harness_timeout`, `verification_error`, `abandoned` | Live work cannot continue. Any retry is a new attempt. |
| `fail` | `stale`, `reconciling` | `failed` | `operator`, `reconciler` | none | `reconciliation_failed`, `abandoned` | Quarantined or recovering work is abandoned after inspection. |
| `cancel` | `provisioning`, `running`, `verifying`, `reviewable` | `canceled` | `agent`, `operator`, `control_plane` | none | `agent_requested`, `operator_requested`, `claim_released`, `superseded` | An authorized actor stopped the attempt; the harness process tree is terminated. |
| `cancel` | `stale`, `reconciling` | `canceled` | `operator` | none | `operator_requested` | Only an operator cancels quarantined or recovering work. |
| `mark_stale` | `provisioning`, `running`, `verifying`, `reviewable`, `reconciling` | `stale` | `control_plane`, `reconciler` | none | `base_drift`, `lease_expired`, `heartbeat_lost`, `worktree_missing`, `branch_moved` | Quarantine without deleting work when the base, lease, heartbeat, or Git resources no longer hold. |
| `begin_reconciliation` | `provisioning`, `running`, `verifying`, `reviewable`, `stale` | `reconciling` | `operator`, `reconciler` | none | none | Recovery starts comparing durable state with real process and Git state; the current state is recorded as the origin. |
| `resume` | `reconciling` | recorded origin | `operator`, `reconciler` | resumable origin | none | Reconciliation confirmed that real state matches the recorded origin, so the attempt continues there. |

#### Actors

| Actor | Authority |
| --- | --- |
| `agent` | The agent session that owns the attempt's claim. It may act only on attempts whose `session_id` is its own. |
| `operator` | A human acting through the local UI, CLI, or MCP with explicit intent. Required for quarantine-breaking and destructive actions. |
| `control_plane` | The hub's orchestration: provisioning, harness adapters, verifiers, and explicitly configured acceptance policy. |
| `reconciler` | Startup or periodic recovery. It quarantines work when intent is unclear and never cancels live work on its own. |

#### Typed failures

Requests are checked in this order and fail with the first code that applies.

| Code | Meaning |
| --- | --- |
| `unknown_state` | The attempt record holds a state this contract version does not define. |
| `invalid_request` | The request or attempt record is malformed: blank or oversized idempotency key, non-integer revision, unknown actor kind, blank actor id, or oversized note. |
| `unknown_event` | The event is not defined by this contract version. |
| `idempotency_conflict` | The idempotency key already applied a different event to this attempt. |
| `revision_conflict` | `expected_revision` is not the attempt's current revision because another writer moved it first. Re-read before retrying. |
| `terminal_state` | The attempt is `accepted`, `failed`, or `canceled`. Terminal attempts never change; retry with a new attempt. |
| `invalid_transition` | The event is not allowed from the current state. The failure lists the events that are. |
| `unauthorized_actor` | The actor kind may not perform this event, or an agent acted on an attempt owned by another session. |
| `invalid_reason` | The matched transition requires one of its listed reason codes and got none or another value, or a reason code was given to a transition that takes none. |
| `policy_required` | Acceptance must name the policy that authorized it. |
| `origin_not_resumable` | `resume` needs a recorded reconciliation origin of `provisioning`, `running`, `verifying`, or `reviewable`. |

#### Default bounds

| Bound | Default | Meaning |
| --- | --- | --- |
| `harness_wall_clock` | 2 h | Longest a harness process tree may run before the attempt fails with `harness_timeout`. |
| `harness_idle_output` | 15 min | Longest a running harness may produce no output before it is treated as hung. |
| `captured_stream` | 1 MiB | Captured stdout or stderr per stream; output beyond it is truncated with an explicit marker. |
| `verification_step` | 30 min | Longest a single verification step may run. |
| `cancellation_grace` | 10 s | Wait between the cooperative stop signal and termination of the whole process tree. |
| `concurrent_attempts_per_repository` | 4 | Non-terminal attempts sharing one repository. |
| `live_attempts_per_issue` | 1 | Non-terminal attempts per issue. Another launch is refused, not queued, until the live one ends. |
| `idempotency_key` | 200 characters | Maximum idempotency key length. |
| `transition_note` | 2000 characters | Maximum transition note length. |

<!-- execution-contract:generated:end -->

### Boundaries

- **Local only.** Execution control runs inside the loopback-bound local service and adds no network listener or remote callback. Push, PR creation, and merge are remote mutations and happen only under an explicitly configured policy with operator-provided authority.
- **Operator approval.** `accept` always names the policy that authorized it, and the control plane accepts only under an explicitly configured policy, never because verification passed. Canceling quarantined (`stale`) or recovering (`reconciling`) work, forcing another session's claim, and destructive cleanup require an operator.
- **Dirty checkouts.** The operator's current checkout is never modified, cleaned, reset, stashed, or reused as a worktree. Provisioning creates a new worktree from the pinned SHA. Reconciliation and cleanup never remove a dirty worktree or one the attempt does not own; they quarantine the attempt as `stale` instead.
- **Untrusted repositories and paths.** Repository content, including hooks, filters, configuration, and agent-produced files, is untrusted input. Control-plane Git commands must not run repository hooks or scripts. Worktree paths are derived by the hub, resolved to an absolute path inside the configured workspace root, and rejected when they escape it through `..`, symlinks, or junctions, or when the target already exists. Repository identity is validated before provisioning.
- **Command construction.** Git and harness processes are launched with argument arrays and no shell. Issue titles, descriptions, comments, and agent-supplied text are never interpolated into commands. Branch and worktree names are generated from validated identifiers.
- **Credentials.** Passwords, tokens, keys, cookies, and connection strings never enter attempt records, transition history, evidence, or logs. Harness environments are built from an explicit allowlist, secret values reach a harness only through that environment, and captured output is scrubbed before it is stored.
- **Process trees.** Cancellation and time bounds signal the harness, wait the cancellation grace period, then terminate the whole process tree. A process the hub cannot prove it started is reported, never killed.
- **Network.** The hub does not broker harness network access in this contract version. A harness's own network use is the operator's policy decision and is recorded in adapter provenance, and attempt endpoints are never exposed beyond loopback.
- **Bounds.** The defaults above apply until a runtime slice makes them configurable. Crossing a time bound fails the attempt with a typed reason; captured output beyond its bound is truncated with an explicit marker.

## Pre-Production Gate

Use [GITHUB_OSS_READINESS.md](GITHUB_OSS_READINESS.md) as the public GitHub release checklist.

Before public GitHub publication, the repo should pass:

- `bun run build`
- `bun run lint`
- `bun run store-regression`
- `bun run harness-smoke`
- `bun run ui-smoke`
- `bun run public-hygiene`
- a secret scan and data exclusion review
- README, license, sample config, and contribution documentation review
