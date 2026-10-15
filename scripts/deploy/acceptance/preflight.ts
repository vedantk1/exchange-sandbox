import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const SOURCE_COMMAND_TIMEOUT_MS = 5_000;

type SourceCommand = (
  executable: 'git',
  arguments_: string[],
  options: {
    signal: AbortSignal;
    timeout: number;
    killSignal: 'SIGKILL';
    encoding: 'utf8';
    maxBuffer: number;
  },
) => Promise<{ stdout: string }>;

const execute = promisify(execFile);

/** Source inspection participates in the same abort budget as Docker and browser work. */
export async function acceptanceSource(
  signal: AbortSignal,
  command: SourceCommand = execute,
): Promise<{ commit: string; dirty: boolean }> {
  signal.throwIfAborted();
  const options = {
    signal,
    timeout: SOURCE_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL' as const,
    encoding: 'utf8' as const,
    maxBuffer: 1_000_000,
  };
  const commit = (await command('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
  signal.throwIfAborted();
  const dirty =
    (
      await command(
        'git',
        ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal'],
        options,
      )
    ).stdout.trim() !== '';
  signal.throwIfAborted();
  return { commit, dirty };
}
