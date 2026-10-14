import { useEffect, useState } from 'react';
import type { PreparedHistoryExportView } from '@sandbox/contracts';
import { Dialog } from '../components/ui.js';

export function ExportDialog({
  bundle,
  close,
  regenerate,
}: {
  bundle: PreparedHistoryExportView;
  close: () => void;
  regenerate: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((Date.parse(bundle.expiresAt) - now) / 1_000));
  const expired = seconds === 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Consistent history export"
      description="Every file below comes from the same committed snapshot. Download them together to reconcile orders, executions, fees, and balances."
    >
      <dl className="trader-review-list">
        <div>
          <dt>Session</dt>
          <dd className="mono">{bundle.sessionId}</dd>
        </div>
        <div>
          <dt>Account scope</dt>
          <dd className="mono">{bundle.accountId ?? 'All session accounts'}</dd>
        </div>
        {bundle.auditScope === 'SESSION' && (
          <div>
            <dt>Administrator audit</dt>
            <dd>Entire selected session, including actions for other accounts.</dd>
          </div>
        )}
        <div>
          <dt>As of</dt>
          <dd>{new Date(bundle.asOf).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Outbox cursor</dt>
          <dd>#{bundle.cursor}</dd>
        </div>
      </dl>
      <p role="status" className="muted">
        {expired
          ? 'These download links have expired. Prepare a fresh export to download again.'
          : `Download links expire in ${Math.floor(seconds / 60)}m ${seconds % 60}s.`}
      </p>
      <div className="history-export-files">
        {bundle.files.map((file) => (
          <div key={file.name}>
            {expired ? (
              <span className="muted">{file.name}</span>
            ) : (
              <a className="button ghost" href={file.downloadUrl} download={file.name}>
                {file.name}
              </a>
            )}
            <p className="muted">
              {file.rows.toLocaleString()} rows · {(file.bytes / 1024).toFixed(1)} KiB
            </p>
          </div>
        ))}
      </div>
      <p className="muted">
        All selected history is included. Page filters do not limit exported rows. Amounts retain
        exact decimal precision; later activity is excluded.
      </p>
      <p className="muted">
        Sign in is required for each download. Preparing more exports can replace older links. After
        a server restart or an unavailable link, prepare a fresh export. A fresh export captures a
        new snapshot.
      </p>
      <div className="history-export-files">
        <button className="button ghost" onClick={regenerate}>
          Prepare fresh export
        </button>
        <button className="button primary" onClick={close}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
