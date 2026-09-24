// Render one PDF page to a downscaled image, for a model to read.
//
// The local rule engine cannot read a page that carries no text layer, so such a
// page is either handed to a model as an IMAGE or left unread — and an unread
// page keeps blocking readiness. This module is the image half of that: it
// renders exactly one page, downscaled, and returns base64 the provider layer can
// put straight into a message.
//
// Cost is what the defaults are for. A vision request is billed by the image it
// carries, and a scanned A4 page at native resolution is thousands of pixels on
// its long edge — an order of magnitude more tokens than the same page at 1500
// pixels, for text a model reads just as well. So the defaults are a JPEG capped
// at `DEFAULT_PAGE_IMAGE_MAX_EDGE` on its longest edge, and the byte cost is
// bounded by that cap rather than by the source document. A PNG of a scan is
// lossless and several times larger for no readable gain, which is why JPEG is
// the default and not an option the caller has to remember.
//
// Failure is per page and typed, never fatal: `renderPageImage` rejects with a
// `PageImageError` whose message is safe to show as-is, and the caller records it
// as the reason that page was not read (so it keeps blocking).
//
// Only pdf.js TYPES are imported — no pdf.js at runtime — because the caller
// passes the document it has already parsed. That keeps this module free of
// pdf.js's Node-only legacy build and usable in a plain jsdom test.

import type { PDFDocumentProxy } from 'pdfjs-dist'

/** The encoded type of a rendered page. JPEG keeps a scan's bytes bounded. */
export const PAGE_IMAGE_MIME = 'image/jpeg'

/** Longest edge of a rendered page image, in pixels. */
export const DEFAULT_PAGE_IMAGE_MAX_EDGE = 1500

/** Encoder quality for lossy types (0–1). */
export const DEFAULT_PAGE_IMAGE_QUALITY = 0.7

export interface PageImage {
  /** raw base64 of the encoded image — no `data:` prefix, which is the wire shape */
  base64: string
  /** e.g. `image/jpeg` */
  mime: string
  width: number
  height: number
}

export interface RenderPageImageOptions {
  /** Longest edge of the rendered image, in pixels. Defaults to 1500. Never upscales. */
  maxEdge?: number
  /** Encoded image type. Defaults to JPEG. */
  mime?: string
  /** 0–1 encoder quality for lossy types. Defaults to 0.7. */
  quality?: number
  /** Aborting stops the render and rejects with a `CANCELLED` `PageImageError`. */
  signal?: AbortSignal
}

export type PageImageErrorCode =
  'INVALID_OPTION' | 'NO_CANVAS' | 'RENDER_FAILED' | 'ENCODE_FAILED' | 'CANCELLED'

/**
 * A page that could not be turned into an image. The message is plain language
 * and safe to show as the reason a page was not read — never a stack trace.
 */
export class PageImageError extends Error {
  readonly code: PageImageErrorCode
  constructor(code: PageImageErrorCode, message: string) {
    super(message)
    this.name = 'PageImageError'
    this.code = code
  }
}

function messageOf(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'
  const text = raw.trim()
  return (text.length === 0 ? 'unknown error' : text).slice(0, 200)
}

/**
 * The pixel size a page should be rendered at.
 *
 * Pure, so the cost bound is testable without a canvas: the longest edge is
 * capped at `maxEdge` and the aspect ratio is preserved. A page already inside
 * the cap is returned unchanged — upscaling would multiply the request's bytes
 * without adding a pixel of information.
 */
export function pageImageSize(
  width: number,
  height: number,
  maxEdge: number = DEFAULT_PAGE_IMAGE_MAX_EDGE,
): { width: number; height: number } {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 0
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 0
  if (safeWidth === 0 || safeHeight === 0) return { width: 0, height: 0 }
  const longest = Math.max(safeWidth, safeHeight)
  const scale = longest > maxEdge ? maxEdge / longest : 1
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  }
}

/**
 * Split a canvas data URL into the base64 payload and its mime type.
 *
 * Pure: the encoder's own output is the only thing that decides the mime, so the
 * image's declared type can never disagree with its bytes.
 */
export function decodeDataUrl(dataUrl: string): { base64: string; mime: string } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(typeof dataUrl === 'string' ? dataUrl : '')
  if (!match || match[1] === undefined || match[2] === undefined || match[2].length === 0) {
    throw new PageImageError(
      'ENCODE_FAILED',
      'The rendered page could not be encoded as an image, so no model could read it.',
    )
  }
  return { mime: match[1], base64: match[2] }
}

function resolveMaxEdge(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_IMAGE_MAX_EDGE
  if (!Number.isFinite(value) || value < 1) {
    throw new PageImageError('INVALID_OPTION', 'maxEdge must be a finite number of at least 1.')
  }
  return Math.floor(value)
}

function resolveQuality(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_IMAGE_QUALITY
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new PageImageError('INVALID_OPTION', 'quality must be a number above 0 and at most 1.')
  }
  return value
}

function resolveMime(value: string | undefined): string {
  if (value === undefined) return PAGE_IMAGE_MIME
  const mime = value.trim()
  if (mime.length === 0) {
    throw new PageImageError('INVALID_OPTION', 'mime must be a non-empty image type.')
  }
  return mime
}

/** A detached canvas, or null where this build cannot draw one (no DOM). */
function createCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/**
 * Render one page of an already-parsed document to a downscaled image.
 *
 * Rejects with a `PageImageError` — never silently returns a blank or full-size
 * image — when the page cannot be rendered, encoded, or when the run is
 * cancelled. `page.cleanup()` always runs, so a vision pass over many pages does
 * not hold every rendered page's resources.
 */
export async function renderPageImage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  options: RenderPageImageOptions = {},
): Promise<PageImage> {
  const maxEdge = resolveMaxEdge(options.maxEdge)
  const quality = resolveQuality(options.quality)
  const mime = resolveMime(options.mime)
  const signal = options.signal

  const throwIfAborted = (): void => {
    if (signal?.aborted === true) {
      throw new PageImageError(
        'CANCELLED',
        'The page image was not rendered because the run was cancelled.',
      )
    }
  }
  throwIfAborted()

  const page = await doc.getPage(pageNumber)
  let task: { promise: Promise<void>; cancel: () => void } | null = null
  try {
    throwIfAborted()
    const base = page.getViewport({ scale: 1 })
    const size = pageImageSize(base.width, base.height, maxEdge)
    if (size.width === 0 || size.height === 0) {
      throw new PageImageError(
        'RENDER_FAILED',
        `Page ${pageNumber} reported no size, so no image could be rendered for it.`,
      )
    }
    const viewport = page.getViewport({ scale: size.width / base.width })
    const canvas = createCanvas(size.width, size.height)
    if (!canvas) {
      throw new PageImageError(
        'NO_CANVAS',
        'This build cannot draw a page image, so no model could read a page without a text layer.',
      )
    }
    const context = canvas.getContext('2d')
    if (!context) {
      throw new PageImageError(
        'NO_CANVAS',
        'This build cannot draw a page image, so no model could read a page without a text layer.',
      )
    }
    // A PDF page is transparent wherever it has no content, and a JPEG has no
    // alpha channel: an unpainted canvas would encode those areas black. Paint
    // the paper first so the model sees the page, not a black rectangle.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)

    const onAbort = (): void => {
      try {
        task?.cancel()
      } catch {
        // Already finished: cancelling is best-effort.
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      task = page.render({ canvasContext: context, canvas, viewport })
      await task.promise
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    throwIfAborted()

    const encoded = decodeDataUrl(canvas.toDataURL(mime, quality))
    return {
      base64: encoded.base64,
      mime: encoded.mime,
      width: canvas.width,
      height: canvas.height,
    }
  } catch (error) {
    if (error instanceof PageImageError) throw error
    if (signal?.aborted === true) {
      throw new PageImageError(
        'CANCELLED',
        'The page image was not rendered because the run was cancelled.',
      )
    }
    throw new PageImageError(
      'RENDER_FAILED',
      `Page ${pageNumber} could not be rendered to an image (${messageOf(error)}).`,
    )
  } finally {
    try {
      page.cleanup()
    } catch {
      // Releasing a page's resources is best-effort; it never changes the result.
    }
  }
}
