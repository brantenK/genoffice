import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), tailwindcss()],
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
