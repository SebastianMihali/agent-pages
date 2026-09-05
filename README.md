# Agent Pages

A small self-hosted static hosting application for coding agents. Create a site, receive a stable URL and update its files through MCP or REST.

**Status:** specification and implementation plan prepared. There is no runnable application or published Docker image yet.

Sites start private to their owner. An owner can explicitly make a site public and return it to private visibility. Private access is not shared with clients or collaborators in the initial scope.

## Start here

- [Product direction](agent-pages-spec.md)
- [MVP contract](.scratch/mvp/spec.md)
- [Implementation plan and tickets](.scratch/mvp/plan.md)
- [Domain glossary](CONTEXT.md)
- [Development preparation](docs/development.md)
- [MCP client configuration draft](docs/mcp-clients.md)

The intended deployment is one Docker application and one persistent `/data` volume, with an application hostname and wildcard site hostnames for browser isolation. The first supported agent clients are Codex and Claude Code.

Install, build, deployment and usage commands will be added when they have been implemented and verified. The [original specification](docs/archive/agent-pages-spec-original.md) is preserved as historical context and is not an implementation contract.
