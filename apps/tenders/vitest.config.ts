import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  root: local('.'),
  resolve: {
    alias: {
      '@genoffice/docx-engine': local('../../packages/docx-engine/src/index.ts'),
      '@genoffice/electron-utils': local('../../packages/electron-utils/src/index.ts'),
      '@genoffice/project-store': local('../../packages/project-store/src/index.ts'),
      '@genoffice/i18n': local('../../packages/i18n/src/index.ts'),
      '@genoffice/ui': local('../../packages/ui/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
    testTimeout: 20000,
  },
})
