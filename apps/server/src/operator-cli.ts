import { AuthError, AuthService } from './auth/index.js';
import { Exchange, WriterUnavailableError } from './exchange.js';

class PromptCanceled extends Error {}

/** A local TTY is required: passwords never enter argv, environment, or terminal echo. */
async function prompt(label: string, secret: boolean): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Run this command in an interactive local terminal.');
  process.stdout.write(label);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.off('data', read);
      process.stdin.off('end', ended);
      process.off('SIGINT', interrupted);
      process.off('SIGTERM', interrupted);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const ended = () => finish(new PromptCanceled());
    const interrupted = () => finish(new PromptCanceled());
    const read = (chunk: string) => {
      // Ignore terminal escape sequences instead of interpreting them as input.
      if (chunk.includes('\u001b')) return;
      for (const character of chunk) {
        if (character === '\u0003' || character === '\u0004') {
          finish(new PromptCanceled());
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u0015') {
          if (!secret) process.stdout.write('\b \b'.repeat([...value].length));
          value = '';
        } else if (character === '\u007f' || character === '\b') {
          const characters = [...value];
          if (characters.length) {
            characters.pop();
            value = characters.join('');
            if (!secret) process.stdout.write('\b \b');
          }
        } else if (character >= ' ' && value.length < 1024) {
          value += character;
          if (!secret) process.stdout.write(character);
        }
      }
    };
    process.stdin.on('data', read);
    process.stdin.once('end', ended);
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
  });
}

let exchange: Exchange | undefined;
try {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || (mode !== 'setup' && mode !== 'reset'))
    throw new Error('Use the setup or reset command without credential arguments.');
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('An interactive local terminal is required.');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  // Acquire singleton ownership before collecting credentials, so an active
  // server produces an immediate stop-first explanation.
  exchange = await Exchange.open(databaseUrl, { allowFaultedStartup: true });
  const auth = new AuthService(exchange);
  const handle = mode === 'setup' ? await prompt('Administrator handle: ', false) : undefined;
  const password = await prompt('New password (12–128 characters, hidden): ', true);
  const confirmation = await prompt('Confirm password (hidden): ', true);
  if (password !== confirmation)
    throw new AuthError('PASSWORD_MISMATCH', 'Passwords did not match.');
  if (mode === 'setup') {
    await auth.bootstrapAdmin({ handle: handle!, password });
    console.log('Administrator created. The exchange is paused; sign in to invite traders.');
  } else {
    await auth.resetAdminPassword({ password });
    console.log('Administrator password changed. Previous administrator sessions are revoked.');
  }
} catch (error) {
  process.exitCode = error instanceof PromptCanceled ? 130 : 1;
  if (error instanceof PromptCanceled)
    console.error('Canceled; no credential change was submitted.');
  else if (error instanceof WriterUnavailableError)
    console.error('Stop the running exchange server before administrator setup or recovery.');
  else if (error instanceof AuthError) console.error(`${error.code}: ${error.message}`);
  else
    console.error(
      'Operator command failed. Use a local interactive terminal and check database availability.',
    );
} finally {
  try {
    await exchange?.close();
  } catch {
    console.error('Database shutdown could not be confirmed.');
    process.exitCode = 1;
  }
}
