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
    // `.tsx` specs are component tests: they render the real renderer surfaces
    // through `tests/helpers/render.tsx` (react-dom/client + act, no test library).
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'jsdom',
    testTimeout: 20000,
  },
})
