# Development preparation

Planning snapshot: 2026-09-05. This is preparation evidence, not a build or runtime verification.

## Environment observed

| Item | Observation |
| --- | --- |
| Workspace | Documentation only; no application package or test suite yet |
| Git | No repository initialized in this directory |
| Node.js | v24.16.0 available |
| pnpm | 11.5.0 available |
| Docker CLI | 29.5.2 available |
| Docker engine | Unreachable at the configured local socket during inspection |
| Codex CLI | Available; `mcp add --help` exposes Streamable HTTP and bearer-token environment-variable configuration |
| Claude Code CLI | Available; `mcp add --help` exposes HTTP transport and custom headers |

These versions are observations, not a dependency-support promise. [Ticket 01](../.scratch/mvp/issues/01-runtime-and-http-integration.md) selects compatible versions and records them in the actual package/runtime configuration. Once those files exist, consult them rather than treating this snapshot as current environment state.

## Implementation entry point

Read the [MVP plan](../.scratch/mvp/plan.md), its first unblocked ticket and the contract sections linked by that ticket. The [product direction](../agent-pages-spec.md) explains scope; the historical draft is not an implementation template.

Implementation preparation is complete when the contract, glossary, ADRs and ordered tickets agree and their local references resolve. Implementation begins with a small bootable application; no dependency install, Git initialization, client configuration change, DNS change or deployment was performed during documentation preparation.

Preparation checks on 2026-09-05 verified local Markdown targets/anchors, balanced code fences, ordered ticket dependencies and the client JSON example. The historical specification's original body was preserved (36,452 UTF-8 bytes). These documentation checks do not satisfy application acceptance criteria.

## Local verification approach

- Use temporary fixture directories or a dedicated development data directory; never point tests at an existing `/data` installation.
- Add real package commands when implemented, then document only commands that were run successfully.
- Exercise isolated application/site hostnames from the first host-dispatch ticket. Browser security tests use local HTTPS and the production cookie policy; an HTTP development shortcut is not security evidence.
- Use a synthetic second principal only in tests to establish owner checks. The product has one account in the MVP.
- Inject time and operation failure points for expiry/recovery tests, and use child-process termination where a real restart matters.
- Capture process IDs for development servers and stop only processes started for that task.

## Deployment prerequisites, collected later

The final deployment verification needs a running Docker engine, a target Coolify installation, an application hostname and a content base domain whose wildcard DNS/TLS can be configured. The intended deployment is documented in the [MVP operations contract](../.scratch/mvp/spec.md#web-interface-and-operations).

No remote target or credentials are assumed to exist. Prepare the container and exact proxy configuration first, then collect the missing operational inputs. Keep production passwords, keys and private fixtures out of tracked files and tool output.
