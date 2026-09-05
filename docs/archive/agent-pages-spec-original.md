> Historical draft, superseded on 2026-09-05. This file is preserved for reference only; implement the current [product direction](../../agent-pages-spec.md) and [MVP specification](../../.scratch/mvp/spec.md).

# Agent Pages — Product & Technical Specification

## 1. Project overview

**Agent Pages** is a small, self-hosted, open-source static hosting service designed primarily for AI coding agents.

The main use case is:

1. An AI agent generates a static website.
2. The agent publishes it through MCP or REST.
3. Agent Pages returns a public URL immediately.
4. The agent can later inspect, add, modify, or delete files in the same website.
5. Websites can contain multiple pages and static assets.
6. Everything is hosted from a single domain and a single application.

This is **not** intended to be:

- a SaaS;
- a Vercel/Netlify competitor;
- a multi-tenant commercial hosting platform;
- a container deployment platform;
- a serverless runtime;
- a general-purpose backend hosting service.

The project should stay small, maintainable, secure, and easy to self-host.

---

# 2. Core goals

The application must allow a user or AI agent to:

- create a static website;
- publish HTML, CSS, JavaScript, images, fonts, JSON and similar static files;
- create websites with multiple pages;
- add pages after the website has already been created;
- read existing files;
- modify existing files;
- delete individual files;
- list files;
- delete a complete website;
- optionally create temporary websites that automatically expire;
- interact through:
  - a web dashboard;
  - a REST API;
  - an MCP server;
- use local filesystem storage by default;
- optionally support S3-compatible storage later;
- run inside Docker;
- deploy cleanly on Coolify.

---

# 3. Technology stack

Use the following stack.

## Package manager

```text
pnpm
```

Do not use Bun as the package manager.

## Application framework

```text
TanStack Start
React
TanStack Router
TanStack Query
TypeScript
```

Do **not** introduce Hono, Express, Fastify or another HTTP framework unless absolutely necessary.

TanStack Start should handle:

- dashboard;
- REST server routes;
- server-side logic;
- MCP endpoint integration;
- static-site request interception/serving.

## UI

```text
Tailwind CSS
shadcn/ui
```

The dashboard should be minimal and functional rather than highly polished.

## Validation

```text
Zod
```

Use Zod schemas at public boundaries:

- REST API;
- MCP tools;
- environment variables where appropriate.

## Database

```text
SQLite
Drizzle ORM
```

SQLite should store metadata only.

Static website files should **not** be stored inside SQLite.

## MCP

Use the official Model Context Protocol TypeScript SDK.

The MCP implementation should expose tools from the same business logic used by the REST API.

Do not duplicate site-management logic inside MCP handlers.

## Deployment

```text
Docker
Coolify
```

---

# 4. Domain and routing model

There must be **one domain only**.

Example:

```text
https://pages.example.com
```

Do not use:

- wildcard DNS;
- one subdomain per website;
- separate domains for dashboard and hosted content.

The application should use URL paths to separate functionality.

## Dashboard

```text
https://pages.example.com/
```

Examples:

```text
https://pages.example.com/
https://pages.example.com/sites
https://pages.example.com/sites/:siteId
https://pages.example.com/settings
```

## REST API

```text
https://pages.example.com/api/*
```

## MCP

```text
https://pages.example.com/mcp
```

## Hosted websites

All user/agent-generated static websites must live under:

```text
https://pages.example.com/s/:slug/
```

Examples:

```text
https://pages.example.com/s/acme/
https://pages.example.com/s/portfolio/
https://pages.example.com/s/restaurant/
```

A multi-page website may therefore expose:

```text
https://pages.example.com/s/acme/
https://pages.example.com/s/acme/about/
https://pages.example.com/s/acme/pricing/
https://pages.example.com/s/acme/contact/
```

The `/s/` prefix is reserved exclusively for hosted static websites.

---

# 5. Important security implication of the single-domain design

The dashboard and generated websites share the same origin:

```text
pages.example.com
```

This is less isolated than using a separate domain.

Because generated websites may contain arbitrary client-side JavaScript, the application must compensate with stricter security controls.

Generated websites must never be able to access privileged application data.

## Required controls

### Dashboard authentication cookies

Authentication cookies used by the dashboard must:

- use `HttpOnly`;
- use `Secure`;
- use an appropriate `SameSite` policy;
- be scoped to application paths whenever practical;
- never expose secrets to JavaScript.

Prefer keeping sensitive dashboard state server-side.

### API authentication

REST and MCP must require an API key or authenticated session.

Do not rely on browser cookies for agent API authentication.

### Generated-site route isolation

Generated static websites under:

```text
/s/*
```

must never:

- execute server-side code;
- access internal files;
- access the SQLite database directly;
- receive application secrets;
- receive environment variables;
- have access to Docker;
- have access to the Coolify API;
- have access to SSH;
- have access to the host filesystem outside the dedicated storage path.

### CSP / security headers

Generated sites should be served with configurable security headers.

The V1 should implement a safe baseline without unnecessarily breaking normal static websites.

At minimum evaluate/use:

```text
X-Content-Type-Options: nosniff
Referrer-Policy
Permissions-Policy
Content-Security-Policy
```

Do not treat CSP as the primary trust boundary.

### Important design principle

All HTML/CSS/JS produced by an AI agent must be considered:

```text
UNTRUSTED CONTENT
```

The agent skill is guidance, not a security boundary.

---

# 6. Website model

A **Site** represents a virtual static filesystem.

A site is not limited to one HTML page.

Example:

```text
acme/
├── index.html
├── about/
│   └── index.html
├── pricing/
│   └── index.html
├── contact/
│   └── index.html
└── assets/
    ├── style.css
    ├── app.js
    ├── logo.svg
    └── hero.webp
```

Public URLs:

```text
index.html
→ /s/acme/

about/index.html
→ /s/acme/about/

pricing/index.html
→ /s/acme/pricing/

contact/index.html
→ /s/acme/contact/

assets/style.css
→ /s/acme/assets/style.css
```

---

# 7. Base-path rule

Because sites are hosted underneath:

```text
/s/:slug/
```

generated websites must be **base-path aware**.

## Preferred URLs inside generated HTML

Use relative URLs.

Good:

```html
<a href="about/">About</a>
<link rel="stylesheet" href="assets/style.css">
<script src="assets/app.js"></script>
```

From nested pages use suitable relative paths:

```html
<a href="../contact/">Contact</a>
```

## Avoid root-relative paths

Do not generate:

```html
<a href="/about/">About</a>
<link rel="stylesheet" href="/assets/style.css">
```

because `/` refers to:

```text
https://pages.example.com/
```

rather than:

```text
https://pages.example.com/s/acme/
```

The Agent Pages skill must explicitly teach agents this rule.

## `<base>` support

The application may optionally inject or recommend:

```html
<base href="/s/acme/">
```

but the system should not rely on automatic HTML rewriting as the primary solution.

V1 should prefer explicit relative paths.

---

# 8. Static route resolution

For a request such as:

```text
GET /s/acme/about/
```

resolve the site:

```text
slug = acme
```

and requested virtual path:

```text
about/
```

Then look for:

```text
about/index.html
```

Suggested resolution rules:

## Root

```text
GET /s/acme/
→ index.html
```

## Directory-style route

```text
GET /s/acme/about/
→ about/index.html
```

## Extension-less request

For:

```text
GET /s/acme/about
```

try, in order:

```text
about
about.html
about/index.html
```

If a canonical redirect is desirable, redirect to:

```text
/s/acme/about/
```

when `about/index.html` exists.

## Exact asset

```text
GET /s/acme/assets/style.css
→ assets/style.css
```

## 404

If no file exists:

1. serve site-level `404.html` if present;
2. otherwise return the generic Agent Pages 404.

---

# 9. Static site types

Support at least two site modes.

## Static

```text
type = static
```

Normal filesystem routing.

Example:

```text
/about/
→ about/index.html
```

Unknown paths return 404.

## SPA

```text
type = spa
```

For SPA sites:

1. try to find the requested file normally;
2. if no matching static file exists;
3. return the site's `index.html`.

This allows hosting static builds from:

- Vite + React;
- Vue;
- Svelte;
- Solid;
- other client-side SPA frameworks.

However, SPA builds must still be configured for the correct base path:

```text
/s/:slug/
```

Agent Pages should not attempt complex automatic JavaScript bundle rewriting in V1.

---

# 10. Supported files

At minimum support static files such as:

```text
.html
.htm
.css
.js
.mjs
.json

.png
.jpg
.jpeg
.webp
.avif
.gif
.svg
.ico

.woff
.woff2

.txt
.xml
.webmanifest
.map
```

Binary uploads must be supported through the dashboard/REST API where appropriate.

Do not execute server-side code.

Files such as:

```text
.php
.py
.rb
.sh
.exe
```

must never be executed.

The simplest V1 policy is to reject obviously executable/server-side extensions.

---

# 11. Storage architecture

Business logic must depend on a storage abstraction.

Example conceptual interface:

```ts
interface StorageProvider {
  readFile(siteId: string, path: string): Promise<StoredFile | null>

  writeFile(
    siteId: string,
    path: string,
    data: Uint8Array,
    contentType?: string,
  ): Promise<void>

  deleteFile(siteId: string, path: string): Promise<void>

  fileExists(siteId: string, path: string): Promise<boolean>

  listFiles(siteId: string): Promise<StoredFileInfo[]>

  deleteSite(siteId: string): Promise<void>
}
```

## V1 provider

```text
LocalStorageProvider
```

Use a persistent directory such as:

```text
/data/sites
```

Example:

```text
/data/
├── database.sqlite
└── sites/
    ├── <site-id-1>/
    │   ├── index.html
    │   ├── about/
    │   │   └── index.html
    │   └── assets/
    │       └── style.css
    └── <site-id-2>/
        └── index.html
```

## Future provider

Add:

```text
S3StorageProvider
```

using the same interface.

It should be compatible with generic S3-compatible storage, including potentially:

- AWS S3;
- Cloudflare R2;
- MinIO;
- Backblaze B2;
- Wasabi.

S3 support is useful but must not block the V1.

---

# 12. Coolify deployment

The application should be deployable as one Docker resource.

Use a persistent volume:

```text
/data
```

Suggested environment configuration:

```env
APP_URL=https://pages.example.com

STORAGE_PROVIDER=local
STORAGE_PATH=/data/sites

DATABASE_URL=/data/database.sqlite

ADMIN_USERNAME=admin
ADMIN_PASSWORD=<secure-password>

MAX_SITE_SIZE_MB=50
MAX_FILE_SIZE_MB=20
MAX_FILES_PER_SITE=500
```

Only one public domain needs to be configured:

```text
pages.example.com
```

No wildcard DNS.

No per-site proxy configuration.

No per-site Coolify application.

All generated sites are served by the same application.

---

# 13. Database

Use SQLite + Drizzle.

The database stores metadata, not website content.

## Suggested `sites` table

Fields:

```text
id
name
slug
type
created_at
updated_at
expires_at
size
file_count
```

Possible TypeScript model:

```ts
type Site = {
  id: string
  name: string
  slug: string
  type: 'static' | 'spa'

  createdAt: Date
  updatedAt: Date

  expiresAt: Date | null

  size: number
  fileCount: number
}
```

`slug` must be unique.

Use the site ID internally for storage paths where practical.

Example:

```text
URL slug:
acme

Storage:
sites/019c.../
```

This allows changing a slug later without moving the entire storage directory.

---

# 14. Site slugs

Slugs should:

- be unique;
- be lowercase;
- use URL-safe characters;
- avoid reserved words;
- have a reasonable maximum length.

Reserved slugs should include at least:

```text
api
mcp
sites
settings
login
logout
s
assets
admin
```

Actual public websites are always under `/s/`, but reserved words should still be handled carefully.

Example:

```text
Acme Website
→ acme-website
```

If already used:

```text
acme-website-2
```

or return a conflict and allow the caller to choose.

---

# 15. REST API

REST routes should use the same core services as MCP and the dashboard.

Do not put business logic directly in route handlers.

## Sites

### Create site

```text
POST /api/sites
```

Example:

```json
{
  "name": "Acme Website",
  "slug": "acme",
  "type": "static",
  "expiresIn": null
}
```

Response:

```json
{
  "id": "019c...",
  "name": "Acme Website",
  "slug": "acme",
  "url": "https://pages.example.com/s/acme/"
}
```

### List sites

```text
GET /api/sites
```

### Get site

```text
GET /api/sites/:siteId
```

### Delete site

```text
DELETE /api/sites/:siteId
```

---

# 16. REST file API

Support reading and changing the site's virtual filesystem.

## List files

```text
GET /api/sites/:siteId/files
```

## Read file

Possible route:

```text
GET /api/sites/:siteId/files/*
```

## Write files in batches

Preferred:

```text
PUT /api/sites/:siteId/files
```

Example:

```json
{
  "files": [
    {
      "path": "index.html",
      "content": "<!doctype html>..."
    },
    {
      "path": "about/index.html",
      "content": "<!doctype html>..."
    },
    {
      "path": "assets/style.css",
      "content": "body { ... }"
    }
  ]
}
```

Batch writes are especially important for AI agents.

## Delete files

```text
DELETE /api/sites/:siteId/files
```

Example:

```json
{
  "paths": [
    "old-page/index.html",
    "assets/old.css"
  ]
}
```

For binary assets, support multipart upload or an explicit encoding format as needed.

Do not force large binary content through JSON strings.

---

# 17. MCP server

Expose MCP at:

```text
POST/GET /mcp
```

using the official TypeScript MCP SDK integrated into TanStack Start.

The MCP layer must call shared services.

Architecture:

```text
Dashboard ─────┐
               │
REST API ──────┼──> SiteService / FileService ──> StorageProvider
               │
MCP ───────────┘
```

Do not create a second implementation of site operations specifically for MCP.

---

# 18. MCP V1 tools

Expose the following tools.

## `create_site`

Create a site, optionally with initial files.

Suggested input:

```json
{
  "name": "Restaurant Mario",
  "slug": "restaurant-mario",
  "type": "static",
  "expiresIn": null,
  "files": [
    {
      "path": "index.html",
      "content": "..."
    },
    {
      "path": "menu/index.html",
      "content": "..."
    }
  ]
}
```

Suggested output:

```json
{
  "id": "...",
  "url": "https://pages.example.com/s/restaurant-mario/"
}
```

---

## `list_sites`

Return existing sites with metadata and URL.

---

## `get_site`

Return information about one site.

Suggested response includes:

```text
id
name
slug
type
url
createdAt
updatedAt
expiresAt
size
fileCount
```

---

## `list_files`

Input:

```json
{
  "siteId": "..."
}
```

Output:

```json
{
  "files": [
    "index.html",
    "about/index.html",
    "assets/style.css",
    "assets/app.js"
  ]
}
```

---

## `read_file`

Input:

```json
{
  "siteId": "...",
  "path": "index.html"
}
```

Returns file content for textual files.

For binary files return metadata rather than dumping arbitrary binary content into the agent context unless explicitly needed.

---

## `write_files`

This is one of the most important MCP tools.

It must support batch updates.

Input:

```json
{
  "siteId": "...",
  "files": [
    {
      "path": "about/index.html",
      "content": "..."
    },
    {
      "path": "assets/style.css",
      "content": "..."
    }
  ]
}
```

Behavior:

- create new files when they do not exist;
- overwrite files when they already exist;
- create missing directories automatically;
- validate all paths before writing.

---

## `delete_files`

Input:

```json
{
  "siteId": "...",
  "paths": [
    "old/index.html",
    "assets/unused.css"
  ]
}
```

---

## `delete_site`

Deletes the site's metadata and all stored content.

Mark this MCP tool as destructive.

---

# 19. Typical agent workflow

User:

```text
Create a website for Restaurant Mario with:
- home
- about
- menu
- contact

Publish it when finished.
```

Agent:

1. generates:
   - `index.html`
   - `about/index.html`
   - `menu/index.html`
   - `contact/index.html`
   - `assets/style.css`
   - `assets/app.js`
2. calls `create_site`;
3. receives:

```text
https://pages.example.com/s/restaurant-mario/
```

Later the user says:

```text
Add a reservations page.
```

Agent:

1. calls `get_site`;
2. calls `list_files`;
3. reads relevant files:
   - `index.html`
   - `assets/style.css`
4. calls `write_files` with:

```text
reservations/index.html
```

The new page becomes:

```text
https://pages.example.com/s/restaurant-mario/reservations/
```

Later:

```text
Change the primary button color.
```

Agent:

1. calls `read_file("assets/style.css")`;
2. modifies only the necessary CSS;
3. calls `write_files`.

The same website is updated in place.

---

# 20. Agent skill

The repository should include an agent skill.

Suggested location:

```text
skills/
└── agent-pages/
    └── SKILL.md
```

The skill should teach agents how to create compatible websites.

It must include rules similar to the following.

## Website generation rules

When building a site for Agent Pages:

- generate static output only;
- use HTML, CSS and client-side JavaScript;
- use relative URLs;
- use directory-style pages;
- prefer shared assets;
- do not include secrets;
- do not embed private API keys;
- do not create server-side executable code;
- do not assume the site runs at `/`;
- remember that every site runs under `/s/:slug/`.

Good:

```text
index.html
about/index.html
contact/index.html
assets/style.css
```

Avoid:

```text
about.html
```

when a directory-style page is more appropriate.

## URL rules

Good:

```html
<a href="about/">About</a>
<script src="assets/app.js"></script>
```

Bad:

```html
<a href="/about/">About</a>
<script src="/assets/app.js"></script>
```

## Update behavior

When modifying an existing site:

1. use `get_site`;
2. use `list_files`;
3. read only relevant files;
4. use `write_files`;
5. do not create a completely new site unless requested.

---

# 21. Dashboard

Use TanStack Start + shadcn/ui.

Keep the dashboard intentionally small.

## Main page

Example:

```text
Agent Pages

Sites                                      + New site

┌──────────────────────────────────────────────┐
│ Acme                                         │
│ /s/acme/                                     │
│                                              │
│ 14 files · 487 KB · updated 2 min ago       │
│                                Open     •••  │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Portfolio                                    │
│ /s/portfolio/                                │
│                                              │
│ 8 files · 1.2 MB · updated yesterday        │
│                                Open     •••  │
└──────────────────────────────────────────────┘
```

Actions:

- create site;
- open site;
- view site details;
- delete site;
- see expiration status.

---

# 22. Site detail page

Example:

```text
Acme Website

https://pages.example.com/s/acme/

[Open Site]

Type: Static
Created: ...
Updated: ...
Expires: Never
Size: ...
Files: ...


Files
─────────────────────────────

index.html
about/
  index.html
pricing/
  index.html
assets/
  style.css
  app.js
  logo.svg
```

Useful actions:

- upload file;
- upload multiple files;
- upload ZIP;
- delete file;
- download file;
- refresh;
- delete site.

A full online code editor is **not required for V1**.

---

# 23. Manual site creation

Dashboard form:

```text
Create Site

Name
[               ]

Slug
[               ]

Type
● Static
○ SPA

Expiration
● Never
○ 24 hours
○ 7 days
○ Custom

[Create]
```

After creation allow:

- file upload;
- ZIP upload;
- drag and drop.

---

# 24. ZIP uploads

The dashboard should support uploading a static website ZIP.

Example ZIP:

```text
index.html
about/
  index.html
assets/
  style.css
```

Extract it into the site's virtual filesystem.

Security requirements for ZIP extraction:

- prevent Zip Slip/path traversal;
- reject absolute paths;
- reject `..`;
- enforce site size limit;
- enforce per-file size limit;
- enforce maximum file count;
- do not follow/create dangerous symlinks.

If a ZIP contains root-relative URLs such as:

```text
/assets/app.js
```

the application does not need to rewrite the bundle automatically in V1.

The UI may warn that sites built for `/` may not work correctly under `/s/:slug/`.

---

# 25. Authentication

This is a self-hosted, single-admin application.

Do not build:

- registration;
- user accounts;
- teams;
- organizations;
- OAuth login;
- billing.

## Dashboard authentication

Support one admin account.

Environment variables are acceptable for V1:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<password>
```

Store an authenticated session securely.

Passwords must never be stored in plaintext in SQLite.

---

# 26. API keys

REST and MCP should use API keys.

Example:

```text
agp_xxxxxxxxxxxxxxxxx
```

Preferred future-friendly model:

- API keys are generated in the dashboard;
- only a hash of the key is stored in SQLite;
- the complete key is shown once;
- keys can be revoked;
- optionally record:
  - created time;
  - last used time;
  - label.

Example dashboard:

```text
API Keys

Codex
Created: Aug 24
Last used: 3 minutes ago
[Revoke]

Claude
Created: Aug 20
Last used: yesterday
[Revoke]

[Create API Key]
```

For V1 all API keys may have the same permissions.

Scoped permissions can be added later if useful.

---

# 27. Security requirements

Security must be implemented in code.

Do not rely solely on the agent skill.

## Path traversal

Never allow:

```text
../
../../
/absolute/path
```

All paths must be normalized and guaranteed to remain below the site's storage root.

Example malicious input:

```text
../../../../etc/passwd
```

must be rejected.

## Symlinks

Avoid accepting or following user-controlled symlinks.

## Null bytes

Reject null bytes and malformed paths.

## File limits

Make limits configurable.

Suggested defaults:

```env
MAX_SITE_SIZE_MB=50
MAX_FILE_SIZE_MB=20
MAX_FILES_PER_SITE=500
```

## API rate limiting

Protect write operations.

Suggested starting point:

```text
10–30 writes per minute per API key
```

Keep it configurable.

## Container

Run the Docker container as a non-root user.

Do not mount:

```text
/var/run/docker.sock
```

Do not expose:

- SSH;
- Coolify credentials;
- host root filesystem;
- unrelated directories.

Only mount:

```text
/data
```

for persistent application data.

## No server-side execution

A published site is always static content.

Uploaded code is returned to browsers as files.

It is never run by the Agent Pages server.

---

# 28. TTL / temporary sites

TTL is part of V1.

A site may have:

```text
expiresAt = null
```

for permanent sites.

Or:

```text
expiresAt = <timestamp>
```

for temporary sites.

Examples:

```text
1 hour
24 hours
7 days
custom
```

Agent/MCP input may use:

```json
{
  "expiresIn": "24h"
}
```

A scheduled cleanup job should:

1. find expired sites;
2. delete stored site files;
3. remove database metadata.

This is particularly useful for AI-generated previews and tests.

---

# 29. Features explicitly NOT required for V1

Do not implement these unless requested later.

```text
❌ SaaS billing
❌ Stripe
❌ multiple users
❌ teams
❌ organizations
❌ subscriptions
❌ custom domains per site
❌ wildcard DNS
❌ per-site subdomains
❌ analytics
❌ advanced monitoring
❌ automatic screenshots
❌ review workflows
❌ client approvals
❌ comments
❌ version history
❌ immutable deployments
❌ rollback
❌ GitHub Actions integration
❌ VS Code extension
❌ n8n integration
❌ OAuth MCP
❌ serverless functions
❌ SSR for uploaded applications
❌ databases for uploaded sites
❌ Docker deployment per site
❌ shell execution
```

Keep scope intentionally small.

---

# 30. Optional future features

The architecture should not make these impossible, but do not build them prematurely.

Possible future additions:

- S3/R2 storage;
- site snapshots/versioning;
- rollback;
- password-protected sites;
- API-key scopes;
- better SPA base-path tooling;
- import/export;
- site cloning;
- automatic HTML compatibility checks;
- static asset compression;
- cache headers;
- site-specific headers;
- basic traffic statistics;
- CLI;
- SDK;
- public Docker image;
- installation wizard.

---

# 31. Suggested internal architecture

Keep framework code thin.

Suggested modules:

```text
src/
├── routes/
│   ├── __root.tsx
│   ├── index.tsx
│   ├── login.tsx
│   │
│   ├── sites/
│   │   ├── index.tsx
│   │   └── $siteId.tsx
│   │
│   ├── api/
│   │   └── ...
│   │
│   └── mcp.ts
│
├── components/
│   └── ui/
│
├── lib/
│   ├── db/
│   │   ├── client.ts
│   │   └── schema.ts
│   │
│   ├── sites/
│   │   ├── site.service.ts
│   │   └── site.schemas.ts
│   │
│   ├── files/
│   │   ├── file.service.ts
│   │   └── file.schemas.ts
│   │
│   ├── storage/
│   │   ├── storage-provider.ts
│   │   └── local-storage.ts
│   │
│   ├── auth/
│   │   ├── session.ts
│   │   └── api-keys.ts
│   │
│   ├── security/
│   │   ├── paths.ts
│   │   ├── limits.ts
│   │   └── mime.ts
│   │
│   └── mcp/
│       ├── server.ts
│       └── tools/
│           ├── create-site.ts
│           ├── list-sites.ts
│           ├── get-site.ts
│           ├── list-files.ts
│           ├── read-file.ts
│           ├── write-files.ts
│           ├── delete-files.ts
│           └── delete-site.ts
│
├── server.ts
└── styles.css

skills/
└── agent-pages/
    └── SKILL.md

drizzle/
Dockerfile
docker-compose.yml
.env.example
package.json
pnpm-lock.yaml
README.md
```

Do not create a monorepo unless the project actually grows enough to need one.

A single pnpm package is preferred for V1.

---

# 32. Service layer

Create shared services.

Example:

```text
SiteService
FileService
StorageProvider
AuthService
```

Routes and MCP tools should be adapters only.

Bad:

```text
MCP tool
→ writes filesystem directly
```

Good:

```text
MCP tool
→ FileService.writeFiles()
→ StorageProvider
```

Same for REST:

```text
REST handler
→ FileService.writeFiles()
→ StorageProvider
```

And dashboard/server functions:

```text
Dashboard
→ SiteService
```

This is important for maintainability and testing.

---

# 33. Static site serving architecture

TanStack Start should intercept requests matching:

```text
/s/*
```

before normal dashboard routing where appropriate.

Conceptual flow:

```text
Request
  │
  ├─ /api/*
  │     → REST API
  │
  ├─ /mcp
  │     → MCP handler
  │
  ├─ /s/:slug/*
  │     → static site serving layer
  │
  └─ everything else
        → TanStack Start dashboard/router
```

Static site serving should:

1. parse slug;
2. find site metadata;
3. validate the site exists and has not expired;
4. resolve requested virtual file path;
5. read from `StorageProvider`;
6. detect/assign MIME type;
7. return file;
8. attach static-site security/cache headers.

---

# 34. MIME handling

Return correct `Content-Type` values.

Examples:

```text
.html       text/html
.css        text/css
.js         text/javascript
.json       application/json
.svg        image/svg+xml
.png        image/png
.webp       image/webp
.woff2      font/woff2
```

Use a reliable MIME library instead of maintaining an incomplete manual table.

Use:

```text
X-Content-Type-Options: nosniff
```

---

# 35. Caching

For V1 keep caching conservative.

Possible policy:

HTML:

```text
Cache-Control: no-cache
```

or low TTL.

Assets:

```text
Cache-Control: public, max-age=...
```

However, because files may be overwritten in place by `write_files`, avoid aggressive immutable caching unless file versioning/content hashing is introduced later.

Correctness is more important than maximal caching in V1.

---

# 36. Expired sites

When a site is expired:

```text
GET /s/:slug/*
```

should return either:

```text
404 Not Found
```

or a small generic page such as:

```text
This site has expired.
```

Do not expose private metadata.

Cleanup should eventually remove the files.

---

# 37. Logging

Log at least:

```text
site created
site deleted
files written
files deleted
API key created/revoked
authentication failures
storage errors
MCP tool errors
cleanup errors
```

Do not log:

- API key secrets;
- admin passwords;
- full sensitive headers;
- unnecessarily large HTML contents.

---

# 38. Tests

Prioritize tests for security-sensitive and core behavior.

Required high-value tests:

## Path validation

Test rejection of:

```text
../foo
../../etc/passwd
/absolute/path
foo/../../../bar
null-byte paths
```

## Routing

Test:

```text
/s/acme/
/s/acme/about/
/s/acme/about
/s/acme/assets/style.css
```

## Multi-page behavior

Create a site, add another page later, confirm it is served.

## File mutation

Test:

- create;
- overwrite;
- delete;
- list.

## Site deletion

Confirm all files and metadata are deleted.

## TTL

Confirm expired sites are unavailable and cleaned.

## Authentication

Confirm REST/MCP writes require a valid API key.

## Size limits

Confirm oversized sites/files are rejected.

---

# 39. Docker requirements

Create a production Dockerfile.

Requirements:

- pnpm-based install/build;
- minimal final image;
- non-root runtime user;
- persistent `/data` directory;
- health endpoint;
- production environment;
- no unnecessary build tooling in final image when avoidable.

Expose one application port.

Example:

```text
3000
```

Coolify will handle reverse proxy and HTTPS.

---

# 40. Health check

Provide:

```text
GET /api/health
```

Response:

```json
{
  "status": "ok"
}
```

Optionally verify:

- DB reachable;
- storage writable.

Avoid exposing internal secrets or filesystem paths.

---

# 41. README expectations

The open-source README should explain the product simply.

Suggested positioning:

> **Agent Pages**
>
> A tiny self-hosted static hosting service for AI coding agents.
>
> Publish HTML/CSS/JS instantly through MCP or REST and get a public URL.

Feature list:

```text
✓ MCP
✓ REST API
✓ Multi-page websites
✓ HTML/CSS/JS and static assets
✓ Persistent sites
✓ Temporary previews
✓ File-level updates
✓ Dashboard
✓ Local storage
✓ Docker
✓ Coolify-friendly
✓ Open source
```

Include examples for:

- Docker;
- Docker Compose;
- Coolify;
- MCP client configuration;
- REST API;
- creating a site;
- updating an existing site.

---

# 42. Product philosophy

When making implementation decisions, prefer:

```text
simple
self-hosted
agent-friendly
predictable
secure by default
easy to understand
easy to deploy
```

over:

```text
enterprise complexity
premature abstraction
SaaS features
heavy infrastructure
magic rewriting
extra services
multiple containers
```

The main success criterion is:

> An AI coding agent should be able to create or update a static website and receive a working public URL with one or very few tool calls.

---

# 43. V1 acceptance criteria

V1 is complete when all of the following work.

## Infrastructure

- [ ] `pnpm install`
- [ ] application builds successfully
- [ ] Docker image builds
- [ ] Docker container runs
- [ ] `/data` can be mounted persistently
- [ ] works behind Coolify reverse proxy

## Dashboard

- [ ] admin login
- [ ] site list
- [ ] create site
- [ ] site details
- [ ] file list
- [ ] file upload
- [ ] ZIP upload
- [ ] delete site
- [ ] API key management

## Static hosting

- [ ] `/s/:slug/`
- [ ] multiple pages
- [ ] nested folders
- [ ] CSS
- [ ] JS
- [ ] images
- [ ] fonts
- [ ] site-level `404.html`
- [ ] SPA fallback mode

## REST

- [ ] create site
- [ ] list sites
- [ ] get site
- [ ] delete site
- [ ] list files
- [ ] read file
- [ ] batch write files
- [ ] delete files

## MCP

- [ ] create_site
- [ ] list_sites
- [ ] get_site
- [ ] list_files
- [ ] read_file
- [ ] write_files
- [ ] delete_files
- [ ] delete_site

## Security

- [ ] API-key authentication
- [ ] secure admin session
- [ ] path traversal protection
- [ ] symlink protection
- [ ] file count limit
- [ ] file size limit
- [ ] site size limit
- [ ] rate limiting
- [ ] non-root Docker user
- [ ] no uploaded server-side execution

## TTL

- [ ] permanent site
- [ ] temporary site
- [ ] expired site no longer publicly accessible
- [ ] scheduled cleanup

## Agent integration

- [ ] `skills/agent-pages/SKILL.md`
- [ ] skill explains relative path requirement
- [ ] skill tells agents to update existing sites instead of recreating them
- [ ] MCP usage documented

---

# 44. Final architectural summary

```text
                         pages.example.com
                                  │
                                  ▼
                             Coolify HTTPS
                                  │
                                  ▼
                    ┌────────────────────────┐
                    │     TanStack Start     │
                    │                        │
                    │ React + shadcn         │
                    │ Dashboard              │
                    │                        │
                    │ REST /api/*            │
                    │ MCP  /mcp              │
                    │ Sites /s/:slug/*       │
                    └───────────┬────────────┘
                                │
                ┌───────────────┼────────────────┐
                │               │                │
                ▼               ▼                ▼
           SiteService     FileService       Auth
                │               │
                └───────┬───────┘
                        ▼
                 StorageProvider
                        │
               ┌────────┴────────┐
               │                 │
               ▼                 ▼
      Local filesystem      S3-compatible
            V1                  later

                        +
                     SQLite
                    metadata
```

Public site examples:

```text
pages.example.com/s/acme/
pages.example.com/s/acme/about/
pages.example.com/s/acme/contact/

pages.example.com/s/portfolio/
pages.example.com/s/portfolio/projects/
```

Application/dashboard examples:

```text
pages.example.com/
pages.example.com/sites
pages.example.com/sites/:siteId
pages.example.com/settings
pages.example.com/mcp
pages.example.com/api/sites
```

No wildcard DNS.

No site subdomains.

No second domain.

No SaaS infrastructure.

One application.

One container.

One domain.

One persistent volume.

One small open-source project.
