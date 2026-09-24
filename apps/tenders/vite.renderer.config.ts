import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Workspace packages resolve from THIS checkout's sources, the way
// apps/docs/electron.vite.config.ts does it: node_modules may be a symlink into
// another checkout (a git worktree), where the bare specifier would silently
// bundle that checkout's — possibly stale — code. The .docx intake imports
// `@genoffice/docx-engine` (src/renderer/src/intake/docx.ts), so this alias is
// what makes a Word import resolve in the renderer at all. Keep in sync with
// electron.vite.config.ts, which builds the packaged renderer.
const localAlias = {
  '@genoffice/docx-engine': resolve(__dirname, '../../packages/docx-engine/src/index.ts'),
}

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), tailwindcss()],
  resolve: { alias: localAlias },
  // The demo RFP and the demo vault PDFs are fetched at runtime from demo/*, so
  // they must be served in dev too (vite's default publicDir would be
  // src/renderer/public, which does not exist). Keep in sync with
  // electron.vite.config.ts, which copies the same directory into out/renderer.
  publicDir: resolve(__dirname, 'public'),
  server: {
    port: Number(process.env.TENDERS_DEV_PORT) || 5179,
    strictPort: true,
  },
})
