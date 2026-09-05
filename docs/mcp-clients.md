# MCP client configuration and verification

Checked: 2026-09-05. Codex and Claude Code both completed a live MCP workflow against an isolated loopback HTTP fixture using the application’s authentication, MCP and site modules. This verifies real client interoperability; the fixture does not exercise the TanStack production bundle or deployed wildcard TLS.

## Shared configuration

Use the application's HTTPS endpoint, e.g. `https://app.example.com/mcp`, with an owner API key in the Authorization header. Site hostnames do not expose MCP. Create the key in the owner's authenticated key-management screen.

Supply `AGENT_PAGES_API_KEY` through the environment of the client process. Keep its value out of repository files and shell history. The browser owner session and private-site grants are not MCP credentials. Client configuration should reference an environment variable rather than persist the full secret.

## Codex

For a persistent installation, the installed CLI help confirms this form. The smoke test uses invocation-only configuration and does not run this configuration-changing command:

```sh
codex mcp add agent-pages --url https://app.example.com/mcp --bearer-token-env-var AGENT_PAGES_API_KEY
```

Equivalent configuration entry:

```toml
[mcp_servers.agent-pages]
url = "https://app.example.com/mcp"
bearer_token_env_var = "AGENT_PAGES_API_KEY"
```

The official documentation describes the URL and bearer environment-variable fields for HTTP servers. Verify that the actual client process, including a graphical launcher if used, receives the variable. [OpenAI MCP documentation](https://developers.openai.com/codex/mcp/).

## Claude Code

Use a scoped MCP configuration with a variable reference in the header:

```json
{
  "mcpServers": {
    "agent-pages": {
      "type": "http",
      "url": "https://app.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${AGENT_PAGES_API_KEY}"
      }
    }
  }
}
```

Claude Code documents environment expansion in HTTP headers. Confirm the variable is present before connecting and check connection status; do not assume a saved configuration proves authentication. The installed CLI help also confirms HTTP transport/header support. [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json).

## Recorded live verification

The commands below ran successfully on 2026-09-05 with Node 24.16.0 and MCP TypeScript SDK 1.30.0:

```sh
pnpm exec tsx scripts/mcp-client-smoke.ts both
```

| Client | Version | Fixture site ID | Result |
| --- | --- | --- | --- |
| Codex CLI | 0.153.4 | `039fb0fae999e707a2d343d2badde838` | Lifecycle, reconnect and credential cases passed |
| Claude Code | 2.1.261 | `bc52ec5ef8ccabb1cd6c560063c4ecaa` | Lifecycle, reconnect and credential cases passed |

Each client discovered tools and made these real HTTP MCP calls: `create_site`, `read_file`, `write_files`, an exact replay of `write_files`, another `read_file`, two `set_site_visibility` calls, `get_site`, and `list_files`. The server observed creation as private/version 1, update and replay as version 2, public as version 3, and private again as version 4. Each final site retained three files and its updated index content. Content-handler probes returned anonymous 404 for private state, 200 for public state, then 404 after returning to private. After each client exited, the harness revoked its key and confirmed the next HTTP MCP discovery request returned 401.

A second actual process invocation of each client reused its fixture site ID and key, initialized a new MCP connection, then successfully called `get_site` and `read_file`. Both saw the existing private/version-4 site and its updated file, with no creation or mutation calls.

The harness also launched each real client with `AGENT_PAGES_API_KEY` removed from its environment and then with an invalid value. No authenticated tool calls occurred and the stored site state remained unchanged in all four cases:

| Client case | Observed behavior |
| --- | --- |
| Codex, missing variable | No HTTP MCP request; client reported unavailable MCP tools. |
| Codex, invalid key | Two HTTP 401 handshake requests; client reported unavailable MCP tools. |
| Claude Code, missing variable | Two HTTP 401 handshake requests; client reported unavailable server/credentials. It did not stop with a configuration-expansion error. |
| Claude Code, invalid key | Two HTTP 401 handshake requests; client reported unavailable MCP tools. |

All four negative client invocations exited with code 0 while reporting the MCP failure in their final answer. The harness checks server requests, authenticated tool calls and unchanged site state; CLI exit status alone does not establish a successful MCP connection. Revocation remains a direct HTTP probe after the actual client invocations, and anonymous visibility probes run through the content handler rather than an external browser.

The harness independently checks the stored site state rather than trusting a client's final answer. It creates a temporary data directory, deletes its own fixtures, revokes keys, closes its own server and removes temporary configuration. API keys are generated in memory and passed through `AGENT_PAGES_API_KEY`; configuration files contain only the variable reference. Normal output records tool names, site IDs, versions and statuses, never authorization headers or complete request bodies. No global client configuration was changed.

Codex ran with `--ignore-user-config`, `--ephemeral`, a read-only sandbox, disabled shell/apps/multi-agent tools, and invocation-only MCP configuration. Claude ran with `--strict-mcp-config`, an isolated MCP file, empty setting sources, `--no-session-persistence`, no built-in tools and only the fixture MCP tools allowed. Both clients used their existing authenticated subscriptions. The harness is optional and requires those CLI installations and authentication; it is not part of the automated test suite.

Strict Zod input schemas are advertised through the SDK. Domain failures return structured `error` fields with `isError: true`; malformed tool arguments rejected before the callback use the SDK's own validation-error result.

## Remaining deployment verification

The live fixture does not establish production deployment acceptance. In [ticket 07](../.scratch/mvp/issues/07-release-verification.md), separately verify the production bundle through the intended HTTPS proxy and browser owner handoff, and repeat the client workflow against that deployment:

1. Initialize, discover the expected tools and create a private multipage fixture.
2. Confirm anonymous access is denied; open the site as its signed-in owner.
3. Read a relevant file, update it with the returned version and an operation ID, and preserve the site URL.
4. Retry an operation and reconnect without duplicating the site or replaying a visibility change.
5. Explicitly make the fixture public, confirm anonymous access, then make it private and confirm denial.
6. Revoke the key and confirm the next request fails. Delete only fixtures created for the verification.

SDK integration tests are necessary but do not replace these client workflows. OAuth and other MCP clients are not claimed as supported by this MVP.
