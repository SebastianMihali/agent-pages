# Independent implementation review

Fixed point: `f357c5a0ceb14dc8acfb0a8c77815f2d66a72ea7` (documentation baseline).
Reviewed implementation: `c06b911` (`feat: implement private-by-default single-owner MVP`).
Diff: `git diff f357c5a0ceb14dc8acfb0a8c77815f2d66a72ea7...c06b911`.

The two axes were reviewed independently by separate agents. Remote deployment was excluded because the owner explicitly deferred domains/Coolify while requesting all local checks.

## Standards

1. **Medium — staging reservation leak:** staging directory creation occurred after reserving quota but before the cleanup `try`; an ENOSPC/EACCES failure retained the reservation until restart. Violated failure-state/retry rules in AGENTS.md.
2. **Medium — no-op storage admission:** file mutations reserved a full revision before recognizing that no file changed, incorrectly rejecting a no-op near storage capacity. Violated proportional-work and redundant-I/O rules.
3. **Medium — manifest pagination lifetime:** retention lookup and manifest reading were outside the revision lease/cleanup boundary, allowing cleanup to remove a selected revision mid-read. Violated ADR 0002's reader-lifetime requirement.
4. **Medium — missing security audit events:** login rejection, key changes, visibility exposure and deletion did not emit safe structured events. Violated AGENTS.md's security-event logging rule.
5. **Low, possible duplicated code — duplicate authentication:** dispatch and REST/MCP adapters each performed the same bearer hash/SQLite lookup. The heuristic identified redundant request work.

## Spec

1. **P2 — unused mutation rate setting:** `MAX_MUTATIONS_PER_MINUTE` was configured but only concurrency/queue controls were enforced. The reviewer reproduced two immediate mutations with a configured limit of one.
2. **P2 — invalid-read lease leak:** path validation threw after acquiring a revision lease, outside release handling. The reviewer reproduced an invalid read followed by deletion that could not reclaim the tombstone until restart.
3. **P2 — text replay required free staging space:** text creation/writes staged bytes before resolving a successful receipt. The reviewer reproduced a valid create retry failing at a coherent 1 MiB stored quota after other sites consumed space.

No unrequested scope creep was found by the Spec axis. All eight original findings have corresponding fixes and focused regression evidence. The Spec reviewer independently reran four focused regressions and closed all three findings at `f82ff38`. The Standards reviewer closed the original five findings, then identified one additional cleanup case during follow-up. It is resolved and independently re-reviewed through `cfbbc78`; neither axis has an open finding.


## Fixes and verification

- Standards 1: all staging work is inside cleanup handling. Failed physical reclamation retains conservative byte accounting and blocks further staging until bounded periodic cleanup succeeds; successful operations and original failures are not masked by cleanup errors. Real permission-failure tests verify recovery.
- Standards 2: text no-ops and absent-path deletion save a receipt before reserving a replacement revision.
- Standards 3: manifest listing acquires and releases the same revision lease used by file reads; a controlled cleanup race now preserves the selected manifest.
- Standards 4: a typed, field-projecting audit writer records login decisions, committed key changes, visibility and deletion. Tests exclude submitted text, passwords and every token/key; replays emit no duplicate mutation event.
- Standards 5: production admission passes its authenticated principal into REST/MCP, avoiding a second bearer lookup. Direct adapter use still authenticates, and origin checks remain enforced.
- Spec 1: the single-owner installation shares a minute budget across domain mutation operations and all entry points, before file-stream consumption. Injected-clock tests prove the 429/reset behavior while reads remain available.
- Spec 2: invalid file paths release acquired leases; deletion can reclaim content immediately afterward.
- Spec 3: canonical text digests resolve existing receipts before quota/staging/version work. Full-quota and unwritable-staging regressions prove matching replay and changed-input conflict behavior.

The updated application checks pass: lint, typecheck, 90 tests in 17 files. Final browser/container results are recorded in the [verification record](verification.md).

## Standards follow-up: revision cleanup

**Medium — failed revision reclamation:** cleanup of a delete-only work tree or an uncommitted final revision could replace the primary error and release storage accounting before physical removal. The fix groups every possible owned revision path under one reservation, retains it until all paths are removed, and tracks uploaded input bytes separately. Confirmed commits retain their files and transfer accounting to SQLite; pending cleanup blocks new revision creation while reads, matching text receipts and no-ops remain available.

Three added regressions exercise real denied cleanup after database-trigger failures for create/write and a delete-only post-finalize failure. They verify primary errors, admission rejection, unchanged active state and successful reclamation/retry after permissions are restored. The focused site/lock suite passes 33 tests. The independent Standards follow-up reports this finding resolved with no remaining issue in scope.
