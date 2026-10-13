import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Exchange } from './exchange.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Run pnpm demo or supply a dedicated development DATABASE_URL.');
let exchange = await Exchange.open(url);
try {
  const setup = await exchange.bootstrap();
  const seller = randomUUID();
  const buyer = randomUUID();
  await exchange.createTrader({ accountId: seller, label: 'demo-seller', commandId: randomUUID() });
  await exchange.createTrader({ accountId: buyer, label: 'demo-buyer', commandId: randomUUID() });
  const ask = await exchange.placeLimit({
    accountId: seller,
    commandId: randomUUID(),
    sessionId: setup.sessionId,
    side: 'SELL',
    quantity: '0.4',
    price: '50000',
  });
  assert.equal(ask.order?.status, 'OPEN');
  const buyCommand = {
    accountId: buyer,
    commandId: randomUUID(),
    sessionId: setup.sessionId,
    side: 'BUY' as const,
    quantity: '0.1',
    price: '50000',
  };
  const buy = await exchange.placeLimit(buyCommand);
  assert.equal(buy.order?.status, 'FILLED');
  await exchange.cancel({
    accountId: seller,
    commandId: randomUUID(),
    sessionId: setup.sessionId,
    orderId: ask.order!.id,
  });
  const beforeRestart = await exchange.snapshot(buyer);
  await exchange.close();
  exchange = await Exchange.open(url);
  assert.deepEqual(await exchange.placeLimit(buyCommand), buy);
  assert.deepEqual(await exchange.snapshot(buyer), beforeRestart);
  assert.deepEqual(await exchange.reconcile(), { ok: true, issues: [] });
  const sellerState = await exchange.snapshot(seller);
  const buyerState = await exchange.snapshot(buyer);
  const feeState = await exchange.snapshot(setup.feeAccountId);
  console.log(
    'Virtual BTC-SIM / USD-SIM only. Each trader starts with 1 BTC-SIM and 100,000 USD-SIM.',
  );
  console.log(
    'Seller offers 0.4 BTC-SIM at 50,000; buyer fills 0.1; seller cancels the remaining 0.3.',
  );
  console.table([
    {
      account: 'seller',
      BTC: sellerState.balances['BTC-SIM'].total,
      USD: sellerState.balances['USD-SIM'].total,
    },
    {
      account: 'buyer',
      BTC: buyerState.balances['BTC-SIM'].total,
      USD: buyerState.balances['USD-SIM'].total,
    },
    {
      account: 'fees (session total)',
      BTC: feeState.balances['BTC-SIM'].total,
      USD: feeState.balances['USD-SIM'].total,
    },
  ]);
  console.log(
    'Restart + original-command retry: identical receipt, no duplicate fill. Reconciliation: passed.',
  );
} finally {
  await exchange.close();
}
