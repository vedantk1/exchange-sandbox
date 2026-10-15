import { createHash, randomUUID, type Hash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PreparedHistoryExportView } from '@sandbox/contracts';
import type { FastifyReply } from 'fastify';
import type { Exchange } from '../exchange.js';
import { AuthError } from '../auth/errors.js';
import { requirePrincipal, type Principal } from '../auth/access.js';
import { historyContext, scopedAccount } from './context.js';
import { csvText } from './export.js';
import { diagnosticOutcome } from '../diagnostic-outcome.js';
import type { DiagnosticOutcome } from '../diagnostics.js';
import {
  EXPORT_DECIMALS,
  exportColumns,
  exportRows,
  type ExportFileName,
  type ExportRow,
} from './export-rows.js';

export interface HistoryExportsOptions {
  directory?: string;
  ttlMs?: number;
  maxConcurrent?: number;
  maxReady?: number;
  maxPerAccount?: number;
  maxBytes?: number;
  downloadMs?: number;
}

type Options = Required<Omit<HistoryExportsOptions, 'directory'>>;
interface FileState {
  name: ExportFileName;
  path: string;
  handle: FileHandle;
  hash: Hash;
  bytes: number;
  rows: number;
}
interface Job {
  id: string;
  owner: Pick<Principal, 'accountId' | 'role'>;
  directory: string;
  controller: AbortController;
  files: FileState[];
  bytes: number;
  metadata: PreparedHistoryExportView | null;
  streams: Set<ReadStream>;
  stopped: boolean;
}

/** Ephemeral private artifacts: database lifetime and download lifetime are independent. */
export class HistoryExports {
  private readonly jobs = new Map<string, Job>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly streams = new Set<ReadStream>();
  private readonly options: Options;
  private directory = '';
  private ownsDirectory = false;
  private timer: NodeJS.Timeout | undefined;
  private active = 0;
  private downloads = 0;
  private closed = false;
  private publication: Promise<void> = Promise.resolve();

  private constructor(
    private readonly exchange: Exchange,
    options: HistoryExportsOptions,
  ) {
    this.options = {
      ttlMs: options.ttlMs ?? 5 * 60_000,
      maxConcurrent: options.maxConcurrent ?? 2,
      maxReady: options.maxReady ?? 8,
      maxPerAccount: options.maxPerAccount ?? 2,
      maxBytes: options.maxBytes ?? 128 * 1024 * 1024,
      downloadMs: options.downloadMs ?? 30_000,
    };
    if (Object.values(this.options).some((value) => !Number.isSafeInteger(value) || value < 1))
      throw new Error('History export limits must be positive integers.');
  }

  static async create(
    exchange: Exchange,
    options: HistoryExportsOptions = {},
  ): Promise<HistoryExports> {
    const manager = new HistoryExports(exchange, options);
    manager.ownsDirectory = options.directory === undefined;
    manager.directory = options.directory
      ? resolve(options.directory)
      : await mkdtemp(join(tmpdir(), 'spot-history-exports-'));
    await mkdir(manager.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(manager.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error('The history export directory must be a private directory.');
    await chmod(manager.directory, 0o700);
    // Only this service's fixed child names are removed. The single writer owns this directory.
    for (const entry of await readdir(manager.directory, { withFileTypes: true })) {
      if (/^export-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.name))
        await rm(join(manager.directory, entry.name), { recursive: true, force: true });
    }
    manager.timer = setInterval(
      () => {
        void manager.expire().catch(() => undefined);
      },
      Math.min(1_000, manager.options.ttlMs),
    );
    manager.timer.unref();
    return manager;
  }

  private check(job: Job, signal: AbortSignal): void {
    if (this.closed || job.stopped || signal.aborted)
      throw new AuthError(
        'EXPORT_ABORTED',
        'Export preparation stopped. Prepare a fresh export to retry.',
        503,
      );
  }

  private async write(
    job: Job,
    file: FileState,
    columns: string[],
    rows: ExportRow[],
    signal: AbortSignal,
    header = false,
  ): Promise<void> {
    this.check(job, signal);
    const heading = csvText(columns, [], EXPORT_DECIMALS);
    const text = header ? heading : csvText(columns, rows, EXPORT_DECIMALS).slice(heading.length);
    const buffer = Buffer.from(text, 'utf8');
    if (job.bytes + buffer.length > this.options.maxBytes)
      throw new AuthError(
        'EXPORT_TOO_LARGE',
        `The complete export exceeds its ${this.options.maxBytes}-byte resource limit. No partial export was published.`,
        413,
      );
    await file.handle.writeFile(buffer);
    this.check(job, signal);
    file.hash.update(buffer);
    file.bytes += buffer.length;
    file.rows += header ? 0 : rows.length;
    job.bytes += buffer.length;
  }

  async prepare(
    token: string,
    sessionId: string,
    requestedAccountId?: string,
    requestSignal?: AbortSignal,
  ): Promise<PreparedHistoryExportView> {
    const started = performance.now();
    let outcome: DiagnosticOutcome = 'ok';
    try {
      return await this.prepareJob(token, sessionId, requestedAccountId, requestSignal);
    } catch (error) {
      outcome = diagnosticOutcome(error);
      throw error;
    } finally {
      this.exchange.diagnostics.observe('export.prepare', performance.now() - started, outcome);
      this.exchange.diagnostics.event('export.prepared', { outcome });
    }
  }

  private async prepareJob(
    token: string,
    sessionId: string,
    requestedAccountId?: string,
    requestSignal?: AbortSignal,
  ): Promise<PreparedHistoryExportView> {
    const owner = await this.exchange.readTransaction(async (tx) => {
      const actor = await requirePrincipal(tx, token);
      const accountId =
        actor.role === 'ADMIN' && !requestedAccountId
          ? null
          : await scopedAccount(tx, actor, requestedAccountId);
      return { actor, accountId };
    });
    await this.expire();
    if (this.closed || this.active >= this.options.maxConcurrent)
      throw new AuthError(
        'EXPORT_BUSY',
        'Export preparation is at capacity. Retry after a current export finishes.',
        503,
      );
    if (requestSignal?.aborted)
      throw new AuthError(
        'EXPORT_ABORTED',
        'Export preparation stopped. Prepare a fresh export to retry.',
        503,
      );
    const id = randomUUID();
    const job: Job = {
      id,
      owner: { accountId: owner.actor.accountId, role: owner.actor.role },
      directory: join(this.directory, `export-${id}`),
      controller: new AbortController(),
      files: [],
      bytes: 0,
      metadata: null,
      streams: new Set(),
      stopped: false,
    };
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, job.controller.signal])
      : job.controller.signal;
    this.jobs.set(id, job);
    this.active += 1;
    this.exchange.diagnostics.gauge('export.retained_jobs', this.jobs.size);
    this.exchange.diagnostics.gauge('export.active_preparations', this.active);
    const work = this.generate(job, token, sessionId, owner.accountId, signal);
    this.pending.add(work);
    try {
      return await work;
    } finally {
      this.pending.delete(work);
      this.active -= 1;
      this.exchange.diagnostics.gauge('export.active_preparations', this.active);
    }
  }

  private async generate(
    job: Job,
    token: string,
    sessionId: string,
    accountId: string | null,
    signal: AbortSignal,
  ): Promise<PreparedHistoryExportView> {
    let snapshotWork: Promise<unknown> | undefined;
    try {
      const admin = job.owner.role === 'ADMIN';
      const columns = exportColumns(Boolean(accountId), admin);
      const names: ExportFileName[] = [
        'manifest.csv',
        'orders.csv',
        'fills.csv',
        'activity.csv',
        'commands.csv',
        'balances.csv',
        ...(admin ? ['audit.csv' as const] : []),
      ];
      this.check(job, signal);
      await mkdir(job.directory, { mode: 0o700 });
      // Create all paths before beginning the budgeted callback. A late callback can only
      // write existing handles, never recreate deleted private paths after cancellation.
      for (const name of names) {
        this.check(job, signal);
        const path = join(job.directory, name);
        const handle = await open(path, 'wx', 0o600);
        job.files.push({ name, path, handle, hash: createHash('sha256'), bytes: 0, rows: 0 });
      }
      const boundary = await this.exchange.exportReadTransaction((tx) => {
        snapshotWork = (async () => {
          const context = await historyContext(tx, token, sessionId);
          if (
            context.actor.accountId !== job.owner.accountId ||
            context.actor.role !== job.owner.role
          )
            throw new AuthError(
              'SESSION_CHANGED',
              'The signed-in account changed. Prepare a fresh export.',
              401,
            );
          if (accountId) await scopedAccount(tx, context.actor, accountId);
          const check = () => this.check(job, signal);
          for (const file of job.files) {
            check();
            await this.write(job, file, columns[file.name], [], signal, true);
            if (file.name === 'manifest.csv') {
              await this.write(
                job,
                file,
                columns[file.name],
                [
                  {
                    sessionId,
                    accountId,
                    asOf: context.asOf,
                    outboxCursor: context.cursor,
                    scope: accountId ? 'ACCOUNT' : 'ADMIN_SESSION',
                    auditScope: admin ? 'SESSION' : 'NONE',
                    baseAsset: 'BTC-SIM',
                    quoteAsset: 'USD-SIM',
                  },
                ],
                signal,
              );
            } else {
              for await (const rows of exportRows(
                tx,
                sessionId,
                accountId,
                admin,
                file.name,
                check,
              ))
                await this.write(job, file, columns[file.name], rows, signal);
            }
          }
          return context;
        })();
        return snapshotWork as Promise<Awaited<ReturnType<typeof historyContext>>>;
      });
      this.check(job, signal);
      await Promise.all(job.files.map((file) => file.handle.close()));
      // Recheck outside the older snapshot before publishing a download capability.
      const current = await this.exchange.readTransaction((tx) => requirePrincipal(tx, token));
      if (current.accountId !== job.owner.accountId || current.role !== job.owner.role)
        throw new AuthError(
          'SESSION_CHANGED',
          'The signed-in account changed. Prepare a fresh export.',
          401,
        );
      this.check(job, signal);
      const metadata: PreparedHistoryExportView = {
        exportId: job.id,
        sessionId,
        accountId,
        auditScope: admin ? 'SESSION' : 'NONE',
        asOf: boundary.asOf,
        cursor: boundary.cursor,
        expiresAt: new Date(Date.now() + this.options.ttlMs).toISOString(),
        files: job.files.map((file) => ({
          name: file.name,
          bytes: file.bytes,
          rows: file.rows,
          sha256: file.hash.digest('hex'),
          downloadUrl: `/api/history/exports/${job.id}/files/${file.name}`,
        })),
      };
      await this.publish(job, metadata, signal);
      return structuredClone(metadata);
    } catch (error) {
      job.controller.abort();
      await this.remove(job);
      // runBudget fences DB transports immediately, but its callback may still be awaiting
      // a file write. Reapply cleanup after that callback settles; never publish its result.
      if (snapshotWork) {
        const tail = snapshotWork.catch(() => undefined).finally(() => this.remove(job));
        this.pending.add(tail);
        void tail.finally(() => this.pending.delete(tail)).catch(() => undefined);
      }
      throw error;
    }
  }

  private async publish(
    job: Job,
    metadata: PreparedHistoryExportView,
    signal: AbortSignal,
  ): Promise<void> {
    const previous = this.publication;
    let release!: () => void;
    this.publication = new Promise<void>((done) => {
      release = done;
    });
    await previous;
    try {
      this.check(job, signal);
      await this.makeRoom(job);
      this.check(job, signal);
      job.metadata = metadata;
    } finally {
      release();
    }
  }

  private async makeRoom(candidate: Job): Promise<void> {
    while (true) {
      const ready = [...this.jobs.values()].filter((job) => job.metadata && !job.stopped);
      const own = ready.filter((job) => job.owner.accountId === candidate.owner.accountId);
      const candidates =
        own.length >= this.options.maxPerAccount
          ? own
          : ready.length >= this.options.maxReady
            ? ready
            : [];
      if (!candidates.length) return;
      const oldest = candidates.find((job) => job.streams.size === 0);
      if (!oldest)
        throw new AuthError(
          'EXPORT_BUSY',
          'Existing exports are downloading. Retry after a download finishes.',
          503,
        );
      await this.remove(oldest);
    }
  }

  private async remove(job: Job): Promise<void> {
    job.stopped = true;
    job.controller.abort();
    this.jobs.delete(job.id);
    this.exchange.diagnostics.gauge('export.retained_jobs', this.jobs.size);
    await Promise.allSettled(job.files.map((file) => file.handle.close()));
    await rm(job.directory, { recursive: true, force: true });
  }

  private async expire(): Promise<void> {
    for (const job of [...this.jobs.values()]) {
      if (
        job.metadata &&
        Date.parse(job.metadata.expiresAt) <= Date.now() &&
        job.streams.size === 0
      )
        await this.remove(job);
    }
  }

  async download(
    reply: FastifyReply,
    token: string,
    exportId: string,
    fileName: string,
  ): Promise<void> {
    const started = performance.now();
    let recorded = false;
    let active = false;
    const completed = (outcome: DiagnosticOutcome) => {
      if (recorded) return;
      recorded = true;
      if (active) {
        this.downloads -= 1;
        this.exchange.diagnostics.gauge('export.active_downloads', this.downloads);
      }
      this.exchange.diagnostics.observe('export.download', performance.now() - started, outcome);
      this.exchange.diagnostics.event('export.downloaded', { outcome });
    };
    try {
      await this.sendDownload(
        reply,
        token,
        exportId,
        fileName,
        () => {
          active = true;
          this.downloads += 1;
          this.exchange.diagnostics.gauge('export.active_downloads', this.downloads);
        },
        completed,
      );
    } catch (error) {
      completed(diagnosticOutcome(error));
      throw error;
    }
  }

  private async sendDownload(
    reply: FastifyReply,
    token: string,
    exportId: string,
    fileName: string,
    started: () => void,
    completed: (outcome: DiagnosticOutcome) => void,
  ): Promise<void> {
    const actor = await this.exchange.readTransaction((tx) => requirePrincipal(tx, token));
    const job = this.jobs.get(exportId);
    if (
      !job?.metadata ||
      job.stopped ||
      this.closed ||
      Date.parse(job.metadata.expiresAt) <= Date.now()
    )
      throw new AuthError(
        'EXPORT_EXPIRED',
        'This temporary export is unavailable or expired. Prepare a fresh export.',
        410,
      );
    if (actor.accountId !== job.owner.accountId || actor.role !== job.owner.role)
      throw new AuthError('FORBIDDEN', 'This export belongs to another account.', 403);
    const file = job.files.find((entry) => entry.name === fileName);
    if (!file) throw new AuthError('EXPORT_FILE_NOT_FOUND', 'Export file not found.', 404);
    if (
      this.streams.size >= 8 ||
      [...this.jobs.values()]
        .filter((entry) => entry.owner.accountId === actor.accountId)
        .reduce((count, entry) => count + entry.streams.size, 0) >= 2
    )
      throw new AuthError(
        'EXPORT_DOWNLOAD_LIMIT',
        'Too many export downloads. Wait for a current download to finish.',
        503,
      );
    const stream = createReadStream(file.path, { highWaterMark: 64 * 1024 });
    this.streams.add(stream);
    job.streams.add(stream);
    started();
    let outcome: DiagnosticOutcome = 'ok';
    let streamClosed = false;
    let responseClosed = false;
    let responseFinished = reply.raw.writableFinished;
    const finishObservation = () => {
      if (!streamClosed || (!responseFinished && !responseClosed)) return;
      reply.raw.off('close', close);
      reply.raw.off('finish', finish);
      completed(outcome);
    };
    const timeout = setTimeout(() => {
      outcome = 'timeout';
      stream.destroy(new Error('Export download exceeded its deadline.'));
    }, this.options.downloadMs);
    const close = () => {
      responseClosed = true;
      if (!responseFinished && !reply.raw.writableFinished && outcome === 'ok') outcome = 'aborted';
      stream.destroy();
      finishObservation();
    };
    const finish = () => {
      responseFinished = true;
      finishObservation();
    };
    const cleanup = () => {
      streamClosed = true;
      clearTimeout(timeout);
      this.streams.delete(stream);
      job.streams.delete(stream);
      finishObservation();
      if (job.metadata && Date.parse(job.metadata.expiresAt) <= Date.now())
        void this.expire().catch(() => undefined);
    };
    stream.once('error', (error) => {
      if (outcome === 'ok') outcome = diagnosticOutcome(error);
    });
    stream.once('close', cleanup);
    reply.raw.once('close', close);
    reply.raw.once('finish', finish);
    reply.raw.socket?.setTimeout?.(this.options.downloadMs + 5_000);
    try {
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${file.name}"`)
        .header('Content-Length', file.bytes)
        .header(
          'X-Export-SHA256',
          job.metadata.files.find((entry) => entry.name === file.name)!.sha256,
        );
      await reply.send(stream);
    } catch (error) {
      if (outcome === 'ok') outcome = diagnosticOutcome(error);
      stream.destroy();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const job of this.jobs.values()) job.controller.abort();
    for (const stream of this.streams) stream.destroy();
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    await Promise.all([...this.jobs.values()].map((job) => this.remove(job)));
    // Configured roots remain for reuse and owned volume permissions; only owned children are removed.
    if (this.ownsDirectory) await rm(this.directory, { recursive: true, force: true });
  }
}
