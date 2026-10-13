import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type CommandOutcome } from './api.js';
import { CommandRunner, type PendingCommand } from './commands.js';

type Request = <T>(path: string, body?: Record<string, unknown>) => Promise<T>;
const actorId = randomUUID();
const sessionId = randomUUID();
const order = { side: 'BUY', quantity: '0.1', price: '50000' };

function memory() {
  const entries = new Map<string, string>();
  const writes: string[] = [];
  return {
    entries,
    writes,
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
      writes.push(value);
    }),
    removeItem: vi.fn((key: string) => {
      entries.delete(key);
    }),
  };
}

function accepted(body: Record<string, unknown>): CommandOutcome {
  return {
    commandId: body.commandId as string,
    sessionId: body.sessionId as string,
    sequence: '1',
    status: 'ACCEPTED',
  };
}

function requester(
  work: (path: string, body?: Record<string, unknown>) => unknown | Promise<unknown>,
) {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const request: Request = async <T>(path: string, body?: Record<string, unknown>): Promise<T> => {
    calls.push({ path, ...(body ? { body: structuredClone(body) } : {}) });
    return (await work(path, body)) as T;
  };
  return { request, calls };
}

function pending(storage: ReturnType<typeof memory>): PendingCommand {
  expect(storage.entries.size).toBe(1);
  return JSON.parse([...storage.entries.values()][0]!) as PendingCommand;
}

describe('durable browser command intentions', () => {
  it('persists the identity before sending and prevents a second intention while dispatch is pending', async () => {
    const storage = memory();
    let release!: (result: CommandOutcome) => void;
    const outstanding = new Promise<CommandOutcome>((resolve) => {
      release = resolve;
    });
    const transport = requester((_path, body) => {
      expect(pending(storage).body).toEqual(body);
      return outstanding;
    });
    const runner = new CommandRunner(actorId, storage, transport.request, vi.fn());
    const first = runner.submit('/api/orders', order, 'Buy simulated BTC', sessionId);
    expect(runner.busy).toBe(true);
    expect(await runner.submit('/api/orders', order, 'Duplicate click', sessionId)).toBeNull();
    expect(transport.calls).toHaveLength(1);
    const sent = transport.calls[0]!.body!;
    expect(sent).toMatchObject({ ...order, sessionId, commandId: expect.any(String) });
    release(accepted(sent));
    expect(await first).toEqual(accepted(sent));
    expect(runner.pending).toBeNull();
    expect(storage.entries.size).toBe(0);
  });

  it('resolves a lost command response from its original receipt without submitting again', async () => {
    const storage = memory();
    let submitted: Record<string, unknown> | undefined;
    const transport = requester((path, body) => {
      if (body) {
        submitted = body;
        throw new TypeError('Connection lost after commit');
      }
      expect(path).toBe(`/api/receipts/${submitted!.commandId}`);
      return accepted(submitted!);
    });
    const runner = new CommandRunner(actorId, storage, transport.request, vi.fn());
    const result = await runner.submit('/api/orders', order, 'Buy simulated BTC', sessionId);
    expect(result).toEqual(accepted(submitted!));
    expect(transport.calls.filter((call) => call.body)).toHaveLength(1);
    expect(runner.pending).toBeNull();
    expect(storage.entries.size).toBe(0);
  });

  it('restores an unresolved request after reload and retries the exact same identity and body when no receipt exists', async () => {
    const storage = memory();
    const offline = requester(() => {
      throw new TypeError('Offline');
    });
    const first = new CommandRunner(actorId, storage, offline.request, vi.fn());
    expect(await first.submit('/api/orders', order, 'Buy simulated BTC', sessionId)).toBeNull();
    const original = structuredClone(first.pending!);
    expect(pending(storage)).toEqual(original);
    const transport = requester((_path, body) => (body ? accepted(body) : null));
    const restored = new CommandRunner(actorId, storage, transport.request, vi.fn());
    expect(restored.pending).toEqual(original);
    expect(await restored.resolve()).toBeNull();
    expect(restored.pending).toEqual(original);
    expect(
      await restored.submit(
        '/api/orders',
        { ...order, price: '60000' },
        'New intention',
        sessionId,
      ),
    ).toBeNull();
    expect(await restored.retry()).toEqual(accepted(original.body));
    expect(transport.calls).toEqual([
      { path: `/api/receipts/${original.body.commandId}` },
      { path: '/api/orders', body: original.body },
    ]);
    expect(restored.pending).toBeNull();
    expect(storage.writes).toHaveLength(1);
  });

  it.each(['start', 'stop'] as const)(
    'restores a simulator %s after a lost response and retries its original audited intention',
    async (action) => {
      const storage = memory();
      const path = `/api/admin/simulator/${action}`;
      const body = { reason: `Operator chose to ${action} synthetic activity` };
      const offline = requester(() => {
        throw new TypeError('Connection lost');
      });
      const first = new CommandRunner(actorId, storage, offline.request, vi.fn());
      expect(await first.submit(path, body, `${action} simulator`, sessionId)).toBeNull();
      const original = pending(storage);
      expect(original).toMatchObject({ path, body: { ...body, sessionId } });
      const online = requester((_path, retryBody) => (retryBody ? accepted(retryBody) : null));
      const restored = new CommandRunner(actorId, storage, online.request, vi.fn());
      expect(restored.storageBlocked).toBe(false);
      expect(restored.pending).toEqual(original);
      expect(await restored.resolve()).toBeNull();
      expect(await restored.retry()).toEqual(accepted(original.body));
      expect(online.calls).toEqual([
        { path: `/api/receipts/${original.body.commandId}` },
        { path, body: original.body },
      ]);
      expect(storage.writes).toHaveLength(1);
      expect(storage.entries.size).toBe(0);
      expect(restored.pending).toBeNull();
    },
  );

  it.each([400, 401, 403, 429])(
    'clears a first-attempt definite HTTP %i rejection without retrying or reading a receipt',
    async (status) => {
      const storage = memory();
      const transport = requester(() => {
        throw new ApiError(status, 'REQUEST_REJECTED', 'Rejected before admission');
      });
      const runner = new CommandRunner(actorId, storage, transport.request, vi.fn());
      expect(await runner.submit('/api/orders', order, 'Buy simulated BTC', sessionId)).toBeNull();
      expect(runner.pending).toBeNull();
      expect(storage.entries.size).toBe(0);
      expect(transport.calls).toHaveLength(1);
      expect(runner.error).toBe('Rejected before admission');
      runner.dismissError();
      expect(runner.error).toBeNull();
    },
  );

  it('retains an earlier uncertain identity when retry receives a definite rejection but its receipt is absent', async () => {
    const storage = memory();
    const offline = requester(() => {
      throw new TypeError('Offline');
    });
    const first = new CommandRunner(actorId, storage, offline.request, vi.fn());
    await first.submit('/api/orders', order, 'Buy simulated BTC', sessionId);
    const original = structuredClone(first.pending!);
    const transport = requester((_path, body) => {
      if (body) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again');
      return null;
    });
    const restored = new CommandRunner(actorId, storage, transport.request, vi.fn());
    expect(await restored.retry()).toBeNull();
    expect(restored.pending).toEqual(original);
    expect(pending(storage)).toEqual(original);
    expect(transport.calls.map((call) => call.path)).toEqual([
      '/api/orders',
      `/api/receipts/${original.body.commandId}`,
    ]);
    restored.dismissError();
    expect(restored.error).not.toBeNull();
  });

  it('treats an identity conflict as unresolved until the original outcome can be established', async () => {
    const storage = memory();
    const transport = requester((_path, body) => {
      if (body) throw new ApiError(409, 'COMMAND_CONFLICT', 'The identity already exists');
      return null;
    });
    const runner = new CommandRunner(actorId, storage, transport.request, vi.fn());
    expect(await runner.submit('/api/orders', order, 'Buy simulated BTC', sessionId)).toBeNull();
    expect(runner.pending).toEqual(pending(storage));
    expect(transport.calls).toHaveLength(2);
  });

  it('never stores returned invitation secrets and rejects credential routes before storage', async () => {
    const storage = memory();
    const secret = 'one-time-secret-returned-only-in-the-response';
    const transport = requester((_path, body) => ({ ...accepted(body!), token: secret }));
    const runner = new CommandRunner(actorId, storage, transport.request, vi.fn());
    expect(
      await runner.submit(
        '/api/admin/invitations',
        { reason: 'Invite a participant' },
        'Create invitation',
        sessionId,
      ),
    ).toMatchObject({ token: secret });
    expect(storage.writes.join('\n')).not.toContain(secret);
    expect(storage.entries.size).toBe(0);
    const writes = storage.writes.length;
    await expect(
      runner.submit(
        '/api/auth/password',
        { currentPassword: 'current-secret-password', newPassword: 'next-secret-password' },
        'Change password',
        sessionId,
      ),
    ).rejects.toThrow('Unsupported');
    expect(storage.writes).toHaveLength(writes);
    expect(storage.writes.join('\n')).not.toContain('secret-password');
    expect(transport.calls).toHaveLength(1);
  });

  it.each([
    { password: 'private-value' },
    { details: { currentPassword: 'private-value' } },
    { details: [{ recovery_token: 'private-value' }] },
    { secret: 'private-value' },
  ])(
    'rejects accidental secret-bearing command fields before any persistence or request',
    async (extra) => {
      const storage = memory();
      const transport = requester((_path, body) => accepted(body!));
      const runner = new CommandRunner(actorId, storage, transport.request, vi.fn());
      await expect(
        runner.submit('/api/orders', { ...order, ...extra }, 'Buy simulated BTC', sessionId),
      ).rejects.toThrow('Credential fields');
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(transport.calls).toEqual([]);
      expect(runner.pending).toBeNull();
    },
  );

  it.each(['malformed JSON', 'read denied'])(
    'blocks new commands when prior storage cannot be trusted: %s',
    async (mode) => {
      const storage = memory();
      if (mode === 'malformed JSON')
        storage.entries.set(`sandbox.pending.v1.${actorId}`, '{broken');
      else
        storage.getItem.mockImplementation(() => {
          throw new Error('Storage denied');
        });
      const transport = requester((_path, body) => accepted(body!));
      const runner = new CommandRunner(actorId, storage, transport.request, vi.fn());
      expect(runner.storageBlocked).toBe(true);
      runner.dismissError();
      expect(runner.error).not.toBeNull();
      expect(await runner.submit('/api/orders', order, 'Buy simulated BTC', sessionId)).toBeNull();
      expect(transport.calls).toEqual([]);
      expect(storage.setItem).not.toHaveBeenCalled();
    },
  );

  it('sends nothing when the pending identity cannot be persisted', async () => {
    const storage = memory();
    storage.setItem.mockImplementation(() => {
      throw new Error('Quota exhausted');
    });
    const transport = requester((_path, body) => accepted(body!));
    const runner = new CommandRunner(actorId, storage, transport.request, vi.fn());
    expect(await runner.submit('/api/orders', order, 'Buy simulated BTC', sessionId)).toBeNull();
    expect(runner.pending).toBeNull();
    expect(runner.error).toBeTruthy();
    expect(transport.calls).toEqual([]);
  });

  it('does not discard a pending identity when an unrelated receipt is returned', async () => {
    const storage = memory();
    const transport = requester((_path, body) =>
      body ? { ...accepted(body), commandId: randomUUID() } : null,
    );
    const runner = new CommandRunner(actorId, storage, transport.request, vi.fn());
    expect(await runner.submit('/api/orders', order, 'Buy simulated BTC', sessionId)).toBeNull();
    expect(runner.pending).toEqual(pending(storage));
    expect(runner.error).toContain('unknown');
  });
});
