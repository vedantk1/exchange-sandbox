import type { WorkspaceView } from '@sandbox/contracts';
import type { Database } from '@sandbox/database';
import { buyReservation, formatPrice, formatQuantity, formatQuote } from '@sandbox/domain';
import type { Transaction } from 'kysely';

type DemoOverview = NonNullable<NonNullable<WorkspaceView['admin']>['overview']['demoMarket']>;
type Inventory = DemoOverview['inventory']['maker'];
type Asset = 'BTC-SIM' | 'USD-SIM';

export interface QuoteIntent {
  role: 'maker' | 'taker';
  side: 'BUY' | 'SELL';
  price: bigint;
  quantity: bigint;
}

/** Shared by the worker and its inventory preview; all values use domain integer units. */
export function quoteIntents(referencePrice: bigint, takerBase: bigint): QuoteIntent[] {
  const buy = takerBase <= 10000n;
  return [
    { role: 'maker', side: 'BUY', price: referencePrice - 3000n, quantity: 200n },
    { role: 'maker', side: 'BUY', price: referencePrice - 1000n, quantity: 200n },
    { role: 'maker', side: 'SELL', price: referencePrice + 1000n, quantity: 200n },
    { role: 'maker', side: 'SELL', price: referencePrice + 3000n, quantity: 200n },
    {
      role: 'taker',
      side: buy ? 'BUY' : 'SELL',
      price: referencePrice + (buy ? 1000n : -1000n),
      quantity: 10n,
    },
  ];
}

export async function simulatorInventory(
  tx: Transaction<Database>,
  sessionId: string,
  makerAccountId: string,
  takerAccountId: string,
  referencePrice: bigint,
): Promise<DemoOverview['inventory']> {
  const rows = await tx
    .selectFrom('balances')
    .select(['account_id', 'asset', 'bucket', 'amount'])
    .where('session_id', '=', sessionId)
    .where('account_id', 'in', [makerAccountId, takerAccountId])
    .execute();
  const exact = (accountId: string, asset: Asset, bucket: 'AVAILABLE' | 'RESERVED') =>
    BigInt(
      rows.find(
        (row) => row.account_id === accountId && row.asset === asset && row.bucket === bucket,
      )?.amount ?? '0',
    );
  const total = (accountId: string, asset: Asset) =>
    exact(accountId, asset, 'AVAILABLE') + exact(accountId, asset, 'RESERVED');
  const intents = quoteIntents(referencePrice, total(takerAccountId, 'BTC-SIM'));
  const account = (accountId: string, role: QuoteIntent['role']): Inventory => {
    const balance = (asset: Asset) => {
      const format = asset === 'BTC-SIM' ? formatQuantity : formatQuote;
      return {
        available: format(exact(accountId, asset, 'AVAILABLE')),
        reserved: format(exact(accountId, asset, 'RESERVED')),
        total: format(total(accountId, asset)),
      };
    };
    // Each cycle cancels the account's earlier orders first. This preview budgets
    // the released inventory in actual submission order, with no assumed proceeds.
    const budget = {
      'BTC-SIM': total(accountId, 'BTC-SIM'),
      'USD-SIM': total(accountId, 'USD-SIM'),
    };
    return {
      balances: { 'BTC-SIM': balance('BTC-SIM'), 'USD-SIM': balance('USD-SIM') },
      orders: intents
        .filter((intent) => intent.role === role)
        .map((intent) => {
          const asset = intent.side === 'BUY' ? 'USD-SIM' : 'BTC-SIM';
          const required =
            intent.side === 'BUY' ? buyReservation(intent.quantity, intent.price) : intent.quantity;
          const affordable = budget[asset] >= required;
          const shortfall = affordable ? 0n : required - budget[asset];
          // A rejected level does not reserve funds, matching admission behavior.
          if (affordable) budget[asset] -= required;
          const format = asset === 'BTC-SIM' ? formatQuantity : formatQuote;
          return {
            side: intent.side,
            price: formatPrice(intent.price),
            quantity: formatQuantity(intent.quantity),
            asset,
            required: format(required),
            shortfall: format(shortfall),
            affordable,
          };
        }),
    };
  };
  return { maker: account(makerAccountId, 'maker'), taker: account(takerAccountId, 'taker') };
}
