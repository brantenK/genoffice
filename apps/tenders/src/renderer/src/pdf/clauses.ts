// Clause reconstruction: PDF text extraction emits one "line" per visual row,
// so a single sentence is typically split across several lines (the demo RFP
// wraps at ~88 characters). Scoring lines individually under-weights clauses
// whose mandatory keywords ("must", "shall"), dates or address tails land on
// a continuation line. This module stitches consecutive lines into
// sentence-level clause units consumed by the shredder and the logistics
// extractor.
import type {
  BoundingBox,
  ExtractedPage,
  PageExtraction,
  PageLine
} from '../../shared/types'

export interface Clause {
  /** full joined sentence text */
  text: string
  pageNumber: number
  /** union of the member line boxes — highlights the whole clause */
  box: BoundingBox
  /** member lines in reading order */
  lines: PageLine[]
}

/** wrap-joined sentences longer than this are split to stay quotable */
const MAX_CLAUSE_CHARS = 600

/** numbered / lettered / bulleted list items start a new clause */
const STARTS_BLOCK_RE = /^(?:[-•*·]|\d{1,2}[.)]|[a-z][.)])\s+/

function unionBox(a: BoundingBox, b: BoundingBox): BoundingBox {
  const left = Math.min(a.left, b.left)
  const top = Math.min(a.top, b.top)
  const right = Math.max(a.left + a.width, b.left + b.width)
  const bottom = Math.max(a.top + a.height, b.top + b.height)
  return { top, left, width: right - left, height: bottom - top }
}

function endsSentence(text: string): boolean {
  return /[.!?]["')\]]?$/.test(text.trim())
}

/** ALL-CAPS heading / label lines end the current clause and stand alone. */
function isHeading(text: string): boolean {
  const t = text.trim()
  if (t.length < 4 || t.length > 90) return false
  const letters = t.replace(/[^A-Za-z]/g, '')
  if (letters.length < 4) return false
  const upper = t.replace(/[^A-Z]/g, '').length
  return upper / letters.length > 0.7
}

/** vertical gap between two lines — big gaps (paragraph breaks) split clauses.
 *  Box coords are normalized 0–1 over the page, so thresholds are relative. */
function largeGap(prev: PageLine, next: PageLine): boolean {
  const prevBottom = prev.box.top + prev.box.height
  return next.box.top - prevBottom > prev.box.height * 2.5
}

/** Reconstruct sentence-level clauses for one page. */
export function pageClauses(page: ExtractedPage): Clause[] {
  const clauses: Clause[] = []
  let current: PageLine[] = []

  const flush = () => {
    if (current.length === 0) return
    const text = current
      .map((l) => l.text.trim())
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
    if (text.length >= 8) {
      clauses.push({
        text,
        pageNumber: page.pageNumber,
        box: current.map((l) => l.box).reduce(unionBox),
        lines: current
      })
    }
    current = []
  }

  for (const line of page.lines) {
    const t = line.text.trim()
    if (t.length === 0) {
      flush()
      continue
    }
    if (current.length > 0) {
      const prev = current[current.length - 1]
      if (isHeading(t) || largeGap(prev, line) || STARTS_BLOCK_RE.test(t)) flush()
    }
    // headings stand alone — they are labels, not clause text
    if (isHeading(t)) {
      clauses.push({ text: t, pageNumber: page.pageNumber, box: line.box, lines: [line] })
      continue
    }
    current.push(line)
    const joinedLen = current.reduce((n, l) => n + l.text.length + 1, 0)
    if (endsSentence(t) || joinedLen >= MAX_CLAUSE_CHARS) flush()
  }
  flush()
  return clauses
}

/** Reconstruct sentence-level clauses for the whole document, in page order. */
export function buildClauses(ex: PageExtraction): Clause[] {
  return ex.pages.flatMap(pageClauses)
}
