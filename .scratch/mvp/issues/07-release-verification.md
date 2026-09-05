# Live clients, deployment and recovery verification

Status: ready-for-agent
Progress: in-progress
Blocked by: 06

## Objective

Demonstrate the complete private-by-default workflow and a reproducible self-hosted installation before declaring the MVP complete.

## Scope

Verify every remaining [acceptance criterion](../spec.md#acceptance), both [client configurations](../../../docs/mcp-clients.md), the production container and [operations contract](../spec.md#web-interface-and-operations). Add tested Docker Compose/Coolify instructions, `.env.example` guidance and usage examples. Create the Agent Pages skill using the available skill-creation/writing guidance; teach stable-site updates, owner authentication, explicit visibility changes, operation IDs and the actual root-based URLs.

Use isolated fixtures and capture exact versions/results. Request real deployment hostnames/access only when a concrete container/configuration exists. Never connect an unverified application to existing private content or configure the user's real clients with test credentials silently.

## Acceptance

- [ ] Codex and Claude Code each discover tools, create a private multipage site, read/change its stylesheet, preserve its identity and change visibility explicitly when requested.
- [ ] Reconnect/retry, revoked-key failure and privacy behavior are demonstrated with both configurations; record client versions and any unsupported modes.
- [ ] Production lint/type/build and all relevant domain, integration and browser checks pass.
- [ ] Fresh non-root Docker startup, persistent restart, readiness/recovery and wildcard host/TLS routing work behind the intended Coolify proxy; record tested deployment details.
- [ ] Cold backup restores to a fresh volume with the same owner, visibility, files and keys, and invalidates browser sessions.
- [ ] Published documentation describes only verified functionality; remaining limitations are explicit.
- [ ] All MVP acceptance boxes have evidence and the Agent Pages skill matches the implemented contract.

## Verification

Local application checks pass (87 tests, lint, typecheck), browser checks pass, and Docker/Compose restart/restore/private-state checks pass. Actual Codex/Claude workflows are recorded in docs/mcp-clients.md. Remote Coolify/DNS/TLS checks are intentionally deferred by the owner; the release acceptance remains open for that deployment boundary.

Commands, exact versions and limitations: [local verification record](../verification.md). Final independent code review is in progress.
