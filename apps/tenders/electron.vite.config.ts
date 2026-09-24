import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Workspace packages resolve from THIS checkout's sources (the precedent is
// apps/docs/electron.vite.config.ts): in a git worktree node_modules is a
// symlink into the main checkout, so a bare specifier would bundle that
// checkout's — possibly stale — code. `src/renderer/src/intake/docx.ts` imports
// `@genoffice/docx-engine`, so without this the packaged renderer cannot bundle
// a Word import. Keep in sync with vite.renderer.config.ts (the dev server).
const localAlias = {
  '@genoffice/docx-engine': resolve(__dirname, '../../packages/docx-engine/src/index.ts'),
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@genoffice/i18n', '@genoffice/electron-utils'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@genoffice/i18n', '@genoffice/electron-utils'] })],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: { alias: localAlias },
    // electron-vite's renderer root is src/renderer, so vite's default publicDir
    // (src/renderer/public) is empty and the build emitted no demo/ at all:
    // "Load demo RFP" fetches ./demo/sample-rfp.pdf and the sample workspace's
    // vault documents live under demo/vault/, so neither was ever shipped. The
    // assets are in apps/tenders/public and must be copied into out/renderer.
    publicDir: resolve(__dirname, 'public'),
    server: {
      port: Number(process.env.TENDERS_DEV_PORT) || 5179,
      strictPort: Boolean(process.env.TENDERS_DEV_PORT),
    },
  },
})
