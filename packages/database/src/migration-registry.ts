import { createHash } from 'node:crypto';
import { INITIAL_SCHEMA } from './schema.js';
import { IDENTITY_SCHEMA } from './identity-schema.js';
import { DEMO_MARKET_SCHEMA } from './demo-market-schema.js';
import { SIMULATOR_CONTROLS_SCHEMA } from './simulator-controls-schema.js';
import { MARKET_ORDERS_SCHEMA } from './market-orders-schema.js';
import { SESSION_LIFECYCLE_SCHEMA } from './session-lifecycle-schema.js';
import { COMMAND_TIMESTAMP_SCHEMA } from './command-timestamp-schema.js';
import { ORDER_INTEGRITY_SCHEMA } from './order-integrity-schema.js';
import { LARGE_SESSION_SCHEMA } from './large-session-schema.js';
import { MIGRATION_CHECKSUMS_SCHEMA } from './migration-checksums-schema.js';

export interface MigrationDefinition {
  readonly name: string;
  readonly statement: string;
  readonly checksum: string;
}

/** SHA-256 pins the exact UTF-8 SQL, including whitespace, from published migrations. */
export const MIGRATIONS: readonly MigrationDefinition[] = Object.freeze(
  [
    {
      name: '001_exchange_core',
      statement: INITIAL_SCHEMA,
      checksum: 'c68425a2cebced691c6d6ae00fdaab7ca9b5a2226b3c152cabb2e9f27872990a',
    },
    {
      name: '002_identity_and_controls',
      statement: IDENTITY_SCHEMA,
      checksum: '6743abd9dbde236e4dae3f8791121c289d8c0f6ffb2bd6aefcca23c6b08903c3',
    },
    {
      name: '003_demo_market',
      statement: DEMO_MARKET_SCHEMA,
      checksum: '1029048650bced15cb322d629c63c3b4ac9160f4da4fd811217ce509371f76d3',
    },
    {
      name: '004_simulator_controls',
      statement: SIMULATOR_CONTROLS_SCHEMA,
      checksum: '999115fbf363c5115debcfb4f1b3cd3490b724f120107d8a9104a502fa06939e',
    },
    {
      name: '005_market_orders',
      statement: MARKET_ORDERS_SCHEMA,
      checksum: 'a8319ab12032a42f5320de51f8245d5fa21b36dfd6df5e1b10d6570e7f68b488',
    },
    {
      name: '006_session_lifecycle',
      statement: SESSION_LIFECYCLE_SCHEMA,
      checksum: 'fe5c45fe494958066491e8f0b44ab616bce63cb3a045c664f470cb18de652a66',
    },
    {
      name: '007_command_timestamps',
      statement: COMMAND_TIMESTAMP_SCHEMA,
      checksum: 'b06a1dc7bd21c298f02fb1e90f330617402b116e72dc7eff72f2770c652fb742',
    },
    {
      name: '008_order_integrity',
      statement: ORDER_INTEGRITY_SCHEMA,
      checksum: 'a5a296564e7b9e964d6f90e65a56cbe2c0edf2d73e5f8a1692217d74baba946e',
    },
    {
      name: '009_large_session_reads',
      statement: LARGE_SESSION_SCHEMA,
      checksum: '6d6699e900cb3325295b9c4186d4f9aa76d7fd8263766dcb0a58d8a98b460b7d',
    },
    {
      name: '010_migration_checksums',
      statement: MIGRATION_CHECKSUMS_SCHEMA,
      checksum: '6ca1d2ea4be9829fcff56206e7522471621b945c74daf1192a339574d973a6e0',
    },
  ].map((migration) => Object.freeze(migration)),
);

export function migrationError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Validate source before even opening a migration transaction. */
export function verifyMigrationSources(
  migrations: readonly MigrationDefinition[] = MIGRATIONS,
): void {
  for (const migration of migrations) {
    const actual = createHash('sha256').update(migration.statement, 'utf8').digest('hex');
    if (actual !== migration.checksum)
      throw migrationError(
        'MIGRATION_SOURCE_MISMATCH',
        `Migration SQL does not match its pinned checksum: ${migration.name}`,
      );
  }
}

/** Applied names must be an exact prefix; sorting is independent of timestamps. */
export function verifyMigrationNames(names: readonly string[]): number {
  const ordered = [...names].sort();
  const known = new Set(MIGRATIONS.map(({ name }) => name));
  for (const name of ordered) {
    if (!known.has(name))
      throw migrationError(
        'MIGRATION_HISTORY_INVALID',
        `Database has unsupported migration: ${name}`,
      );
  }
  if (ordered.some((name, index) => name !== MIGRATIONS[index]?.name))
    throw migrationError(
      'MIGRATION_HISTORY_INVALID',
      'Database migration history is not a contiguous known prefix.',
    );
  return ordered.length;
}
