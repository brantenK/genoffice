/**
 * FX statement contract: a foreign-currency invoice's produced document is
 * labelled with the invoice's OWN currency ISO code (the same rule the print
 * preview implements) and carries the base-currency equivalent at the stored
 * rate — never the base symbol against foreign figures. The quotation PDF
 * builder follows the identical discipline.
 *
 * Regression: buildInvoicePdf drew every amount with the company's BASE symbol
 * (settings.currencySymbol), so an EUR 1 000 invoice at 20 ZAR/EUR printed
 * "R 1 000.00" — a base-labelled figure that is neither the EUR amount nor the
 * base total (R 20 000), on both print templates.
 */
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildInvoicePdf, buildQuotationPdf, formatMoney } from '../src/shared/invoice-pdf'
import { DEFAULT_BOOK_SETTINGS } from '../src/shared/chart'
import type { CompanySettings, Invoice, Quotation } from '../src/shared/types'

const settings: CompanySettings = {
  ...DEFAULT_BOOK_SETTINGS,
  companyName: 'FX Print (Pty) Ltd',
  currency: 'ZAR',
  currencySymbol: 'R',
}

const eurInvoice: Invoice = {
  id: 'inv-fx',
  invoiceNumber: 'INV-2026-001',
  type: 'Sales',
  partyId: 'party-fx',
  partyName: 'Euro Trader BV',
  date: '2026-09-01',
  dueDate: '2026-10-01',
  items: [
    {
      id: 'it-1',
      itemCode: 'CONS',
      description: 'Consulting',
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
  status: 'Unpaid',
  currency: 'EUR',
  exchangeRate: 20,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

/** The quotation analog of `eurInvoice`: an EUR offer at the same rate. */
const eurQuote: Quotation = {
  id: 'quote-fx',
  quoteNumber: 'QTN-2026-001',
  partyId: 'party-fx',
  partyName: 'Euro Trader BV',
  date: '2026-09-01',
  validUntil: '2026-10-01',
  items: [
    {
      id: 'it-1',
      itemCode: 'CONS',
      description: 'Consulting',
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
  status: 'Sent',
  currency: 'EUR',
  exchangeRate: 20,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

/**
 * Extracts the drawn text from a pdf-lib document: every content stream is
 * Flate-compressed; inflating each and concatenating exposes the literal
 * strings the draw calls wrote. pdf-lib draws text as hex strings
 * ("<54415820494E...> Tj"); those are decoded too. `drawn` returns each drawn
 * string separately (the text between each decode and its "Tj"), so
 * assertions can test whole figures rather than substrings.
 */
function extractPdf(bytes: Uint8Array): { text: string; drawn: string[] } {
  const raw = Buffer.from(bytes)
  const chunks: string[] = []
  const drawn: string[] = []
  const marker = Buffer.from('stream')
  const endMarker = Buffer.from('endstream')
  let cursor = 0
  for (;;) {
    const start = raw.indexOf(marker, cursor)
    if (start === -1) break
    // skip the EOL after the keyword
    let dataStart = start + marker.length
    if (raw[dataStart] === 13) dataStart += 1
    if (raw[dataStart] === 10) dataStart += 1
    const end = raw.indexOf(endMarker, dataStart)
    if (end === -1) break
    const payload = raw.subarray(dataStart, end)
    let content: string
    try {
      content = inflateSync(payload).toString('latin1')
    } catch {
      content = payload.toString('latin1')
    }
    // pdf-lib draws text as hex strings ("<54415820494E...> Tj"); decode them,
    // then lift each decoded figure up to its "Tj" as one drawn string.
    content = content.replace(/<([0-9A-Fa-f\s]+)>/g, (_m, hex: string) =>
      Buffer.from(hex.replace(/\s+/g, ''), 'hex').toString('latin1'),
    )
    for (const match of content.matchAll(/([^\n]{2,}?)\s+Tj/g)) {
      drawn.push(match[1])
    }
    chunks.push(content)
    cursor = end + endMarker.length
  }
  return { text: chunks.join('\n'), drawn }
}

describe('FX statement print contract (buildInvoicePdf)', () => {
  it.each(['classic', 'modern'] as const)(
    '%s: an EUR invoice is labelled EUR with its base equivalent, never the base symbol',
    async template => {
      const bytes = await buildInvoicePdf(eurInvoice, { ...settings, printTemplate: template })
      const { text, drawn } = extractPdf(bytes)

      // The invoice's own-currency figures are labelled with the ISO code.
      expect(text).toContain(formatMoney(eurInvoice.grandTotal, 'EUR'))
      expect(text).toContain(formatMoney(eurInvoice.outstandingAmount, 'EUR'))
      // The base-currency equivalent rides the stored rate.
      expect(text).toContain(formatMoney(round2(1000 * 20), 'R'))
      expect(text).toContain('Exchange rate: 1 EUR = 20.00 ZAR')
      // The old defect: base-symbol-labelled foreign figures must not return —
      // asserted per drawn string (the base figure never appears as a
      // stand-alone draw).
      for (const figure of drawn) {
        expect(
          figure,
          `a drawn figure must never be the base-symbol foreign amount: ${figure}`,
        ).not.toBe(formatMoney(eurInvoice.grandTotal, 'R'))
        expect(figure).not.toBe(formatMoney(eurInvoice.outstandingAmount, 'R'))
      }
    },
  )

  it('a base-currency invoice keeps the company symbol exactly as before', async () => {
    const zarInvoice: Invoice = {
      ...eurInvoice,
      currency: undefined,
      exchangeRate: undefined,
    }
    const bytes = await buildInvoicePdf(zarInvoice, settings)
    const { text } = extractPdf(bytes)
    expect(text).toContain(formatMoney(zarInvoice.grandTotal, 'R'))
    expect(text).not.toContain('Exchange rate:')
    expect(text).not.toContain('EUR')
  })
})

describe('FX statement print contract (buildQuotationPdf)', () => {
  it.each(['classic', 'modern'] as const)(
    '%s: an EUR quotation is labelled EUR with its base equivalent, never the base symbol',
    async template => {
      const bytes = await buildQuotationPdf(eurQuote, { ...settings, printTemplate: template })
      const { text, drawn } = extractPdf(bytes)

      // The quotation's own-currency figures are labelled with the ISO code.
      expect(text).toContain(formatMoney(eurQuote.grandTotal, 'EUR'))
      // The base-currency equivalent rides the stored rate.
      expect(text).toContain(formatMoney(round2(1000 * 20), 'R'))
      expect(text).toContain('Exchange rate: 1 EUR = 20.00 ZAR')
      // The old defect: base-symbol-labelled foreign figures must not return —
      // asserted per drawn string (the base figure never appears as a
      // stand-alone draw).
      for (const figure of drawn) {
        expect(
          figure,
          `a drawn figure must never be the base-symbol foreign amount: ${figure}`,
        ).not.toBe(formatMoney(eurQuote.grandTotal, 'R'))
      }
    },
  )

  it('a base-currency quotation keeps the company symbol and carries no FX note', async () => {
    const zarQuote: Quotation = {
      ...eurQuote,
      currency: undefined,
      exchangeRate: undefined,
    }
    const bytes = await buildQuotationPdf(zarQuote, settings)
    const { text } = extractPdf(bytes)
    expect(text).toContain(formatMoney(zarQuote.grandTotal, 'R'))
    expect(text).not.toContain('Exchange rate:')
    expect(text).not.toContain('EUR')
  })
})

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}
