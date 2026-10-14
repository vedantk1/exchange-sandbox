import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types, type PoolClient } from 'pg';
import type { Database } from './types.js';
import {
  DATABASE_ACQUIRE_TIMEOUT_MS,
  DATABASE_CLOSE_TIMEOUT_MS,
  DATABASE_LOCK_TIMEOUT_MS,
  DEFAULT_DATABASE_BUDGETS,
  DatabaseTimeoutError,
  databaseScope,
  disconnect,
  remaining,
  runBudget,
  type DatabaseBudgetKind,
  type DatabaseBudgets,
} from './budgets.js';

interface Runtime {
  budgets: DatabaseBudgets;
  closeTimeoutMs: number;
}
const runtimes = new WeakMap<Kysely<Database>, Runtime>();

export interface DatabaseOptions {
  max?: number;
  onError?: (error: Error) => void;
  budgets?: DatabaseBudgets;
  acquireTimeoutMs?: number;
  closeTimeoutMs?: number;
}

/** All production transactions select a budget before acquiring a connection. */
export function withDatabaseBudget<T>(
  database: Kysely<Database>,
  kind: DatabaseBudgetKind,
  work: () => Promise<T>,
): Promise<T> {
  const runtime = runtimes.get(database);
  if (!runtime) throw new Error('Database runtime is not managed.');
  return runBudget(runtime, kind, runtime.budgets[kind], work);
}

export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
): Kysely<Database> {
  const runtime: Runtime = {
    budgets: options.budgets ?? DEFAULT_DATABASE_BUDGETS,
    closeTimeoutMs: options.closeTimeoutMs ?? DATABASE_CLOSE_TIMEOUT_MS,
  };
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DATABASE_ACQUIRE_TIMEOUT_MS;
  const limits = [
    acquireTimeoutMs,
    runtime.closeTimeoutMs,
    ...Object.values(runtime.budgets).flatMap(({ statementMs, totalMs }) => [statementMs, totalMs]),
  ];
  if (limits.some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new Error('Database budgets must be positive integers.');
  if (Object.values(runtime.budgets).some(({ statementMs, totalMs }) => statementMs >= totalMs))
    throw new Error('The statement budget must be smaller than the total budget.');
  const pool = new Pool({
    connectionString,
    max: options.max ?? 10,
    // pg-pool exposes a client only after its initial handshake. Bound that
    // unborrowed phase by the drain deadline too, so even shorter trusted
    // shutdown overrides cannot wait for a longer connection timeout.
    connectionTimeoutMillis: Math.min(acquireTimeoutMs, runtime.closeTimeoutMs),
    keepAlive: true,
    // Financial numbers and cursors must never pass through Number.
    types: {
      getTypeParser(oid, format) {
        if (format !== 'binary' && (oid === 20 || oid === 1700)) {
          return (value: string) => value;
        }
        return types.getTypeParser(oid, format);
      },
    },
  });
  // Idle connection errors otherwise become unhandled EventEmitter errors.
  // The exchange supplies a callback that marks its writer unavailable.
  pool.on('error', (error: Error & { code?: string }) => {
    if (!['25P03', '25P04'].includes(error.code ?? '')) options.onError?.(error);
  });
  const clients = new Map<PoolClient, Promise<void>>();
  const borrowed = new Set<{ client: PoolClient; discard: () => void }>();
  pool.on('connect', (client) => {
    // Active connection errors have no pool idle listener; consume them while
    // pg rejects its query. Only idle errors invoke the writer-health callback.
    client.on('error', () => undefined);
    clients.set(
      client,
      new Promise<void>((resolve) =>
        client.once('end', () => {
          clients.delete(client);
          resolve();
        }),
      ),
    );
  });

  const managedPool = {
    options: pool.options,
    async connect(): Promise<Pick<PoolClient, 'query' | 'release'> & { processID: number }> {
      const scope = databaseScope.getStore();
      const ownedScope = scope?.owner === runtime ? scope : undefined;
      if (ownedScope) remaining(ownedScope);
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        if (
          error instanceof Error &&
          /(?:timeout exceeded when trying to connect|connection timeout)/i.test(error.message)
        )
          throw new DatabaseTimeoutError(ownedScope?.kind ?? 'read');
        throw error;
      }
      let released = false;
      let discarded = false;
      const lease = {
        client,
        discard() {
          discarded = true;
          disconnect(client);
          release(true);
        },
      };
      function release(destroy = false): void {
        if (released) return;
        released = true;
        borrowed.delete(lease);
        ownedScope?.connections.delete(lease);
        client.off('error', onClientError);
        client.release(destroy || discarded);
      }
      function onClientError(error: Error & { code?: string }): void {
        if (['25P03', '25P04'].includes(error.code ?? '')) lease.discard();
      }
      client.on('error', onClientError);
      borrowed.add(lease);
      ownedScope?.connections.add(lease);
      const budget = ownedScope?.budget ?? runtime.budgets.read;
      async function query(text: string, parameters: readonly unknown[]) {
        if (discarded || released) throw new DatabaseTimeoutError(ownedScope?.kind ?? 'read');
        let timeout: NodeJS.Timeout | undefined;
        try {
          const deadlineMs = ownedScope ? remaining(ownedScope) : budget.totalMs;
          timeout = setTimeout(() => lease.discard(), deadlineMs);
          return await client.query(text, [...parameters]);
        } catch (error) {
          const code = (error as { code?: string })?.code;
          // Session-ending timeouts cannot accept Kysely's rollback. Dispose
          // first so rollback and any continuation retain the typed timeout.
          if (code === '25P03' || code === '25P04') lease.discard();
          if (discarded) throw new DatabaseTimeoutError(ownedScope?.kind ?? 'read');
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      }
      try {
        // Late pool acquisitions after an expired scope never begin SQL work.
        if (ownedScope) remaining(ownedScope);
        const totalMs = ownedScope ? remaining(ownedScope) : budget.totalMs;
        // Let PostgreSQL's session-ending timers report an error before the
        // hard local transport fence; the margin is never extra execution time.
        const transactionMs = Math.max(1, totalMs - Math.min(250, Math.ceil(totalMs / 10)));
        await query(
          `SELECT set_config('statement_timeout', $1, false),
            set_config('lock_timeout', $2, false),
            set_config('idle_in_transaction_session_timeout', $3, false),
            set_config('transaction_timeout', $3, false)`,
          [
            `${budget.statementMs}ms`,
            `${Math.min(DATABASE_LOCK_TIMEOUT_MS, budget.statementMs)}ms`,
            `${transactionMs}ms`,
          ],
        );
        return {
          query: query as PoolClient['query'],
          release: () => release(),
          // Kysely's cancellation support uses this backend identifier.
          processID: (client as PoolClient & { processID: number }).processID,
        };
      } catch (error) {
        lease.discard();
        throw error;
      }
    },
    async end(): Promise<void> {
      // Drain first. At the deadline close all transports and discard leases,
      // then still await actual socket end before the caller releases its guard.
      const timeout = setTimeout(() => {
        for (const lease of borrowed) lease.discard();
        for (const client of clients.keys()) disconnect(client);
      }, runtime.closeTimeoutMs);
      try {
        await pool.end();
        await Promise.all(clients.values());
      } finally {
        clearTimeout(timeout);
      }
    },
  };
  const database = new Kysely<Database>({ dialect: new PostgresDialect({ pool: managedPool }) });
  runtimes.set(database, runtime);
  return database;
}
