import {
  networkInterfaces,
  type NetworkInterfaceInfoIPv4,
  type NetworkInterfaceInfoIPv6,
} from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  hostNetworkSnapshot,
  NetworkReadinessError,
  waitForHostNetworkReady,
} from '../../scripts/deploy/acceptance/network-readiness.js';

const settled = { fingerprint: 'stable', tentativeIPv6: false };
const sample = () => vi.fn(async () => ({ ...settled }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('passes only after three observed unchanged seconds and removes the total deadline', async () => {
  const read = sample();
  const done = vi.fn();
  const pending = waitForHostNetworkReady(undefined, { platform: 'linux', sample: read }).then(
    done,
  );
  await vi.advanceTimersByTimeAsync(2_999);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(done).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('a changed snapshot resets the quiet window without extending the overall budget', async () => {
  const read = sample();
  const done = vi.fn();
  const pending = waitForHostNetworkReady(undefined, { platform: 'linux', sample: read }).then(
    done,
  );
  await vi.advanceTimersByTimeAsync(2_000);
  read.mockResolvedValue({ fingerprint: 'changed', tentativeIPv6: false });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  await pending;
  expect(done).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('fails at ten seconds if topology never becomes stable', async () => {
  let value = 0;
  const read = vi.fn(async () => ({ fingerprint: String(++value), tentativeIPv6: false }));
  const pending = waitForHostNetworkReady(undefined, { platform: 'linux', sample: read }).catch(
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await pending).toBeInstanceOf(NetworkReadinessError);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds a blocked asynchronous sample and fences its eventual completion', async () => {
  let finish!: (value: typeof settled) => void;
  const read = vi.fn(
    () =>
      new Promise<typeof settled>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = waitForHostNetworkReady(undefined, { platform: 'linux', sample: read }).catch(
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await pending).toMatchObject({ code: 'ACCEPTANCE_NETWORK_NOT_READY' });
  finish(settled);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]).toBeDefined();
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels a pending read without retaining its raw failure or leaving timers', async () => {
  const controller = new AbortController();
  const read = vi.fn(async () => new Promise<typeof settled>(() => undefined));
  const pending = waitForHostNetworkReady(controller.signal, {
    platform: 'linux',
    sample: read,
  }).catch((error: unknown) => error);
  controller.abort();
  expect(await pending).toMatchObject({ code: 'ACCEPTANCE_NETWORK_NOT_READY' });
  expect(vi.getTimerCount()).toBe(0);
  const failed = await waitForHostNetworkReady(undefined, {
    platform: 'linux',
    sample: async () => {
      throw new Error('PRIVATE_NETWORK_SENTINEL');
    },
  }).catch((error: unknown) => error);
  expect(JSON.stringify(failed)).not.toContain('PRIVATE_NETWORK_SENTINEL');
});

it('does no sampling or waiting on other platforms, including an already aborted signal', async () => {
  const read = sample();
  await waitForHostNetworkReady(AbortSignal.abort(), { platform: 'darwin', sample: read });
  expect(read).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not declare a stable tentative IPv6 address ready before DAD completes', async () => {
  const read = vi.fn(async () => ({ fingerprint: 'tentative', tentativeIPv6: true }));
  const done = vi.fn();
  const pending = waitForHostNetworkReady(undefined, { platform: 'linux', sample: read }).then(
    done,
  );
  await vi.advanceTimersByTimeAsync(4_000);
  expect(done).not.toHaveBeenCalled();
  read.mockResolvedValue({ fingerprint: 'complete', tentativeIPv6: false });
  await vi.advanceTimersByTimeAsync(3_100);
  await pending;
  expect(done).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('canonicalizes address ordering and includes IPv6 DAD flags without exposing names or addresses', () => {
  type Interfaces = ReturnType<typeof networkInterfaces>;
  const first: NetworkInterfaceInfoIPv4 = {
    address: '127.0.0.1',
    netmask: '255.0.0.0',
    family: 'IPv4',
    internal: true,
    mac: '00:00:00:00:00:00',
    cidr: '127.0.0.1/8',
  };
  const second: NetworkInterfaceInfoIPv6 = {
    address: '::1',
    netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    family: 'IPv6',
    internal: true,
    scopeid: 0,
    mac: '00:00:00:00:00:00',
    cidr: '::1/128',
  };
  const interfaces: Interfaces = { PRIVATE_INTERFACE_SENTINEL: [first, second] };
  const reverse: Interfaces = { PRIVATE_INTERFACE_SENTINEL: [second, first] };
  const complete = '00000000000000000000000000000001 01 80 10 80 PRIVATE_INTERFACE_SENTINEL\n';
  const tentative = complete.replace('10 80', '10 40');
  const snapshot = hostNetworkSnapshot(interfaces, complete);
  expect(snapshot).toEqual(hostNetworkSnapshot(reverse, complete));
  expect(snapshot.tentativeIPv6).toBe(false);
  expect(hostNetworkSnapshot(interfaces, tentative).tentativeIPv6).toBe(true);
  expect(hostNetworkSnapshot(interfaces, tentative).fingerprint).not.toBe(snapshot.fingerprint);
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_INTERFACE_SENTINEL');
  expect(JSON.stringify(snapshot)).not.toContain('127.0.0.1');
});
