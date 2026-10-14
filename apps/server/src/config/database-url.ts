import { readFile } from 'node:fs/promises';

/** Secret file support keeps deployment credentials out of Compose/environment files. */
export async function configuredDatabaseUrl(): Promise<string> {
  const direct = process.env.DATABASE_URL;
  const path = process.env.DATABASE_URL_FILE;
  if (direct && path) throw new Error('Choose exactly one database URL source.');
  const value = direct ?? (path ? (await readFile(path, 'utf8')).trim() : undefined);
  if (!value) throw new Error('DATABASE_URL or DATABASE_URL_FILE is required.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('The database URL must use PostgreSQL.');
  return value;
}
