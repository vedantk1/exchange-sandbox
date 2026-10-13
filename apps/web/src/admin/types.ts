import type { AccountView, WorkspaceView } from '@sandbox/contracts';
import type { CommandOutcome } from '../lib/api';

export type AdminData = NonNullable<WorkspaceView['admin']>;
export type Trader = AdminData['traders'][number];
export type GrantTarget = { accountId: string; label: string };

export interface AdminWorkspaceProps {
  workspace: WorkspaceView;
  refresh: () => Promise<void>;
  readAccount: (accountId: string) => Promise<AccountView>;
  runCommand: (
    path: string,
    payload: Record<string, unknown>,
    label: string,
  ) => Promise<CommandOutcome | null>;
  busy: boolean;
  connected: boolean;
}

export interface AdminAction {
  title: string;
  description: string;
  path: string;
  target?: string;
  danger?: boolean;
  secret?: 'join' | 'recover';
  grant?: GrantTarget;
  payload?: Record<string, unknown>;
}
