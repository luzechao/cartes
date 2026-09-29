import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Fixtures are data, not tests.
    exclude: ['node_modules/**', 'test/fixtures/**'],
    // Many tests sweep the whole 182-file corpus. They take 1-3 s locally and about 2.5x that on
    // a shared CI runner, which vitest's 5 s default does not allow for. Tests that run EnergyPlus
    // set their own, longer limits.
    testTimeout: 30_000,
  },
})
