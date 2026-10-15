export const JOURNEY_CHECKS = [
  'httpsIdentityVerified',
  'compiledUiLogin',
  'invitationRedemption',
  'csrfProtection',
  'secureSessionCookies',
  'partialFillAndCancellation',
  'liveUpdates',
  'traderExportReconciliation',
  'adminExportReconciliation',
  'crossAccountExportDenied',
  'sessionPreservedAfterRestart',
  'originalReceiptReplay',
  'restartAccountingPreserved',
] as const;

export const SETUP_CHECKS = [
  'freshInstallation',
  'supportedOwnerInitialization',
  'interactiveAdministratorSetup',
  'restrictedRuntime',
  'runningImageIdentity',
] as const;

export const STAGES = [
  'preflight',
  'prepare',
  'migrate',
  'bootstrap',
  'startup',
  'https',
  'journey',
  'cleanup',
  'complete',
] as const;
export type AcceptanceStage = (typeof STAGES)[number];
export type DockerResource = 'container' | 'volume' | 'network';
export interface ImageEvidence {
  id: string;
  revision: string | null;
}
export interface CleanupEvidence {
  containersRemoved: boolean;
  volumesRemoved: boolean;
  networksRemoved: boolean;
  privateFilesRemoved: boolean;
}

export const emptyCleanup = (): CleanupEvidence => ({
  containersRemoved: false,
  volumesRemoved: false,
  networksRemoved: false,
  privateFilesRemoved: false,
});

/** Reconstruct an allowlist. Raw diagnostics, URLs, credentials and actor IDs never enter artifacts. */
export function acceptanceReport(input: {
  stage: AcceptanceStage;
  source: { commit: string; dirty: boolean };
  images: Partial<Record<'api' | 'web' | 'postgres', ImageEvidence>>;
  checks: Record<string, unknown>;
  cleanup: CleanupEvidence;
}) {
  const hex = /^[0-9a-f]{40}$/;
  const images: Partial<Record<'api' | 'web' | 'postgres', ImageEvidence>> = {};
  for (const name of ['api', 'web', 'postgres'] as const) {
    const image = input.images[name];
    if (image && /^sha256:[0-9a-f]{64}$/.test(image.id))
      images[name] = {
        id: image.id,
        revision: image.revision && hex.test(image.revision) ? image.revision : null,
      };
  }
  const checks = Object.fromEntries(
    [...SETUP_CHECKS, ...JOURNEY_CHECKS].map((name) => [name, input.checks[name] === true]),
  );
  const cleanup = Object.fromEntries(
    Object.keys(emptyCleanup()).map((name) => [
      name,
      input.cleanup[name as keyof CleanupEvidence] === true,
    ]),
  );
  const passed =
    input.stage === 'complete' &&
    hex.test(input.source.commit) &&
    Boolean(images.api && images.web && images.postgres) &&
    images.api?.revision === input.source.commit &&
    images.web?.revision === input.source.commit &&
    Object.values(checks).every(Boolean) &&
    Object.values(cleanup).every(Boolean);
  return {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    kind: 'fresh-compose-https-acceptance',
    status: passed ? 'passed' : 'failed',
    stage: STAGES.includes(input.stage) ? input.stage : 'preflight',
    source: {
      commit: hex.test(input.source.commit) ? input.source.commit : null,
      dirty: input.source.dirty === true,
    },
    images,
    checks,
    cleanup,
    tls: {
      serverValidation: 'Node HTTPS requires the generated Caddy CA and localhost hostname.',
      browserTrust:
        'An isolated Chromium exception is limited to the leaf public key after Node validation; no global TLS bypass or host trust-store changes.',
    },
    scope:
      'Generated isolated Compose installation only. API retains its normal restricted role and container resource limits. This is acceptance evidence, not a capacity benchmark or proof of real-money readiness.',
  };
}
