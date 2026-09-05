# Owner-only content access and isolated static serving

Status: ready-for-agent
Progress: done
Blocked by: 03

## Objective

Serve real private pages and assets only to their owner, and serve them anonymously only after an explicit public-visibility change.

## Scope

Implement the [private browser handoff](../spec.md#private-content-and-browser-handoff), [visibility](../spec.md#visibility-and-privacy-limits), [host security](../spec.md#hosts-and-http-security) and [static routes](../spec.md#paths-files-and-routing). Add the small app-owned open-site form and callback flow, session-bound grants, one-use tickets, raw file streaming, no-store headers and access-aware 404/HEAD responses.

Serve generated content solely on its site's hostname. Use real local HTTPS and distinct hosts in browser tests. Block uploaded workers and reserved routes as specified. Do not accept a shared password or weaken host isolation to simplify the flow.

## Acceptance

- [x] A signed-in owner opens a multipage private site with working CSS, scripts, image and font assets.
- [x] Anonymous access to each asset/document shape is denied; a different principal, wrong-host ticket, replay, expiry and logout cannot authorize it.
- [x] Making public enables anonymous reads; making private invalidates grants and denies subsequent anonymous reads without caching leakage.
- [x] Public attacker content cannot read the application or another private site in an authenticated Chromium/Firefox browser, including fetch, embedding, worker and document.domain attempts.
- [x] Root/nested/index resolution, canonical redirects, custom 404 and HEAD follow the contract after authorization.
- [x] Streams keep their selected revision alive, cancel on disconnect and cannot serve internal manifests or staging files.
- [x] POST handoff carries no credential in URL/referrer/logs, cannot be redirected to an arbitrary host and does not execute uploaded code.

## Verification

Access/content tests and Chromium/Firefox production HTTPS tests pass, including site-bound ticket replay/expiry, 101 reopenings, grants/logout/visibility revocation, deep links, all asset types, nested routing/HEAD/custom 404 and adversarial sibling-origin behavior.

Commands, exact versions and limitations: [local verification record](../verification.md). The independent Standards and Spec findings for this scope are closed; see the [review record](../review.md).
