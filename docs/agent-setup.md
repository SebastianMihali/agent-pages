# Set up an agent for Agent Pages

The repository includes an `agent-pages` skill that teaches a coding agent how to publish safely. The skill describes the workflow; the MCP connection gives the agent authenticated tools. Use both when the client supports them. The [REST API](api.md) is the fallback for clients without MCP and for binary uploads.

## 1. Install the bundled skill

```sh
npx skills add https://github.com/SebastianMihali/agent-pages.git
```

## 2. Create and load an API key

Sign in to the Agent Pages owner dashboard and create a dedicated API key for the agent. The key is shown once. Load it into the shell that starts the client:

```sh
# Bash: the value is read without echoing or entering it in shell history.
read -rsp 'Agent Pages API key: ' AGENT_PAGES_API_KEY; printf '\n'
export AGENT_PAGES_API_KEY
```

Use your operating system's secret manager for persistent automation. Keep the value out of prompts, repositories, MCP JSON/TOML values, screenshots and logs. Revoke the key in the dashboard when it is no longer needed.

## 3. Connect MCP

Agent Pages exposes a Streamable HTTP MCP server at `https://app.example.com/mcp`. Requests use the owner API key loaded in step 2; browser cookies and private-site grants are not API credentials. Configure your client below, then inspect `/mcp` before publishing.

The process that launches the client must inherit `AGENT_PAGES_API_KEY`, including when it is started by a desktop launcher. Store only the environment-variable reference in client configuration.

### Codex MCP configuration

The Codex CLI accepts a URL and the name of a bearer-token environment variable:

```sh
codex mcp add agent-pages \
  --url https://app.example.com/mcp \
  --bearer-token-env-var AGENT_PAGES_API_KEY
codex mcp get agent-pages
```

The equivalent entry in `~/.codex/config.toml`, or in a trusted project-scoped `.codex/config.toml`, is:

```toml
[mcp_servers.agent-pages]
url = "https://app.example.com/mcp"
bearer_token_env_var = "AGENT_PAGES_API_KEY"
```

Use `/mcp` in Codex to inspect the active connection. See the [official OpenAI MCP documentation](https://developers.openai.com/codex/mcp/).

### Claude Code MCP configuration

Create a project-scoped `.mcp.json` containing only the environment-variable reference:

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

Claude Code also supports `claude mcp add --transport http --scope project`, but writing `.mcp.json` avoids placing a token value in a command or generated configuration. Check the connection with `/mcp`. See the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json).

### Available tools

| Tool | Purpose |
| --- | --- |
| `create_site` | Create a private site from UTF-8 text files. |
| `list_sites`, `get_site` | Find owned sites and read their metadata. |
| `list_files`, `read_file` | Inspect a revision. Binary or oversized reads return an authenticated REST download path. |
| `write_files`, `delete_files` | Atomically update one complete site revision. |
| `set_site_visibility` | Explicitly make a site public or private. |
| `set_site_expiration` | Set, replace or remove an expiration. |
| `delete_site` | Delete a site and deny new reads immediately. |

All mutations require a fresh UUID `operationId`. Mutations of an existing site also require its current `expectedVersion`. Retry a lost response with the identical operation ID and input; reconcile a `VERSION_CONFLICT` by reading current state before issuing a new operation. The bundled [Agent Pages skill](../skills/agent-pages/SKILL.md) gives agents the complete workflow.

MCP writes accept supported UTF-8 text files, including Markdown. Use the authenticated [REST API](api.md) for binary files such as PDF and images. Uploaded content never makes a site public implicitly.

## 4. Give the agent a concrete task

For a new site, paste this prompt and replace the bracketed values:

```text
Use the agent-pages skill and the configured Agent Pages MCP server.
Publish the static site in [directory] as a new private site named "[name]".
Keep it private. Include every required asset and use authenticated REST multipart for binary files.
After publication, verify the returned manifest and current metadata.
Report the site ID, version, visitor URL, owner open URL, visibility, expiration, and any files you could not publish.
Never print or store the bearer token.
```

For an update, make the identity explicit:

```text
Use the agent-pages skill and the configured Agent Pages MCP server.
Update site [32-character site ID] from [directory]. Preserve its URL, visibility, and expiration.
Read its current version and files first. Publish changed and new files in one atomic batch, preserving other files.
If I explicitly requested file removal, perform it as a separate delete operation. Use authenticated REST multipart for binary files.
Verify the resulting manifest and report the new version and URLs.
Never print or store the bearer token.
```

Publishing a new site is always private. Ask for `set_site_visibility` only when you intentionally want anonymous access. Making a site private later blocks new anonymous reads but cannot recall files already downloaded.

## REST-only alternative

An agent without MCP can use `docs/api.md` as its contract. Give it filesystem access to the site and an environment containing `AGENT_PAGES_API_KEY`, then use this prompt:

```text
Read docs/api.md and publish [directory] to Agent Pages at https://app.example.com.
Use the REST API and $AGENT_PAGES_API_KEY without printing its value.
Create a private site named "[name]". Use JSON for UTF-8 text and one manifest-first multipart request for binary files.
Generate UUID operation IDs, preserve an operation ID for exact retries, and reconcile version conflicts before writing again.
Verify metadata and the final file manifest, then report the site ID, version, visitor URL, owner open URL, and visibility.
```

For direct scripts, start with the create and multipart examples in [REST API](api.md). Treat non-2xx responses as failures and parse the structured `error` object; a successful process exit or agent summary alone does not prove publication.

## Troubleshooting

- `401 UNAUTHENTICATED`: confirm the client process received `AGENT_PAGES_API_KEY`, the key has not been revoked, and the URL is the application hostname rather than a site hostname.
- The server is absent from the tool list: inspect `/mcp`, then restart the client after changing configuration.
- A connection works in a terminal but not in a desktop app: launch the app from an environment that contains the variable or configure its process environment securely.
- `VERSION_CONFLICT`: call `get_site`, reconcile the intended update with the returned version, and use a new operation ID.
- Binary or large content: follow the multipart example in [REST API](api.md#binary-and-multipart-writes).
