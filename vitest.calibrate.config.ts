import { defineConfig } from 'vitest/config';

// Long-running headless simulation used to tune the economy. Not part of `npm test`.
export default defineConfig({
  test: {
    include: ['scripts/**/*.calibrate.ts'],
    environment: 'node',
    testTimeout: 900_000,
  },
});
