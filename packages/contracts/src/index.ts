import { Type, type Static } from '@sinclair/typebox';

export const Id = Type.String({
  minLength: 36,
  maxLength: 36,
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
export const Decimal = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$',
});
export const Reason = Type.String({
  minLength: 1,
  maxLength: 500,
  pattern: '^[^\\u0000-\\u001f\\u007f]+$',
});
export const Token = Type.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]{43}$' });
export const Password = Type.String({ minLength: 12, maxLength: 128 });
export const Handle = Type.String({
  minLength: 3,
  maxLength: 32,
  pattern: '^[a-zA-Z][a-zA-Z0-9_]{2,31}$',
});
export const Empty = Type.Object({}, { additionalProperties: false });
export const User = Type.Object({
  accountId: Id,
  handle: Type.String(),
  role: Type.Union([Type.Literal('ADMIN'), Type.Literal('TRADER')]),
});
export const Login = Type.Object(
  { handle: Handle, password: Password },
  { additionalProperties: false },
);
export const Redeem = Type.Object(
  { token: Token, handle: Handle, password: Password },
  { additionalProperties: false },
);
export const Recover = Type.Object(
  { token: Token, password: Password },
  { additionalProperties: false },
);
export const ChangePassword = Type.Object(
  { currentPassword: Password, newPassword: Password },
  { additionalProperties: false },
);
export const LoginResult = Type.Object({ user: User, csrfToken: Token, expiresAt: Type.String() });
export const AdminCommand = Type.Object(
  { commandId: Id, sessionId: Id, reason: Reason },
  { additionalProperties: false },
);
export const OrderCommand = Type.Object(
  {
    commandId: Id,
    sessionId: Id,
    side: Type.Union([Type.Literal('BUY'), Type.Literal('SELL')]),
    quantity: Decimal,
    price: Decimal,
  },
  { additionalProperties: false },
);
export const CancelCommand = Type.Object(
  { commandId: Id, sessionId: Id },
  { additionalProperties: false },
);
export const GrantCommand = Type.Object(
  {
    ...AdminCommand.properties,
    accountId: Id,
    asset: Type.Union([Type.Literal('BTC-SIM'), Type.Literal('USD-SIM')]),
    amount: Decimal,
  },
  { additionalProperties: false },
);
export const IdParam = Type.Object({ id: Id }, { additionalProperties: false });
export const OrderParam = Type.Object({ orderId: Id }, { additionalProperties: false });
export const CommandParam = Type.Object({ commandId: Id }, { additionalProperties: false });
export const Order = Type.Object({
  id: Id,
  accountId: Id,
  side: Type.Union([Type.Literal('BUY'), Type.Literal('SELL')]),
  price: Type.String(),
  quantity: Type.String(),
  remaining: Type.String(),
  status: Type.String(),
  cancelReason: Type.Union([Type.String(), Type.Null()]),
  reserved: Type.String(),
  sequence: Type.String(),
});
// Public-to-the-owner fill DTO deliberately omits counterparty order identities.
export const Fill = Type.Object({
  id: Id,
  quantity: Type.String(),
  price: Type.String(),
  notional: Type.String(),
  buyerFee: Type.String(),
  sellerFee: Type.String(),
  sequence: Type.String(),
  fillIndex: Type.Integer(),
});
export const AdminFill = Type.Object({
  ...Fill.properties,
  makerOrderId: Id,
  takerOrderId: Id,
  buyOrderId: Id,
  sellOrderId: Id,
});
export const CommandResult = Type.Object({
  commandId: Id,
  sessionId: Id,
  sequence: Type.String(),
  status: Type.Union([Type.Literal('ACCEPTED'), Type.Literal('REJECTED')]),
  code: Type.Optional(Type.String()),
  order: Type.Optional(Order),
  fills: Type.Array(Fill),
});
export const AdminResult = Type.Object({
  commandId: Id,
  sessionId: Id,
  sequence: Type.String(),
  status: Type.Union([Type.Literal('ACCEPTED'), Type.Literal('REJECTED')]),
  code: Type.Optional(Type.String()),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  token: Type.Optional(Token),
});
export const Balance = Type.Object({
  available: Type.String(),
  reserved: Type.String(),
  total: Type.String(),
});
export const Snapshot = Type.Object({
  sessionId: Id,
  balances: Type.Object({ 'BTC-SIM': Balance, 'USD-SIM': Balance }),
  orders: Type.Array(Order),
  fills: Type.Array(Fill),
  historyLimit: Type.Optional(Type.Integer()),
});
export const AdminSnapshot = Type.Object({ ...Snapshot.properties, fills: Type.Array(AdminFill) });
export const ErrorResult = Type.Object({ code: Type.String(), message: Type.String() });
export const Ok = Type.Object({ ok: Type.Boolean() });
export const JoinResult = Type.Object({ ...User.properties, sessionId: Id });
export const Invitations = Type.Array(
  Type.Object({
    id: Id,
    createdAt: Type.String(),
    expiresAt: Type.String(),
    state: Type.String(),
    redeemedBy: Type.Union([Id, Type.Null()]),
  }),
);
// Services return records; serializers still enforce these explicit property allowlists.
export const Traders = Type.Unsafe<Record<string, unknown>[]>(
  Type.Array(
    Type.Object({
      accountId: Id,
      handle: Type.String(),
      status: Type.String(),
      suspensionReason: Type.Union([Type.String(), Type.Null()]),
      pendingCancellation: Type.Boolean(),
      createdAt: Type.String(),
    }),
  ),
);
export const Audit = Type.Unsafe<Record<string, unknown>[]>(
  Type.Array(
    Type.Object({
      id: Id,
      actorId: Id,
      commandId: Id,
      sessionId: Type.Union([Id, Type.Null()]),
      action: Type.String(),
      targetId: Type.Union([Id, Type.Null()]),
      reason: Type.String(),
      result: Type.Record(Type.String(), Type.Unknown()),
      createdAt: Type.String(),
    }),
  ),
);
export const Overview = Type.Unsafe<Record<string, unknown>>(
  Type.Object({
    sessionId: Type.Union([Id, Type.Null()]),
    marketState: Type.String(),
    fault: Type.Union([Type.String(), Type.Null()]),
    counts: Type.Object({
      traders: Type.String(),
      suspended: Type.String(),
      pending: Type.String(),
      open_orders: Type.String(),
    }),
  }),
);
export const Receipt = Type.Unsafe<Record<string, unknown> | null>(
  Type.Union([CommandResult, AdminResult, Type.Null()]),
);
export const BookLevel = Type.Object({ price: Type.String(), quantity: Type.String() });
export const Market = Type.Object({
  sessionId: Id,
  marketState: Type.String(),
  fault: Type.Union([Type.String(), Type.Null()]),
  book: Type.Object({ bids: Type.Array(BookLevel), asks: Type.Array(BookLevel) }),
  trades: Type.Array(
    Type.Object({
      price: Type.String(),
      quantity: Type.String(),
      sequence: Type.String(),
      fillIndex: Type.Integer(),
      timestamp: Type.String(),
    }),
  ),
});
export type OrderCommandInput = Static<typeof OrderCommand>;
export type AdminCommandInput = Static<typeof AdminCommand>;

export const Cursor = Type.String({ minLength: 1, maxLength: 20, pattern: '^(0|[1-9][0-9]*)$' });
export const StreamQuery = Type.Object(
  { sessionId: Id, cursor: Cursor },
  { additionalProperties: false },
);
export const WorkspaceOrder = Type.Object({
  ...Order.properties,
  createdAt: Type.String(),
  updatedAt: Type.String(),
  executedQuantity: Type.String(),
  averagePrice: Type.Union([Type.String(), Type.Null()]),
  cumulativeFee: Type.String(),
});
export const WorkspaceFill = Type.Object({
  makerOrderId: Type.Optional(Id),
  takerOrderId: Type.Optional(Id),
  buyOrderId: Type.Optional(Id),
  sellOrderId: Type.Optional(Id),
  ...Fill.properties,
  orderId: Id,
  side: Type.Union([Type.Literal('BUY'), Type.Literal('SELL')]),
  role: Type.Union([Type.Literal('MAKER'), Type.Literal('TAKER')]),
  timestamp: Type.String(),
  fee: Type.String(),
});
export const Activity = Type.Object({
  id: Type.String(),
  commandId: Type.Union([Id, Type.Null()]),
  orderId: Type.Union([Id, Type.Null()]),
  kind: Type.String(),
  asset: Type.Union([Type.Literal('BTC-SIM'), Type.Literal('USD-SIM')]),
  bucket: Type.Union([Type.Literal('AVAILABLE'), Type.Literal('RESERVED')]),
  amount: Type.String(),
  createdAt: Type.String(),
});
export const CommandHistory = Type.Object({
  commandId: Id,
  status: Type.Union([Type.Literal('ACCEPTED'), Type.Literal('REJECTED')]),
  code: Type.Union([Type.String(), Type.Null()]),
  sequence: Type.String(),
  createdAt: Type.String(),
  orderId: Type.Union([Id, Type.Null()]),
});
export const AccountWorkspace = Type.Object({
  openOrders: Type.Array(WorkspaceOrder),
  balances: Snapshot.properties.balances,
  orders: Type.Array(WorkspaceOrder),
  fills: Type.Array(WorkspaceFill),
  activity: Type.Array(Activity),
  commands: Type.Array(CommandHistory),
  historyLimit: Type.Integer(),
});
export const OrderDetail = Type.Object({
  order: WorkspaceOrder,
  fills: Type.Array(WorkspaceFill),
  historyLimit: Type.Integer(),
});
export const Candle = Type.Object({
  timestamp: Type.String(),
  open: Type.String(),
  high: Type.String(),
  low: Type.String(),
  close: Type.String(),
  volume: Type.String(),
});
export const WorkspaceTrader = Type.Object({
  accountId: Id,
  handle: Type.String(),
  status: Type.String(),
  suspensionReason: Type.Union([Type.String(), Type.Null()]),
  pendingCancellation: Type.Boolean(),
  createdAt: Type.String(),
});
export const WorkspaceAudit = Type.Object({
  id: Id,
  actorId: Id,
  commandId: Id,
  sessionId: Type.Union([Id, Type.Null()]),
  action: Type.String(),
  targetId: Type.Union([Id, Type.Null()]),
  reason: Type.String(),
  result: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.String(),
});
export const DemoMarket = Type.Object({
  enabled: Type.Boolean(),
  status: Type.String(),
  updatedAt: Type.String(),
});
export const WorkspaceOverview = Type.Object({
  feeAccountId: Type.Union([Id, Type.Null()]),
  issuanceAccountId: Type.Union([Id, Type.Null()]),
  sessionId: Type.Union([Id, Type.Null()]),
  marketState: Type.String(),
  fault: Type.Union([Type.String(), Type.Null()]),
  demoMarket: Type.Optional(
    Type.Object({
      ...DemoMarket.properties,
      makerAccountId: Id,
      takerAccountId: Id,
    }),
  ),
  counts: Type.Object({
    traders: Type.String(),
    suspended: Type.String(),
    pending: Type.String(),
    open_orders: Type.String(),
  }),
});
export const Workspace = Type.Object({
  user: User,
  sessionId: Id,
  marketState: Type.Union([Type.Literal('TRADING'), Type.Literal('PAUSED')]),
  fault: Type.Union([Type.String(), Type.Null()]),
  cursor: Cursor,
  market: Type.Object({
    book: Market.properties.book,
    trades: Market.properties.trades,
    candles: Type.Array(Candle),
    demoMarket: Type.Optional(DemoMarket),
  }),
  account: Type.Optional(AccountWorkspace),
  admin: Type.Optional(
    Type.Object({
      overview: WorkspaceOverview,
      traders: Type.Array(WorkspaceTrader),
      invitations: Invitations,
      audit: Type.Array(WorkspaceAudit),
    }),
  ),
  historyLimit: Type.Integer(),
});
export type WorkspaceResponse = Static<typeof Workspace>;
export type AccountWorkspaceResponse = Static<typeof AccountWorkspace>;
export type OrderDetailResponse = Static<typeof OrderDetail>;
export type WorkspaceOrderResponse = Static<typeof WorkspaceOrder>;
export type WorkspaceFillResponse = Static<typeof WorkspaceFill>;

export type WorkspaceView = Static<typeof Workspace>;
export type AccountView = Static<typeof AccountWorkspace>;
export type WorkspaceOrderView = Static<typeof WorkspaceOrder>;
export type WorkspaceFillView = Static<typeof WorkspaceFill>;
export type ActivityView = Static<typeof Activity>;
export type CommandHistoryView = Static<typeof CommandHistory>;
export type CandleView = Static<typeof Candle>;
