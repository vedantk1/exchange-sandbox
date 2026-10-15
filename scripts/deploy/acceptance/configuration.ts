import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface SelfHostConfiguration {
  directory: string;
  environmentFile: string;
}

function relativeDirectory(directory: string): string[] {
  // This is also written into Compose's dotenv file. Keep it relative and
  // literal so neither path traversal nor dotenv interpolation can change it.
  if (
    !directory ||
    isAbsolute(directory) ||
    /[\\\u0000-\u001f\u007f$#"']/u.test(directory) ||
    directory.trim() !== directory
  )
    throw new Error('Use a literal workspace-relative configuration directory.');
  const parts = directory.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error('Use a normalized workspace-relative configuration directory.');
  return parts;
}

/** The ordinary owner setup path, also used by isolated acceptance installations. */
export async function prepareSelfHost(
  rawOrigin: string,
  directory = '.local/self-host',
): Promise<SelfHostConfiguration> {
  const origin = new URL(rawOrigin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== rawOrigin ||
    origin.username ||
    origin.password
  )
    throw new Error('Supply an exact HTTPS origin without credentials or a path.');
  const parts = relativeDirectory(directory);
  let parent = '.';
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    try {
      await mkdir(parent, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Configuration parents must be ordinary directories.');
  }
  // Exclusive creation rejects existing installations before generating a
  // secret or changing permissions. Never repair or replace an existing tree.
  await mkdir(directory, { mode: 0o700 });
  try {
    await mkdir(`${directory}/secrets`, { mode: 0o700 });
    const owner = randomBytes(32).toString('hex');
    const runtime = randomBytes(32).toString('hex');
    const values = {
      'owner-password': owner,
      'owner-url': `postgresql://sandbox_owner:${owner}@postgres:5432/exchange`,
      'runtime-url': `postgresql://sandbox_app:${runtime}@postgres:5432/exchange`,
    };
    for (const [name, value] of Object.entries(values))
      // A private parent prevents host access; unprivileged container users must
      // be able to read Docker's mounted secret files without owning them.
      await writeFile(`${directory}/secrets/${name}`, `${value}\n`, { flag: 'wx', mode: 0o444 });
    const environmentFile = `${directory}/compose.env`;
    await writeFile(
      environmentFile,
      [
        `PUBLIC_ORIGIN=${rawOrigin}`,
        `PUBLIC_HOST=${origin.hostname}`,
        `HTTPS_PORT=${origin.port || '443'}`,
        'HTTP_PORT=80',
        'BIND_HOST=0.0.0.0',
        `SELF_HOST_DIRECTORY=${JSON.stringify(directory)}`,
        '',
      ].join('\n'),
      { flag: 'wx', mode: 0o600 },
    );
    return { directory, environmentFile };
  } catch {
    try {
      // Exclusive creation above establishes ownership of this fresh tree.
      // Existing configuration trees never enter this cleanup path.
      await rm(directory, { recursive: true, force: true });
    } catch {
      throw new Error('Self-host preparation failed; its new private directory needs cleanup.');
    }
    throw new Error('Self-host preparation failed; its new private directory was removed.');
  }
}
