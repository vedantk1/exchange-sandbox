import { describe, expect, it } from 'vitest';
import {
  Diagnostics,
  type DiagnosticEvent,
  type DiagnosticFields,
  type DiagnosticGauge,
  type DiagnosticOutcome,
  type DiagnosticRecord,
  type DiagnosticTiming,
} from '../../apps/server/src/diagnostics.js';

const requestA = '11111111-1111-4111-8111-111111111111';
const requestB = '22222222-2222-4222-8222-222222222222';
const commandId = '33333333-3333-4333-8333-333333333333';
const sessionId = '44444444-4444-4444-8444-444444444444';

function capture() {
  const records: DiagnosticRecord[] = [];
  const diagnostics = new Diagnostics({
    sink: (record) => records.push(record),
    now: () => Date.UTC(2026, 0, 1),
  });
  return { diagnostics, records };
}

describe('bounded process diagnostics', () => {
  it('reports cumulative duration buckets and independently counts fixed outcomes', () => {
    const { diagnostics } = capture();
    diagnostics.observe('engine.command', 0, 'accepted');
    diagnostics.observe('engine.command', 5, 'rejected');
    diagnostics.observe('engine.command', 12.5, 'error');
    diagnostics.observe('engine.command', 20_000, 'timeout');
    const timing = diagnostics.snapshot().timings['engine.command'];
    expect(timing.count).toBe(4);
    expect(timing.totalMs).toBe(20_017.5);
    expect(timing.maxMs).toBe(20_000);
    expect(timing.outcomes.accepted).toBe(1);
    expect(timing.outcomes.rejected).toBe(1);
    expect(timing.outcomes.error).toBe(1);
    expect(timing.outcomes.timeout).toBe(1);
    expect(timing.outcomes.ok).toBe(0);
    expect(timing.buckets).toEqual([
      { upperBoundMs: 1, count: 1 },
      { upperBoundMs: 5, count: 2 },
      { upperBoundMs: 10, count: 2 },
      { upperBoundMs: 25, count: 3 },
      { upperBoundMs: 50, count: 3 },
      { upperBoundMs: 100, count: 3 },
      { upperBoundMs: 250, count: 3 },
      { upperBoundMs: 500, count: 3 },
      { upperBoundMs: 1_000, count: 3 },
      { upperBoundMs: 2_500, count: 3 },
      { upperBoundMs: 5_000, count: 3 },
      { upperBoundMs: 10_000, count: 3 },
      { upperBoundMs: null, count: 4 },
    ]);
    expect(diagnostics.snapshot().histogramSemantics).toBe('cumulative');
  });

  it('ignores invalid names, outcomes, durations, and gauge values without adding labels', () => {
    const { diagnostics, records } = capture();
    const before = diagnostics.snapshot();
    for (const duration of [-1, NaN, Infinity, -Infinity]) {
      diagnostics.observe('http.request', duration, 'ok');
      diagnostics.gauge('http.active_requests', duration);
    }
    diagnostics.observe('private/sql' as DiagnosticTiming, 1, 'ok');
    diagnostics.observe('http.request', 1, 'secret' as DiagnosticOutcome);
    diagnostics.event('private/token' as DiagnosticEvent);
    diagnostics.gauge('private/account' as DiagnosticGauge, 3);
    const after = diagnostics.snapshot();
    expect(after.timings).toEqual(before.timings);
    expect(after.gauges).toEqual(before.gauges);
    expect(after.events).toEqual(before.events);
    expect(records).toEqual([]);
    expect(JSON.stringify(after)).not.toMatch(/private\/|secret/);
  });

  it('saturates large finite samples and gauges instead of overflowing JSON numbers', () => {
    const { diagnostics } = capture();
    diagnostics.observe('database.read.query', Number.MAX_VALUE, 'ok');
    diagnostics.observe('database.read.query', Number.MAX_VALUE, 'timeout');
    diagnostics.gauge('live.connections', Number.MAX_VALUE);
    const snapshot = diagnostics.snapshot();
    const timing = snapshot.timings['database.read.query'];
    expect(timing.totalMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(timing.maxMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(timing.count).toBe(2);
    expect(timing.buckets.at(-1)?.count).toBe(2);
    expect(timing.buckets.at(-2)?.count).toBe(0);
    expect(snapshot.gauges['live.connections']).toBe(Number.MAX_SAFE_INTEGER);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('retains only fixed aggregates across many distinct request IDs and operations', () => {
    const { diagnostics } = capture();
    const before = diagnostics.snapshot();
    for (let index = 0; index < 2_000; index++) {
      diagnostics.run(
        {
          requestId: `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
          operation: `unbounded-route-${index}`,
        },
        () => {
          diagnostics.event('request.completed', { statusCode: 200 });
          diagnostics.observe('http.request', index, 'ok');
        },
      );
    }
    const after = diagnostics.snapshot();
    expect(Object.keys(after.timings)).toEqual(Object.keys(before.timings));
    expect(Object.keys(after.events)).toEqual(Object.keys(before.events));
    expect(Object.keys(after.gauges)).toEqual(Object.keys(before.gauges));
    expect(after.events['request.completed']).toBe(2_000);
    expect(after.timings['http.request'].count).toBe(2_000);
    const json = JSON.stringify(after);
    expect(json).not.toMatch(/unbounded-route|requestId|commandId|sessionId|sequence|operation/);
    expect(json).not.toContain('1111-4111-8111-111111111111');
    expect(json.length).toBeLessThan(JSON.stringify(before).length + 500);
  });

  it('allowlists sink fields and normalizes operations without serializing payloads or errors', () => {
    const { diagnostics, records } = capture();
    const secret = 'PRIVATE_DIAGNOSTIC_SENTINEL';
    diagnostics.run({ requestId: requestA, operation: 'limit_order' }, () =>
      diagnostics.event('command.completed', {
        commandId,
        sessionId,
        sequence: '123',
        outcome: 'accepted',
        statusCode: 201,
        sql: secret,
        error: new Error(secret),
        password: secret,
        accountId: secret,
        url: `https://${secret}.invalid`,
      } as DiagnosticFields),
    );
    expect(records).toEqual([
      {
        type: 'diagnostic',
        event: 'command.completed',
        occurredAt: '2026-01-01T00:00:00.000Z',
        requestId: requestA,
        operation: 'limit_order',
        commandId,
        sessionId,
        sequence: '123',
        outcome: 'accepted',
        statusCode: 201,
      },
    ]);
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain(commandId);
    expect(Object.isFrozen(records[0])).toBe(true);
  });

  it('rejects malformed IDs, oversized sequences, raw outcomes, and invalid status codes', () => {
    const { diagnostics, records } = capture();
    diagnostics.event('request.completed', {
      requestId: requestA.toUpperCase().replace('11111111', 'ABCDEF12'),
      commandId: 'not-a-command-id',
      sessionId: '44444444444444448444444444444444',
      sequence: '9'.repeat(79),
      operation: '/api/private?token=SECRET',
      outcome: 'SQL_ERROR_SECRET' as DiagnosticOutcome,
      statusCode: 600,
    });
    expect(records[0]).toEqual({
      type: 'diagnostic',
      event: 'request.completed',
      occurredAt: '2026-01-01T00:00:00.000Z',
      operation: 'other',
    });
    for (const value of ['1e5', '-1', '1.2', ' 1', '']) {
      diagnostics.event('command.completed', { sequence: value });
    }
    expect(records.every((record) => record.sequence === undefined)).toBe(true);
    diagnostics.event('command.replayed', { sequence: '9'.repeat(78), statusCode: 200 });
    expect(records.at(-1)?.sequence).toHaveLength(78);
    expect(records.at(-1)?.statusCode).toBe(200);
    expect(JSON.stringify(records)).not.toContain('SECRET');
  });

  it('does not inherit event-only fields from a correlation context', () => {
    const { diagnostics, records } = capture();
    diagnostics.run(
      { requestId: requestA, outcome: 'error', statusCode: 500 } as DiagnosticFields,
      () => diagnostics.event('request.completed'),
    );
    expect(records[0]?.requestId).toBe(requestA);
    expect(records[0]?.outcome).toBeUndefined();
    expect(records[0]?.statusCode).toBeUndefined();
  });

  it('keeps correlated asynchronous operations isolated while nested work inherits context', async () => {
    const { diagnostics, records } = capture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = diagnostics.run({ requestId: requestA, operation: 'limit_order' }, async () => {
      await gate;
      await diagnostics.run({ commandId, sessionId, sequence: '42' }, async () => {
        await Promise.resolve();
        diagnostics.event('command.completed', { outcome: 'accepted' });
      });
      diagnostics.event('request.completed', { statusCode: 201 });
    });
    const second = diagnostics.run({ requestId: requestB, operation: 'read' }, async () => {
      diagnostics.event('request.completed', { statusCode: 200 });
      release();
      await gate;
      diagnostics.event('live.connected');
    });
    await Promise.all([first, second]);
    const command = records.find((record) => record.event === 'command.completed');
    expect(command).toMatchObject({
      requestId: requestA,
      commandId,
      sessionId,
      sequence: '42',
      operation: 'limit_order',
    });
    const otherRequest = records.filter((record) => record.requestId === requestB);
    expect(otherRequest).toHaveLength(2);
    expect(otherRequest.every((record) => record.operation === 'read')).toBe(true);
    expect(otherRequest.every((record) => record.commandId === undefined)).toBe(true);
    const finalRequest = records.find(
      (record) => record.requestId === requestA && record.event === 'request.completed',
    );
    expect(finalRequest?.commandId).toBeUndefined();
    diagnostics.event('recovery.started');
    expect(records.at(-1)?.requestId).toBeUndefined();
  });

  it('runs synchronous and asynchronous work exactly once and preserves its result or original error', async () => {
    const { diagnostics } = capture();
    let calls = 0;
    const result = {};
    expect(
      diagnostics.run({}, () => {
        calls++;
        return result;
      }),
    ).toBe(result);
    const error = new Error('business failure');
    expect(() =>
      diagnostics.run({}, () => {
        calls++;
        throw error;
      }),
    ).toThrow(error);
    await expect(
      diagnostics.run({}, async () => {
        calls++;
        throw error;
      }),
    ).rejects.toBe(error);
    expect(calls).toBe(3);
  });

  it('does not let a throwing sink affect work or later aggregates', async () => {
    let calls = 0;
    const diagnostics = new Diagnostics({
      sink: () => {
        throw new Error('logging unavailable');
      },
    });
    const result = await diagnostics.run({ requestId: requestA }, async () => {
      calls++;
      diagnostics.event('command.completed', { outcome: 'accepted' });
      diagnostics.observe('engine.command', 3, 'accepted');
      return 17;
    });
    expect(result).toBe(17);
    expect(calls).toBe(1);
    expect(diagnostics.snapshot().events['command.completed']).toBe(1);
    expect(diagnostics.snapshot().timings['engine.command'].count).toBe(1);
    expect(diagnostics.snapshot().gauges['diagnostics.dropped_events']).toBe(1);
  });

  it('counts synchronous sink rejection without recursively logging its failure', () => {
    let writes = 0;
    const diagnostics = new Diagnostics({
      sink: () => {
        writes++;
        return false;
      },
    });
    expect(
      diagnostics.run({}, () => {
        diagnostics.event('command.completed');
        return 'completed';
      }),
    ).toBe('completed');
    expect(writes).toBe(1);
    expect(diagnostics.snapshot().gauges['diagnostics.dropped_events']).toBe(1);
    expect(diagnostics.snapshot().events['command.completed']).toBe(1);
    diagnostics.gauge('diagnostics.dropped_events', Number.MAX_SAFE_INTEGER - 1);
    diagnostics.event('command.completed');
    diagnostics.event('command.completed');
    expect(diagnostics.snapshot().gauges['diagnostics.dropped_events']).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(writes).toBe(3);
  });

  it('consumes rejected and declined asynchronous sink writes without awaiting them', async () => {
    let writes = 0;
    const diagnostics = new Diagnostics({
      sink: async () => {
        writes++;
        if (writes === 1) throw new Error('asynchronous logging failure');
        return false;
      },
    });
    const result = diagnostics.run({}, () => {
      diagnostics.event('command.completed');
      diagnostics.event('command.replayed');
      return 'business result';
    });
    expect(result).toBe('business result');
    expect(writes).toBe(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(diagnostics.snapshot().gauges['diagnostics.dropped_events']).toBe(2);
    expect(diagnostics.snapshot().events['command.completed']).toBe(1);
    expect(diagnostics.snapshot().events['command.replayed']).toBe(1);
  });

  it('consumes hostile thenable rejection and counts an async false only once', async () => {
    const diagnostics = new Diagnostics({
      sink: () => ({
        then(resolve: (accepted: false) => void, reject: (error: Error) => void) {
          resolve(false);
          reject(new Error('late rejected settlement'));
          resolve(false);
        },
      }),
    });
    diagnostics.event('request.completed');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(diagnostics.snapshot().gauges['diagnostics.dropped_events']).toBe(1);
    const rejectedGetter = new Diagnostics({
      sink: () =>
        Object.defineProperty({}, 'then', {
          get: () => {
            throw new Error('broken thenable');
          },
        }),
    });
    rejectedGetter.event('request.completed');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rejectedGetter.snapshot().gauges['diagnostics.dropped_events']).toBe(1);
  });

  it('does not count normal synchronous or asynchronous sinks as dropped', async () => {
    const records: DiagnosticRecord[] = [];
    const diagnostics = new Diagnostics({ sink: (record) => records.push(record) });
    diagnostics.event('request.completed');
    const asynchronous = new Diagnostics({
      sink: async (record) => {
        records.push(record);
      },
    });
    asynchronous.event('command.completed');
    const absent = new Diagnostics();
    absent.event('request.completed');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(records).toHaveLength(2);
    expect(diagnostics.snapshot().gauges['diagnostics.dropped_events']).toBe(0);
    expect(asynchronous.snapshot().gauges['diagnostics.dropped_events']).toBe(0);
    expect(absent.snapshot().gauges['diagnostics.dropped_events']).toBe(0);
  });

  it('isolates sink mutation and snapshot mutation from later diagnostics', () => {
    const diagnostics = new Diagnostics({
      sink: (record) => {
        Object.assign(record, { operation: 'private' });
      },
    });
    diagnostics.event('command.completed');
    diagnostics.observe('engine.command', 4, 'accepted');
    diagnostics.gauge('engine.available', 1);
    const snapshot = diagnostics.snapshot();
    snapshot.events['command.completed'] = 99;
    snapshot.gauges['engine.available'] = 99;
    snapshot.timings['engine.command'].count = 99;
    snapshot.timings['engine.command'].outcomes.accepted = 99;
    snapshot.timings['engine.command'].buckets[0]!.count = 99;
    const fresh = diagnostics.snapshot();
    expect(fresh.events['command.completed']).toBe(1);
    expect(fresh.gauges['engine.available']).toBe(1);
    expect(fresh.timings['engine.command'].count).toBe(1);
    expect(fresh.timings['engine.command'].outcomes.accepted).toBe(1);
    expect(fresh.timings['engine.command'].buckets[0]?.count).toBe(0);
  });

  it('starts a new observation window per instance and reports process memory without identity fields', () => {
    let now = Date.UTC(2026, 0, 1);
    let monotonic = 100;
    const diagnostics = new Diagnostics({ now: () => now, monotonicNow: () => monotonic });
    diagnostics.event('request.completed');
    diagnostics.gauge('http.active_requests', 2);
    now += 2_500;
    monotonic += 2_500;
    const snapshot = diagnostics.snapshot();
    expect(snapshot.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(snapshot.generatedAt).toBe('2026-01-01T00:00:02.500Z');
    expect(snapshot.uptimeSeconds).toBe(2.5);
    expect(Object.keys(snapshot.process)).toEqual(['rssBytes', 'heapUsedBytes', 'heapTotalBytes']);
    expect(snapshot.process.rssBytes).toBeGreaterThan(0);
    expect(snapshot.process.heapTotalBytes).toBeGreaterThanOrEqual(snapshot.process.heapUsedBytes);
    expect(JSON.stringify(snapshot)).not.toMatch(/hostname|machine|userId|pid/);
    const fresh = new Diagnostics({ now: () => now, monotonicNow: () => monotonic }).snapshot();
    expect(fresh.startedAt).toBe(snapshot.generatedAt);
    expect(fresh.uptimeSeconds).toBe(0);
    expect(fresh.events['request.completed']).toBe(0);
    expect(fresh.gauges['http.active_requests']).toBe(0);
  });

  it('uses monotonic elapsed time while wall-clock corrections change timestamps', () => {
    let wall = Date.UTC(2026, 0, 2);
    let monotonic = 100;
    const diagnostics = new Diagnostics({ now: () => wall, monotonicNow: () => monotonic });
    wall -= 86_400_000;
    monotonic += 250;
    const backward = diagnostics.snapshot();
    expect(backward.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(backward.uptimeSeconds).toBe(0.25);
    wall += 172_800_000;
    monotonic += 750;
    const forward = diagnostics.snapshot();
    expect(forward.generatedAt).toBe('2026-01-03T00:00:00.000Z');
    expect(forward.startedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(forward.uptimeSeconds).toBe(1);
  });

  it('keeps invalid clocks and getter-backed fields from interrupting business work', () => {
    const diagnostics = new Diagnostics({
      now: () => {
        throw new Error('broken clock');
      },
    });
    const fields = Object.defineProperty({}, 'requestId', {
      get: () => {
        throw new Error('unexpected getter');
      },
    });
    expect(
      diagnostics.run(fields, () => {
        diagnostics.event('request.completed', fields);
        return 'success';
      }),
    ).toBe('success');
    expect(diagnostics.snapshot().generatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(diagnostics.snapshot().events['request.completed']).toBe(1);
  });
});
