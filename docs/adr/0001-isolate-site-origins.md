---
status: accepted
date: 2026-09-05
---

# Isolate the application and every site by origin

Sites start private to their owner and can become public; uploaded JavaScript is untrusted. Use one application hostname and a distinct hostname for each site, routed to the same application and persistent volume, because path separation cannot isolate a public site's scripts from private content opened by the same visitor.

This supersedes the original single-origin requirement and the interim proposal to share a second origin between all sites. Production needs a wildcard DNS record, wildcard HTTPS and a wildcard proxy route for site hostnames; that operational cost buys browser-native separation while preserving ordinary static JavaScript.

## Considered options

- One origin for everything leaves application sessions exposed to uploaded scripts.
- Two fixed origins protect the application but leave sites able to interact as same-origin documents.
- Opaque-origin sandboxing changes the behavior of storage, modules and other browser features; it is not the compatibility model for this MVP.
- Shared site passwords would grant access beyond the owner and contradict the requested access policy.

## Consequences

Sites are served at the root of their own origin. The old `/s/:slug/` base-path requirement is retired. Site hostnames are stable, server-generated identifiers and are never reassigned to a different site. Credentials stay off visitor URLs; app login and management stay on the application hostname.

Sibling subdomains remain same-site for cookies. Enforce host-only cookies, exact-origin checks, owner authorization, restrictive embedding/CORS behavior and the private-content handoff described in the [MVP security contract](../../.scratch/mvp/spec.md#identity-and-access). Separate origins do not protect against an authorized owner deliberately exporting their content, or an operator reading the underlying storage.

Browser behavior reference: [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy) and [cookie scope and HttpOnly](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).
