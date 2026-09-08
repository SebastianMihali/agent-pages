# ZIP export review

Date: 2026-09-08. Owner-confirmed baseline: `22a515a742874ca746efee325847b6dca2d334a6`. Two independent agents reviewed the staged implementation before commit using `git diff --cached 22a515a742874ca746efee325847b6dca2d334a6`; the commit list was empty because the work was not yet committed. This is the staged-work equivalent of the skill's committed-range review.

## Standards

**0 findings.** No documented-standard violations or actionable baseline smells were found. The adapter separates HTTP headers from owner authorization, reuses revision ownership, and bounds export concurrency. Lazy file opening and byte-based buffering preserve backpressure. Terminal paths converge on cleanup that waits for pending file opening, closes active streams and releases the lease and capacity.

Follow-up review of the fixes also found **0 findings**: colon-path normalization stays at the ZIP boundary, and moving export handling before mutation Origin checks preserves session authorization and foreign-origin rejection. HEAD is excluded only from the top-level mutation precheck; downstream handlers retain their checks.

## Spec

1. **P2, resolved — accepted POSIX filenames resembling Windows drives failed export.** The site's canonical path rules accept `a:notes.txt` and `C:/page.html`, but the ZIP encoder rejects them as absolute. Such entry names now receive an explicit `./` prefix, preserving their extracted POSIX paths. This narrow metadata convention is documented and covered by a failing-then-passing SiteModule test.
2. **P3, resolved — authenticated web HEAD without Origin returned 401 instead of 405.** Export now uses its own read-only Origin/fetch-metadata checks before the mutation-only Origin requirement. The top-level dispatcher also excludes HEAD from its mutation precheck. Both handler and production browser HTTP checks verify 405 with `Allow: GET`.

The independent Spec follow-up confirmed **0 remaining findings**, with no scope creep. Final full-suite and browser results are recorded in [the implementation ticket](issues/01-site-zip-export.md).

Totals: Standards **0**; Spec **2 resolved, 0 remaining**. Worst original Spec finding: P2 filename compatibility; neither axis has an outstanding issue.
