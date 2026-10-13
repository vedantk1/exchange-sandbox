import { useEffect, useState } from 'react';
import type { AccountView } from '@sandbox/contracts';
import type { CommandOutcome } from '../lib/api';
import { AccountInspector, Empty, Status } from './AccountInspector';
import { ActionDialog, SecretDialog } from './ActionDialog';
import { SimulatorCard } from './SimulatorCard';
import { date, label } from './format';
import type { AdminAction, AdminWorkspaceProps } from './types';
import './admin.css';

type Tab = 'overview' | 'participants' | 'invitations' | 'audit';

export function AdminWorkspace({
  workspace,
  connected,
  busy,
  runCommand,
  readAccount,
  refresh,
}: AdminWorkspaceProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountRead, setAccountRead] = useState(0);
  const [action, setAction] = useState<AdminAction | null>(null);
  const [secret, setSecret] = useState<{
    kind: 'join' | 'recover';
    token: string;
    target?: string;
  } | null>(null);
  const [notice, setNotice] = useState<{ tone: string; text: string; details?: string[] } | null>(
    null,
  );
  const admin = workspace.admin;

  useEffect(() => {
    let current = true;
    if (!selectedId) return;
    setAccountLoading(true);
    setAccountError(null);
    void readAccount(selectedId)
      .then((value) => {
        if (current) setAccount(value);
      })
      .catch(() => {
        if (current)
          setAccountError(
            'Account refresh failed. The previous view may be stale; retry before acting on these balances.',
          );
      })
      .finally(() => {
        if (current) setAccountLoading(false);
      });
    return () => {
      current = false;
    };
  }, [selectedId, workspace.cursor, readAccount, accountRead]);

  if (!admin) return null;
  const { overview, traders, invitations, audit } = admin;
  const demoMarket = overview.demoMarket;
  const selected = traders.find((trader) => trader.accountId === selectedId);
  const systemName =
    selectedId && selectedId === overview.feeAccountId
      ? 'System fee account'
      : selectedId && selectedId === overview.issuanceAccountId
        ? 'Virtual issuance account'
        : selectedId && selectedId === demoMarket?.makerAccountId
          ? 'Demo market maker account'
          : selectedId && selectedId === demoMarket?.takerAccountId
            ? 'Demo market taker account'
            : selectedId && !selected
              ? `Account ${selectedId.slice(0, 8)}`
              : undefined;
  const selectedSimulator =
    selectedId &&
    (selectedId === demoMarket?.makerAccountId || selectedId === demoMarket?.takerAccountId)
      ? { accountId: selectedId, label: systemName! }
      : undefined;
  const simulatorGrantInventory =
    action?.grant?.accountId === demoMarket?.makerAccountId
      ? demoMarket?.inventory.maker
      : action?.grant?.accountId === demoMarket?.takerAccountId
        ? demoMarket?.inventory.taker
        : undefined;
  const grantBalances =
    simulatorGrantInventory?.balances ??
    (selected &&
    action?.grant?.accountId === selected.accountId &&
    selected.status === 'ACTIVE' &&
    !accountLoading &&
    !accountError
      ? (account?.balances ?? null)
      : null);
  const locked = busy || !connected;
  const paused = overview.marketState === 'PAUSED';
  const faulted = Boolean(overview.fault);
  const filtered = traders.filter(
    (trader) =>
      trader.handle.includes(query.toLowerCase()) || trader.accountId.includes(query.toLowerCase()),
  );
  const activeInvitations = invitations.filter(
    (invitation) => invitation.state === 'PENDING',
  ).length;
  const marketAction: AdminAction = paused
    ? {
        title: 'Resume trading',
        description:
          'Reconcile the accounting records, finish any safe pending cancellations, and reopen order submission and matching. An unresolved accounting fault prevents resume. An enabled demo simulator can resume placing orders when trading reopens.',
        path: '/api/admin/market/resume',
      }
    : {
        title: 'Pause trading',
        description:
          'Stop new orders and matching after this action is confirmed. Existing orders and reservations remain. Reads and cancellations stay available; earlier accepted fills may complete before confirmation.',
        path: '/api/admin/market/pause',
      };

  function inspect(accountId: string) {
    if (selectedId !== accountId) {
      setAccount(null);
      setAccountError(null);
    }
    setSelectedId(accountId);
    setTab('participants');
  }

  function recordOutcome(result: CommandOutcome, current: AdminAction) {
    if (result.status === 'REJECTED') {
      setNotice({
        tone: 'warning',
        text: `${current.title} was rejected: ${label(result.code ?? 'rejected')}. No success is assumed.`,
      });
      return;
    }
    const data = result.data;
    if (data?.ok === false) {
      setNotice({
        tone: 'danger',
        text: 'Reconciliation found an accounting fault. Financial actions remain blocked until the underlying issue is resolved.',
        details: Array.isArray(data.issues) ? data.issues.map(String) : [],
      });
    } else if (current.path === '/api/admin/simulator/stop' && data?.pendingCancellation === true) {
      setNotice({
        tone: 'warning',
        text: 'New simulator orders are disabled. Existing order cancellations remain pending until accounting recovery succeeds.',
      });
    } else if (data?.pendingCancellation === true) {
      setNotice({
        tone: 'warning',
        text: 'Access was revoked. Order cancellations remain pending until accounting recovery succeeds.',
      });
    } else if (current.secret && !result.token) {
      setNotice({
        tone: 'warning',
        text:
          current.secret === 'join'
            ? 'The invitation was created, but this response does not contain its one-time secret. Revoke the invitation and create a replacement.'
            : 'The recovery request completed, but its one-time secret is unavailable. Create a replacement recovery link to invalidate the previous one.',
      });
    } else {
      setNotice({
        tone: 'positive',
        text:
          data?.ok === true
            ? 'Reconciliation passed. This check does not change the market state.'
            : `${current.title} confirmed by the server.`,
      });
    }
  }

  async function confirm(payload: Record<string, unknown>) {
    if (!action) return;
    const current = action;
    const result = await runCommand(current.path, payload, current.title);
    setAction(null);
    if (result) {
      recordOutcome(result, current);
      if (result.status === 'ACCEPTED' && current.secret && result.token) {
        setSecret({
          kind: current.secret,
          token: result.token,
          ...(current.target ? { target: current.target } : {}),
        });
      }
      setAccountRead((value) => value + 1);
      // A failed refresh does not undo the committed action; the shared connection
      // banner marks the workspace stale and prevents further commands.
      await refresh().catch(() => undefined);
    }
  }

  return (
    <div className="admin-workspace">
      <header className="admin-page-heading">
        <div>
          <p className="admin-eyebrow">Exchange operations</p>
          <h1>
            Control room<span className="admin-role-label">Administrator</span>
          </h1>
          <p>Run the sandbox with a clear record of every decision.</p>
        </div>
        <div className="admin-market-control">
          <Status value={faulted ? 'FAULT' : overview.marketState} />
          <button
            className={`button ${paused ? 'primary' : 'ghost'}`}
            disabled={locked}
            onClick={() => setAction(marketAction)}
          >
            {paused ? 'Resume trading' : 'Pause trading'}
          </button>
        </div>
      </header>
      <nav className="admin-nav" aria-label="Administrator views">
        {(
          [
            { id: 'overview', label: 'Overview' },
            { id: 'participants', label: 'Participants' },
            { id: 'invitations', label: 'Invitations' },
            { id: 'audit', label: 'Audit history' },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? 'selected' : ''}
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === 'invitations' && activeInvitations > 0 && <span>{activeInvitations}</span>}
          </button>
        ))}
      </nav>
      {notice && (
        <div className={`admin-alert ${notice.tone}`} role="status">
          <div>
            <p>{notice.text}</p>
            {notice.details?.length ? (
              <ul>
                {notice.details.map((detail, index) => (
                  <li key={index}>{detail}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <button
            className="admin-dismiss"
            aria-label="Dismiss action result"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </div>
      )}
      {faulted && (
        <div className="admin-alert danger" role="alert">
          <div>
            <strong>Accounting recovery required</strong>
            <p>{overview.fault}</p>
            <p>
              Reads, access revocation, and stopping the simulator are available. Financial actions
              cannot bypass this fault.
            </p>
          </div>
        </div>
      )}
      {overview.counts.pending !== '0' && (
        <div className="admin-alert warning" role="status">
          <div>
            <strong>{overview.counts.pending} suspended account(s) awaiting cancellation</strong>
            <p>
              Access is already revoked. Review the accounting fault and reconcile before resuming.
            </p>
          </div>
        </div>
      )}
      {tab === 'overview' && (
        <>
          <section className="admin-metrics" aria-label="Exchange operational counts">
            <Metric
              title="Participants"
              value={overview.counts.traders}
              detail={`${overview.counts.suspended} suspended`}
            />
            <Metric
              title="Open orders"
              value={overview.counts.open_orders}
              detail="Reservations remain during pause"
            />
            <Metric
              title="Pending invitations"
              value={String(activeInvitations)}
              detail="From the latest 200 invitations"
            />
            <Metric
              title="Accounting"
              value={faulted ? 'Attention' : 'Healthy'}
              detail={faulted ? 'Financial actions blocked' : 'No recorded consistency fault'}
            />
          </section>
          <div className="admin-overview-grid">
            <section className="admin-card">
              <div className="admin-card-heading">
                <div>
                  <p className="admin-eyebrow">Operating state</p>
                  <h2>{paused ? 'Market is paused' : 'Market is trading'}</h2>
                </div>
                <span className={`admin-state-dot ${paused ? 'paused' : ''}`} aria-hidden="true" />
              </div>
              <p className="admin-body-copy">
                {paused
                  ? 'New orders and matching are stopped. Existing orders retain their reservations; participants can still inspect and cancel their remaining quantities when accounting is healthy.'
                  : 'Participants can submit limit and protected market orders. Orders execute using price and time priority.'}
              </p>
              <div className="admin-session">
                <span>Active session</span>
                <code>{workspace.sessionId}</code>
              </div>
              <div className="admin-operating-actions">
                <button
                  className="button ghost"
                  disabled={locked}
                  onClick={() =>
                    setAction({
                      title: 'Check reconciliation',
                      description:
                        'Compare the journal, balances, reservations, and exchange records. A failed check records an accounting fault and pauses trading. Passing a check does not automatically resume trading.',
                      path: '/api/admin/reconcile',
                    })
                  }
                >
                  Run reconciliation
                </button>
                <button
                  className="button ghost"
                  onClick={() => void refresh().catch(() => undefined)}
                >
                  Refresh workspace
                </button>
              </div>
            </section>
            <section className="admin-card">
              <div className="admin-card-heading">
                <div>
                  <p className="admin-eyebrow">Getting the market ready</p>
                  <h2>A deliberate start</h2>
                </div>
              </div>
              <ol className="admin-checklist">
                <li>
                  <span className={traders.length ? 'done' : ''}>{traders.length ? '✓' : '1'}</span>
                  <div>
                    <strong>Invite participants</strong>
                    <p>Each new trader receives 1 BTC-SIM and 100,000 USD-SIM.</p>
                    <button className="admin-link" onClick={() => setTab('invitations')}>
                      Manage invitations →
                    </button>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <strong>Review the market rules</strong>
                    <p>
                      BTC-SIM / USD-SIM · limit and protected market orders · 0.10% fee on each
                      side. The optional demo simulator uses these same market rules.
                    </p>
                  </div>
                </li>
                <li>
                  <span className={!paused ? 'done' : ''}>{!paused ? '✓' : '3'}</span>
                  <div>
                    <strong>Resume when ready</strong>
                    <p>All operator actions require a reason and a confirmed server result.</p>
                  </div>
                </li>
              </ol>
            </section>
          </div>
          <SimulatorCard
            simulator={demoMarket}
            paused={paused}
            faulted={faulted}
            locked={locked}
            inspect={inspect}
            onAction={setAction}
          />
          <section className="admin-card">
            <div className="admin-card-heading">
              <div>
                <p className="admin-eyebrow">Ledger visibility</p>
                <h2>System accounts</h2>
              </div>
            </div>
            <div className="admin-system-accounts">
              <div>
                <strong>Fee collection</strong>
                <p>Inspect simulated trading fees collected by the exchange.</p>
                <button
                  className="button ghost"
                  disabled={!overview.feeAccountId}
                  onClick={() => {
                    if (overview.feeAccountId) inspect(overview.feeAccountId);
                  }}
                >
                  Inspect fee account
                </button>
              </div>
              <div>
                <strong>Virtual issuance</strong>
                <p>Inspect the balancing side of allocations and positive grants.</p>
                <button
                  className="button ghost"
                  disabled={!overview.issuanceAccountId}
                  onClick={() => {
                    if (overview.issuanceAccountId) inspect(overview.issuanceAccountId);
                  }}
                >
                  Inspect issuance account
                </button>
              </div>
            </div>
          </section>
        </>
      )}
      {tab === 'participants' && (
        <div className="admin-participant-layout">
          <section className="admin-card admin-participant-list">
            <div className="admin-card-heading">
              <div>
                <p className="admin-eyebrow">Access & accounts</p>
                <h2>Participants</h2>
              </div>
            </div>
            <label className="admin-search">
              <span className="admin-sr-only">Find participant by handle or account ID</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find handle or account ID"
              />
            </label>
            <div className="admin-trader-list">
              {filtered.length ? (
                filtered.map((trader) => (
                  <button
                    className={`admin-trader ${selectedId === trader.accountId ? 'selected' : ''}`}
                    key={trader.accountId}
                    onClick={() => inspect(trader.accountId)}
                    aria-pressed={selectedId === trader.accountId}
                  >
                    <span className="admin-avatar" aria-hidden="true">
                      {trader.handle.slice(0, 2).toUpperCase()}
                    </span>
                    <span>
                      <strong>@{trader.handle}</strong>
                      <small>
                        {trader.pendingCancellation ? 'Cancellation pending' : label(trader.status)}
                      </small>
                    </span>
                    <span className="admin-chevron" aria-hidden="true">
                      ›
                    </span>
                  </button>
                ))
              ) : (
                <Empty
                  title={query ? 'No matching participant' : 'No participants yet'}
                  description={
                    query
                      ? 'Search applies to the first 200 participants.'
                      : 'Create an invitation to let someone join the sandbox.'
                  }
                />
              )}
            </div>
            {filtered.length === 0 &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                query.toLowerCase(),
              ) && (
                <button className="button ghost" onClick={() => inspect(query.toLowerCase())}>
                  Inspect this account ID
                </button>
              )}
            <p className="admin-history-note">First 200 participants by handle.</p>
          </section>
          <AccountInspector
            key={selectedId}
            account={account}
            trader={selected}
            systemName={systemName}
            simulatorAccount={selectedSimulator}
            loading={accountLoading}
            error={accountError}
            locked={locked || Boolean(accountError)}
            canGrant={paused && !faulted}
            fault={faulted}
            onAction={setAction}
            retry={() => setAccountRead((value) => value + 1)}
          />
        </div>
      )}
      {tab === 'invitations' && (
        <section className="admin-card">
          <div className="admin-card-heading">
            <div>
              <p className="admin-eyebrow">Private access</p>
              <h2>Invitations</h2>
              <p className="admin-body-copy">
                Single-use links expire after 24 hours. The application never sends them for you.
              </p>
            </div>
            <button
              className="button primary"
              disabled={locked}
              onClick={() =>
                setAction({
                  title: 'Create invitation',
                  description:
                    'Create a single-use invitation valid for 24 hours. The person chooses their own handle and password and receives the fixed starting allocation. Copy the secret link from the next screen; it cannot be retrieved later.',
                  path: '/api/admin/invitations',
                  secret: 'join',
                })
              }
            >
              Create invitation
            </button>
          </div>
          {invitations.length ? (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <caption className="admin-sr-only">Invitation metadata</caption>
                <thead>
                  <tr>
                    <th>Invitation</th>
                    <th>Created / expires</th>
                    <th>Status</th>
                    <th>Redeemed by</th>
                    <th>
                      <span className="admin-sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((invitation) => (
                    <tr key={invitation.id}>
                      <td>
                        <code title={invitation.id}>{invitation.id.slice(0, 8)}</code>
                      </td>
                      <td>
                        {date(invitation.createdAt)}
                        <small>Expires {date(invitation.expiresAt)}</small>
                      </td>
                      <td>
                        <Status value={invitation.state} />
                      </td>
                      <td>
                        {invitation.redeemedBy ? (
                          <button
                            className="admin-link"
                            onClick={() => inspect(invitation.redeemedBy!)}
                          >
                            {traders.find((trader) => trader.accountId === invitation.redeemedBy)
                              ?.handle ?? invitation.redeemedBy.slice(0, 8)}
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {invitation.state === 'PENDING' && (
                          <button
                            className="button ghost admin-small-button"
                            disabled={locked}
                            onClick={() =>
                              setAction({
                                title: 'Revoke invitation',
                                description:
                                  'Permanently invalidate this unused invitation. It will no longer allow an account to be created.',
                                path: `/api/admin/invitations/${invitation.id}/revoke`,
                                target: invitation.id,
                                danger: true,
                              })
                            }
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="Your first invitation starts here"
              description="Create a link, share it privately, and watch the participant appear after redemption."
            />
          )}
          <p className="admin-history-note">
            Latest 200 invitations. Secret links are never stored in this list.
          </p>
        </section>
      )}
      {tab === 'audit' && (
        <section className="admin-card">
          <div className="admin-card-heading">
            <div>
              <p className="admin-eyebrow">Recorded decisions</p>
              <h2>Administrator history</h2>
              <p className="admin-body-copy">
                Reasons and committed outcomes, including business rejections. Credential secrets
                never appear here.
              </p>
            </div>
          </div>
          {audit.length ? (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <caption className="admin-sr-only">Recent administrative actions</caption>
                <thead>
                  <tr>
                    <th>Action / time</th>
                    <th>Target</th>
                    <th>Reason</th>
                    <th>Result</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((entry) => (
                    <tr key={entry.id}>
                      <td className="admin-capitalize">
                        {label(entry.action)}
                        <small>{date(entry.createdAt)}</small>
                      </td>
                      <td>
                        {entry.targetId
                          ? (traders.find((trader) => trader.accountId === entry.targetId)
                              ?.handle ?? entry.targetId.slice(0, 8))
                          : 'Exchange'}
                      </td>
                      <td className="admin-reason">{entry.reason}</td>
                      <td>
                        <Status value={String(entry.result.status ?? 'RECORDED')} />
                        {entry.result.code != null && (
                          <small>{label(String(entry.result.code))}</small>
                        )}
                        {typeof entry.result.data === 'object' &&
                          entry.result.data !== null &&
                          'pendingCancellation' in entry.result.data &&
                          entry.result.data.pendingCancellation === true && (
                            <small>Cancellation pending</small>
                          )}
                        {typeof entry.result.data === 'object' &&
                          entry.result.data !== null &&
                          'ok' in entry.result.data &&
                          entry.result.data.ok === false && <small>Accounting fault found</small>}
                      </td>
                      <td>
                        <details>
                          <summary className="admin-link">Inspect</summary>
                          <div className="admin-audit-detail">
                            <span>Command</span>
                            <code>{entry.commandId}</code>
                            <span>Target</span>
                            <code>{entry.targetId ?? 'Exchange'}</code>
                            <span>Recorded outcome</span>
                            <pre>{JSON.stringify(entry.result, null, 2)}</pre>
                          </div>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No recorded actions yet"
              description="Invitations, access changes, market controls, grants, and reconciliation checks appear here."
            />
          )}
          <p className="admin-history-note">Most recent 100 administrator actions.</p>
        </section>
      )}
      <footer className="admin-footer">
        <span>SIMULATED ASSETS ONLY</span>
        <p>
          The administrator does not hold a trading balance. Use a separately invited participant
          account to trade. Times use your browser’s local timezone.
        </p>
      </footer>
      {action && (
        <ActionDialog
          action={action}
          balances={grantBalances}
          busy={busy}
          connected={connected}
          unavailableReason={
            action.grant && (!paused || faulted || !grantBalances)
              ? 'Grant confirmation requires a current eligible account view and a paused, healthy market.'
              : action.path === '/api/admin/simulator/start' &&
                  (faulted || demoMarket?.status === 'STOPPING')
                ? 'Starting requires healthy accounting and completion of pending simulator cancellations.'
                : null
          }
          onClose={() => setAction(null)}
          onConfirm={confirm}
        />
      )}
      {secret && <SecretDialog secret={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function Metric({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <article className="admin-metric">
      <span>{title}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}
