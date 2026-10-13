import type { WorkspaceView } from '@sandbox/contracts';

export type MarketView = WorkspaceView['market'];
export type {
  WorkspaceOrderView as OrderView,
  WorkspaceFillView as FillView,
  OrderDetailResponse as OrderDetailView,
} from '@sandbox/contracts';
