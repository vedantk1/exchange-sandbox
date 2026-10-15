import type { Execute } from './lifecycle.js';

export interface RuntimeCheckpoint {
  available: boolean;
  running: boolean | null;
  oomKilled: boolean | null;
  restartCount: number | null;
}

const unavailable = (): RuntimeCheckpoint => ({
  available: false,
  running: null,
  oomKilled: null,
  restartCount: null,
});

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 255)
    : null;

/** Fixed fields only: container IDs, names, paths, environment and errors are excluded. */
export function formatRuntimeCheckpoint(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  try {
    const { available, running, oomKilled, restartCount } = value as Record<string, unknown>;
    const checkpoint: RuntimeCheckpoint =
      available === true
        ? {
            available: true,
            running: typeof running === 'boolean' ? running : null,
            oomKilled: typeof oomKilled === 'boolean' ? oomKilled : null,
            restartCount: count(restartCount),
          }
        : unavailable();
    return JSON.stringify(checkpoint);
  } catch {
    return;
  }
}

/** Read one previously verified API container before cleanup, without logs or another API request. */
export async function readRuntimeCheckpoint(
  execute: Execute,
  verifiedApiId: string,
  signal: AbortSignal,
): Promise<RuntimeCheckpoint> {
  if (!/^[0-9a-f]{64}$/.test(verifiedApiId) || signal.aborted) return unavailable();
  const controller = new AbortController();
  const linked = AbortSignal.any([signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let canceled: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      canceled = () => reject(new Error('Runtime inspection unavailable.'));
      linked.addEventListener('abort', canceled, { once: true });
      timer = setTimeout(() => controller.abort(), 2_000);
    });
    const text = await Promise.race([execute(['inspect', verifiedApiId], 2_000, linked), aborted]);
    linked.throwIfAborted();
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length !== 1) return unavailable();
    const inspected = parsed[0] as {
      Id?: unknown;
      State?: { Running?: unknown; OOMKilled?: unknown };
      RestartCount?: unknown;
    } | null;
    const restartCount = count(inspected?.RestartCount);
    if (
      inspected?.Id !== verifiedApiId ||
      typeof inspected.State?.Running !== 'boolean' ||
      typeof inspected.State.OOMKilled !== 'boolean' ||
      restartCount === null
    )
      return unavailable();
    return {
      available: true,
      running: inspected.State.Running,
      oomKilled: inspected.State.OOMKilled,
      restartCount,
    };
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timer);
    if (canceled) linked.removeEventListener('abort', canceled);
  }
}
