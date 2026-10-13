# Development and validation

## Current milestone

Milestone 1 established matching, accounting, and recovery. Milestone 2 adds invitations, authentication, a Fastify HTTP API, and audited administrator controls. The [MVP](MVP.md) remains the full product specification; [architecture](ARCHITECTURE.md) records the implementation direction and [API documentation](API.md) describes the implemented routes.

The HTTP adapter derives account identity from an opaque login cookie, validates strict request schemas, and checks role and ownership. Financial and access mutations recheck authorization under the same installation lock. Internal TypeScript methods remain trusted module interfaces; caller-supplied account IDs alone are never authentication. There is no browser interface yet.

HTTP admission has a bounded active-request count and deadline. The control lock has a bounded wait. An observed disconnect before admission prevents a later mutation; an admitted command finishes atomically and is resolved through its original receipt. The [API guide](API.md) documents the prototype limits and the distinction between an observed disconnect and an uncertain client-side timeout.

Local administrator setup starts paused and supplies no administrator balance. The isolated matching demo still uses its separate developer fixture, which starts trading directly. Protected market orders, bot operation, session rollover, SSE delivery, exports, and a separate restricted application database role remain later milestones. Transactional outbox records exist; an event publisher does not.

## Prerequisites and setup

- Node.js 24, pinned by `.nvmrc` and the package engine range.
- pnpm 10.22.0, pinned by `packageManager` in `package.json`.
- A normal, non-root local user: PostgreSQL cannot initialize a cluster as root.

```sh
pnpm install --frozen-lockfile
pnpm admin:setup
pnpm dev
```

`admin:setup` prompts for a handle and a non-echoed password, then creates the single administrator. It refuses to replace an existing administrator. `dev` starts the API in Node watch mode on loopback; its default origin is `http://localhost:3000`. Stop the API before running owner commands because one writer owns the installation.

These commands use a persistent PostgreSQL cluster under `.local/development-postgres/`. Generated connection metadata is private, ignored by Git, and stored in `.local/development-database.json`; it is not an example or a portable deployment credential. Keep both with the local database, and do not share them. The runner stops only the PostgreSQL process it started and never deletes this persistent cluster. An incomplete or unreadable cluster is preserved for inspection.

`pnpm admin:reset` is the owner-only lost-password process. With the API stopped, it prompts for a replacement password, updates the administrator, revokes all administrator sessions, and records the action. It cannot grant administrator rights to a trader. Possession of local database access is the trust boundary for both owner commands; neither is exposed over HTTP. Credentials are never accepted as CLI arguments.

For an isolated scenario:

```sh
pnpm demo
```

The default demo starts temporary PostgreSQL 18, runs the controlled partial-fill/cancellation scenario, and prints exact results. It uses a loopback address, an available local port, and a generated password. The connection URL and password are not printed.

The runner stops the database and removes its temporary cluster when it exits normally. Data is intentionally ephemeral. If the runner itself is forcibly killed, an operator may need to stop that leftover local PostgreSQL process before removing its corresponding `.local/postgres-*` directory. Do not delete an active cluster's files.

The bundled PostgreSQL dependency supplies platform-specific binaries, so no Docker daemon or separately installed database is required. A successful run on one platform does not establish support across every platform the dependency lists.

## Commands

| Command                          | Purpose                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm demo`                      | Run the controlled scenario against temporary PostgreSQL, or `DATABASE_URL` when supplied |
| `pnpm dev`                       | Start the API in watch mode against persistent local PostgreSQL or `DATABASE_URL`         |
| `pnpm admin:setup`               | Create the single administrator through an interactive local prompt                       |
| `pnpm admin:reset`               | Recover administrator access and revoke its existing sessions                             |
| `pnpm typecheck`                 | Check all workspace TypeScript, including tests and developer scripts                     |
| `pnpm format:check`              | Check repository formatting                                                               |
| `pnpm format`                    | Apply formatting                                                                          |
| `pnpm test`                      | Run deterministic domain examples and property tests                                      |
| `pnpm test:integration`          | Start temporary PostgreSQL and run integration tests, or use `TEST_DATABASE_URL`          |
| `pnpm test:integration:external` | Run integration tests directly against an already configured `TEST_DATABASE_URL`          |
| `pnpm check`                     | Run type checking, formatting, domain tests, and PostgreSQL integration tests             |

Local iteration uses development/watch mode. `API_ORIGIN` selects the exact permitted origin; mutating requests must send it in the Origin header. Secure cookies require an HTTPS origin; the HTTP exception is limited to loopback. The default listener is loopback. TLS termination, proxy deployment, and remote installation have not been validated as a release configuration.

## Existing PostgreSQL instances

Set `DATABASE_URL` in the process environment to use an existing development database for setup, owner recovery, the server, or the demo. Set `TEST_DATABASE_URL` for a dedicated existing test database. Keep connection material out of tracked files and shell command arguments; use the local environment or an appropriate secret store. The runners do not log either URL.

Use a dedicated development database for the demo. Its migrations create the exchange schema and its scenario writes simulated accounts and trading history. The wrapper does not stop or remove an externally supplied database.

Tests create a uniquely named exchange test schema for each case using the supplied database connection. They drop only those generated schemas during cleanup. The test database role needs permission to create schemas, tables, functions, and triggers. Existing unrelated schemas are not reset or truncated. A test process killed outside normal cleanup can leave a generated test schema behind.

Integration tests deliberately use database-owner privileges for corruption probes. That establishes what recovery detects; it is not evidence of tamper resistance against the database owner. The future deployment design separates migration ownership and application permissions. Migration `002_identity_and_controls` extends existing installations without rewriting migration 001 or issuing new allocations to existing traders. Legacy developer-only accounts do not acquire login credentials automatically.

## Core API

`apps/server/src/exchange.ts` exports `Exchange`. Service methods accept decimal strings for financial inputs; unsupported precision and JavaScript numbers are rejected rather than rounded or coerced.

| Method                                                                   | Contract                                                                                                 |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `Exchange.open(databaseUrl, options?)`                                   | Migrate/verify the schema, acquire writer ownership, and reconcile persisted state before admitting work |
| `bootstrap()`                                                            | Establish or return the local development session and system accounts                                    |
| `createTrader({ accountId, label, commandId })`                          | Create a simulated trader and record its initial allocation once                                         |
| `placeLimit({ accountId, commandId, sessionId, side, quantity, price })` | Submit a limit order, returning a durable accepted or rejected result                                    |
| `cancel({ accountId, commandId, sessionId, orderId })`                   | Cancel only the caller's remaining order quantity                                                        |
| `getReceipt(accountId, commandId)`                                       | Resolve a previously submitted trading command using its original identity                               |
| `snapshot(accountId)`                                                    | Read the account's current session, exact balances, orders, and fills                                    |
| `reconcile()`                                                            | Compare persisted accounting, orders, and fills and report invariant violations                          |
| `close()`                                                                | Release the service's database resources and writer ownership                                            |

Reuse the original command identity and payload after an uncertain response. Identical retries return the original receipt even if the order has subsequently changed. A receipt is the original command outcome; read a fresh snapshot for current order state. Reusing an identity with a changed payload raises `COMMAND_CONFLICT`. A missing receipt while an original request may still be running is not evidence that it failed.

`getReceipt` resolves order-submission and cancellation commands. Developer trader-creation receipts have a separate result shape; retry `createTrader` with the original input to resolve an uncertain allocation. Creating the same trader with a fresh command identity also preserves its one starting allocation for that session.

Business rejections, such as insufficient funds, are durable results and do not reserve funds. Malformed financial inputs fail before command persistence. Cancellation preserves completed fills and fees. The HTTP adapter supplies the authenticated session to order submission and cancellation; the core checks that session again after acquiring the installation lock, before reading receipts or mutating funds.

A runtime accounting invariant failure rolls back financial effects to a savepoint while retaining the serialized command boundary. The transaction commits an `INVARIANT_FAILURE` rejected receipt and a persistent fault; queued and later financial work is blocked. The local admission gate also remains halted if persisting that fault fails. The HTTP server can restart in inspection mode: reads and access revocation remain available. Suspension during a fault revokes sessions immediately and records pending cancellations. Administrator resume reconciles, completes pending cancellations, reconciles again, and only then clears the halt. No operation repairs accounting or overwrites balances automatically; unresolved evidence keeps resume blocked.

`beforeCommit` and `afterCommit` hooks are test seams for deterministic fault injection. They are not a supported production extension mechanism. The real process-loss tests stop a worker at these boundaries and send `SIGKILL` from its parent process.

## Source boundaries

| Location                  | Responsibility                                                  |
| ------------------------- | --------------------------------------------------------------- |
| `packages/domain/src/`    | Exact amounts, validation, and pure price/time matching         |
| `packages/contracts/src/` | TypeBox request/response contracts used by the HTTP adapter     |
| `packages/database/src/`  | PostgreSQL types, client, reviewed schema, and migrations       |
| `apps/server/src/`        | Command admission, persistence, accounting, reads, and recovery |
| `packages/domain/test/`   | Focused domain examples and generated properties                |
| `tests/integration/`      | Real database concurrency, integrity, and process-loss tests    |
| `tests/helpers/`          | Isolated database schemas and the crash-worker harness          |
| `scripts/`                | Development, owner-command, and temporary PostgreSQL runners    |

The domain does not open database connections. The service owns the transaction boundary. PostgreSQL is authoritative; process memory does not decide whether a previous order committed.

## Evidence and limitations

Local validation uses Node.js 24 and PostgreSQL 18.4. Run `pnpm check` for current counts and results. The CI workflow runs the same checks against a PostgreSQL service; no remote CI run has been performed.

| Suite                                      | Behavior exercised                                                                                                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain/test/`                    | Exact parsing and arithmetic; price/time priority; self-trade prevention; generated conservation and fee properties                                                                    |
| `tests/integration/trading.test.ts`        | MVP partial-fill/cancel balances, price-improvement release, ordering, concurrent reservations, retries, ownership, cancel/fill race, and restart priority                             |
| `tests/integration/integrity.test.ts`      | Exclusive writer ownership, schema compatibility, journal integrity, nonnegative customer buckets, runtime fault rollback and queued-command refusal, and startup corruption detection |
| `tests/integration/recovery.test.ts`       | Actual application `SIGKILL` before commit and after commit before acknowledgement; atomic rollback, persisted receipts/outbox, and replay without duplicated effects                  |
| `tests/integration/api*.test.ts`           | Cookie authentication, CSRF/origin checks, invitation races, account privacy, credential revocation, admin controls, grants, and inspection during faults                              |
| `tests/integration/admin-recovery.test.ts` | A queued resume observes the fault it actually reconciles; an unpersisted runtime fault stays visible and cannot be cleared by replaying an older receipt                              |

The process-loss suite uses a separate operating-system process and real PostgreSQL transactions. It does not simulate PostgreSQL losing durable storage, an operating-system power failure, or recovery from a backup. Those are different operational guarantees.

Most API tests use Fastify request injection with real PostgreSQL. Admission tests also use a real loopback HTTP listener to exercise disconnects before and after admission, alongside database lock-contention checks. Neither establishes browser cookie behavior or UI acceptance. No throughput, latency, production deployment, or complete MVP acceptance claim follows from these tests. Performance measurement and the remaining product flows need their own evidence.

Local smoke checks also started the actual watch-mode HTTP listener, checked its liveness, uninitialized readiness, and rejection of anonymous private reads, then stopped it. The owner setup prompt was checked for hidden password input and cancellation without creating an administrator. The persistent development database reopened successfully between these commands; no default application credentials are installed.

## Troubleshooting

- Missing `TEST_DATABASE_URL` in the external test command: use `pnpm test:integration` for a temporary instance, or configure a dedicated database.
- A second writer cannot start: close the previous instance and confirm its process has exited. Do not remove locks or change its epoch manually to force concurrent writers.
- Startup reconciliation fails: preserve the database for investigation. Inspect the reported fault and source records; do not overwrite balances or delete journal history to make startup succeed.
- Temporary PostgreSQL fails to initialize: check the Node version, supported operating system/architecture, and whether the process is running as root. Use an existing PostgreSQL instance when bundled binaries cannot run.
