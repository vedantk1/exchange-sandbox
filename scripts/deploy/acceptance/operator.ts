import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const prompts = [
  'Administrator handle: ',
  'New password (12–128 characters, hidden): ',
  'Confirm password (hidden): ',
];
const success = 'Administrator created. The exchange is paused; sign in to invite traders.';

const failures = {
  OPERATOR_INPUT_INVALID: 'Self-host operator setup requires supported terminal input.',
  OPERATOR_CANCELED: 'Self-host operator setup was canceled.',
  OPERATOR_TERMINAL_START_FAILED: 'Self-host operator terminal could not start.',
  OPERATOR_TERMINAL_INPUT_FAILED: 'Self-host operator terminal input failed.',
  OPERATOR_TERMINAL_TIMEOUT: 'Self-host operator setup exceeded its terminal deadline.',
  OPERATOR_CREATION_UNCONFIRMED: 'Self-host operator setup did not confirm administrator creation.',
} as const;

export class OperatorSetupError extends Error {
  readonly exitStatus: number | null;

  constructor(
    readonly code: keyof typeof failures,
    readonly promptIndex: number,
    exitStatus: number | null = null,
  ) {
    super(failures[code]);
    this.name = 'OperatorSetupError';
    this.exitStatus =
      exitStatus !== null && Number.isInteger(exitStatus) && exitStatus >= 0 && exitStatus <= 255
        ? exitStatus
        : null;
  }
}

export interface OperatorSetupOptions {
  /** Arguments following `docker compose`; the helper appends `run --rm operator setup`. */
  composeArguments: string[];
  handle: string;
  password: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** Feed the supported owner command through a real terminal, retaining no transcript. */
export async function runOperatorSetup({
  composeArguments,
  handle,
  password,
  environment,
  signal,
}: OperatorSetupOptions): Promise<void> {
  if (
    !['linux', 'darwin'].includes(process.platform) ||
    !/^[a-zA-Z][a-zA-Z0-9_]{2,31}$/.test(handle) ||
    [...password].length < 12 ||
    [...password].length > 128 ||
    Buffer.byteLength(password, 'utf8') > 512 ||
    /[\u0000-\u001f\u007f]/u.test(password)
  )
    throw new OperatorSetupError('OPERATOR_INPUT_INVALID', 0);
  if (signal?.aborted) throw new OperatorSetupError('OPERATOR_CANCELED', 0);
  const command = ['docker', 'compose', ...composeArguments, 'run', '--rm', 'operator', 'setup'];
  const arguments_ = ['scripts/deploy/acceptance/operator-pty.py', ...command];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('python3', arguments_, {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(environment ? { env: environment } : {}),
    });
    const answers = [handle, password, password];
    let transcript = '';
    let promptIndex = 0;
    let confirmed = false;
    let settled = false;
    let closed = false;
    let failure: OperatorSetupError | undefined;
    let stopped = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (stopped || closed) return;
      stopped = true;
      const terminate = (kind: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          // Stop the transport group; final project cleanup also checks for
          // one-off containers if Docker disconnected its terminal session.
          process.kill(-child.pid, kind);
        } catch {
          child.kill(kind);
        }
      };
      terminate('SIGTERM');
      forceTimer = setTimeout(() => terminate('SIGKILL'), 1_000);
      forceTimer.unref();
      // Resolve failure only after transport closure, or after a final bounded
      // kill attempt. Project cleanup can then remove any one-off container.
      cleanupTimer = setTimeout(() => complete(failure), 2_000);
      cleanupTimer.unref();
    };
    const complete = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', canceled);
      if (error) reject(error);
      else resolve();
    };
    const fail = (error: OperatorSetupError) => {
      if (settled || failure) return;
      failure = error;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', canceled);
      if (closed) complete(error);
      else stop();
    };
    const canceled = () => fail(new OperatorSetupError('OPERATOR_CANCELED', promptIndex));
    const timeout = setTimeout(
      () => fail(new OperatorSetupError('OPERATOR_TERMINAL_TIMEOUT', promptIndex)),
      45_000,
    );
    timeout.unref();
    signal?.addEventListener('abort', canceled, { once: true });
    if (signal?.aborted) canceled();
    const read = (chunk: string) => {
      if (settled || failure) return;
      // Transport output may contain private values. It is never logged or
      // exposed in errors, and only a bounded rolling prompt window is kept.
      transcript = (transcript + chunk).slice(-8_192);
      const prompt = prompts[promptIndex];
      if (prompt && transcript.includes(prompt)) {
        transcript = transcript.slice(transcript.indexOf(prompt) + prompt.length);
        try {
          child.stdin.write(`${answers[promptIndex]}\n`);
        } catch {
          fail(new OperatorSetupError('OPERATOR_TERMINAL_INPUT_FAILED', promptIndex));
          return;
        }
        promptIndex += 1;
      }
      if (promptIndex === prompts.length && transcript.includes(success)) confirmed = true;
    };
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream.on('data', (chunk: Buffer) => read(decoder.write(chunk)));
    }
    child.stdin.on('error', () =>
      fail(new OperatorSetupError('OPERATOR_TERMINAL_INPUT_FAILED', promptIndex)),
    );
    child.once('error', () =>
      fail(new OperatorSetupError('OPERATOR_TERMINAL_START_FAILED', promptIndex)),
    );
    child.once('close', (code) => {
      closed = true;
      if (failure) complete(failure);
      else if (code === 0 && confirmed) complete();
      else fail(new OperatorSetupError('OPERATOR_CREATION_UNCONFIRMED', promptIndex, code));
    });
  });
}
