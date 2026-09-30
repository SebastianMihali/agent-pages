# Owner dashboard

The dashboard is where the owner reviews what agents publish, edits files, restores earlier revisions, and controls visibility, expiration, export and deletion. The [README visual tour](../README.md#visual-tour) shows its main screens.

## Workspace, editor and revision history

The owner area includes an Overview of live sites, content totals and upcoming expirations. In Sites, select a file to open its dedicated editor screen and inspect its source or preview a raster image, download it, and edit supported UTF-8 text with CodeMirror 6. HTML and SVG are shown as source; pages open on their isolated site origin.

Saving publishes immediately at the existing URL and preserves visibility. Drafts and undo history stay in memory while switching files; leaving warns before discarding unsaved edits. Conflicting agent updates require review. After session expiry, sign in in another tab and retry. Editing is limited to 256 KiB per file or a lower configured transport/file bound; binary, oversized and non-UTF-8 files remain downloadable. Up to 20 documents are retained in memory; drafts do not survive closing the tab. Overview content size counts live revisions, not physical disk usage.

Revision history in the site detail lets the owner inspect retained files and confirm a restore. The default retains five previous revisions in addition to the active one, subject to storage capacity. Restoration preserves the site's URL, visibility and expiration while advancing its version. The overview shows retained history separately from active content. See [revision history and restoration](api.md#revision-history-and-restoration) for the API and [recovery and capacity](operations.md#recovery-and-capacity) for storage policy.

## Export and delete a site

In site detail, choose **Export ZIP** to download the active revision, including nested pages and binary assets. The same download is available through `GET /api/sites/:siteId/export` with your bearer API key; browser sessions use the dedicated dashboard route. Export requires owner authentication even for public sites.

The archive is named `site-<siteId>.zip`, with `index.html` at its root and all original relative file paths. It contains site content only, not account settings, credentials or revision history, and does not change visibility or expiration. ZIP entries are stored without compression to keep server CPU predictable. This is a portable content copy; use the [cold backup procedure](operations.md) to restore an entire installation.

Downloads retain one revision across concurrent updates. Deleted or expired sites cannot start an export; lifecycle changes can interrupt an in-progress archive. Retry a failed download from the beginning. Exports stream without a temporary archive, have a five-minute deadline, and share an installation-wide export limit equal to `MAX_CONCURRENT_MUTATIONS` (default 2), separate from mutation jobs.

To remove a site, choose **Delete site** in its dashboard detail and confirm **Delete permanently**. The site immediately disappears from the list and its URL stops serving content; deletion cannot be undone. Export a ZIP first if you need a copy. If an agent has changed the site, the dashboard reloads its current version and asks you to confirm again.

Agents can use `DELETE /api/sites/:siteId` with a bearer API key and a JSON body containing `operationId` (UUID) and `expectedVersion`, or call MCP `delete_site` with those fields plus `siteId`. Read the current version through `GET /api/sites/:siteId` or `get_site` first. Retry an uncertain result with the **same** operation ID and version. A successful result has `deleted: true`; `cleanupPending: true` means access is already disabled while disk cleanup runs in the background.
