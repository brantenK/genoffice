import { deflateSync, inflateSync } from 'node:zlib'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildInvoicePdf, buildQuotationPdf } from '../src/shared/invoice-pdf'
import { migrateAndValidateBooks } from '../src/main/books-core'
import {
  DEFAULT_INVOICE_ACCENT,
  isValidInvoiceAccent,
  isValidLogoDataUrl,
} from '../src/shared/chart'
import { DEFAULT_INVOICE_NOTES } from '../src/shared/print'
import type { CompanySettings, Invoice, Quotation } from '../src/shared/types'

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

/** A quotation carrying one discounted line and an invoice-level discount. */
function makeQuote(overrides: Partial<Quotation> = {}): Quotation {
  return {
    id: 'quote-1',
    quoteNumber: 'QTN-2026-007',
    partyId: 'party-1',
    partyName: 'Rand Water Authority',
    date: '2026-09-01',
    validUntil: '2026-10-31',
    items: [
      {
        id: 'qi1',
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
    status: 'Sent',
    notes: 'Quotation valid for 30 days.',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('the VAT totals row labels the rate the lines actually carry', () => {
  it('a 0% invoice prints a bare VAT label, never the fallback 15%', async () => {
    const zeroRated = makeInvoice({
      items: [
        {
          id: 'z1',
          itemCode: 'C-1',
          description: 'Zero-rated export',
          accountId: 'acc-sales',
          accountName: 'Sales',
          qty: 1,
          rate: 1000,
          taxRate: 0,
          amount: 1000,
        },
      ],
      subtotal: 1000,
      taxTotal: 0,
      grandTotal: 1000,
      outstandingAmount: 1000,
    })
    const text = decodedStreams(await buildInvoicePdf(zeroRated, SETTINGS))
    expect(text).toContain('VAT / Tax')
    expect(text).not.toContain('(15%)')
  })

  it('a mixed-rate invoice prints a bare VAT label too', async () => {
    const mixed = makeInvoice({
      items: [
        {
          id: 'm1',
          itemCode: 'C-1',
          description: 'Standard-rated works',
          accountId: 'acc-sales',
          accountName: 'Sales',
          qty: 1,
          rate: 1000,
          taxRate: 15,
          amount: 1000,
        },
        {
          id: 'm2',
          itemCode: 'C-2',
          description: 'Zero-rated export',
          accountId: 'acc-sales',
          accountName: 'Sales',
          qty: 1,
          rate: 500,
          taxRate: 0,
          amount: 500,
        },
      ],
      subtotal: 1500,
      taxTotal: 150,
      grandTotal: 1650,
      outstandingAmount: 1650,
    })
    const text = decodedStreams(await buildInvoicePdf(mixed, SETTINGS))
    expect(text).toContain('VAT / Tax')
    expect(text).not.toContain('(15%)')
  })

  it('a single non-zero rate keeps its labelled VAT row', async () => {
    const text = decodedStreams(await buildInvoicePdf(makeInvoice(), SETTINGS))
    expect(text).toContain('VAT / Tax (15%)')
  })

  it('a quotation follows the same label semantics', async () => {
    const zero = decodedStreams(
      await buildQuotationPdf(
        makeQuote({
          items: [
            {
              id: 'qz1',
              itemCode: 'C-1',
              description: 'Zero-rated export',
              accountId: 'acc-sales',
              accountName: 'Sales',
              qty: 1,
              rate: 1000,
              taxRate: 0,
              amount: 1000,
            },
          ],
          subtotal: 1000,
          taxTotal: 0,
          grandTotal: 1000,
        }),
        SETTINGS,
      ),
    )
    expect(zero).toContain('VAT / Tax')
    expect(zero).not.toContain('(15%)')

    expect(decodedStreams(await buildQuotationPdf(makeQuote(), SETTINGS))).toContain(
      'VAT / Tax (15%)',
    )
  })
})

describe('the printed totals carry the discount the engine booked', () => {
  it('a discounted invoice prints a Discount row between Subtotal and VAT', async () => {
    // 5 000 − 500 discount, 15% VAT on the discounted base: 4 500 + 675 = 5 175.
    const discounted = makeInvoice({
      items: [
        {
          id: 'd1',
          itemCode: 'C-1',
          description: 'Discounted works',
          accountId: 'acc-sales',
          accountName: 'Sales',
          qty: 2,
          rate: 2500,
          taxRate: 15,
          amount: 5000,
        },
      ],
      subtotal: 5000,
      taxTotal: 675,
      grandTotal: 5175,
      outstandingAmount: 5175,
      discountTotal: 500,
    })
    const text = decodedStreams(await buildInvoicePdf(discounted, SETTINGS))
    expect(text).toContain('Discount')
    expect(text).toContain('-R 500,00')
    expect(text).toContain('R 5 000,00')
    expect(text).toContain('R 5 175,00')
    // The rows tie: Subtotal − Discount + VAT = Grand Total.
    expect(5000 - 500 + 675).toBe(5175)
  })

  it('a line discount shows in the row amounts, not only in the totals', async () => {
    const lineDiscounted = makeInvoice({
      items: [
        {
          id: 'ld1',
          itemCode: 'C-1',
          description: 'Line-discounted works',
          accountId: 'acc-sales',
          accountName: 'Sales',
          qty: 2,
          rate: 2500,
          taxRate: 15,
          amount: 5000,
          discountRate: 10,
        },
      ],
      subtotal: 4500,
      taxTotal: 675,
      grandTotal: 5175,
      outstandingAmount: 5175,
    })
    const text = decodedStreams(await buildInvoicePdf(lineDiscounted, SETTINGS))
    expect(text).toContain('R 4 500,00')
    expect(text).not.toContain('R 5 000,00')
  })

  it('no Discount row is drawn when the invoice carries none', async () => {
    const text = decodedStreams(await buildInvoicePdf(makeInvoice(), SETTINGS))
    expect(text).not.toContain('Discount')
  })

  it('a discounted quotation prints the same Discount row', async () => {
    const discounted = makeQuote({
      subtotal: 4500,
      taxTotal: 675,
      grandTotal: 5175,
      discountTotal: 500,
    })
    const text = decodedStreams(await buildQuotationPdf(discounted, SETTINGS))
    expect(text).toContain('Discount')
    expect(text).toContain('-R 500,00')
    expect(text).toContain('R 5 175,00')
  })
})

describe('the document title follows the payload direction', () => {
  it('a purchase bill prints PURCHASE BILL in the title and the metadata', async () => {
    const bill = makeInvoice({ type: 'Purchase', invoiceNumber: 'BILL-2026-0031' })
    const pdf = await buildInvoicePdf(bill, SETTINGS)
    const text = decodedStreams(pdf)
    expect(text).toContain('PURCHASE BILL')
    expect(text).not.toContain('TAX INVOICE')

    const loaded = await PDFDocument.load(pdf)
    expect(loaded.getTitle()).toBe('Purchase Bill BILL-2026-0031')
  })

  it('a sale still prints TAX INVOICE and a credit note CREDIT NOTE', async () => {
    const sale = decodedStreams(await buildInvoicePdf(makeInvoice(), SETTINGS))
    expect(sale).toContain('TAX INVOICE')

    const credit = decodedStreams(
      await buildInvoicePdf(makeInvoice({ creditNote: true, invoiceNumber: 'CN-2026-0001' }), SETTINGS),
    )
    expect(credit).toContain('CREDIT NOTE')
  })
})

describe('a blank note renders the shared default in the PDF', () => {
  it('prints the one default note, not a builder-specific fallback', async () => {
    const blankNotes = makeInvoice({ notes: undefined })
    const text = decodedStreams(await buildInvoicePdf(blankNotes, SETTINGS))
    expect(text).toContain(DEFAULT_INVOICE_NOTES)
    expect(text).not.toContain('Net 30 days upon invoice receipt')
    expect(text).not.toContain('FNB')
  })
})

describe('the quotation PDF mirrors the invoice pipeline', () => {
  it('carries QUOTATION, the quote number, the valid-until date and the status', async () => {
    for (const template of ['classic', 'modern'] as const) {
      const pdf = await buildQuotationPdf(makeQuote(), { ...SETTINGS, printTemplate: template })
      const text = decodedStreams(pdf)
      expect(text).toContain('QUOTATION')
      expect(text).toContain('QTN-2026-007')
      expect(text).toContain('Valid Until: 2026-10-31')
      expect(text).toContain('Status: SENT')
      expect(text).toContain('Rand Water Authority')
      expect(text).toContain('R 5 750,00')
      expect(text).toContain('Billed To: Rand Water Authority')
      expect(text).toContain('Generated via Zano Books')
    }
  })

  it('has no due-date, round-off or amount-due rows to invent', async () => {
    const text = decodedStreams(await buildQuotationPdf(makeQuote(), SETTINGS))
    expect(text).not.toContain('Due:')
    expect(text).not.toContain('Round-off')
    expect(text).not.toContain('Amount Due')
  })

  it('respects the modern template accent like the invoice PDF does', async () => {
    const modernRed = decodedStreams(
      await buildQuotationPdf(makeQuote(), {
        ...SETTINGS,
        printTemplate: 'modern',
        invoiceAccent: '#C22626',
      }),
    )
    // The band, the tinted table header and the emphasised grand total.
    expect(countOccurrences(modernRed, accentFillToken('#C22626'))).toBeGreaterThanOrEqual(2)
    expect(modernRed).toContain('1 1 1 rg')
  })

  it('documents itself as Quotation in the metadata', async () => {
    const loaded = await PDFDocument.load(await buildQuotationPdf(makeQuote(), SETTINGS))
    expect(loaded.getTitle()).toBe('Quotation QTN-2026-007')
    expect(loaded.getAuthor()).toBe('Zano Consulting (Pty) Ltd')
  })
})

describe('migration stamps and repairs the letterhead extras', () => {
  const migrate = (settings: Record<string, unknown>) =>
    migrateAndValidateBooks({
      version: 1,
      revision: 0,
      updatedAt: '2026-09-01T00:00:00.000Z',
      settings: { ...SETTINGS, ...settings },
      accounts: [],
      parties: [],
      invoices: [],
      journalEntries: [],
    })

  it('keeps a valid logo data URL and a trimmed registration number', () => {
    const png = makeTinyPngDataUrl()
    const migrated = migrate({ logoDataUrl: png, registrationNumber: '  2016/123456/07  ' })
    expect(migrated.settings.logoDataUrl).toBe(png)
    expect(migrated.settings.registrationNumber).toBe('2016/123456/07')
  })

  it('strips a logo with a wrong prefix, a non-string logo and one over the cap', () => {
    for (const bad of [
      'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      'data:image/jpeg+xml;base64,whatever',
      'data:text/html;base64,PGh0bWw+',
      'not a data url at all',
      42,
      null,
    ]) {
      const migrated = migrate({ logoDataUrl: bad })
      expect(
        migrated.settings.logoDataUrl,
        `logo ${String(bad).slice(0, 40)} must be stripped`,
      ).toBeUndefined()
    }

    const oversize = migrate({ logoDataUrl: `data:image/png;base64,${'A'.repeat(700_001)}` })
    expect(oversize.settings.logoDataUrl).toBeUndefined()
  })

  it('caps the registration number and drops a blank one', () => {
    const capped = migrate({ registrationNumber: 'x'.repeat(500) })
    expect(capped.settings.registrationNumber).toHaveLength(120)

    const blank = migrate({ registrationNumber: '   ' })
    expect(blank.settings.registrationNumber).toBeUndefined()
    expect(JSON.parse(JSON.stringify(blank.settings)).registrationNumber).toBeUndefined()
  })

  it('round-trips a populated ledger with the extras unchanged', () => {
    const ledger = migrateAndValidateBooks({
      version: 1,
      revision: 2,
      updatedAt: '2026-09-01T00:00:00.000Z',
      settings: {
        ...SETTINGS,
        logoDataUrl: makeTinyPngDataUrl(),
        registrationNumber: '2016/123456/07',
      },
      accounts: [],
      parties: [],
      invoices: [
        makeInvoice({
          partyAddress: '18 River Street, Sandton',
          partyTaxId: 'VAT 4990314821',
        }),
      ],
      journalEntries: [],
    })
    expect(ledger.settings.registrationNumber).toBe('2016/123456/07')
    expect(isValidLogoDataUrl(ledger.settings.logoDataUrl)).toBe(true)
    // The envelope shape is untouched otherwise.
    expect(ledger.invoices[0].partyAddress).toBe('18 River Street, Sandton')
    expect(ledger.invoices[0].partyTaxId).toBe('VAT 4990314821')
    expect(ledger.quotes).toEqual([])
    expect(ledger.version).toBe(1)
    expect(ledger.revision).toBe(2)
  })
})

describe('the letterhead logo and registration line reach the drawn PDF', () => {
  it('draws the logo as an image operator on both templates', async () => {
    for (const template of ['classic', 'modern'] as const) {
      const pdf = await buildInvoicePdf(makeInvoice(), {
        ...SETTINGS,
        printTemplate: template,
        logoDataUrl: makeTinyPngDataUrl(),
      })
      expect(Buffer.from(pdf).toString('latin1')).toMatch(/Subtype\s*\/Image/)
      const pageStream = pageContentStreams(pdf)
      expect(pageStream.some((stream) => /\bDo\b/.test(stream)), template).toBe(true)
    }
  })

  it('a corrupt logo payload skips cleanly instead of failing the build', async () => {
    const corrupt = await buildInvoicePdf(makeInvoice(), {
      ...SETTINGS,
      logoDataUrl: 'data:image/png;base64,notARealPngPayload',
    })
    expect(Buffer.from(corrupt).toString('latin1')).not.toMatch(/Subtype\s*\/Image/)
  })

  it('without a logo or registration the classic layout stays as it always was', async () => {
    const plain = await buildInvoicePdf(makeInvoice(), SETTINGS)
    const explicitBlank = await buildInvoicePdf(makeInvoice(), {
      ...SETTINGS,
      registrationNumber: '',
    })
    const text = decodedStreams(plain)
    expect(decodedStreams(explicitBlank)).toBe(text)
    // Exactly one 'Reg: ' — the VAT Reg draw — so no registration line was
    // added, and no party lines or image were drawn either.
    expect(countOccurrences(text, 'Reg: ')).toBe(1)
    expect(text).not.toContain('VAT / Tax ID:')
    // No image XObject and no image operator when nothing was set.
    expect(Buffer.from(plain).toString('latin1')).not.toMatch(/Subtype\s*\/Image/)
    expect(pageContentStreams(plain).some((stream) => /\bDo\b/.test(stream))).toBe(false)
  })

  it('prints the Reg line when a registration number is set', async () => {
    const text = decodedStreams(
      await buildInvoicePdf(makeInvoice(), {
        ...SETTINGS,
        registrationNumber: '2016/123456/07',
      }),
    )
    // The VAT Reg draw plus the new registration line.
    expect(countOccurrences(text, 'Reg: ')).toBe(2)
    expect(text).toContain('Reg: 2016/123456/07')
  })

  it('prints the party address and tax-ID lines when the payload carries them', async () => {
    const withParty = decodedStreams(
      await buildInvoicePdf(
        makeInvoice({
          partyAddress: '18 River Street, Sandton',
          partyTaxId: 'VAT 4990314821',
        }),
        SETTINGS,
      ),
    )
    expect(withParty).toContain('18 River Street, Sandton')
    expect(withParty).toContain('VAT / Tax ID: VAT 4990314821')

    // A party without them prints no stray labels.
    const withoutParty = decodedStreams(await buildInvoicePdf(makeInvoice(), SETTINGS))
    expect(withoutParty).not.toContain('VAT / Tax ID:')
  })

  it('the quotation PDF inherits the logo, Reg line and party lines', async () => {
    const pdf = await buildQuotationPdf(
      makeQuote({
        partyAddress: '18 River Street, Sandton',
        partyTaxId: 'VAT 4990314821',
      }),
      { ...SETTINGS, registrationNumber: '2016/123456/07', logoDataUrl: makeTinyPngDataUrl() },
    )
    expect(Buffer.from(pdf).toString('latin1')).toMatch(/Subtype\s*\/Image/)
    const text = decodedStreams(pdf)
    expect(text).toContain('Reg: 2016/123456/07')
    expect(text).toContain('18 River Street, Sandton')
    expect(text).toContain('VAT / Tax ID: VAT 4990314821')
  })
})

/**
 * A minimal valid 4x2 RGB PNG, assembled by hand (zlib IDAT + correct CRCs),
 * so the embed tests exercise a real image without a binary fixture.
 */
function makeTinyPngDataUrl(): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typeBuf = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
    return Buffer.concat([len, typeBuf, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(4, 0)
  ihdr.writeUInt32BE(2, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(4 * 3, 0x7f)])
  const idat = deflateSync(Buffer.concat([row, row]))
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString('base64')}`
}

const CRC_TABLE: number[] = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  CRC_TABLE[n] = c >>> 0
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** The inflated content stream of each page that draws the document title. */
function pageContentStreams(pdf: Uint8Array): string[] {
  const buf = Buffer.from(pdf)
  const raw = buf.toString('latin1')
  const streams: string[] = []
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
    // pdf-lib emits text as `<hex> Tj` tokens (see decodedStreams) — decode
    // them in place before matching the title, leaving operators like `Do`
    // untouched so the logo assertion can ride the same streams.
    const decoded = content.replace(
      /<([0-9a-fA-F]+)>\s*Tj/g,
      (_m, hex: string) => ` ${Buffer.from(hex, 'hex').toString('latin1')} `,
    )
    if (decoded.includes('TAX INVOICE') || decoded.includes('QUOTATION')) {
      streams.push(decoded)
    }
  }
  return streams
}
