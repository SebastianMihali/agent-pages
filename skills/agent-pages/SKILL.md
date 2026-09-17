---
name: agent-pages
description: Create and update static sites on an existing Agent Pages installation through its MCP tools, and manage expiration and private or public visibility.
---

Use the configured Agent Pages MCP server. If it is absent, obtain the installation's application URL and have the owner provision a personal API key through its web interface. Configure the client's bearer token through an environment variable; keep the value out of prompts, output and project files. Browser cookies and private-site grants are not API credentials.

## Create and update

Create with `create_site`: provide a new UUID `operationId`, a descriptive name and UTF-8 text files including root `index.html`. New sites are private. When the user requests a lifetime, pass `expiresInSeconds` explicitly; `null` means Never. Otherwise omit it so the owner's default applies. Read the returned `expiresAt`, and keep it with the site ID, `version`, visitor `url` and owner `openUrl` associated with the project. Open private content through `openUrl`, where the owner signs in. Site content begins at `/`; relative and root-relative links work across multiple pages.

For an existing site, use `get_site`, then `list_files`/`read_file` as needed. Batch related changes with `write_files` using the current `expectedVersion` and a new `operationId`. Updates preserve the site ID, URL and visibility. `delete_files` removes selected paths; root `index.html` remains required. Creation is for a new site, not a retry of an update.

After a lost response, retry the identical command with the same operation ID. Successful receipts are retained for at least 24 hours, with the deadline returned as `operationExpiresAt`. Reusing an ID with different input causes `IDEMPOTENCY_CONFLICT`. For `VERSION_CONFLICT`, read the current site and reconcile the intended change before issuing a new operation; do not blindly overwrite a newer version. After receipt expiry, inspect state before deciding whether another mutation is needed.

For large or binary assets, use authenticated REST multipart `PUT /api/sites/:siteId/files`: send a first `manifest` JSON part containing `operationId`, `expectedVersion` and `files: [{path, partName}]`, followed by those file parts in the same order. All parts form one atomic revision. Use the actual server's documented limits and schemas. MCP `read_file` returns a REST download path instead of embedding binary or oversized text; that path still requires the owner's bearer key.

Markdown (`.md`) is a supported UTF-8 text file for MCP and REST writes. PDF (`.pdf`) is supported through REST multipart and is served with its server-assigned MIME type; do not encode a PDF as MCP text. The dashboard can publish both formats, but its file editor deliberately leaves `.md` and `.pdf` non-editable.

## Visibility, expiration and deletion

Uploading or updating content leaves visibility unchanged. Use `set_site_visibility` only when the user's request explicitly authorizes making the site public or private. Public means anyone with the URL can read its content; it never grants management access. Sites are never indexed by search engines, so do not promise discoverability. A returned receipt describes the original operation, so use `get_site` when current visibility is uncertain. Making a site private blocks subsequent anonymous retrievals but cannot recall copies already downloaded.

Use `set_site_expiration` with the current version and a fresh operation ID to extend, shorten or remove a live site's expiration. Pass seconds relative to the call, or `null` for Never. Read the returned `expiresAt`; preserve the site identity instead of recreating it. Expiration is terminal, so treat `SITE_EXPIRED` as final and never expect an expiration change to revive the site.

Use `delete_site` for a requested whole-site deletion, with its current version and a fresh operation ID. A successful tombstone makes the site inaccessible immediately; `cleanupPending` describes disk reclamation at the time of that result. Retrying that operation returns its original receipt even after cleanup.

## Constraints and completion

Paths are relative POSIX names: no hidden segments, traversal, backslashes, literal percent signs or top-level `_agent`. Supported static files are HTML, CSS, JS, JSON, common images/fonts, text and Markdown, XML, web manifests, source maps and PDF. The MVP has no ZIP upload, server execution, SPA fallback, shared private access or history/rollback.

After a change, read the affected file or manifest and check the returned version and visibility. Report the stable URL and, for private sites, the owner `openUrl`. Distinguish verified content from a browser preview you have not opened. For retryable `BUSY`, `RATE_LIMITED` or storage errors, honor retry guidance and use bounded retries with the original operation ID; surface a persistent failure instead of creating duplicate sites.
