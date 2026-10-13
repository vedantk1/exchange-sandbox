# Exchange sandbox MVP

Status: MVP product scope accepted. The defaults below define the agreed exchange sandbox, with real funds excluded. They are requirements, not claims about implemented features. The accepted technical design is recorded separately in [System architecture and stack](ARCHITECTURE.md); [development and validation](DEVELOPMENT.md) tracks the implemented milestone.

The accepted automation design is the two-account demo market simulator below. It replaces the earlier single quoting-bot proposal. Its administrator controls, inventory visibility, and audited funding are implemented; session rollover, protected market orders, and exports remain future work.

The product lets a developer or technical learner run a small exchange, trade virtual assets, and inspect how orders, executions, fees, and balances change. Its primary value is understandable exchange behavior. It does not promise realistic trading returns or reproduce an external exchange's liquidity.

## Product boundaries

- One installation has one shared active trading session. Invited traders and the optional simulator use the same order book. The simulator has two disclosed automated participants: a maker and a taker.
- There is one predefined spot pair, BTC-SIM / USD-SIM. Both are internal virtual assets with no monetary value, blockchain connection, deposit address, or withdrawal path.
- Matching happens between orders in this installation. All charts and market statistics use its own executions. There are no external market feeds or exchange integrations.
- The product has an original identity and interface. Familiar order-book conventions are useful; Binance branding and copied assets are excluded.
- Initial operation is private and invitation-only. A public account signup service is outside the MVP.
- Shared market views and APIs require authentication. Shared means visible to participants, not anonymously accessible.
- Starting a new session archives the previous session. It never rewrites completed trades or resets balances in place.
- The complete sandbox is usable without a paid service, external exchange account, or external market-data dependency.

## Roles and permissions

There are two human roles and two automated system participants. The administrator uses a separate trader account to trade; the administrator account has no trading balance.

| Capability                       | Trader                           | Administrator                         | Simulator accounts    |
| -------------------------------- | -------------------------------- | ------------------------------------- | --------------------- |
| View current shared market data  | Yes                              | Yes                                   | Yes                   |
| Place orders                     | Own account only                 | No                                    | Own account only      |
| Cancel orders                    | Own remaining orders             | Any remaining order, with a reason    | Own remaining orders  |
| View private orders and balances | Own account only                 | All accounts                          | Own account only      |
| Inspect archived history         | Own activity and session summary | All activity                          | No interactive access |
| Invite or suspend traders        | No                               | Yes                                   | No                    |
| Issue virtual funds              | No                               | Recorded positive grants while paused | No                    |
| Pause or resume trading          | No                               | Yes                                   | No                    |
| Start or stop the simulator      | No                               | Yes                                   | No                    |
| Start a new session              | No                               | Yes                                   | No                    |

MVP has one administrator established during first setup. Additional administrator roles, delegated permissions, impersonation, and account deletion are excluded. Suspended accounts retain their history.

## Trader features and screens

| Screen                | Required content and actions                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Join and sign in      | Redeem invitation, choose a unique handle and password, sign in, sign out, change own password using the current password. Email is not required.                                        |
| Trading workspace     | Session and market status, simulation label, order book, latest trades, basic one-minute candlestick chart, limit and protected market order forms, available balances, own open orders. |
| Orders                | Current-session orders with status and side filters; open order detail; cancel an order or all own remaining orders.                                                                     |
| Order detail          | Submitted parameters, accepted sequence/time, state and reason, fills, average execution price, cumulative fees, remaining quantity, and funds reserved or released.                     |
| Balances and activity | Available, reserved, and total holdings for each asset; initial allocations, grants, executions, fees, and reservation changes linked to their cause.                                    |
| History               | Select an archived session; inspect own orders, fills, balances, and activity; export own history. Trading controls are unavailable.                                                     |

These are product surfaces, not a requirement for separate pages. Order details may be a panel. Desktop is the primary trading layout; narrow screens must retain readable balances and usable order and cancellation controls. Native mobile apps are excluded.

Every trading surface identifies the active session and virtual asset status. Shared market data must not expose trader handles or account identifiers. Simulator participation is disclosed with a system-liquidity label. Private account details remain restricted by role.

Before the first trade, the chart and last-trade price show an honest empty state. Empty time intervals do not invent trades or volume. Order-book prices may exist before a last-trade price exists.

The implemented chart also explains the first one to four populated minute buckets: a flat candle is valid, and additional candles require trades in additional minutes. Existing data stays visible. Ongoing demo activity uses real execution times, so several minutes of chart history take several real minutes to accumulate.

## Trader flows

### Join and receive starting funds

1. A trader opens a valid invitation, chooses an unused handle and password, and creates an account. The invitation cannot be used again.
2. The account receives the session's initial allocation once: 1 BTC-SIM and 100,000 USD-SIM. The activity history records both allocations.
3. Onboarding explains that participants trade inside this installation, all assets are virtual, and the simulator supplies synthetic liquidity when enabled.
4. The trader enters the workspace. A paused or empty market displays its actual state and an explanation of available actions.

Invalid, revoked, expired, or already-used invitations show an explanation and direct the person to the operator. The interface does not reveal other accounts' details.

### Place a limit order

1. Choose Buy or Sell, enter BTC-SIM quantity and a USD-SIM limit price.
2. Review the quantity, price limit, fee rate, maximum buy commitment or reserved sell quantity, and available balance. A sell estimate at the limit is labeled as an estimate; a better price can produce larger proceeds and a larger fee.
3. Confirm once. Pending submission is visible. If an acknowledgement is lost, show an uncertain state and resolve the original submission before encouraging another order.
4. An accepted order receives a stable identity and follows price then acceptance-order priority. It may fill immediately, partially fill and rest, or remain fully open.
5. The workspace updates executions, remaining quantity, balances, and fees. The order detail explains the outcome.

An invalid price or quantity, insufficient funds, account restriction, paused market, or obsolete session rejects the order with a specific reason and no new reservation. An order is accepted only after its required funds can be reserved.

### Place a protected market order

1. Choose Buy or Sell and enter BTC-SIM quantity. Both sides use base-asset quantity; a separate spend-an-exact-amount mode is excluded.
2. Review an estimate from the current local book, available depth, possible partial execution, and a fixed 5 percent price guard relative to the best opposing quote in that preview.
3. The preview fixes the maximum buy price or minimum sell price. It expires after 10 seconds; an expired preview requires another review. A new preview never silently replaces one that was already confirmed.
4. At acceptance, reserve funds using that fixed guard and execute immediately against eligible orders within it. Do not move the guard to follow a changed market.
5. Cancel any unfilled quantity immediately. Show filled quantity, average price, fee, canceled remainder, and the reason, including absent liquidity or the guard being reached.

A market order never remains on the book. If no opposing quote exists, no market preview is available. If liquidity disappears after the preview, an accepted order can finish canceled with zero fills. Insufficient funds for the full protected buy commitment rejects the order instead of silently reducing its size.

The guard bounds the price of executed units. It does not guarantee execution of the entire quantity or a minimum total sale receipt. The review distinguishes estimates from that price guarantee.

### Cancel and understand the result

1. Select an open order, or select Cancel all open orders. Bulk cancellation asks for confirmation of a snapshot of the current session's affected orders and count. It reports per-order results; orders submitted after that snapshot are not included.
2. Show cancellation as pending until its result is known. A fill may occur before cancellation is accepted.
3. Cancel only the remaining quantity and release its reservation. Preserve completed fills and charged fees.
4. Report the authoritative result. A fully filled order cannot subsequently become canceled. Repeated cancellation does not release funds twice.

Signing out does not cancel orders. Orders can execute while their owner is offline; signing back in restores their current state. A password change revokes other login and API sessions; signing out revokes the session being used.

### Reconnect or inspect a previous session

1. A disconnected or stale connection shows a visible status and disables new submissions. Cancellation cannot be presented as successful while disconnected.
2. Reconnection restores authoritative orders, balances, market state, and session identity before trading controls return. A quiet book alone does not count as a stale connection.
3. Pending submissions and cancellations resolve against their original identities; retries do not create duplicate effects.
4. If a new session has started, show the change explicitly. Unsent forms and previews from the previous session are invalidated. Requests targeting the previous session are rejected, never applied to the new one.
5. The trader can select previous sessions in History without changing the active market for other participants.

## Trading rules

All prices and quantities below are illustrative simulation settings, not current market prices. They are fixed for the session and are not editable in the MVP administrator interface.

| Rule                       | MVP behavior                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pair                       | BTC-SIM / USD-SIM                                                                                                                                                                         |
| Initial trader allocation  | 1 BTC-SIM and 100,000 USD-SIM per account per session                                                                                                                                     |
| Quantity increment         | 0.0001 BTC-SIM                                                                                                                                                                            |
| Price increment            | 0.01 USD-SIM per BTC-SIM; price must be positive                                                                                                                                          |
| Quote accounting precision | 0.000000001 USD-SIM; entered amounts outside supported precision are rejected rather than silently rounded                                                                                |
| Minimum order              | At least one quantity increment and at least 1 USD-SIM notional at the limit or protected market guard                                                                                    |
| Maximum order              | 100 BTC-SIM, still subject to available funds                                                                                                                                             |
| Maximum resting orders     | 50 per trader account; a new limit order at the cap is rejected; market orders do not add resting orders                                                                                  |
| Limit duration             | Good until canceled or until the session ends                                                                                                                                             |
| Priority                   | Best price first, then authoritative acceptance order at the same price; client timestamps do not determine priority                                                                      |
| Execution price            | The resting order's price                                                                                                                                                                 |
| Market duration            | Immediate execution within the confirmed guard, then cancel the remainder                                                                                                                 |
| Market buy guard           | Preview best ask multiplied by 1.05, rounded down to the price increment                                                                                                                  |
| Market sell guard          | Preview best bid multiplied by 0.95, rounded up to the price increment                                                                                                                    |
| Fees                       | 0.1 percent of executed quote notional on each side, paid in USD-SIM; same rate for makers, takers, humans, and the simulator                                                             |
| Amendments                 | Cancel and submit a new order; the new order gets new priority                                                                                                                            |
| Self-trade prevention      | On encountering its own resting order, cancel the incoming order's unfilled remainder. Preserve earlier fills and the resting order. Do not skip the resting order to reach worse prices. |
| Ownership                  | No margin, borrowing, short selling, or negative spendable balances                                                                                                                       |

An accepted order is Open, Partially filled, Filled, or Canceled. Canceled orders can have completed fills and always retain their executed quantity. Rejected submissions appear in the submitter's history with a reason. Submitting, Cancel pending, and Unknown are interface states while the final result is unresolved; they do not assert that a trade happened.

The minimum-notional rule applies when submitting an order. Valid executions and remaining quantities may fall below that minimum. The guard-rounding rules above are explicit exceptions to rejecting excess input precision; they produce a displayed valid price before confirmation.

### Funds and fee treatment

- A buy reserves its maximum remaining purchase cost plus the remaining possible fee. A sell reserves its remaining BTC-SIM quantity; its fee is deducted from execution proceeds.
- Each execution updates both participants and the fee account consistently. Funds cannot be used by two orders simultaneously.
- Each fill's quote value is executed quantity multiplied by execution price. Each participant's fee is exactly 0.001 times that value. Four quantity decimals, two price decimals, and this fee rate fit within nine quote decimals without rounding. Splitting the same total notional into more fills must not change the total fee.
- A buy reserves quantity multiplied by its price cap multiplied by 1.001. After each fill, its remaining reservation is remaining quantity multiplied by that cap multiplied by 1.001. Release any excess reservation from price improvement. This applies to both limit buys and protected market buys.
- Canceling never charges a fee for unexecuted quantity. Reservations left after a terminal order state are released once.
- Available plus reserved equals total for each asset. Display rounding must not hide the exact amount available to spend; details and exports expose supported precision.
- Fees accumulate in a visible system fee account. Grants create explicit virtual issuance records. Every change has an attributable cause; balances cannot be overwritten or silently repaired.

## Two-account market simulator

The administrator explicitly starts the simulator from the overview. The first start creates a maker and a taker without login credentials, each receiving 1 BTC-SIM and 100,000 USD-SIM once per session. Start is permitted while healthy and paused; order submission waits for resume. Later starts and application restarts preserve the same accounts and balances. Automated accounts are excluded from human participant counts.

After each completed cycle, the service waits four seconds. It cancels both accounts' remaining orders, then requests two maker bids and two asks of 0.0200 BTC-SIM, at 10 and 30 USD-SIM offsets around a fictional reference moving within 48,000–52,000 USD-SIM. Replacement orders get fresh price/time priority. The taker submits a 0.0010 BTC-SIM crossing limit order: buy when its total BTC inventory is at or below 1 BTC-SIM, otherwise sell. This encourages activity but cannot guarantee a fill or a stable inventory.

Both accounts use ordinary matching, reservations, self-trade prevention, fees, and finite funds. They can trade with each other and with people. This synthetic activity is disclosed; it is not a market-realism or profitability claim. Charts use only actual sandbox executions and timestamps, with no historical backfill or direct candle generation.

The administrator sees each account's available and reserved balances, account inspection links, and exact funding requirements/shortfalls per order level. The funding preview includes buy fees and assumes old reservations are released first; it uses the stored reference price and assumes no execution proceeds. The next cycle's price or other trades can change affordability. Insufficient funds reject individual orders and produce Limited inventory, never borrowing or automatic issuance.

State is Not started, Running, Paused, Limited inventory, Stopped, Stopping, Error, or Faulted. Paused/Faulted reflect the exchange gate; the persisted enabled setting remains separate. A confirmed stop disables dispatch and cancels only these accounts' remaining orders. Earlier trades and human orders remain. If accounting blocks cancellation, Stopping explicitly means disabled with cleanup pending. Reconciliation and recovery finish cleanup before reopening trading. The state timestamp records the last persisted change, not worker liveness.

An application shutdown drains in-flight work and preserves intent and order state. Restart reconciles before resuming an enabled simulator and resolves unfinished commands by their original identities. A stopped simulator stays stopped. Administrator stop advances a generation checked under the trading lock, preventing older queued work from executing even after another start.

## Administrator features and flows

### First setup and first usable market

1. On an uninitialized installation, the operator uses the documented local setup process to create the administrator. No universal default credentials are supplied. Setup cannot claim an installation that already has an administrator.
2. The first session is created Paused, with fixed market rules and the simulator Not started. Automated accounts receive their allocations only on the first explicit start. There are no invented trades.
3. The administrator sees a checklist: invite a trader, review starting allocations and rules, enable the simulator if desired, and resume trading.
4. The administrator can arm the simulator while paused. Resume explicitly states whether simulator activity will start. With the simulator enabled, a fresh installation becomes tradable without a second human participant.

### Invite and manage access

1. Create an invitation and copy its single-use link. It expires after 24 hours and can be revoked before redemption. The application does not send email or messages.
2. The invitation list shows Pending, Redeemed, Expired, or Revoked. Redeemed accounts appear in the trader list.
3. To reset a trader password, generate a separate single-use recovery link valid for one hour. Generating another recovery link invalidates the previous one. Successful redemption changes the password and revokes existing login and API sessions. Passwords are never revealed to the administrator.
4. To suspend a trader, enter a reason and confirm the effect on access and open orders. New orders are blocked, remaining orders are canceled, and login and API sessions are revoked. Earlier fills remain valid. Completion is shown only when restrictions and cancellations have taken effect.
5. Reinstatement allows a new login and new orders. Canceled orders are not recreated. Reinstatement does not issue another starting allocation if the account already received one in the current session.

Suspended traders cannot sign in until reinstated. Account history remains available to the administrator. Administrator credential recovery must have a documented owner-only process; trader recovery links cannot grant administrator access.

### Inspect the exchange

The administrator overview shows active session, market state, simulator state and inventory condition, account counts, open order counts, recent executions, and any unresolved order/balance consistency failure. These are operational facts, not profit or performance metrics.

The administrator can inspect any account's orders, fills, balances, grants, and reservation changes; inspect the system fee account; and search by account handle or order identity. Each trade links both order identities in the administrator view. Trader views expose only their own private order details.

CSV export includes orders, fills, balance activity, available/reserved/total balance snapshots, and administrator actions for a selected session, with session identity and simulation labels. All datasets in an export share one recorded as-of boundary so the exported records reconcile even if trading continues. Exporting does not pause or change the market. It excludes passwords, authentication material, and invitation/recovery link secrets. Traders can export only their own orders, fills, balances, and balance activity. Exports preserve quantities, prices, reasons, and timestamps at documented precision.

### Pause and resume

1. Pause requires a reason and explains that new orders and matching will stop, while existing orders and reservations remain.
2. A confirmed pause is an authoritative boundary: earlier accepted executions may complete before confirmation; no new orders or fills occur after that confirmation until resume.
3. During pause, read access and cancellation remain available. An enabled simulator freezes, retaining its unfilled quotes. Stop simulator remains available and cancels those quotes.
4. Resume confirms the market and simulator behavior, records a reason, and reopens order submission and matching. A stopped simulator stays stopped. An enabled frozen simulator resumes.

A pause can also result from a detected consistency failure. This differs from an operator pause: resume, grants, invitation redemption, reinstatement, initial allocations, balance-changing cancellations, and new-session transitions are blocked until reconciliation succeeds. Read-only inspection and immediate access revocation remain available; dependent cancellations stay visibly pending. The reason remains visible, and the administrator cannot bypass it by starting a new session. Pausing does not retroactively cancel or reverse trades.

### Cancel a trader order

1. Inspect an order, select Cancel remaining quantity, enter a reason, and confirm.
2. Apply the same cancellation and race rules as a trader cancellation. The administrator cannot undo fills or choose a replacement execution price.
3. Record the action and its result. The trader sees that the cancellation was administrative and why.

### Grant virtual funds

1. While the market is paused, select an active trader or either simulator account, select an asset, enter a positive amount within its supported precision, and provide a reason.
2. Review the resulting balance, virtual issuance amount, and participant. Confirm once.
3. Record the grant in the participant's activity and administrator history. Repeating the same submission cannot issue funds twice.

Grants never modify an existing reservation or a prior record. Direct balance editing, deductions, fees paid out to administrators, and trader-controlled refills are excluded. Both simulator accounts can continue using granted funds when resumed.

### Start and stop the simulator

1. Start shows the fixed preset, available inventory, and whether the market is trading or paused. It is valid to enable the simulator while paused; quoting waits for resume.
2. First start initializes the pair and their standard allocations once. Later starts do not grant more funds. Insufficient inventory displays the missing side or level instead of implying full liquidity.
3. Stop confirms that the simulator's remaining orders will be canceled. It waits for cancellation results and leaves earlier executions intact.
4. A simulator error is visible to the administrator and does not silently refill or reset the account. Any orders still present are listed and remain cancelable.

### Start a new session

1. The market must be paused. Show the affected account count, open order count, and the fact that all participants move to a new session.
2. Require a reason and explicit confirmation of the current session identity. No reset takes effect merely by opening the dialog.
3. Stop the simulator, cancel all remaining orders with a session-ended reason, release reservations, and close the session. Preserve its orders, fills, final balances, grants, fees, and administrator history as a read-only archive.
4. Create exactly one new session with the same fixed rules. Each active trader receives the standard initial allocation; both existing simulator accounts receive the same standard per-account allocation once. Suspended accounts remain suspended and receive funds only when first activated in that new session. Each account can receive the initial allocation only once per session.
5. Preserve accounts, roles, passwords, restrictions, and outstanding invitations with their original expiry times. Keep the new market Paused and the simulator Stopped.
6. Notify connected traders that the session changed and invalidate old previews/forms. There must never be two simultaneously tradable sessions or an intermediate session with partially reset balances.

While rollover is in progress, invitation redemption, reinstatement, and grants are temporarily unavailable. Already accepted enrollments or grants must resolve before closing the old session, and those enrolled accounts then participate in the normal carryover. Requests not yet accepted receive a temporary-unavailability response and can be retried after the transition without consuming an invitation. Every allocation belongs to exactly one session; no account is silently omitted or funded in an already archived session.

Retries must recover the outcome of the same new-session request. An interrupted transition stays visibly unavailable until completed or recovered; it must not silently create another session. Archived sessions cannot be reopened for trading, and the MVP has no delete-history action.

## Failure behavior and audit history

| Situation                                  | Required product behavior                                                                                                                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order response is lost                     | Show Unknown while resolving the original submission; a retry cannot create another order                                                                                                                                                           |
| Order fills before cancellation            | Preserve the fills and explain the quantity that could still be canceled                                                                                                                                                                            |
| Price moves after a market preview         | Keep the confirmed guard; execute only within it, possibly partially or not at all                                                                                                                                                                  |
| Market is paused during activity           | Report outcomes relative to the confirmed pause boundary; do not claim an earlier accepted fill was reversed                                                                                                                                        |
| Bot inventory is exhausted                 | Show reduced or absent liquidity with the reason; never silently add funds                                                                                                                                                                          |
| Client misses updates                      | Mark data stale and reconcile before enabling new submissions                                                                                                                                                                                       |
| Service restarts                           | Preserve committed activity and the active session. Reconcile orders, reservations, fees, and pending results before trading resumes. Restore prior market/simulator intentions only after reconciliation; unresolved failures keep trading paused. |
| Session changes during an order            | Resolve against the old session or reject it as obsolete; never place it in the new session                                                                                                                                                         |
| Administrator operation fails or times out | Show pending/unknown/failed as appropriate, retain action identity, and recover its actual result before offering an unsafe repeat                                                                                                                  |
| Account or order limit is exceeded         | Return a specific rejection without silently accepting only part of the request                                                                                                                                                                     |

Administrator history records actor role/account reference, timestamp, session, action, target, reason, result, and resulting grant or order references where applicable. No secret values are included. Visible explanations and exports distinguish user actions, operator actions, simulator actions, and recovery actions.

The trader and developer interfaces enforce the same ownership, session, order, fee, restriction, and retry rules. MVP API coverage includes authentication for invited accounts, current session/market state, shared book and trades, own balances/history, order submission/status, and cancellation. A dedicated administrator automation API, API-key management console, and client libraries are deferred.

## Release acceptance criteria

Each criterion is a required observable result, not a claim of current implementation. Browser CI covers selected trader/admin workflows; it does not yet establish all full-release criteria below.

| ID  | Scenario                      | Passing result                                                                                                                                                                                                                   |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Fresh installation            | Following the documentation, an operator creates an administrator, invites a trader, enables liquidity, and reaches a first trade without external service credentials                                                           |
| A02 | Invitations and ownership     | Expired/revoked/used links fail; one trader cannot view or cancel another trader's private orders, including through the API or exports                                                                                          |
| A03 | Controlled partial fill       | With the simulator stopped, trader A sells 0.4 BTC-SIM at 50,000; trader B buys 0.1 at that price. A has 0.1 executed and 0.3 remaining; each side pays 5 USD-SIM                                                                |
| A04 | Cancellation and accounting   | A cancels the remaining 0.3 from A03. A finishes with 0.9 BTC-SIM and 104,995 USD-SIM; B has 1.1 BTC-SIM and 94,995 USD-SIM. The fee account holds 10 USD-SIM. Neither account retains a reservation for these terminal orders   |
| A05 | Ordering and self-trade       | Better prices execute first; equal-price orders follow acceptance order. An incoming order encountering its own resting order cancels its remainder without self-execution or skipping to worse prices                           |
| A06 | Guarded execution             | Depth within a confirmed market guard fills; quantity beyond that depth is canceled. A moved book cannot silently change the guard or overspend the reserved commitment                                                          |
| A07 | Reservations and fees         | Simultaneous orders cannot reuse reserved funds. Price improvement releases excess. The same total executed notional split across more fills yields the same per-order fee                                                       |
| A08 | Retry and recovery            | Lost acknowledgements and repeated requests do not duplicate orders, grants, cancellations, or new sessions. Restart preserves committed fills and recovers active orders and reservations                                       |
| A09 | Operator controls             | Confirmed pause blocks new orders/fills but permits cancellation. Suspension blocks trading and revokes access, with remaining orders canceled and existing fills preserved                                                      |
| A10 | Simulator lifecycle           | Both simulator accounts obey ordinary rules; stop fences queued work and cancels their orders. Inventory/shortfalls and pending cleanup are visible. Grants require a healthy pause; retries and restart never duplicate funding |
| A11 | Session rollover              | Starting a new session archives complete prior history, retains accounts/restrictions, allocates new funds once, and leaves the new session paused. Old-session requests cannot affect it                                        |
| A12 | Market truth                  | Candles and volume come from internal executions; the empty market contains no fabricated trade history. All funds and sessions are labeled simulated                                                                            |
| A13 | Explainability and export     | An operator and trader can trace A03/A04 through order detail, fees, released reservations, final balances, and correctly scoped export files                                                                                    |
| A14 | Developer onboarding          | Documented API examples can read a market, place a limit order, inspect it, and cancel its remainder under the same rules as the interface                                                                                       |
| A15 | Fault and rollover boundaries | An unresolved accounting fault blocks grants and session rollover. Enrollment or reinstatement during rollover cannot cause duplicate or missing allocations. Access revocation remains available during a fault                 |
| A16 | Coherent live export          | All exported datasets share a recorded as-of boundary; their balances, reservations, fills, grants, and fees reconcile while later trades remain outside that export                                                             |

A03 and A04 are isolated examples with fresh starting allocations, no other trades or grants, and the simulator stopped. These fixture prices make the arithmetic inspectable; they are not a real-market quote.

## Explicit exclusions

- Real assets, custody, wallet connections, blockchain/testnet transactions, deposits, withdrawals, bank connections, and fiat payments.
- Margin, leverage, short selling, futures, perpetuals, options, liquidation, lending, staking, and yield products.
- Public signup, social features, competitions, leaderboards, referrals, copy trading, and account impersonation.
- Realistic-profit claims, portfolio valuation, realized/unrealized profit dashboards, strategy backtesting, historical-market replay, and multiple scenario modes.
- External market feeds, external order routing, arbitrary asset listings, editable market rules, multiple simultaneous sessions, and a general plugin system.
- Advanced charting studies, native mobile apps, order amendments, stop orders, trailing orders, and additional order-duration choices.
- Direct balance edits, trade reversals, archive deletion, general role management, automated email, and runtime administrator promotion.
- Production-readiness claims for real-money operations. Enabling real funds is a separate product decision, not an MVP configuration switch.

## Handoff to architecture

Architecture work should address the behavior and acceptance criteria above. It must not silently expand the feature set or weaken order, balance, isolation, and recovery guarantees to suit a preferred stack.

The [architecture recommendation](ARCHITECTURE.md) addresses component boundaries, persistence and recovery, authentication, transport, deployment, and technology. Product changes belong in this specification; technical decisions and their tradeoffs belong in that design.
