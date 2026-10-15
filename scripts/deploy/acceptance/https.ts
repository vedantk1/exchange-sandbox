import { request, type RequestOptions } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

interface Credentials {
  cookie: string;
  csrf: string;
}

export interface HttpsResponse {
  status: number;
  headers: IncomingHttpHeaders;
  bytes: Buffer;
}

/** Acceptance traffic trusts only this installation's generated CA and the URL hostname. */
export class TrustedHttps {
  constructor(
    readonly origin: string,
    readonly ca: string,
    private readonly credentials: () => Promise<Credentials>,
    private readonly signal?: AbortSignal,
  ) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
      throw new Error('ACCEPTANCE_HTTPS_REQUIRED');
  }

  private url(path: string): URL {
    const url = new URL(path, this.origin);
    if (!path.startsWith('/') || url.origin !== this.origin)
      throw new Error('ACCEPTANCE_SAME_ORIGIN_REQUIRED');
    return url;
  }

  private async options(method: string, csrf: boolean): Promise<RequestOptions> {
    const credentials = await this.credentials();
    return {
      method,
      family: 4,
      ca: this.ca,
      rejectUnauthorized: true,
      headers: {
        cookie: credentials.cookie,
        origin: this.origin,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...(csrf ? { 'x-csrf-token': credentials.csrf } : {}),
      },
    };
  }

  async response(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    csrf = true,
  ): Promise<HttpsResponse> {
    const url = this.url(path);
    const options = await this.options(method, csrf);
    return new Promise((resolve, reject) => {
      const deadline = AbortSignal.timeout(15_000);
      const outgoing = request(url, {
        ...options,
        signal: this.signal ? AbortSignal.any([this.signal, deadline]) : deadline,
      });
      outgoing.once('error', reject);
      outgoing.once('response', (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          // This scenario has two orders. A large response indicates unexpected scope or traffic.
          if (size > 1024 * 1024) {
            outgoing.destroy(new Error('ACCEPTANCE_RESPONSE_LIMIT'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            bytes: Buffer.concat(chunks),
          }),
        );
      });
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  async json<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
    const response = await this.response(method, path, body);
    if (response.status !== 200) throw new Error('ACCEPTANCE_HTTP_STATUS');
    return JSON.parse(response.bytes.toString('utf8')) as T;
  }

  async events(
    path: string,
  ): Promise<{ wait: (event: string) => Promise<void>; close: () => void }> {
    const url = this.url(path);
    const options = await this.options('GET', false);
    const outgoing = request(url, { ...options, ...(this.signal ? { signal: this.signal } : {}) });
    let failed = false;
    const seen = new Set<string>();
    // No frames or payloads leave this helper: only evidence that named frames arrived.
    outgoing.on('error', () => {
      failed = true;
    });
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        outgoing.destroy();
        reject(new Error('ACCEPTANCE_SSE_TIMEOUT'));
      }, 10_000);
      outgoing.once('response', (incoming) => {
        // The global deadline can abort between this callback and the awaiting microtask.
        // Install the stream error handler before exposing the response.
        incoming.on('error', () => {
          failed = true;
        });
        clearTimeout(timer);
        resolve(incoming);
      });
      outgoing.once('error', () => {
        clearTimeout(timer);
        reject(new Error('ACCEPTANCE_SSE_FAILED'));
      });
      outgoing.end();
    });
    if (
      response.statusCode !== 200 ||
      !response.headers['content-type']?.startsWith('text/event-stream')
    ) {
      outgoing.destroy();
      throw new Error('ACCEPTANCE_SSE_STATUS');
    }
    let pending = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      pending += chunk;
      if (pending.length > 16_384) {
        failed = true;
        outgoing.destroy();
        return;
      }
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const event = /^event: ([a-z-]+)$/m.exec(frame)?.[1];
        try {
          if (!event || !['ready', 'invalidate', 'heartbeat'].includes(event)) throw new Error();
          const data = JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? '') as Record<
            string,
            unknown
          >;
          if (
            Object.keys(data).sort().join(',') !== 'cursor,sessionId' ||
            data.sessionId !== url.searchParams.get('sessionId') ||
            typeof data.cursor !== 'string' ||
            !/^(0|[1-9][0-9]*)$/.test(data.cursor) ||
            BigInt(data.cursor) < BigInt(url.searchParams.get('cursor') ?? '0') ||
            (event === 'invalidate' && data.cursor === url.searchParams.get('cursor'))
          )
            throw new Error();
          seen.add(event);
        } catch {
          failed = true;
          outgoing.destroy();
        }
      }
    });
    response.on('end', () => {
      failed = true;
    });
    return {
      wait: async (event) => {
        const deadline = Date.now() + 12_000;
        while (!seen.has(event)) {
          if (failed || Date.now() > deadline) throw new Error('ACCEPTANCE_SSE_EVENT_MISSING');
          await delay(25);
        }
      },
      close: () => outgoing.destroy(),
    };
  }
}
