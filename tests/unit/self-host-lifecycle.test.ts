import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceptanceEnvironment,
  cleanupRun,
  manifestFor,
  OWNER_LABEL,
  RUN_ROOT,
  type Execute,
  type RunManifest,
} from '../../scripts/deploy/acceptance/lifecycle.js';
import { emptyCleanup, type DockerResource } from '../../scripts/deploy/acceptance/report.js';

const fixtures: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of fixtures.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(): Promise<RunManifest> {
  const manifest = manifestFor(`sandbox-acceptance-${randomUUID().replaceAll('-', '')}`);
  await mkdir(RUN_ROOT, { recursive: true });
  await mkdir(manifest.directory, { mode: 0o700 });
  fixtures.push(manifest.directory);
  await writeFile(`${manifest.directory}/run.json`, JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(`${manifest.directory}/private-marker`, 'Preserve until removal is verified.', {
    mode: 0o600,
  });
  return manifest;
}

type Inventory = Record<DockerResource, string[]>;

function fakeDocker(
  manifest: RunManifest,
  options: {
    foreignKind?: DockerResource;
    leftoverKind?: DockerResource;
    failedBeforeInventory?: DockerResource;
    failedAfterInventory?: DockerResource;
    lostRemovalReply?: boolean;
    failedRemoval?: DockerResource;
  } = {},
) {
  const calls: string[][] = [];
  const markerVisible: boolean[] = [];
  const inventory: Inventory = {
    container: ['generated-container'],
    volume: ['generated-volume'],
    network: ['generated-network'],
  };
  let removing = false;
  const execute: Execute = async (arguments_) => {
    calls.push(arguments_);
    expect(arguments_[0]).not.toBe('compose');
    const kind: DockerResource =
      arguments_[0] === 'ps' || arguments_[0] === 'inspect' || arguments_[0] === 'rm'
        ? 'container'
        : (arguments_[0] as DockerResource);
    if (arguments_.includes('rm')) {
      removing = true;
      expect(arguments_.at(-1)).toBe(`generated-${kind}`);
      if (options.failedRemoval === kind) throw new Error('Private Docker diagnostic is omitted.');
      if (options.leftoverKind !== kind) inventory[kind] = [];
      if (options.lostRemovalReply) throw new Error('Private Docker diagnostic is omitted.');
      return '';
    }
    if (arguments_.includes('inspect')) {
      const labels = {
        [OWNER_LABEL]: options.foreignKind === kind ? 'different-project' : manifest.project,
      };
      return JSON.stringify([
        kind === 'container' ? { Config: { Labels: labels } } : { Labels: labels },
      ]);
    }
    expect(arguments_).toContain(`label=com.docker.compose.project=${manifest.project}`);
    if (
      (!removing && options.failedBeforeInventory === kind) ||
      (removing && options.failedAfterInventory === kind)
    )
      throw new Error('Private Docker diagnostic is omitted.');
    if (removing) {
      markerVisible.push(
        (await readFile(`${manifest.directory}/private-marker`, 'utf8')).length > 0,
      );
    }
    return inventory[kind].join('\n');
  };
  return { execute, calls, markerVisible };
}

describe('isolated self-host lifecycle', () => {
  it.each(['container', 'volume', 'network'] as const)(
    'refuses every mutation when a %s does not have the independent ownership label',
    async (foreignKind) => {
      const manifest = await fixture();
      const docker = fakeDocker(manifest, { foreignKind });
      expect(await cleanupRun(manifest, docker.execute)).toEqual(emptyCleanup());
      expect(docker.calls.some((arguments_) => arguments_.includes('rm'))).toBe(false);
      expect(await readFile(`${manifest.directory}/private-marker`, 'utf8')).toContain('Preserve');
    },
  );

  it.each(['container', 'volume', 'network'] as const)(
    'retains private files and reports a leftover %s after removal',
    async (leftoverKind) => {
      const manifest = await fixture();
      const docker = fakeDocker(manifest, { leftoverKind });
      const result = await cleanupRun(manifest, docker.execute);
      expect(result).toEqual({
        containersRemoved: leftoverKind !== 'container',
        volumesRemoved: leftoverKind !== 'volume',
        networksRemoved: leftoverKind !== 'network',
        privateFilesRemoved: false,
      });
      expect(await readFile(`${manifest.directory}/private-marker`, 'utf8')).toContain('Preserve');
    },
  );

  it('retains private files when the initial Docker inventory is unavailable', async () => {
    const manifest = await fixture();
    const docker = fakeDocker(manifest, { failedBeforeInventory: 'network' });
    expect(await cleanupRun(manifest, docker.execute)).toEqual(emptyCleanup());
    expect(docker.calls.some((arguments_) => arguments_.includes('rm'))).toBe(false);
    expect(await readFile(`${manifest.directory}/private-marker`, 'utf8')).toContain('Preserve');
  });

  it('does not claim full cleanup when the verification inventory fails', async () => {
    const manifest = await fixture();
    const docker = fakeDocker(manifest, { failedAfterInventory: 'volume' });
    const result = await cleanupRun(manifest, docker.execute);
    expect(result.volumesRemoved).toBe(false);
    expect(result.privateFilesRemoved).toBe(false);
    expect(await readFile(`${manifest.directory}/private-marker`, 'utf8')).toContain('Preserve');
  });

  it.each([false, true])(
    'removes private files only after all resource inventories confirm removal (lost removal reply: %s)',
    async (lostRemovalReply) => {
      const manifest = await fixture();
      const docker = fakeDocker(manifest, { lostRemovalReply });
      expect(await cleanupRun(manifest, docker.execute)).toEqual({
        containersRemoved: true,
        volumesRemoved: true,
        networksRemoved: true,
        privateFilesRemoved: true,
      });
      expect(docker.markerVisible.length).toBeGreaterThanOrEqual(3);
      expect(docker.markerVisible.every(Boolean)).toBe(true);
      await expect(lstat(manifest.directory)).rejects.toHaveProperty('code', 'ENOENT');
    },
  );

  it('retains private files and reports a failed resource removal', async () => {
    const manifest = await fixture();
    const docker = fakeDocker(manifest, { failedRemoval: 'volume' });
    const result = await cleanupRun(manifest, docker.execute);
    expect(result.volumesRemoved).toBe(false);
    expect(result.privateFilesRemoved).toBe(false);
    expect(await readFile(`${manifest.directory}/private-marker`, 'utf8')).toContain('Preserve');
  });

  it('does not interpret mutable Compose files when deleting label-verified resources', async () => {
    const manifest = await fixture();
    await writeFile(
      `${manifest.directory}/compose.override.json`,
      JSON.stringify({ volumes: { postgres_data: { name: 'unrelated-existing-volume' } } }),
    );
    await writeFile(
      `${manifest.directory}/compose.env`,
      'COMPOSE_PROJECT_NAME=ordinary-installation\n',
    );
    const docker = fakeDocker(manifest);
    expect((await cleanupRun(manifest, docker.execute)).privateFilesRemoved).toBe(true);
    const removalCalls = docker.calls.filter((arguments_) => arguments_.includes('rm'));
    expect(removalCalls).toHaveLength(3);
    expect(JSON.stringify(removalCalls)).not.toContain('unrelated-existing-volume');
    expect(JSON.stringify(removalCalls)).not.toContain('ordinary-installation');
  });

  it.each(['project', 'directory', 'version'])(
    'refuses malformed %s before calling Docker',
    async (field) => {
      const manifest = await fixture();
      const invalid = {
        ...manifest,
        [field]:
          field === 'project'
            ? 'ordinary-installation'
            : field === 'directory'
              ? `${manifest.directory}/../outside`
              : 2,
      } as RunManifest;
      const execute = vi.fn<Execute>();
      expect(await cleanupRun(invalid, execute)).toEqual(emptyCleanup());
      expect(execute).not.toHaveBeenCalled();
      expect(await readFile(`${manifest.directory}/private-marker`, 'utf8')).toContain('Preserve');
    },
  );

  it('refuses a symlinked run directory before calling Docker', async () => {
    const ordinary = await fixture();
    const linked = manifestFor(`sandbox-acceptance-${randomUUID().replaceAll('-', '')}`);
    fixtures.push(linked.directory);
    await symlink(ordinary.directory.split('/').at(-1)!, linked.directory);
    const execute = vi.fn<Execute>();
    expect(await cleanupRun(linked, execute)).toEqual(emptyCleanup());
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(`${ordinary.directory}/private-marker`, 'utf8')).toContain('Preserve');
  });

  it('removes ambient installation overrides from every acceptance and cleanup child environment', () => {
    const overrides = [
      'COMPOSE_FILE',
      'COMPOSE_PROJECT_NAME',
      'COMPOSE_PROFILES',
      'COMPOSE_ENV_FILES',
      'PUBLIC_ORIGIN',
      'PUBLIC_HOST',
      'DATABASE_URL',
      'DATABASE_URL_FILE',
      'RUNTIME_DATABASE_URL',
      'RUNTIME_DATABASE_URL_FILE',
      'MIGRATION_LEGACY_BASELINE',
      'SELF_HOST_DIRECTORY',
      'API_IMAGE',
      'WEB_IMAGE',
      'OPERATIONS_IMAGE',
      'BIND_HOST',
      'HTTP_PORT',
      'HTTPS_PORT',
    ];
    for (const name of overrides) vi.stubEnv(name, 'PRIVATE_OVERRIDE_SENTINEL');
    vi.stubEnv('PATH', '/supported/tooling');
    vi.stubEnv('DOCKER_HOST', 'unix:///supported/docker.sock');
    const environment = acceptanceEnvironment();
    for (const name of overrides) expect(environment).not.toHaveProperty(name);
    expect(environment.PATH).toBe('/supported/tooling');
    expect(environment.DOCKER_HOST).toBe('unix:///supported/docker.sock');
    expect(JSON.stringify(environment)).not.toContain('PRIVATE_OVERRIDE_SENTINEL');
  });
});
