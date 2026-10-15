import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  readHistoryLocation,
  writeHistoryLocation,
  type HistoryLocation,
} from './history-location.js';

/** Router state is authoritative, so reload and popstate use the same validated selection. */
export function useHistoryLocation(actorId: string, admin: boolean) {
  const [parameters, setParameters] = useSearchParams();
  const value = readHistoryLocation(parameters, actorId, admin);
  const canonical = writeHistoryLocation(parameters, value, admin).toString();
  const current = parameters.toString();
  useEffect(() => {
    if (canonical !== current) setParameters(new URLSearchParams(canonical), { replace: true });
  }, [canonical, current, setParameters]);
  function update(patch: Partial<HistoryLocation>, replace = false) {
    setParameters(
      (previous) => {
        const next = { ...readHistoryLocation(previous, actorId, admin), ...patch };
        // Reuse the parser for UI updates too, before any value reaches a query.
        const encoded = writeHistoryLocation(previous, next, admin);
        return writeHistoryLocation(encoded, readHistoryLocation(encoded, actorId, admin), admin);
      },
      { replace },
    );
  }
  return { value, update };
}
