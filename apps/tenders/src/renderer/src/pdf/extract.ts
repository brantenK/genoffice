// In-browser PDF text + coordinate extraction (pdfjs-dist).
// Produces per-page text lines with NORMALIZED bounding boxes (0.0–1.0,
// top-left origin) that the highlight overlay and shredder both consume.
// The legacy build is used so the exact same module runs in Node (tests).
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { BoundingBox, ExtractedPage, PageExtraction, PageLine } from '../../shared/types'

let workerConfigured = false

/** Must be called once from the browser entry with the bundled worker URL. */
export function configurePdfWorker(src: string): void {
  pdfjs.GlobalWorkerOptions.workerSrc = src
  workerConfigured = true
}

export async function loadPdfDocument(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  // Copy: pdfjs may detach the buffer (worker transfer).
  const copy = data.slice(0)
  return pdfjs.getDocument({ data: copy }).promise
}

function unionBoxes(boxes: BoundingBox[]): BoundingBox {
  const top = Math.min(...boxes.map((b) => b.top))
  const left = Math.min(...boxes.map((b) => b.left))
  const bottom = Math.max(...boxes.map((b) => b.top + b.height))
  const right = Math.max(...boxes.map((b) => b.left + b.width))
  return { top, left, width: right - left, height: bottom - top }
}

/** Extract text items + normalized line boxes from a single page. */
export async function extractSinglePage(page: PDFPageProxy): Promise<ExtractedPage> {
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()

  interface Item {
    str: string
    box: BoundingBox
    top: number
    left: number
    height: number
  }
  const items: Item[] = []

  for (const raw of content.items) {
    const it = raw as { str?: string; transform?: number[]; width?: number; height?: number }
    if (!it.str || !it.str.trim() || !it.transform) continue
    const [/*a*/, /*b*/, /*c*/, /*d*/, e, f] = it.transform
    const w = it.width ?? 0
    const h = it.height ?? 0
    if (w <= 0 || h <= 0) continue

    // Map the PDF-space rect through the viewport transform (handles rotation),
    // then normalize against viewport dimensions. NOTE: pdfjs v6 applyTransform
    // mutates the point array in place (returns void).
    const p1 = [e, f] as [number, number]
    const p2 = [e + w, f + h] as [number, number]
    pdfjs.Util.applyTransform(p1, viewport.transform)
    pdfjs.Util.applyTransform(p2, viewport.transform)
    const left = Math.min(p1[0], p2[0])
    const right = Math.max(p1[0], p2[0])
    const top = Math.min(p1[1], p2[1])
    const bottom = Math.max(p1[1], p2[1])

    items.push({
      str: it.str,
      box: {
        top: top / viewport.height,
        left: left / viewport.width,
        width: (right - left) / viewport.width,
        height: (bottom - top) / viewport.height
      },
      top,
      left,
      height: bottom - top
    })
  }

  // Cluster items into visual lines by top coordinate.
  items.sort((a, b) => a.top - b.top || a.left - b.left)
  const lines: PageLine[] = []
  let cluster: Item[] = []
  let clusterTop = 0

  const flush = () => {
    if (cluster.length === 0) return
    cluster.sort((a, b) => a.left - b.left)
    const text = cluster
      .map((i) => i.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length > 0) {
      lines.push({ pageNumber: page.pageNumber, text, box: unionBoxes(cluster.map((i) => i.box)) })
    }
    cluster = []
  }

  for (const it of items) {
    if (cluster.length === 0) {
      cluster.push(it)
      clusterTop = it.top
      continue
    }
    const tolerance = Math.max(2, Math.min(it.height, cluster[0].height) * 0.5)
    if (Math.abs(it.top - clusterTop) <= tolerance) {
      cluster.push(it)
    } else {
      flush()
      cluster.push(it)
      clusterTop = it.top
    }
  }
  flush()

  const text = lines.map((l) => l.text).join('\n')
  return {
    pageNumber: page.pageNumber,
    width: viewport.width,
    height: viewport.height,
    text,
    lines,
    needsOcr: text.replace(/\s+/g, '').length < 20
  }
}

/** Extract all pages, reporting progress (1-based page number). */
export async function extractAllPages(
  doc: PDFDocumentProxy,
  onProgress?: (page: number, total: number) => void
): Promise<PageExtraction> {
  const pages: ExtractedPage[] = []
  let textPages = 0
  let ocrPages = 0
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const ex = await extractSinglePage(page)
    pages.push(ex)
    if (ex.needsOcr) ocrPages += 1
    else textPages += 1
    page.cleanup()
    onProgress?.(n, doc.numPages)
  }
  return { numPages: doc.numPages, pages, textPages, ocrPages }
}
