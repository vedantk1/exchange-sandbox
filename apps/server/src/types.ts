import type { OrderStatus, Side } from '@sandbox/domain';

export interface CommandIdentity {
  accountId: string;
  commandId: string;
  sessionId: string;
}

export interface LimitCommand extends CommandIdentity {
  side: Side;
  quantity: string;
  price: string;
}

export interface CancelCommand extends CommandIdentity {
  orderId: string;
}

export interface OrderView {
  id: string;
  accountId: string;
  side: Side;
  price: string;
  quantity: string;
  remaining: string;
  status: OrderStatus;
  cancelReason: string | null;
  reserved: string;
  sequence: string;
}

export interface FillView {
  id: string;
  makerOrderId: string;
  takerOrderId: string;
  buyOrderId: string;
  sellOrderId: string;
  quantity: string;
  price: string;
  notional: string;
  buyerFee: string;
  sellerFee: string;
  sequence: string;
  fillIndex: number;
}

export interface CommandResult {
  commandId: string;
  sessionId: string;
  sequence: string;
  status: 'ACCEPTED' | 'REJECTED';
  code?: string;
  order?: OrderView;
  fills: FillView[];
}

export interface BalanceView {
  available: string;
  reserved: string;
  total: string;
}

export interface Snapshot {
  sessionId: string;
  balances: Record<'BTC-SIM' | 'USD-SIM', BalanceView>;
  orders: OrderView[];
  fills: FillView[];
}

/** Failure injection at transaction boundaries; never supplied by a remote caller. */
export interface ExchangeOptions {
  hooks?: {
    beforeCommit?: (commandId: string) => Promise<void>;
    afterCommit?: (commandId: string) => Promise<void>;
  };
}
