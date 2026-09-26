import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, expect } from '@playwright/test'
import {
  launchShell,
  closeAndSaveVideo,
  waitForPageWithUrl,
  screenshotPath,
  type LaunchedApp,
} from './helpers'

/**
 * Zano Books end-to-end smoke journey against the real built shell.
 *
 * The Books module renders in its own WebContentsView, so it surfaces as a
 * separate Playwright page (poll for a 'books' URL, the same pattern as
 * crm-smoke.spec.ts). One journey drives the module the way a user would:
 * first-run setup, a posted sales invoice, a recorded payment, reports, the
 * print preview, a PDF export, a bank-statement import with 1-click
 * reconciliation, backup/restore, and the audit trail. The on-disk ledger is
 * asserted directly, because the ledger file — not the DOM — is the product.
 *
 * A second, independent launch verifies the unreadable-store guard: a corrupt
 * books file must show the read-error screen (never the setup wizard) and the
 * file must be left byte-identical.
 */

const COMPANY = 'Smoke Test Engineering (Pty) Ltd'
const CUSTOMER = 'Smoke Client (Pty) Ltd'

async function openBooks(launched: LaunchedApp) {
  const { app, page } = launched
  await openAppFromHome(page)
  const books = await waitForPageWithUrl(app, 'books')
  await expect(books.locator('text=Zano Books').first()).toBeVisible()
  return books
}

// The Home sidebar groups business apps in the second `.app-nav` block.
async function openAppFromHome(page: import('@playwright/test').Page) {
  const item = page.locator('.app-nav-item[data-ext="books"]')
  await item.waitFor({ state: 'visible', timeout: 15_000 })
  await item.click()
}

async function booksData(profileDir: string) {
  return JSON.parse(readFileSync(join(profileDir, 'books', 'books-data.json'), 'utf8'))
}

async function goto(books: import('@playwright/test').Page, label: string) {
  await books.getByRole('button', { name: label, exact: true }).first().click()
}

test.describe('Zano Books smoke journey', () => {
  test('setup → invoice → payment → reports → print/PDF → banking → backup → audit', async () => {
    test.setTimeout(240_000)
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'books-smoke' })
    const { userDataDir } = launched
    try {
      const books = await openBooks(launched)

      // ── 1) First run: the two-step setup wizard, then a real first save ─
      await expect(books.locator('text=Set up Zano Books')).toBeVisible()
      await books
        .locator('input[placeholder="e.g. Thabo Engineering (Pty) Ltd"]')
        .fill(COMPANY)
      await books.locator('input[placeholder="e.g. 4920198273"]').fill('4920198273')
      await books.getByRole('button', { name: /Continue/i }).click()
      const bankField = books
        .locator('label', { hasText: 'Business bank account' })
        .locator('..')
        .locator('input')
      await bankField.fill('10000')
      await books.screenshot({ path: screenshotPath('books-setup-wizard') })
      await books.getByRole('button', { name: 'Start using Zano Books' }).click()
      await expect(books.getByRole('button', { name: 'Sales Invoices', exact: true })).toBeVisible()

      const first = await booksData(userDataDir)
      expect(first.settings.companyName).toBe(COMPANY)
      expect(first.revision).toBeGreaterThanOrEqual(1)
      expect(first.journalEntries.length).toBeGreaterThanOrEqual(1)

      // ── 2) Party, then a sales invoice: post it and see it in the list ──
      await goto(books, 'Customers & Parties')
      await books.locator('main').getByRole('button', { name: /Add Contact/i }).click()
      await books.locator('input[placeholder="e.g. City Power Johannesburg"]').fill(CUSTOMER)
      await books.screenshot({ path: screenshotPath('books-new-party') })
      await books.getByRole('button', { name: 'Save Contact' }).click()
      await expect(books.locator(`text=${CUSTOMER}`).first()).toBeVisible({ timeout: 15_000 })

      await goto(books, 'Sales Invoices')
      await books.locator('main').getByRole('button', { name: 'New Invoice' }).click()
      await books
        .locator('label', { hasText: 'Customer' })
        .locator('..')
        .locator('select')
        .selectOption({ label: CUSTOMER })
      const row = books.locator('tbody tr').first()
      await row.locator('input').nth(0).fill('Consulting works')
      await row.locator('input').nth(1).fill('2')
      await row.locator('input').nth(2).fill('1000')
      await expect(books.locator('text=/Grand Total/i').first()).toBeVisible()
      await books.screenshot({ path: screenshotPath('books-invoice-form') })
      await books.getByRole('button', { name: 'Submit & Post' }).click()
      await expect(books.locator('text=INV-2026-001').first()).toBeVisible({ timeout: 15_000 })

      let data = await booksData(userDataDir)
      expect(data.invoices).toHaveLength(1)
      expect(data.invoices[0].outstandingAmount).toBe(2000)
      const salesJournal = data.journalEntries.find((j: { remarks: string }) =>
        j.remarks.includes('INV-2026-001'),
      )
      expect(salesJournal.totalDebit).toBe(salesJournal.totalCredit)
      const arLeg = salesJournal.items.find((i: { accountId: string }) => i.accountId === 'acc-ar')
      expect(arLeg.debit).toBe(2000)

      // A second invoice stays open for the bank-reconciliation leg.
      await books.locator('main').getByRole('button', { name: 'New Invoice' }).click()
      await books
        .locator('label', { hasText: 'Customer' })
        .locator('..')
        .locator('select')
        .selectOption({ label: CUSTOMER })
      const row2 = books.locator('tbody tr').first()
      await row2.locator('input').nth(0).fill('Water works')
      await row2.locator('input').nth(1).fill('2')
      await row2.locator('input').nth(2).fill('1000')
      await books.getByRole('button', { name: 'Submit & Post' }).click()
      await expect(books.locator('text=INV-2026-002').first()).toBeVisible({ timeout: 15_000 })

      // ── 3) Record a payment against the first invoice ───────────────────
      const statusOf = (data: Awaited<ReturnType<typeof booksData>>, number: string) =>
        data.invoices.find((i: { invoiceNumber: string }) => i.invoiceNumber === number)?.status
      await books.getByRole('button', { name: 'Record payment for invoice INV-2026-001' }).click()
      // The invoice list persists asynchronously; wait for the ledger itself.
      await expect
        .poll(() => booksData(userDataDir).then((d) => statusOf(d, 'INV-2026-001')), { timeout: 15_000 })
        .toBe('Paid')
      await books.screenshot({ path: screenshotPath('books-invoice-paid') })

      data = await booksData(userDataDir)
      expect(data.payments.length).toBeGreaterThanOrEqual(1)

      // ── 4) Ledger views: journal + chart of accounts ────────────────────
      await goto(books, 'Journal Entries')
      await expect(books.locator('text=/Settlement|Payment/i').first()).toBeVisible()
      await books.screenshot({ path: screenshotPath('books-journal') })
      await goto(books, 'Chart of Accounts')
      await expect(books.locator('text=Accounts Receivable').first()).toBeVisible()
      await books.screenshot({ path: screenshotPath('books-coa') })

      // ── 5) Reports: P&L, balance sheet, aging ───────────────────────────
      await goto(books, 'Financial Reports')
      await expect(books.locator('text=/Profit|Income/i').first()).toBeVisible()
      await books.screenshot({ path: screenshotPath('books-report-pnl') })
      for (const report of ['Balance Sheet', 'Aging', 'Aged', 'Trial Balance']) {
        const tab = books.getByRole('button', { name: new RegExp(report, 'i') }).first()
        if ((await tab.count()) === 0) continue
        await tab.click()
        await books.waitForTimeout(300)
        await books.screenshot({ path: screenshotPath(`books-report-${report.replace(/\s+/g, '-').toLowerCase()}`) })
      }

      // ── 6) Print preview + PDF export (never the OS print dialog) ───────
      await goto(books, 'Sales Invoices')
      await books.getByRole('button', { name: 'Print invoice INV-2026-001' }).click()
      await expect(books.locator('text=/Tax Invoice|Invoice/i').first()).toBeVisible()
      await books.screenshot({ path: screenshotPath('books-print-preview') })
      // PDF exports land in the module's own export area under the OS temp
      // dir (the shell opens the generated file in a PDF tab).
      const pdfsBefore = listFiles(join(tmpdir(), 'zano-books-exports'), '.pdf')
      await books.getByRole('button', { name: 'Print / PDF' }).click()
      await books.waitForTimeout(2000)
      const pdfsAfter = listFiles(join(tmpdir(), 'zano-books-exports'), '.pdf')
      expect(pdfsAfter.length).toBeGreaterThan(pdfsBefore.length)
      await books.keyboard.press('Escape')

      // ── 7) Banking: import a statement and reconcile INV-2026-002 ───────
      const csv = [
        'Date,Description,Reference,Amount',
        '2026-09-26,EFT Payment Smoke Client INV-2026-002,,2000.00',
      ].join('\n')
      const csvPath = join(userDataDir, 'smoke-statement.csv')
      writeFileSync(csvPath, csv, 'utf8')
      await goto(books, 'Banking & Statements')
      await books.locator('input[type="file"]').setInputFiles(csvPath)
      await expect(books.locator('text=/Imported|imported/i').first()).toBeVisible({ timeout: 20_000 })
      await books.screenshot({ path: screenshotPath('books-bank-import') })
      const reconcile = books.getByRole('button', { name: /Reconcile with 1-Click/i }).first()
      await expect(reconcile).toBeVisible({ timeout: 15_000 })
      await reconcile.click()
      await expect(books.locator('text=/Reconciled|reconciled/i').first()).toBeVisible({ timeout: 20_000 })
      await books.screenshot({ path: screenshotPath('books-reconciled') })

      data = await booksData(userDataDir)
      expect(data.invoices.find((i: { invoiceNumber: string }) => i.invoiceNumber === 'INV-2026-002').status).toBe('Paid')
      const bank = data.accounts.find((a: { id: string }) => a.id === 'acc-bank')
      expect(bank.balance).toBe(14000)
      const suspense = data.accounts.find((a: { id: string }) => a.id === 'acc-suspense')
      expect(Math.round((suspense?.balance ?? 0) * 100) / 100).toBe(0)

      // ── 8) Settings: backup, then restore it ────────────────────────────
      await goto(books, 'Settings')
      await books.getByRole('button', { name: /Backup Now/i }).click()
      await expect(books.locator('text=/Backup|backup/i').first()).toBeVisible({ timeout: 20_000 })
      await books.waitForTimeout(500)
      expect(listFiles(join(userDataDir, 'books', 'backups'), '.json').length).toBeGreaterThan(0)
      await books.screenshot({ path: screenshotPath('books-settings-backup') })
      const restore = books.getByRole('button', { name: /^Restore/i }).first()
      if ((await restore.count()) > 0) {
        await restore.click()
        const confirm = books.getByRole('button', { name: /Restore|Confirm/i }).last()
        await confirm.click()
        await books.waitForTimeout(1000)
        await books.screenshot({ path: screenshotPath('books-restored') })
      }

      // ── 9) Audit trail recorded the journey ─────────────────────────────
      await goto(books, 'Audit Log')
      await expect(books.locator('text=/invoice\.|bank\.|payment\.|backup\./i').first()).toBeVisible()
      await books.screenshot({ path: screenshotPath('books-audit-log') })

      // ── 10) The on-disk ledger stayed coherent through the whole journey ─
      data = await booksData(userDataDir)
      for (const j of data.journalEntries) {
        expect(
          Math.round(j.totalDebit * 100),
          `journal ${j.entryNumber} balanced`,
        ).toBe(Math.round(j.totalCredit * 100))
      }
      expect(data.revision).toBeGreaterThanOrEqual(7)
    } finally {
      await closeAndSaveVideo(launched, 'books-smoke')
    }
  })

  test('a corrupt books file shows the read-error screen and is never overwritten', async () => {
    test.setTimeout(120_000)
    const corruptDir = join(tmpdir(), `zano-books-corrupt-${Date.now()}`)
    mkdirSync(join(corruptDir, 'books'), { recursive: true })
    const corruptBytes = '{"settings":{"companyName":"Broken Co"},"accounts":'
    writeFileSync(join(corruptDir, 'books', 'books-data.json'), corruptBytes, 'utf8')

    const launched = await launchShell({
      onboardingSeen: true,
      userDataDir: corruptDir,
      videoDir: 'books-corrupt',
    })
    try {
      const books = await openBooks(launched)
      await expect(books.locator('text=Zano Books could not read your data')).toBeVisible({
        timeout: 20_000,
      })
      await expect(books.getByRole('button', { name: 'Try again' })).toBeVisible()
      await expect(books.locator('text=Set up Zano Books')).toHaveCount(0)
      await books.screenshot({ path: screenshotPath('books-read-error') })

      const stillCorrupt = readFileSync(join(corruptDir, 'books', 'books-data.json'), 'utf8')
      expect(stillCorrupt).toBe(corruptBytes)
      const siblings = readdirSync(join(corruptDir, 'books'))
      expect(siblings.some((f) => f.startsWith('books-data.json.corrupt-'))).toBe(true)
    } finally {
      await closeAndSaveVideo(launched, 'books-corrupt')
    }
  })
})

function listFiles(dir: string, ext: string, depth = 3): string[] {
  if (!existsSync(dir) || depth < 0) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, ext, depth - 1))
    else if (entry.name.endsWith(ext) && statSync(full).isFile()) out.push(full)
  }
  return out
}
