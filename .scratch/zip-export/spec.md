# Site ZIP export

Updated: 2026-09-08. Implemented and locally verified from the completed local MVP in [the MVP plan](../mvp/plan.md).

## Contract

- An owner can download the active revision of a live owned site from an **Export ZIP** link in site detail or `GET /api/sites/:siteId/export` with a bearer key. The dashboard uses `GET /web/sites/:siteId/export` with its session. Public visibility does not authorize export. These are application-host routes only; credentials never enter URLs.
- Export is read-only: no operation ID, version precondition, visibility change, receipt, or new revision. No query parameters are accepted. Unsupported methods return 405 with `Allow: GET`.
- The archive contains every manifest file, including nested, Unicode, empty and binary files, at its original relative path, with `index.html` at the root. It excludes internal manifests, database files, credentials and history. There is no enclosing directory. Accepted POSIX paths beginning with a drive-like prefix such as `a:notes.txt` receive `./` in the ZIP entry name to mark them explicitly relative; their extracted POSIX path is unchanged.
- Select and authorize one active revision atomically and retain it for the entire stream, including concurrent publication/cleanup. Existing lifecycle checks apply before opening each file: deletion, expiration or a public-to-private transition may interrupt a download; they must never produce a successful partial ZIP. New exports of expired/deleted/other-owner sites fail through existing domain errors.
- Return `application/zip`, attachment filename `site-<siteId>.zip`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, and `X-Agent-Pages-Revision`. Never derive the attachment header from the user-provided name. Reject foreign Origin and fetch metadata on the web export route.
- Stream one file at a time with backpressure and bounded buffers; do not stage an archive or buffer the whole site. Use a maintained ZIP encoder with ZIP64 support rather than a custom format implementation. Entries are stored without compression to bound CPU and simplify cancellation.
- Bound simultaneous exports across REST and web to `MAX_CONCURRENT_MUTATIONS` (default 2), independently of mutation slots. Excess requests return `BUSY`. Keep the export slot until completion or cleanup, not merely until response headers are returned. Bound each export to five minutes. Cancellation, request abort, timeout, read failure and shutdown close streams and release the revision and slot. Errors after headers abort the body instead of appending JSON to the ZIP.
- No new MCP tool, import, rollback, revision selection, backup automation, or deployment changes.

## Verification

Owner-confirmed public test seams: SiteModule, authenticated HTTP handlers, and dashboard download through production HTTPS in Chromium/Firefox. Use an independent ZIP reader to verify entry names and exact bytes. Include concurrent publication/cleanup, denial, capacity, cancellation, failure and shutdown cases.

Owner-confirmed review baseline: `22a515a742874ca746efee325847b6dca2d334a6`.
