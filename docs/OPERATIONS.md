# Operations and troubleshooting

Use diagnostics to locate a failure, then use committed receipts and accounting records to establish its financial outcome. Keep an unresolved submission's original `commandId`, `sessionId` and payload. Retrying the same intention with a new identity can create another order.

## Inspect the current process

Every HTTP response includes a server-generated UUID in `X-Request-Id`. A retry receives another request identity while keeping its original command identity. Caller-provided request identity headers are ignored. Capture the response status/code and request identity before investigating an uncertain command.

Sign in as the administrator and request `/api/admin/diagnostics` on the application origin. For example, the signed-in browser console can fetch it without copying a cookie or password into a command:

```js
const response = await fetch('/api/admin/diagnostics', {
  credentials: 'same-origin',
  cache: 'no-store',
});
console.log(response.status, await response.json());
```

The endpoint is administrator-only, uses live database authentication, and returns `Cache-Control: no-store`. It exposes aggregate measurements without request, command, account, order or session identities. A financial halt leaves inspection available while database reads work. A database outage or blocked authentication query can also make this endpoint unavailable; it has no authentication bypass.

`/health/live` answers whether the HTTP process is responding. `/health/ready` checks whether the installation is ready for trading, including database access, administrator setup, recovery/fault and session-transition gates. Liveness alone does not prove readiness or accounting health. When the authenticated endpoint cannot respond, inspect these separate responses and the owner's API logs. For the default Compose configuration:

```sh
docker compose --env-file .local/self-host/compose.env logs --tail 200 --no-color api
```

Use the matching environment file and project selection for a custom installation. Do not publish private configuration, cookie jars, database dumps, browser traces or raw terminal transcripts as a troubleshooting report.

## Interpret the measurements

The `schemaVersion: 1` snapshot describes one observation window: `startedAt`, `generatedAt`, uptime, current process RSS/heap bytes, fixed-name `timings`, event counts and gauges. The normal API creates a new window at each process start. Compare window identities before subtracting snapshots; counters do not survive a restart and are not durable audit history.

Each timing has `count`, `totalMs`, `maxMs`, fixed outcome counts and cumulative buckets. A sample contributes to every bucket whose upper bound includes it; `upperBoundMs: null` is the final unbounded bucket. Do not sum cumulative buckets. Durations use monotonic elapsed time; event timestamps use the wall clock. Aggregates saturate at `Number.MAX_SAFE_INTEGER` rather than overflowing. These measurements do not declare a latency target or hosting capacity.

| Signal                              | Meaning and limits                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.request`                      | HTTP response completion, classified separately from a durable trading result. A lost HTTP response does not undo a commit.                                                     |
| `http.command`                      | Dispatched command handlers with validated command/session identities. Authorization/schema/admission failures can happen before dispatch and have no sample here.              |
| `engine.command`                    | Matching-core limit, protected-market and cancellation attempts, including internal simulator calls and receipt replay. It is not a count of distinct orders or executions.     |
| `engine.lock`                       | Control-row lock acquisition duration; rising latency can expose contention before a timeout.                                                                                   |
| `database.<kind>.acquire`           | Actual pool acquisition completion/failure, including a connection acquired after its bounded scope already timed out.                                                          |
| `database.<kind>.query`             | Adapter query completion, including configuration/transaction control and fenced attempts that cannot reach SQL. It is not a business-operation count.                          |
| `database.<kind>.budget`            | One outcome at the bounded scope boundary, including acquisition, statements and asynchronous callbacks. The underlying acquisition/query may finish later.                     |
| `database.shutdown`                 | Actual managed-pool drain completion. `timeout` means the drain deadline forced transport disposal.                                                                             |
| `live.connection`                   | Accepted stream lifetime or failed connection attempt. `live.frame` counts attempted frames, including backpressure failures; it is not an end-to-end delivery acknowledgement. |
| `export.prepare`, `export.download` | Preparation outcome and download completion/failure. A download observation waits for file-stream closure and HTTP response finish/closure.                                     |
| `simulator.cycle`                   | Completed scheduler-cycle attempts. `skipped` can be a normal pause, stopped intent, stale generation or other gate; inspect simulator state before diagnosing a failure.       |

Database kinds are `read`, `export`, `command` and `maintenance`. `lock_timeout` identifies PostgreSQL lock timeout (`55P03`); `timeout` includes statement cancellation (`57014`), transaction/idle deadlines (`25P04`/`25P03`) and local database budgets. These aggregate outcomes intentionally omit SQL and raw error detail. One operation can contribute to acquisition, query, budget, engine and HTTP measurements; adding those counts would double-count work.

Gauges show active HTTP requests, live connections, export preparations/downloads/retained jobs, simulator in-flight work, and engine state. A snapshot fetched over HTTP includes its own active request, so an otherwise idle API can report one. `engine.available` describes writer/transport ownership, while `engine.faulted` describes an accounting halt and `engine.recovering` describes startup recovery. An available writer can still be faulted. Active work should fall when it settles; an observed disconnect does not release an HTTP slot while its database work remains queued.

The production API emits allowlisted JSON diagnostic events to stdout. `request.completed` and `command.completed` can correlate validated `requestId`, `commandId`, `sessionId`, decimal `sequence`, fixed operation/outcome and status. Matching emits its committed result before the after-commit test hook; `command.replayed` identifies a matching-core receipt replay. Failed attempts can have no sequence. An HTTP error after commit can therefore coexist with an accepted core event. Resolve the receipt rather than inferring rollback from the response alone.

The stdout adapter declines new diagnostic events when its pending buffer reaches 64 KiB. `diagnostics.dropped_events` counts declined, thrown or rejected sink writes during this window; it is a cumulative loss count despite appearing among gauges. Aggregates continue when event output is dropped. Events are not retained in an application backlog. Missing events or zero measurements are not proof that no failure occurred, especially across restart, log loss or work that never reached the observed boundary. IDs never become metric labels, and event fields exclude raw URLs/query strings, SQL/parameters, credentials, tokens, private account identifiers and raw errors.

## Investigate trading failures

| Symptom                                                  | Investigate                                                                                                                                                         | Safe next step                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMISSION_BUSY` or rising lock latency                  | Compare HTTP active requests, `admission.rejected` and `engine.lock`/database outcomes. Capacity exhaustion is `busy`; a PostgreSQL lock timeout is `lock_timeout`. | Reduce concurrent work and inspect the stalled owner operation. Resolve an uncertain command by its original receipt or identical retry. Do not remove writer locks or change its epoch.                                                    |
| `ADMISSION_EXPIRED` / `REQUEST_ABORTED`                  | The request expired or was observed disconnected before admission. Its database wait may still hold a capacity slot until it settles.                               | Let the queued work drain, then resolve/retry the original identity. A browser timeout by itself does not establish whether the server admitted the command.                                                                                |
| HTTP 503 `DATABASE_TIMEOUT`                              | Separate acquisition, query and total-budget timeouts for the relevant kind. Compare lock timing and the request/command event chain.                               | Check database availability and competing work. An expected timeout does not itself mean accounting corruption; preserve the original identity because a sent commit may have succeeded.                                                    |
| `WRITER_UNAVAILABLE`, `engine.available = 0`             | Inspect the writer event, database/transport availability and whether an earlier instance still owns the installation. Shutdown also lowers availability.           | Stop overlapping processes cleanly, restore connectivity and restart through normal fencing/reconciliation. Never force two writers or manually release ownership.                                                                          |
| `RECOVERY_REQUIRED`, `engine.faulted = 1`, readiness 503 | Inspect administrator overview, reconciliation results and retained financial history. Read-only inspection/access revocation may remain usable.                    | Preserve the database and take a backup before a diagnosed owner maintenance procedure. Do not overwrite balances, delete evidence or clear a fault flag to make trading resume. A pause/resume request cannot repair an invariant failure. |

A trading `status: "REJECTED"` with HTTP 200 is a durable business result when a receipt exists. Examples include insufficient funds or a paused market. Check the response code, current order/account snapshot and receipt separately; raw HTTP success is not proof that an order was accepted.

## Investigate live updates, exports and simulator activity

| Symptom                                             | Investigate                                                                                                                                                                                | Safe next step                                                                                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disconnected or stale live workspace                | Compare `live.connections`, connection outcomes, frame/backpressure events and database read timeouts. `STREAM_LIMIT` indicates fixed stream capacity; authorization loss closes a stream. | Close unused tabs, restore connectivity or sign in again when required. Let the workspace fetch a committed snapshot and resynchronize; do not treat an SSE frame as financial state.                                       |
| `EXPORT_BUSY` / `EXPORT_DOWNLOAD_LIMIT`             | Compare active preparations/downloads and retained jobs. An active download can finish after the preparation handler returns.                                                              | Wait for existing work to finish and retry the read. Avoid launching duplicate preparations to overcome a busy response.                                                                                                    |
| `EXPORT_EXPIRED`, interrupted or timed-out download | Temporary jobs expire and disappear on API restart; inspect prepare/download outcomes and current database budgets.                                                                        | Prepare a fresh coherent snapshot and download its complete files/manifest. A new preparation may include later trades; do not combine files from different snapshots. An expired export does not delete financial history. |
| Too few simulator trades or many skipped cycles     | Inspect administrator simulator intent/status, market pause/fault gates, inventory and per-order shortfalls. A cycle can complete while commands report insufficient funds.                | Resume only when appropriate. If inventory is insufficient, pause and use the reviewed virtual-fund grant; no scheduler/restart action refills it automatically. Retain original persisted plans through recovery.          |

This milestone adds diagnostics and regression coverage, without an external monitoring stack, monitoring UI, automatic financial repair or sustained-load certification. Keep the [recorded performance/restore/Compose evidence](RELEASE.md#operational-evidence) separate from current process observations.
