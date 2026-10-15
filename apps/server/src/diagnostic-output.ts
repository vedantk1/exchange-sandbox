import type { Writable } from 'node:stream';
import type { DiagnosticRecord } from './diagnostics.js';

interface PendingWrite {
  bytes: number;
  resolve: (accepted: boolean) => void;
}

export interface DiagnosticOutput {
  write(record: DiagnosticRecord): Promise<boolean> | false;
  close(): void;
}

/**
 * Writes already sanitized registry records to a shared byte stream. Admission
 * bounds serialized pending bytes; it never waits for drain or queues retries.
 * Closing this adapter does not end or destroy the shared stream. Its passive
 * error guard remains until the stream closes, covering delayed write errors.
 */
export function createDiagnosticOutput(
  stream: Writable,
  maxBufferedBytes = 65_536,
): DiagnosticOutput {
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
    throw new Error('Diagnostic output byte limit must be a positive safe integer');
  }

  let closed = false;
  let pendingBytes = 0;
  const pending = new Set<PendingWrite>();

  function settle(entry: PendingWrite, accepted: boolean) {
    if (!pending.delete(entry)) return;
    pendingBytes -= entry.bytes;
    entry.resolve(accepted);
  }

  function stop(): void {
    closed = true;
    for (const entry of pending) settle(entry, false);
  }

  function streamClosed(): void {
    stop();
    stream.off('error', stop);
    stream.off('close', streamClosed);
  }

  if (!stream.closed) {
    stream.on('error', stop);
    stream.on('close', streamClosed);
  }

  return {
    write(record) {
      if (closed || stream.destroyed || stream.closed || !stream.writable || stream.writableEnded) {
        return false;
      }
      let line: Buffer;
      try {
        // The registry validates values. This copy additionally ensures callers
        // cannot accidentally append payload, credential, SQL, or error fields.
        const safe: DiagnosticRecord = {
          type: record.type,
          event: record.event,
          occurredAt: record.occurredAt,
        };
        for (const field of [
          'requestId',
          'commandId',
          'sessionId',
          'sequence',
          'operation',
          'outcome',
          'statusCode',
        ] as const) {
          const value = record[field];
          if (value !== undefined) Object.assign(safe, { [field]: value });
        }
        line = Buffer.from(`${JSON.stringify(safe)}\n`, 'utf8');
      } catch {
        return false;
      }
      if (Math.max(pendingBytes, stream.writableLength) + line.byteLength > maxBufferedBytes) {
        return false;
      }
      return new Promise<boolean>((resolve) => {
        const entry = { bytes: line.byteLength, resolve };
        pending.add(entry);
        pendingBytes += entry.bytes;
        try {
          stream.write(line, (error) => {
            if (error) stop();
            else settle(entry, !closed);
          });
        } catch {
          stop();
        }
      });
    },
    close: stop,
  };
}
