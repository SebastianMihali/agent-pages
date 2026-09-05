# Minimal owner web interface

Status: ready-for-agent
Progress: open
Blocked by: 05

## Objective

Finish the small interface needed to sign in, open private sites, manage visibility and connect the owner's agents.

## Scope

Finish the [web interface contract](../spec.md#web-interface-and-operations) using existing authenticated operations and TanStack/React with Tailwind/shadcn. Reuse the login, key forms and open-site flow already introduced; keep all site decisions in the domain module.

Provide owned-site list/detail, clear visibility and expiry labels, open-site navigation, explicit public/private actions and API-key creation/revocation. File upload, ZIP, editor, analytics and preview iframes remain deferred.

## Acceptance

- [ ] Login/logout and session expiry have clear recoverable states.
- [ ] Lists/details show only owned records, render untrusted names/paths as text and show useful empty/error/loading states.
- [ ] Open Site follows the private handoff or opens public content without embedding it in the application origin.
- [ ] Visibility changes are explicit and handle version conflicts without overwriting newer state.
- [ ] API key display is once-only, copyable and absent from persisted browser state or page hydration.
- [ ] Keyboard interaction, labels and narrow-screen layout are checked; no continuous polling or unnecessary subscriptions are introduced.
- [ ] UI tests exercise user actions and outcomes rather than duplicating markup implementation.

## Verification

Not run; implementation has not started.
