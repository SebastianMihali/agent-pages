# Development

Agent Pages is one TypeScript package using Node.js 24.16, pnpm 11.5, TanStack Start, SQLite, and local revision files. Development and tests must use an isolated data directory; never point them at a production `/data` volume.

## Local setup

Install the pinned dependencies:

```sh
corepack enable
pnpm install --frozen-lockfile
```

Generate the required scrypt password hash in an interactive terminal. Input is not echoed and only the resulting hash is printed to stdout.

```sh
pnpm admin:password-hash
```

Copy `.env.example` to `.env`, replace its password-hash placeholder, and keep `.env` untracked. The development defaults use separate `.localhost` application and content hostnames over HTTP. This mode is rejected in production and does not establish the browser-security acceptance criteria, which use local HTTPS.

Start the application with:

```sh
pnpm dev
```

The application is then available at `http://app.agent-pages.localhost:3000`. Site origins use `<site-id>.sites.agent-pages.localhost:3000`.

## Verification

Use focused tests while changing behavior, then run the complete local checks:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Browser acceptance uses a generated one-day local certificate and the production cookie policy:

```sh
pnpm exec playwright install chromium firefox
pnpm test:browser
```

Playwright builds the production bundle and owns the HTTPS fixture process. The fixture creates temporary credentials/storage and removes them when stopped; do not start a second manual server on its ports. Browser tests ignore trust errors only for the generated local certificate.

Storage and recovery tests use actual temporary SQLite databases and file trees. They inject time and bounded filesystem failure points, and use child-process termination for restart-sensitive publication and installation-lock behavior. A synthetic second principal establishes owner isolation without adding account provisioning.

## Runtime and native dependencies

`better-sqlite3` and `fs-ext` contain native code. A clean install therefore needs a supported prebuilt binary or Python, Make, and a C++ compiler. The Docker build stage installs those tools and compiles the modules for its Linux architecture. Do not copy host `node_modules` into a container image.

The pinned Nitro 3 beta is a deliberate exception to the initial stable-dependency preference: the current TanStack integration requires `nitro/vite`. The production build, native dependency packaging and HTTPS browser tests cover this boundary. SQL persistence uses explicit statements and module-owned migrations as recorded in [ADR 0003](adr/0003-explicit-sqlite-persistence.md).

The application takes an advisory lock before opening SQLite. A second process using the same data directory fails startup. This is a single-instance safeguard; network filesystems and multiple replicas are unsupported.

## Publication measurement

Run `pnpm exec tsx scripts/benchmark-publication.ts` for isolated 64 KiB and 50 MiB fixtures. On Node 24.16.0/macOS arm64, the 2026-09-05 run measured create/update at 60/26 ms and 206/64 ms respectively. Maximum staged volume bytes were 349,464 and 105,076,643. Process peak RSS was 238,960 KiB, including the TypeScript runner and both fixtures; this is not a production steady-state memory measurement. These are single local measurements, not latency guarantees.

## Deployment verification inputs

End-to-end deployment verification additionally needs an application hostname, wildcard DNS/TLS for the content base domain, a reverse proxy or Coolify installation, and control of a persistent local volume. Prepare the container and proxy routes before collecting credentials. See [operations](operations.md).
