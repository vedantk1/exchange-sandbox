import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  MarketPreviewView,
  OrderDetailResponse,
  WorkspaceOrderView,
  WorkspaceView,
} from '@sandbox/contracts';
import type { CommandOutcome } from '../lib/api.js';
import { BalanceActivity, BalanceCards, HistoryPanel, OrdersTable } from './AccountPanels.js';
import { OrderBook, PriceChart, RecentTrades } from './MarketPanels.js';
import { CancelDialog, OrderDetailDialog } from './OrderDialogs.js';
import { OrderTicket } from './OrderTicket.js';
import { shortId } from './amounts.js';
import './trader.css';

export interface TraderWorkspaceProps {
  workspace: WorkspaceView;
  connected: boolean;
  busy: boolean;
  section: 'trade' | 'orders' | 'balances' | 'history';
  runCommand: (
    path: string,
    body: Record<string, unknown>,
    label: string,
  ) => Promise<CommandOutcome | null>;
  readOrder: (id: string) => Promise<OrderDetailResponse>;
  previewMarket: (body: {
    sessionId: string;
    side: 'BUY' | 'SELL';
    quantity: string;
  }) => Promise<MarketPreviewView>;
  refresh: () => Promise<void>;
}

export function TraderWorkspace({
  workspace,
  connected,
  busy,
  section,
  runCommand,
  readOrder,
  previewMarket,
  refresh,
}: TraderWorkspaceProps) {
  const [selectedPrice, setSelectedPrice] = useState<{ price: string; key: number } | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [cancelSnapshot, setCancelSnapshot] = useState<{
    sessionId: string;
    orders: WorkspaceOrderView[];
  } | null>(null);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [sideFilter, setSideFilter] = useState('ALL');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const account = workspace.account;
  const trading = connected && !workspace.fault && workspace.marketState === 'TRADING';
  const cancelEnabled = connected && !workspace.fault;
  const disabledReason = !connected
    ? 'Reconnecting. New orders wait until the workspace is current.'
    : workspace.fault
      ? 'Accounting is paused for an administrator check. Orders and balances remain visible.'
      : workspace.marketState !== 'TRADING'
        ? 'Trading is paused. Existing orders keep their reservations and can still be canceled.'
        : busy
          ? 'Resolve the pending command before submitting another order.'
          : null;

  useEffect(() => {
    setSelectedPrice(null);
    setSelectedOrder(null);
    setCancelSnapshot(null);
  }, [workspace.sessionId]);

  if (!account)
    return (
      <div className="trader-empty">
        <strong>No trader account in this workspace.</strong>
      </div>
    );
  const merged = new Map(account.orders.map((order) => [order.id, order]));
  for (const order of account.openOrders) merged.set(order.id, order);
  const allOrders = [...merged.values()].sort((a, b) =>
    BigInt(a.sequence) > BigInt(b.sequence) ? -1 : BigInt(a.sequence) < BigInt(b.sequence) ? 1 : 0,
  );
  const filtered = allOrders.filter(
    (order) =>
      (statusFilter === 'ALL' ||
        (statusFilter === 'OPEN'
          ? ['OPEN', 'PARTIALLY_FILLED'].includes(order.status)
          : order.status === statusFilter)) &&
      (sideFilter === 'ALL' || order.side === sideFilter),
  );
  const requestCancel = (orders: WorkspaceOrderView[]) =>
    setCancelSnapshot({ sessionId: workspace.sessionId, orders: [...orders] });
  const headings = {
    trade: 'BTC-SIM / USD-SIM',
    orders: 'Your orders',
    balances: 'Balances & activity',
    history: 'Execution history',
  };
  const descriptions = {
    trade: 'One shared book. Every execution happens here.',
    orders: 'Track accepted orders, remaining quantities, and final outcomes.',
    balances: 'Every allocation, trade, fee, and reservation has a record.',
    history: 'Inspect your executions and durable command outcomes.',
  };

  return (
    <div className="trader-workspace">
      <div className="trader-page-heading">
        <div>
          <div className="trader-eyebrow">
            EXCHANGE SANDBOX <span>VIRTUAL ASSETS ONLY</span>
          </div>
          <h1>{headings[section]}</h1>
          <p>{descriptions[section]}</p>
        </div>
        <div className="trader-session-info">
          <span
            className={`trader-market-state ${workspace.fault ? 'fault' : workspace.marketState.toLowerCase()}`}
          >
            <i aria-hidden="true" />
            {workspace.fault
              ? 'Accounting check required'
              : workspace.marketState === 'TRADING'
                ? 'Trading open'
                : 'Market paused'}
          </span>
          <span title={workspace.sessionId}>
            Session <span className="mono">{shortId(workspace.sessionId)}</span>
          </span>
        </div>
      </div>
      {section !== 'trade' && (
        <div className="trader-section-toolbar">
          <span className="trader-caption">Current session · authoritative account data</span>
          <button
            className="button ghost small"
            type="button"
            disabled={refreshing}
            onClick={() => {
              setRefreshError(null);
              setRefreshing(true);
              void refresh()
                .catch(() =>
                  setRefreshError(
                    'The workspace could not be refreshed. Displayed records may be stale.',
                  ),
                )
                .finally(() => setRefreshing(false));
            }}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      )}
      {refreshError && (
        <p className="trader-notice error" role="alert">
          {refreshError}
        </p>
      )}
      {section === 'trade' ? (
        <div className="trader-trading-grid">
          <PriceChart market={workspace.market} />
          <OrderBook
            market={workspace.market}
            onPrice={(price) => setSelectedPrice({ price, key: Date.now() })}
          />
          <OrderTicket
            account={account}
            sessionId={workspace.sessionId}
            enabled={trading}
            disabledReason={disabledReason}
            busy={busy}
            selectedPrice={selectedPrice}
            runCommand={runCommand}
            previewMarket={previewMarket}
          />
          <BalanceCards account={account} />
          <section className="trader-panel trader-open-orders">
            <div className="trader-panel-header">
              <h2>
                Open orders <span className="trader-count">{account.openOrders.length}</span>
              </h2>
              <div className="trader-panel-actions">
                <Link className="trader-link" to="/orders">
                  All orders ↗
                </Link>
                <button
                  className="button ghost small"
                  type="button"
                  disabled={!cancelEnabled || busy || account.openOrders.length === 0}
                  onClick={() => requestCancel(account.openOrders)}
                >
                  Cancel all
                </button>
              </div>
            </div>
            <OrdersTable
              orders={account.openOrders}
              onSelect={setSelectedOrder}
              onCancel={requestCancel}
              disabled={!cancelEnabled || busy}
            />
          </section>
          <RecentTrades market={workspace.market} />
        </div>
      ) : section === 'orders' ? (
        <section className="trader-panel">
          <div className="trader-panel-header">
            <div className="trader-order-filters">
              <label>
                <span className="sr-only">Order status</span>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                >
                  <option value="ALL">All statuses</option>
                  <option value="OPEN">Open & partially filled</option>
                  <option value="FILLED">Filled</option>
                  <option value="CANCELED">Canceled</option>
                </select>
              </label>
              <label>
                <span className="sr-only">Order side</span>
                <select value={sideFilter} onChange={(event) => setSideFilter(event.target.value)}>
                  <option value="ALL">Both sides</option>
                  <option value="BUY">Buy</option>
                  <option value="SELL">Sell</option>
                </select>
              </label>
            </div>
            <button
              className="button ghost small"
              type="button"
              disabled={!cancelEnabled || busy || account.openOrders.length === 0}
              onClick={() => requestCancel(account.openOrders)}
            >
              Cancel all {account.openOrders.length} open orders
            </button>
          </div>
          <OrdersTable
            orders={filtered}
            onSelect={setSelectedOrder}
            onCancel={requestCancel}
            disabled={!cancelEnabled || busy}
          />
          <div className="trader-panel-note">
            All open orders plus the latest {account.historyLimit} accepted orders. Rejected
            submissions are recorded in <Link to="/history">History</Link>.
          </div>
        </section>
      ) : section === 'balances' ? (
        <div className="trader-section-stack">
          <BalanceActivity account={account} onSelect={setSelectedOrder} />
        </div>
      ) : (
        <HistoryPanel account={account} onSelect={setSelectedOrder} />
      )}
      <OrderDetailDialog
        id={selectedOrder}
        cursor={workspace.cursor}
        close={() => setSelectedOrder(null)}
        readOrder={readOrder}
        onCancel={requestCancel}
        disabled={!cancelEnabled || busy}
      />
      <CancelDialog
        snapshot={cancelSnapshot}
        close={() => setCancelSnapshot(null)}
        sessionId={workspace.sessionId}
        enabled={cancelEnabled}
        busy={busy}
        runCommand={runCommand}
      />
    </div>
  );
}
