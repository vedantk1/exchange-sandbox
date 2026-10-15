import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareSelfHost } from '../../scripts/deploy/acceptance/configuration.js';

let directory: string;

beforeEach(async () => {
  await mkdir('.local', { recursive: true });
  directory = await mkdtemp('.local/self-host-configuration-test-');
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe('self-host preparation', () => {
  it('creates separate private credentials and literal Compose settings through the owner CLI', async () => {
    const target = `${directory}/installation with spaces`;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/deploy/prepare.ts',
        'https://localhost:9443',
        '--directory',
        target,
      ],
      { encoding: 'utf8', timeout: 5_000 },
    );
    expect(child.status).toBe(0);
    const environment = await readFile(`${target}/compose.env`, 'utf8');
    expect(environment).toContain('PUBLIC_ORIGIN=https://localhost:9443\n');
    expect(environment).toContain('HTTPS_PORT=9443\nHTTP_PORT=80\nBIND_HOST=0.0.0.0\n');
    expect(environment).toContain(`SELF_HOST_DIRECTORY=${JSON.stringify(target)}\n`);
    const owner = (await readFile(`${target}/secrets/owner-password`, 'utf8')).trim();
    const ownerUrl = new URL((await readFile(`${target}/secrets/owner-url`, 'utf8')).trim());
    const runtimeUrl = new URL((await readFile(`${target}/secrets/runtime-url`, 'utf8')).trim());
    expect(/^[0-9a-f]{64}$/.test(owner)).toBe(true);
    expect(ownerUrl.password === owner).toBe(true);
    expect(ownerUrl.username).toBe('sandbox_owner');
    expect(runtimeUrl.username).toBe('sandbox_app');
    expect(runtimeUrl.password !== owner && /^[0-9a-f]{64}$/.test(runtimeUrl.password)).toBe(true);
    expect(`${environment}${child.stdout}${child.stderr}`.includes(owner)).toBe(false);
    expect((await lstat(target)).mode & 0o777).toBe(0o700);
    expect((await lstat(`${target}/secrets`)).mode & 0o777).toBe(0o700);
    expect((await lstat(`${target}/compose.env`)).mode & 0o777).toBe(0o600);
    expect((await lstat(`${target}/secrets/owner-password`)).mode & 0o777).toBe(0o444);
  });

  it('rejects existing installation directories before changing any file or permissions', async () => {
    const target = `${directory}/existing`;
    await mkdir(target, { mode: 0o755 });
    await writeFile(`${target}/preserve`, 'existing configuration');
    await expect(prepareSelfHost('https://localhost', target)).rejects.toThrow();
    expect(await readFile(`${target}/preserve`, 'utf8')).toBe('existing configuration');
    expect((await lstat(target)).mode & 0o777).toBe(0o755);
    await expect(lstat(`${target}/secrets`)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('rejects symlink parents and symlink targets without following them', async () => {
    await mkdir(`${directory}/ordinary`);
    await symlink('ordinary', `${directory}/linked`);
    await expect(
      prepareSelfHost('https://localhost', `${directory}/linked/fresh`),
    ).rejects.toThrow();
    await expect(prepareSelfHost('https://localhost', `${directory}/linked`)).rejects.toThrow();
    await expect(lstat(`${directory}/ordinary/fresh`)).rejects.toHaveProperty('code', 'ENOENT');
    await expect(lstat(`${directory}/ordinary/secrets`)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it.each([
    ['http://localhost', 'fresh'],
    ['https://localhost/', 'fresh'],
    ['https://localhost/path', 'fresh'],
    ['https://private@localhost', 'fresh'],
    ['https://localhost', '../outside'],
    ['https://localhost', '/outside'],
    ['https://localhost', 'nested/../outside'],
    ['https://localhost', 'nested//fresh'],
    ['https://localhost', 'nested/./fresh'],
    ['https://localhost', 'nested/$PRIVATE'],
    ['https://localhost', 'nested/line\nbreak'],
    ['https://localhost', 'nested\\fresh'],
  ])('rejects ambiguous origin or directory before writing (%s, %s)', async (origin, relative) => {
    const target =
      relative.startsWith('/') || relative.startsWith('..') ? relative : `${directory}/${relative}`;
    await expect(prepareSelfHost(origin, target)).rejects.toThrow();
  });
});
