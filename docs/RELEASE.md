# Self-host release and portfolio verification

The release target is an open-source repository that other people can run themselves. A hosted demonstration is outside the current delivery. The [MIT license](../LICENSE) covers the source. All balances and executions remain virtual; see the accepted [MVP](MVP.md) for product boundaries.

## Direction review and remaining work

The 2026-10-15 review keeps the product scope fixed. Matching/accounting, trader and administrator flows, guarded execution, simulator controls, rollover/archives and complete exports have implementation and regression evidence in the acceptance map below. The recent integrity, large-session, upgrade, Compose and diagnostics milestones address specific failure modes. More infrastructure now needs a demonstrated problem and a bounded outcome.

The strongest engineering story is an inspectable trading system whose original command identity resolves a lost response without duplicating financial effects. Exact accounting, transactional receipts, process-kill tests, coherent exports and restore evidence support that story. The existing architecture diagrams, screenshots, walkthrough and MIT license already provide the foundations for a showcase.

Milestone status and remaining work:

| Priority             | Work                                       | Completion boundary                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implemented          | Finish the visible trader/admin experience | Exact textual candles, stable archive summaries with explicit metadata refresh, validated history URLs with reload/Back/Forward, and password/recovery/keyboard browser regressions are delivered.                                                                                                                                                 |
| Implemented          | Curate the portfolio entry point           | The README now leads with a representative trader image and three evidence-linked claims, plus an administrator/simulator view, a continuous recorded walkthrough and a concise engineering case study.                                                                                                                                            |
| Implemented          | Open a disposable reviewer demo            | One command opens genuinely authenticated trader/admin windows against temporary development services. A headless smoke mode checks the same seeded scenario; explicit capture mode keeps private browser-state handling separate.                                                                                                                 |
| Release verification | Bound repeated packaged startup checks     | Five fresh full Compose/HTTPS journeys use one source/image identity, stop at the first failure and retain only an allowlisted aggregate report. Passing runs do not establish a cause or fix for the intermittent initial-login failure.                                                                                                          |
| Bounded follow-up    | Validate packaged resource limits          | Agree a normal workload, overload probe, duration and latency/resource targets before running Compose/HTTPS with trading, reads, exports, live clients and login bursts. Measure container memory/OOM events, rejections, resource release, receipt recovery and final reconciliation; fix demonstrated failures and publish the supported limits. |
| Deferred maintenance | Define ephemeral-record retention          | Establish explicit age/reference rules before deleting expired authentication records or unused previews. Preserve used previews, receipts, journal, audit and recovery evidence. Prioritize implementation if measured growth or operator use warrants it.                                                                                        |

The resource question is concrete but still open: the recorded 479.06 MiB peak came from a 3.804-second development-process workload, whereas the packaged API has a 512 MiB/one-CPU limit. Those are different measurement contexts and do not establish an OOM failure or a supported capacity. The load plan must retain the current HTTP protections: 600 requests/minute per client IP and 20/minute on rate-limited authentication routes. A single-IP driver cannot sustain the earlier proposed 20 commands/second through those limits; disclose client topology and distinguish expected throttling from ordinary-workload failures.

The reviewer launcher, focused checks, current screenshots, walkthrough and case study supply the showcase entry point. The [v0.1.0 notes](releases/v0.1.0.md) define the initial release scope. The release gate is a reviewed, reproducible version with green CI and disclosed startup-check results; the separate capacity exercise is pending. Microservices, brokers, additional markets/order types, external monitoring storage and a diagnostics dashboard remain deferred until a measured or accepted product requirement justifies them. A hosted demo remains outside the chosen delivery.

## Review the project locally

Use Node.js 24 and pnpm 10.22.0. The shortest reviewer path opens the actual development application with isolated trader and administrator sessions:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm portfolio:serve
```

On Linux, install browser system dependencies with `pnpm exec playwright install --with-deps chromium` when needed. PostgreSQL initializes as a normal, non-root user. The launcher starts temporary PostgreSQL, an isolated schema, the API and Vite on loopback. It seeds two synthetic participants through ordinary APIs, then transfers genuinely issued session cookies in memory to separate Chromium contexts. It writes no browser authentication files in the normal launch. No Docker, account setup or manual cookie import is needed. `TEST_DATABASE_URL` is refused before connecting; unset it for this disposable demonstration.

The trader opens on the seller's partially filled 0.4 BTC-SIM order at 50,000 USD-SIM: 0.1 has executed and 0.3 remains reserved. Inspect the order, cancel the remainder, and check **History**. The administrator opens the control room with the simulator stopped. Pause trading to inspect controls and finite simulator inventory; resume for ongoing synthetic trading. Closing either demo window or pressing Ctrl+C closes both windows, stops the owned services and removes its schema and temporary database. The persistent development database is untouched.

To automate that same reviewer path without visible windows:

```sh
pnpm portfolio:serve --headless --smoke
```

The smoke run verifies both authenticated roles, seeded fill and cancellation, released balances, retained execution history, and administrator pause/start/inventory/stop controls, then exits and cleans up. `--headless` and `--smoke` must appear together. It does not measure load or replace packaged HTTPS acceptance.

For a persistent installation, follow [development setup](DEVELOPMENT.md#prerequisites-and-setup). `pnpm admin:setup` and `pnpm dev` retain development PostgreSQL between runs. The self-host package below is a separate deployment artifact.

Run `pnpm check` for type checking, formatting, unit/integration/browser tests and the web build; `pnpm demo` prints the controlled accounting example without opening the UI. These wrappers create isolated temporary PostgreSQL clusters; CI uses its separate PostgreSQL service. Browser tests run actual development pages and APIs in independent schemas, including lost responses and real preview expiry. Process-loss tests send `SIGKILL` at known transaction boundaries.

The [operator runbook](OPERATIONS.md) explains how to correlate a browser's `X-Request-Id` with committed command outcomes and inspect the administrator-only diagnostic snapshot. This demonstrates maintainability without requiring a hosted metrics service. Diagnostics verification is separate from the previously recorded workload, restore and Compose acceptance results below; the new instrumentation does not establish additional hosting capacity.

## Walkthrough

Use two browser profiles for the two traders. Keep the simulator stopped for the exact arithmetic demonstration.

1. Create the administrator with `pnpm admin:setup`, start `pnpm dev`, and sign in. Invite two traders and redeem their links in separate profiles. Each receives 1 BTC-SIM and 100,000 USD-SIM.
2. Resume trading. The seller reviews and places a limit sell for 0.4 BTC-SIM at 50,000 USD-SIM. The buyer purchases 0.1 at that price. Inspect the seller's partial fill, 0.3 remaining quantity, and both 5 USD-SIM fees.
3. Cancel the seller's remainder. The seller finishes with 0.9 BTC-SIM and 104,995 USD-SIM; the buyer with 1.1 BTC-SIM and 94,995 USD-SIM. Neither retains a reservation for those orders, and the fee account holds 10 USD-SIM.
4. Inspect each order's executions and linked balance activity. Export the account files or the administrator's complete session bundle; keep its manifest with the CSV files.
5. Pause the market. Review **Start a new session**, enter a reason, and confirm the full old session identity. Both traders move to the new paused session with fresh allocations. In **History**, select the old archive and verify the earlier final balances and canceled order.
6. Start the simulator and resume. Its ordinary orders create synthetic liquidity and executions. Review a protected market order's fixed guard and estimates; expiry requires a fresh review. More one-minute candles require trading in more real minutes.

The source browser scenarios reproduce the rollover, archive, pagination, export, and lost-acknowledgement portions automatically:

```sh
pnpm test:browser --grep 'rollover|complete history'
pnpm test:integration tests/integration/session-lifecycle.test.ts tests/integration/session-repair.test.ts
```

![Trading and exact partial-fill accounting](screenshots/trading-workspace.png)

![Read-only archive with preserved final balances](screenshots/archived-session.png)

Screenshots come from isolated browser-test accounts and virtual funds. They contain no invitation, recovery, password, or authentication secrets. To refresh them deliberately, run the matching rollover browser scenario with `CAPTURE_PORTFOLIO_SCREENSHOTS=1`; ordinary CI does not rewrite tracked images.

### Recorded walkthrough and current screenshots

The [silent trader walkthrough](media/trader-walkthrough.webm) is a continuous 110-second browser recording. It shows the seeded partial fill, exact order detail, reviewed cancellation of only the remainder, released reservations, and retained execution/order history. Download/open the WebM if the repository viewer does not play it. Setup and authentication happened off camera; the 0.4 sell and 0.1 buy at 50,000 were accepted through the ordinary API. The simulator stayed stopped throughout this clip. There are no playback-speed changes or manufactured financial records.

The README's [trader image](screenshots/trader-demo.png) and [administrator image](screenshots/admin-simulator.png) show the same isolated demonstration after enabling the two-account simulator through the administrator UI. Its scheduler accumulated executions across real UTC minutes; empty minutes remain empty. The administrator view shows the actual controls, inventory and finite-funding previews. The earlier exact-accounting/archive screenshots above remain separate examples.

The default reviewer launcher above is also the easiest way to inspect the current interface. For deliberate screenshots or a recording tool that needs storage-state files, opt into capture mode:

```sh
pnpm portfolio:serve --no-open
```

This opens no browser. The printed `output/playwright/portfolio-private-*/trader.json` and `admin.json` paths are private Playwright storage-state capabilities: load each into its own isolated browser context on the printed origin, then visit `/trade` or `/admin`. Never publish those files, a trace, or a credential handoff. This explicit mode cannot combine with `--headless` or `--smoke`. Use a 1440-pixel desktop viewport, capture only application content after authentication, and start the simulator only after completing the arithmetic/cancellation example. Allow several real minutes for a representative chart.

Stop with Ctrl+C. The runner closes its development servers/simulator, removes its generated schema and private browser state, and stops its owned temporary database. It refuses `TEST_DATABASE_URL`; unset that variable before starting this fully disposable demonstration. Reviewed public images and video live under `docs/`; intermediate captures remain ignored under `output/playwright/`. The [case study](CASE_STUDY.md) links the visible flows to source, failure tests, tradeoffs and measured limits.

## Self-host package

`Dockerfile` supplies API, web/proxy, and owner-operated verification targets. `compose.yaml` supplies PostgreSQL with persistent storage, a one-shot migration service, the API, and a Caddy frontend serving the built React application. PostgreSQL and the API have no published host ports. The browser uses one HTTPS origin for static files, cookies, HTTP commands, and SSE.

Base images are pinned by version and digest. Workspace dependencies install from the frozen lockfile. The exact TypeScript loader version is a server production dependency, so its complete dependency graph comes from that lockfile in both API and operations images. Commands use `node --import ./apps/server/node_modules/tsx/dist/loader.mjs`; there is no global loader installation. The pinned global pnpm bootstrap installs the workspace. Owner credentials belong only to migration and explicitly invoked operation tooling. The application runs as an unprivileged container user and uses a separate restricted database role. Its startup verifies migration names, checksums, and metadata structure rather than running DDL. Administrator creation and credential recovery remain interactive owner commands with hidden password entry; no universal administrator credentials are installed.

Generated configuration and secrets live under ignored `.local/self-host/`. Preparation requires an explicit HTTPS origin and refuses an existing target directory without changing its files or permissions. Keep these files and persistent volumes private. Use a hostname you control, with DNS and ports configured for that machine. Caddy obtains the certificate for the configured hostname. For owner-local verification, `localhost` uses Caddy's private development authority; trust its exported root certificate explicitly in the client rather than disabling certificate verification. `selfhost:prepare <https-origin> --directory <fresh-relative-directory>` supports a separate installation; use that directory's generated `compose.env` for every Compose command.

```sh
pnpm selfhost:prepare https://exchange.example
# Use the real HTTPS origin for your installation in the command above.
docker compose --env-file .local/self-host/compose.env build
docker compose --env-file .local/self-host/compose.env up -d postgres
docker compose --env-file .local/self-host/compose.env run --rm migrate
docker compose --env-file .local/self-host/compose.env run --rm operator setup
docker compose --env-file .local/self-host/compose.env up -d api web
```

Run operator setup in an interactive terminal and choose your own administrator credentials. `.local/self-host/compose.env` contains the public origin/host/port settings; actual database secrets are separate private files. A custom HTTPS port is preserved by the HTTP redirect. Local testing can bind `BIND_HOST=127.0.0.1` and select unused ports in that private environment file.

To upgrade, back up first, stop the API/web, rebuild, run `migrate`, then restart. Older names-only installations require the explicit adoption procedure below. Run `operator reset` only for owner-authorized administrator credential recovery while the API is stopped. Ordinary `docker compose down` retains volumes; removing them is a separate destructive action. Back up database contents and the private connection configuration through your own protected backup process.

The product's image tags use `spot-exchange-simulator`. Existing installations should retain their checkout directory or explicit Compose project name when adopting the renamed repository, so Compose continues to use the same persistent volumes. Existing credentials, database roles, and financial records remain compatible.

The deployment trusts exactly one private proxy hop for client authentication throttling. Caddy sanitizes forwarded client headers; keep the backend port private and retain the default zero-hop setting when running a direct development API. The runtime database role cannot create/alter/drop schema objects, rewrite migration metadata, or assume an owner role. Provisioning rejects a pre-existing role that owns objects rather than silently claiming it is restricted.

The latest update requires `010_migration_checksums`. It adds checksum provenance and constraints to migration metadata without rewriting financial rows. The additional version marker makes earlier runtimes reject the upgraded installation. The migration service also reprovisions the runtime role with updates limited to the five execution fields and no order deletion/truncation privilege. Earlier migration 009 adds read indexes without rewriting financial rows. Index creation runs with the API stopped under the owner maintenance budget; a large existing installation may require a rehearsed maintenance window. Prepared CSVs use the private disk-backed `history_exports` volume; its contents are temporary, excluded from database backups, and removed on restart. Do not move this volume to `/tmp` tmpfs when assessing container memory. Earlier migration `007_command_timestamps` changes future command timestamp defaults. Database budgets, transport disposal, and the 25-second process shutdown deadline are documented in [architecture](ARCHITECTURE.md#database-budgets-and-shutdown). Retain Compose's 30-second stop grace period. A forced shutdown or lost commit reply requires original-command recovery after restart; it does not justify manually releasing writer locks or deleting receipts.

Operational diagnostics requires no new migration, volume, monitoring account or configuration secret. Its aggregates reset with the API process. Keep API stdout collection bounded and inspect `diagnostics.dropped_events` before assuming a log search is complete; do not enable request-body, raw SQL or transport tracing to compensate for dropped events. Database authentication is still required to read `/api/admin/diagnostics`, so the [runbook](OPERATIONS.md) also covers failures where that endpoint cannot respond.

### Adopt a names-only installation

Fresh installations record checksums automatically. Existing installations that only recorded migration names stop with `MIGRATION_ADOPTION_REQUIRED`; startup never backfills hashes silently. Rehearse this process on a restored backup before upgrading an installation you need to preserve.

1. Back up the database and matching private configuration. Stop the API/web and rebuild the images.
2. Using your private owner connection, inspect `SELECT name, applied_at FROM schema_migrations ORDER BY name`. The names must be a complete known prefix. Select its final name as the explicit baseline; for the previously published large-session release this is `009_large_session_reads`.
3. Run the owner migration service with that baseline:

```sh
MIGRATION_LEGACY_BASELINE=009_large_session_reads docker compose --env-file .local/self-host/compose.env run --rm migrate
docker compose --env-file .local/self-host/compose.env up -d api web
```

The owner compares the installed application schema with a scratch schema built from the pinned migration prefix on the same PostgreSQL server. It checks structural catalog evidence, including columns/defaults, constraints, indexes, triggers, functions, sequence definitions/ownership, types, rules and policies. Data, database owners, privileges and comments are excluded; migration metadata has a separate shape check. Additional application-schema objects or altered definitions fail adoption. SQL string literals and function bodies retain their original semantics during namespace comparison.

Adoption preserves the original `applied_at` values and records canonical hashes with `LEGACY_SCHEMA_VERIFIED` provenance and a new verification time. New migrations use `APPLIED` provenance. This proves structural equivalence at adoption, not which SQL was executed in the past. Hashes, adoption and subsequent migrations commit atomically. If the reply is lost, retry the same baseline; the adopted prefix must still match. Remove the baseline setting after success. Do not leave it in runtime configuration.

`MIGRATION_LEGACY_BASELINE_MISMATCH`, `MIGRATION_SCHEMA_MISMATCH`, `MIGRATION_METADATA_INVALID`, `MIGRATION_HISTORY_INVALID` and checksum/source mismatches require inspection, not forced hash replacement. A failed adoption leaves existing records intact. Compare with the restored backup and the pinned release; do not delete migration records, disable guards or recalculate old hashes to bypass a failure. Owner commands refuse an active writer with `OWNER_WRITER_BUSY`.

For the persistent development cluster, stop `pnpm dev`, then use `MIGRATION_LEGACY_BASELINE=009_large_session_reads pnpm db:migrate` and restart `pnpm dev`. Use the actually installed final name if it is an earlier supported prefix. `pnpm db:migrate` also supports an owner `DATABASE_URL` supplied privately in the process environment. Ordinary future upgrades use the same command without the legacy setting.

The independently [frozen 008 installation](../tests/fixtures/historical/README.md) exercises this owner path with records created by the historical application, exact PostgreSQL numeric/timestamp evidence, and original receipts. It is a synthetic compatibility fixture, not a dump of a real installation. Regeneration is deliberate; routine tests load the committed bytes and verify their hashes.

After building API and operations images, reproduce the runtime check with `pnpm exec tsx scripts/deploy/verify-runtime.ts spot-exchange-simulator-api:local spot-exchange-simulator-operations:local`. It verifies the local locked loader, absence of global tsx, normal owner initialization, restricted production startup and an operations IPC child. It creates and removes its own isolated Docker network and containers; CI runs the same check.

The packaged proxy explicitly enables HTTP/1.1 and HTTP/2 because Compose publishes TCP only; it does not advertise an unreachable HTTP/3 endpoint. The trusted-HTTPS verifier checks this on entry, asset and missing-asset responses. Static `/assets/*` paths use file-only routing. Missing deployment chunks return 404 with `no-store`; current assets retain immutable cache headers, and SPA deep links return the entry document with `no-cache`. The React recovery screen catches failed lazy imports after the app starts, preserves pending identities, and offers an explicit reload. It cannot recover a missing initial entry script. After building the web image, reproduce the trusted-HTTPS routing regression with `pnpm exec tsx scripts/deploy/verify-assets.ts spot-exchange-simulator-web:local`. It creates and removes its own temporary container and trusts only that container's local CA; CI runs it against the CI image. CA-file creation can precede readiness of the serving certificate, so the verifier separately waits for a trusted HTTPS response within a fixed deadline. Certificate validation remains required, and the first HTTP response proceeds to the routing/content assertions without retrying failed assertions.

### Fresh Compose acceptance

The current acceptance contract requires 19 setup/HTTPS/journey checks, including administrator-only operational diagnostics, a new process window after restart and original-receipt replay signals. Four cleanup confirmations remain independently required. The [usability CI report](evidence/usability-ci-acceptance-result.json) records all 19 checks for its clean published revision; the earlier diagnostics report remains intact. Earlier 18-check local/CI reports remain intact for their original commits.

`pnpm selfhost:acceptance [api-image] [web-image]` tests the packaged application through a new, isolated Compose installation. It requires Node.js/pnpm as above, a running Docker daemon with Compose, Python 3 on Linux or macOS, and Playwright Chromium. Python's standard-library PTY bridge supplies a real terminal to the ordinary interactive owner setup command; it is only an acceptance-harness prerequisite, not an application runtime dependency. Generated administrator credentials travel through that terminal in memory, never command arguments, environment variables, or a saved transcript.

Build API and web images from the source revision being evaluated. Their `org.opencontainers.image.revision` labels must equal `git rev-parse HEAD`; the harness also checks immutable image IDs against the running containers. The default image tags are shown below. The CI run requires a clean checkout. A local dirty checkout is disclosed in the report and should not be presented as evidence for a clean published revision.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
docker build --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" --target api -t spot-exchange-simulator-api:local .
docker build --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" --target web -t spot-exchange-simulator-web:local .
pnpm selfhost:acceptance
```

The harness pulls the pinned PostgreSQL image, chooses unused loopback ports, and exclusively creates `.local/self-host-acceptance/run-<generated-id>/`. It records ownership before generating private configuration under that directory's `configuration/` subdirectory. Explicit Compose files/project/environment settings, verified bind mounts, and separately labeled volumes/networks keep it independent of `.local/self-host/`, the development database, and ambient Compose settings. Existing configuration directories and symlink parents are refused. The API retains its normal restricted database role, non-root/read-only container settings, and CPU/memory limits.

The journey runs ordinary owner migrations against the empty database, confirms no users exist, and bootstraps the administrator with `operator setup`. Isolated Chromium contexts sign in to the compiled UI and redeem invitations. Initial login observes the anonymous session response before checking the form. Its bounded bootstrap observer distinguishes entry-script transport/status failures, JavaScript exceptions, and session requests that were never issued, remain pending, or fail. Submission diagnostics separately identify handle/password fill, click, absent/pending/failed POST requests and HTTP status outcomes, with native validity/readiness booleans. Before cleanup, a failure-only, two-second inspection of the verified API container records availability, running/OOM state and bounded restart count. Failure output reconstructs only fixed categories, booleans, bounded counts and HTTP statuses; URLs, browser messages, response bodies and raw errors are excluded. The existing 12-second limits remain, requests are not retried, and observers detach on every outcome. HTTPS commands and UI interactions exercise partial filling, cancellation, exact balances/fees, CSRF, secure cookies, and SSE delivery. Native trader and administrator CSV downloads are compared with authenticated HTTPS downloads and reconciled against their manifests, hashes, row counts, exact journal totals, and role scope; cross-account export access must fail. A graceful Compose API restart must preserve sessions, accounting, original receipt lookup/replay, and automatic live resynchronization in the existing UI before a separate reload check. This restart check does not inject a crash or a lost commit reply; separate integration process-kill tests retain that coverage.

TLS checks first require Node HTTPS to validate Caddy's generated CA and the `localhost` hostname. Chromium then uses a temporary profile and an exception limited to that verified leaf certificate's public key. The exception bypasses Chromium's certificate checks for that matching key; the preceding Node validation establishes its identity. Other Node requests continue to require CA/hostname validation. No host trust store is changed, and no global browser `ignoreHTTPSErrors` setting is used.

An eight-minute run deadline and interruption handlers lead to separately bounded cleanup. Cleanup inventories exact containers, volumes, and networks for the generated project, verifies an independent ownership label before deletion, and checks they are gone before removing the private run directory. It does not use mutable Compose files to select deletion targets or perform a global prune. If Docker inspection or removal cannot be confirmed, private files remain for a retry:

```sh
pnpm selfhost:acceptance:cleanup
```

This fallback reads validated ownership records only beneath `.local/self-host-acceptance/`; each recorded run has a 90-second cleanup budget. CI runs it with `if: always()` after the acceptance step. An uncatchable process/runner loss can still require this command on a persistent host. Cleanup success is independently required for a passing acceptance result.

Transport-debug and TLS-key-log environment settings are refused before credentials or browser traffic are created. The harness atomically writes `.local/operations/self-host-acceptance-result.json` after cleanup. Its fixed allowlist contains source commit/dirty state, image IDs/revision labels, check results, failure stage, cleanup results, and the disclosed TLS/test scope. It contains no generated origin/ports, credentials, cookies, invitation links, actor IDs, local paths, terminal transcript, screenshots, traces, or raw errors. CI uploads only that file as `self-host-acceptance-report`, with seven-day retention; private run files are never uploaded. A process/runner terminated before report creation cannot supply a report and must not be treated as a passing result.

### Bounded startup checks

After building the source-labeled API/web images above, run:

```sh
pnpm selfhost:startup-checks
```

The default batch runs five independent fresh Compose installations and the full HTTPS journey, rather than retrying a failed login in one installation. Each run must pass all 19 setup/journey checks and all four cleanup confirmations. Source, image revision labels and immutable API/web image IDs must agree throughout the batch. The first failed run stops the batch; later successes cannot hide it. The existing eight-minute per-journey deadline remains, with a shared ten-minute work deadline across the batch. Expiry or interruption aborts the active journey and enters separately bounded cleanup, which can require up to a further 90 seconds.

`pnpm selfhost:startup-checks [api-image] [web-image] --runs=N` selects explicit images or a smaller local probe of one to five runs. The report discloses the requested count: a one-run probe is not five-run release evidence. Use the default five-run command for release verification. Run from a clean checkout for published-source evidence.

The allowlisted aggregate is `.local/operations/self-host-startup-checks-result.json`; the standalone acceptance report is preserved. It records the requested/completed batch and each run's sanitized result, source/image identity, check and cleanup outcomes, and fixed failure diagnostics. It excludes generated origins, credentials, actor identifiers, local paths, transcripts, traces, screenshots and raw errors. CI runs the default batch after standalone acceptance and uploads only this file as `self-host-startup-checks-report` with seven-day retention. Review the report before deliberately retaining a public copy; never publish private run directories. Use `pnpm selfhost:acceptance:cleanup` for any recorded leftovers after an uncatchable process loss.

The first reviewer publication (`eb8279c`, Actions run `38729625168`) passed standalone acceptance and the first batch installation, then stopped on administrator sign-in submission during installation two; cleanup passed. Earlier CI initial-login failures remain an unresolved intermittent issue. The bootstrap observer distinguishes script, runtime and session-request outcomes without changing the 12-second waits or retrying requests. A completed five-run batch establishes those five executions only; it neither explains the previous failure nor establishes a failure rate, sustained capacity or universal startup guarantee.

## Operational evidence

A backup exercise restores a PostgreSQL custom-format dump into a new database, compares retained records, reopens the exchange, reconciles accounting, and replays original trading and rollover receipts. Temporary verification databases and files are owned by that exercise. A successful application-process restart alone is a different guarantee from a verified database restore.

Use PostgreSQL 18 `pg_dump`/`pg_restore` for `pnpm ops:restore`; `PG_DUMP_BIN` and `PG_RESTORE_BIN` select explicit compatible client binaries. The operations image includes matching tools:

```sh
docker compose --env-file .local/self-host/compose.env --profile tools build operations
mkdir -p .local/operations
docker compose --env-file .local/self-host/compose.env --profile tools run --rm --user "$(id -u):$(id -g)" operations
BENCHMARK_PAIRS=1000 pnpm ops:benchmark
pnpm ops:benchmark:session
pnpm ops:benchmark:charts
```

The Docker restore exercise uses the configured PostgreSQL service to create fresh generated databases, then removes those databases after verification. It does not restore over an existing installation. Running the container with the operator's UID/GID keeps its private files readable by that operator on Linux. Reports and the private generated fixture dump are retained under ignored `.local/operations/`. Commit only the reviewed, sanitized JSON evidence; never commit a database dump or its authentication material.

The reproducible workload measures committed matching commands against real PostgreSQL, reports latency and throughput for its explicit configuration, and checks financial reconciliation and receipt replay. It identifies the runtime, platform, workload, and concurrency without machine or user identifiers. Results establish the measured workload only; they do not claim general hosting capacity, internet latency, or real-money readiness.

## Recorded local operational results

The reviewer release candidate `9a3545a` passed five independent clean-source Compose/HTTPS installations on macOS/Docker with Node.js 24 and PostgreSQL 18.4. The [reviewed startup report](evidence/reviewer-startup-checks-result.json) preserves matching source/image identities, all 19 acceptance checks and all four cleanup confirmations for each run. Independent Docker inventory afterward found no acceptance-labeled containers, volumes or networks. A separate clean tracked-source archive installed with the documented frozen lockfile and passed the headless reviewer smoke, then its temporary checkout was removed. Local regression validation passed all 228 unit tests, 226 PostgreSQL tests and 29 Chromium scenarios; headed role windows and window-close cleanup were also checked. These results do not reproduce or explain the earlier intermittent login failure. Check the final selected revision's Actions result for remote Linux verification.

The 2026-10-15 usability/presentation validation passed all 185 unit/property/client tests, 226 PostgreSQL tests and 25 Chromium scenarios, plus type checking, formatting and the web build. The new exact-candle, history, credential/recovery and keyboard regressions use temporary PostgreSQL and development pages. The isolated portfolio runner passed real setup/interrupt cleanup, and its external-database refusal is a regression. Current screenshots and the 109.6-second recording were visually reviewed; preparation and capture scope are disclosed above. The runner interruption and media reviews remain local checks; remote Linux verification for the published usability revision is recorded under MVP acceptance below. These checks do not establish sustained capacity.

The 2026-10-15 diagnostics validation built all three self-host images. After the publication-time verifier repairs, a clean-source local run of `6a41337` passed all 19 Compose HTTPS checks and all four cleanup confirmations, including administrator-only diagnostics, a new process observation window after restart and original-receipt replay signals. CI checks were enabled and API/web revision labels matched the source. This supersedes the initial uncommitted local diagnostic run; the earlier retained reports below preserve their original 18-check scope. Remote Linux evidence is recorded separately under MVP acceptance. No sustained-load workload was remeasured.

The 2026-10-15 [fresh Compose acceptance report](evidence/self-host-acceptance-result.json) records a clean-source local run of commit `e2e128c` with CI checks enabled. All 18 setup/HTTPS/journey checks and all four cleanup checks passed; the running API/web image IDs and revision labels matched that source. All three image targets rebuilt successfully. A separate real SIGTERM before browser traffic produced a failed report with every cleanup check verified, and the fallback cleanup command passed again with no recorded runs left. These are local macOS/Docker results. The earlier operational results below retain their original scope; the remote Linux run is recorded separately in the acceptance evidence below.

The 2026-10-14 [self-host report](evidence/container-smoke-result.json) records actual container builds and HTTPS requests through Caddy using an explicitly trusted local CA. It covers deep-link routing, secure cookies, CSRF, invitations, protected market execution, exact accounting, SSE proxy delivery, rollover, archives, and original receipt replay. The API's non-root user and restricted database connection were checked separately. Test-owned containers and volumes were removed afterward.

The [restore report](evidence/restore-result.json), refreshed for checksum/runtime hardening using the operations image and PostgreSQL 18 tools, compared all 22 tables and ten applied migrations before reopening the restored writer. Its generated fixture includes three users, redeemed and pending invitations, a recovery token, a grant, both simulator accounts, a protected market preview/use, a completed rollover, and old/new-session financial records. Login, preview preservation, original order/rollover receipts, and reconciliation passed after restore. The fixture dump itself is private and excluded from Git.

The [workload report](evidence/benchmark-result.json) used Node.js 24.19.0, PostgreSQL 18.4, and an Apple M1 Pro with 10 logical CPUs and 16 GiB memory. Ten warmup pairs per caller were excluded; each measured caller then submitted 1,000 limit sell/buy pairs. These are direct core calls with matching, journal writes, and database commit included.

| Concurrent callers | Measured commands | Duration | Commands/second | p50       | p95       | p99       |
| ------------------ | ----------------- | -------- | --------------- | --------- | --------- | --------- |
| 1                  | 2,000             | 6.37 s   | 313.89          | 3.091 ms  | 4.743 ms  | 6.711 ms  |
| 4                  | 8,000             | 33.60 s  | 238.09          | 16.145 ms | 26.418 ms | 34.756 ms |

All measured commands were accepted, with zero errors, successful financial reconciliation, and identical receipt replay after reopening the writer. Four concurrent callers increased latency and reduced observed throughput, exposing contention at the serialized boundary. These short runs measure the disclosed workload; HTTP, password hashing, TLS, live clients, sustained load, and saturation behavior are separate measurements. Use the scripts and method to reproduce results, rather than treating these figures as a deployment capacity promise.

The [candle comparison](evidence/candle-result.json) uses 105,000 synthetic fills across 5,001 populated UTC minutes, including a 5,000-fill burst in the latest minute. It measures a minimal table with production numeric types and sequence indexes, independently of the accounting workload. Both queries returned exactly the same 60 OHLCV rows. The fixture was vacuumed before measurement, allowing index-only scans; newly written live pages may require heap fetches. Five warm query samples produced p50/p95 of 28.520/31.589 ms for the old full-session aggregate and 1.852/1.999 ms for the indexed query. EXPLAIN reported 105,000 versus 6,360 rows at fill scan nodes and 277 versus zero temporary blocks written. The added covering minute index occupied 9,052,160 bytes (about 8.6 MiB). It trades storage and additional index maintenance for less historical read work. Every fill in a selected minute is still processed; a very large recent burst remains real work. These are local query measurements, with the fixture and limitations recorded in the report, rather than general deployment capacity.

The [large-session HTTP report](evidence/large-session-benchmark-result.json) seeds 10,001 real matched pairs (20,002 accepted orders) outside measurement, with a disclosed paused-market inventory grant. Its mixed phase runs the API in a separate development process and sends 275 actual loopback HTTP requests: 200 order commands, 30 workspace/chart reads, 30 history pages, two export preparations, and 13 streamed downloads, alongside two authenticated SSE clients. The default run completed in 3.804 seconds with zero errors/timeouts. Order, workspace/chart, and history p95 were 57.998, 73.591, and 53.298 ms. The two export preparations took 1.173 and 1.604 seconds; two samples do not establish a general latency percentile. The administrator activity CSV contained 90,019 rows and 14,552,024 bytes, and the trader export included 10,001 orders and fills. Independent snapshot row counts, exact balances reconstructed from the immutable journal prefix, byte counts, and hashes all matched. Both live clients caught up with every measured commit; reconciliation and original HTTP receipt replay passed after terminating and reopening the API process.

API RSS peaked at 479.06 MiB from a warm 333.78 MiB baseline; the separate driver peaked at 214.16 MiB. Sampling was every 50 ms. Authentication memory remains in the API baseline; PostgreSQL, operating-system cache, and browser memory are excluded. This local workload leaves modest headroom against the Compose API's 512 MiB limit and does not certify that limit for a different host or heavier workload. TLS, remote latency, password-hashing concurrency, sustained load, and saturation are separate measurements. The report's historical candle comparison uses an explicitly synthetic fixture; real trading timestamps were not altered. Both benchmark commands create and remove generated schemas, preserve existing application data, and write sanitized evidence under ignored `.local/operations/`.

## MVP acceptance evidence

Use the scenario definitions in [MVP release acceptance](MVP.md#release-acceptance-criteria). The table identifies evidence to inspect, rather than treating a test count as complete product acceptance.

| Criteria                              | Evidence                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A01 fresh installation                | Fresh Compose owner setup and compiled HTTPS invitation/trading acceptance; earlier smoke report and development-browser workflow      |
| A02 invitations and ownership         | API/auth integration tests, scoped history/export tests, invitation browser workflow                                                   |
| A03–A04 partial fill and cancellation | Trading integration tests, trader browser workflow, exact walkthrough above                                                            |
| A05 ordering and self-trade           | Domain examples/properties and PostgreSQL trading/market-order tests                                                                   |
| A06 guarded execution                 | Market-order domain/integration tests and protected-market browser scenarios                                                           |
| A07 reservations and fees             | Domain conservation/split-fill properties and concurrent reservation integration tests                                                 |
| A08 retry and recovery                | Original receipt replay after graceful Compose API restart, separate actual process-kill tests, reload/retry scenarios and restore     |
| A09 operator controls                 | Auth/admin recovery and simulator integration tests; administrator browser workflow                                                    |
| A10 simulator lifecycle               | Simulator/core integration tests and audited controls/inventory/funding browser workflow                                               |
| A11 rollover                          | Session lifecycle/reconciliation tests, three rollover process-kill boundaries, and live transition/archive browser workflow           |
| A12 market truth                      | Workspace/candle tests and simulator browser scenarios; empty/sparse states and exact textual OHLCV data                               |
| A13 explainability and export         | Order/account inspection, complete history and URL navigation; native trader/admin HTTPS CSVs with exact totals and scope checks       |
| A14 developer onboarding              | Documented HTTP examples and API route/authorization integration tests                                                                 |
| A15 fault and rollover boundaries     | Gated enrollment/funding/reinstatement tests, faulted-transition repair/retry tests, access-revocation checks                          |
| A16 coherent live export              | Concurrent-commit export test with one Repeatable Read snapshot, exact balance/fee totals, role scopes, and recorded manifest boundary |

The archive browser scenario also verifies a 390 × 844 viewport without document overflow, a history workspace that fills the available width, readable session/export/pagination controls, and Escape restoring focus after closing read-only order details. The packaged HTTPS acceptance journey supplements the development-browser scenarios; the earlier smoke report remains separate evidence. Local verification is recorded in [development evidence](DEVELOPMENT.md#evidence-and-limitations). The public repository's **Actions → Verify Spot Exchange Simulator** view records remote Linux runs against their exact commits, including image builds and downloadable sanitized acceptance/restore reports. Check that commit's result when evaluating a release.

GitHub Actions run `38722272133`, attempt 2, passed on Linux for published usability commit `2852554` on 2026-10-15: 185 unit/property/client tests, 226 PostgreSQL tests, 25 Chromium scenarios, all three image builds, trusted-HTTPS asset/runtime checks, fresh Compose acceptance and cleanup, and the PostgreSQL restore. The [reviewed usability CI acceptance report](evidence/usability-ci-acceptance-result.json) records matching clean source/image revisions, all 19 checks and all four cleanup confirmations. Its ZIP matched GitHub's published SHA-256 and contained only the expected allowlisted JSON file. Both acceptance and restore artifacts uploaded successfully. The first attempt failed at initial packaged login; the unchanged successful rerun and successful local verification do not establish its cause. Subsequent harness changes add fixed bootstrap diagnostics and regressions without increasing timeouts or retrying requests; see [development evidence](DEVELOPMENT.md#evidence-and-limitations).

Earlier retained reports preserve their original source and scope:

| Source / Actions run      | Unit / PostgreSQL / Chromium | Acceptance                            | Retained report                                                  |
| ------------------------- | ---------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `6a41337` / `38714709831` | 173 / 226 / 16               | 19 checks; four cleanup confirmations | [Diagnostics CI](evidence/diagnostics-ci-acceptance-result.json) |
| `f5888a9` / `38696489380` | 138 / 200 / 13               | 18 checks; four cleanup confirmations | [Original CI](evidence/self-host-ci-acceptance-result.json)      |

Both earlier runs passed image builds, HTTPS asset/runtime checks and PostgreSQL restore. Their downloaded archive digests and allowlists were verified before retention. Retained reports outlive CI artifact expiry; none extends graceful restart into a crash, sustained-capacity or real-money guarantee.

## Contributing

Keep financial amounts exact, preserve durable command identities, and make ownership/session checks part of the transaction boundary. Add tests for changed guarantees and keep the MVP, architecture, API, and development docs consistent. Run `pnpm check` before proposing a change. Use development mode for ordinary local work.

Before adding files, verify that Git tracks no `.local`, `.env`, database dump, password, cookie, token, or generated test artifact. The committed screenshots use test-only identities. The public repository contains an original interface, the accepted architecture tradeoffs, runnable examples, verification scripts, and the MIT license. Keep generated local configuration private when sharing your own installation.
