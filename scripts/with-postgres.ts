import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import pg from 'pg';

const mode = process.argv[2];
if (mode !== 'test' && mode !== 'demo') {
  throw new Error('Usage: tsx scripts/with-postgres.ts <test|demo>');
}

const connectionVariable = mode === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
const externalUrl = process.env[connectionVariable];
let child: ChildProcess | undefined;
let stopDatabase: (() => Promise<void>) | undefined;
let clusterDirectory: string | undefined;
let stage = 'preparing the runner';

async function withShutdownDeadline(stop: () => Promise<void>): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      stop(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('PostgreSQL shutdown timed out.')), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === 'string')
    throw new Error('Could not allocate a loopback port.');
  return address.port;
}

async function printDatabaseVersion(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const result = await client.query<{ version: string }>('SELECT version() AS version');
    const version = result.rows[0]?.version.match(/^PostgreSQL ([0-9]+(?:\.[0-9]+)*)/)?.[1];
    if (!version) throw new Error('Connected server did not return a PostgreSQL version.');
    console.log(
      `Running ${mode} against PostgreSQL ${version} (${externalUrl ? 'external database' : 'temporary local cluster'}).`,
    );
  } finally {
    await client.end();
  }
}

async function runChild(connectionString: string): Promise<number> {
  const arguments_ =
    mode === 'test'
      ? ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts']
      : ['--import', 'tsx', 'apps/server/src/demo.ts'];
  return new Promise<number>((resolve, reject) => {
    child = spawn(process.execPath, arguments_, {
      stdio: 'inherit',
      env: { ...process.env, [connectionVariable]: connectionString },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
}

const forwardInterrupt = () => child?.kill('SIGINT');
const forwardTerminate = () => child?.kill('SIGTERM');
process.on('SIGINT', forwardInterrupt);
process.on('SIGTERM', forwardTerminate);

try {
  let connectionString = externalUrl;
  if (!connectionString) {
    // Load the native dependency only when needed: an external database also
    // works on platforms where the optional embedded binary is unavailable.
    stage = 'loading bundled PostgreSQL';
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    await mkdir('.local', { recursive: true });
    clusterDirectory = await mkdtemp('.local/postgres-');
    const port = await availablePort();
    const password = randomBytes(32).toString('hex');
    const database = new EmbeddedPostgres({
      databaseDir: `${clusterDirectory}/data`,
      port,
      user: 'sandbox',
      password,
      authMethod: 'scram-sha-256',
      persistent: true,
      createPostgresUser: false,
      postgresFlags: ['-h', '127.0.0.1', '-c', 'unix_socket_directories='],
      // The library's initdb output includes local machine identifiers. Keep
      // logs private; connection/version checks give deterministic diagnostics.
      onLog: () => undefined,
      onError: () => undefined,
    });
    stopDatabase = () => database.stop();
    const previousMask = process.umask(0o077);
    try {
      stage = 'initializing temporary PostgreSQL';
      await database.initialise();
    } finally {
      process.umask(previousMask);
    }
    stage = 'starting temporary PostgreSQL';
    await database.start();
    connectionString = `postgresql://sandbox:${password}@127.0.0.1:${port}/postgres`;
  }
  stage = 'connecting to PostgreSQL';
  await printDatabaseVersion(connectionString);
  stage = 'starting the child command';
  process.exitCode = await runChild(connectionString);
} catch (error) {
  // Do not dump connection strings, credentials, or native initdb output.
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
  console.error(
    `PostgreSQL ${mode} runner failed while ${stage} (${code}). Check database availability and native dependency support.`,
  );
  process.exitCode = 1;
} finally {
  let stopped = false;
  try {
    if (stopDatabase) await withShutdownDeadline(stopDatabase);
    stopped = true;
  } catch {
    console.error(
      `PostgreSQL shutdown was not confirmed. Retained ${clusterDirectory ?? 'cluster files'}; stop its server before removing them.`,
    );
    process.exitCode = 1;
  } finally {
    if (stopped && clusterDirectory) await rm(clusterDirectory, { recursive: true, force: true });
    process.off('SIGINT', forwardInterrupt);
    process.off('SIGTERM', forwardTerminate);
  }
}

// embedded-postgres registers a beforeExit hook that otherwise replaces the
// child's failure status with zero. Cleanup is complete; preserve its result.
process.exit(process.exitCode ?? 0);
