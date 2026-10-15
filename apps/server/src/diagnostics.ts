import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const TIMINGS = [
  'http.request',
  'http.command',
  'engine.command',
  'engine.lock',
  'database.read.acquire',
  'database.read.query',
  'database.read.budget',
  'database.export.acquire',
  'database.export.query',
  'database.export.budget',
  'database.command.acquire',
  'database.command.query',
  'database.command.budget',
  'database.maintenance.acquire',
  'database.maintenance.query',
  'database.maintenance.budget',
  'database.shutdown',
  'live.connection',
  'export.prepare',
  'export.download',
  'simulator.cycle',
] as const;

const OUTCOMES = [
  'ok',
  'accepted',
  'rejected',
  'timeout',
  'lock_timeout',
  'busy',
  'aborted',
  'unavailable',
  'conflict',
  'error',
  'skipped',
] as const;

const EVENTS = [
  'request.completed',
  'command.completed',
  'command.replayed',
  'admission.rejected',
  'recovery.started',
  'recovery.completed',
  'runtime.halted',
  'writer.unavailable',
  'live.connected',
  'live.disconnected',
  'live.frame',
  'export.prepared',
  'export.downloaded',
  'simulator.cycle',
] as const;

const GAUGES = [
  'http.active_requests',
  'live.connections',
  'export.active_preparations',
  'export.active_downloads',
  'export.retained_jobs',
  'simulator.in_flight',
  'engine.available',
  'engine.faulted',
  'engine.recovering',
  'diagnostics.dropped_events',
] as const;

const OPERATIONS = [
  'limit_order',
  'market_order',
  'cancel_order',
  'market_preview',
  'admin_command',
  'authentication',
  'read',
  'diagnostics',
  'simulator',
  'maintenance',
  'other',
  'market_resume',
  'market_pause',
  'grant',
  'reconcile',
  'suspend',
  'reinstate',
  'session_rollover',
  'simulator_start',
  'simulator_stop',
  'invitation_issue',
  'invitation_revoke',
  'password_rotate',
  'password_recover',
  'invitation_redeem',
] as const;

export type DiagnosticTiming = (typeof TIMINGS)[number];
export type DiagnosticOutcome = (typeof OUTCOMES)[number];
export type DiagnosticEvent = (typeof EVENTS)[number];
export type DiagnosticGauge = (typeof GAUGES)[number];
export type DiagnosticOperation = (typeof OPERATIONS)[number];

export interface DiagnosticContext {
  requestId?: string;
  commandId?: string;
  sessionId?: string;
  sequence?: string;
  operation?: string;
}

export interface DiagnosticFields extends DiagnosticContext {
  outcome?: DiagnosticOutcome;
  statusCode?: number;
}

export interface DiagnosticRecord extends Omit<DiagnosticFields, 'operation'> {
  type: 'diagnostic';
  event: DiagnosticEvent;
  occurredAt: string;
  operation?: DiagnosticOperation;
}

export interface DiagnosticOptions {
  /** Literal false declines an event; thrown/rejected writes are dropped as well.
   * Other return values are ignored, including resolved void from an async sink.
   */
  sink?: (record: DiagnosticRecord) => unknown;
  /** Epoch milliseconds for event and snapshot timestamps. */
  now?: () => number;
  /** Monotonic milliseconds for elapsed process lifetime, defaulting to performance.now. */
  monotonicNow?: () => number;
}

export interface DiagnosticTimingSnapshot {
  count: number;
  totalMs: number;
  maxMs: number;
  outcomes: Record<DiagnosticOutcome, number>;
  /** Cumulative counts: a sample contributes to every bucket whose bound contains it. */
  buckets: Array<{ upperBoundMs: number | null; count: number }>;
}

export interface DiagnosticsSnapshot {
  schemaVersion: 1;
  startedAt: string;
  generatedAt: string;
  uptimeSeconds: number;
  process: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
  histogramSemantics: 'cumulative';
  timings: Record<DiagnosticTiming, DiagnosticTimingSnapshot>;
  events: Record<DiagnosticEvent, number>;
  gauges: Record<DiagnosticGauge, number>;
}

const timingNames = new Set<string>(TIMINGS);
const outcomeNames = new Set<string>(OUTCOMES);
const eventNames = new Set<string>(EVENTS);
const gaugeNames = new Set<string>(GAUGES);
const operationNames = new Set<string>(OPERATIONS);
const bucketBounds = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, null];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sequence = /^[0-9]{1,78}$/;
const maximum = Number.MAX_SAFE_INTEGER;

function fixedRecord<K extends string, V>(
  names: readonly K[],
  value: (name: K) => V,
): Record<K, V> {
  return Object.fromEntries(names.map((name) => [name, value(name)])) as Record<K, V>;
}

function add(left: number, right: number): number {
  return Math.min(maximum, left + right);
}

type SafeFields = Omit<DiagnosticFields, 'operation'> & { operation?: DiagnosticOperation };

function sanitize(fields: DiagnosticFields | undefined, contextOnly = false): SafeFields {
  const safe: SafeFields = {};
  if (!fields || typeof fields !== 'object') return safe;
  // Read only named primitives. Payloads, account handles, SQL, URLs, and error
  // objects cannot become labels or diagnostic fields, even through spread input.
  try {
    for (const key of ['requestId', 'commandId', 'sessionId'] as const) {
      const value = fields[key];
      if (typeof value === 'string' && uuid.test(value)) safe[key] = value;
    }
    const position = fields.sequence;
    if (typeof position === 'string' && sequence.test(position)) safe.sequence = position;
    const operation = fields.operation;
    if (typeof operation === 'string') {
      safe.operation = operationNames.has(operation) ? (operation as DiagnosticOperation) : 'other';
    }
    if (contextOnly) return safe;
    const outcome = fields.outcome;
    if (typeof outcome === 'string' && outcomeNames.has(outcome)) safe.outcome = outcome;
    const status = fields.statusCode;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
      safe.statusCode = status;
    }
  } catch {
    // Diagnostic input must not interrupt business work, including getter-backed
    // objects accidentally passed by a caller. Already validated primitives are safe.
  }
  return safe;
}

/**
 * Process-local, bounded diagnostics. Aggregates have only fixed labels; events
 * go directly to an optional sanitized sink and are never retained in memory.
 * A new process starts a new observation window; these are not durable counters.
 */
export class Diagnostics {
  private readonly context = new AsyncLocalStorage<SafeFields>();
  private readonly timings = fixedRecord(TIMINGS, () => ({
    count: 0,
    totalMs: 0,
    maxMs: 0,
    outcomes: fixedRecord(OUTCOMES, () => 0),
    buckets: bucketBounds.map((upperBoundMs) => ({ upperBoundMs, count: 0 })),
  }));
  private readonly events = fixedRecord(EVENTS, () => 0);
  private readonly gauges = fixedRecord(GAUGES, () => 0);
  private readonly clock: () => number;
  private readonly monotonicClock: () => number;
  private readonly sink: DiagnosticOptions['sink'];
  private readonly started: number;
  private readonly startedMonotonic: number;

  constructor(options: DiagnosticOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.monotonicClock = options.monotonicNow ?? (() => performance.now());
    this.sink = options.sink;
    this.started = this.time();
    this.startedMonotonic = this.monotonicTime();
  }

  observe(name: DiagnosticTiming, durationMs: number, outcome: DiagnosticOutcome): void {
    if (
      !timingNames.has(name) ||
      !outcomeNames.has(outcome) ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    ) {
      return;
    }
    const timing = this.timings[name];
    const duration = Math.min(maximum, durationMs);
    timing.count = add(timing.count, 1);
    timing.totalMs = add(timing.totalMs, duration);
    timing.maxMs = Math.max(timing.maxMs, duration);
    timing.outcomes[outcome] = add(timing.outcomes[outcome], 1);
    for (const bucket of timing.buckets) {
      if (bucket.upperBoundMs === null || durationMs <= bucket.upperBoundMs) {
        bucket.count = add(bucket.count, 1);
      }
    }
  }

  event(name: DiagnosticEvent, fields?: DiagnosticFields): void {
    if (!eventNames.has(name)) return;
    this.events[name] = add(this.events[name], 1);
    if (!this.sink) return;
    const safe = { ...this.context.getStore(), ...sanitize(fields) };
    const record: DiagnosticRecord = {
      type: 'diagnostic',
      event: name,
      occurredAt: new Date(this.time()).toISOString(),
      ...safe,
    };
    try {
      const result = this.sink(Object.freeze(record));
      if (result === false) {
        this.dropped();
      } else if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
        // A mistakenly async sink must not cause an unhandled rejection. Observe
        // its settlement without awaiting it, retaining records, or queuing writes.
        void Promise.resolve<unknown>(result).then(
          (accepted) => {
            if (accepted === false) this.dropped();
          },
          () => this.dropped(),
        );
      }
    } catch {
      // An unavailable logging destination must not fail requests or commands.
      this.dropped();
    }
  }

  gauge(name: DiagnosticGauge, value: number): void {
    if (!gaugeNames.has(name) || !Number.isFinite(value) || value < 0) return;
    this.gauges[name] = Math.min(maximum, value);
  }

  run<T>(context: DiagnosticContext, work: () => T): T {
    return this.context.run({ ...this.context.getStore(), ...sanitize(context, true) }, work);
  }

  snapshot(): DiagnosticsSnapshot {
    const generated = this.time();
    const memory = process.memoryUsage();
    return {
      schemaVersion: 1,
      startedAt: new Date(this.started).toISOString(),
      generatedAt: new Date(generated).toISOString(),
      uptimeSeconds: Math.max(0, (this.monotonicTime() - this.startedMonotonic) / 1_000),
      process: {
        rssBytes: Math.min(maximum, memory.rss),
        heapUsedBytes: Math.min(maximum, memory.heapUsed),
        heapTotalBytes: Math.min(maximum, memory.heapTotal),
      },
      histogramSemantics: 'cumulative',
      timings: fixedRecord(TIMINGS, (name) => {
        const timing = this.timings[name];
        return {
          count: timing.count,
          totalMs: timing.totalMs,
          maxMs: timing.maxMs,
          outcomes: { ...timing.outcomes },
          buckets: timing.buckets.map((bucket) => ({ ...bucket })),
        };
      }),
      events: { ...this.events },
      gauges: { ...this.gauges },
    };
  }

  private dropped(): void {
    this.gauges['diagnostics.dropped_events'] = add(this.gauges['diagnostics.dropped_events'], 1);
  }

  private monotonicTime(): number {
    try {
      const value = this.monotonicClock();
      if (Number.isFinite(value) && value >= 0 && value <= maximum) return value;
    } catch {
      // Clock failures must not change business behavior.
    }
    return performance.now();
  }

  private time(): number {
    try {
      const value = this.clock();
      if (Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000) {
        return value;
      }
    } catch {
      // A broken diagnostic clock is not a business failure.
    }
    return Date.now();
  }
}
