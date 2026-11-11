import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.js'], testTimeout: 60000, hookTimeout: 120000 },
});
