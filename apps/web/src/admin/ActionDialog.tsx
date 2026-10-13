import { useState, type FormEvent } from 'react';
import type { AccountView } from '@sandbox/contracts';
import { Dialog } from '../components/ui';
import { addExact, amount, validGrant } from './format';
import type { AdminAction } from './types';

export function ActionDialog({
  action,
  balances,
  busy,
  connected,
  unavailableReason,
  onClose,
  onConfirm,
}: {
  action: AdminAction;
  balances: AccountView['balances'] | null;
  busy: boolean;
  connected: boolean;
  unavailableReason: string | null;
  onClose: () => void;
  onConfirm: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [asset, setAsset] = useState<'BTC-SIM' | 'USD-SIM'>('USD-SIM');
  const [grantAmount, setGrantAmount] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const validReason = reason.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(reason);
  const validAmount = !action.grant || validGrant(grantAmount, asset);
  const locked = busy || submitting;
  const balance = balances?.[asset];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!validReason || !validAmount || locked || !connected || unavailableReason) return;
    if (action.grant && !reviewing) {
      setReviewing(true);
      return;
    }
    setSubmitting(true);
    try {
      await onConfirm({
        ...action.payload,
        reason: reason.trim(),
        ...(action.grant ? { accountId: action.grant.accountId, asset, amount: grantAmount } : {}),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
      title={action.title}
      description={action.description}
    >
      <form className="admin-action-form" onSubmit={(event) => void submit(event)}>
        {action.target && (
          <div className="admin-target">
            <span>Participant / target</span>
            <strong>{action.target}</strong>
          </div>
        )}
        {action.grant && !reviewing && (
          <div className="admin-form-grid">
            <label>
              Simulated asset
              <select
                value={asset}
                onChange={(event) => setAsset(event.target.value as typeof asset)}
                disabled={locked}
              >
                <option>USD-SIM</option>
                <option>BTC-SIM</option>
              </select>
            </label>
            <label>
              Amount
              <input
                inputMode="decimal"
                value={grantAmount}
                onChange={(event) => setGrantAmount(event.target.value)}
                placeholder={asset === 'BTC-SIM' ? '0.0000' : '0.00'}
                maxLength={64}
                autoComplete="off"
                required
                disabled={locked}
                aria-describedby="grant-help"
              />
            </label>
            <p id="grant-help" className="admin-field-help">
              Positive amounts only.{' '}
              {asset === 'BTC-SIM'
                ? 'Up to 100 BTC-SIM with 4 decimal places.'
                : 'Up to 10,000,000 USD-SIM with 9 decimal places.'}
            </p>
          </div>
        )}
        {!reviewing && (
          <label>
            Reason
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Explain why this action is needed"
              maxLength={500}
              required
              autoComplete="off"
              disabled={locked}
            />
            <span className="admin-field-help">
              Recorded in administrator history. Do not include passwords or link secrets.
            </span>
          </label>
        )}
        {action.grant && reviewing && (
          <div className="admin-review" aria-label="Grant review">
            <dl>
              <div>
                <dt>Account</dt>
                <dd>{action.grant.label}</dd>
              </div>
              <div>
                <dt>Virtual funds to issue</dt>
                <dd className="admin-number">
                  +{amount(grantAmount)} {asset}
                </dd>
              </div>
              {balance && (
                <>
                  <div>
                    <dt>Available before</dt>
                    <dd className="admin-number">
                      {amount(balance.available)} {asset}
                    </dd>
                  </div>
                  <div>
                    <dt>Available after grant</dt>
                    <dd className="admin-number">
                      {amount(
                        addExact(balance.available, grantAmount, asset === 'BTC-SIM' ? 4 : 9),
                      )}{' '}
                      {asset}
                    </dd>
                  </div>
                  <div>
                    <dt>Reserved (unchanged)</dt>
                    <dd className="admin-number">
                      {amount(balance.reserved)} {asset}
                    </dd>
                  </div>
                </>
              )}
              <div>
                <dt>Reason</dt>
                <dd>{reason.trim()}</dd>
              </div>
            </dl>
            <p>
              Projected from the latest account snapshot. The server checks the paused market and
              records the actual result when confirmed.
            </p>
          </div>
        )}
        {!connected && (
          <p className="admin-alert warning" role="status">
            Live connection unavailable. Wait for a fresh snapshot before confirming.
          </p>
        )}
        {unavailableReason && (
          <p className="admin-alert warning" role="status">
            {unavailableReason}
          </p>
        )}
        <div className="admin-dialog-actions">
          <button
            type="button"
            className="button ghost"
            disabled={locked}
            onClick={() => (reviewing ? setReviewing(false) : onClose())}
          >
            {reviewing ? 'Back to edit' : 'Keep unchanged'}
          </button>
          <button
            className={`button ${action.danger ? 'danger' : 'primary'}`}
            disabled={
              !validReason || !validAmount || locked || !connected || Boolean(unavailableReason)
            }
            type="submit"
          >
            {submitting
              ? 'Confirming…'
              : action.grant && !reviewing
                ? 'Review grant'
                : `Confirm ${action.grant ? 'grant' : 'action'}`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function SecretDialog({
  secret,
  onClose,
}: {
  secret: { kind: 'join' | 'recover'; token: string; target?: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const link = `${window.location.origin}/${secret.kind}#token=${encodeURIComponent(secret.token)}`;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={secret.kind === 'join' ? 'Invitation ready' : 'Recovery link ready'}
      description="Copy this link now. It will not be available again after you close this window."
    >
      <div className="admin-secret">
        {secret.target && (
          <p>
            For <strong>{secret.target}</strong>
          </p>
        )}
        <label>
          Single-use link
          <input
            aria-label="Single-use link"
            className="admin-secret-input"
            value={link}
            readOnly
            onFocus={(event) => event.target.select()}
            spellCheck={false}
          />
        </label>
        <p className="admin-field-help">
          Expires in {secret.kind === 'join' ? '24 hours' : '1 hour'}. Share privately with the
          intended person.{' '}
          {secret.kind === 'recover' && 'This replaces any earlier unused recovery link.'}
        </p>
        <p className="admin-field-help">
          The secret stays in this window only. If it is lost,{' '}
          {secret.kind === 'join'
            ? 'revoke this invitation and create another.'
            : 'create a replacement recovery link.'}
        </p>
        {copyError && (
          <p role="status" className="admin-alert warning">
            Clipboard access is unavailable. Select and copy the link above.
          </p>
        )}
        <div className="admin-dialog-actions">
          <button className="button ghost" onClick={onClose}>
            Close and discard link
          </button>
          <button
            className="button primary"
            onClick={() => {
              if (!navigator.clipboard) {
                setCopyError(true);
                return;
              }
              void navigator.clipboard
                .writeText(link)
                .then(() => {
                  setCopied(true);
                  setCopyError(false);
                })
                .catch(() => setCopyError(true));
            }}
          >
            {copied ? 'Copied' : 'Copy private link'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
