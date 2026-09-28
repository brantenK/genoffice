import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildInvoicePdf } from '../src/shared/invoice-pdf'
import { migrateAndValidateBooks } from '../src/main/books-core'
import { DEFAULT_INVOICE_ACCENT, isValidInvoiceAccent } from '../src/shared/chart'
import type { CompanySettings, Invoice } from '../src/shared/types'

/**
 * Locks for the print templates + letterhead feature:
 * - the classic template's drawn output is byte-for-byte unchanged by the new
 *   settings being stamped on (the migration default must not move a pixel);
 * - classic vs modern are structurally different PDFs (the modern band draws
 *   white text classic never does, and the accent fill only appears where the
 *   template allows it);
 * - the letterhead footer reaches the drawn PDF text in both templates, and
 *   an over-long footer is clipped instead of colliding with the page marker;
 * - both templates keep the page furniture (page numbers, footer, repeated
 *   table header) on every page;
 * - the migration stamps and repairs the print settings.
 *
 * Assertions read the real content streams: every FlateDecode stream is
 * inflated and its `<hex> Tj` text tokens are decoded in place, so both the
 * drawn text and the colour operators (`rg`/`RG`) are visible — the
 * technique of tests/pdf-and-invariants.test.ts, minus the raw file shell so
 * byte comparisons are never affected by embedded creation timestamps.
 */

const SETTINGS: CompanySettings = {
  companyName: 'Zano Consulting (Pty) Ltd',
  taxNumber: 'VAT 4510278912',
  currency: 'ZAR',
  currencySymbol: 'R',
  financialYearStart: '2026-03-01',
  address: '12 Albert Road, Johannesburg',
  email: 'accounts@zanostack.com',
  phone: '+27 11 555 0199',
}

/** Short enough for the classic footer to append it without clipping. */
const LETTERHEAD_SHORT = 'Zano Consulting · VAT 4510278912'
/** Longer than a footer line: exercises the clip path. */
const LETTERHEAD_LONG =
  'Zano Consulting (Pty) Ltd · Reg 2016/123456/07 · 12 Albert Road, Johannesburg'

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'tpl-1',
    invoiceNumber: 'INV-2026-0042',
    type: 'Sales',
    partyId: 'party-1',
    partyName: 'Rand Water Authority',
    date: '2026-09-01',
    dueDate: '2026-10-01',
    items: [
      {
        id: 'i1',
        itemCode: 'C-1',
        description: 'Water infrastructure consulting',
        accountId: 'acc-sales',
        accountName: 'Sales',
        qty: 2,
        rate: 2500,
        taxRate: 15,
        amount: 5000,
      },
    ],
    subtotal: 5000,
    taxTotal: 750,
    grandTotal: 5750,
    outstandingAmount: 5750,
    status: 'Unpaid',
    notes: 'Payment terms: Net 30 days upon invoice receipt.',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

/** An invoice long enough to break across pages (the page-furniture probe). */
const MULTI_PAGE_ITEMS = Array.from({ length: 60 }, (_, index) => ({
  id: `m${index + 1}`,
  itemCode: `C-${index + 1}`,
  description: `Milestone ${index + 1} site works and commissioning`,
  accountId: 'acc-sales',
  accountName: 'Sales',
  qty: 1,
  rate: 1000 + index,
  taxRate: 15,
  amount: 1000 + index,
}))

/** Decoded content streams: text tokens decoded in place, operators intact. */
function decodedStreams(pdf: Uint8Array): string {
  const buf = Buffer.from(pdf)
  const raw = buf.toString('latin1')
  let text = ''
  const streamRe = /stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = streamRe.exec(raw)) !== null) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end === -1) continue
    let content: string
    try {
      content = inflateSync(buf.subarray(start, end)).toString('latin1')
    } catch {
      continue
    }
    text += `\n${content.replace(
      /<([0-9a-fA-F]+)>\s*Tj/g,
      (_m, hex: string) => ` ${Buffer.from(hex, 'hex').toString('latin1')} `,
    )}\n`
  }
  // pdf-lib stamps /CreationDate and /ModDate (second granularity) inside the
  // compressed object stream, so two builds made across a second boundary
  // differ on metadata alone. These tests judge drawn output and structure,
  // not wall-clock metadata — neutralise the stamps to keep the comparison
  // deterministic.
  return text.replace(/[\u00A0\u202F]/g, ' ').replace(/D:\d{14}Z?/g, 'D:FIXED')
}

const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1

/** The exact fill-colour token pdf-lib emits for a #RRGGBB literal. */
function accentFillToken(hex: string): string {
  const value = parseInt(hex.slice(1), 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return `${r / 255} ${g / 255} ${b / 255} rg`
}

const RED = '#C22626'
const pageCountOf = (text: string): number => {
  const marker = text.match(/Page 1 of (\d+)/)
  expect(marker, 'the first page must carry a Page 1 of M marker').not.toBeNull()
  return Number(marker![1])
}

describe('classic template stays byte-compatible under the new settings', () => {
  it('stamping classic + the default accent changes no drawn output at all', async () => {
    const plain = await buildInvoicePdf(makeInvoice(), SETTINGS)
    const stamped = await buildInvoicePdf(makeInvoice(), {
      ...SETTINGS,
      printTemplate: 'classic',
      invoiceAccent: DEFAULT_INVOICE_ACCENT,
    })
    expect(decodedStreams(plain)).toBe(decodedStreams(stamped))
  })

  it('classic never draws white text and never uses a non-default accent fill', async () => {
    const text = decodedStreams(await buildInvoicePdf(makeInvoice(), SETTINGS))
    expect(text).not.toContain('1 1 1 rg')
    expect(text).not.toContain(accentFillToken(RED))
    expect(text).not.toContain(accentFillToken(DEFAULT_INVOICE_ACCENT))
  })
})

describe('classic vs modern are structurally different', () => {
  it('the modern band draws white text the classic template never does', async () => {
    const classic = decodedStreams(await buildInvoicePdf(makeInvoice(), SETTINGS))
    const modern = decodedStreams(
      await buildInvoicePdf(makeInvoice(), { ...SETTINGS, printTemplate: 'modern' }),
    )
    expect(modern).not.toBe(classic)
    expect(modern).toContain('1 1 1 rg')
    expect(classic).not.toContain('1 1 1 rg')
  })

  it('the settings accent fills the modern band and the classic totals rule only when changed', async () => {
    const modernRed = decodedStreams(
      await buildInvoicePdf(makeInvoice(), {
        ...SETTINGS,
        printTemplate: 'modern',
        invoiceAccent: RED,
      }),
    )
    // Band + tinted table header + the two emphasised totals fills.
    expect(countOccurrences(modernRed, accentFillToken(RED))).toBeGreaterThanOrEqual(2)

    // Classic with the default accent: the built-in teal constant stays in
    // play — the settings accent contributes nothing to the stream.
    const classicDefault = decodedStreams(await buildInvoicePdf(makeInvoice(), SETTINGS))
    expect(classicDefault).not.toContain(accentFillToken(RED))

    // Classic with a user-chosen accent: the accent appears as the Amount Due
    // label/value text fills and as the stroke of the totals rule — the only
    // classic change.
    const classicRed = decodedStreams(
      await buildInvoicePdf(makeInvoice(), { ...SETTINGS, invoiceAccent: RED }),
    )
    expect(countOccurrences(classicRed, accentFillToken(RED))).toBe(2)
    expect(countOccurrences(classicRed, accentFillToken(RED).replace(/ rg$/, ' RG'))).toBe(1)
    expect(classicRed).not.toBe(classicDefault)
  })
})

describe('the letterhead footer reaches the drawn PDF text', () => {
  it('classic appends the letterhead to the existing footer line', async () => {
    const text = decodedStreams(
      await buildInvoicePdf(makeInvoice(), {
        ...SETTINGS,
        letterheadFooter: LETTERHEAD_SHORT,
      }),
    )
    // The em-dash tail decodes as a WinAnsi control byte, so the existing
    // tests assert the prefix — the same prefix lock is used here.
    expect(text).toContain(LETTERHEAD_SHORT)
    expect(text).toContain('Generated via Zano Books')
  })

  it('modern renders the letterhead where the generated-by line goes', async () => {
    const text = decodedStreams(
      await buildInvoicePdf(makeInvoice(), {
        ...SETTINGS,
        printTemplate: 'modern',
        letterheadFooter: LETTERHEAD_LONG,
      }),
    )
    expect(text).toContain(LETTERHEAD_LONG)
    expect(text).not.toContain('Generated via Zano Books')
  })

  it('modern without a letterhead keeps the generated-by footer', async () => {
    const text = decodedStreams(
      await buildInvoicePdf(makeInvoice(), { ...SETTINGS, printTemplate: 'modern' }),
    )
    expect(text).toContain('Generated via Zano Books')
  })

  it('clips an over-long letterhead instead of colliding with the page marker', async () => {
    const text = decodedStreams(
      await buildInvoicePdf(makeInvoice(), {
        ...SETTINGS,
        printTemplate: 'modern',
        letterheadFooter: 'Z'.repeat(400),
      }),
    )
    // The clipped footer carries the ellipsis marker and the 'Page 1 of 1'
    // marker is still drawn at the right edge on its own.
    expect(text).toContain('...')
    expect(text).toContain('Page 1 of 1')
    const footerRuns = text.match(/ Z+\.\.\. /g) || []
    expect(footerRuns.length).toBe(1)
  })
})

describe('page furniture survives in both templates', () => {
  for (const template of ['classic', 'modern'] as const) {
    it(`numbers every page and repeats the footer + table header (${template})`, async () => {
      const invoice = makeInvoice({ items: MULTI_PAGE_ITEMS })
      const text = decodedStreams(
        await buildInvoicePdf(invoice, {
          ...SETTINGS,
          printTemplate: template,
          letterheadFooter: LETTERHEAD_SHORT,
        }),
      )

      const pageCount = pageCountOf(text)
      expect(pageCount).toBeGreaterThan(1)
      // 'Page N of M' on every page, numbered 1..M with the same M.
      for (let index = 1; index <= pageCount; index += 1) {
        expect(text, `missing page marker for page ${index}`).toContain(
          `Page ${index} of ${pageCount}`,
        )
      }
      expect(countOccurrences(text, 'Page ')).toBe(pageCount)
      // The footer line (letterhead appended / replaced) is drawn on every page.
      expect(countOccurrences(text, LETTERHEAD_SHORT)).toBe(pageCount)
      // The line-items table header repeats after every page break.
      expect(countOccurrences(text, 'Description')).toBeGreaterThanOrEqual(2)
    })
  }
})

describe('migration stamps and repairs the print settings', () => {
  it('stamps classic + the default accent when the fields are absent', () => {
    const migrated = migrateAndValidateBooks({
      version: 1,
      revision: 3,
      updatedAt: '2026-09-01T00:00:00.000Z',
      settings: { ...SETTINGS },
      accounts: [],
      parties: [],
      invoices: [],
      journalEntries: [],
    })
    expect(migrated.settings.printTemplate).toBe('classic')
    expect(migrated.settings.invoiceAccent).toBe(DEFAULT_INVOICE_ACCENT)
    expect(migrated.settings.letterheadFooter).toBeUndefined()
  })

  it('keeps a valid modern choice, a valid custom accent and a footer as given', () => {
    const migrated = migrateAndValidateBooks({
      version: 1,
      revision: 0,
      updatedAt: '2026-09-01T00:00:00.000Z',
      settings: {
        ...SETTINGS,
        printTemplate: 'modern',
        invoiceAccent: '#1b7a46',
        letterheadFooter: '  Printed with pride.  ',
      },
      accounts: [],
      parties: [],
      invoices: [],
      journalEntries: [],
    })
    expect(migrated.settings.printTemplate).toBe('modern')
    expect(migrated.settings.invoiceAccent).toBe('#1b7a46')
    expect(migrated.settings.letterheadFooter).toBe('Printed with pride.')
  })

  it('repairs an invalid accent to the default and a bad template to classic', () => {
    for (const bad of ['red', '#12345', '#C2262', '#C22626F', 'javascript:alert(1)', 12, null]) {
      const migrated = migrateAndValidateBooks({
        version: 1,
        revision: 0,
        updatedAt: '2026-09-01T00:00:00.000Z',
        settings: { ...SETTINGS, invoiceAccent: bad as unknown as string, printTemplate: 'fancy' },
        accounts: [],
        parties: [],
        invoices: [],
        journalEntries: [],
      })
      expect(migrated.settings.invoiceAccent, `accent ${String(bad)} must be repaired`).toBe(
        DEFAULT_INVOICE_ACCENT,
      )
      expect(migrated.settings.printTemplate).toBe('classic')
    }
  })

  it('caps the letterhead footer and drops a blank one', () => {
    const migrated = migrateAndValidateBooks({
      version: 1,
      revision: 0,
      updatedAt: '2026-09-01T00:00:00.000Z',
      settings: { ...SETTINGS, letterheadFooter: 'x'.repeat(500) },
      accounts: [],
      parties: [],
      invoices: [],
      journalEntries: [],
    })
    expect(migrated.settings.letterheadFooter).toHaveLength(200)

    const blank = migrateAndValidateBooks({
      version: 1,
      revision: 0,
      updatedAt: '2026-09-01T00:00:00.000Z',
      settings: { ...SETTINGS, letterheadFooter: '   ' },
      accounts: [],
      parties: [],
      invoices: [],
      journalEntries: [],
    })
    expect(blank.settings.letterheadFooter).toBeUndefined()
    expect(JSON.parse(JSON.stringify(blank.settings)).letterheadFooter).toBeUndefined()
  })

  it('stamps the print defaults on a fresh (empty) ledger too', () => {
    const fresh = migrateAndValidateBooks(null)
    expect(fresh.settings.printTemplate).toBe('classic')
    expect(fresh.settings.invoiceAccent).toBe(DEFAULT_INVOICE_ACCENT)
    expect(isValidInvoiceAccent(fresh.settings.invoiceAccent)).toBe(true)
  })
})
