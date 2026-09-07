import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { agingBuckets, buildInvoicePdf, taxRegister } from '../src/shared/reports'
import { writeInvoicePdf } from '../src/main/books-main'
import type { CompanySettings, Invoice, InvoiceItem, Party } from '../src/shared/types'

function makeItem(overrides: Partial<InvoiceItem> & { id: string }): InvoiceItem {
  const qty = overrides.qty ?? 1
  const rate = overrides.rate ?? 0
  return {
    id: overrides.id,
    itemCode: overrides.itemCode || `C-${overrides.id}`,
    description: overrides.description || `Item ${overrides.id}`,
    accountId: overrides.accountId || 'acc-sales',
    accountName: overrides.accountName || 'Sales',
    qty,
    rate,
    taxRate: overrides.taxRate ?? 15,
    amount: overrides.amount ?? qty * rate,
    discountRate: overrides.discountRate,
  }
}

function makeInvoice(overrides: Partial<Invoice> & { id: string }): Invoice {
  const id = overrides.id
  const type = overrides.type || 'Sales'
  return {
    id,
    invoiceNumber: overrides.invoiceNumber || `INV-${id.toUpperCase()}`,
    type,
    partyId: overrides.partyId || `party-${id}`,
    partyName: overrides.partyName || `Party ${id}`,
    date: overrides.date || '2026-08-01',
    dueDate: overrides.dueDate || '2026-08-31',
    items: overrides.items || [],
    subtotal: overrides.subtotal ?? 0,
    taxTotal: overrides.taxTotal ?? 0,
    grandTotal: overrides.grandTotal ?? 0,
    outstandingAmount: overrides.outstandingAmount ?? 0,
    status: overrides.status || 'Unpaid',
    notes: overrides.notes,
    tenderReference: overrides.tenderReference,
    creditNote: overrides.creditNote,
    roundOff: overrides.roundOff,
    createdAt: overrides.createdAt || '2026-08-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-08-01T00:00:00.000Z',
  }
}

const AS_OF = '2026-09-06'

describe('agingBuckets', () => {
  it('buckets by days overdue with boundary due dates (due today -> current, 30 -> days30, 31 -> days60, 61 -> days90)', () => {
    const invoices = [
      makeInvoice({
        id: 'today',
        partyId: 'p1',
        partyName: 'Alpha',
        dueDate: '2026-09-06',
        outstandingAmount: 100,
      }),
      makeInvoice({
        id: 'future',
        partyId: 'p2',
        partyName: 'Beta',
        dueDate: '2026-09-20',
        outstandingAmount: 50,
      }),
      makeInvoice({
        id: 'd30',
        partyId: 'p3',
        partyName: 'Gamma',
        dueDate: '2026-08-07',
        outstandingAmount: 200,
      }),
      makeInvoice({
        id: 'd31',
        partyId: 'p4',
        partyName: 'Delta',
        dueDate: '2026-08-06',
        outstandingAmount: 300,
      }),
      makeInvoice({
        id: 'd61',
        partyId: 'p5',
        partyName: 'Epsilon',
        dueDate: '2026-07-07',
        outstandingAmount: 400,
      }),
    ]
    const rows = agingBuckets(invoices, [], AS_OF, 'Sales')
    expect(rows).toHaveLength(5)
    const byName = new Map(rows.map((r) => [r.partyName, r]))
    expect(byName.get('Alpha')).toMatchObject({
      current: 100,
      days30: 0,
      days60: 0,
      days90: 0,
      total: 100,
    })
    expect(byName.get('Beta')).toMatchObject({
      current: 50,
      days30: 0,
      days60: 0,
      days90: 0,
      total: 50,
    })
    expect(byName.get('Gamma')).toMatchObject({
      current: 0,
      days30: 200,
      days60: 0,
      days90: 0,
      total: 200,
    })
    expect(byName.get('Delta')).toMatchObject({
      current: 0,
      days30: 0,
      days60: 300,
      days90: 0,
      total: 300,
    })
    expect(byName.get('Epsilon')).toMatchObject({
      current: 0,
      days30: 0,
      days60: 0,
      days90: 400,
      total: 400,
    })
  })

  it('excludes Paid, Draft, Cancelled and zero-outstanding invoices', () => {
    const invoices = [
      makeInvoice({ id: 'paid', status: 'Paid', outstandingAmount: 999, dueDate: '2026-07-01' }),
      makeInvoice({ id: 'draft', status: 'Draft', outstandingAmount: 500, dueDate: '2026-07-01' }),
      makeInvoice({
        id: 'cancelled',
        status: 'Cancelled',
        outstandingAmount: 500,
        dueDate: '2026-07-01',
      }),
      makeInvoice({ id: 'zero', status: 'Unpaid', outstandingAmount: 0, dueDate: '2026-07-01' }),
      makeInvoice({
        id: 'overdue',
        status: 'Overdue',
        outstandingAmount: 250,
        dueDate: '2026-07-01',
      }),
    ]
    const rows = agingBuckets(invoices, [], AS_OF, 'Sales')
    expect(rows).toHaveLength(1)
    expect(rows[0].partyName).toBe('Party overdue')
    expect(rows[0].days90).toBe(250)
    expect(rows[0].total).toBe(250)
  })

  it('filters by invoice type (Sales vs Purchase)', () => {
    const invoices = [
      makeInvoice({ id: 's1', type: 'Sales', outstandingAmount: 100, dueDate: '2026-07-01' }),
      makeInvoice({ id: 'p1', type: 'Purchase', outstandingAmount: 100, dueDate: '2026-07-01' }),
    ]
    const sales = agingBuckets(invoices, [], AS_OF, 'Sales')
    const purchases = agingBuckets(invoices, [], AS_OF, 'Purchase')
    expect(sales).toHaveLength(1)
    expect(sales[0].partyName).toBe('Party s1')
    expect(purchases).toHaveLength(1)
    expect(purchases[0].partyName).toBe('Party p1')
  })

  it('aggregates multiple invoices per party and sorts by total descending', () => {
    const invoices = [
      makeInvoice({
        id: 'a1',
        partyId: 'pA',
        partyName: 'Alpha',
        outstandingAmount: 100,
        dueDate: '2026-08-20',
      }),
      makeInvoice({
        id: 'a2',
        partyId: 'pA',
        partyName: 'Alpha',
        outstandingAmount: 50,
        dueDate: '2026-07-01',
      }),
      makeInvoice({
        id: 'b1',
        partyId: 'pB',
        partyName: 'Beta',
        outstandingAmount: 500,
        dueDate: '2026-07-01',
      }),
    ]
    const rows = agingBuckets(invoices, [], AS_OF, 'Sales')
    expect(rows).toHaveLength(2)
    expect(rows[0].partyName).toBe('Beta')
    expect(rows[0].total).toBe(500)
    expect(rows[1].partyName).toBe('Alpha')
    expect(rows[1].total).toBe(150)
    // 2026-08-20 due is 17 days overdue as of 2026-09-06 -> days30 bucket.
    expect(rows[1].current).toBe(0)
    expect(rows[1].days30).toBe(100)
    expect(rows[1].days90).toBe(50)
  })

  it('resolves names from the parties list and rounds amounts', () => {
    const parties: Party[] = [
      { id: 'p1', name: 'Official Name (Pty) Ltd', type: 'Customer', outstandingBalance: 0 },
    ]
    const invoices = [
      makeInvoice({
        id: 'x',
        partyId: 'p1',
        partyName: 'Old Name',
        outstandingAmount: 10.005,
        dueDate: '2026-07-01',
      }),
    ]
    const rows = agingBuckets(invoices, parties, AS_OF, 'Sales')
    expect(rows).toHaveLength(1)
    expect(rows[0].partyName).toBe('Official Name (Pty) Ltd')
    expect(rows[0].days90).toBe(10.01)
    expect(rows[0].total).toBe(10.01)
  })
})

describe('taxRegister', () => {
  it('single rate with sales and purchase sides plus totals row', () => {
    const invoices = [
      makeInvoice({
        id: 's1',
        type: 'Sales',
        items: [makeItem({ id: 'i1', amount: 1000, taxRate: 15 })],
      }),
      makeInvoice({
        id: 'p1',
        type: 'Purchase',
        items: [makeItem({ id: 'i2', amount: 2000, taxRate: 15 })],
      }),
    ]
    const rows = taxRegister(invoices)
    expect(rows).toHaveLength(2)
    expect(rows[0].taxRate).toBe(15)
    expect(rows[0].salesTaxable).toBe(1000)
    expect(rows[0].salesTax).toBe(150)
    expect(rows[0].purchaseTaxable).toBe(2000)
    expect(rows[0].purchaseTax).toBe(300)
    expect(rows[1].taxRate).toBeNull()
    expect(rows[1].salesTaxable).toBe(1000)
    expect(rows[1].salesTax).toBe(150)
    expect(rows[1].purchaseTaxable).toBe(2000)
    expect(rows[1].purchaseTax).toBe(300)
  })

  it('mixed rates produce one row per rate plus totals', () => {
    const invoices = [
      makeInvoice({
        id: 's1',
        type: 'Sales',
        items: [
          makeItem({ id: 'i1', amount: 1000, taxRate: 15 }),
          makeItem({ id: 'i2', amount: 500, taxRate: 0 }),
          makeItem({ id: 'i3', amount: 700, taxRate: 15 }),
        ],
      }),
    ]
    const rows = taxRegister(invoices)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ taxRate: 0, salesTaxable: 500, salesTax: 0 })
    expect(rows[1]).toMatchObject({ taxRate: 15, salesTaxable: 1700, salesTax: 255 })
    expect(rows[2]).toMatchObject({ taxRate: null, salesTaxable: 2200, salesTax: 255 })
  })

  it('applies discountRate to the taxable base and the tax', () => {
    const invoices = [
      makeInvoice({
        id: 's1',
        type: 'Sales',
        items: [makeItem({ id: 'i1', amount: 1000, taxRate: 15, discountRate: 10 })],
      }),
    ]
    const rows = taxRegister(invoices)
    expect(rows[0].salesTaxable).toBe(900)
    expect(rows[0].salesTax).toBe(135)
    expect(rows[1].salesTaxable).toBe(900)
    expect(rows[1].salesTax).toBe(135)
  })

  it('excludes draft and cancelled invoices', () => {
    const invoices = [
      makeInvoice({
        id: 'draft',
        status: 'Draft',
        items: [makeItem({ id: 'i1', amount: 1000, taxRate: 15 })],
      }),
      makeInvoice({
        id: 'cancelled',
        status: 'Cancelled',
        items: [makeItem({ id: 'i2', amount: 1000, taxRate: 15 })],
      }),
      makeInvoice({
        id: 'posted',
        items: [makeItem({ id: 'i3', amount: 100, taxRate: 15 })],
      }),
    ]
    const rows = taxRegister(invoices)
    expect(rows).toHaveLength(2) // one rate row + totals row
    expect(rows[0].salesTaxable).toBe(100)
    expect(rows[0].salesTax).toBe(15)
    expect(rows[1].salesTaxable).toBe(100)
  })
})

const PDF_SETTINGS: CompanySettings = {
  companyName: 'Zano Consulting (Pty) Ltd',
  taxNumber: 'VAT 4510278912',
  currency: 'ZAR',
  currencySymbol: 'R',
  financialYearStart: '2026-03-01',
  address: '12 Albert Road, Johannesburg',
  email: 'accounts@zanostack.com',
  phone: '+27 11 555 0199',
}

const PDF_INVOICE = makeInvoice({
  id: 'pdf1',
  invoiceNumber: 'INV-2026-0042',
  partyName: 'Rand Water Authority',
  date: '2026-09-01',
  dueDate: '2026-10-01',
  status: 'Unpaid',
  tenderReference: 'RFP-WTR-2026-04',
  items: [
    makeItem({
      id: 'i1',
      description: 'Water infrastructure consulting',
      qty: 2,
      rate: 2500,
      taxRate: 15,
      amount: 5000,
    }),
  ],
  subtotal: 5000,
  taxTotal: 750,
  grandTotal: 5750,
  outstandingAmount: 5750,
  notes: 'Payment terms: Net 30 days upon invoice receipt.',
})

/**
 * Searches the PDF bytes as an ASCII/latin1 string. pdf-lib stores drawn
 * text inside FlateDecode-compressed content streams as hex-encoded strings,
 * so each compressed chunk is inflated (node zlib) and its hex string tokens
 * are decoded before searching — the assertions still target the raw PDF
 * bytes, never a re-render.
 */
function pdfText(pdf: Uint8Array): string {
  const buf = Buffer.from(pdf)
  const raw = buf.toString('latin1')
  let text = raw
  const streamRe = /stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = streamRe.exec(raw)) !== null) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end === -1) continue
    try {
      text += `\n${decodePdfHex(inflateSync(buf.subarray(start, end)).toString('latin1'))}\n`
    } catch {
      // Not a flate stream — leave as-is.
    }
  }
  // en-ZA grouping can render as a (narrow) no-break space; normalise so
  // formatted money matches with a plain space.
  return text.replace(/[\u00A0\u202F]/g, ' ')
}

/** Decodes `<...>` hex string tokens (single-byte chars, or UTF-16BE when BOM-prefixed). */
function decodePdfHex(content: string): string {
  const out: string[] = []
  const hexRe = /<([0-9a-fA-F]+)>/g
  let match: RegExpExecArray | null
  while ((match = hexRe.exec(content)) !== null) {
    const hex = match[1]
    if (hex.length % 2 !== 0) continue
    const bytes = Buffer.from(hex, 'hex')
    if (hex.startsWith('FEFF') && hex.length > 4) {
      // UTF-16BE: swap to LE so Buffer can decode it.
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const t = bytes[i]
        bytes[i] = bytes[i + 1]
        bytes[i + 1] = t
      }
      out.push(bytes.toString('utf16le').replace(/^\uFEFF/, ''))
    } else {
      out.push(bytes.toString('latin1'))
    }
  }
  return out.join('\n')
}

describe('buildInvoicePdf', () => {
  it('produces a valid PDF buffer containing invoice number and company name as text', async () => {
    const pdf = await buildInvoicePdf(PDF_INVOICE, PDF_SETTINGS)
    expect(pdf).toBeInstanceOf(Uint8Array)
    expect(pdf.length).toBeGreaterThan(500)
    expect(pdfText(pdf).startsWith('%PDF-')).toBe(true)
    const text = pdfText(pdf)
    expect(text).toContain('INV-2026-0042')
    expect(text).toContain('Zano Consulting (Pty) Ltd')
    expect(text).toContain('TAX INVOICE')
    expect(text).toContain('Rand Water Authority')
    // en-ZA money format: R 5 750,00 (space grouping, comma decimal).
    expect(text).toContain('R 5 750,00')
  })

  it('round-trips through PDFDocument.load with correct document metadata', async () => {
    const pdf = await buildInvoicePdf(PDF_INVOICE, PDF_SETTINGS)
    const loaded = await PDFDocument.load(pdf)
    expect(loaded.getTitle()).toBe('Tax Invoice INV-2026-0042')
    expect(loaded.getAuthor()).toBe('Zano Consulting (Pty) Ltd')
  })

  it('titles credit notes CREDIT NOTE', async () => {
    const credit: Invoice = {
      ...PDF_INVOICE,
      creditNote: true,
      invoiceNumber: 'CN-2026-0001',
    }
    const pdf = await buildInvoicePdf(credit, PDF_SETTINGS)
    const text = pdfText(pdf)
    expect(text.startsWith('%PDF-')).toBe(true)
    expect(text).toContain('CREDIT NOTE')
    expect(text).toContain('CN-2026-0001')
  })
})

describe('writeInvoicePdf (openInPdf generation path)', () => {
  it('writes a real PDF file that starts with %PDF-', async () => {
    const dir = join(tmpdir(), `books-pdf-test-${randomUUID().slice(0, 8)}`)
    mkdirSync(dir, { recursive: true })
    try {
      const target = join(dir, 'Tax_Invoice_INV-2026-0042.pdf')
      const result = await writeInvoicePdf(PDF_INVOICE, PDF_SETTINGS, target)
      expect(result.ok).toBe(true)
      expect(result.path).toBe(target)
      expect(existsSync(target)).toBe(true)
      const bytes = readFileSync(target)
      expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-')
      expect(bytes.length).toBeGreaterThan(500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns { ok: false, error } when generation fails', async () => {
    const result = await writeInvoicePdf(
      null as unknown as Invoice,
      PDF_SETTINGS,
      join(tmpdir(), 'should-not-exist.pdf'),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(existsSync(join(tmpdir(), 'should-not-exist.pdf'))).toBe(false)
  })
})
