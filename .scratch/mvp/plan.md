# MVP implementation plan

Updated: 2026-09-05. Implementation in progress; local acceptance and release verification are being recorded.

## Decisions settled with the owner

- Start with one owner account.
- Sites are private to that owner by default; making a site public is an explicit, reversible visibility change.
- Private sharing and multiple accounts are outside the MVP.
- Verify MCP with both Codex and Claude Code.

The [MVP specification](spec.md) is the behavioral contract. The architecture decisions are [origin isolation](../../docs/adr/0001-isolate-site-origins.md) and [complete revisions](../../docs/adr/0002-publish-complete-revisions.md).

## Start here

Begin with [01 — Runtime and HTTP integration](issues/01-runtime-and-http-integration.md). Do not generate the whole application skeleton from the old specification. Complete one ticket's behavior and focused checks before moving to its dependents.

`Status` is the triage label from [repository conventions](../../docs/agents/triage-labels.md). `Progress` is `open`, `in-progress` or `done`. `Blocked by` lists ticket numbers and is satisfied only when every prerequisite has `Progress: done`. A ticket can be fully specified (`ready-for-agent`) while waiting on implementation prerequisites. This plan uses normal implementation tickets, not the separate wayfinder claimed/resolved convention.

Before changing a ticket to done, record the changed files, verification commands/results and any remaining limitations under `## Verification`. Keep acceptance boxes honest; a planned test or mocked protocol response is not a live-client verification.

## Ordered work

| Ticket | Deliverable | Blocked by | Progress |
| --- | --- | --- | --- |
| [01](issues/01-runtime-and-http-integration.md) | Small bootable TanStack/Node application, host dispatch and production MCP transport probe | — | in-progress |
| [02](issues/02-owner-identity.md) | One owner, sessions, personal keys and shared authorization | 01 | in-progress |
| [03](issues/03-site-publication.md) | Revision storage, site lifecycle, retry/concurrency and quotas | 02 | in-progress |
| [04](issues/04-content-access.md) | Private-site browser handoff, content serving and explicit public visibility | 03 | in-progress |
| [05](issues/05-rest-and-mcp.md) | Complete shared REST/MCP operations and binary upload | 04 | in-progress |
| [06](issues/06-owner-interface.md) | Minimal owner UI and visibility/key controls | 05 | in-progress |
| [07](issues/07-release-verification.md) | Both live clients, browser isolation, Docker/Coolify and restore verification | 06 | in-progress |

Build the smallest fixture/UI necessary to prove each earlier ticket; the UI ticket finishes usability, not deferred security. All development and fixture data remain local/isolated until private-content tests pass. The first real owner workflow is create-private → open-as-owner → read/update → explicitly make-public → make-private.

## Technical checks at implementation time

These are bounded engineering tasks, not pending product questions:

- Pin compatible TanStack/MCP/SQLite/Zod versions and Node. Nitro 3 is a documented exception to the stable-version preference: the current TanStack integration uses `nitro/vite`, available in the pinned beta. Production/native build and HTTP tests guard this integration; reassess before dependency upgrades.
- Verify stateless MCP JSON response behavior and the built server's raw request/body/stream handling before implementing all tools.
- Validate wildcard TLS, host forwarding and HTTP-method handling through the intended Coolify proxy configuration; document exact tested versions.
- Validate Chromium/Firefox origin isolation and the private-site POST handoff before treating the hosting path as ready.
- Measure full-revision preparation for a small site and a near-limit fixture; document memory, elapsed time and temporary disk use before adding optimizations.

If a check disproves the chosen design, update its ADR/contract before expanding implementation. Do not silently fall back to same-origin hosting, public-by-default content or in-place batch writes.

## Operational inputs for deployment

Local implementation can start without these. Deployment verification needs the actual application hostname, content base domain, control over wildcard DNS/TLS, a reachable Coolify target and a running Docker engine. Request those when the container and deployment instructions are concrete; do not request or store credentials in this plan.

The environment inspection is recorded in [development preparation](../../docs/development.md). Docker became available during implementation. Build, persistence and restore evidence belongs in ticket 07; the intended remote proxy still requires deployment inputs.

The project intends open-source distribution, but no license has been selected. Choose a license before external distribution; this is not a prerequisite for local implementation.

## Completion

The MVP is complete only when all seven tickets and the [acceptance criteria](spec.md#acceptance) are verified. Until then, README must describe the actual implemented state rather than advertise planned features as available.
