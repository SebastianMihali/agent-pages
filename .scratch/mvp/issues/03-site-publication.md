# Site lifecycle and complete revision publication

Status: ready-for-agent
Progress: done
Blocked by: 02

## Objective

Implement shared owner-scoped site operations whose successful results survive retry and restart, while failed preparation preserves the active content.

## Scope

Implement the [site model](../spec.md#site-model), [publication/recovery](../spec.md#publication-and-recovery), [retry/concurrency](../spec.md#retry-and-concurrency-contract), [paths](../spec.md#paths-files-and-routing) and [resource limits](../spec.md#resource-limits). One domain module owns creation, file changes, visibility, tombstones, quotas and operation receipts. Keep filesystem complexity private to the local persistence implementation.

Add site/revision/receipt migrations, manifests, per-site coordination, installation lock, staging reservations, reader leases and bounded cleanup. Use the same lifecycle for TTL and explicit deletion. Expose a small interface to the next tickets; do not invent an S3 provider contract.

## Acceptance

- [x] Initial content must include index.html; new sites are private and associated with the authenticated owner.
- [x] Writes/deletes publish one complete revision and preserve visibility; a visibility change advances metadata without copying content.
- [x] Interrupted preparation/finalization/commit and ENOSPC scenarios produce the specified recovery behavior and consistent counters.
- [x] Duplicate operations across restart return their receipt; mismatched IDs and competing expected versions produce the specified conflicts.
- [x] Creation, deletion retries after reclamation, expiration during writes and cleanup/read races are covered.
- [x] Traversal, symlinks, duplicate/colliding paths and quota oversubscription are rejected.
- [x] Restart reconciliation and a second-instance lock failure are tested against temporary data directories.
- [x] Record a small-site and near-limit full-revision preparation measurement with elapsed time, peak memory and staging disk use; optimize only if evidence requires it.

## Verification

The storage/lock suite passes with no skipped fixture. It covers atomic publication, receipts, quota/concurrency, real process crashes/locks, symlinks, cleanup retry, expiry during writes, and corruption. ENOSPC is injected at the file-copy seam. Small/near-limit measurements are recorded centrally.

Commands, exact versions and limitations: [local verification record](../verification.md). The independent Standards and Spec reviews have no open findings; see the [review record](../review.md).
