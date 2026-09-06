# Independent review of the pre-release changes

Fixed point: `cdddec4`. Reviewed commits: `f130461`, `f35834c`, `f93ad74`, `0c3bd16`, `721b925`. Two agents reviewed the diff independently on 2026-09-06, one against `AGENTS.md` plus the smell baseline and one against `.scratch/pre-release/spec.md` and its tickets.

## Standards

1. **High, single source of truth:** the `owner_settings` migration repeated the preset allowlist in a `CHECK` constraint next to `src/server/sites/expiration.ts`. Fixed: the constraint is gone; the module's allowlist is the only rule.
2. **Medium, fragile derived value:** creation replay reverse-engineered the original resolved lifetime from the stored receipt's timestamps. Fixed: the creation fingerprint records the requested form (`'default'`, `null` or a number), so an omitted expiration replays identically after a setting change and no receipt lookup or in-transaction fingerprint is needed. The default is still resolved inside the commit transaction.
3. **Medium, duplicated code:** the visibility and expiration controls in `sites-section.tsx` had identical failure handling. Fixed with one `reportMutationFailure` helper.
4. **Medium, redundant query:** the extra receipt lookup in creation. Removed by the fix for finding 2.
5. **Low, judgement:** `setOwnerSettings` does not go through the site `mutation()` wrapper. Left as is: it is not a site mutation, has no receipt, is naturally idempotent and is reachable only from the session-authenticated web handler behind installation-wide admission.

## Spec

1. **Wrong annotation:** `set_site_expiration` advertised `destructiveHint: false` while the ticket asked for the same annotations as `set_site_visibility`. Fixed: it uses the shared write annotations, and the ticket wording explains why shortening a lifetime counts as destructive.
2. **Partial:** the release workflow only wrote the image digest to the run summary. Fixed: it now creates the GitHub Release for the tag with generated notes and the image digest, which needs `contents: write` on that job.
3. **Minor wording:** `engines.node` is a range rather than a pinned patch version. Left as is; the range admits one minor line and matches the existing package convention.

No scope creep was found. Verification after the fixes: `pnpm lint`, `pnpm typecheck`, `pnpm test` (106 tests in 18 files), `pnpm build` and `pnpm test:browser` (13 passed, 1 intentionally skipped) on Chromium and Firefox.
