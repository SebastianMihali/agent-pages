# Self-host DNS and certificate guidance

Status: ready-for-agent
Progress: done
Blocked by: —

## Objective

Remove the impression that Agent Pages needs a whole domain: explain the delegated wildcard and how to obtain its certificate on common setups.

## Scope

Extend `docs/operations.md` and the README production paragraph:

- State that the content zone is one delegated subdomain such as `sites.example.com`, that `*.sites.example.com` leaves every other name on the domain untouched, and that two DNS records are needed: the application host and the wildcard.
- Explain that a wildcard certificate requires the ACME DNS-01 challenge, so the proxy needs API credentials for the DNS provider, and that HTTP-01 cannot issue it.
- Give the Coolify configuration path for a wildcard certificate with a DNS provider, verified against current Coolify and Traefik documentation, with at least the Cloudflare case. Mark anything not verified on a real deployment as such.
- Record the single-hostname sandbox model as an evaluated alternative in a short note under `docs/` so the reasoning is not lost.

Use primary sources and record the consulted versions and dates. Do not change application code.

## Acceptance

- [x] A self-hoster with an existing domain can follow the document to the point of a working wildcard route without reading the ADR.
- [x] Every proxy or provider step cites its source and version.
- [x] The alternative-model note exists and links to the ADR it did not replace.

## Verification

2026-09-06: `docs/operations.md` gained a "DNS and certificates" section with the two-record model, the DNS-01 requirement and a cited Coolify/Traefik/Cloudflare configuration path; `docs/single-hostname-alternative.md` records the rejected CSP sandbox model and links ADR 0001; the README production sentence was adjusted. Sources: Traefik ACME reference (v3.7 docs), go-acme/lego Cloudflare provider page, Coolify "DNS Challenge" and "Wildcard SSL Certificates" pages, all accessed 2026-09-06. No step was exercised on a real Coolify instance; the document says so.
