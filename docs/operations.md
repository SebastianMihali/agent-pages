# Operations

Agent Pages runs as one application instance with one local persistent `/data` volume. SQLite metadata, revision trees, staging state, operation receipts, and credential hashes all live on that volume. Mount no Docker socket or unrelated host secrets.

## Production prerequisites

Prepare:

- an application origin such as `https://app.example.com`;
- a distinct content base domain such as `sites.example.com`;
- DNS and a wildcard certificate for `*.sites.example.com`;
- reverse-proxy routes for the exact application host and one-label content hosts;
- a persistent local filesystem mounted at `/data` and writable by container UID/GID `1000`;
- one strong operator-chosen password, stored only as the supported scrypt hash.

Run exactly one replica. Advisory locking makes a second process on the same local volume fail startup, but replication and network-mounted storage are outside the supported storage model.

## DNS and certificates

Agent Pages does not need a whole domain. It needs the application hostname plus one delegated subdomain for content; the rest of a domain shared with other projects is untouched.

Pick a content zone such as `sites.example.com`. `*.sites.example.com` only ever matches names under that one label; it does not create or affect any other record on `example.com`, including `www.example.com` or another project's subdomain on the same domain.

Exactly two DNS records point at the reverse proxy:

- the application host, `app.example.com`;
- the wildcard content host, `*.sites.example.com`.

A wildcard certificate can only be issued through the ACME DNS-01 challenge, because a single HTTP request cannot prove control of every possible subdomain the way it proves control of one host. Traefik's own reference documentation states this plainly: "wildcard certificates can only be generated through a DNS-01 challenge" ([Traefik, ACME certificate resolver reference, "Wildcard Domains"](https://doc.traefik.io/traefik/reference/install-configuration/tls/certificate-resolvers/acme/), v3.7 docs, accessed 2026-09-06). HTTP-01 cannot issue one.

DNS-01 means the proxy itself needs API credentials for your DNS provider, scoped to creating and deleting `TXT` records under `_acme-challenge.<zone>`. Store that credential like any other production secret: it can write DNS records, not just read them.

### Configure and verify the routes

Configure your reverse proxy to terminate HTTPS for the application hostname and the wildcard content hostname, forwarding both to the same application on port `3000`. Preserve any certificate resolvers used by other applications. Keep DNS credentials restricted to the required zone and persist certificate storage across proxy restarts.

For Traefik, use the [ACME certificate resolver reference](https://doc.traefik.io/traefik/reference/install-configuration/tls/certificate-resolvers/acme/) for DNS-01 configuration. Provider credentials and permissions depend on your DNS provider; the [Cloudflare provider reference](https://go-acme.github.io/lego/dns/cloudflare/) documents its token requirements.

Verify `/health/ready` on the application hostname. Then sign in, create a private site with an `index.html` file, and open it through the owner interface to check wildcard routing, TLS and the private-session handoff. Content hostnames serve site files, not application health endpoints. See [Reverse proxy](#reverse-proxy) for forwarding and request-limit requirements.

## Credentials and configuration

Generate the password hash from a checked-out release in an interactive terminal:

```sh
pnpm install --frozen-lockfile
pnpm admin:password-hash
```

Provide the printed value as `ADMIN_PASSWORD_HASH` through the deployment platform's secret configuration. Never place the password or hash in the image, source tree, command history, or a committed environment file.

Required production variables are:

```text
NODE_ENV=production
APP_ORIGIN=https://app.example.com
CONTENT_BASE_DOMAIN=sites.example.com
DATA_DIR=/data
ADMIN_USERNAME=owner
ADMIN_PASSWORD_HASH=<generated scrypt hash>
PORT=3000
```

`.env.example` lists all resource-limit settings and their defaults. Limit values whose names end in `_MB` use binary MiB. Keep `MAX_FILE_SIZE_MB <= MAX_SITE_SIZE_MB <= MAX_TOTAL_SITE_SIZE_MB <= MAX_STORED_SIZE_MB`, and keep `MAX_BATCH_FILES <= MAX_FILES_PER_SITE`. Leave at least `MIN_FREE_DISK_MB` available beyond admitted staging work.

Changing the configured username or password hash requires a restart. Startup preserves the stable owner and API keys while revoking browser sessions, private-site tickets, and grants.

## Container build and launch

Build from a clean checkout for the target architecture:

```sh
docker build --pull --tag agent-pages:local .
```

The final image runs as the unprivileged `node` account. For a direct Docker smoke test, place production values in an access-restricted environment file and use a named volume:

```sh
docker volume create agent-pages-data
docker run --detach \
  --name agent-pages \
  --restart unless-stopped \
  --env-file ./.env.production \
  --volume agent-pages-data:/data \
  --publish 127.0.0.1:3000:3000 \
  agent-pages:local
```

For Docker Compose, copy `.env.example` to `.env.production`, set production origins and a generated password hash, then restrict the file and start the checked-in service. Write the hash as an unquoted `ADMIN_PASSWORD_HASH=scrypt$...` value. The service reads this file with Compose's `env_file.format: raw`, so the dollar signs are preserved instead of treated as interpolation; this requires Docker Compose 2.30 or newer ([Compose `env_file` format reference](https://docs.docker.com/reference/compose-file/services/#format)).

```sh
chmod 600 .env.production
docker compose config --quiet
docker compose up --build --detach
docker compose ps
```

The Compose service binds only to loopback, mounts the named `agent-pages-data` volume at `/data`, and allows 130 seconds for shutdown, exceeding the browser upload deadline. Put the reverse proxy in front of it. Stop it without deleting the data volume:

```sh
docker compose down
```

On a container hosting platform, build from the repository's `Dockerfile`, set container port `3000`, mount persistent storage at `/data`, and provide the production environment variables at runtime. Run one replica. Route the exact `APP_ORIGIN` hostname and the wildcard `*.CONTENT_BASE_DOMAIN` hostname to that same application; both routes need HTTPS, while the container itself continues to listen over HTTP on the private network. Confirm `/health/ready` before enabling traffic. Verify wildcard DNS, certificates and routing for each installation; a local image test alone does not establish them.

When the proxy runs in a container network, connect it to port 3000 without publishing that port publicly. The image health check probes readiness using Node, so it does not depend on curl or wget in the runtime image. Configure deployment readiness against `/health/ready` on the internal host; readiness becomes successful only after the installation lock, migrations, storage recovery, and startup cleanup complete.

## Reverse proxy

Route both the exact application host and `*.CONTENT_BASE_DOMAIN` to the same container. Preserve the original external `Host`, replace rather than append trusted forwarded host/protocol fields, and prevent direct public access to port 3000. Reject unknown hosts at the proxy as well as in the application.

Terminate TLS at the proxy and force HTTPS. Disable proxy response caching for application and site responses. Do not rewrite site paths: uploaded content starts at `/` on its isolated hostname. Preserve request methods and bodies, including JSON bodies on `DELETE`, streamed multipart uploads, and POST requests to the reserved `/_agent/session` handoff. Set the proxy body limit above `MAX_MULTIPART_BODY_MB` so the configured payload plus multipart framing and headers can pass. Allow at least 120 seconds for `/web` multipart requests; `/api` keeps the application's 30-second body deadline.

The application hostname serves login, the owner interface, REST, and MCP. Content hostnames serve only the selected site's files and reserved private-session handoff. Never route uploaded content through the application origin.

## Health and shutdown

Use `/health/live` to determine whether the process is running and `/health/ready` to determine whether it may receive traffic. Health responses contain no paths, credentials, or site metadata.

On shutdown, stop routing new requests and send `SIGTERM`. The runtime stops periodic cleanup, cancels queued or stalled mutation streams, drains owned mutation work, closes SQLite, and releases the installation lock. Allow a termination grace period longer than the proxy's maximum upload/request duration; do not send `SIGKILL` during normal operation.

## Cold backup

The supported MVP backup is a cold copy of the entire data directory. A live file-by-file copy is not consistent across SQLite and revision publication.

For a named Docker volume:

1. Stop the application cleanly and confirm the container has exited.
2. Archive every entry in `/data`, including dotfiles, SQLite sidecars, manifests, staging state, and revision directories.
3. Restrict the archive like a credential secret because it contains private content and API-key hashes.
4. Restart the application after the archive command succeeds.

One example, run from an access-restricted backup directory, is:

```sh
docker stop agent-pages
docker run --rm \
  --volume agent-pages-data:/source:ro \
  --volume "$PWD":/backup \
  alpine:3.22 \
  tar -C /source -czf /backup/agent-pages-data.tgz .
docker start agent-pages
```

Record the application image/version, `APP_ORIGIN`, and `CONTENT_BASE_DOMAIN` with the backup. Do not record plaintext credentials.

## Restore verification

Restore into a fresh, empty volume; never overlay a running or partially populated installation:

```sh
docker volume create agent-pages-restore
docker run --rm \
  --volume agent-pages-restore:/restore \
  --volume "$PWD":/backup:ro \
  alpine:3.22 \
  tar -C /restore -xzf /backup/agent-pages-data.tgz
```

Start one container with the restored volume, the same configured origins, and the intended current owner credentials. Startup reconciliation must finish before readiness succeeds. Then verify all of the following:

1. A browser cookie from before the backup is rejected.
2. The owner can sign in and list the restored private site.
3. Anonymous GET and HEAD requests cannot read that site's HTML or an asset.
4. The owner can open the private site through the application handoff.
5. The active files and visibility match the source installation.
6. An update with the restored current version publishes a new revision at the same site URL.
7. A retained API key can authenticate unless it was revoked before backup.

Keep the source installation stopped or isolated while testing the restored copy. Two installations must not serve the same site hostnames simultaneously.

Keep a protected backup copy off the application server. Configure a backup schedule and retention policy appropriate to your recovery requirements, and periodically repeat restore verification in isolation.

## Recovery and capacity

Expiration denies reads by time comparison before physical cleanup. Explicit deletion and expiration first commit an inaccessible tombstone, then reclaim files asynchronously with retry. Failed cleanup can therefore continue to consume site-count and stored-byte quota.

At startup, Agent Pages removes abandoned staging, reconciles retired and orphaned revisions, resumes tombstones, and verifies active revision metadata. A missing or corrupt active revision fails readiness instead of publishing an empty site. Preserve the volume for diagnosis and restore a known-good cold backup; do not manually point metadata at another revision.

Expected outcomes such as conflicts, denials and limits are not logged. Storage failures and unexpected errors are written to stderr as one JSON line per event (`request_failed`, `tool_failed`, `content_request_failed`, `cleanup_failed`) with the error code, the request ID returned to the client where one exists, and the underlying cause's name, message and system error code. Clients never receive the cause. Use the request ID to correlate a client-reported failure with its log line.

Monitor filesystem free space as well as application quota errors. SQLite, logs, manifests, and filesystem allocation overhead consume space beyond accounted site bytes. `QUOTA_EXCEEDED` requires freeing capacity or changing coherent limits; `STORAGE_UNAVAILABLE` and `BUSY` should be retried with the same operation ID after the underlying condition clears.
