import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/domain/test/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
