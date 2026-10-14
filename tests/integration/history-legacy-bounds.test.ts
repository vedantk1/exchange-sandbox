import { expect, it, vi } from 'vitest';
import * as rowsModule from '../../apps/server/src/history/export-rows.js';
import { createApiFixture } from '../helpers/api.js';

it('stops a legacy byte-limit export within its first bounded audit page', async () => {
  const context = await createApiFixture();
  const auditPages: number[] = [];
  const original = rowsModule.exportRows;
  const pagination = vi.spyOn(rowsModule, 'exportRows').mockImplementation(async function* (
    ...args: Parameters<typeof original>
  ) {
    for await (const rows of original(...args)) {
      if (args[4] === 'audit.csv') auditPages.push(rows.length);
      yield rows;
    }
  });
  try {
    // Every row is below the endpoint's byte limit; together the first page
    // exceeds it. Later pages must never be fetched or retained after rejection.
    await context.sql.query(
      `INSERT INTO admin_audit(id,actor_id,command_id,session_id,action,reason,result)
      SELECT gen_random_uuid(),(SELECT account_id FROM users WHERE role='ADMIN'),gen_random_uuid(),$1,
        'LEGACY_EXPORT_BYTES','Bounded compatibility fixture',jsonb_build_object('note',repeat('x',12000))
        FROM generate_series(1,1500)`,
      [context.sessionId],
    );
    const response = await context.admin.request('GET', `/api/history/${context.sessionId}/export`);
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: 'EXPORT_TOO_LARGE' });
    expect(response.json()).not.toHaveProperty('files');
    expect(auditPages).toEqual([rowsModule.EXPORT_BATCH_SIZE]);
  } finally {
    pagination.mockRestore();
    await context.dispose();
  }
});
