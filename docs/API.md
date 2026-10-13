# Sandbox API

The API is the authenticated boundary around the PostgreSQL exchange core. It uses ordinary HTTP requests, opaque cookie sessions, and exact decimal strings. All assets and balances are simulated. Browser screens, live event delivery, protected market orders, the liquidity bot, and session rollover are separate milestones.

The trader interface and administrator controls use the same transaction boundary as the core. Administrator routes support the application; they do not establish a separate, stable automation product.

## Authentication and request safety

There is no public signup or HTTP administrator bootstrap. A local operator establishes the single administrator, then creates expiring, single-use invitations. The administrator identity has no trading account. Use a separately invited trader account to trade.

Passwords use Argon2id. Session, invitation, and recovery tokens are random bearer secrets; only their hashes are stored. Treat their plaintext values like passwords. Never place them in tracked files, command arguments, logs, or public links. The application does not deliver invitations by email.

Authenticated reads require the session cookie. Browser mutations also require the configured origin and the session's CSRF token. Login and token redemption validate the origin before handling credentials. An API client must keep its cookie jar and CSRF token together. Session cookies are HttpOnly and SameSite; HTTPS deployments require Secure cookies. The documented loopback development configuration is the only plaintext-HTTP exception.

The server derives the actor from the authenticated session. Clients cannot select a trading account by adding an account identifier to an order. Trader reads and commands are scoped to that actor, while explicitly authorized administrator routes can inspect participants and apply controls.

Signing out revokes the current session but leaves existing orders active. Password changes revoke other sessions and rotate the current session. Password recovery revokes all prior sessions. Suspension revokes access and cancels unfilled order quantities; completed fills remain valid. Reinstatement does not recreate orders or repeat the current session's starting allocation.

## Commands and retries

Trading and administrator mutation payloads include a caller-generated UUID `commandId`. Financial commands also name the intended exchange `sessionId`. Use a new identity for a new intention, and reuse the same identity and payload after an uncertain response.

An accepted command response reports committed state. Business rejections are durable results where the command reached admission. Malformed inputs, missing authentication, permission failures, and CSRF failures do not constitute accepted exchange commands. Reusing a command identity with different content is a conflict.

A stored receipt records the original result, including when the corresponding order later fills or is canceled. Read a fresh account snapshot for current balances and order states. A timeout is ambiguous; it does not authorize inventing a new command identity and submitting the same trade again.

All monetary values are strings. Quantity accepts at most four decimal places, price at most two, and USD-SIM balances at most nine. JavaScript numbers, exponent notation, unsupported precision, and implicit rounding are rejected. The [MVP](MVP.md) defines fixed market rules and limits.

## Admission, overload, and disconnects

The prototype admits at most 64 active HTTP requests without an additional application queue. A slot covers authorization and route execution. If the client disconnects while database work is still pending, that work retains its slot until it settles. Rejected excess requests return HTTP 503 with `ADMISSION_BUSY`.

PostgreSQL control-lock waits are limited to two seconds. HTTP requests have an eight-second admission deadline measured with a monotonic clock; database pool acquisition has its own five-second bound. After acquiring the control lock, the service rechecks the observed disconnect/deadline before allowing a mutation. A pre-admission disconnect, expired deadline, or lock timeout produces no command receipt, financial effect, or accounting fault. These constants are prototype resource bounds, not measured latency or throughput guarantees.

An admitted command completes its transaction even if the client then disconnects. Its result may therefore exist without reaching the client. Silent network disruption is not always observed immediately, and a client-side timeout alone cannot establish whether admission occurred. Resolve the original command identity through its receipt or retry the same payload; never assume that closing the connection canceled an admitted order.

`ADMISSION_BUSY`, `ADMISSION_EXPIRED`, and `REQUEST_ABORTED` are transient admission failures. The socket/request timeouts are transport controls, not instructions to reverse a committed command. Password work also has a separate bounded concurrency limit; overloaded hashing returns `AUTH_BUSY`.

## Operator behavior

The first HTTP installation starts paused. A pause blocks new orders and fills while allowing cancellation and reads. Resume is explicit and requires a reason. Grants issue positive simulated funds through the journal, require a paused healthy market, and are idempotent. They never edit balances directly.

Administrator actions record the actor, action, target, reason, session, and result without storing credential or token plaintext. Invitation and recovery secrets are returned only for handoff; their list and history views exclude those secrets.

An accounting fault is distinct from an operator pause. Reads and access revocation remain available, but financial work is blocked. A suspended account whose cancellations cannot safely finish during a fault remains visibly pending; do not present it as fully canceled. No route may bypass an unresolved fault by resuming trading.

## Routes

Paths below are relative to the configured server origin. All mutation bodies are JSON, and unrecognized fields are rejected. Authentication returns a `user` object, a CSRF token, and an expiry alongside the session cookies. Monetary fields in every response remain decimal strings.

| Method | Path                          | Purpose                                                                         |
| ------ | ----------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/api/auth/login`             | Sign in with `{ handle, password }`                                             |
| GET    | `/api/auth/session`           | Read the authenticated identity                                                 |
| POST   | `/api/auth/logout`            | Revoke the current session; send `{}`                                           |
| POST   | `/api/auth/password`          | Change password with `{ currentPassword, newPassword }` and rotate the session  |
| POST   | `/api/auth/redeem`            | Consume an invitation with `{ token, handle, password }`                        |
| POST   | `/api/auth/recover`           | Consume a recovery token with `{ token, password }`                             |
| GET    | `/api/market`                 | Read session, market state, shared order-book depth, and executions             |
| GET    | `/api/me`                     | Read own balances, orders, and fills                                            |
| GET    | `/api/orders/:orderId`        | Inspect an owned order and its fills; another account's order returns not found |
| POST   | `/api/orders`                 | Submit `{ commandId, sessionId, side, quantity, price }`                        |
| POST   | `/api/orders/:orderId/cancel` | Cancel own remainder with `{ commandId, sessionId }`                            |
| GET    | `/api/receipts/:commandId`    | Resolve own original trading command outcome                                    |
| GET    | `/api/openapi.json`           | Read the authenticated OpenAPI description                                      |

Invitation redemption creates and funds an account atomically. Sign in after redemption to establish a cookie session. Handles are lowercase identifiers of 3–32 characters beginning with a letter and continuing with letters, digits, or underscores. Passwords contain 12–128 Unicode code points within the supported encoded-size bound. Invitations last 24 hours, recovery tokens one hour, and login sessions 12 hours.

Administrator mutations use `{ commandId, sessionId, reason }` plus the additional fields shown below. Every administrator route requires the administrator role; passing an administrator's account identifier never substitutes for that role.

| Method | Path                                      | Purpose / additional mutation fields                                 |
| ------ | ----------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/api/admin/overview`                     | Read operational state                                               |
| GET    | `/api/admin/traders`                      | List participant accounts                                            |
| GET    | `/api/admin/traders/:accountId`           | Inspect an account snapshot                                          |
| GET    | `/api/admin/invitations`                  | List invitation metadata and state                                   |
| POST   | `/api/admin/invitations`                  | Create a single-use invitation                                       |
| POST   | `/api/admin/invitations/:id/revoke`       | Revoke an unused invitation                                          |
| POST   | `/api/admin/traders/:accountId/recovery`  | Issue a trader recovery token and invalidate preceding unused tokens |
| POST   | `/api/admin/traders/:accountId/suspend`   | Revoke access and cancel the remaining open orders                   |
| POST   | `/api/admin/traders/:accountId/reinstate` | Restore access without repeating initial funding                     |
| POST   | `/api/admin/market/pause`                 | Pause order admission and matching                                   |
| POST   | `/api/admin/market/resume`                | Resume a healthy market                                              |
| POST   | `/api/admin/reconcile`                    | Record a reconciliation check; inspect `data.ok` and `data.issues`   |
| POST   | `/api/admin/orders/:orderId/cancel`       | Cancel an order remainder administratively                           |
| POST   | `/api/admin/grants`                       | Issue funds; add `{ accountId, asset, amount }`                      |
| GET    | `/api/admin/audit`                        | Inspect administrator action history without secrets                 |

Invitation and recovery issuance return their plaintext `token` only on the first successful response. A retry returns the persisted metadata without the secret. If that first response is lost, revoke the unusable invitation and issue a new one; a new recovery issuance invalidates its predecessor. Persisting a plaintext secret in a retry receipt would weaken the storage guarantee.

Administrator results use `{ commandId, sessionId, sequence, status, code?, data? }`. For example, a suspension can report `data.pendingCancellation: true` while access is already revoked. A reconciliation check can be accepted as a completed check while `data.ok` is false; inspect the reported outcome, not only the HTTP status. Trading business rejections likewise return HTTP 200 with `status: "REJECTED"` and a stable `code`.

HTTP errors use `{ code, message }`. Invalid inputs use 400, unauthenticated access 401, permission or CSRF/origin failures 403, missing private orders 404, conflicting command identities 409, unsupported content type 415, rate limits 429, and unavailable recovery or authentication capacity 503. Resolve a possibly committed command by its original identity after a transport failure or server error.

Book depth is capped at 50 price levels per side, shared executions at 100 records, and account/order history responses at 100 records with `historyLimit` metadata. These are bounded inspection views, not complete exports. Administrator lists are also bounded; pagination and CSV exports remain future work. Private trader fill responses omit counterparty order identities; administrator inspection retains both sides for reconciliation.

## Cookie-authenticated example

This example runs in a same-origin browser console after signing in. It assumes two separately invited traders when a matching counterparty is needed; submitting a limit order alone may leave it resting on an empty book. It demonstrates the API's request sequence, not a completed browser interface.

```js
const csrfToken = decodeURIComponent(
  document.cookie
    .split('; ')
    .find((value) => value.startsWith('sandbox_csrf='))
    .split('=')[1],
);

async function read(path) {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

async function command(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

const market = await read('/api/market');
const submission = {
  commandId: crypto.randomUUID(),
  sessionId: market.sessionId,
  side: 'SELL',
  quantity: '0.1000',
  price: '50000.00',
};
const result = await command('/api/orders', submission);
const currentAccount = await read('/api/me');

if (result.status === 'ACCEPTED' && result.order.remaining !== '0.0000') {
  await command(`/api/orders/${result.order.id}/cancel`, {
    commandId: crypto.randomUUID(),
    sessionId: market.sessionId,
  });
}
```

For an uncertain submission, query `/api/receipts/${submission.commandId}` or retry `submission` unchanged. The example's cancellation is a new command with a new identity. Preserve each pending command's identity until its outcome is resolved.

## Validation boundary

API integration tests use Fastify's HTTP injection interface with a real PostgreSQL database and independently isolated schemas. Additional disconnect tests open actual loopback HTTP connections, confirm a database admission wait or an admitted transaction boundary, and then abort the client connection. The suite exercises route validation, authentication, cookies, authorization, admission capacity, and committed accounting together. This does not substitute for future browser testing, real TLS/reverse-proxy validation, or load testing.

The suite also constructs an actual milestone-one schema and committed allocation history before applying the identity migration. A separate admission-race test holds PostgreSQL's control-row lock, confirms that an authenticated order is waiting, revokes its session, and verifies that the queued command makes no financial change. These checks cover schema continuity and authorization at the transaction boundary.

See [development and validation](DEVELOPMENT.md) for setup, commands, database handling, and the exact implemented milestone boundary.
