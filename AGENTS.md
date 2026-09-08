## Claw Task Hub Project Instructions

- Product name: Claw Task Hub.
- This repository is a local-first, Linear-like task hub designed primarily for AI agents and agentic harnesses.
- Keep the product universal across harnesses. MCP-compatible agents, CLIs, and local automation runners are the target surface.
- Use relative repository paths in documentation and code examples. Do not commit machine-specific install paths, LAN addresses, proxy settings, VPN settings, or user names.
- Default API behavior must remain local-only. Non-loopback binding requires an explicit unsafe flag and must be documented as unsupported for public deployment without additional authentication.
- The default local database is under `data/`; generated SQLite files, logs, screenshots, reports, and scratch files must stay untracked.
- External tracker imports must stay in standalone operator tools and must not appear in normal API, CLI, or MCP runtime paths.
- Normal Claw Task Hub work must not depend on any external ticketing account or hosted tracker.
- Run `bun run verify` before release-oriented changes are considered done. `package.json` is the sole verification-task authority; hooks and hosted CI dispatch that same command rather than maintaining parallel check lists.
- Before every commit, run `bun run verify` against the exact tree being committed. Do not commit if any check fails.
- Keep hosted CI usage bounded: do not run both branch-push and pull-request verification for the same change, cancel superseded pull-request runs, and run packaging/release jobs only for explicit SemVer tags.
- Treat `src/styles/design-system.ts` and `src/styles/app-rules.ts` as the sole styling authority. `src/App.css` is optimized generated output and must never be hand-edited. New or changed UI styles must reuse the kernel's tokens, typed rule nodes, and shared component primitives for color, typography, spacing, sizing, radii, focus, hover, disabled, motion, and responsive states. Raw colors belong only in the design kernel; breakpoint and shared layout geometry must be kernel values, while local structural geometry may remain in rule nodes. `bun run css:check` must reject generated drift. Every changed UI surface must have browser coverage for its relevant interaction, accessibility, and responsive states before commit.
- Use `docs/AGENTIC_HARNESS.md` as the canonical agent and harness contract.
- Use context bindings for project-bound harness startup. Bind stable keys such as repository remote, working directory, branch, or thread id to the owning project; never store secrets in binding metadata.
- Use visible issue identifiers such as `CTH-272`, `LOCAL-1`, or imported historical identifiers in conversation and tool calls.
- New issues must be filed under an explicit owning project id from `list_projects`; never infer or copy a default project id from unrelated examples.
- Do not store secrets in issues, comments, docs, tests, fixtures, or screenshots.
- In PowerShell, do not pass raw JSON to `bun run hub -- tools/call` when payloads contain comments, Markdown, quotes, backticks, or newlines. Use `base64:<json>` or `.\tools\cth-call.ps1 -Tool <tool> -InputObject $payload` instead of hand-escaping quotes.
