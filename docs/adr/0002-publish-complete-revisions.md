---
status: accepted
date: 2026-09-05
---

# Publish complete revisions through one active reference

Agent updates can replace several related files and can be interrupted or retried. Prepare a complete revision outside the served tree, then publish it by updating the active reference and site metadata in one database transaction; this keeps a failed preparation from partially changing the live site.

The filesystem and SQLite do not share a transaction. Preparation, commit, read lifetime and recovery must follow the [MVP publication contract](../../.scratch/mvp/spec.md#publication-and-recovery), including recovery of unreferenced files after interruption.

## Considered options

- Writing files in place is smaller initially, but exposes partial batches and makes retry recovery ambiguous.
- Renaming individual files protects individual writes, not a multi-file publication.
- A general deployment/history platform exceeds the current product scope.

## Consequences

The MVP uses internal immutable revisions without exposing history or rollback. Preparing an update may copy the bounded site tree; measure this with representative sites before adding deduplication or copy-on-write machinery. Keep only revisions needed by active readers and pending cleanup.

Publication is atomic at the active-reference transition. Separate browser requests can straddle that transition; the MVP does not promise that an entire browser navigation uses one revision. User-visible rollback and versioned asset URLs remain later work.
