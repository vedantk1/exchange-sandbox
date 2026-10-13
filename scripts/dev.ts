import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

function port(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65_535)
    throw new Error('Invalid development port.');
  return Number(value);
}

async function requireFreePort(value: number): Promise<void> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(value, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
}

const children: { child: ChildProcess; closed: Promise<void> }[] = [];
let stopping = false;
let finish: (status: number) => void;
const finished = new Promise<number>((resolve) => {
  finish = resolve;
});

function start(arguments_: string[], environment: NodeJS.ProcessEnv, cwd?: string): void {
  const child = spawn(process.execPath, arguments_, {
    ...(cwd ? { cwd } : {}),
    stdio: 'inherit',
    env: environment,
  });
  const closed = new Promise<void>((resolve) => {
    child.once('error', () => {
      finish(1);
      resolve();
    });
    child.once('exit', (code) => {
      if (!stopping) finish(code === 0 ? 1 : (code ?? 1));
      resolve();
    });
  });
  children.push({ child, closed });
}

function interrupt(): void {
  stopping = true;
  finish(0);
}
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

async function ready(backendPort: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${backendPort}/health/live`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      /* The API can take a moment to migrate and acquire its writer. */
    }
    await delay(150);
  }
  throw new Error('Development API did not start.');
}

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const backendPort = port(process.env.PORT, 3001);
  const webPort = port(process.env.WEB_PORT, 3000);
  if (backendPort === webPort) throw new Error('Development ports must differ.');
  await requireFreePort(backendPort);
  await requireFreePort(webPort);
  if (!stopping) {
    const environment = {
      ...process.env,
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: String(backendPort),
      WEB_PORT: String(webPort),
      API_ORIGIN: process.env.API_ORIGIN ?? `http://localhost:${webPort}`,
    };
    start(
      ['--watch', '--watch-preserve-output', '--import', 'tsx', 'apps/server/src/main.ts'],
      environment,
    );
    const startup = await Promise.race([ready(backendPort).then(() => 'ready' as const), finished]);
    if (startup === 'ready' && !stopping) {
      start(['node_modules/vite/bin/vite.js'], environment, 'apps/web');
      console.log(
        `Development workspace: http://localhost:${webPort}. API: loopback port ${backendPort}.`,
      );
      process.exitCode = await finished;
    } else if (typeof startup === 'number') process.exitCode = startup;
  }
} catch {
  console.error(
    'Development servers could not start. Check free PORT and WEB_PORT values and the API startup diagnostics.',
  );
  process.exitCode = 1;
} finally {
  stopping = true;
  for (const { child } of children)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(children.map(({ closed }) => closed)),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          for (const { child } of children)
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          resolve();
        }, 8_000);
      }),
    ]);
    await Promise.all(children.map(({ closed }) => closed));
  } finally {
    clearTimeout(timeout);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
