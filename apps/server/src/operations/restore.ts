import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { AdminService } from '../admin/service.js';
import { AuthService } from '../auth/index.js';
import { Exchange } from '../exchange.js';
import { financialEvidence, isolatedDatabase } from './database.js';
import { configuredDatabaseUrl } from '../config/database-url.js';

async function pgTool(binary: string, urlValue: string, arguments_: string[]) {
  const url = new URL(urlValue);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, arguments_, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        PGHOST: url.hostname,
        PGPORT: url.port || '5432',
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      },
    });
    // Keep native diagnostics private: they may echo names, paths or connection details.
    child.stderr.resume();
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('PostgreSQL backup tooling failed.')),
    );
  });
}

let source: Awaited<ReturnType<typeof isolatedDatabase>> | undefined;
let target: Awaited<ReturnType<typeof isolatedDatabase>> | undefined;
let exchange: Exchange | undefined;
let stage = 'creating isolated databases';
try {
  const ownerUrl = process.env.TEST_DATABASE_URL ?? (await configuredDatabaseUrl());
  await mkdir('.local/operations', { recursive: true, mode: 0o700 });
  const directory = await mkdtemp('.local/operations/restore-');
  source = await isolatedDatabase(ownerUrl);
  if (!/^18(?:\.|$)/.test(source.serverVersion))
    throw new Error('The reviewed restore drill uses PostgreSQL 18.');
  target = await isolatedDatabase(ownerUrl);
  stage = 'building retained fixture';
  exchange = await Exchange.open(source.url);
  const auth = new AuthService(exchange);
  const password = randomBytes(24).toString('hex');
  const administrator = await auth.bootstrapAdmin({ handle: 'operator', password });
  const login = await auth.login({ handle: 'operator', password });
  const admin = new AdminService(exchange);
  const command = () => ({
    commandId: randomUUID(),
    sessionId: administrator.sessionId,
    reason: 'Exercise an isolated backup and restore',
  });
  const enroll = async (handle: string) => {
    const invitation = await auth.issueInvitation(login.token, command());
    const participant = await auth.redeemInvitation({ token: invitation.token!, handle, password });
    return participant.accountId;
  };
  const seller = await enroll('drill_seller');
  const buyer = await enroll('drill_buyer');
  await auth.issueInvitation(login.token, command());
  await auth.issueRecovery(login.token, { ...command(), accountId: seller });
  await admin.grant(login.token, {
    ...command(),
    accountId: buyer,
    asset: 'USD-SIM',
    amount: '100',
  });
  await admin.startSimulator(login.token, command());
  await admin.resume(login.token, command());
  const askInput = {
    accountId: seller,
    commandId: randomUUID(),
    sessionId: administrator.sessionId,
    side: 'SELL' as const,
    quantity: '0.4',
    price: '50000',
  };
  const ask = await exchange.placeLimit(askInput);
  const preview = await exchange.previewMarket({
    accountId: buyer,
    sessionId: administrator.sessionId,
    side: 'BUY',
    quantity: '0.1',
  });
  const purchase = {
    accountId: buyer,
    commandId: randomUUID(),
    sessionId: administrator.sessionId,
    previewId: preview.previewId,
  };
  const filled = await exchange.placeMarket(purchase);
  assert.equal(filled.order?.status, 'FILLED');
  assert.equal(ask.order?.status, 'OPEN');
  await admin.pause(login.token, command());
  const rolloverInput = command();
  const rollover = await admin.rollover(login.token, rolloverInput);
  assert.equal(rollover.status, 'ACCEPTED');
  assert.deepEqual(await exchange.reconcile(), { ok: true, issues: [] });
  await exchange.close();
  exchange = undefined;
  const expected = await financialEvidence(source.url);
  const archive = `${directory}/exchange.dump`;
  const started = performance.now();
  stage = 'dumping fixture';
  await pgTool(process.env.PG_DUMP_BIN ?? 'pg_dump', source.url, [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--file',
    archive,
  ]);
  const dumpMs = performance.now() - started;
  const restoring = performance.now();
  stage = 'restoring fresh database';
  await pgTool(process.env.PG_RESTORE_BIN ?? 'pg_restore', target.url, [
    '--exit-on-error',
    '--no-owner',
    '--no-privileges',
    '--dbname',
    new URL(target.url).pathname.slice(1),
    archive,
  ]);
  const restoreMs = performance.now() - restoring;
  stage = 'comparing restored table evidence';
  assert.deepEqual(await financialEvidence(target.url), expected);
  exchange = await Exchange.open(target.url, { migrations: 'verify' });
  stage = 'checking login and receipt recovery';
  assert.deepEqual(await exchange.reconcile(), { ok: true, issues: [] });
  assert.deepEqual(await exchange.placeMarket(purchase), filled);
  const restoredAuth = new AuthService(exchange);
  const restoredLogin = await restoredAuth.login({ handle: 'operator', password });
  assert.equal(restoredLogin.user.accountId, administrator.accountId);
  assert.deepEqual(
    await new AdminService(exchange).rollover(restoredLogin.token, rolloverInput),
    rollover,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    kind: 'fresh-database-pg-dump-restore',
    postgres: source.serverVersion,
    format: 'custom',
    dumpMs: Number(dumpMs.toFixed(2)),
    restoreMs: Number(restoreMs.toFixed(2)),
    comparedTables: Object.keys(expected).length,
    sourceRows: Object.fromEntries(
      Object.entries(expected).map(([table, { rows }]) => [table, rows]),
    ),
    checks: {
      exactTableEvidence: true,
      reconciliation: true,
      loginPreserved: true,
      originalOrderReceiptReplay: true,
      protectedMarketPreviewPreserved: true,
      originalRolloverReceiptReplay: true,
    },
    archiveSha256: (await import('node:crypto'))
      .createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
    scope:
      'Generated fixture and fresh databases only; this is a logical restore drill, not disaster recovery for an existing deployment.',
  };
  await writeFile(`${directory}/result.json`, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile('.local/operations/restore-result.json', `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const rawCode = (error as { code?: unknown })?.code;
  const code =
    typeof rawCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(rawCode) ? rawCode : 'DRILL_FAILED';
  console.error(
    `Restore drill failed while ${stage} (${code}). Use PostgreSQL 18 pg_dump/pg_restore and an owner connection able to create isolated databases; private artifacts were retained.`,
  );
  process.exitCode = 1;
} finally {
  await exchange?.close();
  await target?.dispose();
  await source?.dispose();
}
