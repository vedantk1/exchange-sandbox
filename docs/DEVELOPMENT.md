# Development and validation

## Current milestone

The functional MVP is implemented: exact matching/accounting, invitations and authentication, trader/admin workspaces, live updates, protected market orders, simulator controls, session rollover, retained archives and complete scoped history/exports.

Release hardening covers bounded database work and shutdown, market-read isolation, immutable accepted order terms, indexed historical reads, migration checksums and frozen upgrade fixtures, locked runtime tooling, fresh Compose/HTTPS acceptance, and bounded operational diagnostics. Reviewer onboarding opens disposable authenticated trader/admin windows and supplies a headless smoke mode; repeated packaged startup checks are a separate bounded release exercise. The [MVP](MVP.md) remains the product specification; [architecture](ARCHITECTURE.md) records the implementation tradeoffs, [API documentation](API.md) describes routes, and the [operator runbook](OPERATIONS.md) covers investigation and recovery. The [direction review](RELEASE.md#direction-review-and-remaining-work) records the release boundary and separate capacity follow-up.

The HTTP adapter derives account identity from an opaque login cookie, validates strict request schemas, and checks role and ownership. Financial and access mutations recheck authorization under the same installation lock. Internal TypeScript methods remain trusted module interfaces; caller-supplied account IDs alone are never authentication. The React client shares transport types and uses decimal strings for financial labels and exact integer arithmetic for previews.

HTTP admission has a bounded active-request count and deadline. The control lock has a bounded wait. An observed disconnect before admission prevents a later mutation; an admitted command finishes atomically and is resolved through its original receipt. The [API guide](API.md) documents the prototype limits and the distinction between an observed disconnect and an uncertain client-side timeout.

Local administrator setup starts paused and supplies no administrator balance. The isolated matching demo still uses its separate developer fixture, which starts trading directly. Session rollover, scoped archives, complete history/export reads, and a restricted self-host application role are implemented. The current publisher reads committed outbox positions and sends authorized snapshot invalidations; it does not send financial deltas or token secrets.

## Prerequisites and setup

- Node.js 24, pinned by `.nvmrc` and the package engine range.
- pnpm 10.22.0, pinned by `packageManager` in `package.json`.
- A normal, non-root local user: PostgreSQL cannot initialize a cluster as root.

After `pnpm install --frozen-lockfile`, install Chromium with `pnpm exec playwright install chromium` and run `pnpm portfolio:serve` for a disposable UI review. It opens the trader and administrator with isolated, genuinely authenticated sessions and a seeded partial fill, without writing browser-state files. Closing either demo window or Ctrl+C removes the temporary installation. It refuses `TEST_DATABASE_URL`. See [reviewer launch and smoke mode](RELEASE.md#review-the-project-locally); the commands below instead retain a persistent development database.

```sh
pnpm install --frozen-lockfile
pnpm admin:setup
pnpm dev
```

`admin:setup` prompts for a handle and a non-echoed password, then creates the single administrator. It refuses to replace an existing administrator. `dev` starts the API in Node watch mode on loopback port 3001, waits for liveness, and starts Vite on `http://localhost:3000`. Vite proxies `/api` and `/health`, including SSE, so the browser uses one origin for cookies and commands. Open the printed localhost URL, rather than the backend port. Stop the development runner before owner commands because one writer owns the installation.

Use `WEB_PORT` to change Vite's port and `PORT` to change the backend port; they must differ. `API_ORIGIN` defaults to `http://localhost:<WEB_PORT>` and must exactly match the URL opened in the browser. An occupied port fails explicitly instead of silently selecting a different origin. Stopping the runner stops both development processes and the local PostgreSQL process it owns.

These commands use a persistent PostgreSQL cluster under `.local/development-postgres/`. Generated connection metadata is private, ignored by Git, and stored in `.local/development-database.json`; it is not an example or a portable deployment credential. Keep both with the local database, and do not share them. The runner stops only the PostgreSQL process it started and never deletes this persistent cluster. An incomplete or unreadable cluster is preserved for inspection.

`pnpm admin:reset` is the owner-only lost-password process. With the API stopped, it prompts for a replacement password, updates the administrator, revokes all administrator sessions, and records the action. It cannot grant administrator rights to a trader. Possession of local database access is the trust boundary for both owner commands; neither is exposed over HTTP. Credentials are never accepted as CLI arguments.

`pnpm db:migrate` runs owner migrations under the writer guard without changing database roles. A names-only installation requires a backup, a stopped API, and the explicit `MIGRATION_LEGACY_BASELINE` matching its last applied migration. For example, the previous large-session release uses `MIGRATION_LEGACY_BASELINE=009_large_session_reads pnpm db:migrate`. The owner attests the application schema before adding hashes; ordinary startup never adopts them silently. Follow the [upgrade procedure](RELEASE.md#adopt-a-names-only-installation) for mismatches and lost-reply retries. Fresh installations need no legacy setting.

For an isolated scenario:

```sh
pnpm demo
```

The default demo starts temporary PostgreSQL 18, runs the controlled partial-fill/cancellation scenario, and prints exact results. It uses a loopback address, an available local port, and a generated password. The connection URL and password are not printed.

The runner stops the database and removes its temporary cluster when it exits normally. Data is intentionally ephemeral. If the runner itself is forcibly killed, an operator may need to stop that leftover local PostgreSQL process before removing its corresponding `.local/postgres-*` directory. Do not delete an active cluster's files.

The bundled PostgreSQL dependency supplies platform-specific binaries, so no Docker daemon or separately installed database is required. A successful run on one platform does not establish support across every platform the dependency lists.

## Commands

| Command                                                | Purpose                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `pnpm demo`                                            | Run the controlled scenario against temporary PostgreSQL, or `DATABASE_URL` when supplied        |
| `pnpm dev`                                             | Start Vite and the API in development/watch mode against persistent PostgreSQL or `DATABASE_URL` |
| `pnpm admin:setup`                                     | Create the single administrator through an interactive local prompt                              |
| `pnpm admin:reset`                                     | Recover administrator access and revoke its existing sessions                                    |
| `pnpm typecheck`                                       | Check all workspace TypeScript, including tests and developer scripts                            |
| `pnpm format:check`                                    | Check repository formatting                                                                      |
| `pnpm format`                                          | Apply formatting                                                                                 |
| `pnpm test`                                            | Run domain examples/property tests and browser command-recovery/arithmetic tests                 |
| `pnpm test:integration`                                | Start temporary PostgreSQL and run integration tests, or use `TEST_DATABASE_URL`                 |
| `pnpm test:integration:external`                       | Run integration tests directly against an already configured `TEST_DATABASE_URL`                 |
| `pnpm test:browser`                                    | Run Chromium workflows against a disposable PostgreSQL cluster, or `TEST_DATABASE_URL`           |
| `pnpm test:browser:external`                           | Run browser workflows against a dedicated existing `TEST_DATABASE_URL`                           |
| `pnpm check`                                           | Run type checking, formatting, unit/integration/browser tests, and the browser build             |
| `pnpm build:web`                                       | Check the browser production bundle without starting a production server                         |
| `pnpm portfolio:serve`                                 | Open authenticated trader/admin Chromium windows against a disposable development installation   |
| `pnpm portfolio:serve --headless --smoke`              | Check the same seeded reviewer flows automatically, then clean up and exit                       |
| `pnpm portfolio:serve --no-open`                       | Start the disposable fixture and explicitly write private browser state for deliberate captures  |
| `pnpm selfhost:prepare <https-origin>`                 | Generate private self-host configuration without a default administrator                         |
| `pnpm selfhost:acceptance [api-image] [web-image]`     | Verify fresh packaged Compose setup, HTTPS trading/exports, graceful restart and cleanup         |
| `pnpm selfhost:acceptance:cleanup`                     | Retry verified cleanup of recorded acceptance-owned runs only                                    |
| `pnpm selfhost:startup-checks [api-image] [web-image]` | Run five fresh full HTTPS acceptance installations, stopping at the first failure                |
| `pnpm ops:benchmark`                                   | Measure a disclosed core workload against isolated PostgreSQL schemas                            |
| `pnpm ops:restore`                                     | Run a fresh-database logical restore drill; requires PostgreSQL 18 backup clients                |

Local iteration uses development/watch mode. `API_ORIGIN` selects the exact permitted origin; mutating requests must send it in the Origin header. Secure cookies require an HTTPS origin; the HTTP exception is limited to loopback. The default listener is loopback. The separate self-host package uses Caddy for HTTPS and same-origin proxying; its validation and setup instructions are in [release verification](RELEASE.md).

Packaged acceptance deliberately runs the built production images, separately from `pnpm check` and the development-browser suite. It requires Docker Compose, Python 3's standard-library PTY support on Linux/macOS, Chromium, and API/web images carrying the current Git revision label. Follow [fresh Compose acceptance](RELEASE.md#fresh-compose-acceptance) for the exact build commands, TLS trust scope, isolation, report format, and cleanup recovery. It creates no fixtures in an existing development or self-host installation.

The packaged journey checks setup, HTTPS trading/exports, diagnostics, restart recovery and receipt replay, followed by independent cleanup confirmations. The [release verification summary](RELEASE.md#release-verification) identifies the recorded release revision and startup reports; [local operational results](RELEASE.md#recorded-local-operational-results) retain separate benchmark and restore evidence.

`selfhost:startup-checks` repeats that full journey on fresh installations under a shared ten-minute work deadline and stops on the first failure. It preserves the standalone report and writes an allowlisted aggregate to `.local/operations/self-host-startup-checks-result.json`. Cleanup remains independently bounded after the work deadline. See [bounded startup checks](RELEASE.md#bounded-startup-checks) for image identity, smaller local probes, privacy and interpretation. The Linux login reproduction and network-readiness gate are documented in [release verification](RELEASE.md#bounded-startup-checks).

## Operational diagnostics

The development and packaged API emit sanitized JSON diagnostic events alongside their ordinary HTTP/startup logs. Sign in as the administrator and request `/api/admin/diagnostics` on the same origin to inspect the current process window. Its live database authorization, privacy boundary, timing/gauge semantics and safe recovery procedures are documented once in [operations and troubleshooting](OPERATIONS.md). No external collector or new monitoring service is required; no diagnostics UI is added.

`ExchangeOptions.diagnostics` accepts an injected `Diagnostics` instance for trusted local tests/tools; its sink receives only allowlisted event fields. `DatabaseOptions.observer` receives phase, budget kind, fixed outcome and elapsed milliseconds, never SQL or parameters. Observer/sink failures are consumed independently of transaction completion and transport disposal. Use the existing integration wrapper for focused checks, for example `pnpm test:integration tests/integration/api-diagnostics.test.ts tests/integration/database-observation.test.ts`; these tests own isolated schemas and do not alter the development installation.

## Market simulator

Run `pnpm dev`, sign in as the administrator, and choose **Start simulator** in the overview. Confirm with a reason. First start creates two non-login accounts and issues each the ordinary one-time allocation of 1 BTC-SIM and 100,000 USD-SIM; later starts preserve the existing accounts and balances. Start can arm the simulator while paused. Resume trading to admit its orders. The earlier `dev:market` command and `DEMO_MARKET` environment switch have been removed; administrator intent stored in PostgreSQL is authoritative.

The maker and taker share the book with people and can change their sandbox balances through ordinary fills. They are excluded from human participant counts. Each cycle cancels their remaining orders, requests two maker bids and asks of 0.0200 BTC-SIM at offsets of 10 and 30 USD-SIM, and submits one 0.0010 BTC-SIM taker order. The fictional reference starts at 50,000 and moves within 48,000–52,000. The taker buys when its total BTC inventory is at or below 1 BTC-SIM, otherwise sells. Cycles wait four seconds after the previous work settles. This is not a fill or timing guarantee.

The overview shows exact available/reserved balances and per-order funding shortfalls. The preview includes buy fees, budgets total inventory after releasing previous reservations, and assumes no sale proceeds. Its stored reference may differ from the next cycle's price. Inspect either account for orders, fills, grants, and journal activity. To add inventory, pause a healthy market, choose **Fund demo maker** or **Fund demo taker**, review the exact before/after balance and issuance, and confirm a reason. Grants have the same precision, per-grant limits, journal entries, and replay protection as human funding. Funding never starts the worker. There is no automatic refill.

Pause preserves simulator intent and resting orders. **Stop simulator** disables new work and cancels only the two automated accounts' remaining orders, preserving human orders and completed trades. Its generation fence prevents queued work from an earlier run executing after stop or a later start. A fault can leave `STOPPING`: intent is disabled but financial cleanup is pending. Inspect and resolve the underlying fault, then reconcile/resume; resume completes cleanup and reconciles again before reopening trading. Start remains blocked while cleanup is pending.

Normal process shutdown drains the worker without changing the administrator's enabled setting or canceling its orders. Restart reconciles, resolves an unfinished plan using original command identities, and continues only if enabled and trading is healthy. A stopped simulator remains stopped. Running indicates persisted intent/state, not a separate worker health probe; the visible timestamp is the last persisted change.

Charts use real execution timestamps and one-minute UTC buckets. There is no historical seed, accelerated clock, or external price feed. Multiple trades in one minute update one candle, and flat candles are valid. Empty/sparse chart explanations remain visible alongside real data. Allow several minutes for useful history.

## Automated browser checks

Install the pinned Chromium binary once, then run the suite:

```sh
pnpm exec playwright install chromium
pnpm test:browser
```

On Linux, `pnpm exec playwright install --with-deps chromium` also installs browser system dependencies. Browser tests use actual React pages, Fastify, and PostgreSQL. The harness starts Vite in development mode on a free port, gives each test a generated schema and fresh browser context, and cleans up its own processes/schema. It never connects to the persistent development cluster or ports 3000/3001. Set `TEST_DATABASE_URL` only to a dedicated test database. Integration and browser suites must run sequentially if they share a PostgreSQL server because the writer guard is installation-wide. Integration filters also pass through, for example `pnpm test:integration tests/integration/session-lifecycle.test.ts`.

Coverage includes invitation redemption/login, exact partial-fill/cancellation balances and history, reconnect after offline state, a committed response loss followed by same-command retry after reload, and simulator start/stop/inventory/funding with pause/resume. Protected market scenarios cover moved liquidity and partial outcomes, actual 10-second preview expiry with explicit refresh, and a lost response recovered after reload and expiry using the original command and preview. Rollover scenarios verify the full old-session review, connected trader invalidation, archived final balances, original-command recovery after moving sessions, complete pagination/search, and actual CSV downloads. Simulator ticks in browser tests are invoked deterministically through the real scheduler after the administrator enables it; timer/restart/race behavior is covered separately in integration tests.

Failures retain screenshots and traces under `output/playwright/ci/`, ignored by Git. CI runs Chromium against its PostgreSQL service and uploads failure artifacts for seven days. Artifacts contain only isolated test accounts and virtual funds. The restore container runs under the runner's UID/GID so its private report remains readable by the artifact uploader. Only the sanitized `restore-result.json` is uploaded from the hidden `.local` directory; the generated dump and other private files are excluded. A successful verification must produce that report. Use `pnpm exec playwright show-trace <trace-path>` to inspect a failure. Browser flags/filters pass through, for example `pnpm test:browser --grep simulator`. These are selected regression workflows, not complete full-MVP acceptance or cross-browser certification.

Usability regressions cover exact candle data and narrow keyboard scrolling, archive isolation and explicit metadata refresh, validated history URLs with reload/Back/Forward, password rotation and single-use recovery, and keyboard-only trader/admin review flows. Credential/recovery tests disable traces/screenshots and clear the page before automatic failure-context collection so one-use handoffs do not become artifacts. Rotation changes the current bearer cookie while preserving that browser's signed-in access; other sessions are revoked.

## Session lifecycle and retained history

In the paused, healthy administrator overview, choose **Start a new session**, enter a reason, review the affected accounts/open orders and allocation rules, then confirm the full current session identity. The saved command continues to target that original session after a live transition or reload. An unknown result must be resolved or retried using that identity.

The server records a durable gate, then cancels remaining quantities, releases reservations, closes the old session, creates the new one, and allocates eligible accounts exactly once in one transaction. The new market is paused and its simulator stopped. Accounts, credentials, restrictions, and invitation expiry survive. Suspended accounts receive funds when first activated in the new session. An invariant fault keeps the transition gated until reconciliation succeeds after repair; replay cannot bypass it.

Trader **History** and administrator **Sessions & history** select current or closed sessions. Views display their session and read boundary, page through complete records, inspect individual orders, and download a consistent CSV bundle. Financial archives are read-only; post-closure rejection/recovery metadata can still be appended. Server-side account and order lookup reaches records beyond the recent workspace window. Read [the API](API.md#sessions-rollover-and-complete-history) for scopes, cursor rules, CSV precision, and explicit export limits.

The history URL stores validated `session`, administrator-only `account`, `kind`, `search`, `side` and `status`; administrator tabs use `view`. Selection changes push a browser entry, while search typing replaces the current entry. Omitted sessions follow the active session, explicit archives stay selected, and invalid/duplicate values normalize to safe defaults. Server authorization remains authoritative. Pagination cursors and export capabilities are excluded. Archived summaries use stable query keys and do not refetch for unrelated live ticks; **Refresh records** refreshes the summary, selected account and first record page so later rejection/recovery metadata remains reachable.

The chart's native disclosure opens an exact UTC OHLCV table; only visual coordinates use floating point. The table preserves decimal strings, has row/column headers and a keyboard-scrollable region. The chart's visual attribution is retained, with an accessible footer link and no hidden keyboard stop.

## Browser workflows and live state

The administrator starts at the control room. Invite participants, inspect their accounts, pause/resume trading, run reconciliation, and review audit history. Invitation links expire after 24 hours; recovery links after one hour. Their secrets are displayed only for immediate copying, use URL fragments, and are removed from the recipient's address bar after capture. They are not written to browser request recovery storage. If an issuance response loses its one-time secret, revoke/reissue the invitation or create a replacement recovery link.

Participant screens separate trading, open/recent orders, balances/activity, and execution/command history. Limit orders require review of the quantity, price, fee, and reservation before submission. Protected market orders request a server preview, showing estimated execution separately from the fixed guard and required reservation. Confirmation expires after 10 seconds and requires an explicit new review. An accepted market order is immediately filled or canceled with any earlier fills retained; the result and history explain its executed quantity, fees, and canceled remainder. Cancellation applies to the displayed order snapshot and preserves earlier fills. Book depth, candles, and recent trades use this installation's executions only; an empty exchange shows an empty chart instead of invented prices. Sparse history remains visible with an explanation, and simulator state is disclosed in the trading and administrator workspaces.

The browser reads a consistent workspace snapshot, then subscribes after its outbox cursor. SSE notifications invalidate that snapshot; serialized refreshes replace the visible values from PostgreSQL. A disconnected workspace retains its last confirmed values and disables new commands until refreshed. Authorization is rechecked during live delivery. There is no optimistic credit, invented fill, or assumed cancellation.

Before dispatch, the browser stores an unresolved command's original identity and payload in per-account session storage. Reloading the tab retains that identity; Resolve outcome checks its durable receipt and Retry same command reuses the payload. A missing receipt does not prove failure. Do not clear browser storage to dismiss an uncertain trade: doing so loses the client's recovery record. This recovery store contains command inputs, not passwords or bearer-token secrets.

Rendering failures and rejected lazy imports show **Workspace interrupted** with a focused heading and explicit **Reload workspace** action. Recovery leaves stored requests untouched and does not automatically reload or resend. Reload resolves receipts for the signed-in actor; switching authentication in another tab cannot resolve the original actor's request. This boundary operates after the initial app JavaScript loads. Self-host asset routing returns missing chunks as uncached 404 responses instead of SPA HTML.

Workspace snapshots show every open order and the most recent 100 orders, fills, activity entries, and command outcomes. The administrator snapshot retains bounded recent participants, invitations, and audit entries; the Participants screen uses complete server search/pagination, and Sessions & history reaches older records. Book depth is limited to 50 levels per side; the chart contains up to 60 one-minute candles with actual trades. Indexed UTC bucket selection includes complete populated minutes while avoiding aggregation of older candles. Separate complete history pages and coherent exports are described above; prepared export resource limits fail explicitly; the small compatibility JSON route retains its original row/byte caps.

## Existing PostgreSQL instances

Set `DATABASE_URL` in the process environment to use an existing development database for setup, owner recovery, the server, or the demo. Set `TEST_DATABASE_URL` for a dedicated existing test database. Keep connection material out of tracked files and shell command arguments; use the local environment or an appropriate secret store. The runners do not log either URL.

Use a dedicated development database for the demo. Its migrations create the exchange schema and its scenario writes simulated accounts and trading history. The wrapper does not stop or remove an externally supplied database.

Tests create a uniquely named exchange test schema for each case using the supplied database connection. They drop only those generated schemas during cleanup. The test database role needs permission to create schemas, tables, functions, and triggers. Existing unrelated schemas are not reset or truncated. A test process killed outside normal cleanup can leave a generated test schema behind.

Integration tests deliberately use database-owner privileges for corruption probes. That establishes what recovery detects; it is not evidence of tamper resistance against the database owner. The self-host deployment separates owner migrations from the restricted application role; the development/test clusters deliberately use owner privileges. Migrations 002–010 extend existing installations without rewriting earlier migrations or issuing new allocations to existing traders. Migration 003 adds simulator metadata; migration 004 adds the generation, pending-cleanup state, and registered simulator grant recipients. Existing intent, plans, accounts, and history survive the upgrade. New simulator accounts/allocations are created only on an explicit first administrator start. Migration 005 adds immutable previews/use records and enforces terminal market orders; it does not rewrite existing orders, receipts, or accounting history. Migration 006 adds the durable rollover operation, closure timestamps, and financial archive guards. Migration 007 captures PostgreSQL wall time after command admission and changes future evidence defaults; existing timestamps remain intact. Migration 008 protects accepted order terms and rejects order deletion/truncation without rewriting rows. Migration 009 adds indexed minute selection, per-order fill lookup, and history traversal without changing financial rows. Migration 010 completes the checksum metadata protocol and fences older runtimes. Legacy developer-only accounts do not acquire login credentials automatically.

## Core API

`apps/server/src/exchange.ts` exports `Exchange`. Service methods accept decimal strings for financial inputs; unsupported precision and JavaScript numbers are rejected rather than rounded or coerced.

| Method                                                                   | Contract                                                                                                 |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `Exchange.open(databaseUrl, options?)`                                   | Migrate/verify the schema, acquire writer ownership, and reconcile persisted state before admitting work |
| `bootstrap()`                                                            | Establish or return the local development session and system accounts                                    |
| `createTrader({ accountId, label, commandId })`                          | Create a simulated trader and record its initial allocation once                                         |
| `placeLimit({ accountId, commandId, sessionId, side, quantity, price })` | Submit a limit order, returning a durable accepted or rejected result                                    |
| `previewMarket({ accountId, sessionId, side, quantity })`                | Read the book and persist a 10-second guard; no funds are reserved                                       |
| `placeMarket({ accountId, commandId, sessionId, previewId })`            | Execute within that preview and immediately cancel any remainder                                         |
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

Database read/command/maintenance budgets have separate statement and total deadlines. Pool acquisition is finite, and a total timeout discards transports before allowing a callback to continue. Expected resource failures return recoverable `DATABASE_TIMEOUT` without creating an accounting fault. `ExchangeOptions.database` is trusted local configuration for budgets, pool size, acquisition, and drain limits, never a remote request option. See the [default limits and shutdown guarantees](ARCHITECTURE.md#database-budgets-and-shutdown). Tests use small injected budgets to exercise actual SQL cancellation, transport stalls, and safe recovery quickly.

## Source boundaries

| Location                    | Responsibility                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/domain/src/`      | Exact amounts, validation, and pure price/time matching                                  |
| `packages/contracts/src/`   | TypeBox request/response contracts used by the HTTP adapter                              |
| `packages/database/src/`    | PostgreSQL types, client, reviewed schema, and migrations                                |
| `apps/server/src/`          | Command admission, persistence, accounting, reads, and recovery                          |
| `apps/web/src/`             | Auth, trader/admin screens, shared dialogs, live snapshots, and browser command recovery |
| `packages/domain/test/`     | Focused domain examples and generated properties                                         |
| `apps/web/src/**/*.test.ts` | Browser request identity/recovery and exact preview arithmetic tests                     |
| `tests/integration/`        | Real database concurrency, integrity, and process-loss tests                             |
| `tests/browser/`            | Playwright trader/admin regressions and isolated development-server fixture              |
| `tests/helpers/`            | Isolated database schemas and the crash-worker harness                                   |
| `scripts/`                  | Development, owner-command, and temporary PostgreSQL runners                             |

The domain does not open database connections. The service owns the transaction boundary. PostgreSQL is authoritative; process memory does not decide whether a previous order committed.

## Evidence and limitations

The product and root workspace package are named **Spot Exchange Simulator** (`spot-exchange-simulator`). Internal `@sandbox/*` package names, authentication identifiers, database roles, and durable browser storage keys retain their existing names for compatibility. Renaming the product does not reset an installation or invalidate pending command recovery.

Choose validation according to the behavior being changed. `pnpm check` runs the standard type, format, unit, PostgreSQL, Chromium and browser-build checks; packaged deployment and operational exercises are separate commands. Focused test filters are useful during development, but do not establish that the complete suite or a published revision passed.

| Validation layer                     | Entry point                                                   | Scope                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Domain, browser recovery and tooling | `pnpm test`                                                   | Exact arithmetic, matching properties, request identity, client state and bounded runner behavior                             |
| PostgreSQL integration               | `pnpm test:integration`                                       | Transactions, concurrency, access control, immutable records, budgets, recovery and schema upgrades                           |
| Development browser                  | `pnpm test:browser`                                           | Real trader/admin workflows, partial fills, market guards, live state, archives, exports and keyboard recovery                |
| Reviewer launch                      | `pnpm portfolio:serve --headless --smoke`                     | Disposable authenticated role sessions, seeded trading flows and runner cleanup                                               |
| Packaged self-host                   | `pnpm selfhost:acceptance` and `pnpm selfhost:startup-checks` | Fresh Compose/HTTPS installation, restricted runtime, trading, exports, graceful restart, receipt replay and verified cleanup |
| Operational exercises                | `pnpm ops:benchmark` and `pnpm ops:restore`                   | Disclosed workloads and a separate fresh-database logical restore; not a sustained-load or storage-failure guarantee          |

The [release verification summary](RELEASE.md#release-verification) records published CI and startup-check results. [Recorded local operational results](RELEASE.md#recorded-local-operational-results) describe benchmark and restore measurements, with their source revisions and limits. The [MVP acceptance map](RELEASE.md#mvp-acceptance-evidence) connects product criteria to automated and manual evidence. These are results for the recorded revisions and environments, not fresh validation of every later edit. Do not infer remote CI success from a local run or general capacity from a bounded workload.

The process-loss suite uses a separate operating-system process and real PostgreSQL transactions. It does not simulate PostgreSQL losing durable storage, an operating-system power failure, or recovery from a backup. Most API tests use Fastify request injection with real PostgreSQL; admission and live-delivery tests also use real loopback HTTP listeners. The browser suite exercises the actual UI separately. Cross-browser certification and real-money operation are outside the recorded evidence.

`tests/integration/order-integrity.test.ts` verifies otherwise-valid term edits, deletion/truncation, statement/transaction rollback, restricted/reprovisioned grants, legitimate partial fills/cancellation, and lost-response retry/restart recovery. Its rollback-only owner probes temporarily disable the new guard to demonstrate that each forbidden edit would otherwise satisfy existing constraints.

The order-integrity schema-continuity fixture directly applies migrations 001–007 and seeds them with compatible current financial code before explicit owner adoption and current migrations. Only the initial legacy version check is replaced during fixture setup; actual current version rejection and migration are tested afterward. `tests/integration/order-integrity-upgrade.test.ts` proves unchanged financial rows/exact timestamps, protection of existing orders, continued execution, and receipt recovery after restart. This is separate from the independently frozen historical application test.

`tests/fixtures/historical/008/` contains committed SQL, receipt expectations and provenance from the previously published integrity release. Its [generator and review instructions](../tests/fixtures/historical/README.md) bind workspace imports to historical source and verify external dependency versions/graphs. Routine tests never regenerate it. The frozen directory is excluded from automatic formatting to preserve its exact bytes. `historical-upgrade.test.ts` loads it in a new database, rejects implicit adoption, runs normal owner initialization with the explicit 008 baseline, compares all retained application rows as PostgreSQL JSON text (excluding the intentionally changing writer epoch), and verifies original migration timestamps, reconciliation, old receipts, continued fills/cancellation and restricted restart recovery. Synthetic credentials are disabled before freezing; owner password recovery is exercised only after the exact comparison.

Migration source pins include whitespace. Keep every published statement and pin immutable; append a migration for new schema changes. `migration-checksums.test.ts` covers source and stored-hash mismatch, unknown/gapped history, legacy schema and metadata drift, SQL-literal namespace handling, concurrency, atomic rollback and idempotent adoption retry. A legacy structural attestation does not establish past SQL provenance or protect against database-owner tampering. A diagnosed owner repair of a pre-release development schema does not authorize automatic adoption of unknown variants.

Export fixtures create their private `.local` parent directory themselves before allocating a generated test directory. Focused external-database tests therefore do not depend on a directory left by earlier environment setup or by the bundled PostgreSQL runner.

The frontend recovery scenario controls receipt-before-snapshot delivery and checks that submissions stay disabled until live synchronization returns, while retaining the original actor/command. That controlled schedule also passed the older implementation; it verifies the recovery contract without claiming a deterministic reproduction of the original render race.

Earlier manual development-browser checks covered trading/cancellation, exact grants, invitation and recovery handoffs, live simulator/chart updates, market-preview expiry, offline and lost-response recovery, disabled browser storage, keyboard focus and narrow layouts. Separate owner/runner checks covered hidden password prompts, cancellation without administrator creation, persistent development restart, reviewer role isolation and cleanup after window closure or interruption. These remain manual observations for their original environments; the acceptance map distinguishes them from automated coverage and packaged release verification.

## Troubleshooting

For trading, database, live-stream, export, simulator or recovery failures, use the [operator runbook](OPERATIONS.md). Its first step is to retain the original unresolved command identity.

- Missing `TEST_DATABASE_URL` in the external test command: use `pnpm test:integration` for a temporary instance, or configure a dedicated database.
- A second writer cannot start: close the previous instance and confirm its process has exited. Do not remove locks or change its epoch manually to force concurrent writers.
- Startup reconciliation fails: preserve the database for investigation. Inspect the reported fault and source records; do not overwrite balances or delete journal history to make startup succeed.
- Temporary PostgreSQL fails to initialize: check the Node version, supported operating system/architecture, and whether the process is running as root. Use an existing PostgreSQL instance when bundled binaries cannot run.
