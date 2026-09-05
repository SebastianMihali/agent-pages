# Owner identity and management authentication

Status: ready-for-agent
Progress: done
Blocked by: 01

## Objective

Provision one stable owner and authenticate web sessions and API keys through shared authorization. Keep management credentials on the application origin.

## Scope

Implement the [identity contract](../spec.md#identity-and-access), including migrations for the singleton owner, hash-only sessions/keys, interactive password-hash helper, login/logout, CSRF, throttling and owner-scoped lookups. Implement the minimal login and key-control handlers/forms needed to exercise the flow; ticket 06 completes the interface. Persist no plaintext passwords or complete API keys. Use the request principal rather than client-supplied ownership.

Provide the internal authorization/session operations needed by the later private-site handoff; defer its endpoints until ticket 04. No registration, second-account provisioning, password-sharing feature or OAuth server.

## Acceptance

- [x] Fresh bootstrap creates exactly one stable owner, preserves identity on restart and handles configured username/password changes as specified.
- [x] Correct login succeeds; incorrect login and CSRF/origin failures are generic and rate-limited.
- [x] Session rotation, expiry, logout and startup invalidation work with injected time and isolated storage.
- [x] API keys are shown once, stored hashed, bounded in count and rejected immediately after revocation.
- [x] REST/MCP authentication ignores browser cookies; web handlers do not require a frontend API key.
- [x] Forged owner IDs and a synthetic other principal cannot access an owner's records.
- [x] Browser output, errors and logs contain no secret/session/ticket material beyond the explicit once-only key response.

## Verification

Real SQLite auth tests cover stable identity, hash-only secrets, CSRF, rotation, expiry, throttling/challenge reuse and revocation. Browser tests cover once-only copy, no persistent browser key storage, login/logout and production cookies.

Commands, exact versions and limitations: [local verification record](../verification.md). The independent Standards and Spec findings for this scope are closed; see the [review record](../review.md).
