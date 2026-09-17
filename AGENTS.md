# Working on Agent Pages

Read [architecture](docs/architecture.md) before changing publication, access control or storage. That guide includes the architectural decisions and durable constraints; the [domain glossary](CONTEXT.md) defines product terms.

- Keep site rules in `src/server/sites/`; REST, MCP and dashboard handlers adapt those same operations.
- Treat hosted files as untrusted. Keep application and content origins separate, authorize each request and preserve private-by-default creation.
- Preserve atomic revisions, expected-version checks and operation-ID replay semantics across transports.
- Keep one application instance and one local persistent data volume. Run tests with temporary storage and credentials.
- Inspect callers and tests before editing. Preserve unrelated workspace changes and avoid speculative abstractions.
- Test public behavior and failure boundaries. Use focused tests first, then the checks described in [development](docs/development.md).
- Update [REST API](docs/api.md), [agent instructions](skills/agent-pages/SKILL.md) and [operations](docs/operations.md) when their contracts change.
- Keep personal paths, credentials, production data and local agent state out of tracked files. Use placeholder domains in examples; use the canonical repository URL listed in the README for source installation.
- Use this repository's configured Git identity for commits. Create commits, tags, branches, releases or deployments only when requested.
