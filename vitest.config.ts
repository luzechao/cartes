import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Fixtures are data, not tests.
    exclude: ['node_modules/**', 'test/fixtures/**'],
  },
})
