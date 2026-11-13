import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/unit/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'dist-test/**', 'test/integration/**', 'test/live/**'],
    // Many tests start real processes or walk real folders. Run in parallel on a busy machine they
    // can take several times longer than alone, so the limit is generous; a hang still fails.
    testTimeout: 30_000,
  },
});
