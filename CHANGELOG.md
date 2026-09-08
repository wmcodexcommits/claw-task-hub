# Changelog

All notable changes to Claw Task Hub will be documented in this file.

## Unreleased

## [0.2.0]

- Made Bun 1.3.14 the single package-manager and runtime contract, including native `bun:sqlite` storage.
- Added complete project, issue, and managed-database CRUD across HTTP, CLI, and MCP with destructive confirmation guards.
- Added one canonical contribution gate, repository hooks, bounded pull-request CI, SemVer validation, packaged-runtime smoke tests, and tag-only GitHub Releases.
- Consolidated shared UI styling, repaired responsive detail layouts, removed misleading and duplicate controls, and added browser regressions for those states.
- Added explicit mutation notifications so open UIs refresh after successful API, CLI, or MCP writes without database polling.
- Made temporary SQLite test cleanup Windows-safe by isolating store-regression database handles in a worker process and retrying transient filesystem locks.
- Made database activation fully release the previous Bun SQLite connection so switched databases can be deleted on Windows.
- Applied SQLite's busy timeout before WAL negotiation so concurrent CLI startup waits instead of failing with `SQLITE_BUSY_RECOVERY`.

## [0.1.0]

- Set the package version to `0.1.0` for the first public MVP release.
- Added MIT license for public release preparation.
- Kept optional Linear history import outside normal runtime as a standalone opt-in operator tool.
- Added agent session and issue claim lifecycle support for multi-agent coordination.
- Added harness smoke coverage for list, create, read, comment, session, claim, release, and close workflows.
- Added self-contained UI smoke coverage that runs against a temporary seeded database and random local ports.
- Added public quickstart, contribution, security, CI, and public hygiene checks.
- Added documentation for the optional one-off Linear history migration path.
- Set the API default bind host to loopback for local-first safety.
- Set browser date rendering to English for public UI consistency across host locales.
