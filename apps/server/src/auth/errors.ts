export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function unauthenticated(): AuthError {
  return new AuthError('AUTHENTICATION_REQUIRED', 'Sign in with an active account.', 401);
}
