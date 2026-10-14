# Exchange sandbox

A self-hostable spot-exchange sandbox for developers and technical learners. Trade virtual BTC-SIM / USD-SIM and inspect how orders, fills, fees, and balances change. Real money, custody, and external exchange connections are outside scope.

The prototype includes a browser trading workspace, an administrator control room, invitation-only authentication, and the transactional exchange core. Live updates keep order, balance, and market views synchronized with committed PostgreSQL state.

## Run locally

Use Node.js 24 and pnpm 10.22.0, as pinned in `.nvmrc` and `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm admin:setup
pnpm dev
```

Open `http://localhost:3000`. Setup prompts for the administrator handle and a password without echoing it. The first session starts paused, and the development runner retains PostgreSQL data between runs.

Sign in as the administrator, create invitations, and privately hand the single-use links to participants. After they join, resume trading with a recorded reason. For manual trading, use separately signed-in browser profiles to place a resting sell and a crossing buy, then inspect their fills and exact balance changes.

For ongoing synthetic activity, use **Start simulator** in the administrator overview, give a reason, and resume trading. Two automated accounts place ordinary orders in the shared book. Their executions build the chart; allow several minutes for multiple one-minute candles. Inspect inventory and per-order funding shortfalls in the same panel. Pause the market before granting more virtual funds. **Stop simulator** cancels only the automated accounts' remaining orders and preserves completed trades. Application restarts retain the enabled/stopped setting and never refill inventory. See the [development guide](docs/DEVELOPMENT.md#market-simulator).

For an isolated matching demonstration and the full validation suite:

```sh
pnpm demo
pnpm exec playwright install chromium
pnpm check
```

The demo, integration, and browser test runners start real, temporary PostgreSQL 18 instances on loopback. Docker and an existing database are not required. Temporary database data is removed after the command finishes. The [development guide](docs/DEVELOPMENT.md) explains persistent databases, individual checks, and recovery tests.

## What the core demonstrates

- Price/time matching at the resting order's price, including partial fills and self-trade prevention.
- Exact scaled-integer quantities, prices, reservations, and fees; decimal strings at the service boundary.
- Atomic orders, fills, double-entry journal entries, balance projections, command receipts, and notification records.
- Cancellation of remaining quantity with no duplicated fund release.
- Protected market orders with a server-bound 5% price guard, a 10-second preview, immediate execution, and explicit canceled remainders.
- Durable command identity: retries resolve the original outcome, while changed payloads are rejected.
- Startup reconciliation and tests that kill an actual application process before commit or after commit but before acknowledgement.
- Hashed credentials and tokens, transactional invitation redemption, session revocation, and CSRF-protected API commands.
- Audited pause/resume, grants, administrative cancellation, and suspension with fault-safe access revocation.
- Trader screens with a live order book, internal execution candles, reviewed limit and protected market orders, cancellation, exact balances, and linked activity/history.
- Administrator screens for invitations, access recovery, participants, system accounts, market controls, reviewed grants, and audit history.
- Reconnectable authorized SSE invalidations, consistent workspace snapshots, and browser request identity preserved across refreshes after uncertain responses.
- An administrator-managed two-account simulator with generation-fenced start/stop, persisted command plans, visible inventory limits, reviewed funding, and honest sparse-chart states.
- Browser regressions against real PostgreSQL, including uncertain-response recovery, simulator controls, rollover, archived balances, and actual CSV downloads, with failure traces/screenshots retained in CI.
- Durable session rollover, exactly-once allocations, read-only financial archives, and recovery of the original transition after process loss.
- Complete keyset history pagination and account/order lookup, plus role-scoped CSV files from one recorded snapshot.
- A self-host Compose package with pinned images, HTTPS proxying, owner migrations, a restricted application role, and operational verification scripts.

The architecture is a modular monolith with PostgreSQL as the authority. Serializing mutations gives this single-market prototype an understandable consistency boundary. The reproducible workload and restore exercise are described in the [release guide](docs/RELEASE.md). Measurements apply to their explicit test configuration.

## Project documentation

- [MVP features and user flows](docs/MVP.md): accepted product rules and full-release acceptance criteria.
- [System architecture and stack](docs/ARCHITECTURE.md): accepted design, alternatives, boundaries, and future work.
- [Development and validation](docs/DEVELOPMENT.md): local commands, core API, persistence, and test evidence.
- [HTTP API](docs/API.md): routes, authentication, request examples, and retry behavior.
- [Release and walkthrough](docs/RELEASE.md): self-host packaging, acceptance evidence, restore/workload exercises, screenshots, and contribution guidance.

Workspace snapshots show bounded recent history; complete pages reach older records. Exports explicitly reject oversized bundles instead of silently truncating. Real funds remain outside scope.

Licensed under the [MIT license](LICENSE). The release guide explains how to evaluate and contribute to the project.
