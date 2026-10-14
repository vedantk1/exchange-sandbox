import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const apiImage = process.argv[2] ?? 'spot-exchange-simulator-api:local';
const operationsImage = process.argv[3] ?? 'spot-exchange-simulator-operations:local';
const loader = './apps/server/node_modules/tsx/dist/loader.mjs';
const network = `sandbox-runtime-${randomUUID().replaceAll('-', '')}`;
const containers: string[] = [];
let networkCreated = false;

async function docker(arguments_: string[], timeout = 30_000) {
  try {
    return (await execute('docker', arguments_, { timeout, maxBuffer: 65_536 })).stdout.trim();
  } catch {
    // Docker diagnostics and arguments can include generated connection secrets.
    throw new Error(
      'Runtime image verification command failed; container diagnostics are private.',
    );
  }
}

async function ready(probe: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(200);
  }
  throw new Error(message);
}

const inventory = `
  import assert from 'node:assert/strict';
  import { existsSync, readFileSync, realpathSync } from 'node:fs';
  const expected = JSON.parse(readFileSync('apps/server/package.json', 'utf8')).dependencies.tsx;
  assert.match(expected, /^\\d+\\.\\d+\\.\\d+$/, 'The runtime loader needs an exact version');
  const packagePath = 'apps/server/node_modules/tsx/package.json';
  assert.equal(JSON.parse(readFileSync(packagePath, 'utf8')).version, expected);
  assert.ok(realpathSync(packagePath).startsWith('/app/node_modules/.pnpm/'));
  assert.equal(existsSync('/usr/local/lib/node_modules/tsx'), false);
  assert.equal(existsSync('/usr/local/bin/tsx'), false);
  await import('./apps/server/src/operations/benchmark-process.ts');
`;

try {
  for (const image of [apiImage, operationsImage]) {
    await docker([
      'run',
      '--rm',
      '--entrypoint',
      'node',
      image,
      '--import',
      loader,
      '--input-type=module',
      '--eval',
      inventory,
    ]);
  }
  await docker(['network', 'create', network]);
  networkCreated = true;
  const databaseContainer = await docker([
    'run',
    '--detach',
    '--rm',
    '--network',
    network,
    '--network-alias',
    'postgres',
    '--env',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '--env',
    'POSTGRES_DB=exchange_runtime_test',
    'postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636',
  ]);
  containers.push(databaseContainer);
  await ready(async () => {
    try {
      // The image's initialization server only accepts Unix sockets. Waiting
      // for TCP avoids racing its shutdown before the final server starts.
      await docker(['exec', databaseContainer, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
      return true;
    } catch {
      return false;
    }
  }, 'The isolated runtime-verification database did not become ready.');

  const ownerUrl = 'postgresql://postgres@postgres:5432/exchange_runtime_test';
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = 'sandbox_app';
  runtimeUrl.password = randomBytes(24).toString('hex');
  await docker([
    'run',
    '--rm',
    '--network',
    network,
    '--env',
    `DATABASE_URL=${ownerUrl}`,
    '--env',
    `RUNTIME_DATABASE_URL=${runtimeUrl}`,
    '--entrypoint',
    'node',
    apiImage,
    '--import',
    loader,
    '--input-type=module',
    '--eval',
    `
      import { initializeOwner } from './apps/server/src/deploy/owner-initialization.ts';
      await initializeOwner(process.env.DATABASE_URL, new URL(process.env.RUNTIME_DATABASE_URL));
    `,
  ]);

  // Run the real production command against its restricted, migrated role.
  const apiContainer = await docker([
    'run',
    '--detach',
    '--rm',
    '--network',
    network,
    '--publish',
    '127.0.0.1::3001',
    '--env',
    `DATABASE_URL=${runtimeUrl}`,
    '--env',
    'API_ORIGIN=https://localhost',
    apiImage,
  ]);
  containers.push(apiContainer);
  const port = Number(
    (await docker(['port', apiContainer, '3001/tcp'])).match(/^127\.0\.0\.1:(\d+)$/)?.[1],
  );
  assert.ok(Number.isInteger(port) && port > 0, 'The temporary API port was not published.');
  await ready(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`, {
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok && (await response.json()).alive === true;
    } catch {
      return false;
    }
  }, 'The production API did not start with its locked loader and restricted role.');
  await docker(['stop', '--time', '20', apiContainer]);
  containers.splice(containers.indexOf(apiContainer), 1);

  // The operations image runs a TypeScript IPC child with the inherited loader.
  // This specifically catches loader resolution errors that a parent import misses.
  await docker([
    'run',
    '--rm',
    '--network',
    network,
    '--env',
    `TEST_DATABASE_URL=${ownerUrl}`,
    operationsImage,
    'scripts/deploy/verify-operations-worker.ts',
  ]);
  console.log(
    'Verified local locked loaders, owner migration, restricted production startup, and the operations IPC child.',
  );
} finally {
  for (const container of containers.reverse()) {
    await docker(['rm', '--force', container]);
  }
  if (networkCreated) await docker(['network', 'rm', network]);
}
