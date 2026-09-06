# English owner interface

Status: ready-for-agent
Progress: open
Blocked by: —

## Objective

Make every user-visible string in the owner web interface English, matching the server messages, documentation and skill, without adding an i18n layer.

## Scope

Italian strings live only in `src/components/ui/badge.tsx`, `src/components/owner/api.ts`, `src/components/owner/owner-app.tsx`, `src/components/owner/sites-section.tsx` and `src/components/owner/keys-section.tsx`. The browser tests `tests/browser/owner-workflow.spec.ts`, `tests/browser/site-access.spec.ts` and `tests/browser/support.ts` select elements by those labels and must be updated together.

Replace the strings in place with plain English. Keep existing accessibility attributes, form semantics and the explicit wording that making a site public lets anyone view it. Do not introduce a dictionary, translation library or locale detection. Do not change layout, behavior or server code.

## Acceptance

- [ ] No Italian string remains in `src/` (grep for accented characters and the known labels) and the HTML `lang` attribute is `en`.
- [ ] Browser-test selectors use the new labels; the suite passes on Chromium and Firefox.
- [ ] Copy for visibility, key display and errors is reviewed for tone by a taste-focused reviewer.

## Verification

Record `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:browser` results and the grep used to prove no Italian remains.
