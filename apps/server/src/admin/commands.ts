import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@sandbox/database';
import { DomainError } from '@sandbox/domain';
import type { Selectable, Transaction } from 'kysely';
import { CommandConflictError } from '../errors.js';

export type Control = Selectable<Database['exchange_control']>;

export function fingerprint(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function validateId(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new DomainError('INVALID_ID', 'IDs must be lowercase UUID strings.');
  }
}

export function validateReason(value: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new DomainError('INVALID_REASON', 'Provide a reason of 1 to 500 printable characters.');
  }
  return value.trim();
}

/** All helpers require the caller to hold the installation admission lock. */
export async function loadReceipt(
  tx: Transaction<Database>,
  actorId: string,
  commandId: string,
  hash: string,
): Promise<Record<string, unknown> | null> {
  const row = await tx
    .selectFrom('receipts')
    .selectAll()
    .where('actor_id', '=', actorId)
    .where('command_id', '=', commandId)
    .executeTakeFirst();
  if (!row) return null;
  if (row.payload_hash !== hash) throw new CommandConflictError();
  return row.result;
}

export async function nextSequence(tx: Transaction<Database>, control: Control): Promise<string> {
  await tx
    .updateTable('exchange_control')
    .set({ next_sequence: (BigInt(control.next_sequence) + 1n).toString() })
    .where('id', '=', 1)
    .execute();
  return control.next_sequence;
}

export interface AuditInput {
  actorId: string;
  commandId: string;
  sessionId: string | null;
  action: string;
  targetId: string | null;
  reason: string;
  result: Record<string, unknown>;
}

export async function appendAudit(tx: Transaction<Database>, input: AuditInput): Promise<void> {
  await tx
    .insertInto('admin_audit')
    .values({
      id: randomUUID(),
      actor_id: input.actorId,
      command_id: input.commandId,
      session_id: input.sessionId,
      action: input.action,
      target_id: input.targetId,
      reason: input.reason,
      result: input.result,
    })
    .execute();
}

export async function persistAdminResult(
  tx: Transaction<Database>,
  input: AuditInput & {
    sessionId: string;
    hash: string;
    sequence: string;
  },
): Promise<void> {
  const result = JSON.parse(JSON.stringify(input.result)) as Record<string, unknown>;
  await tx
    .insertInto('receipts')
    .values({
      actor_id: input.actorId,
      command_id: input.commandId,
      session_id: input.sessionId,
      payload_hash: input.hash,
      sequence: input.sequence,
      result,
    })
    .execute();
  await tx
    .insertInto('outbox')
    .values({
      session_id: input.sessionId,
      sequence: input.sequence,
      event_type: input.action,
      payload: { accountId: input.actorId, ...result },
    })
    .execute();
  const session = await tx
    .selectFrom('exchange_sessions')
    .select('id')
    .where('id', '=', input.sessionId)
    .executeTakeFirst();
  await appendAudit(tx, { ...input, sessionId: session?.id ?? null, result });
}
