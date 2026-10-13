# Exchange sandbox

A self-hostable spot-exchange sandbox for developers and technical learners. Trade virtual BTC-SIM / USD-SIM and inspect how orders, fills, fees, and balances change. Real money, custody, and external exchange connections are outside scope.

The first milestone implements the exchange core in TypeScript against PostgreSQL. It is a headless development prototype: the trader interface, authentication, protected market orders, and administrator workflows come later.

## Try the first milestone

Use Node.js 24 and pnpm 10.22.0, as pinned in `.nvmrc` and `package.json`.

```sh
pnpm install --frozen-lockfile
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

The architecture is a modular monolith with PostgreSQL as the authority. Serializing mutations gives this single-market prototype an understandable consistency boundary. Throughput is unmeasured; distributed services would add recovery complexity before there is evidence they are needed.

## Project documentation

- [MVP features and user flows](docs/MVP.md): accepted product rules and full-release acceptance criteria.
- [System architecture and stack](docs/ARCHITECTURE.md): accepted design, alternatives, boundaries, and future work.
- [Development and validation](docs/DEVELOPMENT.md): local commands, core API, persistence, and test evidence.

This repository does not yet provide a public HTTP service or a complete exchange application. The core API trusts its caller and is intended for local development and verification until the authentication and permission layer is implemented.
