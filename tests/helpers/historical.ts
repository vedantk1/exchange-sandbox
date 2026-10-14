import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AdminCommand, AdminResult } from '../../apps/server/src/admin/service.js';
import type {
  CancelCommand,
  CommandResult,
  LimitCommand,
  MarketCommand,
} from '../../apps/server/src/types.js';

interface HistoricalManifest {
  sourceCommit: string;
  installationSha256: string;
  expectationsSha256: string;
  migrationStatements: { name: string; sha256: string }[];
  rows: Record<string, number>;
}

interface HistoricalExpectations {
  seller: string;
  buyer: string;
  operator: { accountId: string; handle: string; role: 'ADMIN'; sessionId: string };
  archivedSessionId: string;
  sessionId: string;
  commands: {
    archivedSell: LimitCommand;
    archivedBuy: LimitCommand;
    rollover: AdminCommand;
    buy: LimitCommand;
    cancel: CancelCommand;
    market: MarketCommand;
    partialMarket: MarketCommand;
  };
  results: {
    archivedSell: CommandResult;
    archivedBuy: CommandResult;
    rollover: AdminResult;
    buy: CommandResult;
    cancel: CommandResult;
    market: CommandResult;
    partialMarket: CommandResult;
  };
  orderIds: {
    partial: string;
    filled: string;
    open: string;
    canceled: string;
    market: string;
    partialMarket: string;
  };
}

/** Read committed historical bytes; never reconstruct them from current SQL. */
export async function frozen008Installation() {
  const directory = 'tests/fixtures/historical/008';
  const [sql, expectationsJson, manifestJson] = await Promise.all([
    readFile(`${directory}/installation.sql`, 'utf8'),
    readFile(`${directory}/expectations.json`, 'utf8'),
    readFile(`${directory}/manifest.json`, 'utf8'),
  ]);
  const manifest = JSON.parse(manifestJson) as HistoricalManifest;
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  if (
    sha256(sql) !== manifest.installationSha256 ||
    sha256(expectationsJson) !== manifest.expectationsSha256
  )
    throw new Error('Frozen008 fixture bytes do not match the reviewed provenance manifest.');
  return { sql, manifest, expected: JSON.parse(expectationsJson) as HistoricalExpectations };
}
