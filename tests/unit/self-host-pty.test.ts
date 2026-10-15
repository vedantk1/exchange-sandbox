import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const helper = 'scripts/deploy/acceptance/operator-pty.py';

describe('self-host operator PTY bridge', () => {
  it('gives the command a real terminal when its own parent uses ordinary pipes', async () => {
    const result = await execute(
      'python3',
      [
        helper,
        process.execPath,
        '--input-type=module',
        '--eval',
        'console.log(JSON.stringify({ input: process.stdin.isTTY, output: process.stdout.isTTY, error: process.stderr.isTTY }));',
      ],
      { timeout: 5_000, maxBuffer: 8_192 },
    );
    expect(JSON.parse(result.stdout.trim())).toEqual({ input: true, output: true, error: true });
    expect(result.stderr).toBe('');
  });

  it('preserves a nonzero command exit status without printing command details', async () => {
    try {
      await execute('python3', [helper, process.execPath, '--eval', 'process.exit(7)'], {
        timeout: 5_000,
        maxBuffer: 8_192,
      });
      throw new Error('The probe command unexpectedly passed.');
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      expect(failure.code).toBe(7);
      expect(failure.stdout).toBe('');
      expect(failure.stderr).toBe('');
    }
  });

  it.each(['signal', 'input EOF'])(
    'bounds transport and child cleanup after parent %s, even when the child ignores SIGTERM',
    async (cause) => {
      const transport = spawn('python3', [
        helper,
        process.execPath,
        '--eval',
        'process.on("SIGTERM", () => {}); console.log(JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000);',
      ]);
      let childPid: number | undefined;
      let output = '';
      try {
        const closed = new Promise<number | null>((resolve, reject) => {
          transport.once('close', resolve);
          transport.once('error', reject);
        });
        const started = new Promise<void>((resolve) => {
          transport.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8');
            if (output.includes('\n')) {
              childPid = (JSON.parse(output.trim()) as { pid: number }).pid;
              resolve();
            }
          });
        });
        const deadline = new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('PTY cleanup probe timed out.')), 3_000);
          timer.unref();
        });
        await Promise.race([started, deadline]);
        if (cause === 'signal') transport.kill('SIGTERM');
        else transport.stdin.end();
        expect(await Promise.race([closed, deadline])).not.toBe(0);
        let alive = true;
        try {
          process.kill(childPid!, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
          else throw error;
        }
        expect(alive).toBe(false);
      } finally {
        transport.kill('SIGKILL');
        if (childPid) {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            // The successful probe already reaped this generated child.
          }
        }
      }
    },
  );
});
