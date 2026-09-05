# Minimal owner web interface

Status: ready-for-agent
Progress: done
Blocked by: 05

## Objective

Finish the small interface needed to sign in, open private sites, manage visibility and connect the owner's agents.

## Scope

Finish the [web interface contract](../spec.md#web-interface-and-operations) using existing authenticated operations and TanStack/React with Tailwind and small accessible components. Reuse the login, key forms and open-site flow already introduced; keep all site decisions in the domain module.

Provide owned-site list/detail, clear visibility and expiry labels, open-site navigation, explicit public/private actions and API-key creation/revocation. File upload, ZIP, editor, analytics and preview iframes remain deferred.

## Acceptance

- [x] Login/logout and session expiry have clear recoverable states.
- [x] Lists/details show only owned records, render untrusted names/paths as text and show useful empty/error/loading states.
- [x] Open Site follows the private handoff or opens public content without embedding it in the application origin.
- [x] Visibility changes are explicit and handle version conflicts without overwriting newer state.
- [x] API key display is once-only, copyable and absent from persisted browser state or page hydration.
- [x] Keyboard interaction, labels and narrow-screen layout are checked; no continuous polling or unnecessary subscriptions are introduced.
- [x] UI tests exercise user actions and outcomes rather than duplicating markup implementation.

## Verification

Chromium/Firefox UI workflows pass for login/logout, empty/error states, escaped site/file names, selected-site deep links, explicit visibility, once-only key copy/revoke and keyboard/mobile layout. Root inspected the safe desktop/mobile screenshots.

Commands, exact versions and limitations: [local verification record](../verification.md). The independent Standards and Spec findings for this scope are closed; see the [review record](../review.md).
