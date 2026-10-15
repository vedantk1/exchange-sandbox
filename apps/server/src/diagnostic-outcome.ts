import type { DiagnosticOutcome } from './diagnostics.js';
import { DomainError } from '@sandbox/domain';

/** Classify known failures without retaining errors, SQL or caller-supplied text. */
export function diagnosticOutcome(error: unknown): DiagnosticOutcome {
  if (error instanceof DomainError) return 'rejected';
  const detail = error as { code?: unknown; statusCode?: unknown } | null;
  switch (detail?.code) {
    case '55P03':
      return 'lock_timeout';
    case '57014':
    case '25P03':
    case '25P04':
    case 'DATABASE_TIMEOUT':
    case 'ADMISSION_EXPIRED':
      return 'timeout';
    case 'ADMISSION_BUSY':
    case 'AUTH_BUSY':
    case 'STREAM_LIMIT':
    case 'EXPORT_BUSY':
    case 'EXPORT_DOWNLOAD_LIMIT':
      return 'busy';
    case 'REQUEST_ABORTED':
    case 'EXPORT_ABORTED':
      return 'aborted';
    case 'WRITER_UNAVAILABLE':
    case 'RECOVERY_REQUIRED':
      return 'unavailable';
    case 'COMMAND_CONFLICT':
      return 'conflict';
  }
  if (typeof detail?.statusCode === 'number') {
    if (detail.statusCode === 409) return 'conflict';
    if (detail.statusCode === 429) return 'busy';
    if (detail.statusCode >= 400 && detail.statusCode < 500) return 'rejected';
    if (detail.statusCode === 503) return 'unavailable';
  }
  return 'error';
}
