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

A wildcard certificate can only be issued through the ACME DNS-01 challenge, because a single HTTP request cannot prove control of every possible subdomain the way it proves control of one host. Traefik's own reference documentation states this plainly: "wildcard certificates can only be generated through a DNS-01 challenge" ([Traefik, ACME certificate resolver reference, "Wildcard Domains"](https://doc.traefik.io/traefik/reference/install-configuration/tls/certificate-resolvers/acme/), v3.7 docs, accessed 2026-09-06). HTTP-01, the challenge Coolify's bundled proxy uses by default, cannot issue one.

DNS-01 means the proxy itself needs API credentials for your DNS provider, scoped to creating and deleting `TXT` records under `_acme-challenge.<zone>`. Store that credential like any other production secret: it can write DNS records, not just read them.

### Coolify configuration path (Cloudflare example)

The steps below are taken from current Coolify and Traefik documentation and have not been exercised on a real Coolify deployment for this project. Re-check them against the linked pages before relying on them, since both projects ship frequent releases.

1. **Create a Cloudflare API token**, not the legacy global API key. Lego, the ACME library Traefik uses, accepts one token scoped to `Zone / Zone / Read` and `Zone / DNS / Edit` on the zone, or two split tokens (`CF_ZONE_API_TOKEN` for zone lookup, `CF_DNS_API_TOKEN` for record edits) ([go-acme/lego, Cloudflare DNS provider](https://go-acme.github.io/lego/dns/cloudflare/), accessed 2026-09-06).

2. **Switch the Coolify proxy from HTTP-01 to DNS-01.** In Coolify, open `Servers → your server → Proxy` and edit the Traefik `docker-compose` there, adding the provider's environment variable and the `dnschallenge` command flags. Coolify's documented Cloudflare example is:

   ```yaml
   services:
     traefik:
       image: 'traefik:v3.6'
       environment:
         - CF_DNS_API_TOKEN=<Cloudflare API Token>
       command:
         - '--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare'
         - '--certificatesresolvers.letsencrypt.acme.dnschallenge.delaybeforecheck=0'
         - '--certificatesresolvers.letsencrypt.acme.storage=/traefik/acme.json'
   ```

   ([Coolify docs, "DNS Challenge"](https://coolify.io/docs/knowledge-base/proxy/traefik/dns-challenge), accessed 2026-09-06). Restart the proxy after saving. Coolify's own example leaves the existing `httpchallenge` command flags in place alongside the new `dnschallenge` ones; confirm on the live page whether the current Coolify release still expects that.

3. **Request the wildcard certificate.** Coolify documents adding labels to the proxy's own `traefik` service so it requests one certificate covering both the content zone and its wildcard:

   ```yaml
   labels:
     - traefik.http.routers.traefik.tls.certresolver=letsencrypt
     - traefik.http.routers.traefik.tls.domains[0].main=sites.example.com
     - traefik.http.routers.traefik.tls.domains[0].sans=*.sites.example.com
   ```

   ([Coolify docs, "Wildcard SSL Certificates"](https://coolify.io/docs/knowledge-base/proxy/traefik/wildcard-certs), accessed 2026-09-06). Once issued, Traefik reuses this certificate for any router whose TLS SNI falls under `*.sites.example.com`, with no separate ACME round trip per site hostname.

4. **Route the application host normally.** Set the Agent Pages application's Domain field in Coolify to `https://app.example.com`. This is Coolify's documented "Normal" case: one resource on one subdomain, reusing the now wildcard-capable resolver (same source as step 3).

5. **Route the wildcard content host to the same application.** Leave the Domain field limited to the app host and add custom Traefik labels so every `*.sites.example.com` request reaches the same container on port `3000`, following Coolify's documented pattern for routing every subdomain to one application:

   ```yaml
   labels:
     - traefik.http.routers.agent-pages-sites.rule=HostRegexp(`^.+\.sites\.example\.com$`)
     - traefik.http.routers.agent-pages-sites.entryPoints=https
     - traefik.http.routers.agent-pages-sites.tls.certresolver=letsencrypt
     - traefik.http.routers.agent-pages-sites.service=agent-pages-sites
     - traefik.http.services.agent-pages-sites.loadbalancer.server.port=3000
   ```

   (same source as step 3; label syntax shown is for Traefik v3). Add an equivalent HTTP-to-HTTPS redirect router if the proxy does not already force HTTPS globally.

6. Confirm `/health/ready` succeeds through both hostnames before enabling traffic, as described under [Container build and launch](#container-build-and-launch).

Steps 2 through 5 are documentation-derived, not verified against a live Coolify instance for this project; treat the exact flag and label names as a starting point.

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

The Compose service binds only to loopback, mounts the named `agent-pages-data` volume at `/data`, and allows 40 seconds for shutdown. Put the reverse proxy in front of it. Stop it without deleting the data volume:

```sh
docker compose down
```

In Coolify, create one application from the repository's `Dockerfile`, set container port `3000`, add persistent storage at `/data`, and configure the production variables as runtime variables. Set the application replica count to one. Route the exact `APP_ORIGIN` hostname and the wildcard `*.CONTENT_BASE_DOMAIN` hostname to that same application; both routes need HTTPS, while the container itself continues to listen over HTTP on the private network. Confirm `/health/ready` before enabling traffic. The image and host dispatch can be verified locally, but wildcard DNS, certificate issuance, and Coolify proxy behavior must be checked on the actual deployment.

When the proxy runs in a container network, connect it to port 3000 without publishing that port publicly. The image health check probes liveness. Configure deployment readiness against `/health/ready` on the internal host; readiness becomes successful only after the installation lock, migrations, storage recovery, and startup cleanup complete.

## Reverse proxy

Route both the exact application host and `*.CONTENT_BASE_DOMAIN` to the same container. Preserve the original external `Host`, replace rather than append trusted forwarded host/protocol fields, and prevent direct public access to port 3000. Reject unknown hosts at the proxy as well as in the application.

Terminate TLS at the proxy and force HTTPS. Disable proxy response caching for application and site responses. Do not rewrite site paths: uploaded content starts at `/` on its isolated hostname. Preserve request methods and bodies, including JSON bodies on `DELETE`, streamed multipart uploads, and POST requests to the reserved `/_agent/session` handoff. Set request limits no lower than the configured JSON and multipart limits, including multipart overhead.

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

## Recovery and capacity

Expiration denies reads by time comparison before physical cleanup. Explicit deletion and expiration first commit an inaccessible tombstone, then reclaim files asynchronously with retry. Failed cleanup can therefore continue to consume site-count and stored-byte quota.

At startup, Agent Pages removes abandoned staging, reconciles retired and orphaned revisions, resumes tombstones, and verifies active revision metadata. A missing or corrupt active revision fails readiness instead of publishing an empty site. Preserve the volume for diagnosis and restore a known-good cold backup; do not manually point metadata at another revision.

Expected outcomes such as conflicts, denials and limits are not logged. Storage failures and unexpected errors are written to stderr as one JSON line per event (`request_failed`, `tool_failed`, `content_request_failed`, `cleanup_failed`) with the error code, the request ID returned to the client where one exists, and the underlying cause's name, message and system error code. Clients never receive the cause. Use the request ID to correlate a client-reported failure with its log line.

Monitor filesystem free space as well as application quota errors. SQLite, logs, manifests, and filesystem allocation overhead consume space beyond accounted site bytes. `QUOTA_EXCEEDED` requires freeing capacity or changing coherent limits; `STORAGE_UNAVAILABLE` and `BUSY` should be retried with the same operation ID after the underlying condition clears.
