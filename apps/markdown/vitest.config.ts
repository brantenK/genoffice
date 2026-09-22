import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
    // 60s, not upstream's 20s: this checkout lives on a OneDrive-synced disk, so
    // a full-workspace run is several times slower than an isolated one and the
    // 20s budget turns passing tests red (see fork/TRIAGE.md).
    testTimeout: 60000,
    setupFiles: ['tests/setup.ts'],
  },
})
