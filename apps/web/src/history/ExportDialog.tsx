import { useEffect, useState } from 'react';
import type { HistoryExportView } from '@sandbox/contracts';
import { Dialog } from '../components/ui.js';

export function ExportDialog({ bundle, close }: { bundle: HistoryExportView; close: () => void }) {
  const [files, setFiles] = useState<{ name: string; url: string }[]>([]);
  useEffect(() => {
    const created = bundle.files.map((file) => ({
      name: file.name,
      url: URL.createObjectURL(new Blob([file.content], { type: 'text/csv;charset=utf-8' })),
    }));
    setFiles(created);
    return () => created.forEach((file) => URL.revokeObjectURL(file.url));
  }, [bundle]);
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
          <dd className="mono">
            {bundle.accountId ?? 'All session accounts and administrator audit'}
          </dd>
        </div>
        <div>
          <dt>As of</dt>
          <dd>{new Date(bundle.asOf).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Outbox cursor</dt>
          <dd>#{bundle.cursor}</dd>
        </div>
      </dl>
      <div className="history-export-files">
        {files.map((file) => (
          <a className="button ghost" key={file.name} href={file.url} download={file.name}>
            {file.name}
          </a>
        ))}
      </div>
      <p className="muted">
        The bundle includes complete selected history. Filters in the paged view do not limit
        exported rows.
      </p>
      <p className="muted">
        Amounts retain exact decimal precision. Later activity is excluded from this bundle.
      </p>
      <button className="button primary" onClick={close}>
        Done
      </button>
    </Dialog>
  );
}
