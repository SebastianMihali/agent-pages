# Default expiration and `set_site_expiration`

Status: ready-for-agent
Progress: done
Blocked by: 02

## Objective

Let the owner preset an expiration applied to every new site and change the expiration of an existing site without recreating it.

## Scope

Contract changes to write into the [MVP contract](../mvp/spec.md) before implementing, replacing "Expiration is immutable in this MVP":

- **Owner setting.** A per-owner `defaultExpiresInSeconds` stored in SQLite, initial value 604800 (7 days), allowed values 86400, 604800, 2592000 or `null`. Read and written only through the authenticated web handlers used by the dashboard. No environment variable, no REST/MCP exposure.
- **Creation.** When `expiresInSeconds` is omitted, apply the owner default at commit time. Explicit `null` means no expiration; an explicit number keeps its current bounds and wins. Existing sites are unaffected. The creation receipt fingerprint uses the resolved value so replays stay identical after a setting change.
- **Operation.** `set_site_expiration` on REST as `PUT /api/sites/:siteId/expiration` and as the MCP tool of the same name, with `{operationId, expectedVersion, expiresInSeconds}` where `expiresInSeconds` is an integer from 60 through 2,592,000 relative to the call or `null`. It increments `version`, records a receipt, and returns `{site, operationId, operationExpiresAt}`. An expired site returns `SITE_EXPIRED`; a tombstoned site `NOT_FOUND`. A replayed receipt describes the original result and is never re-applied. The tool is marked non-destructive and idempotent in the same way as `set_site_visibility`.
- **Dashboard.** A settings control with the four presets; in site detail, the current expiration with an action to extend, shorten or remove it, using the version-conflict handling already used for visibility.
- **Skill.** Teach reading `expiresAt` after creation, passing an explicit value when the user asks for one, and using `set_site_expiration` instead of recreating a site.

Keep the decision in the site module; REST, MCP and web adapters only validate and forward. Add the schema migration to the module-owned migrations with a test against a restored pre-change database.

## Acceptance

- [x] Creation without `expiresInSeconds` uses the owner default; explicit `null` and explicit numbers behave as specified, with tests for each and for replay after the default changed.
- [x] `set_site_expiration` works through REST, MCP and the dashboard with version conflicts, idempotent replay, `SITE_EXPIRED` and other-owner `NOT_FOUND`; expiry enforcement and cleanup use the new value.
- [x] Migration applies to an existing database and the cold-restore procedure still passes.
- [x] Contract, glossary, client documentation, README and skill are updated; the skill passes its validator.
- [x] Browser tests cover the settings presets and a per-site expiration change.

## Verification

2026-09-06: implemented by Codex from this ticket, reviewed and simplified by the orchestrator (`setExpiration` reuses `siteRow` and `ensureMutable` like `setVisibility`). Migration `0004_owner_settings` adds the per-owner table with a CHECK on the allowed presets; creation resolves the default inside the commit transaction and derives the original resolved value from the stored receipt on replay, so replays after a setting change still match. New `src/server/web-sites.test.ts` covers the settings and expiration web endpoints. `pnpm lint`, `pnpm typecheck`, `pnpm test` (106 tests in 18 files), `pnpm build` and `pnpm test:browser` (13 passed, 1 intentionally skipped, Chromium and Firefox) passed. The live Codex/Claude Code client run recorded in `docs/mcp-clients.md` predates the tool; the transport tests cover it and the document says so.
