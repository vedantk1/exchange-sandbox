import { useState } from 'react';
import type { AccountView, ActivityView, WorkspaceOrderView } from '@sandbox/contracts';
import { amount, shortId, stateLabel, timeLabel } from './amounts.js';

export function OrderStatus({ status }: { status: string }) {
  return <span className={`trader-status ${status.toLowerCase()}`}>{stateLabel(status)}</span>;
}

export function BalanceCards({ account }: { account: AccountView }) {
  return (
    <section className="trader-balance-cards" aria-label="Available balances">
      {(['BTC-SIM', 'USD-SIM'] as const).map((asset) => (
        <div className="trader-balance-card" key={asset}>
          <span
            className={`trader-asset-icon ${asset === 'BTC-SIM' ? 'btc' : 'usd'}`}
            aria-hidden="true"
          >
            {asset === 'BTC-SIM' ? '₿' : '$'}
          </span>
          <div>
            <span>{asset} available</span>
            <strong>
              {amount(account.balances[asset].available, asset === 'BTC-SIM' ? 4 : 2)}
            </strong>
            <small>
              {amount(account.balances[asset].reserved, asset === 'BTC-SIM' ? 4 : 2)} reserved
            </small>
          </div>
        </div>
      ))}
    </section>
  );
}

export function OrdersTable({
  orders,
  onSelect,
  onCancel,
  disabled,
}: {
  orders: WorkspaceOrderView[];
  onSelect: (id: string) => void;
  onCancel: (orders: WorkspaceOrderView[]) => void;
  disabled: boolean;
}) {
  if (!orders.length)
    return (
      <div className="trader-empty">
        <strong>No matching orders</strong>
        <p>Your accepted orders and their latest outcomes appear here.</p>
      </div>
    );
  return (
    <div className="trader-table-scroll">
      <table className="trader-table">
        <thead>
          <tr>
            <th>Order / time</th>
            <th>Side</th>
            <th className="numeric">Limit / guard · USD-SIM</th>
            <th className="numeric">Filled / quantity · BTC-SIM</th>
            <th>Status</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id}>
              <td>
                <button
                  className="trader-link mono"
                  type="button"
                  onClick={() => onSelect(order.id)}
                >
                  {shortId(order.id)} ↗
                </button>
                <time
                  className="trader-cell-sub"
                  dateTime={order.createdAt}
                  title={new Date(order.createdAt).toLocaleString()}
                >
                  {timeLabel(order.createdAt)}
                </time>
              </td>
              <td>
                <span className={`trader-side ${order.side.toLowerCase()}`}>
                  {order.side === 'BUY' ? 'Buy' : 'Sell'}
                </span>
                <span className="trader-cell-sub">
                  {order.type === 'MARKET' ? 'Protected market' : 'Limit'}
                </span>
              </td>
              <td className="numeric">
                {amount(order.price)}
                {order.type === 'MARKET' && (
                  <span className="trader-cell-sub">
                    {order.side === 'BUY' ? 'Maximum' : 'Minimum'} guard
                  </span>
                )}
              </td>
              <td className="numeric">
                {amount(order.executedQuantity, 4)}{' '}
                <span className="muted">/ {amount(order.quantity, 4)}</span>
              </td>
              <td>
                <OrderStatus status={order.status} />
              </td>
              <td className="trader-actions-cell">
                {['OPEN', 'PARTIALLY_FILLED'].includes(order.status) && (
                  <button
                    className="button ghost small"
                    type="button"
                    disabled={disabled}
                    onClick={() => onCancel([order])}
                  >
                    Cancel
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BalanceActivity({
  account,
  onSelect,
}: {
  account: AccountView;
  onSelect: (id: string) => void;
}) {
  const [assetFilter, setAssetFilter] = useState('ALL');
  const activity = account.activity.filter(
    (row) => assetFilter === 'ALL' || row.asset === assetFilter,
  );
  return (
    <>
      <section className="trader-panel">
        <div className="trader-panel-header">
          <h2>Holdings</h2>
          <span className="trader-tag">Virtual assets</span>
        </div>
        <div className="trader-table-scroll">
          <table className="trader-table trader-balance-table">
            <thead>
              <tr>
                <th>Asset</th>
                <th className="numeric">Available</th>
                <th className="numeric">Reserved</th>
                <th className="numeric">Total</th>
              </tr>
            </thead>
            <tbody>
              {(['BTC-SIM', 'USD-SIM'] as const).map((asset) => (
                <tr key={asset}>
                  <td>
                    <strong>{asset}</strong>
                    <span className="trader-cell-sub">
                      {asset === 'BTC-SIM' ? 'Simulated base asset' : 'Simulated quote asset'}
                    </span>
                  </td>
                  {(['available', 'reserved', 'total'] as const).map((bucket) => (
                    <td className="numeric" key={bucket}>
                      {amount(account.balances[asset][bucket], asset === 'BTC-SIM' ? 4 : 2)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="trader-panel-note">
          Available funds can back new orders. Reserved funds back remaining orders. Canceling an
          order releases only its remaining reservation.
        </div>
      </section>
      <section className="trader-panel">
        <div className="trader-panel-header">
          <div>
            <h2>Balance activity</h2>
            <span className="trader-caption">
              Latest {account.historyLimit} journal entries · exact asset changes
            </span>
          </div>
          <label className="trader-inline-filter">
            <span className="sr-only">Filter activity by asset</span>
            <select value={assetFilter} onChange={(event) => setAssetFilter(event.target.value)}>
              <option value="ALL">All assets</option>
              <option>BTC-SIM</option>
              <option>USD-SIM</option>
            </select>
          </label>
        </div>
        <ActivityTable activity={activity} onSelect={onSelect} />
      </section>
    </>
  );
}

export function ActivityTable({
  activity,
  onSelect,
}: {
  activity: ActivityView[];
  onSelect: (id: string) => void;
}) {
  if (!activity.length)
    return (
      <div className="trader-empty">
        <strong>No balance activity to show</strong>
        <p>Allocations, grants, trades, fees, and reservation movements appear here.</p>
      </div>
    );
  return (
    <div className="trader-table-scroll">
      <table className="trader-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Cause</th>
            <th>Asset / balance</th>
            <th className="numeric">Change</th>
            <th>Order / command</th>
          </tr>
        </thead>
        <tbody>
          {activity.map((row) => (
            <tr key={row.id}>
              <td>
                <time dateTime={row.createdAt} title={new Date(row.createdAt).toLocaleString()}>
                  {timeLabel(row.createdAt)}
                </time>
              </td>
              <td>{stateLabel(row.kind)}</td>
              <td>
                {row.asset}
                <span className="trader-cell-sub">{stateLabel(row.bucket)}</span>
              </td>
              <td
                className={`numeric ${row.amount.startsWith('-') ? 'trader-negative' : 'trader-positive'}`}
              >
                {row.amount.startsWith('-') ? '' : '+'}
                {amount(row.amount, row.asset === 'BTC-SIM' ? 4 : 2)}
              </td>
              <td>
                {row.orderId ? (
                  <button
                    className="trader-link mono"
                    type="button"
                    onClick={() => onSelect(row.orderId!)}
                  >
                    {shortId(row.orderId)} ↗
                  </button>
                ) : row.commandId ? (
                  <span className="mono" title={row.commandId}>
                    {shortId(row.commandId)}
                  </span>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HistoryPanel({
  account,
  onSelect,
}: {
  account: AccountView;
  onSelect: (id: string) => void;
}) {
  const [tab, setTab] = useState<'fills' | 'commands'>('fills');
  return (
    <section className="trader-panel">
      <div className="trader-panel-header">
        <div className="trader-tabs" role="group" aria-label="History view">
          <button
            type="button"
            aria-pressed={tab === 'fills'}
            className={tab === 'fills' ? 'active' : ''}
            onClick={() => setTab('fills')}
          >
            Executions <span>{account.fills.length}</span>
          </button>
          <button
            type="button"
            aria-pressed={tab === 'commands'}
            className={tab === 'commands' ? 'active' : ''}
            onClick={() => setTab('commands')}
          >
            Command outcomes
          </button>
        </div>
        <span className="trader-caption">Latest {account.historyLimit} per view</span>
      </div>
      {tab === 'fills' ? (
        account.fills.length ? (
          <div className="trader-table-scroll">
            <table className="trader-table">
              <thead>
                <tr>
                  <th>Time / order</th>
                  <th>Side / role</th>
                  <th className="numeric">Quantity · BTC-SIM</th>
                  <th className="numeric">Price · USD-SIM</th>
                  <th className="numeric">Notional · USD-SIM</th>
                  <th className="numeric">Your fee · USD-SIM</th>
                </tr>
              </thead>
              <tbody>
                {account.fills.map((fill) => (
                  <tr key={`${fill.id}:${fill.orderId}`}>
                    <td>
                      <time dateTime={fill.timestamp}>{timeLabel(fill.timestamp)}</time>
                      <button
                        className="trader-link trader-cell-sub mono"
                        type="button"
                        onClick={() => onSelect(fill.orderId)}
                      >
                        {shortId(fill.orderId)} ↗
                      </button>
                    </td>
                    <td>
                      <span className={`trader-side ${fill.side.toLowerCase()}`}>
                        {stateLabel(fill.side)}
                      </span>
                      <span className="trader-cell-sub">{stateLabel(fill.role)}</span>
                    </td>
                    <td className="numeric">{amount(fill.quantity, 4)}</td>
                    <td className="numeric">{amount(fill.price)}</td>
                    <td className="numeric">{amount(fill.notional)}</td>
                    <td className="numeric">{amount(fill.fee)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="trader-empty">
            <strong>No executions yet</strong>
            <p>When your orders match, each execution and its exact fee appears here.</p>
          </div>
        )
      ) : account.commands.length ? (
        <div className="trader-table-scroll">
          <table className="trader-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Command</th>
                <th>Sequence</th>
                <th>Outcome</th>
                <th>Order / reason</th>
              </tr>
            </thead>
            <tbody>
              {account.commands.map((command) => (
                <tr key={command.commandId}>
                  <td>
                    <time dateTime={command.createdAt}>{timeLabel(command.createdAt)}</time>
                  </td>
                  <td className="mono" title={command.commandId}>
                    {shortId(command.commandId)}
                  </td>
                  <td className="mono">#{command.sequence}</td>
                  <td>
                    <OrderStatus status={command.status} />
                  </td>
                  <td>
                    {command.orderId ? (
                      <button
                        className="trader-link mono"
                        type="button"
                        onClick={() => onSelect(command.orderId!)}
                      >
                        {shortId(command.orderId)} ↗
                      </button>
                    ) : command.code ? (
                      stateLabel(command.code)
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="trader-empty">
          <strong>No trading commands yet</strong>
          <p>Accepted and rejected submissions remain visible here after their outcome is known.</p>
        </div>
      )}
      <div className="trader-panel-note">
        Current session only. Executions are permanent; a later cancellation cannot reverse them.
      </div>
    </section>
  );
}
