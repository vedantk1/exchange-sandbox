import { afterEach, describe, expect, it } from 'vitest';
import { createApiFixture, type ApiFixture } from '../helpers/api.js';

describe('explicit deployment proxy boundary', () => {
  let context: ApiFixture | undefined;
  afterEach(async () => {
    await context?.dispose();
  });
  it('ignores spoofed forwarded addresses under the default direct-server configuration', async () => {
    context = await createApiFixture();
    for (let index = 0; index < 19; index++) {
      const response = await context
        .client()
        .request(
          'POST',
          '/api/auth/login',
          { handle: 'operator', password: 'incorrect-test-password' },
          { 'x-forwarded-for': `192.0.2.${index + 1}` },
        );
      expect(response.statusCode).toBe(401);
    }
    const limited = await context
      .client()
      .request(
        'POST',
        '/api/auth/login',
        { handle: 'operator', password: 'incorrect-test-password' },
        { 'x-forwarded-for': '198.51.100.1' },
      );
    expect(limited.statusCode).toBe(429);
  });
  it('separates client authentication limits only when one private proxy hop is explicitly configured', async () => {
    context = await createApiFixture({ proxyHops: 1 });
    for (let index = 0; index < 20; index++) {
      const response = await context
        .client()
        .request(
          'POST',
          '/api/auth/login',
          { handle: 'operator', password: 'incorrect-test-password' },
          { 'x-forwarded-for': '192.0.2.1' },
        );
      expect(response.statusCode).toBe(401);
    }
    const limited = await context
      .client()
      .request(
        'POST',
        '/api/auth/login',
        { handle: 'operator', password: 'incorrect-test-password' },
        { 'x-forwarded-for': '192.0.2.1' },
      );
    expect(limited.statusCode).toBe(429);
    const another = await context
      .client()
      .request(
        'POST',
        '/api/auth/login',
        { handle: 'operator', password: 'incorrect-test-password' },
        { 'x-forwarded-for': '192.0.2.2' },
      );
    expect(another.statusCode).toBe(401);
  });
});
