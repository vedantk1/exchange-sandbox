import { ApiError, type CommandOutcome } from './api.js';

export interface PendingCommand {
  version: 1;
  actorId: string;
  path: string;
  label: string;
  body: Record<string, unknown> & { commandId: string; sessionId: string };
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Request = <T>(path: string, body?: Record<string, unknown>) => Promise<T>;
const COMMAND_PATH =
  /^\/api\/(?:orders(?:\/[0-9a-f-]{36}\/cancel)?|admin\/(?:market\/(?:pause|resume)|grants|reconcile|invitations(?:\/[0-9a-f-]{36}\/revoke)?|traders\/[0-9a-f-]{36}\/(?:suspend|reinstate|recovery)|orders\/[0-9a-f-]{36}\/cancel))$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Only non-secret command intentions may enter browser persistence. */
function assertNonSecretPayload(value: unknown, visited = new Set<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (visited.has(value)) throw new Error('Command payloads must be acyclic.');
  visited.add(value);
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replaceAll(/[_-]/g, '').toLowerCase();
    if (
      /(password|token|secret)$/.test(normalized) ||
      normalized === 'authorization' ||
      normalized === 'cookie'
    ) {
      throw new Error('Credential fields cannot be stored in a pending command.');
    }
    assertNonSecretPayload(nested, visited);
  }
  visited.delete(value);
}

/** One unresolved intention per tab/account. Credentials and handoff secrets never enter this store. */
export class CommandRunner {
  pending: PendingCommand | null = null;
  busy = false;
  storageBlocked = false;
  error: string | null = null;
  private readonly key: string;

  constructor(
    private readonly actorId: string,
    private readonly storage: Storage,
    private readonly request: Request,
    private readonly changed: () => void,
  ) {
    this.key = `sandbox.pending.v1.${actorId}`;
    try {
      const raw = storage.getItem(this.key);
      if (raw) {
        const value = JSON.parse(raw) as PendingCommand;
        if (
          raw.length > 8_192 ||
          value.version !== 1 ||
          value.actorId !== actorId ||
          !COMMAND_PATH.test(value.path) ||
          typeof value.label !== 'string' ||
          !ID.test(value.body?.commandId) ||
          !ID.test(value.body?.sessionId)
        ) {
          throw new Error('Invalid pending command');
        }
        assertNonSecretPayload(value.body);
        this.pending = value;
      }
    } catch {
      this.storageBlocked = true;
      this.error =
        'Pending request storage could not be read. Check this tab’s browser storage before submitting a command.';
    }
  }

  async submit(
    path: string,
    body: Record<string, unknown>,
    label: string,
    sessionId: string,
  ): Promise<CommandOutcome | null> {
    if (this.busy || this.pending || this.error) return null;
    if (!COMMAND_PATH.test(path)) throw new Error('Unsupported command route.');
    assertNonSecretPayload(body);
    const pending: PendingCommand = {
      version: 1,
      actorId: this.actorId,
      path,
      label,
      body: { ...body, commandId: crypto.randomUUID(), sessionId },
    };
    try {
      // Persist before dispatch: a refresh or lost acknowledgement must not create a second identity.
      this.storage.setItem(this.key, JSON.stringify(pending));
    } catch {
      this.storageBlocked = true;
      this.error =
        'The request was not sent because this tab cannot preserve its identity. Enable session storage and reload.';
      this.changed();
      return null;
    }
    this.pending = pending;
    return this.attempt(false);
  }

  async retry(): Promise<CommandOutcome | null> {
    if (this.busy || !this.pending) return null;
    return this.attempt(true);
  }

  private complete(result: CommandOutcome): CommandOutcome {
    if (
      !this.pending ||
      result.commandId !== this.pending.body.commandId ||
      result.sessionId !== this.pending.body.sessionId ||
      (result.status !== 'ACCEPTED' && result.status !== 'REJECTED')
    )
      throw new Error('Unexpected command response');
    this.storage.removeItem(this.key);
    this.pending = null;
    this.error = null;
    return result;
  }

  private async receipt(): Promise<CommandOutcome | null> {
    if (!this.pending) return null;
    const result = await this.request<CommandOutcome | null>(
      `/api/receipts/${this.pending.body.commandId}`,
    );
    return result ? this.complete(result) : null;
  }

  async resolve(): Promise<CommandOutcome | null> {
    if (this.busy || !this.pending) return null;
    this.busy = true;
    this.changed();
    try {
      const result = await this.receipt();
      if (!result)
        this.error = 'No committed receipt yet. Retry this same command to resolve it safely.';
      return result;
    } catch {
      this.error =
        'The outcome is still unknown. Reconnect or sign in again to resolve this same command.';
      return null;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  private async attempt(retry: boolean): Promise<CommandOutcome | null> {
    const pending = this.pending!;
    this.busy = true;
    this.error = null;
    this.changed();
    try {
      return this.complete(await this.request<CommandOutcome>(pending.path, pending.body));
    } catch (error) {
      if (
        !retry &&
        error instanceof ApiError &&
        [400, 401, 403, 404, 415, 422, 429].includes(error.status)
      ) {
        // These first-attempt transport/validation failures have not admitted a command.
        try {
          this.storage.removeItem(this.key);
        } catch {
          this.error =
            'The command was not admitted, but its saved identity could not be cleared. Restore browser storage and resolve this request.';
          return null;
        }
        this.pending = null;
        this.error = error.message;
        return null;
      }
      try {
        const result = await this.receipt();
        if (result) return result;
      } catch {
        /* A failed receipt read cannot establish the command's outcome. */
      }
      this.error =
        'The response was lost or unavailable. This command’s outcome is unknown; resolve it before submitting another.';
      return null;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  dismissError(): void {
    if (!this.pending && !this.storageBlocked) {
      this.error = null;
      this.changed();
    }
  }
}
