import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import {
  acceptanceSource,
  SOURCE_COMMAND_TIMEOUT_MS,
} from '../../scripts/deploy/acceptance/preflight.js';

type SourceCommand = NonNullable<Parameters<typeof acceptanceSource>[1]>;
const execute = promisify(execFile);

it('reads source identity with a shared cancellation signal and finite command limits', async () => {
  const signal = new AbortController().signal;
  const command = vi
    .fn<SourceCommand>()
    .mockResolvedValueOnce({ stdout: `${'a'.repeat(40)}\n` })
    .mockResolvedValueOnce({ stdout: ' M README.md\n' });
  await expect(acceptanceSource(signal, command)).resolves.toEqual({
    commit: 'a'.repeat(40),
    dirty: true,
  });
  expect(command.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ['git', ['rev-parse', 'HEAD']],
    ['git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal']],
  ]);
  for (const call of command.mock.calls)
    expect(call[2]).toEqual({
      signal,
      timeout: SOURCE_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      maxBuffer: 1_000_000,
    });
});

it('does not inspect source or continue to another command after cancellation', async () => {
  const command = vi.fn<SourceCommand>();
  await expect(acceptanceSource(AbortSignal.abort(), command)).rejects.toThrow();
  expect(command).not.toHaveBeenCalled();
  const controller = new AbortController();
  command.mockImplementationOnce(async () => {
    controller.abort();
    return { stdout: 'a'.repeat(40) };
  });
  await expect(acceptanceSource(controller.signal, command)).rejects.toThrow();
  expect(command).toHaveBeenCalledTimes(1);
});

it('interrupts a real blocked preflight child instead of waiting for its command timeout', async () => {
  const signal = AbortSignal.timeout(50);
  const command = vi.fn<SourceCommand>((_file, _arguments, options) =>
    execute(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      options,
    ),
  );
  await expect(acceptanceSource(signal, command)).rejects.toMatchObject({ code: 'ABORT_ERR' });
  expect(command).toHaveBeenCalledTimes(1);
});

it('terminates a real hung preflight child at the five-second command limit', async () => {
  const command = vi.fn<SourceCommand>((_file, _arguments, options) =>
    execute(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      options,
    ),
  );
  await expect(acceptanceSource(new AbortController().signal, command)).rejects.toMatchObject({
    killed: true,
    signal: 'SIGKILL',
  });
  expect(command).toHaveBeenCalledTimes(1);
}, 10_000);
