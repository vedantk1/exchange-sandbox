import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

export interface AssetResponse {
  status: number;
  type: string;
  cache: string;
  advertisesHttp3: boolean;
  body: string;
}

/** Retain only protocol presence, never an advertised host, port or raw header. */
function advertisesHttp3(value: string | string[] | undefined): boolean {
  const header = Array.isArray(value) ? value.join(',') : (value ?? '');
  return /(?:^|,)\s*h3(?:-\d+)?\s*=/i.test(header);
}

class AssetTransportError extends Error {
  constructor(
    cause: unknown,
    readonly responseStarted: boolean,
  ) {
    super('The HTTPS asset request failed.', { cause });
  }
}

/** The generated local CA and localhost hostname remain mandatory on every request. */
export async function readHttpsAsset(
  path: string,
  port: number,
  ca: string,
  signal: AbortSignal = AbortSignal.timeout(5_000),
): Promise<AssetResponse> {
  let responseStarted = false;
  try {
    return await new Promise<AssetResponse>((resolve, reject) => {
      const outgoing = request(
        {
          hostname: 'localhost',
          family: 4,
          port,
          path,
          ca,
          rejectUnauthorized: true,
          agent: false,
          signal,
        },
        (incoming) => {
          responseStarted = true;
          let body = '';
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk: string) => {
            body += chunk;
            if (body.length > 1_000_000) outgoing.destroy(new Error('Unexpected response size.'));
          });
          incoming.once('error', reject);
          incoming.once('aborted', () =>
            reject(new Error('The HTTPS asset response was interrupted.')),
          );
          incoming.once('end', () =>
            resolve({
              status: incoming.statusCode ?? 0,
              type: incoming.headers['content-type'] ?? '',
              cache: incoming.headers['cache-control'] ?? '',
              advertisesHttp3: advertisesHttp3(incoming.headers['alt-svc']),
              body,
            }),
          );
        },
      );
      outgoing.once('error', reject);
      outgoing.end();
    });
  } catch (error) {
    throw new AssetTransportError(error, responseStarted);
  }
}

function transientStartupError(error: unknown): boolean {
  if (!(error instanceof AssetTransportError) || error.responseStarted) return false;
  const cause = error.cause as NodeJS.ErrnoException | undefined;
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(cause?.code ?? '')) return true;
  // Caddy can expose its generated CA before it finishes issuing the leaf
  // certificate. Retry this startup alert, never arbitrary protocol/TLS errors.
  return cause?.code === 'EPROTO' && /tlsv1 alert internal error/i.test(cause.message ?? '');
}

/** Return the first HTTP response unchanged; status/content assertions belong to the caller. */
export async function waitForHttpsAsset(
  path: string,
  port: number,
  ca: string,
  options: { timeoutMs?: number; attemptMs?: number; retryMs?: number } = {},
): Promise<AssetResponse> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const attemptMs = options.attemptMs ?? 2_000;
  const retryMs = options.retryMs ?? 100;
  if ([timeoutMs, attemptMs, retryMs].some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('HTTPS startup budgets must be positive integers.');
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    while (!deadline.signal.aborted) {
      const attempt = new AbortController();
      const attemptTimer = setTimeout(() => attempt.abort(), attemptMs);
      try {
        return await readHttpsAsset(
          path,
          port,
          ca,
          AbortSignal.any([deadline.signal, attempt.signal]),
        );
      } catch (error) {
        const responseStarted = error instanceof AssetTransportError && error.responseStarted;
        const attemptExpired =
          attempt.signal.aborted &&
          error instanceof AssetTransportError &&
          (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ABORT_ERR';
        if (responseStarted || (!transientStartupError(error) && !attemptExpired)) throw error;
      } finally {
        clearTimeout(attemptTimer);
      }
      await delay(retryMs, undefined, { signal: deadline.signal });
    }
  } catch (error) {
    if (!deadline.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
  }
  throw new Error('The temporary HTTPS proxy did not become ready before its deadline.');
}
