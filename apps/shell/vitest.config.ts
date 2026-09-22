import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 60s, not upstream's 20s: OneDrive-synced disk, so the full-workspace run is
    // much slower than an isolated one and the 20s budget turns passing tests red
    // (see fork/TRIAGE.md).
    testTimeout: 60000,
  },
})
