/** Fence names-only runtimes after adopting the checksum metadata protocol. */
export const MIGRATION_CHECKSUMS_SCHEMA = `
ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL;
ALTER TABLE schema_migrations ALTER COLUMN checksum_origin SET NOT NULL;
ALTER TABLE schema_migrations ALTER COLUMN verified_at SET NOT NULL;
ALTER TABLE schema_migrations ADD CONSTRAINT migration_checksum_format
  CHECK (checksum ~ '^[0-9a-f]{64}$');
ALTER TABLE schema_migrations ADD CONSTRAINT migration_checksum_origin
  CHECK (checksum_origin IN ('APPLIED', 'LEGACY_SCHEMA_VERIFIED'));
`;
