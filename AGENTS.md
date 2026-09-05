# Engineering guidelines

## Priorities

Optimize for correctness, simplicity, maintainability, performance, and security.

- Understand the real constraint before choosing a solution.
- Prefer the smallest model that makes correct behavior unsurprising.
- Apply both “measure twice, cut once” and YAGNI.
- Keep the requested scope tight.
- Remove accidental complexity instead of preserving it by default.
- Prefer explicit, predictable behavior over hidden magic.
- Treat existing behavior as intentional until evidence shows otherwise.

## Before editing

- Inspect the relevant code, tests, configuration, and documentation.
- Trace inputs, outputs, side effects, and failure paths.
- Identify the existing abstraction that owns the behavior.
- Check for related callers and downstream consumers.
- Preserve unrelated user changes already present in the workspace.
- State assumptions that materially affect the chosen solution.

Begin implementation only when the affected behavior and ownership boundary are understood.

## Structure and design

- Organize code around cohesive responsibilities.
- Keep public interfaces narrow and stable.
- Hide implementation complexity behind simple interfaces.
- Separate domain decisions from transport, persistence, framework, and UI concerns.
- Keep dependencies pointing toward stable core logic.
- Put integration-specific complexity at adapter boundaries.
- Maintain a single source of truth for each rule or piece of state.
- Prefer composition over inheritance and global coordination.
- Reuse an existing abstraction when it genuinely owns the behavior.
- Introduce a new abstraction only when it removes proven duplication or isolates meaningful complexity.
- Avoid speculative extension points, generic frameworks, and premature indirection.
- Keep side effects explicit and localized.
- Design operations to be safe to retry when practical.
- Account for reverse operations and failure states, not only the happy path.

## Solution quality

- Solve the root cause rather than masking symptoms.
- Prefer a direct local change when the problem is local.
- Avoid expanding the architecture to solve hypothetical future requirements.
- Use existing dependencies and platform capabilities before adding new ones.
- Keep compatibility unless the requested change explicitly breaks it.
- Make invalid states difficult to represent or easy to detect.
- Fail with actionable context instead of silently continuing.
- Preserve error causes when wrapping or translating failures.
- Document durable decisions and non-obvious constraints close to their source of truth.

## Performance

Performance is a design constraint, not a cleanup phase.

- Keep work proportional to the requested operation.
- Avoid redundant computation, serialization, allocation, and I/O.
- Avoid N+1 access patterns and repeated full-data scans.
- Bound concurrency, queues, retries, payload sizes, and memory growth.
- Stream or batch work when it reduces overhead without obscuring correctness.
- Avoid loading complete datasets when metadata or a targeted subset is sufficient.
- Keep hot paths free of unnecessary abstraction and logging.
- Prevent unnecessary renders, subscriptions, polling, and continuously running animations.
- Use caching only with a clear invalidation model.
- Measure before introducing performance machinery.
- Benchmark or profile changes made specifically for performance.
- Prefer correctness and predictable resource use over impressive benchmark results.

## Security

Treat every external input and integration boundary as untrusted.

- Validate and normalize input at the boundary.
- Enforce authentication and authorization independently.
- Apply least privilege to credentials, processes, files, and network access.
- Keep secrets out of source code, client output, logs, errors, fixtures, and generated artifacts.
- Prevent traversal, injection, unsafe deserialization, and unintended code execution.
- Use explicit allowlists where the accepted input space is narrow.
- Make destructive actions explicit, narrowly scoped, and recoverable when practical.
- Avoid exposing internal implementation details through errors.
- Log security-relevant events without logging sensitive content.
- Keep security controls in executable code rather than relying on documentation or caller discipline.
- Add negative tests for important trust boundaries.
- Surface security tradeoffs explicitly when requirements conflict.

## Code style

- Use clear names that reflect the domain and intent.
- Prefer small cohesive modules over large collections of unrelated helpers.
- Keep control flow explicit and readable.
- Use types and schemas to express invariants where the language permits.
- Avoid bypassing the type system without a documented reason.
- Comments explain intent, constraints, or usage—not syntax.
- Delete stale code and comments when behavior changes.
- Follow existing formatting and naming conventions.
- Avoid clever compression that makes maintenance harder.
- Keep changes internally consistent across implementation, tests, documentation, and contracts.

## Verification

Use the smallest proof that establishes the change works.

- Run focused tests for the affected behavior first.
- Test public behavior rather than private implementation details.
- Cover error paths, boundary conditions, and destructive operations.
- Add regression tests for fixed bugs.
- Use isolated test data and temporary resources.
- Prefer observable completion conditions over arbitrary sleeps.
- Run targeted lint, type, and build checks for the affected scope.
- Expand verification when the blast radius justifies it.
- Report what was verified and what remains unverified.
- Do not claim completion while required checks are failing.

## Process safety

- Never overwrite unrelated workspace changes.
- Avoid destructive Git operations unless explicitly requested.
- Run tests and development processes against isolated state.
- Stop only processes started during the current task, using identifiers captured at launch.
- Never kill processes through broad name or path matching.
- Inspect targets before deletion or bulk modification.
- Keep temporary artifacts out of tracked source unless they are requested deliverables.

## Delivery

- Keep one concern per change.
- Update documentation when public behavior or durable architecture changes.
- Do not create commits, branches, tags, releases, or pull requests unless explicitly requested.
- Summarize the outcome, important decisions, and verification performed.
- Call out known risks, migrations, compatibility changes, and follow-up work.

## Agent skills

### Product and implementation

Before implementing or changing site behavior, read `agent-pages-spec.md` for scope, `.scratch/mvp/spec.md` for the current contract, and the relevant `docs/adr/` decisions. Start implementation from `.scratch/mvp/plan.md`; historical drafts under `docs/archive/` are not requirements.

### Issue tracker

Issues and specs are stored as Markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default Matt Pocock triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context layout. See `docs/agents/domain.md`.
