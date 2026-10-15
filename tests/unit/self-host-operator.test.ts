import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperatorSetupError, runOperatorSetup } from '../../scripts/deploy/acceptance/operator.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

class Terminal extends EventEmitter {
  pid = 424242;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
  answers: string[] = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.answers.push(chunk.toString('utf8')));
  }
}

const password = 'in-memory-test-password';
const options = {
  composeArguments: ['--env-file', '.local/private configuration/compose.env', '-p', 'isolated'],
  handle: 'acceptance_operator',
  password,
  environment: { PATH: '/test/bin' },
};
let terminal: Terminal;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  terminal = new Terminal();
  vi.mocked(spawn).mockReturnValue(terminal as unknown as ReturnType<typeof spawn>);
  vi.spyOn(process, 'kill').mockReturnValue(true);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('self-host operator terminal', () => {
  it.each(['darwin', 'linux'])(
    'supplies credentials only after each real prompt on %s',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      const pending = runOperatorSetup(options);
      expect(terminal.answers).toEqual([]);
      const invocation = vi.mocked(spawn).mock.calls[0]!;
      expect(invocation[0]).toBe('python3');
      expect(JSON.stringify(invocation).includes(password)).toBe(false);
      expect(invocation[2]).toEqual({
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: options.environment,
      });
      expect(invocation[1]).toEqual([
        'scripts/deploy/acceptance/operator-pty.py',
        'docker',
        'compose',
        ...options.composeArguments,
        'run',
        '--rm',
        'operator',
        'setup',
      ]);
      terminal.stdout.write('Administrator han');
      expect(terminal.answers).toEqual([]);
      terminal.stdout.write('dle: ');
      expect(terminal.answers).toEqual(['acceptance_operator\n']);
      const secondPrompt = Buffer.from('New password (12–128 characters, hidden): ');
      const dash = secondPrompt.indexOf(Buffer.from('–'));
      terminal.stdout.write(secondPrompt.subarray(0, dash + 1));
      expect(terminal.answers).toEqual(['acceptance_operator\n']);
      terminal.stdout.write(secondPrompt.subarray(dash + 1));
      expect(terminal.answers).toEqual(['acceptance_operator\n', `${password}\n`]);
      terminal.stdout.write('Confirm password (hidden): ');
      expect(terminal.answers).toEqual(['acceptance_operator\n', `${password}\n`, `${password}\n`]);
      terminal.stdout.write(
        'Administrator created. The exchange is paused; sign in to invite traders.\r\n',
      );
      terminal.emit('close', 0);
      await pending;
      expect(process.kill).not.toHaveBeenCalled();
    },
  );

  it('requires explicit administrator creation rather than trusting the terminal exit status', async () => {
    const pending = runOperatorSetup(options);
    const assertion = expect(pending).rejects.toThrow('did not confirm administrator creation');
    terminal.stderr.write(`Private diagnostic ${password}`);
    terminal.emit('close', 0);
    await assertion;
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('passes path metacharacters as literal argv without invoking a shell', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const pending = runOperatorSetup({
      ...options,
      composeArguments: ['--env-file', "private 'quoted' $(ignored).env"],
    });
    const assertion = expect(pending).rejects.toThrow('did not confirm administrator creation');
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual([
      'scripts/deploy/acceptance/operator-pty.py',
      'docker',
      'compose',
      '--env-file',
      "private 'quoted' $(ignored).env",
      'run',
      '--rm',
      'operator',
      'setup',
    ]);
    terminal.emit('close', 1);
    await assertion;
  });

  it('exposes only fixed diagnostics with prompt progress and a bounded numeric exit status', async () => {
    const pending = runOperatorSetup(options);
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'OperatorSetupError',
      code: 'OPERATOR_CREATION_UNCONFIRMED',
      promptIndex: 1,
      exitStatus: 1,
    });
    terminal.stdout.write('Administrator handle: ');
    terminal.stderr.write(`Private diagnostic ${password}`);
    terminal.emit('close', 1);
    await assertion;
    expect(
      JSON.stringify(new OperatorSetupError('OPERATOR_CREATION_UNCONFIRMED', 1, 999)),
    ).not.toContain(password);
    expect(new OperatorSetupError('OPERATOR_CREATION_UNCONFIRMED', 1, 999).exitStatus).toBeNull();
  });

  it('bounds stalled prompts and terminates the transport before returning a sanitized error', async () => {
    vi.useFakeTimers();
    const pending = runOperatorSetup(options);
    const assertion = expect(pending).rejects.toThrow('exceeded its terminal deadline');
    terminal.stderr.write(`Private diagnostic ${password}`);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(process.kill).toHaveBeenCalledWith(-terminal.pid, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(process.kill).toHaveBeenCalledWith(-terminal.pid, 'SIGKILL');
    terminal.emit('close', null);
    await assertion;
  });

  it('terminates an aborted terminal and does not submit further input', async () => {
    const controller = new AbortController();
    const pending = runOperatorSetup({ ...options, signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow('was canceled');
    controller.abort();
    terminal.stdout.write('Administrator handle: ');
    terminal.emit('close', null);
    await assertion;
    expect(terminal.answers).toEqual([]);
    expect(process.kill).toHaveBeenCalledWith(-terminal.pid, 'SIGTERM');
  });

  it('rejects control characters and already-aborted runs before creating a terminal', async () => {
    await expect(runOperatorSetup({ ...options, password: `${password}\n` })).rejects.toThrow(
      'supported terminal input',
    );
    await expect(runOperatorSetup({ ...options, signal: AbortSignal.abort() })).rejects.toThrow(
      'was canceled',
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
