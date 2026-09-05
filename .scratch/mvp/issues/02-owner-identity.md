# Owner identity and management authentication

Status: ready-for-agent
Progress: in-progress
Blocked by: 01

## Objective

Provision one stable owner and authenticate web sessions and API keys through shared authorization. Keep management credentials on the application origin.

## Scope

Implement the [identity contract](../spec.md#identity-and-access), including migrations for the singleton owner, hash-only sessions/keys, interactive password-hash helper, login/logout, CSRF, throttling and owner-scoped lookups. Implement the minimal login and key-control handlers/forms needed to exercise the flow; ticket 06 completes the interface. Persist no plaintext passwords or complete API keys. Use the request principal rather than client-supplied ownership.

Provide the internal authorization/session operations needed by the later private-site handoff; defer its endpoints until ticket 04. No registration, second-account provisioning, password-sharing feature or OAuth server.

## Acceptance

- [ ] Fresh bootstrap creates exactly one stable owner, preserves identity on restart and handles configured username/password changes as specified.
- [ ] Correct login succeeds; incorrect login and CSRF/origin failures are generic and rate-limited.
- [ ] Session rotation, expiry, logout and startup invalidation work with injected time and isolated storage.
- [ ] API keys are shown once, stored hashed, bounded in count and rejected immediately after revocation.
- [ ] REST/MCP authentication ignores browser cookies; web handlers do not require a frontend API key.
- [ ] Forged owner IDs and a synthetic other principal cannot access an owner's records.
- [ ] Browser output, errors and logs contain no secret/session/ticket material beyond the explicit once-only key response.

## Verification

Real SQLite auth tests cover stable identity, hash-only secrets, CSRF, rotation, expiry, throttling/challenge reuse and revocation. Browser tests cover once-only copy, no persistent browser key storage, login/logout and production cookies.

Commands, exact versions and limitations: [local verification record](../verification.md). Final independent code review is in progress.
