import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TLSSocket } from 'node:tls';
import { promisify } from 'node:util';
import { MIGRATIONS } from '../../packages/database/src/migration-registry.js';
import { prepareSelfHost } from './acceptance/configuration.js';
import { runOperatorSetup, OperatorSetupError } from './acceptance/operator.js';
import { runJourney, AcceptanceJourneyError } from './acceptance/journey.js';
import {
  acceptanceEnvironment,
  cleanupRecordedRuns,
  cleanupRun,
  createRun,
  composeArguments,
  docker,
  listResources,
  OWNER_LABEL,
  type RunManifest,
} from './acceptance/lifecycle.js';
import {
  acceptanceReport,
  emptyCleanup,
  type AcceptanceStage,
  type ImageEvidence,
} from './acceptance/report.js';

const execute = promisify(execFile);
const postgresImage =
  'postgres:18.4@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636';
const loader = './apps/server/node_modules/tsx/dist/loader.mjs';
const reportPath = '.local/operations/self-host-acceptance-result.json';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function bounded<T>(
  probe: () => Promise<T>,
  signal: AbortSignal,
  milliseconds = 30_000,
): Promise<T> {
  const deadline = Date.now() + milliseconds;
  while (true) {
    signal.throwIfAborted();
    try {
      return await probe();
    } catch {
      if (signal.aborted || Date.now() >= deadline)
        throw new Error('Acceptance readiness deadline expired.');
      await delay(200, undefined, { signal });
    }
  }
}

/** Validate the generated CA and hostname before authorizing this leaf key in isolated Chromium. */
async function verifiedIdentity(origin: string, ca: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      `${origin}/health/ready`,
      {
        ca,
        rejectUnauthorized: true,
        family: 4,
        agent: false,
        signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
      },
      (incoming) => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 1024) outgoing.destroy(new Error('Unexpected readiness response.'));
        });
        incoming.once('error', reject);
        const socket = incoming.socket as TLSSocket;
        const certificate = socket.getPeerCertificate().raw;
        const authorized = socket.authorized;
        incoming.once('end', () => {
          try {
            assert.equal(incoming.statusCode, 200);
            assert.equal(JSON.parse(body).ready, true);
            assert.equal(authorized, true);
            assert.ok(certificate);
            const key = new X509Certificate(certificate).publicKey.export({
              type: 'spki',
              format: 'der',
            });
            resolve(createHash('sha256').update(key).digest('base64'));
          } catch {
            reject(new Error('Acceptance HTTPS identity verification failed.'));
          }
        });
      },
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}

async function imageEvidence(image: string, signal: AbortSignal): Promise<ImageEvidence> {
  const [value] = JSON.parse(await docker(['image', 'inspect', image], 30_000, signal));
  assert.match(value.Id, /^sha256:[0-9a-f]{64}$/);
  const revision = value.Config?.Labels?.['org.opencontainers.image.revision'];
  return {
    id: value.Id,
    revision: typeof revision === 'string' && /^[0-9a-f]{40}$/.test(revision) ? revision : null,
  };
}

async function saveReport(report: ReturnType<typeof acceptanceReport>) {
  for (const directory of ['.local', '.local/operations']) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
  }
  const temporary = `${reportPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, reportPath);
}

const runtimeProbe = `
  import { createRequire } from 'node:module';
  import { configuredDatabaseUrl } from './apps/server/src/config/database-url.ts';
  const require = createRequire(new URL('./apps/server/package.json', import.meta.url));
  const { Client } = require('pg');
  const connection = new Client({ connectionString: await configuredDatabaseUrl(), connectionTimeoutMillis:5000, statement_timeout:5000 });
  try {
    await connection.connect();
    const result = await connection.query(\`SELECT
      current_user = 'sandbox_app' AS expected_role,
      NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolbypassrls AS restricted_role,
      NOT has_schema_privilege(current_user, 'public', 'CREATE') AS no_ddl,
      NOT has_table_privilege(current_user, 'schema_migrations', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN') AS metadata_read_only,
      NOT has_column_privilege(current_user, 'orders', 'quantity', 'UPDATE') AS accepted_terms_protected,
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM schema_migrations) AS migrations
      FROM pg_roles r WHERE r.rolname=current_user\`);
    console.log(JSON.stringify({ ...result.rows[0], production:process.env.NODE_ENV === 'production', unprivileged:process.getuid() !== 0 }));
  } finally { await connection.end(); }
`;

async function main(): Promise<void> {
  if (process.argv[2] === '--cleanup') {
    assert.equal(process.argv.length, 3);
    const cleaned = await cleanupRecordedRuns();
    console.log(
      cleaned
        ? 'Self-host acceptance cleanup verified.'
        : 'Self-host acceptance cleanup could not be confirmed.',
    );
    process.exitCode = cleaned ? 0 : 1;
    return;
  }
  const apiImage = process.argv[2] ?? 'spot-exchange-simulator-api:local';
  const webImage = process.argv[3] ?? 'spot-exchange-simulator-web:local';
  const controller = new AbortController();
  const signal = controller.signal;
  const canceled = () => controller.abort();
  const deadline = setTimeout(canceled, 8 * 60_000);
  process.once('SIGINT', canceled);
  process.once('SIGTERM', canceled);
  let stage: AcceptanceStage = 'preflight';
  const enterStage = (next: AcceptanceStage) => {
    stage = next;
    console.log(`Self-host acceptance phase: ${next}.`);
  };
  let completed = false;
  let manifest: RunManifest | undefined;
  let cleanup = emptyCleanup();
  const source = { commit: '', dirty: true };
  const images: Partial<Record<'api' | 'web' | 'postgres', ImageEvidence>> = {};
  const checks: Record<string, boolean> = {};
  try {
    // Debugging transports can emit credentials, request bodies or TLS keys.
    // Reject them before creating any credentials or launching browser traffic.
    for (const name of ['DEBUG', 'PWDEBUG', 'NODE_DEBUG', 'SSLKEYLOGFILE', 'TLSKEYLOGFILE'])
      assert.equal(Boolean(process.env[name]), false);
    assert.ok(process.argv.length <= 4);
    for (const image of [apiImage, webImage])
      assert.match(image, /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,250}$/);
    source.commit = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
    source.dirty =
      (
        await execute('git', ['status', '--porcelain', '--untracked-files=normal'])
      ).stdout.trim() !== '';
    assert.match(source.commit, /^[0-9a-f]{40}$/);
    if (process.env.CI) assert.equal(source.dirty, false);
    images.api = await imageEvidence(apiImage, signal);
    images.web = await imageEvidence(webImage, signal);
    await docker(['pull', postgresImage], 120_000, signal);
    images.postgres = await imageEvidence(postgresImage, signal);
    assert.equal(images.api.revision, source.commit);
    assert.equal(images.web.revision, source.commit);
    const project = `sandbox-acceptance-${randomUUID().replaceAll('-', '')}`;
    for (const kind of ['container', 'volume', 'network'] as const)
      assert.equal((await listResources(docker, kind, project)).length, 0);
    const httpsPort = await availablePort();
    let httpPort = await availablePort();
    while (httpPort === httpsPort) httpPort = await availablePort();
    const origin = `https://localhost:${httpsPort}`;
    enterStage('prepare');
    manifest = await createRun(project);
    signal.throwIfAborted();
    const configuration = await prepareSelfHost(origin, `${manifest.directory}/configuration`);
    const environmentFile = configuration.environmentFile;
    const environment = (await readFile(environmentFile, 'utf8'))
      .replace('HTTP_PORT=80', `HTTP_PORT=${httpPort}`)
      .replace('BIND_HOST=0.0.0.0', 'BIND_HOST=127.0.0.1');
    await writeFile(environmentFile, environment, { mode: 0o600 });
    await mkdir(`${manifest.directory}/operations`, { mode: 0o700 });
    const labels = { [OWNER_LABEL]: project };
    const override = {
      services: {
        migrate: { image: apiImage, labels },
        api: { image: apiImage, labels },
        web: { image: webImage, labels },
        postgres: { labels },
        operator: { image: apiImage, labels },
        operations: {
          labels,
          volumes: [`${manifest.directory}/operations:/app/.local/operations`],
        },
      },
      networks: { default: { labels } },
      volumes: Object.fromEntries(
        ['postgres_data', 'history_exports', 'caddy_data', 'caddy_config'].map((name) => [
          name,
          { labels },
        ]),
      ),
    };
    await writeFile(`${manifest.directory}/compose.override.json`, JSON.stringify(override), {
      mode: 0o600,
      flag: 'wx',
    });
    const args = composeArguments(manifest);
    const compose = (arguments_: string[], timeout = 45_000) =>
      docker(['compose', ...args, ...arguments_], timeout, signal);
    const config = JSON.parse(await compose(['config', '--format', 'json']));
    for (const value of Object.values(config.secrets) as { file: string }[])
      assert.ok(value.file.startsWith(`${resolve(configuration.directory)}/secrets/`));
    assert.equal(config.services.api.environment.API_ORIGIN, origin);
    assert.deepEqual(
      config.services.api.secrets.map((item: { source: string }) => item.source),
      ['runtime_database_url'],
    );
    for (const service of Object.values(config.services) as {
      volumes?: { type: string; source: string }[];
    }[])
      for (const volume of service.volumes ?? [])
        if (volume.type === 'bind')
          assert.ok(volume.source.startsWith(`${resolve(manifest.directory)}/`));
    for (const volume of Object.values(config.volumes) as { name: string; external?: boolean }[]) {
      assert.equal(volume.external ?? false, false);
      assert.ok(volume.name.startsWith(`${project}_`));
    }
    enterStage('migrate');
    await compose(['up', '--detach', '--wait', 'postgres'], 120_000);
    await compose(['run', '--rm', '-T', 'migrate'], 120_000);
    checks.supportedOwnerInitialization = true;
    const before = JSON.parse(
      await compose([
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '--entrypoint',
        'node',
        'operator',
        '--import',
        loader,
        '--input-type=module',
        '--eval',
        runtimeProbe,
      ]),
    );
    assert.equal(before.users, 0);
    assert.equal(before.migrations, MIGRATIONS.length);
    checks.freshInstallation = true;
    enterStage('bootstrap');
    const password = `acceptance-${randomBytes(24).toString('hex')}`;
    await runOperatorSetup({
      composeArguments: args,
      handle: 'acceptance_admin',
      password,
      environment: acceptanceEnvironment(),
      signal,
    });
    checks.interactiveAdministratorSetup = true;
    enterStage('startup');
    await compose(['up', '--detach', '--wait', 'api', 'web'], 120_000);
    const apiId = await compose(['ps', '--quiet', 'api']);
    const webId = await compose(['ps', '--quiet', 'web']);
    const postgresId = await compose(['ps', '--quiet', 'postgres']);
    const actual = JSON.parse(await docker(['inspect', apiId, webId, postgresId], 30_000, signal));
    assert.deepEqual(
      actual.map((value: { Image: string }) => value.Image),
      [images.api.id, images.web.id, images.postgres.id],
    );
    assert.equal(actual[0].HostConfig.ReadonlyRootfs, true);
    assert.ok(actual[0].HostConfig.Memory > 0 && actual[0].HostConfig.NanoCpus > 0);
    checks.runningImageIdentity = true;
    const probe = JSON.parse(
      await compose([
        'exec',
        '-T',
        'api',
        'node',
        '--import',
        loader,
        '--input-type=module',
        '--eval',
        runtimeProbe,
      ]),
    );
    for (const field of [
      'expected_role',
      'restricted_role',
      'no_ddl',
      'metadata_read_only',
      'accepted_terms_protected',
      'production',
      'unprivileged',
    ])
      assert.equal(probe[field], true);
    assert.equal(probe.users, 1);
    checks.restrictedRuntime = true;
    enterStage('https');
    const ca = await bounded(
      () => compose(['exec', '-T', 'web', 'cat', '/data/caddy/pki/authorities/local/root.crt']),
      signal,
    );
    const certificatePin = await bounded(() => verifiedIdentity(origin, ca, signal), signal);
    checks.httpsIdentityVerified = true;
    enterStage('journey');
    const result = await runJourney({
      origin,
      ca,
      certificatePin,
      password,
      signal,
      restartApi: async () => {
        await compose(['restart', '--timeout', '30', 'api'], 90_000);
        await bounded(() => verifiedIdentity(origin, ca, signal), signal);
        const restarted = JSON.parse(await docker(['inspect', apiId], 30_000, signal));
        assert.equal(restarted[0].Image, images.api!.id);
      },
    });
    Object.assign(checks, result);
    signal.throwIfAborted();
    completed = true;
  } catch (error) {
    // Only fixed codes and numeric progress are safe to print, never transcripts or causes.
    const code =
      error instanceof OperatorSetupError
        ? ` (${error.code}; prompt ${error.promptIndex}; exit ${error.exitStatus ?? 'unknown'})`
        : error instanceof AcceptanceJourneyError
          ? ` (${error.code})`
          : '';
    console.error(`Self-host acceptance failed at ${stage}${code}. See the sanitized report.`);
  } finally {
    clearTimeout(deadline);
    const failureStage = stage;
    enterStage('cleanup');
    if (manifest) cleanup = await cleanupRun(manifest);
    const report = acceptanceReport({
      stage: completed
        ? Object.values(cleanup).every(Boolean)
          ? 'complete'
          : 'cleanup'
        : failureStage,
      source,
      images,
      checks,
      cleanup,
    });
    await saveReport(report);
    process.exitCode = report.status === 'passed' ? 0 : 1;
    console.log(
      `Self-host acceptance ${report.status}; sanitized report: ${reportPath}. Cleanup ${Object.values(cleanup).every(Boolean) ? 'verified' : 'not confirmed'}.`,
    );
    process.off('SIGINT', canceled);
    process.off('SIGTERM', canceled);
  }
}

await main().catch(() => {
  console.error(
    'Self-host acceptance could not finish safely. Run the scoped cleanup command and inspect its sanitized report.',
  );
  process.exitCode = 1;
});
