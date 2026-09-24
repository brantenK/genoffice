// Milestone billing copy honesty.
//
// The audit found two fabricated facts on the milestone surfaces:
//   * `Workspace.tsx` labelled an invoice-less BILLED milestone `INV-2026` — a
//     made-up invoice reference, in a product whose pitch is that it never
//     misreports;
//   * `MilestonesDrawer.tsx` captioned every milestone amount "incl. 15% VAT"
//     although nothing in the document records a tax treatment (the proposal
//     generator says "tax treatment not specified" for exactly that reason).
//
// Like the OCR copy guard, this scans the source text: the strings live in JSX
// and a rendered-component harness deliberately does not exist, so a
// whitespace-collapsed, comment-stripped read is the honest way to fail if the
// claim comes back.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Locate `apps/tenders/src/renderer/src` from the workspace or the repo root. */
function resolveRendererSrc(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const fromRepoRoot = join(dir, 'apps', 'tenders', 'src', 'renderer', 'src')
    if (existsSync(fromRepoRoot)) return fromRepoRoot
    const fromWorkspace = join(dir, 'src', 'renderer', 'src')
    if (existsSync(fromWorkspace)) return fromWorkspace
    dir = dirname(dir)
  }
  throw new Error('Could not locate apps/tenders/src/renderer/src from ' + process.cwd())
}

const SRC = resolveRendererSrc()

const BILLING_SURFACES = ['components/Workspace.tsx', 'components/MilestonesDrawer.tsx']

function readSurface(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8')
}

/** Reduce a source file to the copy a user could actually read. */
function copyText(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1')) // line comments (keep "https://")
    .join(' ')
    .replace(/<[^>]*>/g, ' ') // JSX tags
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Source with comments removed and everything else — code, JSX, string literals
 * — intact. The invoice checks match against this rather than the raw file,
 * because a raw-source regex is satisfied by a comment that merely mentions the
 * pattern (`// never fall back to INV-2026`) and, worse, broken by a comment that
 * documents the removal. `copyText` cannot be used for them: it collapses JSX
 * tags, which would also collapse the `{a || 'b'}` fallback expressions.
 */
function codeText(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

/** A fallback label for the invoice controls: `billedInvoiceNumber || '<label>'`. */
const INVOICE_FALLBACK = /billedInvoiceNumber\s*\|\|\s*'([^']*)'/g

describe('milestone billing copy', () => {
  it('never states a tax treatment the document does not record', () => {
    for (const surface of BILLING_SURFACES) {
      expect(
        copyText(readSurface(surface)),
        `${surface} must not claim a VAT treatment`,
      ).not.toMatch(/\bVAT\b/)
    }
    expect(copyText(readSurface('components/MilestonesDrawer.tsx'))).toContain(
      'Tax treatment not specified',
    )
  })

  it('never invents an invoice reference', () => {
    for (const surface of BILLING_SURFACES) {
      expect(
        codeText(readSurface(surface)),
        `${surface} must not fabricate an invoice number`,
      ).not.toMatch(/INV-\d{4}/)
    }
    // Every `billedInvoiceNumber || '<fallback>'` fallback must read as a label,
    // never as an invoice number. Read from comment-stripped code, so the guard
    // cannot be satisfied by documenting the pattern in a comment.
    const fallbacks = BILLING_SURFACES.flatMap((surface) =>
      [...codeText(readSurface(surface)).matchAll(INVOICE_FALLBACK)].map((match) => match[1]),
    )
    expect(fallbacks.length, 'the invoice buttons keep a fallback label').toBeGreaterThan(0)
    for (const fallback of fallbacks) {
      expect(
        fallback,
        'a fallback must not read as an invoice identifier (no number, no INV-<year>)',
      ).not.toMatch(/INV-\d|\d{4}|invoice\s*(no|number|#)\s*\d/i)
    }
  })

  it('the invoice checks read code, so a comment neither satisfies nor breaks them', () => {
    // The exact pre-fix (HEAD) literals: the checks must reject them, or
    // stripping comments has blunted them.
    const shippedWorkspaceFallback = "{m.billedInvoiceNumber || 'INV-2026'}"
    expect(codeText(shippedWorkspaceFallback)).toMatch(/INV-\d{4}/)
    expect([...codeText(shippedWorkspaceFallback).matchAll(INVOICE_FALLBACK)]).toHaveLength(1)
    expect([...codeText(shippedWorkspaceFallback).matchAll(INVOICE_FALLBACK)][0][1]).toMatch(
      /INV-\d|\d{4}/,
    )
    // A comment that mentions the fabricated label must not fail the check...
    expect(codeText('// the old button said INV-2026\n')).not.toMatch(/INV-\d{4}/)
    // ...and a comment that mentions the fallback pattern must not satisfy it.
    expect([
      ...codeText("/* billedInvoiceNumber || 'View in Books' */").matchAll(INVOICE_FALLBACK),
    ]).toHaveLength(0)
    // The real fallback in code still counts.
    expect(
      [...codeText("billedInvoiceNumber || 'View in Books'").matchAll(INVOICE_FALLBACK)].map(
        (match) => match[1],
      ),
    ).toEqual(['View in Books'])
  })
})
