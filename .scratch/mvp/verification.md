# Local MVP verification

Date: 2026-09-05. Remote Coolify deployment is intentionally deferred by the owner until domains and a target are selected. This record distinguishes local evidence from deployment acceptance.

## Automated application checks

`pnpm lint`, `pnpm typecheck` and `pnpm test` passed: **87 tests in 17 files**, no skipped fixtures. Tests use isolated temporary SQLite databases and file trees.

Coverage includes production configuration validation; exact host dispatch; bounded JSON and request admission; owner/session/CSRF/key isolation; ticket expiry/replay/site binding; replacement and revocation of grants; content routing/MIME/HEAD; all REST/MCP domain operations; multipart limits/order/trailer validation; cross-transport receipts; competing versions; staging reservations; visibility/lifecycle races; expiry; cleanup retries; and process crash/restart.

Storage-specific evidence includes an exact child exit at the post-finalize/pre-commit point, an OS advisory lock tested across competing/crashed processes, real symlink substitution and chmod/EACCES cleanup failure, same-size file corruption caught at startup, and mixed-character paginated manifests. ENOSPC is injected at the private file-copy failure seam; the test does not fill a physical disk. Power-loss durability on arbitrary filesystems is not claimed.

The 30-second request deadline cancels a stalled body reader; shutdown aborts mutation streams and drains work before closing the database. Cross-bundle domain-error tests preserve the intended error codes when Nitro bootstrap and TanStack SSR use separate constructors.

`pnpm audit --prod`: no known vulnerabilities reported at verification time. This is dependency-advisory evidence, not a security guarantee.

## Browser and production HTTP

Chromium and Firefox run against the real production bundle through an isolated local HTTPS proxy. The browser fixture uses production `__Host-` cookies and a generated test certificate, with certificate trust errors ignored only inside the test runner. `pnpm test:browser` passed 11 checks; one duplicate native-process check is intentionally skipped under Firefox because it already runs under Chromium and is browser-independent. Versions: Chromium 153.0.8010.12 and Firefox 155.0. Coverage includes keyboard/mobile UI, once-only key copy and revocation, private deep links through login, page/CSS/JS/image/font access, nested redirects, HEAD/custom 404, public/private transitions, logout, sibling fetch/frame/worker/document.domain isolation, production MCP initialization/tool calls, and structured version conflicts. Root inspected safe desktop/mobile screenshots.

Production integration fixes retained in the implementation include native `.node` dependency packaging, a process-wide initialization promise shared by Nitro/SSR, per-request CSP nonces attached through the supported Start router API, and origin-only referrers on controlled POST handoff forms.

## Real MCP clients

Codex CLI 0.153.4 and Claude Code 2.1.261 both completed real HTTP MCP create/read/update/replay/public/private workflows using the installed authenticated clients. Fixture state and anonymous/private/public responses were independently checked. API keys were revoked and subsequent MCP discovery returned 401.

See [client evidence and invocation isolation](../../docs/mcp-clients.md). These CLI workflows use source application handlers on loopback HTTP; production HTTPS transport is checked separately by the browser/integration suite. Second actual client processes reconnected to the same private site; missing and invalid bearer variables caused no authenticated calls or state changes. Both CLIs may exit zero while reporting unavailable MCP tools, so the harness verifies server events/state independently. No global client configuration was changed.

## Container and restore

Linux arm64 Docker builds compiled and traced native SQLite and flock dependencies. The runtime user is `node` (UID 1000), with a writable persistent volume. A competing same-volume container failed startup. Clean restart revoked old browser sessions and retained owner identity, API keys, visibility and site content.

A cold archive restored to a fresh volume, accepted owner login and the retained key, denied anonymous private content and accepted a versioned update at the same site ID. All temporary containers, volumes and credentials used for this workflow were removed. Docker Compose configuration/start/readiness/stop were also checked in an isolated project. Security audit events now cover login decisions, key creation/revocation, visibility and deletion with allowlisted identifiers only.

A separate actual-container check proves `env_file.format: raw` preserves all scrypt dollar signs; Compose 5.1.4 was used.

The local image `agent-pages:mvp-local` built successfully (Linux arm64, non-root). Its smoke verified readiness, SSR, anonymous management 401, unknown/content host isolation 404 and missing-configuration exit before serving. Image identity will be refreshed after review if code changes. Wildcard DNS, public certificate issuance and the actual Coolify proxy remain deployment checks, as explicitly requested by the owner.

## Publication measurement

`pnpm exec tsx scripts/benchmark-publication.ts` ran on Node 24.16.0, macOS arm64 with local APFS storage. Single-run results:

| Initial revision | Create | Update | Peak staged volume bytes |
| --- | --- | --- | --- |
| 64 KiB | 60 ms | 26 ms | 349,464 |
| 50 MiB | 206 ms | 64 ms | 105,076,643 |

Peak process RSS was 238,960 KiB, including the TypeScript runner and both fixtures. The update replaces index.html and copies unchanged assets. These measurements do not establish production latency or steady-state memory guarantees and did not justify a deduplication/cache subsystem.

## Documentation and skill

The Agent Pages skill passed the skill-creator validator in an isolated Python environment. Independent scenario review confirmed that updating an existing private site preserves visibility and identity, and that a lost response to an explicitly requested publication is retried with the original operation ID before reading current state.

The implementation uses explicit parameterized SQLite queries and module-owned migrations, as recorded in ADR 0003. Nitro's pinned beta is a bounded exception to the initial stable-dependency preference; production build/native/browser tests cover its integration. The owner UI uses small accessible Tailwind components without an unused component-library dependency.
