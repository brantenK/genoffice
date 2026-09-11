import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './components/App'
import { configurePdfWorker } from './pdf/extract'
import './styles/tenders.css'

// Bundle the pdfjs worker as a Vite asset (?url) and hand its URL to pdfjs.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
configurePdfWorker(workerUrl)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
