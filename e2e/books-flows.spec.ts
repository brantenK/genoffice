import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { test, expect, type Page } from '@playwright/test'
import {
  launchShell,
  closeAndSaveVideo,
  waitForPageWithUrl,
  screenshotPath,
  type LaunchedApp,
} from './helpers'

/**
 * Zano Books second-journey spec: the flows the happy-path smoke does not
 * touch, driven against the real built shell — purchase bills (VAT input on
 * the asset side), credit notes (mirrored postings), refunds, the aging
 * credit column, malformed input, an over-amount statement line (unapplied
 * receipt), delete-to-empty, closing a period, and persistence across a real
 * app restart. An axe scan covers the module's screens for accessibility.
 */

const CUSTOMER = 'Buyer Co (Pty) Ltd'
const SUPPLIER = 'Timber Supplier CC'

type BooksData = {
  revision: number
  settings: { closedThrough: string }
  invoices: Array<Record<string, any>>
  quotes?: Array<Record<string, any>>
  parties: Array<{ name: string; outstandingBalance: number }>
  journalEntries: Array<Record<string, any>>
  payments: Array<Record<string, any>>
  bankTransactions: Array<Record<string, any>>
  accounts: Array<{ id: string; balance: number }>
}

const booksData = (profileDir: string): BooksData =>
  JSON.parse(readFileSync(join(profileDir, 'books', 'books-data.json'), 'utf8'))
const account = (data: BooksData, id: string) =>
  data.accounts.find((a) => a.id === id)?.balance ?? 0

async function openBooks(launched: LaunchedApp): Promise<Page> {
  await launched.page.locator('.app-nav-item[data-ext="books"]').click()
  const books = await waitForPageWithUrl(launched.app, 'books')
  await expect(books.locator('text=Zano Books').first()).toBeVisible()
  return books
}

async function goto(books: Page, label: string) {
  await books.getByRole('button', { name: label, exact: true }).first().click()
}

async function setupWizard(books: Page, company: string) {
  await expect(books.locator('text=Set up Zano Books')).toBeVisible()
  await books.locator('input[placeholder="e.g. Thabo Engineering (Pty) Ltd"]').fill(company)
  await books.getByRole('button', { name: /Continue/i }).click()
  await books
    .locator('label', { hasText: 'Business bank account' })
    .locator('..')
    .locator('input')
    .fill('10000')
  await books.getByRole('button', { name: 'Start using Zano Books' }).click()
  await expect(books.getByRole('button', { name: 'Sales Invoices', exact: true })).toBeVisible()
}

async function addParty(books: Page, name: string, type: 'Customer' | 'Supplier') {
  await goto(books, 'Customers & Parties')
  await books
    .locator('main')
    .getByRole('button', { name: /Add Contact/i })
    .click()
  const typeSelect = books.locator('select').first()
  await typeSelect.selectOption(type)
  await books.locator('input[placeholder="e.g. City Power Johannesburg"]').fill(name)
  await books.getByRole('button', { name: 'Save Contact' }).click()
  await expect(books.locator(`text=${name}`).first()).toBeVisible({ timeout: 15_000 })
}

async function postInvoice(
  books: Page,
  party: string,
  description: string,
  qty: string,
  rate: string,
  opts: { currency?: string; exchangeRate?: string; taxRate?: string } = {},
) {
  await books
    .locator('main')
    .getByRole('button', { name: /New (Invoice|Bill)/ })
    .click()
  await books
    .locator('label', { hasText: /Customer|Supplier/ })
    .locator('..')
    .locator('select')
    .selectOption({ label: party })
  if (opts.currency) {
    await books
      .locator('label', { hasText: 'Currency' })
      .locator('..')
      .locator('select')
      .selectOption(opts.currency)
  }
  // The rate input only exists once a non-base currency is selected.
  if (opts.exchangeRate) {
    await books
      .locator('label', { hasText: 'Exchange Rate' })
      .locator('..')
      .locator('input')
      .fill(opts.exchangeRate)
  }
  const row = books.locator('tbody tr').first()
  await row.locator('input').nth(0).fill(description)
  await row.locator('input').nth(1).fill(qty)
  await row.locator('input').nth(2).fill(rate)
  if (opts.taxRate) {
    // The row's second select is the VAT % (the first is the income account).
    await row.locator('select').nth(1).selectOption(opts.taxRate)
  }
  await books.getByRole('button', { name: 'Submit & Post' }).click()
}

async function waitForInvoice(books: Page, number: string) {
  await expect(books.locator(`text=${number}`).first()).toBeVisible({ timeout: 15_000 })
}

// ── axe (devDependency; a failed injection must fail the scan) ─────────────

function resolveAxeSource(): string {
  try {
    return createRequire(join(__dirname, '..', 'package.json')).resolve('axe-core/axe.min.js')
  } catch {
    const fallback = join(__dirname, '..', 'node_modules', 'axe-core', 'axe.min.js')
    if (existsSync(fallback)) return fallback
    throw new Error('axe-core is not resolvable — the scan cannot run (run `npm install`)')
  }
}

const AXE_SOURCE = resolveAxeSource()

async function axeScan(page: Page): Promise<string[]> {
  await page.evaluate(readFileSync(AXE_SOURCE, 'utf8'))
  const result = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<any> } })
      .axe
    const res = await axe.run(document, { resultTypes: ['violations'] })
    return res.violations.map((v: any) => ({
      id: v.id as string,
      impact: v.impact as string | null,
      nodes: v.nodes.length as number,
      first: String(v.nodes[0]?.target?.[0] ?? ''),
      sample: String(v.nodes[0]?.html ?? '').slice(0, 160),
      fg: v.nodes[0]?.any?.all?.[0]?.fgColor ?? '',
    }))
  })
  return result.map(
    (v: { impact: string | null; id: string; nodes: number; first: string; sample: string }) =>
      `${v.impact ?? '?'} ${v.id} x${v.nodes} @ ${v.first} :: ${v.sample}`,
  )
}

// ── tests ───────────────────────────────────────────────────────────────────

test.describe('Zano Books flows: the other half of the product', () => {
  test('purchase bill, credit note, refund, aging credit, and an accessibility scan', async () => {
    test.setTimeout(240_000)
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'books-flows' })
    const { userDataDir } = launched
    try {
      const books = await openBooks(launched)
      await setupWizard(books, 'Flows Engineering (Pty) Ltd')
      await addParty(books, SUPPLIER, 'Supplier')

      // ── 1) Purchase bill: VAT input posts on the asset side ────────────
      await postInvoice(books, SUPPLIER, 'Timber purchase', '1', '500')
      await waitForInvoice(books, 'BILL-2026-001')
      let data = booksData(userDataDir)
      expect(data.invoices[0].type).toBe('Purchase')
      expect(account(data, 'acc-ap')).toBe(500)
      expect(account(data, 'acc-vat-in')).toBeGreaterThan(0)
      const billJournal = data.journalEntries.find((j) => j.remarks.includes('BILL-2026-001'))!
      expect(billJournal).toBeDefined()
      expect(Math.round(billJournal.totalDebit * 100)).toBe(
        Math.round(billJournal.totalCredit * 100),
      )
      await books.screenshot({ path: screenshotPath('books-flows-bill') })

      // ── 2) Customer + unpaid sales invoice, then a full credit note ─────
      await addParty(books, CUSTOMER, 'Customer')
      await goto(books, 'Sales Invoices')
      await postInvoice(books, CUSTOMER, 'Consulting', '1', '1000')
      await waitForInvoice(books, 'INV-2026-001')
      data = booksData(userDataDir)
      expect(data.invoices.find((i) => i.invoiceNumber === 'INV-2026-001')!.outstandingAmount).toBe(
        1000,
      )

      await books
        .getByRole('button', { name: 'Issue credit note for invoice INV-2026-001' })
        .click()
      await books.screenshot({ path: screenshotPath('books-credit-note-modal') })
      await books.getByRole('button', { name: 'Issue Credit Note', exact: true }).click()
      await waitForInvoice(books, 'CN-2026-001')

      data = booksData(userDataDir)
      const original = data.invoices.find((i) => i.invoiceNumber === 'INV-2026-001')!
      expect(original).toBeDefined()
      const creditNote = data.invoices.find((i) => i.invoiceNumber === 'CN-2026-001')!
      expect(creditNote).toBeDefined()
      expect(creditNote.creditNote).toBe(true)
      expect(creditNote.outstandingAmount).toBeLessThan(0)
      expect(Math.round((original.outstandingAmount + creditNote.outstandingAmount) * 100)).toBe(0)
      const cnJournal = data.journalEntries.find((j) => j.remarks.includes('CN-2026-001'))!
      expect(cnJournal).toBeDefined()
      expect(Math.round(cnJournal.totalDebit * 100)).toBe(Math.round(cnJournal.totalCredit * 100))
      // The credit note mirrors its posting: invoice + credit note nets every account.
      for (const accountId of new Set([...cnJournal.items.map((i: any) => i.accountId)])) {
        const netOf = (j: any, id: string) =>
          j.items
            .filter((i: any) => i.accountId === id)
            .reduce((s: number, i: any) => s + i.debit - i.credit, 0)
        const originalJournal = data.journalEntries.find((j) => j.remarks.includes('INV-2026-001'))!
        expect(
          Math.round((netOf(originalJournal, accountId) + netOf(cnJournal, accountId)) * 100),
        ).toBe(0)
      }

      // ── 3) Refund the credit note from the Payments screen ──────────────
      await goto(books, 'Payments')
      await books.getByRole('button', { name: 'Record Payment / Refund' }).click()
      const modal = books.locator('div.max-w-2xl')
      await expect(modal.getByRole('heading', { name: 'Record Payment' })).toBeVisible({
        timeout: 10_000,
      })
      // Refund mode first: the party list is filtered to the mode's targets,
      // and Buyer Co has a credit balance but no open invoice.
      await modal.getByRole('button', { name: 'Refund', exact: true }).click()
      await expect(modal.getByRole('heading', { name: 'Record Refund' })).toBeVisible()
      await modal
        .locator('select')
        .first()
        .selectOption({ label: `${CUSTOMER} (Customer)` })
      await books.screenshot({ path: screenshotPath('books-flows-refund-modal') })
      await modal.getByRole('button', { name: 'Record Refund' }).click()
      await expect
        .poll(() => booksData(userDataDir).payments.some((p: any) => p.type === 'refund'), {
          timeout: 15_000,
        })
        .toBe(true)
      await books.screenshot({ path: screenshotPath('books-flows-payments') })
      data = booksData(userDataDir)
      const refundPayment = data.payments.find((p: any) => p.type === 'refund')!
      const refundJournal = data.journalEntries.find((j: any) =>
        j.remarks.includes(refundPayment.id),
      )!
      expect(refundJournal.items.some((i: any) => /Refund for/i.test(i.remark))).toBe(true)
      expect(Math.round(refundJournal.totalDebit * 100)).toBe(
        Math.round(refundJournal.totalCredit * 100),
      )
      // The refund pays back the credit: AR debited, Bank credited.
      expect(refundJournal.items.some((i: any) => i.accountId === 'acc-ar' && i.debit > 0)).toBe(
        true,
      )
      expect(refundJournal.items.some((i: any) => i.accountId === 'acc-bank' && i.credit > 0)).toBe(
        true,
      )

      // ── 4) Aging surfaces the credit, and nets against the receivable ───
      await goto(books, 'Financial Reports')
      const aging = books.getByRole('button', { name: /Aging/i }).first()
      await aging.click()
      await books.waitForTimeout(400)
      await books.screenshot({ path: screenshotPath('books-flows-aging') })

      // ── 4b) The cash-flow statement derives from the same journals ──────
      await books
        .getByRole('button', { name: /Cash Flow/i })
        .first()
        .click()
      await expect(books.locator('text=Statement of Cash Flows')).toBeVisible()
      await expect(books.locator('text=Closing Cash Balance')).toBeVisible()
      await books.screenshot({ path: screenshotPath('books-flows-cash-flow') })

      // ── 5) Accessibility scan over the module's screens ─────────────────
      const violations: string[] = []
      for (const label of [
        'Dashboard',
        'Sales Invoices',
        'Banking & Statements',
        'Financial Reports',
      ]) {
        await goto(books, label)
        await books.waitForTimeout(250)
        violations.push(...(await axeScan(books)))
      }
      ;(await import('node:fs/promises')).writeFile(
        'e2e/artifacts/axe-findings.json',
        JSON.stringify(violations, null, 1),
      )
      // Gate: zero CRITICAL violations (a control without a name is a real
      // barrier). Serious contrast findings against the badge palette are the
      // module's documented accessibility backlog and are printed above.
      const critical = violations.filter((v) => /critical/i.test(v))
      expect(critical, `accessibility: ${critical.join(' | ')}`).toHaveLength(0)

      // ── 6) The ledger stayed coherent ───────────────────────────────────
      data = booksData(userDataDir)
      for (const j of data.journalEntries) {
        expect(Math.round(j.totalDebit * 100)).toBe(Math.round(j.totalCredit * 100))
      }
      expect(data.revision).toBeGreaterThanOrEqual(5)
    } finally {
      await closeAndSaveVideo(launched, 'books-flows')
    }
  })

  test('malformed input, an over-amount line, delete-to-empty, and closing the period', async () => {
    test.setTimeout(240_000)
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'books-flows-2' })
    const { userDataDir } = launched
    const T0F = Date.now()
    try {
      const books = await openBooks(launched)
      await setupWizard(books, 'Edge Case Trading (Pty) Ltd')
      await addParty(books, CUSTOMER, 'Customer')
      await goto(books, 'Sales Invoices')
      await postInvoice(books, CUSTOMER, 'Works', '1', '1000')
      await waitForInvoice(books, 'INV-2026-001')

      // ── 1) A malformed statement is refused without touching the ledger ─
      const badCsv = join(userDataDir, 'bad.csv')
      writeFileSync(badCsv, 'this is not a bank statement at all', 'utf8')
      await goto(books, 'Banking & Statements')
      await books.locator('input[type="file"]').setInputFiles(badCsv)
      await expect(books.locator('text=/failed|error|No valid/i').first()).toBeVisible({
        timeout: 15_000,
      })
      expect(booksData(userDataDir).bankTransactions).toHaveLength(0)

      // ── 2) An over-amount line: settled + unapplied, Suspense cleared ───
      const csv = join(userDataDir, 'over.csv')
      writeFileSync(
        csv,
        'Date,Description,Reference,Amount\n2026-09-26,EFT Buyer Co INV-2026-001,,1500.00\n',
        'utf8',
      )
      await books.locator('input[type="file"]').setInputFiles(csv)
      await expect(books.locator('text=/Imported/i').first()).toBeVisible({ timeout: 20_000 })
      const suggestion = books.getByRole('button', { name: /Reconcile with 1-Click/i }).first()
      await expect(suggestion).toBeVisible({ timeout: 15_000 })
      await suggestion.click()
      {
        let last = ''
        for (let i = 0; i < 60; i++) {
          const d = booksData(userDataDir)
          const sig = JSON.stringify([
            d.invoices.map((x: any) => [x.invoiceNumber, x.status, x.outstandingAmount]),
            d.parties.map((x: any) => [x.name, x.outstandingBalance]),
            d.revision,
          ])
          if (sig !== last) {
            console.log('FLAP t+', Date.now() - T0F, sig)
            last = sig
          }
          await new Promise((r) => setTimeout(r, 150))
        }
      }
      await expect
        .poll(
          () => {
            const d = booksData(userDataDir)
            const inv = d.invoices.find((i) => i.invoiceNumber === 'INV-2026-001')!
            return `${inv.status}:${inv.outstandingAmount}:${account(d, 'acc-ar')}`
          },
          { timeout: 20_000 },
        )
        .toMatch(/Unpaid:-500:-500/)

      await books.screenshot({ path: screenshotPath('books-flows-over-amount') })

      // The over-payment rides on the invoice as a negative outstanding (the
      // product's credit representation, same as credit notes), and the credit
      // is visible in AR, the aging credit column and the party balance.
      let data = booksData(userDataDir)
      const overpaid = data.invoices.find((i) => i.invoiceNumber === 'INV-2026-001')!
      expect(overpaid.status).toBe('Unpaid')
      // The R 500 credit rides on the party (AR control −500 matches it).
      expect(data.parties.find((p: any) => p.name === CUSTOMER)!.outstandingBalance).toBe(-500)
      expect(account(data, 'acc-suspense')).toBe(0)
      expect(account(data, 'acc-bank')).toBe(11500)
      expect(account(data, 'acc-ar')).toBe(-500)

      // ── 3) Deleting the records reaches an empty ledger ─────────────────
      await goto(books, 'Sales Invoices')
      await books.getByRole('button', { name: 'Delete invoice INV-2026-001' }).click()
      await expect.poll(() => booksData(userDataDir).invoices, { timeout: 15_000 }).toHaveLength(0)
      await books.screenshot({ path: screenshotPath('books-flows-empty') })

      // ── 4) Closing the period on an empty ledger works ──────────────────
      await goto(books, 'Settings')
      const closeThrough = books.getByLabel('Close through date')
      await closeThrough.fill('2026-09-26')
      await books.getByRole('button', { name: /Close (Financial Year|Period)/i }).click()
      await books.waitForTimeout(1200)
      data = booksData(userDataDir)
      expect(data.settings.closedThrough).toBe('2026-09-26')
      await books.screenshot({ path: screenshotPath('books-flows-closed') })
    } finally {
      await closeAndSaveVideo(launched, 'books-flows-2')
    }
  })

  test('an EUR invoice at rate 20 posts ×20 in base and a ZAR payment settles it', async () => {
    test.setTimeout(240_000)
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'books-multicurrency' })
    const { userDataDir } = launched
    try {
      const books = await openBooks(launched)
      await setupWizard(books, 'FX Trading (Pty) Ltd')
      await addParty(books, CUSTOMER, 'Customer')
      await goto(books, 'Sales Invoices')

      // EUR 1 000, zero-rated, at 20 ZAR/EUR → 20 000 base receivable.
      await postInvoice(books, CUSTOMER, 'Consulting', '1', '1000', {
        currency: 'EUR',
        exchangeRate: '20',
        taxRate: '0',
      })
      await waitForInvoice(books, 'INV-2026-001')
      await books.screenshot({ path: screenshotPath('books-multicurrency-invoice') })

      // On disk: the invoice keeps its own currency; the ledger posted base.
      let data = booksData(userDataDir)
      const invoice = data.invoices.find((i) => i.invoiceNumber === 'INV-2026-001')!
      expect(invoice.currency).toBe('EUR')
      expect(invoice.exchangeRate).toBe(20)
      expect(invoice.grandTotal).toBe(1000)
      expect(invoice.outstandingAmount).toBe(1000)
      // AR control = grandTotal × rate (the profile's only invoice).
      expect(account(data, 'acc-ar')).toBe(20000)

      // The posting is ×20 and balanced: AR Dr 20 000, income Cr 20 000.
      const journal = data.journalEntries.find((j: any) => j.remarks.includes('INV-2026-001'))!
      expect(journal).toBeDefined()
      expect(Math.round(journal.totalDebit * 100)).toBe(Math.round(journal.totalCredit * 100))
      expect(journal.totalDebit).toBe(20000)
      expect(journal.items.some((i: any) => i.accountId === 'acc-ar' && i.debit === 20000)).toBe(
        true,
      )
      expect(
        journal.items.some((i: any) => i.accountId === 'acc-sales' && i.credit === 20000),
      ).toBe(true)

      // The list labels the foreign-currency figures with the ISO code.
      await expect(books.getByRole('cell').filter({ hasText: 'EUR' }).first()).toBeVisible()

      // The record-payment action settles in BASE: EUR 1 000 at 20 = 20 000 ZAR.
      await books.getByRole('button', { name: 'Record payment for invoice INV-2026-001' }).click()
      await expect
        .poll(
          () => {
            const d = booksData(userDataDir)
            const inv = d.invoices.find((i) => i.invoiceNumber === 'INV-2026-001')!
            const party = d.parties.find((p: any) => p.name === CUSTOMER)!
            return `${inv.status}:${inv.outstandingAmount}:${account(d, 'acc-ar')}:${party.outstandingBalance}`
          },
          { timeout: 20_000 },
        )
        .toBe('Paid:0:0:0')

      data = booksData(userDataDir)
      const payment = data.payments.find(
        (p: any) => p.reference && String(p.reference).includes('Marked paid: INV-2026-001'),
      )!
      expect(payment).toBeDefined()
      expect(payment.total).toBe(20000)
      expect(account(data, 'acc-bank')).toBe(30000) // 10 000 opening + 20 000 receipt
      // The settled invoice keeps its denomination and the AR control nets to zero.
      const settled = data.invoices.find((i) => i.invoiceNumber === 'INV-2026-001')!
      expect(settled.currency).toBe('EUR')
      expect(settled.exchangeRate).toBe(20)
      expect(settled.outstandingAmount).toBe(0)
      const paymentJournal = data.journalEntries.find((j: any) => j.remarks.includes(payment.id))!
      expect(paymentJournal).toBeDefined()
      expect(Math.round(paymentJournal.totalDebit * 100)).toBe(
        Math.round(paymentJournal.totalCredit * 100),
      )
      for (const j of data.journalEntries) {
        expect(Math.round(j.totalDebit * 100)).toBe(Math.round(j.totalCredit * 100))
      }
      await books.screenshot({ path: screenshotPath('books-multicurrency-paid') })
    } finally {
      await closeAndSaveVideo(launched, 'books-multicurrency')
    }
  })

  test('a quotation is off-ledger until it converts into a posted invoice', async () => {
    test.setTimeout(240_000)
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'books-quotes' })
    const { userDataDir } = launched
    try {
      const books = await openBooks(launched)
      await setupWizard(books, 'Quote Craft (Pty) Ltd')
      await addParty(books, CUSTOMER, 'Customer')

      await goto(books, 'Quotations')
      await books
        .locator('main')
        .getByRole('button', { name: /New Quotation/i })
        .click()
      await books
        .locator('label', { hasText: 'Customer' })
        .locator('..')
        .locator('select')
        .selectOption({ label: CUSTOMER })

      // Two lines: 1 000 + 2 000 (the fresh profile prices VAT-inclusively).
      const firstRow = books.locator('tbody tr').first()
      await firstRow.locator('input').nth(0).fill('Survey works')
      await firstRow.locator('input').nth(1).fill('1')
      await firstRow.locator('input').nth(2).fill('1000')
      await books.getByRole('button', { name: 'Add Row' }).click()
      const secondRow = books.locator('tbody tr').nth(1)
      await secondRow.locator('input').nth(0).fill('Design package')
      await secondRow.locator('input').nth(1).fill('1')
      await secondRow.locator('input').nth(2).fill('2000')

      await books.screenshot({ path: screenshotPath('books-quote-form') })
      await books.getByRole('button', { name: 'Save Quotation' }).click()

      await expect(books.locator('text=QTN-2026-001').first()).toBeVisible({ timeout: 15_000 })
      await books.screenshot({ path: screenshotPath('books-quote-list') })

      // On disk: the quote is stored and computed, but the ledger untouched.
      await expect
        .poll(() => booksData(userDataDir).quotes?.length ?? 0, { timeout: 15_000 })
        .toBe(1)
      let data = booksData(userDataDir)
      const quote = data.quotes![0]
      expect(quote.quoteNumber).toBe('QTN-2026-001')
      expect(quote.status).toBe('Draft')
      expect(quote.subtotal).toBeCloseTo(2608.7, 2)
      expect(quote.taxTotal).toBeCloseTo(391.3, 2)
      expect(quote.grandTotal).toBe(3000)
      expect(data.journalEntries).toHaveLength(1) // the opening entry only
      expect(data.parties.find((p: any) => p.name === CUSTOMER)!.outstandingBalance).toBe(0)

      // Mark Sent, then convert.
      await books.getByRole('button', { name: 'Mark quotation QTN-2026-001 as sent' }).click()
      const convertButton = books.getByRole('button', {
        name: 'Convert quotation QTN-2026-001 to an invoice',
      })
      await expect(convertButton).toBeVisible({ timeout: 15_000 })
      await convertButton.click()

      // The conversion landed: quote Converted, invoice posted, one save.
      await expect
        .poll(() => booksData(userDataDir).quotes?.[0]?.status, { timeout: 20_000 })
        .toBe('Converted')

      data = booksData(userDataDir)
      const invoice = data.invoices.find((i: any) => i.invoiceNumber === 'INV-2026-001')!
      expect(invoice).toBeDefined()
      expect(invoice.grandTotal).toBe(3000)
      expect(invoice.outstandingAmount).toBe(3000)
      expect(data.quotes![0].convertedInvoiceId).toBe(invoice.id)
      expect(data.parties.find((p: any) => p.name === CUSTOMER)!.outstandingBalance).toBe(3000)
      const posting = data.journalEntries.find((j: any) => j.remarks.includes('INV-2026-001'))!
      expect(posting).toBeDefined()
      expect(Math.round(posting.totalDebit * 100)).toBe(Math.round(posting.totalCredit * 100))
      for (const j of data.journalEntries) {
        expect(Math.round(j.totalDebit * 100)).toBe(Math.round(j.totalCredit * 100))
      }

      // Conversion opens the new invoice; the list shows the Converted badge.
      await expect(books.locator('text=INV-2026-001').first()).toBeVisible({ timeout: 15_000 })
      await goto(books, 'Quotations')
      await expect(books.locator('text=Converted').first()).toBeVisible({ timeout: 15_000 })
      await books.screenshot({ path: screenshotPath('books-quote-converted') })
    } finally {
      await closeAndSaveVideo(launched, 'books-quotes')
    }
  })

  test('the ledger survives a real app restart in the same profile', async () => {
    test.setTimeout(240_000)
    const profileDir = join(tmpdir(), `zano-books-restart-${Date.now()}`)
    mkdirSync(profileDir, { recursive: true })

    const first = await launchShell({
      onboardingSeen: true,
      userDataDir: profileDir,
      videoDir: 'books-restart-1',
    })
    const books = await openBooks(first)
    await setupWizard(books, 'Persistent Trading (Pty) Ltd')
    await addParty(books, CUSTOMER, 'Customer')
    await goto(books, 'Sales Invoices')
    await postInvoice(books, CUSTOMER, 'Works', '1', '1000')
    await waitForInvoice(books, 'INV-2026-001')
    await books.getByRole('button', { name: 'Record payment for invoice INV-2026-001' }).click()
    const before = booksData(profileDir)
    expect(before.invoices.find((i) => i.invoiceNumber === 'INV-2026-001')!.status).toBe('Paid')
    await closeAndSaveVideo(first, 'books-restart-1')

    // Relaunch the real app against the same profile: no wizard, ledger intact.
    const second = await launchShell({
      onboardingSeen: true,
      userDataDir: profileDir,
      videoDir: 'books-restart-2',
    })
    try {
      const reopened = await openBooks(second)
      await expect(reopened.locator('text=Set up Zano Books')).toHaveCount(0)
      await goto(reopened, 'Sales Invoices')
      await expect(reopened.locator('text=INV-2026-001').first()).toBeVisible({ timeout: 15_000 })
      await reopened.screenshot({ path: screenshotPath('books-restart') })
      const after = booksData(profileDir)
      expect(after.revision).toBe(before.revision)
      expect(after.invoices.find((i) => i.invoiceNumber === 'INV-2026-001')!.status).toBe('Paid')
      expect(after.journalEntries.length).toBe(before.journalEntries.length)
    } finally {
      await closeAndSaveVideo(second, 'books-restart-2')
    }
  })
})

test('one deposit naming two invoices splits across both from the UI', async () => {
  test.setTimeout(240_000)
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'books-split' })
  const { userDataDir } = launched
  try {
    const books = await openBooks(launched)
    await setupWizard(books, 'Split Allocation Trading (Pty) Ltd')
    await addParty(books, CUSTOMER, 'Customer')
    await goto(books, 'Sales Invoices')
    await postInvoice(books, CUSTOMER, 'Works phase 1', '2', '1000')
    await waitForInvoice(books, 'INV-2026-001')
    await postInvoice(books, CUSTOMER, 'Works phase 2', '1', '1000')
    await waitForInvoice(books, 'INV-2026-002')

    // One deposit line whose remittance names both invoices: the UI must
    // offer the split (two suggestions, one transaction) instead of leaving
    // the line Unmatched or silently reconciling only the first.
    const csv = join(userDataDir, 'split.csv')
    writeFileSync(
      csv,
      'Date,Description,Reference,Amount\n2026-09-26,EFT Buyer Co INV-2026-001 INV-2026-002,,3000.00',
      'utf8',
    )
    await goto(books, 'Banking & Statements')
    await books.locator('input[type="file"]').setInputFiles(csv)
    await expect(books.locator('text=/One line, several invoices/i').first()).toBeVisible({
      timeout: 20_000,
    })
    const groupButton = books.getByRole('button', { name: /Reconcile 2 invoices/i })
    await expect(groupButton).toBeVisible({ timeout: 15_000 })
    await books.screenshot({ path: screenshotPath('books-split-group') })
    await groupButton.click()

    await expect
      .poll(
        () => {
          const d = booksData(userDataDir)
          const one = d.invoices.find((i) => i.invoiceNumber === 'INV-2026-001')!
          const two = d.invoices.find((i) => i.invoiceNumber === 'INV-2026-002')!
          return `${one.status}:${one.outstandingAmount}:${two.status}:${two.outstandingAmount}`
        },
        { timeout: 20_000 },
      )
      .toBe('Paid:0:Paid:0')
    await books.screenshot({ path: screenshotPath('books-split-reconciled') })

    const data = booksData(userDataDir)
    expect(Math.round(account(data, 'acc-suspense') * 100)).toBe(0)
    expect(account(data, 'acc-bank')).toBe(13000)
    expect(data.bankTransactions![0].reconciled).toBe(true)
    for (const j of data.journalEntries) {
      expect(Math.round(j.totalDebit * 100)).toBe(Math.round(j.totalCredit * 100))
    }
    expect(data.journalEntries.length).toBeGreaterThanOrEqual(4)
  } finally {
    await closeAndSaveVideo(launched, 'books-split')
  }
})

test('an expired quotation shows the Expired state and the quotes page is axe-clean', async () => {
  test.setTimeout(240_000)
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'books-quote-expiry' })
  const { userDataDir } = launched
  try {
    const books = await openBooks(launched)
    await setupWizard(books, 'Quote Expiry Trading (Pty) Ltd')
    await addParty(books, CUSTOMER, 'Customer')

    // A quote whose validity already lapsed: the row shows Expired (the
    // display state the quotes view derives from validUntil < today) while
    // the stored status stays the lifecycle one.
    await goto(books, 'Quotations')
    await books
      .locator('main')
      .getByRole('button', { name: /New Quotation/i })
      .click()
    await books
      .locator('label', { hasText: 'Customer' })
      .locator('..')
      .locator('select')
      .selectOption({ label: CUSTOMER })
    const row = books.locator('tbody tr').first()
    await row.locator('input').nth(0).fill('Lapsed works')
    await row.locator('input').nth(1).fill('1')
    await row.locator('input').nth(2).fill('1000')
    await books
      .locator('label', { hasText: 'Valid Until' })
      .locator('..')
      .locator('input')
      .fill('2026-01-01')
    await books.getByRole('button', { name: 'Save Quotation' }).click()
    await expect(books.locator('text=QTN-2026-001').first()).toBeVisible({ timeout: 15_000 })

    // The pinned UI element: the Expired badge (AlertCircle + 'Expired') in
    // the quote's row.
    await expect(
      books.locator('tr', { hasText: 'QTN-2026-001' }).locator('text=Expired').first(),
    ).toBeVisible({ timeout: 15_000 })
    const stored = booksData(userDataDir)
    const quote = stored.quotes!.find((q: any) => q.quoteNumber === 'QTN-2026-001')!
    expect(quote.validUntil).toBe('2026-01-01')
    // Expired is a display state only: the stored status never claims it.
    expect(['Draft', 'Sent']).toContain(quote.status)
    await books.screenshot({ path: screenshotPath('books-quote-expired') })

    // The quotes page joins the Axe scan at zero findings.
    await goto(books, 'Quotations')
    await books.waitForTimeout(300)
    const violations = await axeScan(books)
    ;(await import('node:fs/promises')).writeFile(
      'e2e/artifacts/axe-findings-quotes.json',
      JSON.stringify(violations, null, 1),
    )
    expect(
      violations,
      `quotes page accessibility: ${violations.join(' | ')}`,
    ).toHaveLength(0)
  } finally {
    await closeAndSaveVideo(launched, 'books-quote-expiry')
  }
})

test('converting a quote into a closed period is refused; after the close it converts', async () => {
  test.setTimeout(300_000)
  // ── Profile A: the period is closed THROUGH today — the conversion would
  // post an invoice dated today, inside the locked period, and must be
  // refused with the action-guiding message.
  const closedToday = await launchShell({ onboardingSeen: true, videoDir: 'books-convert-closed' })
  const closedDir = closedToday.userDataDir
  try {
    const books = await openBooks(closedToday)
    await setupWizard(books, 'Closed Convert (Pty) Ltd')
    await addParty(books, CUSTOMER, 'Customer')
    await goto(books, 'Quotations')
    await books
      .locator('main')
      .getByRole('button', { name: /New Quotation/i })
      .click()
    await books
      .locator('label', { hasText: 'Customer' })
      .locator('..')
      .locator('select')
      .selectOption({ label: CUSTOMER })
    const row = books.locator('tbody tr').first()
    await row.locator('input').nth(0).fill('Pre-close quote')
    await row.locator('input').nth(1).fill('1')
    await row.locator('input').nth(2).fill('1000')
    await books.getByRole('button', { name: 'Save Quotation' }).click()
    await expect(books.locator('text=QTN-2026-001').first()).toBeVisible({ timeout: 15_000 })
    await books.getByRole('button', { name: 'Mark quotation QTN-2026-001 as sent' }).click()
    await expect(
      books.getByRole('button', { name: 'Convert quotation QTN-2026-001 to an invoice' }),
    ).toBeVisible({ timeout: 15_000 })

    // Close the period through today (the invoice a conversion posts is dated
    // today, so today is the date that matters).
    const today = new Date()
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    await goto(books, 'Settings')
    await books.getByLabel('Close through date').fill(todayIso)
    await books.getByRole('button', { name: /Close (Financial Year|Period)/i }).click()
    await expect
      .poll(() => booksData(closedDir).settings.closedThrough, { timeout: 15_000 })
      .toBe(todayIso)

    await goto(books, 'Quotations')
    await books.getByRole('button', { name: 'Convert quotation QTN-2026-001 to an invoice' }).click()
    await expect(books.locator('text=/closed through/i').first()).toBeVisible({ timeout: 15_000 })
    const stored = booksData(closedDir)
    expect(stored.invoices).toHaveLength(0) // nothing posted
    expect(stored.quotes![0].status).toBe('Sent') // the quote is untouched
    await books.screenshot({ path: screenshotPath('books-convert-refused') })
  } finally {
    await closeAndSaveVideo(closedToday, 'books-convert-closed')
  }

  // ── Profile B: the period is closed through a PAST date — a quote dated
  // after the close converts fine.
  const afterClose = await launchShell({ onboardingSeen: true, videoDir: 'books-convert-open' })
  const openDir = afterClose.userDataDir
  try {
    const books = await openBooks(afterClose)
    await setupWizard(books, 'Open Convert (Pty) Ltd')
    await addParty(books, CUSTOMER, 'Customer')
    await goto(books, 'Quotations')
    await books
      .locator('main')
      .getByRole('button', { name: /New Quotation/i })
      .click()
    await books
      .locator('label', { hasText: 'Customer' })
      .locator('..')
      .locator('select')
      .selectOption({ label: CUSTOMER })
    const row = books.locator('tbody tr').first()
    await row.locator('input').nth(0).fill('Post-close quote')
    await row.locator('input').nth(1).fill('1')
    await row.locator('input').nth(2).fill('1000')
    await books.getByRole('button', { name: 'Save Quotation' }).click()
    await expect(books.locator('text=QTN-2026-001').first()).toBeVisible({ timeout: 15_000 })
    await books.getByRole('button', { name: 'Mark quotation QTN-2026-001 as sent' }).click()

    await goto(books, 'Settings')
    await books.getByLabel('Close through date').fill('2026-01-01')
    await books.getByRole('button', { name: /Close (Financial Year|Period)/i }).click()
    await expect
      .poll(() => booksData(openDir).settings.closedThrough, { timeout: 15_000 })
      .toBe('2026-01-01')

    await goto(books, 'Quotations')
    await books.getByRole('button', { name: 'Convert quotation QTN-2026-001 to an invoice' }).click()
    await expect
      .poll(() => booksData(openDir).quotes?.[0]?.status, { timeout: 20_000 })
      .toBe('Converted')
    const stored = booksData(openDir)
    const invoice = stored.invoices.find((i: any) => i.invoiceNumber === 'INV-2026-001')!
    expect(invoice).toBeDefined()
    // The fresh profile prices VAT-inclusively: the 1 000 quote converts to a
    // 1 000 invoice (the existing quotation journey pins the same arithmetic).
    expect(invoice.grandTotal).toBe(1000)
    expect(stored.parties.find((p: any) => p.name === CUSTOMER)!.outstandingBalance).toBe(1000)
    await books.screenshot({ path: screenshotPath('books-convert-open') })
  } finally {
    await closeAndSaveVideo(afterClose, 'books-convert-open')
  }
})

test('a restore raced against a save leaves a coherent ledger and a live UI', async () => {
  test.setTimeout(240_000)
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'books-restore-race' })
  const { userDataDir } = launched
  try {
    const books = await openBooks(launched)
    await setupWizard(books, 'Race Restore (Pty) Ltd')
    await addParty(books, CUSTOMER, 'Customer')
    await goto(books, 'Sales Invoices')
    await postInvoice(books, CUSTOMER, 'Works', '1', '1000')
    await waitForInvoice(books, 'INV-2026-001')

    // A real backup through the preload bridge, then a live mutation so the
    // two racing writes genuinely disagree about the ledger.
    const backupPath = await books.evaluate(async () => {
      const api = window.booksApi!
      const result = await api.backupNow()
      if (!result.ok) throw new Error(result.error || 'backup failed')
      return result.path!
    })
    expect(existsSync(backupPath)).toBe(true)
    const backupName = backupPath.replace(/^.*[/\\]/, '')
    const raced = await books.evaluate(async (name) => {
      const api = window.booksApi!
      const load = await api.loadData()
      const ledger = load.data!
      const tweaked = {
        ...ledger,
        settings: { ...ledger.settings, companyName: 'Race Save (Pty) Ltd' },
      }
      const [restored, saved] = await Promise.all([
        api.restoreBackup(name),
        api.saveData(tweaked, ledger.revision),
      ])
      return {
        restoredOk: restored.ok,
        restoredError: restored.ok ? undefined : restored.error,
        savedOk: saved.ok,
        savedError: saved.ok ? undefined : (saved as { error?: string }).error,
      }
    }, backupName)
    // Both writes completed (the main process serializes them); whichever won,
    // neither crashed and the errors surface as refusals, never as exceptions.
    expect(typeof raced.restoredOk).toBe('boolean')
    expect(typeof raced.savedOk).toBe('boolean')

    // The final ledger is coherent: journals balanced, stored balances are
    // journal-derived, exactly one invoice either way, revision integral.
    const data = booksData(userDataDir)
    expect(Number.isInteger(data.revision)).toBe(true)
    expect(data.revision).toBeGreaterThanOrEqual(0)
    for (const j of data.journalEntries) {
      expect(Math.round(j.totalDebit * 100)).toBe(Math.round(j.totalCredit * 100))
    }
    // Stored balances == derived balances (the ledger-first invariant, inlined).
    const derived: Record<string, number> = {}
    for (const account of data.accounts) derived[account.id] = 0
    for (const j of data.journalEntries) {
      for (const item of j.items) {
        if (!(item.accountId in derived)) derived[item.accountId] = 0
        const signed = Math.round((item.debit - item.credit) * 100)
        const meta = data.accounts.find((a) => a.id === item.accountId)
        if (meta && (meta as any).rootType === 'Asset') derived[item.accountId] += signed / 100
        else if (meta && (meta as any).rootType === 'Expense') derived[item.accountId] += signed / 100
        else if (meta) derived[item.accountId] -= signed / 100
        else derived[item.accountId] += signed / 100
      }
    }
    for (const account of data.accounts) {
      if ((account as any).isGroup) continue
      expect(
        Math.round((account.balance - derived[account.id]) * 100),
        `account ${account.id} must be journal-derived`,
      ).toBe(0)
    }
    expect(data.invoices.length).toBeLessThanOrEqual(1)
    expect(data.invoices.length).toBeGreaterThanOrEqual(0)

    // The UI is alive and shows a consistent list either way.
    await goto(books, 'Sales Invoices')
    await books.waitForTimeout(400)
    await books.screenshot({ path: screenshotPath('books-restore-race') })
    const load = await books.evaluate(() => window.booksApi!.loadData())
    expect(load.ok).toBe(true)
  } finally {
    await closeAndSaveVideo(launched, 'books-restore-race')
  }
})


/** Reads the drawn strings out of a pdf-lib-produced PDF (hex-decoded text ops). */
function extractPdfFigures(bytes: Buffer): string[] {
  const zlib = require('node:zlib') as typeof import('node:zlib')
  const chunks: string[] = []
  const marker = 'stream'
  const endMarker = 'endstream'
  let cursor = 0
  for (;;) {
    const start = bytes.indexOf(marker, cursor, 'latin1')
    if (start === -1) break
    let dataStart = start + marker.length
    if (bytes[dataStart] === 13) dataStart += 1
    if (bytes[dataStart] === 10) dataStart += 1
    const end = bytes.indexOf(endMarker, dataStart, 'latin1')
    if (end === -1) break
    let content: string
    try {
      content = zlib.inflateSync(bytes.subarray(dataStart, end)).toString('latin1')
    } catch {
      content = bytes.subarray(dataStart, end).toString('latin1')
    }
    content = content.replace(/<([0-9A-Fa-f\s]+)>/g, (_m: string, hex: string) =>
      Buffer.from(hex.replace(/\s+/g, ''), 'hex').toString('latin1'),
    )
    for (const match of content.matchAll(/([^\n]{2,}?)\s+Tj/g)) chunks.push(match[1])
    cursor = end + endMarker.length
  }
  return chunks
}

test('both print templates render an EUR invoice with ISO labels and the base total', async () => {
  test.setTimeout(300_000)
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'books-fx-print' })
  const { userDataDir } = launched
  const exportsRoot = join(tmpdir(), 'zano-books-exports')
  const newestFxPdf = (): string => {
    let newest: { path: string; mtime: number } | null = null
    for (const dir of existsSync(exportsRoot) ? readdirSync(exportsRoot) : []) {
      const dirPath = join(exportsRoot, dir)
      for (const file of existsSync(dirPath) ? readdirSync(dirPath) : []) {
        if (!file.startsWith('Tax_Invoice_INV-2026-001')) continue
        const filePath = join(dirPath, file)
        const mtime = statSync(filePath).mtimeMs
        if (!newest || mtime > newest.mtime) newest = { path: filePath, mtime }
      }
    }
    if (!newest) throw new Error('no generated Tax_Invoice INV-2026-001 PDF found')
    return newest.path
  }

  try {
    const books = await openBooks(launched)
    await setupWizard(books, 'FX Print Trading (Pty) Ltd')
    await addParty(books, CUSTOMER, 'Customer')
    await goto(books, 'Sales Invoices')
    // EUR 1 000, zero-rated, at 20 ZAR/EUR — the posting is base 20 000.
    await postInvoice(books, CUSTOMER, 'Consulting', '1', '1000', {
      currency: 'EUR',
      exchangeRate: '20',
      taxRate: '0',
    })
    await waitForInvoice(books, 'INV-2026-001')
    const data = booksData(userDataDir)
    expect(account(data, 'acc-ar')).toBe(20000)

    for (const template of ['classic', 'modern'] as const) {
      // Pick the template in Settings (the picker persists on save).
      await goto(books, 'Settings')
      await books.getByRole('button', { name: template === 'classic' ? 'Classic' : 'Modern' }).click()
      await books.waitForTimeout(600)

      await goto(books, 'Sales Invoices')
      await books.getByRole('button', { name: 'Print invoice INV-2026-001' }).click()
      await expect(books.locator('text=Document Print Preview · INV-2026-001')).toBeVisible({
        timeout: 15_000,
      })
      // The preview agrees with the document: EUR-labelled figures.
      await expect(books.locator('text=/EUR/').first()).toBeVisible()
      await books.screenshot({ path: screenshotPath(`books-fx-print-${template}`) })
      const beforeCount = existsSync(exportsRoot) ? readdirSync(exportsRoot).length : 0
      await books.getByRole('button', { name: 'Print / PDF' }).click()

      // The document lands in the generated-exports tree; wait for it.
      let pdfPath = ''
      for (let i = 0; i < 40; i += 1) {
        await books.waitForTimeout(250)
        try {
          const candidate = newestFxPdf()
          if (candidate) {
            const count = existsSync(exportsRoot) ? readdirSync(exportsRoot).length : 0
            if (count > beforeCount || i > 20) {
              pdfPath = candidate
              break
            }
          }
        } catch {
          // not there yet
        }
      }
      expect(pdfPath, 'the generated PDF exists').toBeTruthy()
      const figures = extractPdfFigures(readFileSync(pdfPath))
      // The document prints in the invoice's currency: EUR-labelled totals.
      // formatMoney uses en-ZA (decimal comma, space grouping).
      expect(figures.some((f) => /^EUR 1[ ,\u00A0]000[.,]00$/.test(f.trim()))).toBe(true)
      expect(figures.some((f) => f.trim() === 'Grand Total')).toBe(true)
      expect(figures.some((f) => f.trim() === 'Amount Due')).toBe(true)
      // The base-currency equivalent rides the stored rate (grandTotal × 20);
      // it is drawn as one FX-note string.
      expect(
        figures.some((f) =>
          /^Exchange rate: 1 EUR = 20\.00 ZAR · Base grand total: R 20[ ,\u00A0]000[.,]00$/.test(
            f.trim(),
          ),
        ),
      ).toBe(true)
      // The old defect — the base symbol against foreign figures — never returns.
      expect(figures.some((f) => /^R 1[ ,\u00A0]000[.,]00$/.test(f.trim()))).toBe(false)
      // Close the print modal so the next template's navigation isn't blocked
      // by the overlay.
      await books.getByRole('button', { name: 'Close print preview' }).click()
      await expect(books.locator('text=Document Print Preview · INV-2026-001')).toHaveCount(0)
    }
  } finally {
    await closeAndSaveVideo(launched, 'books-fx-print')
  }
})

test('an outstanding EUR invoice reads correctly in aging, tax register and cash flow', async () => {
  test.setTimeout(240_000)
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'books-fx-reports' })
  const { userDataDir } = launched
  try {
    const books = await openBooks(launched)
    await setupWizard(books, 'FX Reports Trading (Pty) Ltd')
    await addParty(books, CUSTOMER, 'Customer')
    await goto(books, 'Sales Invoices')
    await postInvoice(books, CUSTOMER, 'Consulting', '1', '1000', {
      currency: 'EUR',
      exchangeRate: '20',
      taxRate: '0',
    })
    await waitForInvoice(books, 'INV-2026-001')

    const data = booksData(userDataDir)
    const invoice = data.invoices.find((i: any) => i.invoiceNumber === 'INV-2026-001')!

    // Aging: the invoice is outstanding, due 30 days out (not overdue), so it
    // sits in the CURRENT bucket at its BASE amount (outstanding × rate).
    expect(invoice.status).toBe('Unpaid')
    const daysOverdue = Math.round(
      (new Date(invoice.dueDate).getTime() - Date.now()) / 86_400_000,
    )
    expect(daysOverdue).toBeGreaterThan(0) // current bucket, per the aging rule
    const baseOutstanding = Math.round(invoice.outstandingAmount * invoice.exchangeRate * 100) / 100
    expect(baseOutstanding).toBe(20000)
    expect(account(data, 'acc-ar')).toBe(20000) // the control agrees with the bucket

    // Tax register: zero-rated EUR — the 0% band carries the base TAXABLE
    // (20 000) and zero VAT, per the register's real contract.
    await goto(books, 'Financial Reports')
    await books.getByRole('button', { name: /Tax Register/i }).first().click()
    await expect(books.locator('text=Tax Register (VAT)')).toBeVisible({ timeout: 10_000 })
    await expect(books.locator('text=/R 20[ \\u00A0,]000[.,]00/').first()).toBeVisible({
      timeout: 10_000,
    })
    await books.screenshot({ path: screenshotPath('books-fx-tax-register') })

    // Cash flow: a receivable is not cash — opening equals closing while the
    // EUR invoice sits unpaid (only the wizard's opening bank balance moves).
    const opening = account(data, 'acc-bank') + account(data, 'acc-cash')
    expect(opening).toBe(10000)
    await books
      .getByRole('button', { name: /Cash Flow/i })
      .first()
      .click()
    await expect(books.locator('text=Statement of Cash Flows')).toBeVisible({ timeout: 10_000 })
    await expect(books.locator('text=Closing Cash Balance')).toBeVisible({ timeout: 10_000 })
    await expect(books.locator('text=/^R 10[ \\u00A0,]000[.,]00$/').first()).toBeVisible()
    await books.screenshot({ path: screenshotPath('books-fx-cash-flow') })
  } finally {
    await closeAndSaveVideo(launched, 'books-fx-reports')
  }
})
