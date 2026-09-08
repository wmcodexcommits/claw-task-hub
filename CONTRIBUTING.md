# Contributing

Thank you for helping improve Claw Task Hub.

## Product Direction

Claw Task Hub is local-first and agent-first. Human readability matters, but every change should preserve deterministic workflows for AI agents and agentic harnesses.

Good contributions improve one or more of these areas:

- reliable CLI and MCP tool behavior;
- issue/session/claim coordination for multiple agents;
- local SQLite durability and upgrade safety;
- clear agent-facing documentation;
- Linear-like UI clarity without turning the app into a hosted service by default.

## Development Setup

```powershell
bun install --frozen-lockfile
bun run dev
```

The UI runs at `http://localhost:5173`. The API listens on `127.0.0.1:4781` by default.

## Required Checks

Install `pre-commit` once, then install dependencies. Bun configures the
repo-owned hooks automatically:

```powershell
pipx install pre-commit
bun install --frozen-lockfile
```

Every commit and push dispatches the same canonical gate:

```powershell
bun run verify
```

Do not bypass a failed hook. `package.json` owns the check list; hooks and
GitHub Actions only dispatch `bun run verify`. The stable `Verification Gate`
and `Windows Portability` checks in `.github/rulesets/main.json` must be
required on the protected default branch, which is the server-side enforcement
for contributors who bypass local hooks.

`ui-smoke` uses a temporary seeded database and local ports so it can run from
a fresh checkout. Its first run may download Playwright Chromium.

## Release Workflow

1. Update `package.json` with a valid SemVer and add the matching changelog section.
2. Run `bun run verify` against the exact release tree.
3. Create and push the matching tag, for example `v0.2.0`.
4. The tag-only release workflow verifies the tag, builds Linux, macOS, and Windows packages, smoke-tests them, and creates the GitHub Release.

Normal branch pushes do not start duplicate hosted verification. Pull requests
run one full Linux gate plus a bounded Windows portability gate, and superseded
runs are cancelled.

## Pull Request Guidelines

- Keep changes scoped and reviewable.
- Add or update tests for behavior changes.
- Update docs when tool contracts, status semantics, startup behavior, or security boundaries change.
- Use concise issue titles and detailed descriptions or comments.
- Preserve local-first defaults.

## Public Hygiene

Do not commit:

- SQLite databases, WAL/SHM files, logs, screenshots, generated reports, or scratch files;
- passwords, API keys, OAuth tokens, cookies, private keys, or proxy credentials;
- machine-specific paths, private LAN addresses, user names, or customer data;
- text that is not appropriate for a public repository.

Run `bun run public-hygiene` before publishing or opening a pull request.

## External Import Boundary

External tracker import code is retained only for explicit operator-run history imports. Normal work must not connect to external ticketing services or expose import tools in the standard tool list.
