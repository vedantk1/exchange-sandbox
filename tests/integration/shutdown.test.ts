import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../../apps/server/src/shutdown.js';

describe('server shutdown coordination', () => {
  it('closes HTTP admissions and simulator together, then disposes DB exactly once', async () => {
    const order: string[] = [];
    const close = createShutdown({
      stopSimulator: async () => {
        order.push('simulator');
      },
      closeHttp: async () => {
        order.push('http');
      },
      closeExchange: async () => {
        order.push('database');
      },
      terminate: () => {
        throw new Error('Unexpected deadline.');
      },
    });
    await Promise.all([close(), close()]);
    expect(order).toEqual(['simulator', 'http', 'database']);
  });

  it('still disposes DB after a failed HTTP close and retains the same failed result', async () => {
    const closeExchange = vi.fn(async () => undefined);
    const terminate = vi.fn();
    const close = createShutdown({
      stopSimulator: async () => undefined,
      closeHttp: async () => {
        throw new Error('HTTP close failed.');
      },
      closeExchange,
      terminate,
    });
    await expect(close()).rejects.toThrow('HTTP close failed.');
    await expect(close()).rejects.toThrow('HTTP close failed.');
    expect(closeExchange).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates on a failed database close rather than leaving its handles alive', async () => {
    const terminate = vi.fn();
    const close = createShutdown({
      stopSimulator: async () => undefined,
      closeHttp: async () => undefined,
      closeExchange: async () => {
        throw new Error('Database close failed.');
      },
      terminate,
    });
    await expect(close()).rejects.toThrow('Database close failed.');
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('invokes fail-closed termination for a stage that never settles, without reporting completion', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let completed = false;
    const terminate = vi.fn();
    const close = createShutdown({
      stopSimulator: async () => blocked,
      closeHttp: async () => undefined,
      closeExchange: async () => undefined,
      terminate,
      timeoutMs: 30,
    });
    const closing = close().then(() => {
      completed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    finish();
    await closing;
  });
});
