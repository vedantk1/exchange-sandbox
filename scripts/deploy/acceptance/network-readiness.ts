import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';

export class NetworkReadinessError extends Error {
  readonly code = 'ACCEPTANCE_NETWORK_NOT_READY';
  constructor() {
    super('ACCEPTANCE_NETWORK_NOT_READY');
  }
}

interface Snapshot {
  fingerprint: string;
  tentativeIPv6: boolean;
}
interface Environment {
  platform: NodeJS.Platform;
  sample(signal: AbortSignal): Promise<Snapshot>;
}

/** Addresses and interface names remain in memory; only an opaque comparison value escapes. */
export function hostNetworkSnapshot(
  interfaces: ReturnType<typeof networkInterfaces>,
  ipv6: string,
): Snapshot {
  const entries = Object.keys(interfaces)
    .sort()
    .map((name) => [
      name,
      (interfaces[name] ?? [])
        .map((entry) =>
          JSON.stringify([
            entry.family,
            entry.address,
            entry.netmask,
            'scopeid' in entry ? entry.scopeid : 0,
            entry.internal,
          ]),
        )
        .sort(),
    ]);
  const rows = ipv6.trim()
    ? ipv6
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
    : [];
  if (rows.some((row) => row.length !== 6 || !/^[0-9a-f]{1,8}$/i.test(row[4]!)))
    throw new NetworkReadinessError();
  return {
    fingerprint: createHash('sha256')
      .update(JSON.stringify([entries, rows.map((row) => row.join(' ')).sort()]))
      .digest('hex'),
    // IFA_F_TENTATIVE: a stable tentative address can still complete DAD later.
    tentativeIPv6: rows.some((row) => (Number.parseInt(row[4]!, 16) & 0x40) !== 0),
  };
}

const environment: Environment = {
  platform: process.platform,
  async sample(signal) {
    const interfaces = networkInterfaces();
    let ipv6: string;
    try {
      ipv6 = await readFile('/proc/net/if_inet6', { encoding: 'utf8', signal });
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw new NetworkReadinessError();
      ipv6 = '';
    }
    return hostNetworkSnapshot(interfaces, ipv6);
  },
};

/** Wait for observed Linux topology to settle before launching Chromium, never retry a POST. */
export async function waitForHostNetworkReady(
  externalSignal?: AbortSignal,
  dependencies: Environment = environment,
): Promise<void> {
  if (dependencies.platform !== 'linux') return;
  const controller = new AbortController();
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const deadline = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(new NetworkReadinessError());
      signal.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => controller.abort(), 10_000);
    });
    const observe = async () => {
      let previous: string | undefined;
      let unchangedSince = performance.now();
      while (true) {
        signal.throwIfAborted();
        const snapshot = await dependencies.sample(signal);
        signal.throwIfAborted();
        const now = performance.now();
        if (snapshot.fingerprint !== previous || snapshot.tentativeIPv6) unchangedSince = now;
        else if (now - unchangedSince >= 3_000) return;
        previous = snapshot.fingerprint;
        await new Promise<void>((resolve, reject) => {
          const canceled = () => {
            clearTimeout(poll);
            reject(new NetworkReadinessError());
          };
          const poll = setTimeout(() => {
            signal.removeEventListener('abort', canceled);
            resolve();
          }, 100);
          signal.addEventListener('abort', canceled, { once: true });
        });
      }
    };
    // Chromium's Linux notifier coalesces IP changes for two seconds:
    // chromium/chromium, net/base/network_change_notifier_linux.cc,
    // NetworkChangeCalculatorParamsLinux(). Observe three quiet seconds, including DAD flags.
    await Promise.race([observe(), deadline]);
  } catch {
    throw new NetworkReadinessError();
  } finally {
    clearTimeout(timer);
    if (aborted) signal.removeEventListener('abort', aborted);
    controller.abort();
  }
}
