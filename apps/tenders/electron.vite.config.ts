import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@genoffice/i18n', '@genoffice/electron-utils'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@genoffice/i18n', '@genoffice/electron-utils'] })],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
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
