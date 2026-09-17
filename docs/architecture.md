# Architecture

Agent Pages is a single-owner static hosting application. One Node.js process owns SQLite metadata and immutable site revisions on one local persistent volume. REST, MCP and the dashboard use the same site module for publication, visibility, expiration and deletion.

The [glossary](../CONTEXT.md) defines the domain terms. The public integration contract is documented in the [REST API reference](api.md) and [agent skill](../skills/agent-pages/SKILL.md). Runtime settings and limits are listed in [`.env.example`](../.env.example) and validated by [`config.ts`](../src/server/config.ts).

## Module boundaries

| Responsibility | Source |
| --- | --- |
| Site lifecycle, atomic publication, quotas and receipts | `src/server/sites/` |
| Identity, sessions, private-site grants and API keys | `src/server/auth/` |
| Host validation and content delivery | `src/server/hosts.ts`, `src/server/content.ts`, `src/server/access.ts` |
| REST and MCP adapters | `src/server/api.ts`, `src/server/mcp.ts`, `src/server/mcp-tools.ts` |
| Dashboard transport | `src/server/web-auth.ts`, `src/server/web-sites.ts`, `src/server/web-file.ts` |
| File rules shared by server and browser | `src/shared/site-file.ts` |
| Owner interface and browser publication planner | `src/components/owner/` |

Domain rules stay behind the site module; transport code authenticates, validates envelopes and translates results. SQLite uses explicit parameterized statements and module-owned migrations, without a parallel ORM schema.

## SQLite persistence

Authentication and site modules use parameterized `better-sqlite3` statements and explicit migrations. Their operations need short transactions, conditional version checks, durable operation receipts and deliberate lifecycle queries. Domain interfaces keep SQL out of REST, MCP and dashboard callers.

An ORM would be compatible with this design, but must replace enough persistence work to justify another dependency and abstraction. The existing SQL implementation already owns these operations; maintaining an additional ORM schema would duplicate the database definition. Executable migrations remain the source of truth.

The trade-off is that maintainers write and review queries, result types and migrations explicitly instead of relying on ORM-generated types or migration tooling. Parameter binding protects query values; correctness still depends on real-database tests, including migration and restored-state coverage. Reconsider an ORM when a concrete query or migration workflow benefits enough to replace the current implementation coherently.

## Identity and access

The operator provisions one stable owner through `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`. Every site and API key belongs to that owner. Authorization remains explicit even though account registration and multiple-account administration are unsupported.

The application hostname serves login, dashboard, REST and MCP. Each site has a server-generated hostname under a separate content base domain. Uploaded HTML and JavaScript run only on their own site origin. Application endpoints never serve uploaded content; content hosts never expose management endpoints.

Browser sessions use host-only, HttpOnly cookies with Secure enabled in production. Cookie-authenticated mutations validate the application Origin and CSRF proof. REST and MCP accept bearer API keys, independently of browser sessions. Keys grant the owner's management permissions and are not site-scoped. The server stores key hashes, shows the plaintext once and rejects revoked keys on subsequent requests.

Sites start private. Opening a private site uses a short-lived, one-use ticket posted from the application to the site's reserved `/_agent/session` endpoint. The site receives a host-only grant tied to its parent application session and visibility generation. Tickets and management credentials never appear in visitor URLs or uploaded files. Every private content request validates its grant and the site's current lifecycle. Invalid asset requests return a generic 404; document navigation can take the owner through the login/open flow.

Publishing files preserves visibility. Only an explicit visibility operation makes a site public. Returning to private invalidates earlier grants and blocks new anonymous reads, but cannot recall previously downloaded content. All content responses use no-store and noindex policies. Service workers and embedding are restricted to protect the private-session handoff.

### Why each site has its own origin

Path separation on one origin cannot isolate uploaded scripts from application sessions or other sites. A shared second origin protects the application but still lets hosted sites interact as same-origin documents. An opaque-origin sandbox changes storage, module and other browser behavior; shared site passwords would broaden access beyond the owner.

Separate site origins preserve ordinary static JavaScript at the cost of wildcard DNS, TLS and proxy configuration. Each site starts at `/` and keeps a server-generated hostname that is never reassigned to another site. Sibling subdomains are still same-site for cookies, so host-only cookies, exact-origin checks and authorization remain necessary. Origin isolation cannot prevent the operator from reading storage or an authorized owner from exporting content.

Browser references: [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy) and [cookie scope and HttpOnly](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

## Publication and recovery

One site retains its identity and URL across changes. A complete immutable revision contains the site's files and a manifest. A short SQLite transaction publishes that revision by changing the active reference together with its version, counters and operation receipt.

1. Authenticate, authorize, validate the operation and reserve bounded capacity. A replay must match the original operation fingerprint, including file bytes.
2. Prepare a complete revision outside the served tree, copying unchanged files and applying the batch. Validate the prospective tree, file rules and quotas.
3. Flush and finalize the files and manifest on the same filesystem.
4. Recheck lifecycle and expected version, then commit the active reference and receipt in one database transaction.
5. Release reservations and reclaim retired revisions when no reader holds them.

Preparation failures leave the old active reference untouched. A finalized revision without a committed reference is an orphan recovered during cleanup. A response lost after commit is resolved using the stored operation receipt.

Each content request leases one revision until its stream ends. Several requests in one browser navigation can straddle a publication; navigation-wide snapshots and public revision history are unsupported.

All mutations use caller-generated UUID operation IDs. Updates also require the current `expectedVersion`. Matching retries return the original successful result before checking the now-stale version; changed input under the same ID fails. Receipts persist for at least 24 hours, with `operationExpiresAt` in the result. A historical receipt is not evidence of current site state.

Deletion first commits an inaccessible tombstone and receipt, then reclaims files with retry. Expiration denies content immediately by time comparison, even before cleanup. An expired site cannot be revived. Startup discards abandoned staging, reconciles revisions, resumes deletion and validates active metadata before readiness succeeds. Missing or corrupt active content fails readiness rather than publishing an empty site.

An installation lock prevents another process from opening the same data directory. Multiple replicas and network filesystems are unsupported. Backups are cold copies of the entire data directory; see [operations](operations.md#cold-backup).

### Why complete revisions are published

Writing files in place exposes partial batches. Renaming individual files protects each file but cannot publish a related batch atomically. The filesystem and SQLite do not share a transaction, so preparation and recovery must account for files finalized before the database commit.

A complete revision and one active-reference transition provide a narrow publication boundary without adding a general history or deployment platform. Preparing a revision may copy the bounded site tree; measure representative workloads before introducing deduplication or copy-on-write. Retain revisions only while active, leased by readers or awaiting cleanup.

## Files and browser publication

Root `index.html` is required after every file mutation. Paths are case-sensitive relative POSIX names: no hidden segments, traversal, backslashes, literal percent signs or reserved top-level `_agent`. The shared file allowlist controls all transports. Markdown and PDF are supported; PDF requires binary multipart or browser upload. Neither is editable in the dashboard editor.

REST JSON and MCP accept UTF-8 text. REST multipart accepts an ordered manifest followed by raw file parts and commits one atomic batch. The dashboard can create a site from files or a folder, merge an upload into an existing site and delete individual files. Its planner summarizes ignored files and blocks collisions or exceeded limits; the server independently validates all inputs.

One confirmed browser selection is one request. Cancellation before the complete body arrives preserves the previous revision; after upload, the request may already have committed. The client retains the operation ID after an ambiguous response.

Static routing supports exact files, `.html` resolution, directory `index.html` and a site `404.html`. There is no SPA fallback. ZIP export streams the active revision as content only; it does not include credentials or replace an installation backup.

### Why the dashboard shares publication operations

A browser-specific implementation would duplicate domain rules and risk different behavior from REST and MCP. The dashboard therefore adapts the same publication operations, including version checks, receipts and quotas. Multipart mutations carry CSRF proof in `X-CSRF-Token`, allowing session, exact Origin, fetch metadata and CSRF checks before reading the body. Small bounded JSON mutations carry the token in their validated body.

Staging across requests or chunking would add partial server state and recovery semantics. Splitting a confirmed selection into multiple publications would expose intermediate revisions. The dashboard instead uses one bounded multipart request with a longer deadline for interactive uploads, while the site module remains authoritative for file and quota validation. Resumable uploads and browser-specific resource limits are outside the current model.

## Supported scope

The dashboard includes site and API-key management, expiration defaults, file previews/downloads, bounded text editing, browser publication and ZIP export. Public registration, teams, private sharing, ZIP import, rollback, hosted server execution, S3 storage and per-site containers are outside the current scope.
