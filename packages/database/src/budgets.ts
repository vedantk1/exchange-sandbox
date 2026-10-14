import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';

export type DatabaseBudgetKind = 'read' | 'command' | 'maintenance';
export interface DatabaseBudget {
  statementMs: number;
  totalMs: number;
}
export type DatabaseBudgets = Record<DatabaseBudgetKind, DatabaseBudget>;

/** Resource limits, not advertised latency guarantees. Maintenance is deliberately explicit. */
export const DEFAULT_DATABASE_BUDGETS: DatabaseBudgets = {
  read: { statementMs: 3_000, totalMs: 5_000 },
  command: { statementMs: 10_000, totalMs: 15_000 },
  maintenance: { statementMs: 60_000, totalMs: 120_000 },
};
export const DATABASE_LOCK_TIMEOUT_MS = 2_000;
export const DATABASE_ACQUIRE_TIMEOUT_MS = 5_000;
export const DATABASE_CLOSE_TIMEOUT_MS = 20_000;

export class DatabaseTimeoutError extends Error {
  readonly code = 'DATABASE_TIMEOUT';

  constructor(readonly kind: DatabaseBudgetKind | 'shutdown') {
    super(
      'Database work exceeded its resource budget. Resolve the original command before retrying.',
    );
  }
}

export interface DatabaseScope {
  owner: object;
  kind: DatabaseBudgetKind;
  budget: DatabaseBudget;
  deadline: number;
  expired: boolean;
  connections: Set<{ client: PoolClient; discard: () => void }>;
}

export const databaseScope = new AsyncLocalStorage<DatabaseScope>();

/** Closing the socket prevents any continuation from sending COMMIT or more statements. */
export function disconnect(client: PoolClient): void {
  // end() marks pg non-queryable before the forced transport close. Neither a
  // client-side query_timeout nor rejecting a promise provides this guarantee.
  void client.end().catch(() => undefined);
  client.connection.stream.destroy();
}

export function remaining(scope: DatabaseScope): number {
  const milliseconds = Math.ceil(scope.deadline - performance.now());
  if (scope.expired || milliseconds <= 0) throw new DatabaseTimeoutError(scope.kind);
  return milliseconds;
}

export async function runBudget<T>(
  owner: object,
  kind: DatabaseBudgetKind,
  budget: DatabaseBudget,
  work: () => Promise<T>,
): Promise<T> {
  const scope: DatabaseScope = {
    owner,
    kind,
    budget,
    deadline: performance.now() + budget.totalMs,
    expired: false,
    connections: new Set(),
  };
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await databaseScope.run(scope, () =>
      Promise.race([
        Promise.resolve().then(work),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            scope.expired = true;
            // Fence every borrowed transport BEFORE settling the caller. Work
            // paused outside SQL may resume later, but its adapter is discarded.
            for (const connection of scope.connections) connection.discard();
            reject(new DatabaseTimeoutError(kind));
          }, budget.totalMs);
        }),
      ]),
    );
  } finally {
    clearTimeout(timeout);
  }
}
