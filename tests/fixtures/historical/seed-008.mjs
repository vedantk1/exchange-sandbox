// This builder runs only inside the archived008 source checkout. The current
// application and schema modules must never be used to seed this fixture.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { Exchange } from './apps/server/src/exchange.ts';
import { AuthService } from './apps/server/src/auth/index.ts';
import { AdminService } from './apps/server/src/admin/service.ts';
import { INITIAL_SCHEMA } from './packages/database/src/schema.ts';
import { IDENTITY_SCHEMA } from './packages/database/src/identity-schema.ts';
import { DEMO_MARKET_SCHEMA } from './packages/database/src/demo-market-schema.ts';
import { SIMULATOR_CONTROLS_SCHEMA } from './packages/database/src/simulator-controls-schema.ts';
import { MARKET_ORDERS_SCHEMA } from './packages/database/src/market-orders-schema.ts';
import { SESSION_LIFECYCLE_SCHEMA } from './packages/database/src/session-lifecycle-schema.ts';
import { COMMAND_TIMESTAMP_SCHEMA } from './packages/database/src/command-timestamp-schema.ts';
import { ORDER_INTEGRITY_SCHEMA } from './packages/database/src/order-integrity-schema.ts';

const migrations = [
  ['001_exchange_core', INITIAL_SCHEMA],
  ['002_identity_and_controls', IDENTITY_SCHEMA],
  ['003_demo_market', DEMO_MARKET_SCHEMA],
  ['004_simulator_controls', SIMULATOR_CONTROLS_SCHEMA],
  ['005_market_orders', MARKET_ORDERS_SCHEMA],
  ['006_session_lifecycle', SESSION_LIFECYCLE_SCHEMA],
  ['007_command_timestamps', COMMAND_TIMESTAMP_SCHEMA],
  ['008_order_integrity', ORDER_INTEGRITY_SCHEMA],
];
const tables = [
  'exchange_sessions',
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
  'session_rollovers',
  'exchange_control',
  'schema_migrations',
];
const databaseUrl = process.env.HISTORICAL_DATABASE_URL;
if (!databaseUrl || !process.env.HISTORICAL_OUTPUT_PATH)
  throw new Error('Isolated fixture connection and output path are required.');
const sql = new pg.Client({ connectionString: databaseUrl });
await sql.connect();
let exchange;
try {
  exchange = await Exchange.open(databaseUrl);
  const auth = new AuthService(exchange);
  const admin = new AdminService(exchange);
  // Credentials are generated for this isolated builder only, then removed.
  const password = randomUUID() + randomUUID();
  const operator = await auth.bootstrapAdmin({ handle: 'fixture_operator', password });
  const login = await auth.login({ handle: operator.handle, password });
  let sessionId = operator.sessionId;
  const adminCommand = () => ({
    commandId: randomUUID(),
    sessionId,
    reason: 'Synthetic historical upgrade fixture',
  });
  const participants = {};
  for (const handle of ['fixture_seller', 'fixture_buyer']) {
    const invitation = await auth.issueInvitation(login.token, adminCommand());
    participants[handle] = await auth.redeemInvitation({
      token: invitation.token,
      handle,
      password,
    });
  }
  const seller = participants.fixture_seller.accountId;
  const buyer = participants.fixture_buyer.accountId;
  const commands = {};
  const results = {};
  const orderIds = {};
  const command = (accountId) => ({ accountId, commandId: randomUUID(), sessionId });
  await admin.resume(login.token, adminCommand());
  commands.archivedSell = {
    ...command(seller),
    side: 'SELL',
    quantity: '0.3',
    price: '50000',
  };
  results.archivedSell = await exchange.placeLimit(commands.archivedSell);
  commands.archivedBuy = {
    ...command(buyer),
    side: 'BUY',
    quantity: '0.1',
    price: '50000',
  };
  results.archivedBuy = await exchange.placeLimit(commands.archivedBuy);
  await admin.pause(login.token, adminCommand());
  commands.rollover = adminCommand();
  results.rollover = await admin.rollover(login.token, commands.rollover);
  const archivedSessionId = sessionId;
  sessionId = results.rollover.data.newSessionId;
  await admin.resume(login.token, adminCommand());
  const partial = await exchange.placeLimit({
    ...command(seller),
    side: 'SELL',
    quantity: '0.3',
    price: '50000',
  });
  orderIds.partial = partial.order.id;
  commands.buy = { ...command(buyer), side: 'BUY', quantity: '0.1', price: '50000' };
  results.buy = await exchange.placeLimit(commands.buy);
  orderIds.filled = results.buy.order.id;
  const open = await exchange.placeLimit({
    ...command(seller),
    side: 'SELL',
    quantity: '0.2',
    price: '51000',
  });
  orderIds.open = open.order.id;
  const cancelable = await exchange.placeLimit({
    ...command(buyer),
    side: 'BUY',
    quantity: '0.1',
    price: '40000',
  });
  commands.cancel = { ...command(buyer), orderId: cancelable.order.id };
  results.cancel = await exchange.cancel(commands.cancel);
  orderIds.canceled = cancelable.order.id;
  const preview = await exchange.previewMarket({
    accountId: buyer,
    sessionId,
    side: 'BUY',
    quantity: '0.05',
  });
  commands.market = { ...command(buyer), previewId: preview.previewId };
  results.market = await exchange.placeMarket(commands.market);
  orderIds.market = results.market.order.id;
  const partialPreview = await exchange.previewMarket({
    accountId: buyer,
    sessionId,
    side: 'BUY',
    quantity: '0.8',
  });
  commands.partialMarket = { ...command(buyer), previewId: partialPreview.previewId };
  results.partialMarket = await exchange.placeMarket(commands.partialMarket);
  orderIds.partialMarket = results.partialMarket.order.id;
  // Restore open and partial limit states after the IOC consumed the old book.
  const nextPartial = await exchange.placeLimit({
    ...command(seller),
    side: 'SELL',
    quantity: '0.3',
    price: '50000',
  });
  orderIds.partial = nextPartial.order.id;
  await exchange.placeLimit({
    ...command(buyer),
    side: 'BUY',
    quantity: '0.1',
    price: '50000',
  });
  const nextOpen = await exchange.placeLimit({
    ...command(seller),
    side: 'SELL',
    quantity: '0.2',
    price: '51000',
  });
  orderIds.open = nextOpen.order.id;
  const reconcile = await exchange.reconcile();
  if (!reconcile.ok) throw new Error('Historical fixture accounting did not reconcile.');
  await exchange.close();
  exchange = undefined;
  // Preserve identity structure without publishing any usable credential,
  // password hash, token hash, invitation token or generated login session.
  await sql.query("UPDATE users SET password_hash='disabled historical fixture credential'");
  await sql.query('DELETE FROM login_sessions');
  await sql.query(
    "UPDATE invitations SET token_hash=md5(id::text) || md5('disabled-' || id::text)",
  );
  const data = {};
  for (const table of tables) {
    const rows = await sql.query(
      `SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY row_to_json(t)::text`,
    );
    data[table] = rows.rows.map(({ row }) => row);
  }
  const sequenceNames = await sql.query(
    'SELECT sequencename FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename',
  );
  const sequences = [];
  for (const { sequencename } of sequenceNames.rows) {
    const sequence = await sql.query(
      `SELECT last_value::text AS value, is_called FROM "${sequencename.replaceAll('"', '""')}"`,
    );
    sequences.push({
      name: sequencename,
      lastValue: sequence.rows[0].value,
      isCalled: sequence.rows[0].is_called,
    });
  }
  const version = (await sql.query('SHOW server_version')).rows[0].server_version;
  await writeFile(
    process.env.HISTORICAL_OUTPUT_PATH,
    JSON.stringify({
      migrations,
      tables,
      data,
      sequences,
      version,
      expectations: {
        seller,
        buyer,
        operator,
        archivedSessionId,
        sessionId,
        commands,
        results,
        orderIds,
      },
    }),
  );
} finally {
  await exchange?.close();
  await sql.end();
}
