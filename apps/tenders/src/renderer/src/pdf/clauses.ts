// Clause reconstruction: PDF text extraction emits one "line" per visual row,
// so a single sentence is typically split across several lines (the demo RFP
// wraps at ~88 characters). Scoring lines individually under-weights clauses
// whose mandatory keywords ("must", "shall"), dates or address tails land on
// a continuation line. This module stitches consecutive lines into
// sentence-level clause units consumed by the shredder and the logistics
// extractor.
import type { BoundingBox, ExtractedPage, PageExtraction, PageLine } from '../../shared/types'

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

const UNICODE_SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g
const UNICODE_DASHES = /[\u2010-\u2015\u2212\u2043]/g

/**
 * Normalise PDF/OCR text before it is matched. Handles the two recurring
 * sources of parser misses: Unicode whitespace/dash punctuation and OCR
 * substitutions (curly quotes, ellipsis, ligatures, table tab/pipe runs).
 * Deliberately conservative: it never invents or deletes semantic content
 * (sentence punctuation, digits and words are preserved) so determinism and
 * "unknown stays unknown" both hold.
 */
export function normalizePdfText(input: string): string {
  if (!input) return ''
  return (
    input
      .normalize('NFKC')
      .replace(ZERO_WIDTH, '')
      .replace(UNICODE_SPACES, ' ')
      .replace(UNICODE_DASHES, '-')
      .replace(/\u2026/g, '...')
      .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
      .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
      .replace(/\t+/g, ' ')
      // table-like text: pipe/tab cell separators become a plain space so
      // patterns can span cells instead of being broken by the glyph.
      .replace(/\s*\|\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
  )
}

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
    const text = normalizePdfText(current.map((l) => l.text).join(' '))
    if (text.length >= 8) {
      clauses.push({
        text,
        pageNumber: page.pageNumber,
        box: current.map((l) => l.box).reduce(unionBox),
        lines: current,
      })
    }
    current = []
  }

  for (const line of page.lines) {
    const t = normalizePdfText(line.text)
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
    const joinedLen = current.reduce((n, l) => n + normalizePdfText(l.text).length + 1, 0)
    if (endsSentence(t) || joinedLen >= MAX_CLAUSE_CHARS) flush()
  }
  flush()
  return clauses
}

/** Fraction of the page height treated as the running header/footer band. */
const HEADER_FOOTER_BAND = 0.18

/** Digits collapse so "Page 3 of 20" and "Page 4 of 20" share one key. */
function boilerplateKey(text: string): string {
  const key = normalizePdfText(text).toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
  // Running headers/footers are short labels, not sentences: cap the length and
  // ignore lines that end a sentence so repeated body text is never stripped.
  if (key.length < 3 || key.length > 60 || /[.!?]$/.test(key)) return ''
  return key
}

function inHeaderFooterBand(line: PageLine): boolean {
  return (
    line.box.top <= HEADER_FOOTER_BAND || line.box.top + line.box.height >= 1 - HEADER_FOOTER_BAND
  )
}

/**
 * A line is running boilerplate when the same digit-normalised short label
 * repeats in the header/footer band across at least half the pages (min two).
 * Only those band lines are removed; body text is never touched. Requires at
 * least three pages so a two-page document's top-of-page body text is safe.
 * Page-1 letterhead is read directly by the issuer extractor, so suppressing
 * its repeated running copy here cannot hide the authority.
 */
function repeatedBoilerplate(pages: ExtractedPage[]): Set<string> {
  const repeated = new Set<string>()
  if (pages.length < 3) return repeated
  const keyPages = new Map<string, Set<number>>()
  for (const page of pages) {
    for (const line of page.lines) {
      if (!inHeaderFooterBand(line)) continue
      const key = boilerplateKey(line.text)
      if (!key) continue
      const set = keyPages.get(key) ?? new Set<number>()
      set.add(page.pageNumber)
      keyPages.set(key, set)
    }
  }
  const minPages = Math.max(2, Math.ceil(pages.length * 0.5))
  for (const [key, set] of keyPages) {
    if (set.size >= minPages) repeated.add(key)
  }
  return repeated
}

/** Reconstruct sentence-level clauses for the whole document, in page order. */
export function buildClauses(ex: PageExtraction): Clause[] {
  const repeated = repeatedBoilerplate(ex.pages)
  if (repeated.size === 0) return ex.pages.flatMap(pageClauses)
  return ex.pages.flatMap((page) => {
    const lines = page.lines.filter(
      (line) => !inHeaderFooterBand(line) || !repeated.has(boilerplateKey(line.text)),
    )
    return pageClauses(lines.length === page.lines.length ? page : { ...page, lines })
  })
}
