import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import pg from 'pg';

const mode = process.argv[2];
if (mode !== 'test' && mode !== 'demo' && mode !== 'dev' && mode !== 'setup' && mode !== 'reset') {
  throw new Error('Usage: tsx scripts/with-postgres.ts <test|demo|dev|setup|reset>');
}

const persistent = mode === 'dev' || mode === 'setup' || mode === 'reset';
const localDirectory = '.local/development-postgres';
const metadataPath = '.local/development-database.json';

const connectionVariable = mode === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
const externalUrl = process.env[connectionVariable];
let child: ChildProcess | undefined;
let stopDatabase: (() => Promise<void>) | undefined;
let clusterDirectory: string | undefined;
let stage = 'preparing the runner';
let interrupted: 'SIGINT' | 'SIGTERM' | undefined;
let startupUncertain = false;

class LocalDatabaseError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false;
    throw error;
  }
}

async function localMetadata(): Promise<{ port: number; password: string }> {
  if (!(await exists(metadataPath))) {
    // Losing connection metadata must not silently replace an existing
    // cluster's credentials or reinitialize its history.
    if (await exists(`${localDirectory}/data`))
      throw new LocalDatabaseError('LOCAL_DATABASE_METADATA_MISSING');
    const fresh = { port: await availablePort(), password: randomBytes(32).toString('hex') };
    try {
      await writeFile(metadataPath, `${JSON.stringify(fresh)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
  }
  const info = await lstat(metadataPath);
  if (!info.isFile() || info.isSymbolicLink())
    throw new LocalDatabaseError('LOCAL_DATABASE_METADATA_INVALID');
  await chmod(metadataPath, 0o600);
  let metadata: unknown;
  try {
    metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch {
    throw new LocalDatabaseError('LOCAL_DATABASE_METADATA_INVALID');
  }
  const value = metadata as { port?: unknown; password?: unknown } | null;
  if (
    !value ||
    !Number.isInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535 ||
    typeof value.password !== 'string' ||
    value.password.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(value.password)
  )
    throw new LocalDatabaseError('LOCAL_DATABASE_METADATA_INVALID');
  return { port: value.port as number, password: value.password };
}

async function runningLocalDatabase(connectionString: string): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

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
      `Running ${mode} against PostgreSQL ${version} (${externalUrl ? 'external database' : persistent ? 'persistent local development cluster' : 'temporary local cluster'}).`,
    );
  } finally {
    await client.end();
  }
}

async function runChild(connectionString: string): Promise<number> {
  const arguments_ =
    mode === 'test'
      ? ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts']
      : mode === 'demo'
        ? ['--import', 'tsx', 'apps/server/src/demo.ts']
        : mode === 'dev'
          ? ['--watch', '--watch-preserve-output', '--import', 'tsx', 'apps/server/src/main.ts']
          : ['--import', 'tsx', 'apps/server/src/operator-cli.ts', mode!];
  return new Promise<number>((resolve, reject) => {
    child = spawn(process.execPath, arguments_, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(mode === 'dev' ? { NODE_ENV: 'development' } : {}),
        [connectionVariable]: connectionString,
      },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
}

const forwardInterrupt = () => {
  interrupted = 'SIGINT';
  child?.kill('SIGINT');
};
const forwardTerminate = () => {
  interrupted = 'SIGTERM';
  child?.kill('SIGTERM');
};
process.on('SIGINT', forwardInterrupt);
process.on('SIGTERM', forwardTerminate);

try {
  let connectionString = externalUrl;
  if (!connectionString) {
    // Load the native dependency only when needed: an external database also
    // works on platforms where the optional embedded binary is unavailable.
    stage = 'loading bundled PostgreSQL';
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    await mkdir('.local', { recursive: true, mode: 0o700 });
    clusterDirectory = persistent ? localDirectory : await mkdtemp('.local/postgres-');
    const { port, password } = persistent
      ? await localMetadata()
      : { port: await availablePort(), password: randomBytes(32).toString('hex') };
    await mkdir(clusterDirectory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(clusterDirectory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
      throw new LocalDatabaseError('LOCAL_DATABASE_DIRECTORY_INVALID');
    const dataDirectory = `${clusterDirectory}/data`;
    const initialized = await exists(`${dataDirectory}/PG_VERSION`);
    if (await exists(dataDirectory)) {
      const dataInfo = await lstat(dataDirectory);
      if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink())
        throw new LocalDatabaseError('LOCAL_DATABASE_DIRECTORY_INVALID');
      if (!initialized && (await readdir(dataDirectory)).length > 0)
        throw new LocalDatabaseError('LOCAL_DATABASE_INITIALIZATION_INCOMPLETE');
    }
    if (initialized && (await readFile(`${dataDirectory}/PG_VERSION`, 'utf8')).trim() !== '18')
      throw new LocalDatabaseError('LOCAL_DATABASE_VERSION_UNSUPPORTED');
    connectionString = `postgresql://sandbox:${password}@127.0.0.1:${port}/postgres`;
    const alreadyRunning =
      initialized && persistent && (await runningLocalDatabase(connectionString));
    if (alreadyRunning) {
      // A second CLI can diagnose the writer lock without stopping the
      // database owned by the already-running development server.
      console.log(
        'Using the existing local PostgreSQL process. Stop the API before owner commands.',
      );
    } else {
      const database = new EmbeddedPostgres({
        databaseDir: dataDirectory,
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
      if (!initialized) {
        const previousMask = process.umask(0o077);
        try {
          stage = 'initializing local PostgreSQL';
          await database.initialise();
        } finally {
          process.umask(previousMask);
        }
      }
      stage = 'starting local PostgreSQL';
      startupUncertain = true;
      await database.start();
      stopDatabase = () => database.stop();
      startupUncertain = false;
    }
  }
  stage = 'connecting to PostgreSQL';
  await printDatabaseVersion(connectionString);
  stage = 'starting the child command';
  process.exitCode = interrupted
    ? interrupted === 'SIGINT'
      ? 130
      : 143
    : await runChild(connectionString);
} catch (error) {
  // Do not dump connection strings, credentials, or native initdb output.
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code
      : 'UNKNOWN';
  console.error(
    `PostgreSQL ${mode} runner failed while ${stage} (${code}). Check database availability and native dependency support.`,
  );
  if (persistent && code.startsWith('LOCAL_DATABASE_'))
    console.error(
      'Local development files were preserved. Inspect .local/development-postgres and restore its matching metadata; do not reset a running or needed cluster.',
    );
  process.exitCode = 1;
} finally {
  let stopped = false;
  try {
    if (stopDatabase) await withShutdownDeadline(stopDatabase);
    if (startupUncertain) throw new Error('PostgreSQL startup outcome is uncertain.');
    stopped = true;
  } catch {
    console.error(
      `PostgreSQL shutdown was not confirmed. Retained ${clusterDirectory ?? 'cluster files'}; stop its server before removing them.`,
    );
    process.exitCode = 1;
  } finally {
    if (stopped && clusterDirectory && !persistent)
      await rm(clusterDirectory, { recursive: true, force: true });
    process.off('SIGINT', forwardInterrupt);
    process.off('SIGTERM', forwardTerminate);
  }
}

// embedded-postgres registers a beforeExit hook that otherwise replaces the
// child's failure status with zero. Cleanup is complete; preserve its result.
process.exit(process.exitCode ?? 0);
