import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { Exchange } from '../../apps/server/src/exchange.js';

export async function killAtTransactionBoundary(
  databaseUrl: string,
  stage: 'beforeCommit' | 'afterCommit',
  command: Parameters<Exchange['placeLimit']>[0] | Parameters<Exchange['placeMarket']>[0],
  operation: 'limit' | 'market' = 'limit',
) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./crash-worker.ts', import.meta.url))],
    {
      env: {
        ...process.env,
        TEST_DATABASE_URL: databaseUrl,
        EXCHANGE_CRASH_STAGE: stage,
        EXCHANGE_CRASH_OPERATION: operation,
        EXCHANGE_CRASH_COMMAND: JSON.stringify(command),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Worker did not reach ${stage}. ${stderr}`)),
        15_000,
      );
      child.on('message', (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'stage' in message &&
          message.stage === stage
        ) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Worker exited before ${stage}: ${code ?? signal}. ${stderr}`));
      });
    });
    const exited = once(child, 'exit');
    if (!child.kill('SIGKILL')) throw new Error('Could not kill the crash worker.');
    const [, signal] = await exited;
    if (signal !== 'SIGKILL') throw new Error(`Unexpected worker termination: ${String(signal)}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
}
