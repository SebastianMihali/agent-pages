# Export a site's active revision as ZIP

Status: ready-for-agent
Progress: done
Blocked by: —

## Scope

Implement [the ZIP export contract](../spec.md) using [the plan](../plan.md).

## Acceptance

- [x] Exact complete archives retain one revision during publication and cleanup.
- [x] Owner-only REST/web export and dashboard download work with safe headers.
- [x] Cancellation, errors, shutdown, concurrency and timeout are bounded.
- [x] Focused, full and production browser checks pass; independent review is resolved.
- [x] Contract and user documentation match the implementation.

## Verification

2026-09-08:

- Added owner-authorized `SiteModule.exportSite`, an archive-lifetime revision lease, a streaming ZIP adapter, REST/session download routes, and the dashboard action. `yazl` 3.3.1 owns ZIP encoding; `fflate` 0.8.2 is an independent test-only decoder. No schema migration or deployment change.
- TDD seams confirmed by the owner: SiteModule, HTTP handlers and production dashboard. Observed failing tests before implementation for complete archives, capacity, interruption, REST, web and browser download. Review regressions reproduced failures for drive-like POSIX filenames and authenticated HEAD before their fixes.
- Focused site/REST/web checks passed during implementation. Final `pnpm lint` and `pnpm typecheck` passed. `pnpm test` ran once at the final verification stage: **120 passed in 19 files**.
- Final `pnpm test:browser`, including its production build: **15 passed, 1 intentionally skipped** on Chromium 153.0.8010.12 and Firefox 155.0. The skip is the pre-existing duplicate native-process check under Firefox. Downloaded ZIPs were independently decoded and checked in both browsers; authenticated HEAD returns 405 through production HTTP. The mobile screenshot was visually inspected.
- ZIP tests cover binary/Unicode/empty/nested files, files beyond pagination, accepted colon paths, exact bytes, no metadata leakage, concurrent publication and cleanup, other-owner/public/expired/deleted denials, capacity, cancellation during reading, request abort, timeout, shutdown, missing and truncated files. HTTP tests cover credential separation, revocation, Origin/fetch metadata, safe headers, query rejection and method handling.
- One isolated macOS arm64 / Node 24.16 run streamed **50,331,655 site bytes** into **50,332,167 ZIP bytes** in **150 ms**. Largest observed output chunk: **65,536 bytes**; peak RSS increase during export: **19,218,432 bytes**. The fixture was removed. Single-run process measurements include runtime/GC effects and do not establish production throughput or memory guarantees.
- `pnpm audit --prod`: no known vulnerabilities reported at verification time.
- Independent [Standards and Spec review](../review.md): no remaining findings after two Spec fixes.
- Remaining scope limits: no ZIP import, history, installation backup or MCP binary tool. Entries are stored without compression; drive-like POSIX names have an explicit `./` archive prefix. Real Coolify/proxy validation remains the separate deployment milestone.
