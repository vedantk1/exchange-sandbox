import { afterEach, expect, it, vi } from 'vitest';
import {
  formatRuntimeCheckpoint,
  readRuntimeCheckpoint,
} from '../../scripts/deploy/acceptance/runtime-checkpoint.js';
import type { Execute } from '../../scripts/deploy/acceptance/lifecycle.js';

const id = 'a'.repeat(64);
const empty = { available: false, running: null, oomKilled: null, restartCount: null };
const snapshot = (override: Record<string, unknown> = {}) =>
  JSON.stringify([
    {
      Id: id,
      State: { Running: true, OOMKilled: false },
      RestartCount: 0,
      Name: 'PRIVATE_RUNTIME_SENTINEL',
      Config: { Env: ['PRIVATE_RUNTIME_SENTINEL'] },
      ...override,
    },
  ]);
afterEach(() => vi.useRealTimers());

it('inspects only the exact verified API identity with a two-second linked budget', async () => {
  const execute = vi.fn<Execute>().mockResolvedValue(snapshot({ RestartCount: 1000 }));
  const signal = new AbortController().signal;
  const checkpoint = await readRuntimeCheckpoint(execute, id, signal);
  expect(checkpoint).toEqual({
    available: true,
    running: true,
    oomKilled: false,
    restartCount: 255,
  });
  expect(execute).toHaveBeenCalledTimes(1);
  const [arguments_, timeout, linked] = execute.mock.calls[0]!;
  expect(arguments_).toEqual(['inspect', id]);
  expect(timeout).toBe(2000);
  expect(linked?.aborted).toBe(false);
  expect(JSON.stringify(checkpoint)).not.toContain('PRIVATE_RUNTIME_SENTINEL');
});

it('rejects foreign identities, malformed inspect data and nonprimitive state without retaining diagnostics', async () => {
  for (const output of [
    'PRIVATE_RUNTIME_SENTINEL',
    '[]',
    snapshot({ Id: 'b'.repeat(64) }),
    snapshot({ State: { Running: 'true', OOMKilled: false } }),
    snapshot({ State: { Running: true, OOMKilled: 0 } }),
    ...[-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1].map((RestartCount) =>
      snapshot({ RestartCount }),
    ),
  ]) {
    const execute = vi.fn<Execute>().mockResolvedValue(output);
    expect(await readRuntimeCheckpoint(execute, id, new AbortController().signal)).toEqual(empty);
  }
  const execute = vi.fn<Execute>().mockRejectedValue(new Error('PRIVATE_RUNTIME_SENTINEL'));
  expect(await readRuntimeCheckpoint(execute, id, new AbortController().signal)).toEqual(empty);
});

it('does no Docker work for an unverified identity or canceled operation', async () => {
  const execute = vi.fn<Execute>();
  expect(
    await readRuntimeCheckpoint(execute, 'PRIVATE_RUNTIME_SENTINEL', new AbortController().signal),
  ).toEqual(empty);
  expect(await readRuntimeCheckpoint(execute, id, AbortSignal.abort())).toEqual(empty);
  expect(execute).not.toHaveBeenCalled();
});

it('returns unavailable within two seconds even if the inspected transport never settles', async () => {
  vi.useFakeTimers();
  const execute = vi.fn<Execute>(() => new Promise(() => undefined));
  const pending = readRuntimeCheckpoint(execute, id, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toEqual(empty);
  expect(execute.mock.calls[0]![2]?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('propagates external cancellation and removes its inspection deadline', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const execute = vi.fn<Execute>(() => new Promise(() => undefined));
  const pending = readRuntimeCheckpoint(execute, id, controller.signal);
  controller.abort();
  expect(await pending).toEqual(empty);
  expect(execute.mock.calls[0]![2]?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('reconstructs only fixed primitive fields and reads getter-backed values once', () => {
  let reads = 0;
  const value = {
    available: true,
    running: 'PRIVATE_RUNTIME_SENTINEL',
    oomKilled: false,
    get restartCount() {
      return ++reads === 1 ? 2 : 'PRIVATE_RUNTIME_SENTINEL';
    },
    error: new Error('PRIVATE_RUNTIME_SENTINEL'),
  };
  const text = formatRuntimeCheckpoint(value);
  expect(JSON.parse(text!)).toEqual({
    available: true,
    running: null,
    oomKilled: false,
    restartCount: 2,
  });
  expect(reads).toBe(1);
  expect(text).not.toContain('PRIVATE_RUNTIME_SENTINEL');
  expect(
    formatRuntimeCheckpoint({ available: false, running: true, oomKilled: true, restartCount: 2 }),
  ).toBe(JSON.stringify(empty));
  expect(formatRuntimeCheckpoint(undefined)).toBeUndefined();
  expect(
    formatRuntimeCheckpoint(
      Object.defineProperty({}, 'available', {
        get() {
          throw new Error('PRIVATE_RUNTIME_SENTINEL');
        },
      }),
    ),
  ).toBeUndefined();
});
