import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { readHttpsAsset, waitForHttpsAsset } from './asset-https.js';

const execute = promisify(execFile);
const image = process.argv[2] ?? 'spot-exchange-simulator-web:local';
let container: string | undefined;

async function docker(arguments_: string[]) {
  return (
    await execute('docker', arguments_, { timeout: 20_000, maxBuffer: 65_536 })
  ).stdout.trim();
}

async function certificate(): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return await docker([
        'exec',
        container!,
        'cat',
        '/data/caddy/pki/authorities/local/root.crt',
      ]);
    } catch {
      await delay(100);
    }
  }
  throw new Error('The temporary web proxy did not create its local authority.');
}

try {
  container = await docker([
    'run',
    '--detach',
    '--rm',
    '--publish',
    '127.0.0.1::443',
    '--env',
    'PUBLIC_HOST=localhost',
    '--env',
    'PUBLIC_ORIGIN=https://localhost',
    image,
  ]);
  assert.match(container, /^[a-f0-9]{64}$/, 'Docker did not return one container identity.');
  const port = Number(
    (await docker(['port', container, '443/tcp'])).match(/^127\.0\.0\.1:(\d+)$/)?.[1],
  );
  assert.ok(Number.isInteger(port) && port > 0, 'The temporary HTTPS port was not published.');
  const ca = await certificate();
  const index = await waitForHttpsAsset('/history', port, ca);
  assert.equal(index.status, 200, 'SPA deep links must return the entry document.');
  assert.match(index.type, /text\/html/);
  assert.equal(index.cache, 'no-cache');
  const assetPath = index.body.match(/src="(\/assets\/[^\"]+\.js)"/)?.[1];
  assert.ok(assetPath, 'The entry document did not reference a built JavaScript asset.');
  const asset = await readHttpsAsset(assetPath, port, ca);
  assert.equal(asset.status, 200);
  assert.match(asset.type, /(?:application|text)\/javascript/);
  assert.equal(asset.cache, 'public, max-age=31536000, immutable');
  assert.doesNotMatch(asset.body, /<!doctype html>/i);
  const missing = await readHttpsAsset('/assets/removed-deployment-chunk.js', port, ca);
  assert.equal(missing.status, 404, 'Missing chunks must never fall back to the entry document.');
  assert.doesNotMatch(missing.body, /<!doctype html>/i);
  assert.equal(missing.cache, 'no-store');
  console.log('Verified HTTPS deep links, built asset caching, and missing-chunk 404 recovery.');
} finally {
  if (container) await docker(['stop', '--time', '1', container]);
}
