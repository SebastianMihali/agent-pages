# Pre-release changes — contract deltas

Updated: 2026-09-06. Status: decided with the owner through a grilling session; no ticket implemented yet.

This document records the decisions that extend or amend the [MVP contract](../mvp/spec.md) before the first deployment. Tickets under `issues/` implement them in order. Where a delta and the MVP contract disagree, this document wins until the MVP contract is updated by the implementing ticket.

## Decisions settled with the owner

- **Domain model is unchanged.** The application hostname plus a wildcard on a delegated content subdomain ([ADR 0001](../../docs/adr/0001-isolate-site-origins.md)) stays. The owner's concern was self-hosters sharing a domain with other projects; `*.sites.example.com` does not touch the rest of that domain. A single-hostname model based on the CSP `sandbox` directive was evaluated and rejected for now because it removes client-side storage from hosted sites and requires tokenized private URLs. It remains a documented exit if DNS-01 friction proves real.
- **Positioning.** A developer tool for sharing simple test sites, not a hosting service. Adversaries are anonymous visitors, scripts inside hosted sites and other owners. A managed cloud version is possible later; the current work only keeps multi-owner compatibility and adds no account features.
- **Interface language is English**, hardcoded, without an i18n layer.
- **No indexing.** Every site response carries `X-Robots-Tag: noindex, nofollow`, without a per-site option.
- **Default expiration.** A per-owner setting, initial value 7 days, chosen from presets in the dashboard (1 day, 7 days, 30 days, never). It applies only when creation omits `expiresInSeconds`; explicit `null` means never and an explicit number wins. Existing sites are unaffected. No environment variable and no MCP tool exposes the default; agents read `expiresAt` from the creation result.
- **Expiration is mutable.** A new domain operation `set_site_expiration` is exposed on REST, MCP and the dashboard with the same `operationId`/`expectedVersion` contract as `set_site_visibility`. It takes `expiresInSeconds` relative to the call, with creation's bounds, or `null` to remove expiration. An expired site is terminal: the operation returns `SITE_EXPIRED`.
- **CI/CD.** GitHub with Actions, pull requests required on `main` with required checks. Every push and PR runs lint, typecheck, tests, build, Playwright on Chromium and Firefox, and an amd64 Docker build. Semver release tags publish a multi-arch (amd64, arm64) image to GHCR. No automatic deployment until a Coolify target exists.
- **License is MIT.** The repository stays private until the license file exists, then becomes public.

## Order

| Ticket | Deliverable | Blocked by |
| --- | --- | --- |
| [01](issues/01-english-owner-interface.md) | English owner interface and browser-test selectors | — |
| [02](issues/02-ci-and-release-pipeline.md) | GitHub CI, release image pipeline, MIT license, public repository | — |
| [03](issues/03-noindex-site-responses.md) | `X-Robots-Tag` on all site responses | — |
| [04](issues/04-default-expiration-and-set-site-expiration.md) | Per-owner default expiration and `set_site_expiration` | 02 |
| [05](issues/05-self-host-dns-documentation.md) | Delegated wildcard and DNS-01 guidance for self-hosters | — |

Ticket 04 waits for 02 so the contract change lands with CI in place. Tickets 01, 03 and 05 are independent. Real deployment follows this effort and still needs the inputs listed in the [MVP plan](../mvp/plan.md#operational-inputs-for-deployment).

## Out of scope

Single-hostname sandbox mode, multi-account provisioning, per-site indexing control, a free-form default-expiration field, reviving expired sites, automatic deployment and the post-MVP roadmap items in the [product direction](../../agent-pages-spec.md#after-the-mvp).
