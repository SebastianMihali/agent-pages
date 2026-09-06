# Agent Pages

Self-hosted static hosting for coding agents. Create a site, receive a stable URL and update its files through MCP or REST.

**Status:** the single-owner MVP is implemented and locally verified, including real Codex/Claude Code workflows, Chromium/Firefox isolation, Docker persistence and cold restore. See the [verification record](.scratch/mvp/verification.md). Deployment through the intended Coolify proxy is deferred until domains and a target are chosen. Release tags publish a multi-arch image to GHCR through the [release workflow](.github/workflows/release.yml); no release has been tagged yet.

Sites start private to their owner. New sites inherit the owner's expiration preset unless creation supplies an explicit expiration, and a live site's expiration can be changed later. An explicit visibility change makes a site public, and it can be made private again. The application and each site's uploaded code run on separate browser origins. Private sharing, multiple accounts, ZIP uploads, browser editing, SPA fallback and rollback are outside this MVP.

## Run locally

Use Node 24.16 and pnpm 11.5 (exact dependency versions are pinned).

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm admin:password-hash
```

The last command reads a password privately and prints its salted hash. Set `ADMIN_PASSWORD_HASH` in `.env` to that complete value, retaining the dollar signs, and choose `ADMIN_USERNAME`. The example uses isolated local development storage and distinct `.localhost` hosts.

```sh
pnpm dev
```

Open `http://app.agent-pages.localhost:3000`, sign in and create a labeled API key for each agent client. Use the [MCP client setup](docs/mcp-clients.md) to connect Codex or Claude Code. Initial site creation and uploads use MCP/REST; the web interface lists sites, opens private content and manages expiration, visibility and keys.

Production requires HTTPS, an application hostname and a wildcard on one delegated content subdomain such as `sites.example.com`; the rest of a shared domain stays untouched, and the wildcard certificate needs the DNS-01 challenge. See [development and validation](docs/development.md) and [container, proxy and backup operations](docs/operations.md). Production data belongs on one local persistent volume with one application process.

## Project references

- [Product direction](agent-pages-spec.md)
- [MVP contract and acceptance](.scratch/mvp/spec.md)
- [Implementation tickets](.scratch/mvp/plan.md)
- [Domain glossary](CONTEXT.md)
- [Agent Pages skill](skills/agent-pages/SKILL.md)

The [original specification](docs/archive/agent-pages-spec-original.md) is historical context, not the implementation contract. Agent Pages is released under the [MIT License](LICENSE).
