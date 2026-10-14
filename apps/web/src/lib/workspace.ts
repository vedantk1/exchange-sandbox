import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceView } from '@sandbox/contracts';
import { api, ApiError, type User } from './api.js';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** Event payloads are invalidations. Every visible financial value comes from one committed snapshot. */
export function useWorkspace(user: User, onUnauthorized: () => void) {
  const client = useQueryClient();
  const key = ['workspace', user.accountId];
  const readSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      const snapshot = await api<WorkspaceView>(
        '/api/workspace',
        undefined,
        signal,
        user.accountId,
      );
      if (snapshot.user.accountId !== user.accountId)
        throw new ApiError(401, 'SESSION_CHANGED', 'The signed-in account changed. Sign in again.');
      return snapshot;
    },
    [user.accountId],
  );
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readSnapshot(signal),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    networkMode: 'always',
  });
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const refreshWork = useRef<Promise<WorkspaceView> | null>(null);
  const dirty = useRef(false);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  const refreshSnapshot = useCallback(async () => {
    dirty.current = true;
    if (refreshWork.current) return refreshWork.current;
    refreshWork.current = (async () => {
      let value: WorkspaceView;
      do {
        dirty.current = false;
        try {
          value = await client.fetchQuery({
            queryKey: ['workspace', user.accountId],
            queryFn: ({ signal }) => readSnapshot(signal),
            staleTime: 0,
          });
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) unauthorized.current();
          setConnection('reconnecting');
          throw error;
        }
      } while (dirty.current);
      return value;
    })().finally(() => {
      refreshWork.current = null;
    });
    return refreshWork.current;
  }, [client, user.accountId, readSnapshot]);
  const refresh = useCallback(async () => {
    await refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) unauthorized.current();
  }, [query.error]);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | undefined;
    let sourceSession: string | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let lastMessage = performance.now();
    let backoff = 1_000;
    let reconnecting = false;
    const alive = (version: number) => !disposed && generation === version;
    const recover = () => {
      if (disposed || reconnecting) return;
      reconnecting = true;
      generation += 1;
      source?.close();
      setConnection(navigator.onLine ? 'reconnecting' : 'offline');
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        reconnecting = false;
        void connect();
      }, backoff);
      backoff = Math.min(backoff * 2, 5_000);
    };
    const sync = async (version: number) => {
      try {
        const snapshot = await refreshSnapshot();
        if (alive(version) && sourceSession !== snapshot.sessionId) {
          recover();
          return;
        }
        if (alive(version) && source?.readyState === EventSource.OPEN) setConnection('live');
      } catch {
        if (alive(version)) recover();
      }
    };
    const connect = async () => {
      if (disposed) return;
      const version = ++generation;
      lastMessage = performance.now();
      try {
        // Use the confirmed result directly: React's query observer may render
        // older or absent data while receipt recovery updates the interface.
        const { sessionId, cursor } = await refreshSnapshot();
        if (!alive(version)) return;
        sourceSession = sessionId;
        source = new EventSource(
          `/api/events?sessionId=${encodeURIComponent(sessionId)}&cursor=${encodeURIComponent(cursor)}`,
        );
        const received = () => {
          lastMessage = performance.now();
        };
        source.addEventListener('ready', () => {
          if (!alive(version)) return;
          received();
          backoff = 1_000;
          void sync(version);
        });
        source.addEventListener('invalidate', () => {
          if (!alive(version)) return;
          received();
          void sync(version);
        });
        source.addEventListener('reset', () => {
          if (!alive(version)) return;
          received();
          recover();
        });
        // Heartbeats also refresh fault diagnostics, which can change without a new financial event.
        source.addEventListener('heartbeat', () => {
          if (!alive(version)) return;
          received();
          void sync(version);
        });
        source.addEventListener('unavailable', () => {
          if (alive(version)) recover();
        });
        source.addEventListener('auth-lost', () => {
          if (!alive(version)) return;
          source?.close();
          setConnection('reconnecting');
          // Password rotation may have replaced the cookie while this stream retains the old session.
          void api<{ user: User }>('/api/auth/session')
            .then(({ user: currentUser }) => {
              if (!alive(version)) return;
              if (currentUser.accountId === user.accountId) recover();
              else unauthorized.current();
            })
            .catch((error) => {
              if (!alive(version)) return;
              if (error instanceof ApiError && error.status === 401) unauthorized.current();
              else recover();
            });
        });
        source.onerror = () => {
          if (alive(version)) recover();
        };
      } catch {
        if (alive(version)) recover();
      }
    };
    const offline = () => recover();
    const online = () => {
      clearTimeout(retryTimer);
      reconnecting = false;
      source?.close();
      setConnection('reconnecting');
      void connect();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') online();
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visible);
    const watchdog = setInterval(() => {
      if (performance.now() - lastMessage > 20_000) recover();
    }, 5_000);
    void connect();
    return () => {
      disposed = true;
      generation += 1;
      source?.close();
      clearTimeout(retryTimer);
      clearInterval(watchdog);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [user.accountId, refreshSnapshot]);

  return { ...query, connection, connected: connection === 'live', refresh };
}
