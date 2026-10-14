import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AccountSearchView, WorkspaceView } from '@sandbox/contracts';
import { api, errorMessage } from '../lib/api.js';

type Participant = NonNullable<WorkspaceView['admin']>['traders'][number];

/** Search is evaluated by the server across all participants, including those beyond the first page. */
export function AccountSearch({
  actorId,
  selectedId,
  onSelect,
  refreshKey,
}: {
  actorId: string;
  selectedId: string | null;
  onSelect: (account: Participant) => void;
  refreshKey: string;
}) {
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(input.trim());
      setCursor(null);
      setPrevious([]);
    }, 250);
    return () => clearTimeout(timer);
  }, [input]);
  const result = useQuery({
    queryKey: ['account-search', actorId, search, cursor, refreshKey],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (search) params.set('search', search);
      if (cursor) params.set('cursor', cursor);
      return api<AccountSearchView>(
        `/api/admin/accounts/search?${params}`,
        undefined,
        signal,
        actorId,
      );
    },
    retry: false,
  });
  return (
    <div className="history-account-search">
      <label className="field">
        Find participant by handle or account ID
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Search all participants"
          maxLength={64}
          autoComplete="off"
        />
      </label>
      {result.error && (
        <p className="notice danger" role="alert">
          {errorMessage(result.error)}
        </p>
      )}
      {result.isFetching && (
        <p className="muted" role="status">
          Searching participants…
        </p>
      )}
      <div className="history-account-results">
        {result.data?.items.map((account) => (
          <button
            className={`button ghost ${selectedId === account.accountId ? 'selected' : ''}`}
            key={account.accountId}
            aria-pressed={selectedId === account.accountId}
            onClick={() => onSelect(account)}
          >
            @{account.handle} <small>{account.status.toLowerCase()}</small>
          </button>
        ))}
        {result.data?.items.length === 0 && <p className="muted">No matching participants.</p>}
      </div>
      <div className="history-pagination">
        <button
          className="button ghost small"
          disabled={!previous.length || result.isFetching}
          onClick={() => {
            setCursor(previous.at(-1) ?? null);
            setPrevious((values) => values.slice(0, -1));
          }}
        >
          Previous participants
        </button>
        <button
          className="button ghost small"
          disabled={!result.data?.nextCursor || result.isFetching}
          onClick={() => {
            if (!result.data?.nextCursor) return;
            setPrevious((values) => [...values, cursor]);
            setCursor(result.data.nextCursor);
          }}
        >
          Next participants
        </button>
      </div>
    </div>
  );
}
