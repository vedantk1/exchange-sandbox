import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { emptyCleanup, type CleanupEvidence, type DockerResource } from './report.js';

export const RUN_ROOT = '.local/self-host-acceptance';
export const OWNER_LABEL = 'io.spot-exchange.acceptance';
const PROJECT = /^sandbox-acceptance-([0-9a-f]{32})$/;
export interface RunManifest {
  version: 1;
  project: string;
  directory: string;
}
export type Execute = (
  arguments_: string[],
  timeout?: number,
  signal?: AbortSignal,
) => Promise<string>;
const executeFile = promisify(execFile);

/** Never forward ambient Compose/installation settings into the isolated test. */
export function acceptanceEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(?:COMPOSE_|PUBLIC_|DATABASE_URL|RUNTIME_DATABASE_URL|MIGRATION_LEGACY_BASELINE$|SELF_HOST_DIRECTORY$|API_IMAGE$|WEB_IMAGE$|OPERATIONS_IMAGE$|BIND_HOST$|HTTP_PORT$|HTTPS_PORT$)/.test(
          name,
        ),
    ),
  );
}

/** Output may contain secrets; callers receive only a fixed error code on failure. */
export const docker: Execute = async (arguments_, timeout = 45_000, signal) => {
  try {
    return (
      await executeFile('docker', arguments_, {
        env: acceptanceEnvironment(),
        timeout,
        maxBuffer: 2_000_000,
        ...(signal ? { signal } : {}),
      })
    ).stdout.trim();
  } catch {
    throw Object.assign(new Error('Acceptance Docker operation failed.'), {
      code: 'ACCEPTANCE_DOCKER_FAILED',
    });
  }
};

export function manifestFor(project: string): RunManifest {
  const match = PROJECT.exec(project);
  if (!match) throw new Error('Invalid acceptance project.');
  return { version: 1, project, directory: `${RUN_ROOT}/run-${match[1]}` };
}

/** Record ownership before configuration secrets or any Docker resources exist. */
export async function createRun(project: string): Promise<RunManifest> {
  const manifest = manifestFor(project);
  for (const directory of ['.local', RUN_ROOT]) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid acceptance parent.');
  }
  await mkdir(manifest.directory, { mode: 0o700 });
  try {
    await writeFile(`${manifest.directory}/run.json`, JSON.stringify(manifest), {
      mode: 0o600,
      flag: 'wx',
    });
    return manifest;
  } catch (error) {
    await rm(manifest.directory, { recursive: true, force: false });
    throw error;
  }
}

export function validateManifest(input: unknown, directory: string): RunManifest {
  const value = input as Partial<RunManifest> | null;
  if (!value || value.version !== 1 || typeof value.project !== 'string')
    throw new Error('Invalid acceptance manifest.');
  const expected = manifestFor(value.project);
  if (value.directory !== expected.directory || directory !== expected.directory)
    throw new Error('Invalid acceptance manifest path.');
  return expected;
}

export function composeArguments(manifest: RunManifest): string[] {
  validateManifest(manifest, manifest.directory);
  return [
    '--project-directory',
    resolve('.'),
    '-f',
    'compose.yaml',
    '-f',
    `${manifest.directory}/compose.override.json`,
    '--env-file',
    `${manifest.directory}/configuration/compose.env`,
    '--project-name',
    manifest.project,
  ];
}

export async function listResources(
  execute: Execute,
  kind: DockerResource,
  project: string,
): Promise<string[]> {
  if (!PROJECT.test(project)) throw new Error('Invalid acceptance project.');
  const command = kind === 'container' ? ['ps', '--all', '--quiet'] : [kind, 'ls', '--quiet'];
  const result = await execute([
    ...command,
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]);
  return result ? result.split(/\s+/) : [];
}

async function assertOwned(
  execute: Execute,
  kind: DockerResource,
  identifiers: string[],
  project: string,
): Promise<void> {
  if (!identifiers.length) return;
  const command = kind === 'container' ? ['inspect'] : [kind, 'inspect'];
  const objects = JSON.parse(await execute([...command, ...identifiers])) as Array<{
    Labels?: Record<string, string>;
    Config?: { Labels?: Record<string, string> };
  }>;
  if (
    objects.length !== identifiers.length ||
    objects.some((object) => (object.Config?.Labels ?? object.Labels)?.[OWNER_LABEL] !== project)
  )
    throw new Error('Refusing resources without the acceptance ownership label.');
}

async function safeDirectory(directory: string): Promise<void> {
  const components = directory.split('/');
  for (let index = 1; index <= components.length; index++) {
    const info = await lstat(components.slice(0, index).join('/'));
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Invalid acceptance directory.');
  }
}

/** Delete only exact resources discovered and verified by labels; never trust mutable Compose files. */
export async function cleanupRun(
  manifest: RunManifest,
  execute: Execute = docker,
): Promise<CleanupEvidence> {
  const result = emptyCleanup();
  const cleanupDeadline = AbortSignal.timeout(90_000);
  const boundedExecute: Execute = (args, timeout = 20_000) =>
    execute(args, Math.min(timeout, 20_000), cleanupDeadline);
  try {
    validateManifest(manifest, manifest.directory);
    await safeDirectory(manifest.directory);
    const kinds = ['container', 'volume', 'network'] as const;
    // Refuse the entire operation before deleting anything if even one resource
    // has the project label but not our independent ownership label.
    for (const kind of kinds)
      await assertOwned(
        boundedExecute,
        kind,
        await listResources(boundedExecute, kind, manifest.project),
        manifest.project,
      );
    for (const kind of kinds) {
      const identifiers = await listResources(boundedExecute, kind, manifest.project);
      await assertOwned(boundedExecute, kind, identifiers, manifest.project);
      if (identifiers.length) {
        const command = kind === 'container' ? ['rm', '--force'] : [kind, 'rm'];
        try {
          await boundedExecute([...command, ...identifiers], 20_000);
        } catch {
          // A lost CLI reply does not decide cleanup; inspect resources next.
        }
      }
    }
    result.containersRemoved =
      (await listResources(boundedExecute, 'container', manifest.project)).length === 0;
    result.volumesRemoved =
      (await listResources(boundedExecute, 'volume', manifest.project)).length === 0;
    result.networksRemoved =
      (await listResources(boundedExecute, 'network', manifest.project)).length === 0;
    if (result.containersRemoved && result.volumesRemoved && result.networksRemoved) {
      await rm(manifest.directory, { recursive: true, force: false });
      result.privateFilesRemoved = true;
    }
  } catch {
    // Retain private files when removal cannot be confirmed; cleanup can be retried.
  }
  return result;
}

/** Used by CI's always-run fallback after an interrupted verification process. */
export async function cleanupRecordedRuns(): Promise<boolean> {
  try {
    await safeDirectory(RUN_ROOT);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return true;
    return false;
  }
  let success = true;
  for (const name of await readdir(RUN_ROOT)) {
    if (!/^run-[0-9a-f]{32}$/.test(name)) continue;
    const directory = `${RUN_ROOT}/${name}`;
    try {
      await safeDirectory(directory);
      const marker = await lstat(`${directory}/run.json`);
      if (!marker.isFile() || marker.isSymbolicLink())
        throw new Error('Invalid acceptance marker.');
      const value = JSON.parse(await readFile(`${directory}/run.json`, 'utf8'));
      const result = await cleanupRun(validateManifest(value, directory));
      success &&= Object.values(result).every(Boolean);
    } catch {
      success = false;
    }
  }
  return success;
}
