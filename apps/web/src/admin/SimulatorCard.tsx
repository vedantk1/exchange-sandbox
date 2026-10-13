import { Status } from './AccountInspector';
import { amount, date } from './format';
import type { AdminAction, AdminData } from './types';

type DemoMarket = AdminData['overview']['demoMarket'];

export function SimulatorCard({
  simulator,
  paused,
  faulted,
  locked,
  inspect,
  onAction,
}: {
  simulator: DemoMarket;
  paused: boolean;
  faulted: boolean;
  locked: boolean;
  inspect: (accountId: string) => void;
  onAction: (action: AdminAction) => void;
}) {
  const stopping = simulator?.status === 'STOPPING';
  const start: AdminAction = {
    title: 'Start simulator',
    description: simulator
      ? 'Enable automated maker and taker orders using their existing inventory. Starting never refills funds or resets history. While the market is paused, the simulator waits for trading to resume.'
      : 'Create two automated accounts, each with 1 BTC-SIM and 100,000 USD-SIM, and enable simulated orders. This starting allocation happens once. While the market is paused, the simulator waits for trading to resume.',
    path: '/api/admin/simulator/start',
  };
  const stop: AdminAction = {
    title: 'Stop simulator',
    description:
      'Disable new automated orders and cancel only the maker and taker accounts’ unfilled orders. Preserve inventory, completed trades, and history. During an accounting fault, new orders stop immediately and cancellations remain pending until recovery.',
    path: '/api/admin/simulator/stop',
    danger: true,
  };
  return (
    <section className="admin-card" aria-labelledby="demo-market-heading">
      <div className="admin-card-heading">
        <div>
          <p className="admin-eyebrow">Synthetic activity</p>
          <h2 id="demo-market-heading">Demo market simulator</h2>
        </div>
        <div className="admin-operating-actions">
          <Status value={simulator?.status ?? 'NOT_STARTED'} />
          <button
            className={`button ${simulator?.enabled ? 'ghost' : 'primary'}`}
            disabled={locked || (!simulator?.enabled && (faulted || stopping))}
            onClick={() => onAction(simulator?.enabled ? stop : start)}
          >
            {simulator?.enabled ? 'Stop simulator' : 'Start simulator'}
          </button>
        </div>
      </div>
      <p className="admin-body-copy">
        The maker quotes both sides of the shared book; the taker creates small trades. Participants
        can trade with either account. These executions build the chart using synthetic prices.
        Start and stop are saved across server restarts. Pausing the market preserves the enabled
        setting.
      </p>
      {stopping && (
        <p className="admin-alert warning admin-simulator-notice" role="status">
          New automated orders are disabled. Cancellation of existing simulator orders is pending
          accounting recovery. Reconcile and resume trading after resolving the fault.
        </p>
      )}
      {simulator?.status === 'ERROR' && (
        <p className="admin-alert danger admin-simulator-notice" role="status">
          The worker reported an error. Activity is not confirmed healthy; inspect its accounts and
          server diagnostics. Stopping the simulator disables further attempts.
        </p>
      )}
      {simulator ? (
        <>
          <div className="admin-simulator-inventory">
            {(['maker', 'taker'] as const).map((role) => {
              const inventory = simulator.inventory[role];
              const accountId =
                role === 'maker' ? simulator.makerAccountId : simulator.takerAccountId;
              const name = `Demo ${role}`;
              const limited = inventory.orders.some((order) => !order.affordable);
              return (
                <article
                  className="admin-simulator-account"
                  key={role}
                  aria-label={`${name} inventory`}
                >
                  <div className="admin-card-heading">
                    <h3>{name}</h3>
                    <Status value={limited ? 'LIMITED_INVENTORY' : 'FUNDED'} />
                  </div>
                  <div className="admin-table-wrap">
                    <table className="admin-table">
                      <caption className="admin-sr-only">{name} balances</caption>
                      <thead>
                        <tr>
                          <th>Asset</th>
                          <th>Available</th>
                          <th>Reserved</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(['BTC-SIM', 'USD-SIM'] as const).map((asset) => (
                          <tr key={asset}>
                            <td>{asset}</td>
                            <td className="admin-number">
                              {amount(inventory.balances[asset].available)}
                            </td>
                            <td className="admin-number">
                              {amount(inventory.balances[asset].reserved)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="admin-quote-readiness" aria-label={`${name} order funding`}>
                    {inventory.orders.map((order, index) => (
                      <div className={order.affordable ? '' : 'limited'} key={index}>
                        <span>
                          {order.side} {amount(order.quantity)} BTC-SIM @ {amount(order.price)}
                        </span>
                        <strong>
                          {order.affordable
                            ? 'Funded'
                            : `Short ${amount(order.shortfall)} ${order.asset}`}
                        </strong>
                      </div>
                    ))}
                  </div>
                  <div className="admin-operating-actions">
                    <button className="button ghost" onClick={() => inspect(accountId)}>
                      Inspect demo {role}
                    </button>
                    <button
                      className="button ghost"
                      disabled={locked || !paused || faulted}
                      title={
                        !paused || faulted
                          ? 'Funding requires a paused, healthy market.'
                          : undefined
                      }
                      onClick={() =>
                        onAction({
                          title: 'Fund simulator account',
                          description:
                            'Issue a positive grant through the accounting journal to this automated account. Review the asset and amount before confirming. Funding does not start the simulator.',
                          path: '/api/admin/grants',
                          target: name,
                          grant: { accountId, label: name },
                        })
                      }
                    >
                      Fund demo {role}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          <p className="admin-body-copy">
            Funding preview uses reference {amount(simulator.referencePrice)} USD-SIM, includes buy
            fees, and assumes existing simulator reservations are released before the next cycle. It
            assumes no sale proceeds. The next price and actual fills can change requirements. Funds
            are finite; pause the market for an explicit grant when needed. There is no automatic
            refill.
          </p>
          <p className="admin-history-note">
            Last simulator update {date(simulator.updatedAt)}. This timestamp is the last persisted
            state change, not a worker heartbeat. Automated accounts have no login and are excluded
            from participant counts.
          </p>
        </>
      ) : (
        <p className="admin-history-note">
          First start creates the two accounts and their fixed allocation once. All controls and
          funding require an administrator reason.
        </p>
      )}
    </section>
  );
}
