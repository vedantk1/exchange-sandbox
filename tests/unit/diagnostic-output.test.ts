import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createDiagnosticOutput } from '../../apps/server/src/diagnostic-output.js';
import { Diagnostics, type DiagnosticRecord } from '../../apps/server/src/diagnostics.js';

const record: DiagnosticRecord = Object.freeze({
  type: 'diagnostic',
  event: 'request.completed',
  occurredAt: '2026-01-01T00:00:00.000Z',
  outcome: 'ok',
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('bounded diagnostic stream output', () => {
  it('bounds real Writable backpressure without queuing retries', async () => {
    const callbacks: Array<(error?: Error | null) => void> = [];
    const chunks: Buffer[] = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callbacks.push(callback);
      },
    });
    const bytes = Buffer.byteLength(`${JSON.stringify(record)}\n`);
    const output = createDiagnosticOutput(stream, bytes * 2);
    const first = output.write(record);
    const second = output.write(record);
    expect(output.write(record)).toBe(false);
    expect(stream.writableLength).toBe(bytes * 2);
    callbacks.shift()!();
    await turn();
    callbacks.shift()!();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(chunks).toHaveLength(2);
    output.close();
    stream.destroy();
    await turn();
  });

  it('settles synchronous stream write errors without throwing or ending the stream', async () => {
    const stream = new Writable({
      write() {
        throw new Error('PRIVATE_WRITE_ERROR');
      },
    });
    const output = createDiagnosticOutput(stream);
    await expect(output.write(record)).resolves.toBe(false);
    expect(output.write(record)).toBe(false);
    expect(stream.writableEnded).toBe(false);
    output.close();
    stream.destroy();
    await turn();
  });

  it('consumes emitted asynchronous errors and counts a failed registry write once', async () => {
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        setImmediate(() => callback(new Error('PRIVATE_ASYNC_ERROR')));
      },
    });
    const output = createDiagnosticOutput(stream);
    const diagnostics = new Diagnostics({ sink: output.write });
    expect(
      diagnostics.run({}, () => {
        diagnostics.event('command.completed', { outcome: 'accepted' });
        return 'business result';
      }),
    ).toBe('business result');
    await turn();
    await turn();
    expect(diagnostics.snapshot().gauges['diagnostics.dropped_events']).toBe(1);
    expect(diagnostics.snapshot().events['command.completed']).toBe(1);
    expect(chunks).toHaveLength(1);
    expect(Buffer.concat(chunks).toString('utf8')).not.toContain('PRIVATE_ASYNC_ERROR');
    expect(stream.listenerCount('error')).toBe(0);
    output.close();
  });

  it('closes only the adapter and guards errors from already accepted writes', async () => {
    let complete!: (error?: Error | null) => void;
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        complete = callback;
      },
    });
    const output = createDiagnosticOutput(stream);
    const accepted = output.write(record);
    output.close();
    output.close();
    await expect(accepted).resolves.toBe(false);
    expect(output.write(record)).toBe(false);
    expect(stream.destroyed).toBe(false);
    expect(stream.writableEnded).toBe(false);
    expect(stream.listenerCount('error')).toBe(1);
    complete(new Error('PRIVATE_LATE_ERROR'));
    await turn();
    await turn();
    expect(stream.listenerCount('error')).toBe(0);
  });

  it('copies only registry fields and safely declines serialization failures or unavailable streams', async () => {
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    const output = createDiagnosticOutput(stream);
    const extra = Object.freeze({
      ...record,
      payload: 'PRIVATE_PAYLOAD',
      error: new Error('PRIVATE_ERROR'),
    });
    await expect(output.write(extra)).resolves.toBe(true);
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(record);
    const malformed = Object.defineProperty({ ...record }, 'sequence', {
      get() {
        throw new Error('PRIVATE_SERIALIZE_ERROR');
      },
    });
    expect(output.write(malformed)).toBe(false);
    expect(chunks).toHaveLength(1);
    output.close();
    stream.destroy();
    await turn();
    const unavailable = createDiagnosticOutput(stream);
    expect(unavailable.write(record)).toBe(false);
    unavailable.close();
  });
});
