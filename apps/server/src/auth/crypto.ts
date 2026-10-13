import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';
import { AuthError } from './errors.js';

// Four hashes use at most 256 MiB of Argon2 working memory. Reject excess work
// rather than allowing an unbounded queue of expensive password operations.
let passwordWork = 0;

async function bounded<T>(work: () => Promise<T>): Promise<T> {
  if (passwordWork >= 4)
    throw new AuthError('AUTH_BUSY', 'Authentication is busy; retry shortly.', 503);
  passwordWork += 1;
  try {
    return await work();
  } finally {
    passwordWork -= 1;
  }
}

export function canonicalHandle(handle: string): string {
  if (
    typeof handle !== 'string' ||
    handle.length < 3 ||
    handle.length > 32 ||
    !/^[a-zA-Z]/.test(handle) ||
    /[^a-zA-Z0-9_]/.test(handle)
  )
    throw new AuthError(
      'INVALID_HANDLE',
      'Use 3–32 letters, digits, or underscores, starting with a letter.',
    );
  return handle.toLowerCase();
}

export function validatePassword(password: string): void {
  if (
    typeof password !== 'string' ||
    [...password].length < 12 ||
    [...password].length > 128 ||
    Buffer.byteLength(password, 'utf8') > 512
  )
    throw new AuthError('INVALID_PASSWORD', 'Use a password between 12 and 128 characters.');
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  return bounded(() =>
    hash(password, { type: argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 }),
  );
}

let dummyHash: Promise<string> | undefined;

export async function verifyPassword(
  encoded: string | undefined,
  password: string,
): Promise<boolean> {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 512) return false;
  // Missing handles perform the same expensive verification as existing ones.
  // No supplied password or generated dummy secret is retained in storage.
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url')).catch((error: unknown) => {
    dummyHash = undefined;
    throw error;
  });
  const fallback = await dummyHash;
  const matches = await bounded(() => verify(encoded ?? fallback, password));
  return encoded !== undefined && matches;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string | null {
  if (typeof token !== 'string' || token.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(token))
    return null;
  return createHash('sha256').update(token).digest('hex');
}

export function equalHash(left: string, right: string): boolean {
  return left.length === 64 &&
    right.length === 64 &&
    /^[a-f0-9]{64}$/.test(left) &&
    /^[a-f0-9]{64}$/.test(right)
    ? timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
    : false;
}
