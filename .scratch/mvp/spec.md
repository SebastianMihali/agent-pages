# Agent Pages — MVP contract

Updated: 2026-09-05. Status: implementation in progress; verification evidence is recorded in the tickets.

This file is the authoritative implementation contract. See the [product direction](../../agent-pages-spec.md), [glossary](../../CONTEXT.md) and [execution plan](plan.md) for scope, vocabulary and ordering.

## Confirmed scope

- One owner account for the first MVP, provisioned by the installation operator.
- Every site is private to its owner at creation. Only an explicit owner action changes visibility to public; it can be changed back to private.
- Public visibility grants read access to site content, never management access.
- No shared passwords, guest invitations, private sharing, registration or multiple-account administration.
- Both Codex and Claude Code must complete the MCP acceptance workflow.
- One Node.js application instance, one local persistent volume, SQLite metadata and local static files.
- An application hostname and isolated per-site hostnames, as recorded in [ADR 0001](../../docs/adr/0001-isolate-site-origins.md).
- Multipage HTML/CSS/JS, common binary assets, file-level batch changes, optional expiration and a minimal owner web interface.
- ZIP upload, SPA fallback, editing in the browser, public version history, rollback and S3 are deferred.

## Identity and access

### Owner and management credentials

Persist one stable owner ID. Associate every site and API key with that ID; derive ownership from authenticated credentials, never a request's `ownerId`. There is no owner-transfer operation. Application code checks ownership even with one configured account. A synthetic other principal in tests exercises these checks without adding account provisioning to the product.

Provision the account using `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`. Provide an interactive local helper to generate a salted scrypt hash with explicit parameters; validate the supported hash format at startup. The helper is an operator utility, not an endpoint or uploaded-code execution feature. Never accept a default password. Changing the configured password requires a restart; clear browser sessions, access tickets and site grants at startup. Preserve the stable owner ID and existing API keys. Document username changes without creating a second owner or orphaning sites.

The application login uses a server-side session with a random token, hash-only persistence, absolute 12-hour expiry and a production cookie named `__Host-agp-session` (`Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`, no `Domain`). Rotate the token on login and revoke its grants on logout. All cookie-authenticated mutations, including login and key creation, require exact application-origin validation and CSRF protection. Cross-origin form submissions are rejected even from sibling site hostnames.

The owner can create labeled API keys and revoke them in the web interface. Generate at least 256 random bits, show a key once in the authenticated response, store only its hash and display prefix, and keep it out of logs, HTML hydration payloads and browser persistent storage. Limit active keys to 10. A revoked key fails on the next management request. Keys carry their owner's full site-management permissions; site-scoped keys and OAuth are deferred.

REST and MCP use `Authorization: Bearer <key>` exclusively, including read/list operations. Browser sessions are accepted only by the application's dedicated web handlers/server functions. No API key is embedded in frontend code or sent to a site hostname. Authentication failures return generic errors without secret values. Validate authentication and permitted origins before expensive body parsing.

### Private content and browser handoff

Owners sign in only on the application hostname. Uploaded content never receives the management session or the account password. Use the following small, server-managed handoff to view a private site on its own origin:

1. A private top-level document navigation without a site grant redirects to the application's owner-only open-site screen. Unauthenticated asset/fetch requests receive a generic 404, not login HTML. Redirect targets are assembled from configured origins and server IDs.
2. After login and an ownership check, an application-origin, CSRF-protected POST to open the site creates a random one-use ticket, valid for at most 60 seconds, bound to owner ID, site ID, current visibility generation and the live application session.
3. Return an application-controlled form that POSTs the ticket to that site's reserved `/_agent/session` endpoint. Use no-store responses, a restrictive application CSP and an exact form destination. The ticket is carried in the POST body, never in a URL, log or uploaded page. Controlled handoff forms use `Referrer-Policy: origin`: browsers otherwise serialize form navigation Origin as null under no-referrer, breaking the exact-origin check. Only the configured origin is disclosed, never the path or ticket. A user-activated submit works without JavaScript; nonce-based auto-submit may improve the flow.
4. The endpoint requires the exact application `Origin`, validates and atomically consumes the ticket, then sets a random host-only `__Host-agp-site` cookie with `Secure`, `HttpOnly`, `Path=/` and `SameSite=Lax`. It redirects with 303 to a validated local content path. Grant records store token hashes and are bound to the site, owner, application session and visibility generation.
5. On every private page/asset request, check the grant, its unexpired/revoked parent session, current ownership, current visibility generation and site lifetime. No browser cookie or ticket authorizes REST/MCP or visibility changes.

Tickets are never returned in MCP outputs. Return the normal visitor URL and an application `openUrl` instead. Limit outstanding tickets/grants per session (20 tickets, 100 grants), bound their lifetime to the parent session and sweep expired records. Invalid, expired, wrong-host or reused tickets reveal no private metadata.

Reserved `/_agent/` routes must be dispatched before uploaded files and are unavailable as uploaded paths. Responses for the handoff never load uploaded resources. Block service-worker script requests for uploaded files and use `worker-src 'none'` on uploaded documents for the MVP, so uploaded code cannot install an interceptor over the handoff path. Revisit worker support only with a separately verified design.

### Visibility and privacy limits

Visibility is exactly `private | public`, default `private`. Creation and file-write schemas reject a visibility field. A separate `set_site_visibility` operation changes it with ownership and concurrency checks; the UI labels the public action explicitly. Writes preserve visibility.

Making a site private increments its visibility generation and invalidates old site grants/tickets; authorize every subsequent content request again. Enforce visibility before redirects revealing file structure, HEAD responses, custom 404 pages and conditional requests. Use `Cache-Control: no-store` for all site responses in this MVP and require the proxy to bypass content caching.

Public-to-private prevents new unauthenticated retrievals once the change commits. It cannot recall already downloaded/copied content or bytes already being streamed. Private sites are access-controlled, not end-to-end encrypted: the operator controls the disk, and an owner can publish scripts that send their own content to external services. The application does not promise DRM or script confidentiality from its author.

## Hosts and HTTP security

- `APP_ORIGIN`, e.g. `https://app.example.com`, serves web login, owner UI, `/api/*` and `/mcp`.
- `CONTENT_BASE_DOMAIN`, e.g. `sites.example.com`, serves only `<siteId>.sites.example.com`, with exactly one server-generated label. Use opaque lowercase IDs; never reuse an ID or host for a different site. Display `name` separately; no mutable slug is needed in this MVP.
- Each site's content starts at `/`; root-relative and relative URLs are accepted without HTML/JS rewriting.
- Application routes return 404 on content hosts; uploaded content is never served on the application host. Unknown hosts fail closed. A liveness probe may use a specifically configured internal host and route without exposing management endpoints.
- Validate the effective host against configured names. The proxy must replace forwarded host/protocol headers, and direct access to the app port must be restricted in production. Do not construct redirect destinations from arbitrary request headers.
- Production uses HTTPS, host-only cookies and a wildcard certificate/proxy route for the content zone. Reject insecure production configuration and overlapping application/content host assignments.
- REST/MCP accept requests without `Origin` from native clients; if `Origin` exists, require the exact application origin. No wildcard or reflected credentialed CORS. Content does not grant cross-origin CORS access.
- Site responses use `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin` and document `frame-ancestors 'none'`. Disable camera, microphone, geolocation and legacy `document.domain` relaxation via the appropriate browser policies; send `Origin-Agent-Cluster: ?1` on documents. Verify cross-site behavior in the supported browser tests.
- The uploaded-document CSP must permit ordinary inline/external page scripts and styles while blocking workers and framing. Authentication and owner authorization remain server-enforced. Uploaded files cannot override response headers. Application/login CSP is stricter and uses controlled scripts only.
- Log operation IDs, owner/site IDs and error categories, never request bodies, session tokens, authorization headers, ticket bodies or full file contents.

## Site model

Site metadata contains `id`, `ownerId`, `name`, `visibility`, `visibilityGeneration`, `version`, `activeRevisionId`, `createdAt`, `updatedAt`, `expiresAt`, `sizeBytes`, `fileCount` and a deletion state. Public responses do not serialize this metadata.

`version` is a positive integer starting at 1. Increment it after every successful state-changing mutation, including visibility changes. `activeRevisionId` identifies a complete file revision and changes only for content publication. A no-op mutation leaves version/timestamps unchanged and still records an idempotent result. Return current `version` in owner-authorized reads and successful mutations.

Create accepts `name` (1–100 trimmed characters), nonempty initial files including root `index.html`, and optional `expiresInSeconds` (`null` or an integer from 60 through 2,592,000). Compute `expiresAt` once on successful creation. Expiration is immutable in this MVP. Site type is static; reject a requested SPA type with an actionable unsupported-feature error.

Expired sites are unavailable immediately by time comparison. Owner listing/get still identifies expiration until cleanup removes metadata; writes and visibility changes reject expired sites. Owner deletion is permitted. Cleanup uses the same deletion machinery as explicit deletion.

The active revision has a manifest of canonical paths, byte lengths, MIME types and content digests. A manifest is internal metadata outside the served files tree. Validate site totals against the prospective result, not just the upload delta.

## Publication and recovery

Follow [ADR 0002](../../docs/adr/0002-publish-complete-revisions.md). Use one application instance; per-site mutation serialization is internal, and SQLite compare-and-set checks remain the final version guard. Hold an exclusive installation lock on `/data` so a second instance fails rather than bypassing in-process coordination. Hold a short global quota reservation lock when admitting writes.

Suggested disk layout:

```text
/data/database.sqlite
/data/sites/<siteId>/revisions/<revisionId>/manifest.json
/data/sites/<siteId>/revisions/<revisionId>/files/...
/data/staging/<random-staging-id>/...
```

For create/write/delete-files:

1. Authenticate and authorize, then inspect any existing idempotency receipt. Canonical text fingerprints can be computed immediately; streamed file digests require bounded staging before a replay can be proven identical. Reserve temporary capacity before consuming file streams, and verify the complete fingerprint before returning a stored result. A successful matching replay precedes expected-version checks. Validate the entire prospective batch and resulting quotas before publication.
2. Prepare a full new revision in staging. Copy unchanged regular files from the active revision with bounded streaming, apply writes/deletions and compute its manifest. Never mutate an active revision or follow user-controlled symlinks. Limit work to the configured site size/file count.
3. Flush prepared files/manifest and relevant directories, then finalize the revision on the same filesystem. Only a complete, finalized directory can become active.
4. In a short SQLite transaction, recheck lifecycle/version, set the active reference and counters, increment version and persist the operation receipt. Use durable SQLite settings appropriate to the supported local filesystem. Do not hold a database write transaction during file copying.
5. Return success after commit. If the commit outcome is uncertain, look up the receipt rather than applying the mutation again. Queue the old revision for cleanup and release reservations.

Disk errors, quota rejections, validation failures and interruption before commit leave the old active reference untouched. A revision finalized without a committed reference is an orphan, not a published site. Creation does not expose a successful site record/URL before its initial revision is ready.

Resolve a content request to one revision and hold a reader lease until its stream ends/cancels. Cleanup must not remove an active revision or one leased by a reader. Each request is consistent; a browser making several requests across a publication may observe different revisions. Conservative cache policy does not promise navigation-wide snapshot consistency.

Deletion first commits an inaccessible tombstone, version transition, grant invalidation and operation receipt, then removes content asynchronously. New requests fail after that commit; existing streams may finish. Return `cleanupPending: true` when reclamation is pending. Cleanup retries failures with bounded backoff; never delete metadata first and lose the identity of content requiring cleanup.

At startup before readiness, recover interrupted work: discard abandoned staging, find unreferenced finalized revisions, resume tombstones, expire sessions and rebuild quota accounting. If a live reference is missing/corrupt, fail readiness with an operator-actionable log; never silently replace the site with an empty tree. Metadata and stored content are reconciled at recovery/cleanup, not by full scans on every public request.

Process interruption and restart are required tests. Power-loss durability relies on verified fsync/SQLite behavior on the documented local filesystem; do not claim protection against faulty storage or all host filesystems. Network-mounted storage and multiple replicas are unsupported.

## Retry and concurrency contract

Every site mutation requires an `operationId`, a caller-generated UUID. Scope it to the authenticated owner across REST and MCP. Store a canonical request fingerprint (operation kind, target, normalized arguments and file-byte digests) and the successful result in the same transaction as the mutation. Resolve receipts in that owner's scope before requiring a live site record, so deletion retries still work after reclamation; receipt lookup must never bypass credential revocation or owner scoping.

- Repeating the same ID and fingerprint returns the original result without repeating side effects, before checking an expected version that the first call already advanced.
- Reusing an ID with different input returns `IDEMPOTENCY_CONFLICT`.
- Concurrent duplicates serialize/coalesce; they cannot both publish or create sites.
- Persist receipts for at least 24 hours after commit; return `operationExpiresAt` with mutations. Beyond retention, replay is not guaranteed: inspect state and create a fresh operation ID deliberately. Retain deletion receipts after physical cleanup.
- All updates/deletions/visibility changes require `expectedVersion`. A mismatch returns `VERSION_CONFLICT` with the current version only after owner authorization.
- Failed validation/quota checks do not consume an operation ID. Reusing it after correcting arguments is allowed if no successful receipt exists.
- Retrying a previously completed visibility change never re-applies it over a newer state: the receipt describes that earlier result. Read current state when uncertain.

Receipt storage, queues and rate-limit state are bounded. Never purge an unexpired receipt to admit another operation; reject admissions if the configured capacity is reached.

## Paths, files and routing

REST/MCP write paths are canonical relative POSIX paths, case-sensitive. Limit paths to 512 UTF-8 bytes and 32 segments. Reject absolute paths, backslashes, empty segments, `.`/`..`, control characters, nulls, literal `%` in stored names, hidden dot-prefixed segments and the reserved top-level `_agent` segment. Reject duplicate paths and file/directory collisions across the batch and prospective tree. Require root `index.html` after every mutation; deleting it is an error unless deleting the whole site.

For URL reads, decode segments once and reject encoded separators, malformed encodings and traversal after decoding. Test the actual framework/proxy normalization path as well as the pure validator. Resolve storage only through a validated site ID, revision ID and manifest path; uploaded symlinks and arbitrary filesystem paths never become files.

Use an explicit supported extension allowlist: `.html`, `.htm`, `.css`, `.js`, `.mjs`, `.json`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.avif`, `.gif`, `.svg`, `.ico`, `.woff`, `.woff2`, `.txt`, `.xml`, `.webmanifest`, `.map`. Use a maintained MIME library and server-assigned Content-Type. Unsupported file types are rejected; no upload is executed by the server. Never automatically fetch an asset URL provided by an agent.

Resolve static routes after access checks:

| Request | Resolution |
| --- | --- |
| `/` | `index.html` |
| `/about/` | `about/index.html` |
| `/about` | Exact file, then `about.html`, then redirect 308 to `/about/` if `about/index.html` exists |
| `/assets/site.css` | Exact asset |
| Missing | Site `404.html` with HTTP 404, otherwise generic 404 |

Exact files take precedence. Directory redirects preserve query strings. No directory listing and no SPA fallback. GET and HEAD share access checks, status, MIME and declared file length; HEAD has no body. Stream file bytes and cancel promptly on client disconnect. Range and conditional responses may be deferred; a normal complete 200/no-store response is acceptable. Expired/private denial must never become a successful cached or fallback response.

## REST and MCP contract

All site-management calls use the same domain operations. Zod validates inputs, rejects unknown fields and validates required preconditions. Expected failures map to stable domain error codes, not filesystem strings or raw exceptions.

| Domain operation | REST on application host | MCP tool |
| --- | --- | --- |
| Create private site | `POST /api/sites` | `create_site` |
| List owned sites | `GET /api/sites` | `list_sites` |
| Get owned site | `GET /api/sites/:siteId` | `get_site` |
| List active-revision files | `GET /api/sites/:siteId/files` | `list_files` |
| Read active-revision file | `GET /api/sites/:siteId/file?path=...` | `read_file` |
| Batch upsert text files | `PUT /api/sites/:siteId/files` | `write_files` |
| Batch delete files | `POST /api/sites/:siteId/files/delete` | `delete_files` |
| Change visibility | `PUT /api/sites/:siteId/visibility` | `set_site_visibility` |
| Delete site | `DELETE /api/sites/:siteId` | `delete_site` |

Mutation JSON bodies carry `operationId` and, except creation, `expectedVersion`. Delete-site also uses a JSON body. File deletes use POST to avoid depending on intermediary support for a DELETE batch body. Verify delete-site body handling through the intended proxy.

Create input: `{operationId, name, files: [{path, content}], expiresInSeconds?}`. Text contents are UTF-8 strings; sizes are measured as UTF-8 bytes, not JavaScript string lengths. Write input: `{operationId, expectedVersion, files: [{path, content}]}`. File-delete input replaces `files` with a nonempty `paths` array; missing paths are no-ops. Visibility input replaces it with `visibility: 'private' | 'public'`. Reject empty write/delete batches.

Create returns `{site, operationId, operationExpiresAt}`. Mutations return `{site, changedPaths, deletedPaths, operationId, operationExpiresAt}` where applicable; deletion returns `{siteId, version, deleted: true, cleanupPending, operationId, operationExpiresAt}`. Site responses contain `id`, `name`, `visibility`, `version`, `revisionId`, `url`, `openUrl`, timestamps, expiration and file totals. Serialize timestamps as UTC ISO-8601 strings and unset expiration as null. Return no private file content or tokens in creation summaries.

`list_sites` filters by authenticated owner and returns at most 50 entries with an opaque cursor. `list_files` returns up to 100 sorted manifest entries with path, size, MIME and digest, plus cursor and the pinned revision ID. File/read pagination accepts an optional revision ID obtained from listing; if it is no longer retained, return `REVISION_UNAVAILABLE`, never mix revisions silently. Cursors are validated and cannot change owner/site scope.

REST read-file returns raw authenticated bytes with no-store and server MIME headers. MCP read-file returns `{path, revisionId, digest, sizeBytes, contentType, content}` for text within its response cap. For binary or oversized text, return metadata and an authenticated REST download path, not base64 or a public bypass URL.

For binary uploads, support a REST-only multipart variant of `PUT /api/sites/:siteId/files`. The first part must be `manifest` JSON. It contains `operationId`, `expectedVersion` and `{path, partName}` entries; each named file part supplies raw bytes, in manifest entry order. This order permits bounded streaming and backpressure without an extra unaccounted staging layer. Reject duplicate, absent, out-of-order or unreferenced parts and malformed trailing data before committing the revision. Stream to bounded staging, use the same atomic publication and idempotency contract, and never trust client MIME or filesystem filenames. Text and binary parts may share one atomic batch. Initial binary assets can be added to a private site after creation.

MCP uses the official SDK's Streamable HTTP transport integrated through TanStack's request handler. Prefer stateless request handling with JSON responses for these short operations; do not add resumable event streams or legacy SSE transport without a proven client need. Respect SDK initialization, protocol versions, Accept handling and GET/405 behavior. Authenticate/validate Origin on every request, including tool discovery. Close per-request resources. Tool outputs provide structured results and bounded text summaries. Mark read tools read-only and mutation tools appropriately, including destructive file/site operations and the visibility operation's exposure semantics.

REST errors: `{error: {code, message, retryable, requestId, details?}}`. Use equivalent fields in MCP tool-error results with `isError: true`; transport/protocol errors and tool-schema validation errors follow the SDK (`isError` for invalid tool input); domain failures use the structured error fields above. Expected mappings:

| Code | HTTP | Retry behavior |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Fix credentials |
| `NOT_FOUND` | 404 | Includes another owner's site; do not reveal ownership |
| `SITE_EXPIRED` | 410 | Owner-management response only; visitor gets generic 404 |
| `INVALID_INPUT`, `INVALID_PATH` | 400 | Fix the input |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Use a supported upload/file type |
| `VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `REVISION_UNAVAILABLE` | 409 | Read current state or fix the operation ID |
| `PAYLOAD_TOO_LARGE` | 413 | Reduce the request |
| `QUOTA_EXCEEDED` | 409 | Free space or change configured limits |
| `RATE_LIMITED` | 429 | Honor Retry-After |
| `BUSY`, `STORAGE_UNAVAILABLE` | 503 | Bounded retry using the same operation ID |

## Resource limits

All byte limits use binary MiB. Defaults are configurable and validated as positive, coherent values at startup:

| Setting | Default | Meaning |
| --- | --- | --- |
| `MAX_SITE_SIZE_MB` | 50 | Active revision bytes per site |
| `MAX_FILE_SIZE_MB` | 20 | Bytes per file |
| `MAX_FILES_PER_SITE` | 500 | Active revision file count |
| `MAX_SITES` | 100 | Active sites plus unreclaimed tombstones |
| `MAX_TOTAL_SITE_SIZE_MB` | 1024 | Total active revision bytes |
| `MAX_STORED_SIZE_MB` | 3072 | Accounted content/staging/retired-revision bytes |
| `MIN_FREE_DISK_MB` | 256 | Free-space reserve after estimated staging admission |
| `MAX_BATCH_FILES` | 100 | File changes per request |
| `MAX_JSON_BODY_MB` | 2 | Raw REST/MCP body limit, including JSON overhead |
| `MAX_MULTIPART_BODY_MB` | 25 | Total streamed multipart body including overhead |
| `MAX_MCP_TEXT_BYTES` | 65536 | Raw text file bytes returned per read |
| `MAX_CONCURRENT_MUTATIONS` | 2 | Instance-wide active mutation jobs |
| `MAX_QUEUED_MUTATIONS` | 16 | Bounded waiters, with a 30-second admission deadline |
| `MAX_MUTATIONS_PER_MINUTE` | 30 | Per owner across keys and web entry points |
| `MAX_IDEMPOTENCY_RECEIPTS` | 100000 | Admission cap; never evict within retention |

Reject or cancel oversize bodies while reading, including chunked requests with no Content-Length. Estimate full-revision staging cost, reserve capacity across concurrent operations and include obsolete revisions in physical content accounting until reclaimed. Also check actual disk free space for SQLite, logs and other volume use; accounting is not a substitute for ENOSPC handling.

Bound password verification with `MAX_CONCURRENT_PASSWORD_VERIFICATIONS` (2; maximum 8), and throttle with `MAX_LOGIN_FAILURES_PER_MINUTE` (5) and `MAX_LOGIN_ATTEMPTS_PER_MINUTE` (60). The initial deployment uses a conservative installation-wide address bucket for each normalized account, ignoring forwarded client-IP headers; it does not trust a user-supplied address. Authenticated request processing shares an installation-wide admission cap equal to active-plus-queued mutation limits. Body readers cancel stalled requests after 30 seconds. Apply management request limits before body parsing; receipts and limits cannot be bypassed by rotating API keys. Pagination, session/grant counts and streamed-response cancellation must prevent unbounded process memory growth.

## Web interface and operations

The minimum web interface provides login/logout, owned-site list/detail, open-site navigation, private/public controls and API-key creation/revocation. Show visibility prominently; state that making a site public allows anyone to view it. Never render uploaded HTML in the application origin. Render filenames/names as text, and open site content in a separate tab with opener isolation.

Configuration includes `APP_ORIGIN`, `CONTENT_BASE_DOMAIN`, `DATA_DIR=/data`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` and the limits above. Use a separate test/development directory. A development-only HTTP mode may use distinct loopback hostnames and non-production cookie names; it must not be reachable through production configuration. Browser acceptance runs with local HTTPS and production cookie rules.

Run the production container as non-root; persist only `/data`, mount no Docker socket or host secrets, and expose one application port through the proxy. Provide liveness and readiness separately. Readiness becomes healthy only after schema migrations, storage checks and startup recovery finish. A health response reveals no file paths, credentials or site metadata.

Expiry cleanup runs at startup and periodically in one bounded, non-overlapping job using an injected clock in tests. Use the shared per-site serialization and tombstone process; reclaim disk with retries and sanitized logs. Process shutdown stops new writes and drains or cancels owned work within a bounded deadline.

Backup for the MVP is a documented cold backup: stop this installation cleanly, copy the entire `/data` directory including SQLite sidecars and file trees, and restore to a fresh volume with the same configured origins and owner credentials. Invalidate browser sessions/tickets/grants at startup. Keep backups access-restricted because they contain private site content and API-key hashes. Verify restore by logging in and reading/updating a private site. Online backup is deferred.

## Acceptance

Every box requires recorded evidence in its implementation ticket. A synthetic second owner tests authorization only; multi-account functionality remains out of scope. Browser security acceptance targets the current Chromium and Firefox versions pinned by the test runner; record versions in verification output.

- [ ] A fresh install boots with the documented configuration and rejects missing/insecure production credentials or host settings.
- [ ] A second process cannot open the same live data directory.
- [ ] Login, logout, personal key creation and immediate key revocation work without secret leakage.
- [ ] Both selected MCP clients create a private multipage site and update the same URL.
- [ ] Anonymous requests and a synthetic other principal cannot read private HTML, CSS, JS, images, fonts, HEAD, custom 404 or management data.
- [ ] A logged-in owner can open private content with a site-specific grant; wrong-site/reused/expired tickets and grants are rejected.
- [ ] An adversarial public site cannot read application responses or another private site's assets in the same authenticated browser, including fetch, embedding, workers and legacy origin-relaxation attempts.
- [ ] New sites are private, writes preserve visibility, explicit public exposure permits anonymous reads, and reverting to private denies subsequent anonymous requests.
- [ ] A failed/interrupted batch leaves the old revision active; a restart after commit recovers the successful idempotent response.
- [ ] Concurrent updates produce a success and a version conflict, with no lost update or quota oversubscription.
- [ ] Traversal, encoding tricks, symlinks, duplicate paths and file/directory collisions are rejected through actual HTTP as well as validators.
- [ ] Text/binary writes, nested routing, canonical redirects, site 404, HEAD and MIME work with streaming and no-store headers.
- [ ] Limits reject oversized or excessive work during streaming and account for staging and retired revisions.
- [ ] Expiration denies reads before physical cleanup; deletion and cleanup survive failures and restarts.
- [ ] Production build, targeted lint/type checks and relevant integration/browser tests pass.
- [ ] Docker build, non-root runtime, persistence, wildcard routing/TLS through the intended proxy and cold backup/restore are verified.

## Source checks

Consulted on 2026-09-05; dependency APIs are rechecked when versions are selected:

- [TanStack server entry](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point): fetch-based integration point.
- [Official MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server) and [HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): transport lifecycle and security requirements.
- [Client configuration evidence](../../docs/mcp-clients.md): both target clients and the remaining live checks.
