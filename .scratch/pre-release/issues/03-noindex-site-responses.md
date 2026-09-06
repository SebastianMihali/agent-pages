# No indexing of site responses

Status: ready-for-agent
Progress: done
Blocked by: —

## Objective

Keep hosted sites out of search engines: every response served on a content hostname carries `X-Robots-Tag: noindex, nofollow`.

## Scope

Add the header in the content handler (`src/server/content.ts`) for every response on a site host, including HTML, assets, HEAD, redirects, custom and generic 404 and denied responses. Uploaded files cannot override it. There is no per-site option.

Update the [MVP contract](../mvp/spec.md#hosts-and-http-security) header list and the [product direction](../../agent-pages-spec.md) positioning sentence, and mention the behavior in the skill so agents do not promise indexing.

## Acceptance

- [x] Content tests assert the header on page, asset, HEAD, redirect, 404 and denied responses.
- [x] Application-host responses are unaffected.
- [x] Contract, product direction and skill mention the behavior.

## Verification

2026-09-06: `x-robots-tag: noindex, nofollow` joins the shared security headers in `src/server/content.ts`, so every content-host response carries it. A focused test in `src/server/content.test.ts` covers private denial, denied HEAD, the owner-handoff redirect, public page, asset, HEAD, canonical redirect, custom 404 and an invalid path. `pnpm vitest run src/server/content.test.ts`, `pnpm typecheck` and `pnpm lint` passed; the full suite is run once at the end of the pre-release effort.
