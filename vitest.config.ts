import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Node on purpose: proves the package imports and runs without any browser globals.
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'lcov'],
    },
  },
})
