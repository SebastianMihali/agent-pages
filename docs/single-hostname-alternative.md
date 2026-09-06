# Single-hostname alternative (evaluated, not adopted)

Agent Pages uses one application hostname plus a wildcard on a delegated content
subdomain to isolate every site by browser origin; see
[ADR 0001](adr/0001-isolate-site-origins.md). This note records a single-hostname
alternative that was evaluated and rejected, so the reasoning is not lost if the
wildcard DNS-01 requirement ([operations.md](operations.md#dns-and-certificates))
turns out to be real friction for self-hosters later.

## The model

Serve every site from one hostname and isolate hosted documents with the CSP
`sandbox` directive instead of a separate origin. A response served with
`Content-Security-Policy: sandbox` (without `allow-same-origin`) is rendered in
a browser-generated opaque origin, even when the document is opened as a
top-level navigation rather than in an iframe. An opaque origin has no origin
in common with anything else, including other sites on the same hostname and
the application itself, so it cannot read their storage, cookies, or DOM.

This would remove the wildcard DNS record, the wildcard certificate, and the
DNS-01 requirement entirely: one hostname, one ordinary certificate.

## Why it was rejected for now

- **Hosted sites lose client-side state.** An opaque origin cannot use
  `localStorage`, `sessionStorage`, IndexedDB, cookies, or service workers.
  Any hosted site that relies on those (a simple test app with a login form,
  a demo that persists state) breaks in a way a real origin would not.
- **Private sites would need tokenized URLs.** Requests from an opaque
  origin count as cross-site, so a `SameSite=Lax` grant cookie is not sent
  with a private site's own scripts, styles and images. The alternative,
  `SameSite=None` cookies, would attach the grant to requests from any other
  origin as well, exposing a private site's JavaScript and CSS to cross-site
  inclusion. What remains is a short-lived token in the path, which the
  glossary deliberately avoids.
- **Shared domain reputation.** Every hosted site, trusted or not, would
  share one hostname's reputation with browsers, mail filters, and safe
  browsing lists. A single abusive upload could taint lookups for every other
  site on the domain.

These are compatibility and security regressions, not implementation
difficulty; a real origin per site avoids all three by construction.

## Status

Rejected for the current MVP. It remains a documented exit if the delegated
wildcard subdomain and DNS-01 challenge described in
[operations.md](operations.md#dns-and-certificates) prove too much friction
for self-hosters in practice. It does not replace
[ADR 0001](adr/0001-isolate-site-origins.md), which stays the accepted model.
