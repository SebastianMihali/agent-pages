# Development and release publishing

Agent Pages is one TypeScript package using Node.js, pnpm, TanStack Start, React and SQLite. Use the Node and pnpm versions pinned in [`package.json`](../package.json). Development and tests use isolated storage; production data belongs to the deployed installation.

## Development setup

From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm admin:password-hash
```

The helper reads a password without echo and prints its salted hash. Set `ADMIN_PASSWORD_HASH` and `ADMIN_USERNAME` in the ignored `.env` file, then run:

```sh
pnpm dev
```

Open `http://app.agent-pages.localhost:3000`. Content uses `<site-id>.sites.agent-pages.localhost:3000`. Development HTTP mode is rejected in production; browser security tests use a separate HTTPS fixture.

`better-sqlite3` and `fs-ext` contain native code. A clean install needs a supported prebuilt binary or Python, Make and a C++ compiler. The Docker build installs those tools and builds modules for its Linux architecture. Host `node_modules` must not be copied into the image.

## Verification

Run focused tests while changing behavior, then the full application checks:

```sh
pnpm check
pnpm exec playwright install --with-deps chromium firefox
pnpm test:browser
```

`pnpm check` runs lint, type checking, unit/integration tests and the production build. Storage and recovery tests use temporary SQLite databases and file trees; restart-sensitive tests use child processes.

Playwright builds the production bundle and manages its own HTTPS fixture. It needs `openssl` and resolution of `*.localhost` to loopback. The fixture generates temporary credentials, storage and a one-day certificate. Browser tests ignore trust errors only for this fixture. Use its managed server rather than starting a second server on the same ports.

`pnpm test:browser:dev` runs the separate development-mode regressions: the file editor under StrictMode, and site hosts serving their own styles, scripts and images instead of the Vite development server's. It is not included in CI. The optional `pnpm exec tsx scripts/mcp-client-smoke.ts both` verifies installed, authenticated Codex and Claude Code clients against isolated fixtures. It does not modify global client configuration.

`pnpm exec tsx scripts/benchmark-publication.ts` measures publication against isolated fixtures. Measurements depend on the machine and storage; record those conditions when comparing changes.

## Continuous integration

The [CI workflow](../.github/workflows/ci.yml) runs on pull requests and pushes to `main`: application checks, Chromium/Firefox acceptance and an amd64 Docker build. Failed browser runs upload traces for diagnosis. Configure required checks and pull-request protection in the repository hosting settings as needed.

The pinned Nitro integration uses `nitro/vite`. Changes to the framework, runtime or native dependencies should be verified through the production build and HTTPS browser suite, not only the development server.

## Publish a release

The [release workflow](../.github/workflows/release.yml) runs for tags matching `v*.*.*`. It builds `linux/amd64` and `linux/arm64` images with Buildx/QEMU, publishes to `ghcr.io/<repository-owner>/<repository-name>` and creates a GitHub release containing the image digest. Image tags include the version, `major.minor` and `latest`. The workflow derives the namespace from its repository; no personal account is hardcoded.

1. Host the source in the repository intended for publication. Enable Actions and allow the workflow's `GITHUB_TOKEN` to write repository contents and packages. Configure package visibility for the intended audience.
2. Run the application and browser checks and confirm CI succeeds for the release commit. Keep the package version consistent with the intended release.
3. Create and push the release tag, replacing `0.1.0` with the intended version:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. Confirm the workflow succeeds and records the image digest. Check that both target architectures boot with fresh isolated storage and reach readiness.
5. Take a cold backup before upgrading an existing installation, deploy the intended image and verify application login, private-site access, wildcard TLS and an authenticated update. Check folder drag-and-drop, upload cancellation, near-limit uploads and PDF rendering in supported browsers.

A successful build alone does not establish a working deployment or restore. Follow [operations](operations.md) for proxy configuration, lifecycle and backup verification. Configure backup scheduling, retention and an off-server destination for each installation.

## Repository hygiene

Use placeholder domains in documentation and the canonical repository URL from the README for source installation. Keep environment files, data, build outputs, temporary notes and local agent state out of version control and release artifacts. Use the configured Git identity for commit attribution. Public source, images and release metadata should be reviewed together before publication.
