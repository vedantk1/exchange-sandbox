import { describe, expect, it } from 'vitest';
import { formatLoginCheckpoint } from '../../scripts/deploy/acceptance/login.js';

describe('sanitized login checkpoint output', () => {
  it('copies only fixed categories and bounded counters without diagnostic payloads', () => {
    const secret = 'PRIVATE_CHECKPOINT_SENTINEL';
    const output = formatLoginCheckpoint({
      documentLoaded: true,
      scriptRequests: 1000,
      scriptResponses: 2,
      scriptHttpStatus: 503,
      scriptFailure: 'CERTIFICATE',
      session: 'FAILED',
      sessionFailure: 'HTTP2_PROTOCOL',
      pageErrors: 1,
      capabilities: 'AVAILABLE',
      url: secret,
      message: secret,
      body: secret,
      token: secret,
      error: new Error(secret),
    });
    expect(JSON.parse(output!)).toEqual({
      documentLoaded: true,
      scriptRequests: 255,
      scriptResponses: 2,
      scriptHttpStatus: 503,
      scriptFailure: 'CERTIFICATE',
      session: 'FAILED',
      sessionFailure: 'HTTP2_PROTOCOL',
      pageErrors: 1,
      capabilities: 'AVAILABLE',
    });
    expect(output).not.toContain(secret);
  });

  it('replaces invalid runtime fields without echoing unknown error categories', () => {
    const secret = 'PRIVATE_CHECKPOINT_SENTINEL';
    const output = formatLoginCheckpoint({
      documentLoaded: secret,
      scriptRequests: Infinity,
      scriptResponses: -1,
      scriptHttpStatus: 999,
      scriptFailure: secret,
      session: secret,
      sessionFailure: secret,
      pageErrors: '8',
      capabilities: secret,
    });
    expect(JSON.parse(output!)).toEqual({
      documentLoaded: false,
      scriptRequests: 0,
      scriptResponses: 0,
      scriptHttpStatus: null,
      scriptFailure: null,
      session: 'NOT_REQUESTED',
      sessionFailure: null,
      pageErrors: 0,
      capabilities: 'UNAVAILABLE',
    });
    expect(output).not.toContain(secret);
  });

  it('omits absent or getter-backed invalid inputs without propagating failures', () => {
    expect(formatLoginCheckpoint(undefined)).toBeUndefined();
    expect(formatLoginCheckpoint('PRIVATE_CHECKPOINT_SENTINEL')).toBeUndefined();
    expect(
      formatLoginCheckpoint(
        Object.defineProperty({}, 'documentLoaded', {
          get() {
            throw new Error('PRIVATE_CHECKPOINT_SENTINEL');
          },
        }),
      ),
    ).toBeUndefined();
  });
});
