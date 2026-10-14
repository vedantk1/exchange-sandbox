import { fork } from 'node:child_process';

export interface ServerMemory {
  samplingIntervalMs: number;
  baselineRss: number;
  peakRss: number;
  baselineHeapUsed: number;
  peakHeapUsed: number;
}

type WorkerMessage =
  | { type: 'ready'; port: number }
  | { type: 'measurement-started' }
  | { type: 'measurement-stopped'; memory: ServerMemory }
  | { type: 'stopped' }
  | { type: 'failed'; code: string };

/** Only the generated benchmark schema is passed to a separate API process. */
export async function startBenchmarkServer(databaseUrl: string, requestedPort?: number) {
  const child = fork('apps/server/src/operations/large-session-worker.ts', {
    // Inherit the actual TypeScript loader used by the runner. The operations
    // image installs the tsx CLI globally instead of a workspace dev dependency.
    env: {
      ...process.env,
      NODE_ENV: 'development',
      BENCHMARK_DATABASE_URL: databaseUrl,
      ...(requestedPort === undefined ? {} : { BENCHMARK_API_PORT: String(requestedPort) }),
    },
    // Runtime URLs, credentials and native logs stay out of recorded evidence.
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
  });
  // Requests attach their own rejecting handlers; this prevents an idle IPC error
  // from becoming an uncaught exception before cleanup owns the process.
  child.on('error', () => undefined);

  function response<T extends WorkerMessage['type']>(type: T, timeoutMs = 30_000) {
    return new Promise<Extract<WorkerMessage, { type: T }>>((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error(`Benchmark worker ${type} timed out`)),
        timeoutMs,
      );
      function finish(error?: Error, message?: Extract<WorkerMessage, { type: T }>) {
        clearTimeout(timeout);
        child.off('message', onMessage);
        child.off('error', onError);
        child.off('exit', onExit);
        if (error) reject(error);
        else resolve(message!);
      }
      function onMessage(message: unknown) {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        if (message.type === 'failed') {
          const code =
            'code' in message && typeof message.code === 'string' ? message.code : 'FAILED';
          finish(new Error(`Benchmark worker failed (${code})`));
        } else if (message.type === type) {
          finish(undefined, message as Extract<WorkerMessage, { type: T }>);
        }
      }
      function onError() {
        finish(new Error('Benchmark worker IPC failed'));
      }
      function onExit() {
        finish(new Error(`Benchmark worker exited before ${type}`));
      }
      child.on('message', onMessage);
      child.once('error', onError);
      child.once('exit', onExit);
    });
  }

  async function terminate() {
    if (exited) return;
    child.kill('SIGKILL');
    await exit;
  }

  try {
    const ready = await response('ready', 30_000);
    let stop: Promise<void> | undefined;
    return {
      port: ready.port,
      origin: `http://127.0.0.1:${ready.port}`,
      async startMeasurement() {
        const pending = response('measurement-started');
        child.send({ type: 'measure-start' });
        await pending;
      },
      async stopMeasurement() {
        const pending = response('measurement-stopped');
        child.send({ type: 'measure-stop' });
        return (await pending).memory;
      },
      close() {
        stop ??= (async () => {
          if (exited) return;
          try {
            const pending = response('stopped', 30_000);
            child.send({ type: 'close' });
            await pending;
            const watchdog = setTimeout(() => child.kill('SIGKILL'), 5_000);
            try {
              await exit;
            } finally {
              clearTimeout(watchdog);
            }
          } catch (error) {
            // Confirm the previous process exited before a replacement opens its writer guard.
            await terminate();
            throw error;
          }
        })();
        return stop;
      },
    };
  } catch (error) {
    await terminate();
    throw error;
  }
}
