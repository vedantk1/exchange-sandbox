import { describe, expect, it } from 'vitest';
import {
  clearHistoryLocation,
  readHistoryLocation,
  writeHistoryLocation,
} from './history-location.js';

const actor = '11111111-1111-4111-8111-111111111111';
const account = '22222222-2222-4222-8222-222222222222';
const session = '33333333-3333-4333-8333-333333333333';

describe('validated history navigation state', () => {
  it('round-trips an archived administrator selection and all visible filters', () => {
    const parameters = new URLSearchParams({
      view: 'history',
      session,
      account,
      kind: 'orders',
      search: 'a0b1',
      side: 'SELL',
      status: 'CANCELED',
    });
    const value = readHistoryLocation(parameters, actor, true);
    expect(value).toEqual({
      sessionId: session,
      accountId: account,
      kind: 'orders',
      search: 'a0b1',
      side: 'SELL',
      status: 'CANCELED',
    });
    expect(writeHistoryLocation(parameters, value, true).toString()).toBe(parameters.toString());
  });

  it('keeps a trader scoped to its authenticated actor and rejects administrator-only views', () => {
    const parameters = new URLSearchParams({ account, kind: 'audit' });
    const value = readHistoryLocation(parameters, actor, false);
    expect(value.accountId).toBe(actor);
    expect(value.kind).toBe('fills');
    expect(writeHistoryLocation(parameters, value, false).toString()).toBe('');
  });

  it('drops invalid IDs and vocabulary rather than forwarding them to HTTP queries', () => {
    const parameters = new URLSearchParams({
      session: 'not-a-session',
      account: '../account',
      kind: 'private',
      side: 'BOTH',
      status: 'DELETED',
    });
    expect(readHistoryLocation(parameters, actor, true)).toEqual({
      sessionId: null,
      accountId: null,
      kind: 'audit',
      search: '',
      side: 'ALL',
      status: 'ALL',
    });
  });

  it.each(['x'.repeat(81), 'row\u0000identifier', 'row\nidentifier', 'row\u007fidentifier'])(
    'rejects oversized or control-containing record searches',
    (search) => {
      expect(readHistoryLocation(new URLSearchParams({ search }), actor, true).search).toBe('');
    },
  );

  it('trims an allowed search and preserves exact case-sensitive IDs', () => {
    expect(
      readHistoryLocation(new URLSearchParams({ search: '  AbC-123  ' }), actor, false).search,
    ).toBe('AbC-123');
  });

  it('ignores duplicate fields deterministically and normalizes without growing browser history', () => {
    const parameters = new URLSearchParams(
      `session=${session}&session=${session}&kind=orders&kind=audit&account=${account}&account=${actor}&side=BUY&side=SELL`,
    );
    const value = readHistoryLocation(parameters, actor, true);
    expect(writeHistoryLocation(parameters, value, true).toString()).toBe('');
  });

  it('omits active-session and default filters while retaining the administrator tab', () => {
    const parameters = new URLSearchParams('view=history');
    const value = readHistoryLocation(parameters, actor, true);
    expect(value.sessionId).toBeNull();
    expect(writeHistoryLocation(parameters, value, true).toString()).toBe('view=history');
  });

  it('retains order filters when changing the history dataset and clears only history selection keys', () => {
    const parameters = new URLSearchParams({
      view: 'history',
      session,
      account,
      kind: 'commands',
      side: 'SELL',
      status: 'CANCELED',
    });
    const value = readHistoryLocation(parameters, actor, true);
    expect(value.kind).toBe('commands');
    expect(value.side).toBe('SELL');
    expect(clearHistoryLocation(parameters).toString()).toBe('view=history');
  });
});
