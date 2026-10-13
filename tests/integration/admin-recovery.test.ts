import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminService } from '../../apps/server/src/admin/index.js';
import { RecoveryError } from '../../apps/server/src/errors.js';
import { createApiFixture, TEST_PASSWORD, type ApiFixture } from '../helpers/api.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('administrator recovery admission and local fault latches', () => {
  let context: ApiFixture;
  let admin: AdminService;
  let token: string;

  beforeEach(async () => {
    context = await createApiFixture();
    admin = new AdminService(context.exchange);
    token = (await context.auth.login({ handle: 'operator', password: TEST_PASSWORD })).token;
  });

  afterEach(async () => {
    await context?.dispose();
  });

  const command = () => ({
    commandId: randomUUID(),
    sessionId: context.sessionId,
    reason: 'Reconcile before explicitly resuming the test market',
  });

  it('clears the fault from a transaction admitted ahead of a waiting resume', async () => {
    const { browser } = await context.trader('trader');
    const admitted = deferred<number>();
    const release = deferred<void>();
    const failure = context.exchange
      .financialTransaction(async (tx) => {
        const holder = await tx
          .selectNoFrom((eb) => eb.fn<number>('pg_backend_pid', []).as('pid'))
          .executeTakeFirstOrThrow();
        admitted.resolve(holder.pid);
        await release.promise;
        throw new RecoveryError('Injected failure from the already-admitted transaction.');
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    let resume: ReturnType<AdminService['resume']> | undefined;
    try {
      const holderPid = await admitted.promise;
      resume = admin.resume(token, command());
      // Observe the actual PostgreSQL wait boundary, rather than depending on
      // sleeps or assuming the second transaction has reached the lock.
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const blocked = await context.sql.query<{ waiting: boolean }>(
          `
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE $1 = ANY(pg_blocking_pids(pid))
              AND wait_event_type = 'Lock' AND query ILIKE '%exchange_control%'
          ) AS waiting`,
          [holderPid],
        );
        waiting = blocked.rows[0]!.waiting;
      }
      expect(waiting).toBe(true);
      release.resolve();
      expect(await failure).toBeInstanceOf(RecoveryError);
      expect(await resume).toMatchObject({ status: 'ACCEPTED', data: { marketState: 'TRADING' } });
      const placed = await browser.request('POST', '/api/orders', {
        commandId: randomUUID(),
        sessionId: context.sessionId,
        side: 'SELL',
        quantity: '0.1',
        price: '50000',
      });
      expect(placed.statusCode).toBe(200);
      expect(placed.json()).toMatchObject({ status: 'ACCEPTED' });
      expect((await admin.overview(token)).fault).toBeNull();
      expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
    } finally {
      release.resolve();
      await Promise.allSettled([failure, ...(resume ? [resume] : [])]);
    }
  });

  it('reports an unpersisted fault and does not clear it by replaying an older resume', async () => {
    const original = command();
    const first = await admin.resume(token, original);
    expect(first.status).toBe('ACCEPTED');
    // Simulate failure to save both the original halt and its fallback. The
    // runtime latch must remain authoritative even when the stored row is null.
    await context.sql.query(`
      CREATE FUNCTION reject_fault_diagnostic() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected diagnostic write failure'; END;
      $$;
      CREATE TRIGGER reject_fault_diagnostic BEFORE UPDATE OF fault ON exchange_control
      FOR EACH ROW WHEN (NEW.fault IS NOT NULL) EXECUTE FUNCTION reject_fault_diagnostic();
    `);
    try {
      await expect(
        context.exchange.financialTransaction(async () => {
          throw new RecoveryError('Injected financial invariant failure.');
        }),
      ).rejects.toThrow('Injected diagnostic write failure');
    } finally {
      await context.sql.query('DROP TRIGGER reject_fault_diagnostic ON exchange_control');
    }
    const stored = await context.sql.query<{ fault: string | null }>(
      'SELECT fault FROM exchange_control',
    );
    expect(stored.rows[0]!.fault).toBeNull();
    const overview = await context.admin.request('GET', '/api/admin/overview');
    expect(overview.statusCode).toBe(200);
    expect(overview.json<{ fault: string | null }>().fault).toBeTruthy();

    expect(await admin.resume(token, original)).toEqual(first);
    await expect(
      context.exchange.financialTransaction(async () => 'unreachable'),
    ).rejects.toBeInstanceOf(RecoveryError);
    expect((await admin.overview(token)).fault).toBeTruthy();

    expect(await admin.resume(token, command())).toMatchObject({ status: 'ACCEPTED' });
    expect(await context.exchange.financialTransaction(async () => 'admitted')).toBe('admitted');
    expect((await admin.overview(token)).fault).toBeNull();
  });
});
