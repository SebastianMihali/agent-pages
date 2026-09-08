# ZIP export implementation plan

Status: implementation, local verification and independent review complete (2026-09-08).

1. Extend the existing revision lease internally to support sequential reads without releasing the revision after the first file; expose one owner-authorized export operation.
2. Integrate a streaming ZIP encoder with bounded export lifetime/concurrency and explicit cleanup on every terminal path.
3. Add REST and session download adapters and the dashboard action. Test authorization, headers, inputs and real browser downloads.
4. Update the current contract and user documentation; run focused checks throughout, the full unit/integration suite once at the end, and production browser checks.
5. Run the implement skill's independent Standards/Spec review, resolve findings, record verification and commit on the current branch.

Implementation ticket: [01](issues/01-site-zip-export.md).
