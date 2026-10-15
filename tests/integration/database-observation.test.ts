import { afterEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  withDatabaseBudget,
  type DatabaseBudgets,
  type DatabaseObservation,
  type DatabaseOptions,
} from '../../packages/database/src/index.js';
import { createTestExchange, type TestExchange } from '../helpers/database.js';

const budgets: DatabaseBudgets = {
  read: { statementMs: 100, totalMs: 500 },
  export: { statementMs: 700, totalMs: 1_200 },
  command: { statementMs: 3_500, totalMs: 4_500 },
  maintenance: { statementMs: 5_000, totalMs: 6_000 },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function selectValue(database: ReturnType<typeof createDatabase>, value: string | number) {
  return database.selectNoFrom((expression) => expression.val(value).as('value')).execute();
}

function sleep(database: ReturnType<typeof createDatabase>, seconds: number) {
  return database
    .selectNoFrom((expression) =>
      expression.fn<void>('pg_sleep', [expression.val(seconds)]).as('wait'),
    )
    .execute();
}

describe('database operational observations', () => {
  let context: TestExchange | undefined;
  let database: ReturnType<typeof createDatabase> | undefined;
  let events: DatabaseObservation[];

  async function open(options: DatabaseOptions = {}) {
    context = await createTestExchange();
    events = [];
    database = createDatabase(context.url, {
      max: 1,
      budgets,
      observer: (event) => events.push(event),
      ...options,
    });
    return database;
  }

  afterEach(async () => {
    await database?.destroy();
    database = undefined;
    await context?.dispose();
    context = undefined;
  });

  it('reports successful work and SQL errors without SQL, parameters, or error details', async () => {
    const db = await open();
    const privateValue = 'observation-private-value';
    await withDatabaseBudget(db, 'read', () => selectValue(db, privateValue));
    await expect(
      withDatabaseBudget(db, 'export', () =>
        db
          .selectNoFrom((expression) =>
            expression.cast<number>(expression.val(privateValue), 'integer').as('value'),
          )
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '22P02' });
    await db.destroy();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'acquire', kind: 'read', outcome: 'ok' }),
        expect.objectContaining({ phase: 'query', kind: 'read', outcome: 'ok' }),
        expect.objectContaining({ phase: 'budget', kind: 'read', outcome: 'ok' }),
        expect.objectContaining({ phase: 'query', kind: 'export', outcome: 'error' }),
        expect.objectContaining({ phase: 'budget', kind: 'export', outcome: 'error' }),
        expect.objectContaining({ phase: 'shutdown', kind: 'shutdown', outcome: 'ok' }),
      ]),
    );
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(['durationMs', 'kind', 'outcome', 'phase']);
      expect(Number.isFinite(event.durationMs)).toBe(true);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
    const serialized = JSON.stringify(events);
    for (const value of [privateValue, 'SELECT', 'integer', '22P02', context!.url])
      expect(serialized).not.toContain(value);
  });

  it('distinguishes statement deadlines from PostgreSQL lock waits', async () => {
    const db = await open();
    await expect(withDatabaseBudget(db, 'read', () => sleep(db, 1))).rejects.toMatchObject({
      code: '57014',
    });
    expect(events.filter((event) => event.outcome !== 'ok')).toEqual([
      expect.objectContaining({ phase: 'query', kind: 'read', outcome: 'timeout' }),
      expect.objectContaining({ phase: 'budget', kind: 'read', outcome: 'timeout' }),
    ]);

    events.length = 0;
    const blocker = await context!.sql.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE orders IN ACCESS EXCLUSIVE MODE');
    try {
      await expect(
        withDatabaseBudget(db, 'command', () => db.selectFrom('orders').select('id').execute()),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(events.filter((event) => event.outcome !== 'ok')).toEqual([
      expect.objectContaining({ phase: 'query', kind: 'command', outcome: 'lock_timeout' }),
      expect.objectContaining({ phase: 'budget', kind: 'command', outcome: 'lock_timeout' }),
    ]);
    expect(await withDatabaseBudget(db, 'read', () => selectValue(db, 1))).toBeDefined();
  });

  it('reports failed initial acquisition without exposing PostgreSQL connection details', async () => {
    const db = await open();
    await db.destroy();
    events.length = 0;
    const privateDatabaseName = `observation_missing_${randomUUID().replaceAll('-', '')}`;
    const unavailable = new URL(context!.url);
    unavailable.pathname = `/${privateDatabaseName}`;
    database = createDatabase(unavailable.toString(), {
      budgets,
      observer: (event) => events.push(event),
    });
    const missing = database;
    await expect(
      withDatabaseBudget(missing, 'read', () => selectValue(missing, 1)),
    ).rejects.toMatchObject({ code: '3D000' });
    expect(events.map(({ phase, outcome }) => ({ phase, outcome }))).toEqual([
      { phase: 'acquire', outcome: 'error' },
      { phase: 'budget', outcome: 'error' },
    ]);
    const serialized = JSON.stringify(events);
    for (const value of [privateDatabaseName, unavailable.toString(), '3D000'])
      expect(serialized).not.toContain(value);
  });

  it('observes acquisition timeouts while a throwing observer cannot alter rollback or reuse', async () => {
    const db = await open({
      acquireTimeoutMs: 60,
      observer(event) {
        events.push(event);
        throw new Error('private observer error');
      },
    });
    const before = (await context!.sql.query('SELECT next_sequence FROM exchange_control')).rows;
    const entered = deferred();
    const release = deferred();
    const work = withDatabaseBudget(db, 'command', () =>
      db.transaction().execute(async (transaction) => {
        await transaction
          .updateTable('exchange_control')
          .set({ next_sequence: '999999' })
          .where('id', '=', 1)
          .execute();
        entered.resolve();
        await release.promise;
        throw new Error('private callback failure');
      }),
    );
    const rejected = expect(work).rejects.toThrow('private callback failure');
    await entered.promise;
    try {
      await expect(withDatabaseBudget(db, 'read', () => selectValue(db, 1))).rejects.toMatchObject({
        code: 'DATABASE_TIMEOUT',
      });
    } finally {
      release.resolve();
    }
    await rejected;
    expect(events.filter((event) => event.phase === 'acquire' && event.kind === 'read')).toEqual([
      expect.objectContaining({ outcome: 'timeout', durationMs: expect.any(Number) }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ phase: 'budget', kind: 'command', outcome: 'error' }),
    );
    expect((await context!.sql.query('SELECT next_sequence FROM exchange_control')).rows).toEqual(
      before,
    );
    await withDatabaseBudget(db, 'read', () => selectValue(db, 1));
    await db.destroy();
    expect(events).toContainEqual(
      expect.objectContaining({ phase: 'shutdown', kind: 'shutdown', outcome: 'ok' }),
    );
  });

  it('records a late pool acquisition once and fences it before any query', async () => {
    const db = await open({
      acquireTimeoutMs: 1_000,
      budgets: { ...budgets, read: { statementMs: 100, totalMs: 180 } },
    });
    const entered = deferred();
    const release = deferred();
    const work = withDatabaseBudget(db, 'command', () =>
      db.transaction().execute(async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    await entered.promise;
    await expect(withDatabaseBudget(db, 'read', () => selectValue(db, 1))).rejects.toMatchObject({
      code: 'DATABASE_TIMEOUT',
    });
    expect(
      events
        .filter((event) => event.kind === 'read')
        .map(({ phase, outcome }) => ({ phase, outcome })),
    ).toEqual([{ phase: 'budget', outcome: 'timeout' }]);
    release.resolve();
    await work;
    await expect
      .poll(
        () => events.filter((event) => event.phase === 'acquire' && event.kind === 'read').length,
      )
      .toBe(1);
    expect(
      events
        .filter((event) => event.kind === 'read')
        .map(({ phase, outcome }) => ({ phase, outcome })),
    ).toEqual([
      { phase: 'budget', outcome: 'timeout' },
      { phase: 'acquire', outcome: 'timeout' },
    ]);
    await withDatabaseBudget(db, 'read', () => selectValue(db, 1));
  });

  it('reports transaction-ending PostgreSQL deadlines as timeouts and preserves connection recovery', async () => {
    const db = await open();
    await expect(
      withDatabaseBudget(db, 'read', () =>
        db.transaction().execute(async (transaction) => {
          await transaction
            .selectNoFrom((expression) =>
              expression
                .fn<string>('set_config', [
                  expression.val('statement_timeout'),
                  expression.val('1000ms'),
                  expression.val(true),
                ])
                .as('configured'),
            )
            .execute();
          await sleep(transaction, 0.7);
        }),
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_TIMEOUT' });
    expect(events).toContainEqual(
      expect.objectContaining({ phase: 'query', kind: 'read', outcome: 'timeout' }),
    );
    expect(events.filter((event) => event.phase === 'budget')).toEqual([
      expect.objectContaining({ kind: 'read', outcome: 'timeout' }),
    ]);
    await withDatabaseBudget(db, 'read', () => selectValue(db, 1));
  });

  it('reports forced shutdown only after transport drain and consumes rejected async observers', async () => {
    const db = await open({
      closeTimeoutMs: 80,
      observer: async (event) => {
        events.push(event);
        throw new Error('private asynchronous observer error');
      },
    });
    const entered = deferred();
    const release = deferred();
    const work = withDatabaseBudget(db, 'command', () =>
      db.transaction().execute(async (transaction) => {
        entered.resolve();
        await release.promise;
        await selectValue(transaction, 1);
      }),
    );
    const rejected = expect(work).rejects.toMatchObject({ code: 'DATABASE_TIMEOUT' });
    await entered.promise;
    await db.destroy();
    expect(events.filter((event) => event.phase === 'shutdown')).toEqual([
      expect.objectContaining({
        kind: 'shutdown',
        outcome: 'timeout',
        durationMs: expect.any(Number),
      }),
    ]);
    release.resolve();
    await rejected;
    expect(events.filter((event) => event.phase === 'budget')).toEqual([
      expect.objectContaining({ kind: 'command', outcome: 'timeout' }),
    ]);
  });
});
import { randomUUID } from 'node:crypto';
