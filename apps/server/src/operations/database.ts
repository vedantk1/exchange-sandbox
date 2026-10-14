import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import pg from 'pg';

export async function isolatedDatabase(ownerUrl: string) {
  const name = `sandbox_drill_${randomUUID().replaceAll('-', '')}`;
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const version = await owner.query<{ server_version: string }>('SHOW server_version');
  await owner.query(`CREATE DATABASE "${name}"`);
  const url = new URL(ownerUrl);
  url.pathname = `/${name}`;
  let disposed = false;
  return {
    url: url.toString(),
    serverVersion: version.rows[0]!.server_version,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await owner.query(`DROP DATABASE "${name}"`);
      } finally {
        await owner.end();
      }
    },
  };
}

export async function financialEvidence(databaseUrl: string) {
  const database = new pg.Client({ connectionString: databaseUrl });
  await database.connect();
  try {
    const tables = [
      'exchange_sessions',
      'exchange_control',
      'session_rollovers',
      'accounts',
      'users',
      'login_sessions',
      'invitations',
      'recovery_tokens',
      'allocations',
      'balances',
      'orders',
      'fills',
      'grants',
      'journal_transactions',
      'journal_entries',
      'receipts',
      'outbox',
      'admin_audit',
      'demo_market',
      'market_previews',
      'market_preview_uses',
      'schema_migrations',
    ];
    const evidence: Record<string, { rows: number; sha256: string }> = {};
    for (const table of tables) {
      const rows = await database.query<{ row: string }>(
        `SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY row_to_json(t)::text`,
      );
      evidence[table] = {
        rows: rows.rowCount!,
        sha256: createHash('sha256')
          .update(rows.rows.map(({ row }) => row).join('\n'))
          .digest('hex'),
      };
    }
    return evidence;
  } finally {
    await database.end();
  }
}
