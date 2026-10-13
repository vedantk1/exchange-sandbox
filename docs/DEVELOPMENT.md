# Development and validation

## Current milestone

Milestone 1 establishes the persistence and correctness foundation: limit-order matching, exact accounting, partial fills, cancellation, idempotent commands, and recovery against real PostgreSQL. The [MVP](MVP.md) remains the full product specification; [architecture](ARCHITECTURE.md) records the implementation direction.

This milestone exposes a trusted TypeScript API and a command-line demonstration. There is no HTTP listener, browser interface, authentication, invitation system, or administrator interface yet. Caller-supplied account identities are not authentication. Do not expose this core directly to untrusted callers.

The developer bootstrap starts a trading session so the controlled matching demonstration can run. The complete product's administrator setup will start paused, as specified in the MVP. Protected market orders, bot operation, grants, session rollover, SSE delivery, exports, and a separate restricted application database role remain later milestones. Transactional outbox records exist; an event publisher does not.

## Prerequisites and setup

- Node.js 24, pinned by `.nvmrc` and the package engine range.
- pnpm 10.22.0, pinned by `packageManager` in `package.json`.
- A normal, non-root local user: PostgreSQL cannot initialize a cluster as root.

```sh
pnpm install --frozen-lockfile
pnpm demo
```

The default demo starts temporary PostgreSQL 18, runs the controlled partial-fill/cancellation scenario, and prints exact results. It uses a loopback address, an available local port, and a generated password. The connection URL and password are not printed.

The runner stops the database and removes its temporary cluster when it exits normally. Data is intentionally ephemeral. If the runner itself is forcibly killed, an operator may need to stop that leftover local PostgreSQL process before removing its corresponding `.local/postgres-*` directory. Do not delete an active cluster's files.

The bundled PostgreSQL dependency supplies platform-specific binaries, so no Docker daemon or separately installed database is required. A successful run on one platform does not establish support across every platform the dependency lists.

## Commands

| Command                          | Purpose                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm demo`                      | Run the controlled scenario against temporary PostgreSQL, or `DATABASE_URL` when supplied |
| `pnpm typecheck`                 | Check all workspace TypeScript, including tests and developer scripts                     |
| `pnpm format:check`              | Check repository formatting                                                               |
| `pnpm format`                    | Apply formatting                                                                          |
| `pnpm test`                      | Run deterministic domain examples and property tests                                      |
| `pnpm test:integration`          | Start temporary PostgreSQL and run integration tests, or use `TEST_DATABASE_URL`          |
| `pnpm test:integration:external` | Run integration tests directly against an already configured `TEST_DATABASE_URL`          |
| `pnpm check`                     | Run type checking, formatting, domain tests, and PostgreSQL integration tests             |

There is no production-mode server to start at this stage. Later application work should use development/watch processes for local iteration.

## Existing PostgreSQL instances

Set `DATABASE_URL` in the process environment to retain a demo database, or `TEST_DATABASE_URL` to run tests against a dedicated existing PostgreSQL database. Keep connection material out of tracked files and shell command arguments; use the local environment or an appropriate secret store. The runners do not log either URL.

Use a dedicated development database for the demo. Its migrations create the exchange schema and its scenario writes simulated accounts and trading history. The wrapper does not stop or remove an externally supplied database.

Tests create a unique `exchange_test_*` schema for each case using the supplied database connection. They drop only those generated schemas during cleanup. The test database role needs permission to create schemas, tables, functions, and triggers. Existing unrelated schemas are not reset or truncated. A test process killed outside normal cleanup can leave a generated test schema behind.

Integration tests deliberately use database-owner privileges for corruption probes. That establishes what recovery detects; it is not evidence of tamper resistance against the database owner. The future deployment design separates migration ownership and application permissions.

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

Business rejections, such as insufficient funds, are durable results and do not reserve funds. Malformed financial inputs fail before command persistence. Cancellation preserves completed fills and fees. Cross-account cancellation is rejected within the service, but this ownership check still depends on the future authentication layer establishing a trustworthy actor.

A runtime accounting invariant failure rolls back financial effects to a savepoint while retaining the serialized command boundary. The transaction commits an `INVARIANT_FAILURE` rejected receipt and a persistent fault; queued and later financial work is blocked. The local admission gate also remains halted if persisting that fault fails. Faults are sticky: this milestone does not provide a resume or automatic repair API. Read the original receipt and investigate the persisted evidence instead of resubmitting under a fresh identity.

`beforeCommit` and `afterCommit` hooks are test seams for deterministic fault injection. They are not a supported production extension mechanism. The real process-loss tests stop a worker at these boundaries and send `SIGKILL` from its parent process.

## Source boundaries

| Location                 | Responsibility                                                  |
| ------------------------ | --------------------------------------------------------------- |
| `packages/domain/src/`   | Exact amounts, validation, and pure price/time matching         |
| `packages/database/src/` | PostgreSQL types, client, reviewed schema, and migrations       |
| `apps/server/src/`       | Command admission, persistence, accounting, reads, and recovery |
| `packages/domain/test/`  | Focused domain examples and generated properties                |
| `tests/integration/`     | Real database concurrency, integrity, and process-loss tests    |
| `tests/helpers/`         | Isolated database schemas and the crash-worker harness          |
| `scripts/`               | Local demonstration and temporary PostgreSQL runner             |

The domain does not open database connections. The service owns the transaction boundary. PostgreSQL is authoritative; process memory does not decide whether a previous order committed.

## Evidence and limitations

The suite currently contains 32 domain tests and 21 PostgreSQL integration tests. Local validation uses Node.js 24 and PostgreSQL 18.4. The CI workflow is configured, but no remote CI run has been performed.

| Suite                                 | Behavior exercised                                                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain/test/`               | Exact parsing and arithmetic; price/time priority; self-trade prevention; generated conservation and fee properties                                                                    |
| `tests/integration/trading.test.ts`   | MVP partial-fill/cancel balances, price-improvement release, ordering, concurrent reservations, retries, ownership, cancel/fill race, and restart priority                             |
| `tests/integration/integrity.test.ts` | Exclusive writer ownership, schema compatibility, journal integrity, nonnegative customer buckets, runtime fault rollback and queued-command refusal, and startup corruption detection |
| `tests/integration/recovery.test.ts`  | Actual application `SIGKILL` before commit and after commit before acknowledgement; atomic rollback, persisted receipts/outbox, and replay without duplicated effects                  |

The process-loss suite uses a separate operating-system process and real PostgreSQL transactions. It does not simulate PostgreSQL losing durable storage, an operating-system power failure, or recovery from a backup. Those are different operational guarantees.

No throughput, latency, browser, authorization, or complete MVP acceptance claim follows from these tests. Performance measurement and the remaining product flows need their own evidence. For the current scope, the key demonstration is that execution, reservations, fees, accounting, and retry outcomes stay consistent across concurrency and restart.

## Troubleshooting

- Missing `TEST_DATABASE_URL` in the external test command: use `pnpm test:integration` for a temporary instance, or configure a dedicated database.
- A second writer cannot start: close the previous instance and confirm its process has exited. Do not remove locks or change its epoch manually to force concurrent writers.
- Startup reconciliation fails: preserve the database for investigation. Inspect the reported fault and source records; do not overwrite balances or delete journal history to make startup succeed.
- Temporary PostgreSQL fails to initialize: check the Node version, supported operating system/architecture, and whether the process is running as root. Use an existing PostgreSQL instance when bundled binaries cannot run.
