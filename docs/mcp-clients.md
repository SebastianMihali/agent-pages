# MCP client configuration draft

Checked: 2026-09-05. Target clients: Codex and Claude Code, both explicitly required for the MVP. These are documentation-backed configuration examples; live Agent Pages connections have not been tested because the server is not implemented.

## Shared configuration

Use the application's HTTPS endpoint, e.g. `https://app.example.com/mcp`, with an owner API key in the Authorization header. Site hostnames do not expose MCP. The key comes from the owner's authenticated key-management screen once implemented.

Supply `AGENT_PAGES_API_KEY` through the environment of the client process. Keep its value out of repository files and shell history. The browser owner session and private-site grants are not MCP credentials. Client configuration should reference an environment variable rather than persist the full secret.

## Codex

The installed CLI help confirms this form; it is shown for later setup and was not executed:

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

## Verification required

In [ticket 07](../.scratch/mvp/issues/07-release-verification.md), record exact client versions, server dependency versions and results for each client:

1. Initialize, discover the expected tools and create a private multipage fixture.
2. Confirm anonymous access is denied; open the site as its signed-in owner.
3. Read a relevant file, update it with the returned version and an operation ID, and preserve the site URL.
4. Retry an operation and reconnect without duplicating the site or replaying a visibility change.
5. Explicitly make the fixture public, confirm anonymous access, then make it private and confirm denial.
6. Revoke the key and confirm the next request fails. Delete only fixtures created for the verification.

Inspect missing-variable and invalid-token failures as well as the happy path. SDK integration tests are necessary but do not replace these client workflows. OAuth and other MCP clients are not claimed as supported by this MVP.
