---
status: accepted
date: 2026-09-05
---

# Keep one explicit SQLite persistence implementation

The implemented site and authentication modules need short transactions, compare-and-set updates, durable receipts and deliberate SQLite lifecycle queries. These operations already use parameterized `better-sqlite3` statements. The initially selected Drizzle facade had no consumer, while its separate schema duplicated the executable SQL migrations.

Use the existing explicit SQL queries and module-owned migrations as the persistence source of truth. Remove the unused ORM facade, duplicated schema and migration-generator dependency. Domain interfaces continue to hide SQL from REST, MCP and the browser; this decision does not expose a general database API to those callers.

## Consequences

This refines the initial stack preference rather than changing the site/publication contract. Migration changes must be written deliberately and tested against real temporary databases and restored state. An ORM can be reconsidered when an actual query or migration workflow benefits from it; keeping an unused abstraction now would add maintenance without proving that benefit.
