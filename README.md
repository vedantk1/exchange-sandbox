# Spot Exchange Simulator

A self-hostable simulated spot exchange for developers and technical learners. Trade virtual BTC-SIM / USD-SIM and inspect how orders, fills, fees, and balances change. Real money, custody, and external exchange connections are outside scope.

The application includes a browser trading workspace, an administrator control room, invitation-only authentication, and a transactional exchange core. Live updates keep orders, balances, and market views synchronized with committed PostgreSQL state.

[Read the engineering case study](docs/CASE_STUDY.md) · [See the architecture](docs/ARCHITECTURE.md)

Three engineering decisions to inspect:

- **Exact accounting and recoverable commands.** Integer amounts, a double-entry journal, and atomic receipts preserve the original financial outcome across retries and process loss. [Implementation and failure tests](docs/CASE_STUDY.md#exact-amounts-and-one-durable-command-identity).
- **A deliberate PostgreSQL consistency boundary.** Serialized mutations keep matching, reservations, and accounting atomic; committed snapshots serve concurrent reads. [Tradeoffs and measured contention](docs/CASE_STUDY.md#why-postgresql-owns-the-consistency-boundary).
- **A measured historical-query improvement.** Identical complete candles on a disclosed 105,000-fill fixture, with warm SQL p50 reduced from 28.520 ms to 1.852 ms. [Method, index cost, and limits](docs/CASE_STUDY.md#a-measured-historical-query-improvement).

## Try the reviewer demo

Use Node.js 24 and pnpm 10.22.0, as pinned in `.nvmrc` and `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm portfolio:serve
```

This opens two Chromium windows: an authenticated trader and administrator, each in an isolated browser context. No credential entry or browser-state import is needed. It runs the API and Vite in development mode against temporary PostgreSQL; Docker and an existing database are not required. It refuses `TEST_DATABASE_URL` so the demo cannot use an existing test installation. On Linux, use `pnpm exec playwright install --with-deps chromium` if browser system dependencies are missing.

The trader starts with a real partial fill: 0.1 BTC-SIM sold from a 0.4 order at 50,000 USD-SIM, with the 0.3 remainder reserved. Inspect the order, cancel its remainder, and check the released funds and retained execution in **History**. In the administrator window, inspect controls, pause trading, and start the simulator to review its inventory. Resume trading for ongoing synthetic executions; several real minutes produce multiple one-minute candles.

Close either demo window or press Ctrl+C to stop both windows and servers and remove the temporary database. Nothing is added to the persistent development installation. The [reviewer guide](docs/RELEASE.md#review-the-project-locally) explains the automated smoke check, capture mode and longer walkthrough.

## Run a persistent development installation

After installing dependencies, create your own administrator and start the development services:

```sh
pnpm admin:setup
pnpm dev
```

Open `http://localhost:3000`. Setup prompts for the administrator handle and a password without echoing it. The first session starts paused, and the development runner retains PostgreSQL data between runs.

For a Docker deployment with HTTPS, persistent storage, and restricted database access, follow the [self-host guide](docs/RELEASE.md#self-host-package).

Sign in as the administrator, create invitations, and privately hand the single-use links to participants. After they join, resume trading with a recorded reason. For manual trading, use separately signed-in browser profiles to place a resting sell and a crossing buy, then inspect their fills and exact balance changes.

For ongoing synthetic activity, use **Start simulator** in the administrator overview, give a reason, and resume trading. Two automated accounts place ordinary orders in the shared book. Their executions build the chart; allow several minutes for multiple one-minute candles. Inspect inventory and per-order funding shortfalls in the same panel. Pause the market before granting more virtual funds. **Stop simulator** cancels only the automated accounts' remaining orders and preserves completed trades. Application restarts retain the enabled/stopped setting and never refill inventory. See the [development guide](docs/DEVELOPMENT.md#market-simulator).

For an isolated matching demonstration and the full validation suite:

```sh
pnpm demo
pnpm exec playwright install chromium
pnpm check
```

The demo, integration, and browser test runners start real, temporary PostgreSQL 18 instances on loopback. Docker and an existing database are not required. Temporary database data is removed after the command finishes. The [development guide](docs/DEVELOPMENT.md) explains persistent databases, individual checks, and recovery tests.

## What you can try

- Review limit and protected market orders, follow partial fills, cancel remainders, and inspect exact reservations and fees. Market previews bind a 5% price guard and expire after 10 seconds.
- Read internal execution candles visually or as an exact UTC table. Sparse and empty history are explained explicitly.
- Operate the two-account simulator, review inventory/funding shortfalls, and pause, resume, or stop it through audited administrator controls.
- Rotate credentials, issue invitations and recovery links, suspend access, and inspect participant accounts.
- Roll over sessions, revisit read-only financial archives, filter complete history, and download scoped CSV bundles from a coherent snapshot.
- Inspect recovery, migration/restore evidence, and bounded private diagnostics. The [acceptance map](docs/RELEASE.md#mvp-acceptance-evidence) links product flows to their tests.

The architecture is a modular monolith with PostgreSQL as the authority. The [case study](docs/CASE_STUDY.md) explains the choices; the [release guide](docs/RELEASE.md) records workload, restore, and self-host evidence with their limits.

## Continuous integration

The [GitHub Actions workflow](.github/workflows/ci.yml) checks every push and pull request on Linux: frozen dependency installation, type checking, formatting, unit tests, PostgreSQL integration tests including the frozen upgrade, the web build, Chromium browser flows, the disposable reviewer smoke, all three self-host image targets, trusted-HTTPS asset routing, locked production/operations loader startup, fresh Compose acceptance with HTTPS trading/exports and graceful API restart recovery, five further fresh startup journeys, and a fresh PostgreSQL restore. Use the repository's **Actions** tab to inspect the result for the exact published commit. It retains sanitized acceptance, startup-batch and restore reports for seven days. The separate development-browser suite retains failure traces/screenshots; packaged acceptance records no raw browser artifacts or terminal transcripts.

To reproduce the packaged acceptance journey locally, follow [fresh Compose acceptance](docs/RELEASE.md#fresh-compose-acceptance). It requires Docker Compose, Python 3, Chromium, and API/web images labeled with the current Git revision. Run `pnpm selfhost:acceptance [api-image] [web-image]`; `pnpm selfhost:acceptance:cleanup` retries cleanup of recorded test-owned runs.

For the bounded five-installation release exercise, use `pnpm selfhost:startup-checks [api-image] [web-image]`. It stops on the first failure and writes a sanitized aggregate; see [startup checks and their limits](docs/RELEASE.md#bounded-startup-checks).

The [release verification summary](docs/RELEASE.md#release-verification) records the published source, retained evidence and measurement limits. [Development validation](docs/DEVELOPMENT.md#evidence-and-limitations) explains the test layers and how to reproduce checks.

## Project documentation

- [MVP features and user flows](docs/MVP.md): accepted product rules and full-release acceptance criteria.
- [Engineering case study](docs/CASE_STUDY.md): decisions, failure recovery, measured improvements, and limits.
- [System architecture and stack](docs/ARCHITECTURE.md): accepted design, alternatives, boundaries, and future work.
- [Development and validation](docs/DEVELOPMENT.md): local commands, core API, persistence, and test evidence.
- [HTTP API](docs/API.md): routes, authentication, request examples, and retry behavior.
- [Operations and troubleshooting](docs/OPERATIONS.md): private diagnostics, signal interpretation, and safe recovery steps.
- [Release and walkthrough](docs/RELEASE.md): reviewer launch, self-host packaging, acceptance evidence, restore/workload exercises, and contribution guidance.
- [v0.1.0 release notes](docs/releases/v0.1.0.md): initial release features, requirements and known limitations.

Workspace snapshots show bounded recent history; complete pages reach older records. Exports explicitly reject oversized bundles instead of silently truncating. Real funds remain outside scope.

Licensed under the [MIT license](LICENSE). The release guide explains how to evaluate and contribute to the project.
