# CI and release pipeline

Status: ready-for-human
Progress: in-progress
Blocked by: —

## Objective

Run every verification on each change through GitHub Actions, publish release images to GHCR, add the MIT license and open the repository.

## Scope

Human steps: create the GitHub repository, push `main`, enable branch protection with required pull requests and required checks, and switch the repository to public after the license lands. No credentials or secrets are needed beyond the default `GITHUB_TOKEN` for GHCR.

Agent steps:

- `LICENSE` with the MIT text and the owner's name; reference it from `README.md`.
- A `ci` workflow on pushes and pull requests to `main`: pinned Node 24.16 and pnpm 11.5 via `packageManager`, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, then `pnpm exec playwright install --with-deps chromium firefox` and `pnpm test:browser`, then a `docker build` for `linux/amd64` without pushing. Upload Playwright traces on failure.
- A `release` workflow on `v*` semver tags: build with Buildx and QEMU for `linux/amd64` and `linux/arm64`, push to `ghcr.io/<owner>/agent-pages` with the version and `latest` tags, and record the image digest in the release.
- Cache pnpm and Docker layers; keep each job's permissions minimal (`contents: read`, `packages: write` only for release).

Do not add automatic deployment, secrets for Coolify or a changelog tool.

## Acceptance

- [ ] The `ci` workflow is green on a pull request and required on `main`.
- [ ] The Playwright job passes on the GitHub runner with the same certificate fixture used locally, or the fixture is adjusted and documented.
- [ ] A test tag publishes a multi-arch image; `docker run` of the arm64 and amd64 images passes the readiness smoke described in `docs/operations.md`.
- [ ] `LICENSE` exists, the README status and `docs/development.md` describe the pipeline (done 2026-09-06), and the repository is public (pending).

## Verification

2026-09-06: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `LICENSE`, README and `docs/development.md` written and YAML-validated locally. No GitHub repository or remote exists yet, so no workflow run, required-check configuration, published image or public switch has been verified. Remaining human steps: create the repository, push `main`, protect `main` with required pull requests and the `ci` checks, tag a release to exercise the image job, then make the repository public.

Link the successful workflow runs and the published image digest. Note any runner-specific limitation, for example browser versions differing from the local record.
