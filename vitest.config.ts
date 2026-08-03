import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'clients/telegram/tests/**/*.test.ts', 'clients/proposal-reference/tests/**/*.test.ts'],
    pool: 'forks',
  },
});
