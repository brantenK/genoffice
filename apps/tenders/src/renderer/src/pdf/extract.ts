// In-browser PDF text + coordinate extraction (pdfjs-dist).
// Produces per-page text lines with NORMALIZED bounding boxes (0.0–1.0,
// top-left origin) that the highlight overlay and shredder both consume.
// The legacy build is used so the exact same module runs in Node (tests).
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { BoundingBox, ExtractedPage, PageExtraction, PageLine } from '../../shared/types'
import { normalizePdfText } from './clauses'

let _workerConfigured = false

/**
 * Published import limits.
 *
 * `maxPages: 500` is within the measured envelope: 2 000 pages loaded and
 * parsed in ~2.9 s with ~405 MB peak heap on the reference machine — at/above
 * the limit, so the page guard carries headroom (see
 * `tests/performance/results.json` and `tests/performance/scale.test.ts`, run
 * with `TENDERS_BENCH=1`).
 *
 * `maxBytes: 100 MB` is stress-measured: a 91.6 MB image-heavy document (1
 * native cover + 8 image-only scanned pages) parsed in ~0.66 s with ~133 MB
 * peak heap and ~437 MB peak RSS. File size is a poor memory proxy for
 * TEXT-DENSE PDFs, though: a 5.2 MB / 22 000-line fixture peaked at ~0.9–1.3 GB
 * heap, i.e. ~0.042 MB heap per extracted text line — roughly 24 600 lines at a
 * 1 GB heap budget. A line-count guard is therefore recommended alongside the
 * byte guard.
 *
 * Both figures are reference-machine measurements at the counts above, not
 * proven ceilings on other hardware or at other page/line counts.
 *
 * OCR-heavy input is additionally bounded by the per-page scanned-page count
 * surfaced during extraction (no OCR is performed — scanned pages are flagged
 * and block readiness), so the envelope above is the native/mixed one.
 */
export interface PdfPreflightLimits {
  maxBytes: number
  maxPages: number
}

export const PDF_PREFLIGHT_LIMITS: PdfPreflightLimits = {
  maxBytes: 100 * 1024 * 1024,
  maxPages: 500,
}

export type PdfPreflightCode = 'FILE_TOO_LARGE' | 'TOO_MANY_PAGES'

/** Typed, user-surfaceable rejection for oversize input (raised pre-parse). */
export class PdfPreflightError extends Error {
  readonly code: PdfPreflightCode
  readonly actual: number
  readonly limit: number
  constructor(code: PdfPreflightCode, actual: number, limit: number, message: string) {
    super(message)
    this.name = 'PdfPreflightError'
    this.code = code
    this.actual = actual
    this.limit = limit
  }
}

/** Raised when the user cancels an import; no partial result is returned. */
export class PdfImportCancelledError extends Error {
  readonly code = 'CANCELLED' as const
  constructor(message = 'Import cancelled.') {
    super(message)
    this.name = 'PdfImportCancelledError'
    this.code = 'CANCELLED'
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Reject an over-large file before its buffer is read. */
export function assertPdfBytesWithinLimit(
  bytes: number,
  limits: PdfPreflightLimits = PDF_PREFLIGHT_LIMITS,
): void {
  if (Number.isFinite(bytes) && bytes > limits.maxBytes) {
    throw new PdfPreflightError(
      'FILE_TOO_LARGE',
      bytes,
      limits.maxBytes,
      `This PDF is ${formatBytes(bytes)} — the import limit is ${formatBytes(
        limits.maxBytes,
      )} per file.`,
    )
  }
}

/** Reject an over-long document after its page count is known, before page reads. */
export function assertPdfPagesWithinLimit(
  numPages: number,
  limits: PdfPreflightLimits = PDF_PREFLIGHT_LIMITS,
): void {
  if (Number.isFinite(numPages) && numPages > limits.maxPages) {
    throw new PdfPreflightError(
      'TOO_MANY_PAGES',
      numPages,
      limits.maxPages,
      `This PDF has ${numPages} pages — the import limit is ${limits.maxPages} pages per document.`,
    )
  }
}

/** Must be called once from the browser entry with the bundled worker URL. */
export function configurePdfWorker(src: string): void {
  pdfjs.GlobalWorkerOptions.workerSrc = src
  _workerConfigured = true
}

export async function loadPdfDocument(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  // Copy: pdfjs may detach the buffer (worker transfer).
  const copy = data.slice(0)
  return pdfjs.getDocument({ data: copy }).promise
}

export function clampNormalizedBox(box: BoundingBox): BoundingBox {
  // Coerce non-finite inputs (NaN / ±Infinity) to safe defaults before
  // clamping so a malformed PDF transform can never propagate a value that the
  // v2 schema rejects as INVALID_DATA. Offsets default to 0, extents to 0.
  const rawLeft = Number.isFinite(box.left) ? box.left : 0
  const rawTop = Number.isFinite(box.top) ? box.top : 0
  const rawWidth = Number.isFinite(box.width) ? box.width : 0
  const rawHeight = Number.isFinite(box.height) ? box.height : 0

  const left = Math.max(0, Math.min(1, rawLeft))
  const top = Math.max(0, Math.min(1, rawTop))
  let width = Math.max(0, Math.min(1 - left, Math.max(0, rawWidth)))
  let height = Math.max(0, Math.min(1 - top, Math.max(0, rawHeight)))
  if (left + width > 1) {
    width = Math.max(0, 1 - left)
  }
  if (top + height > 1) {
    height = Math.max(0, 1 - top)
  }
  return { left, top, width, height }
}

export function unionBoxes(boxes: BoundingBox[]): BoundingBox {
  if (boxes.length === 0) return { top: 0, left: 0, width: 0, height: 0 }
  const top = Math.max(0, Math.min(1, Math.min(...boxes.map((b) => b.top))))
  const left = Math.max(0, Math.min(1, Math.min(...boxes.map((b) => b.left))))
  const bottom = Math.max(0, Math.min(1, Math.max(...boxes.map((b) => b.top + b.height))))
  const right = Math.max(0, Math.min(1, Math.max(...boxes.map((b) => b.left + b.width))))
  return clampNormalizedBox({
    top,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  })
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
    const [, , , , /*a*/ /*b*/ /*c*/ /*d*/ e, f] = it.transform
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
      box: clampNormalizedBox({
        top: top / viewport.height,
        left: left / viewport.width,
        width: (right - left) / viewport.width,
        height: (bottom - top) / viewport.height,
      }),
      top,
      left,
      height: bottom - top,
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
    // Normalise Unicode spaces/dashes and OCR punctuation here so every
    // downstream consumer (viewer, clauses, shredder) sees canonical text.
    const text = normalizePdfText(cluster.map((i) => i.str).join(' '))
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
    needsOcr: text.replace(/\s+/g, '').length < 20,
  }
}

export interface ExtractAllPagesOptions {
  /** Abort signal: checked between pages so a cancel takes effect promptly. */
  signal?: AbortSignal
}

/** Extract all pages, reporting progress (1-based page number). */
export async function extractAllPages(
  doc: PDFDocumentProxy,
  onProgress?: (page: number, total: number) => void,
  options: ExtractAllPagesOptions = {},
): Promise<PageExtraction> {
  const signal = options.signal
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new PdfImportCancelledError()
  }

  throwIfAborted()
  const pages: ExtractedPage[] = []
  let textPages = 0
  let ocrPages = 0
  for (let n = 1; n <= doc.numPages; n++) {
    // Cancellation is bounded to one page of work: checked before each page.
    throwIfAborted()
    const page = await doc.getPage(n)
    const ex = await extractSinglePage(page)
    page.cleanup()
    // Discard the page's work entirely rather than returning a partial result.
    throwIfAborted()
    pages.push(ex)
    if (ex.needsOcr) ocrPages += 1
    else textPages += 1
    onProgress?.(n, doc.numPages)
  }
  throwIfAborted()
  return { numPages: doc.numPages, pages, textPages, ocrPages }
}
