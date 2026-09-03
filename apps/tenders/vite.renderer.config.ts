import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.TENDERS_DEV_PORT) || 5179,
    strictPort: true,
  },
})
