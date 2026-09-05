# Runtime and HTTP integration

Status: ready-for-agent
Progress: done
Blocked by: none

## Objective

Create the smallest production-buildable single-package application and prove that the chosen HTTP entry point can dispatch isolated hosts and handle the official MCP transport without another HTTP framework.

## Scope

Read the [stack](../../../agent-pages-spec.md#stack), [host contract](../spec.md#hosts-and-http-security) and [transport contract](../spec.md#rest-and-mcp-contract). Resolve dependency versions from official sources/package metadata, pin Node/pnpm and add package scripts for focused tests, type checking, lint and build. Keep configuration server-only; add a validated schema, placeholder `.env.example` and `.gitignore` protecting local data and credentials.

Use an isolated local test endpoint/tool to verify initialization, discovery and a JSON tool response through the production build. It must not ship as an unauthenticated management capability. No site operations or general storage-provider framework belong in this ticket. Start a minimal non-root Dockerfile early so runtime/native SQLite assumptions can be checked before the final release ticket.

## Acceptance

- [x] Clean dependency install, focused test, type/lint checks and production build pass.
- [x] App host, valid content host and unknown host reach distinct controlled handlers; forwarded-host spoofing fails the configured policy.
- [x] The built app accepts the official SDK request/response model without buffering an unbounded body or leaking per-request resources.
- [x] Health output is minimal and malformed/insecure production config fails with actionable context.
- [x] The Dockerfile builds and starts if the local engine is available; otherwise record this check as outstanding and keep final release blocked on it.
- [x] Add actual development commands and selected versions to documentation without claiming site hosting is implemented.

## Verification

Runtime/config/hosts/body/MCP tests pass; production SSR/HTTP and native startup are covered by the browser suite and Docker smoke. Dependencies install from the pinned lockfile. Nitro beta/native packaging and the process-wide bootstrap seam are documented.

Commands, exact versions and limitations: [local verification record](../verification.md). The independent Standards and Spec findings for this scope are closed; see the [review record](../review.md).
