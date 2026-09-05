# REST, MCP and binary upload adapters

Status: ready-for-agent
Progress: open
Blocked by: 04

## Objective

Expose the shared site operations with bounded, consistent contracts that both target clients can use.

## Scope

Implement the [REST/MCP mapping](../spec.md#rest-and-mcp-contract) over the existing domain interface. Add schemas, error translation, structured MCP results/annotations, read pagination and multipart binary upload. Use the official SDK lifecycle verified in ticket 01 and maintain stateless per-request transport behavior where supported.

Prepare client examples from [configuration evidence](../../../docs/mcp-clients.md). Test with the SDK client first; end-to-end agent sessions are recorded in ticket 07. REST, MCP and web mutations share quotas and idempotency scope.

## Acceptance

- [ ] Every specified tool/route performs the same owner-authorized operation and returns equivalent domain results/errors.
- [ ] Authentication and Origin rules apply to discovery and read operations as well as writes.
- [ ] Cross-transport replay uses one operation receipt; schema errors never produce partial filesystem writes.
- [ ] Missing/deleted-site retries, version conflicts, expiring cursors and unavailable revisions give actionable bounded errors.
- [ ] Multipart streams reject oversize/duplicate/missing parts and publish all referenced files atomically.
- [ ] MCP reads return bounded text or binary metadata without encoding large assets into the context.
- [ ] An integration workflow creates a private site, uploads assets, reads/updates files, changes visibility explicitly and deletes it.
- [ ] No MCP response contains an owner session, site grant or private access ticket.

## Verification

Not run; implementation has not started.
