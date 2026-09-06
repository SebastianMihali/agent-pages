# Default expiration and `set_site_expiration`

Status: ready-for-agent
Progress: open
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

- [ ] Creation without `expiresInSeconds` uses the owner default; explicit `null` and explicit numbers behave as specified, with tests for each and for replay after the default changed.
- [ ] `set_site_expiration` works through REST, MCP and the dashboard with version conflicts, idempotent replay, `SITE_EXPIRED` and other-owner `NOT_FOUND`; expiry enforcement and cleanup use the new value.
- [ ] Migration applies to an existing database and the cold-restore procedure still passes.
- [ ] Contract, glossary, client documentation, README and skill are updated; the skill passes its validator.
- [ ] Browser tests cover the settings presets and a per-site expiration change.

## Verification

Record focused site-module, API, MCP and browser tests, the migration test and the full `pnpm check`.
