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

Sign in as the administrator, create invitations, and privately hand the single-use links to two participants. After they join, resume trading with a recorded reason. Use separately signed-in browser profiles to place a resting sell and a crossing buy, then inspect their fills and exact balance changes. There is no automatic liquidity in this milestone.

For an isolated matching demonstration and the full validation suite:

```sh
pnpm demo
pnpm check
```

The demo and integration runner start real, temporary PostgreSQL 18 instances on loopback. Docker and an existing database are not required. Temporary database data is removed after the command finishes. The [development guide](docs/DEVELOPMENT.md) explains persistent databases, individual checks, and recovery tests.

## What the core demonstrates

- Price/time matching at the resting order's price, including partial fills and self-trade prevention.
- Exact scaled-integer quantities, prices, reservations, and fees; decimal strings at the service boundary.
- Atomic orders, fills, double-entry journal entries, balance projections, command receipts, and notification records.
- Cancellation of remaining quantity with no duplicated fund release.
- Durable command identity: retries resolve the original outcome, while changed payloads are rejected.
- Startup reconciliation and tests that kill an actual application process before commit or after commit but before acknowledgement.
- Hashed credentials and tokens, transactional invitation redemption, session revocation, and CSRF-protected API commands.
- Audited pause/resume, grants, administrative cancellation, and suspension with fault-safe access revocation.
- Trader screens with a live order book, internal execution candles, reviewed limit orders, cancellation, exact balances, and linked activity/history.
- Administrator screens for invitations, access recovery, participants, system accounts, market controls, reviewed grants, and audit history.
- Reconnectable authorized SSE invalidations, consistent workspace snapshots, and browser request identity preserved across refreshes after uncertain responses.

The architecture is a modular monolith with PostgreSQL as the authority. Serializing mutations gives this single-market prototype an understandable consistency boundary. Throughput is unmeasured; distributed services would add recovery complexity before there is evidence they are needed.

## Project documentation

- [MVP features and user flows](docs/MVP.md): accepted product rules and full-release acceptance criteria.
- [System architecture and stack](docs/ARCHITECTURE.md): accepted design, alternatives, boundaries, and future work.
- [Development and validation](docs/DEVELOPMENT.md): local commands, core API, persistence, and test evidence.
- [HTTP API](docs/API.md): routes, authentication, request examples, and retry behavior.

Protected market orders, bot operation, session rollover, pagination/exports, a packaged self-host deployment, and complete browser acceptance remain future work. History views are explicitly bounded; all currently open orders remain visible. Real funds remain outside scope.
