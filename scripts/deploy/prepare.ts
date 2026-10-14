import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises';

try {
  const raw = process.argv[2];
  if (!raw || process.argv.length !== 3)
    throw new Error('Use selfhost:prepare with the exact HTTPS origin.');
  const origin = new URL(raw);
  if (origin.protocol !== 'https:' || origin.origin !== raw || origin.username || origin.password)
    throw new Error('Supply an HTTPS origin with no credentials, path, or trailing slash.');
  const directory = '.local/self-host';
  await mkdir(`${directory}/secrets`, { recursive: true, mode: 0o700 });
  for (const path of [directory, `${directory}/secrets`]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid secret directory.');
    await chmod(path, 0o700);
  }
  const owner = randomBytes(32).toString('hex');
  const runtime = randomBytes(32).toString('hex');
  const values = {
    'owner-password': owner,
    'owner-url': `postgresql://sandbox_owner:${owner}@postgres:5432/exchange`,
    'runtime-url': `postgresql://sandbox_app:${runtime}@postgres:5432/exchange`,
  };
  for (const [name, value] of Object.entries(values))
    // The enclosing 0700 directory protects host access. Read-only secret mounts
    // must also be readable by the container's unprivileged application user.
    await writeFile(`${directory}/secrets/${name}`, `${value}\n`, { flag: 'wx', mode: 0o444 });
  await writeFile(
    `${directory}/compose.env`,
    [
      `PUBLIC_ORIGIN=${raw}`,
      `PUBLIC_HOST=${origin.hostname}`,
      `HTTPS_PORT=${origin.port || '443'}`,
      'HTTP_PORT=80',
      'BIND_HOST=0.0.0.0',
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Generated private self-host configuration. No default administrator was created.');
  console.log(
    'Use docker compose --env-file .local/self-host/compose.env for owner-controlled startup.',
  );
} catch {
  console.error(
    'Self-host preparation failed. Supply an exact HTTPS origin and a fresh .local/self-host directory; existing secrets were preserved.',
  );
  process.exitCode = 1;
}
