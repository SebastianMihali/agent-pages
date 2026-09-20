# Agent Pages

Self-hosted static hosting for coding agents and their owners. Create a site, receive a stable URL and update its files through the dashboard, MCP or REST.

**Built almost entirely through vibe coding.**

[Visual tour](#visual-tour) · [How it works](#how-it-works) · [Install](#install-with-docker-compose) · [Connect an agent](#connect-an-agent)

## Visual tour

The owner dashboard brings active sites, public/private visibility, file totals and upcoming expirations into one workspace.

![Agent Pages Overview showing four active sites, public and private counts, recent updates and an upcoming expiration](docs/screenshots/overview.png)

These are screenshots of the running application with disposable demo data. The local addresses are examples, and the API key screen shows only a masked prefix.

<details>
<summary><strong>Manage a site: files, visibility, expiration and ZIP export</strong></summary>

Select a site to see its stable URL, current version and files. Upload files or a folder, change its expiration, explicitly make it public, or export its active content as a ZIP.

![Site detail with a private site, expiration controls, file uploads, ZIP export and the file list](docs/screenshots/sites.png)

</details>

<details>
<summary><strong>Inspect and edit source in the file workspace</strong></summary>

Open a file from the site detail, then choose **Edit file** to modify supported text. **Save changes** publishes immediately at the existing URL. HTML is displayed as source; **Open page** opens the rendered content on its separate site origin.

![File workspace editing index.html with syntax highlighting, a file list and Save changes controls](docs/screenshots/editor.png)

</details>

<details>
<summary><strong>Connect coding agents through API keys</strong></summary>

Create a labeled key for each agent client and use it with MCP or REST. The full key is shown only once; the dashboard lets you revoke it later. Each key has the owner's site-management permissions. See the [agent setup guide](docs/agent-setup.md) for configuration.

![API keys screen with key creation and a labeled demo key showing only its masked prefix](docs/screenshots/keys.png)

</details>

<details>
<summary><strong>Open the hosted result</strong></summary>

Visitors see the uploaded website on its own origin. This example is demo content hosted by Agent Pages, not a built-in template or part of the dashboard. Private sites require the owner's authenticated access; explicitly public sites can be viewed without signing in.

![A rendered demo website hosted by Agent Pages, with a studio introduction and three service columns](docs/screenshots/hosted-site.png)

</details>

## How it works

1. **Create a site.** Upload static files or a folder containing a root `index.html` from the dashboard, or let an agent create it through MCP or REST. Every new site starts private and receives a stable URL.
2. **Review the result.** Choose **Open site** to view it, or inspect its files in the dashboard. Uploaded pages run on a separate origin from the owner workspace.
3. **Update in place.** Upload changed files, save an edit in the file workspace, or ask your agent to publish an update. Complete revisions become active atomically; the site's URL and visibility are preserved. Version checks prevent silently overwriting a concurrent update.
4. **Control access and lifetime.** Keep the site private or explicitly make it public. Set or remove its expiration while it is live, export its files, or delete it when finished.

Sites start private to their owner. New sites inherit the owner's expiration preset unless creation supplies an explicit expiration, and a live site's expiration can be changed later. An explicit visibility change makes a site public, and it can be made private again. The application and each site's uploaded code run on separate browser origins. Private sharing, multiple accounts, ZIP imports, SPA fallback and rollback are outside this MVP.

## Install with Docker Compose

The installation below builds from source using the checked-in `Dockerfile` and `compose.yaml`. You need Git, a server with Docker Engine, and Docker Compose **2.30 or newer**. Compose's [`env_file.format: raw`](https://docs.docker.com/reference/compose-file/services/#format) preserves the dollar signs in the password hash. Node and pnpm are supplied by the container build.

### 1. Prepare DNS and HTTPS

Choose two separate hostnames and point their DNS records at your reverse proxy:

| DNS name | Purpose |
| --- | --- |
| `app.example.com` | Dashboard, login, REST and MCP |
| `*.sites.example.com` | Isolated hostnames for uploaded sites |

Replace these examples with your own domain. Configure HTTPS for the application host and a wildcard certificate for `*.sites.example.com`. Wildcard issuance requires DNS-01; the [DNS and certificate guide](docs/operations.md#dns-and-certificates) explains DNS-01 and the required proxy routes. The rest of your domain can continue serving other projects.

### 2. Get the source and create the owner credentials

Clone the repository, then work from its root:

```sh
git clone https://github.com/SebastianMihali/agent-pages.git
cd agent-pages
cp .env.example .env.production
chmod 600 .env.production
```

Generate the password hash interactively using the helper in a temporary Node container:

```sh
docker run --rm -it \
  --mount "type=bind,source=$PWD,target=/workspace,readonly" \
  --workdir /workspace \
  node:24.16.0-bookworm-slim \
  node scripts/password-hash.ts
```

Enter and confirm your chosen password; input is hidden. Copy the printed hash into `.env.production`. If you already have Node 24.16 installed, you can instead run `node scripts/password-hash.ts` directly.

Edit `.env.production` to contain your production values:

```dotenv
NODE_ENV=production
APP_ORIGIN=https://app.example.com
CONTENT_BASE_DOMAIN=sites.example.com
DATA_DIR=/data
ADMIN_USERNAME=owner
ADMIN_PASSWORD_HASH=<paste the generated scrypt hash here>
PORT=3000
```

`CONTENT_BASE_DOMAIN` is a hostname without `https://` or `*.`. Paste the hash as an unquoted value, preserving every `$` character. Keep the file private and untracked. Optional storage, file-size and request limits are listed in `.env.example`.

### 3. Build and start

```sh
docker compose config --quiet
docker compose up --build --detach
docker compose ps
curl --fail http://127.0.0.1:3000/health/ready
```

Readiness returns `{"status":"ok"}` after initialization and storage recovery. If it does not become ready, inspect `docker compose logs --tail=100 agent-pages` before proceeding.

Compose runs one instance, binds port 3000 to the server's loopback interface and persists data in the `agent-pages-data` named volume mounted at `/data`. Keep one replica and local persistent storage. For a bind mount instead, the directory must be writable by container UID/GID `1000`.

### 4. Connect the reverse proxy and sign in

Route both the application hostname and the wildcard content hostnames to this same application. A proxy running on the host can use `http://127.0.0.1:3000`; a containerized proxy needs a shared Docker network and the application's container port `3000`. Its own `127.0.0.1` does not address the application container.

Preserve the external `Host`, replace forwarded host/protocol headers, force HTTPS and disable proxy caching. Allow at least the configured multipart body limit, including framing, and 120 seconds for browser uploads. Follow the [reverse-proxy requirements](docs/operations.md#reverse-proxy).

```sh
curl --fail https://app.example.com/health/ready
```

Open your application URL and sign in with `ADMIN_USERNAME` and the original password. Create a private site containing `index.html`, then open it from the dashboard to verify wildcard routing and TLS. In **API keys**, create a key for your agent and follow the [agent setup guide](docs/agent-setup.md).

To stop the installation while retaining its data, use `docker compose down`. The `--volumes` option deletes the persistent volume, so omit it when stopping or updating. Take a [cold backup](docs/operations.md#cold-backup) before upgrades.

## Run locally for development

From the repository root, use Node 24.16 and pnpm 11.5.0 (exact dependency versions are pinned). This starts the development server with isolated local data; use the Docker instructions above for a production installation.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm admin:password-hash
```

The last command reads a password privately and prints its salted hash. Set `ADMIN_PASSWORD_HASH` in `.env` to that complete value, retaining the dollar signs, and choose `ADMIN_USERNAME`. The example uses isolated local development storage and distinct `.localhost` hosts.

```sh
pnpm dev
```

Open `http://app.agent-pages.localhost:3000` and sign in. The dashboard lets you create a private site from selected files or a folder, publish files to an existing site and delete individual files. Create a labeled API key for each agent client, then follow the [agent setup guide](docs/agent-setup.md) to install the skill and connect through MCP or REST. The web interface also lists sites, opens private content and manages expiration, visibility and keys.

Production requires HTTPS, an application hostname and a wildcard on one delegated content subdomain such as `sites.example.com`; the rest of a shared domain stays untouched, and the wildcard certificate needs the DNS-01 challenge. See [development and validation](docs/development.md) and [container, proxy and backup operations](docs/operations.md). Production data belongs on one local persistent volume with one application process.

## Owner workspace

The owner area includes an Overview of live sites, content totals and upcoming expirations. In Sites, select a file to open its dedicated editor screen and inspect its source or preview a raster image, download it, and edit supported UTF-8 text with CodeMirror 6. HTML and SVG are shown as source; pages open on their isolated site origin.

Saving publishes immediately at the existing URL and preserves visibility. Drafts and undo history stay in memory while switching files; leaving warns before discarding unsaved edits. Conflicting agent updates require review. After session expiry, sign in in another tab and retry. Editing is limited to 256 KiB per file or a lower configured transport/file bound; binary, oversized and non-UTF-8 files remain downloadable. Up to 20 documents are retained in memory; drafts do not survive closing the tab. Overview content size counts live revisions, not physical disk usage.

## Export and delete a site

In site detail, choose **Export ZIP** to download the active revision, including nested pages and binary assets. The same download is available through `GET /api/sites/:siteId/export` with your bearer API key; browser sessions use the dedicated dashboard route. Export requires owner authentication even for public sites.

The archive is named `site-<siteId>.zip`, with `index.html` at its root and all original relative file paths. It contains site content only, not account settings, credentials or revision history, and does not change visibility or expiration. ZIP entries are stored without compression to keep server CPU predictable. This is a portable content copy; use the [cold backup procedure](docs/operations.md) to restore an entire installation.

Downloads retain one revision across concurrent updates. Deleted or expired sites cannot start an export; lifecycle changes can interrupt an in-progress archive. Retry a failed download from the beginning. Exports stream without a temporary archive, have a five-minute deadline, and share an installation-wide export limit equal to `MAX_CONCURRENT_MUTATIONS` (default 2), separate from mutation jobs.

To remove a site, choose **Delete site** in its dashboard detail and confirm **Delete permanently**. The site immediately disappears from the list and its URL stops serving content; deletion cannot be undone. Export a ZIP first if you need a copy. If an agent has changed the site, the dashboard reloads its current version and asks you to confirm again.

Agents can use `DELETE /api/sites/:siteId` with a bearer API key and a JSON body containing `operationId` (UUID) and `expectedVersion`, or call MCP `delete_site` with those fields plus `siteId`. Read the current version through `GET /api/sites/:siteId` or `get_site` first. Retry an uncertain result with the **same** operation ID and version. A successful result has `deleted: true`; `cleanupPending: true` means access is already disabled while disk cleanup runs in the background.

## Connect an agent

The application includes an MCP server at `https://app.example.com/mcp` and a bearer-authenticated REST API at `https://app.example.com/api`. Create a dedicated API key in the dashboard and supply it through the agent process environment as `AGENT_PAGES_API_KEY`.

```sh
npx skills add https://github.com/SebastianMihali/agent-pages.git
```

Follow [Agent setup](docs/agent-setup.md) to configure MCP or REST and copy a ready-to-use instruction for your agent. See [REST API](docs/api.md) for endpoints, payloads, uploads and retry rules. Keep credentials out of prompts and uploaded site files.

## Documentation

- [Installation, proxy and backup operations](docs/operations.md)
- [Agent and skill setup](docs/agent-setup.md)
- [REST API reference](docs/api.md)
- [Development, tests and release publishing](docs/development.md)
- [Architecture](docs/architecture.md) and [domain glossary](CONTEXT.md)
- [Agent Pages skill](skills/agent-pages/SKILL.md)

Agent Pages is released under the [MIT License](LICENSE).
