import { describe, expect, it } from 'vitest';
import { DomainError } from '../../packages/domain/src/index.js';
import { diagnosticOutcome } from '../../apps/server/src/diagnostic-outcome.js';

describe('operational outcome classification', () => {
  it('separates business rejections, resource limits and unavailable infrastructure', () => {
    expect(diagnosticOutcome(new DomainError('INVALID_PRICE', 'private input'))).toBe('rejected');
    for (const code of ['57014', '25P03', '25P04', 'DATABASE_TIMEOUT', 'ADMISSION_EXPIRED'])
      expect(diagnosticOutcome({ code })).toBe('timeout');
    expect(diagnosticOutcome({ code: '55P03' })).toBe('lock_timeout');
    for (const code of [
      'ADMISSION_BUSY',
      'AUTH_BUSY',
      'STREAM_LIMIT',
      'EXPORT_BUSY',
      'EXPORT_DOWNLOAD_LIMIT',
    ])
      expect(diagnosticOutcome({ code })).toBe('busy');
    for (const code of ['REQUEST_ABORTED', 'EXPORT_ABORTED'])
      expect(diagnosticOutcome({ code })).toBe('aborted');
    for (const code of ['WRITER_UNAVAILABLE', 'RECOVERY_REQUIRED'])
      expect(diagnosticOutcome({ code })).toBe('unavailable');
    expect(diagnosticOutcome({ code: 'COMMAND_CONFLICT' })).toBe('conflict');
  });

  it('reduces HTTP status and unknown failures to fixed categories without retaining details', () => {
    expect(diagnosticOutcome({ statusCode: 401 })).toBe('rejected');
    expect(diagnosticOutcome({ statusCode: 409 })).toBe('conflict');
    expect(diagnosticOutcome({ statusCode: 429 })).toBe('busy');
    expect(diagnosticOutcome({ statusCode: 503 })).toBe('unavailable');
    expect(diagnosticOutcome(new Error('private query or payload'))).toBe('error');
    expect(diagnosticOutcome(null)).toBe('error');
  });
});
