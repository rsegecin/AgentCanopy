import { defineConfig } from 'vitest/config';

// The live suite talks to the real Claude Code CLI on the signed-in account. It only runs through
// `npm run test:live`, never as part of `npm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/live/**/*.test.ts'],
    testTimeout: 180_000,
    fileParallelism: false,
  },
});
