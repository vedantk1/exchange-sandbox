import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/domain/test/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
      'tests/unit/**/*.test.ts',
    ],
    testTimeout: 15_000,
  },
});
