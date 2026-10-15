import { describe, expect, it } from 'vitest';
import {
  acceptanceReport,
  JOURNEY_CHECKS,
  SETUP_CHECKS,
} from '../../scripts/deploy/acceptance/report.js';

type ReportInput = Parameters<typeof acceptanceReport>[0];
const commit = 'a'.repeat(40);

function input(): ReportInput {
  return {
    stage: 'complete',
    source: { commit, dirty: false },
    images: {
      api: { id: `sha256:${'b'.repeat(64)}`, revision: commit },
      web: { id: `sha256:${'c'.repeat(64)}`, revision: commit },
      postgres: { id: `sha256:${'d'.repeat(64)}`, revision: null },
    },
    checks: Object.fromEntries([...SETUP_CHECKS, ...JOURNEY_CHECKS].map((name) => [name, true])),
    cleanup: {
      containersRemoved: true,
      volumesRemoved: true,
      networksRemoved: true,
      privateFilesRemoved: true,
    },
  };
}

describe('sanitized self-host acceptance report', () => {
  it('passes only a complete journey with valid source and image evidence', () => {
    const report = acceptanceReport(input());
    expect(report.status).toBe('passed');
    expect(report.source).toEqual({ commit, dirty: false });
    expect(Object.keys(report.checks)).toEqual([...SETUP_CHECKS, ...JOURNEY_CHECKS]);
    expect(Object.keys(report.images)).toEqual(['api', 'web', 'postgres']);
  });

  it('reconstructs a fixed allowlist without retaining diagnostics, actors, secrets, or unknown fields', () => {
    const sentinel = 'PRIVATE_REPORT_SENTINEL';
    const candidate = input();
    Object.assign(candidate, {
      password: sentinel,
      diagnostics: { message: sentinel },
      publicOrigin: `https://${sentinel}.invalid`,
    });
    Object.assign(candidate.source, { handle: sentinel, machine: sentinel });
    Object.assign(candidate.images, { unknown: { id: sentinel, revision: sentinel } });
    Object.assign(candidate.images.api!, { credential: sentinel, containerName: sentinel });
    Object.assign(candidate.checks, { unknownFlag: true, token: sentinel });
    Object.assign(candidate.cleanup, { privateDirectory: sentinel });
    const report = acceptanceReport(candidate);
    expect(JSON.stringify(report)).not.toContain(sentinel);
    expect(Object.keys(report)).toEqual([
      'formatVersion',
      'generatedAt',
      'kind',
      'status',
      'stage',
      'source',
      'images',
      'checks',
      'cleanup',
      'tls',
      'scope',
    ]);
    expect(Object.keys(report.source)).toEqual(['commit', 'dirty']);
    expect(Object.keys(report.images.api!)).toEqual(['id', 'revision']);
    expect(report.checks).not.toHaveProperty('unknownFlag');
    expect(report.cleanup).not.toHaveProperty('privateDirectory');
  });

  it.each([false, 'true', 1, {}, undefined])(
    'requires literal true for every journey and cleanup result (%j)',
    (value) => {
      const checks = input();
      checks.checks.originalReceiptReplay = value;
      const checkReport = acceptanceReport(checks);
      expect(checkReport.status).toBe('failed');
      expect(checkReport.checks.originalReceiptReplay).toBe(false);
      const cleanup = input();
      Object.assign(cleanup.cleanup, { privateFilesRemoved: value });
      const cleanupReport = acceptanceReport(cleanup);
      expect(cleanupReport.status).toBe('failed');
      expect(cleanupReport.cleanup.privateFilesRemoved).toBe(false);
    },
  );

  it('does not pass a missing mandatory check or an incomplete stage', () => {
    const candidate = input();
    delete candidate.checks.runningImageIdentity;
    expect(acceptanceReport(candidate).status).toBe('failed');
    expect(acceptanceReport({ ...input(), stage: 'cleanup' }).status).toBe('failed');
    const report = acceptanceReport({
      ...input(),
      stage: 'PRIVATE_STAGE_SENTINEL' as ReportInput['stage'],
    });
    expect(report.stage).toBe('preflight');
    expect(report.status).toBe('failed');
    expect(JSON.stringify(report)).not.toContain('PRIVATE_STAGE_SENTINEL');
  });

  it.each(['api', 'web', 'postgres'] as const)(
    'cannot pass without the %s image identity',
    (name) => {
      const missing = input();
      delete missing.images[name];
      expect(acceptanceReport(missing).status).toBe('failed');
      const invalid = input();
      invalid.images[name]!.id = 'PRIVATE_IMAGE_SENTINEL';
      const report = acceptanceReport(invalid);
      expect(report.status).toBe('failed');
      expect(JSON.stringify(report)).not.toContain('PRIVATE_IMAGE_SENTINEL');
    },
  );

  it('cannot pass without valid source evidence and omits non-hash revisions', () => {
    const candidate = input();
    candidate.source.commit = 'PRIVATE_SOURCE_SENTINEL';
    candidate.images.api!.revision = 'PRIVATE_REVISION_SENTINEL';
    const report = acceptanceReport(candidate);
    expect(report.status).toBe('failed');
    expect(report.source.commit).toBeNull();
    expect(report.images.api?.revision).toBeNull();
    expect(JSON.stringify(report)).not.toContain('PRIVATE_');
  });

  it.each(['api', 'web'] as const)(
    'requires the %s image revision to match the recorded source commit',
    (name) => {
      for (const revision of [null, 'e'.repeat(40)]) {
        const candidate = input();
        candidate.images[name]!.revision = revision;
        expect(acceptanceReport(candidate).status).toBe('failed');
      }
    },
  );
});
