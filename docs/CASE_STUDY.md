# An exchange that can explain a lost response

Spot Exchange Simulator is a self-hostable trading application with virtual funds. Its central problem is making an order explainable after partial execution, cancellation, a lost HTTP response or an application restart. The browser exposes orders, fills, fees and reservations; PostgreSQL retains the financial outcome. The [MVP](MVP.md) defines the scope and the [walkthrough](RELEASE.md#walkthrough) makes the arithmetic reproducible.

## Exact amounts and one durable command identity

Prices, quantities and quote amounts have explicit integer scales. Financial calculations use integer arithmetic, and the API carries decimal strings. The chart converts values to floating-point coordinates for drawing; its textual data preserves the original values. Visual approximations never decide whether a user has enough funds.

A matching transaction writes the order, fills, double-entry journal, balance projections, command receipt and notification records together. If the process commits and dies before returning a response, the browser keeps the original command identity and payload. Receipt lookup or an identical retry resolves that outcome. Reusing the identity with different terms is rejected. This provides idempotent financial effects for a command identity; network delivery can still fail.

The boundary is exercised with real PostgreSQL and application processes killed before commit and after commit but before acknowledgement. Separate browser scenarios cover reload and an uncertain response. See [amounts](../packages/domain/src/amounts.ts), [ledger](../apps/server/src/ledger.ts), [transaction orchestration](../apps/server/src/exchange.ts), [process-loss tests](../tests/integration/recovery.test.ts) and [browser recovery](../tests/browser/frontend-recovery.spec.ts).

## Why PostgreSQL owns the consistency boundary

The matching rules run in [pure TypeScript](../packages/domain/src/matching.ts). One serialized mutation boundary makes price/time priority, reservations, both participants' accounting and access checks part of the same commit. A persistent control-row lock and acceptance sequence establish order; SQL-backed book state survives process loss. Committed snapshots serve concurrent reads without reading an authoritative in-memory book.

This is a deliberate fit for one shared simulated market. Serialization imposes a throughput ceiling and the application remains a single failure domain. In the recorded direct-core workload, four concurrent callers increased latency and reduced throughput relative to one caller. More services would add delivery, leadership and recovery problems before removing this boundary. The [architecture diagrams and alternatives](ARCHITECTURE.md) and [measured contention results](RELEASE.md#recorded-local-operational-results) make that tradeoff inspectable. Engine extraction has an explicit trigger: measured requirements that the simpler design cannot meet.

## A measured historical-query improvement

The original candle query aggregated a whole session before selecting recent minutes. The replacement first locates the latest 60 populated UTC minutes using a covering index, then aggregates every fill in those minutes. It preserves burst volume and leaves empty intervals empty.

On an isolated synthetic fixture of 105,000 fills across 5,001 populated minutes, both queries returned identical 60-row OHLCV results. Five warm samples reduced SQL p50 from **28.520 ms to 1.852 ms**. The added index occupied about **8.6 MiB**, adding storage and write-maintenance cost. The fixture was vacuumed before measurement; fresh production pages can require heap fetches. These are local SQL measurements, with their method and limitations in the [report](evidence/candle-result.json), rather than a hosting-capacity claim. The [query](../apps/server/src/market-candles.ts), [index](../packages/database/src/large-session-schema.ts) and [equivalence tests](../tests/integration/market-candles.test.ts) are linked directly to that evidence.

## Making the result usable and operable

Trader and administrator interfaces share typed contracts. Live updates invalidate committed snapshots; pending submissions retain their identities through reconnect and reload. Reviewed actions, scoped CSV bundles, read-only financial archives and exact candle tables make outcomes visible. An administrator can operate the simulator, inspect its inventory and grant virtual funds through ordinary audited controls.

The [release acceptance map](RELEASE.md#mvp-acceptance-evidence) connects these flows to tests and sanitized reports. CI also exercises fresh Compose/HTTPS setup, historical upgrades and a database restore. Application-process recovery and database restore establish different guarantees. The database owner remains outside application-level tamper protection, and sustained packaged capacity remains a separately scoped measurement. Those limits are part of the engineering result.
