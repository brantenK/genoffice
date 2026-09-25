import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './components/App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { configurePdfWorker } from './pdf/extract'
import './styles/tenders.css'
import './styles/responsive.css'

// Bundle the pdfjs worker as a Vite asset (?url) and hand its URL to pdfjs.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
configurePdfWorker(workerUrl)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* The last line of defence. There is a second boundary inside `App` around
        the page area, so a crash in one view keeps the sidebar and its
        navigation; this one covers everything that boundary does not — the
        sidebar, the modals, the tour — and anything thrown while rendering the
        shell itself. Neither can catch an error in an event handler or an async
        callback (React catches only render, lifecycle and effect throws), which
        is why every cross-app call already reports its own failure visibly. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
