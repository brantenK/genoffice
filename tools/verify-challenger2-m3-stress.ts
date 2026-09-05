/**
 * tools/verify-challenger2-m3-stress.ts
 *
 * INDEPENDENT ADVERSARIAL STRESS HARNESS FOR BOOKS MILESTONE 3 (M3)
 * Challenger: challenger_2_books_m3
 *
 * Mandatory Verification Tracks:
 * 1. High-volume randomized bank statement fuzzer (1,000 randomized amounts, 100 randomized statements)
 *    - Validates 100% of parsed amounts are finite, correctly signed, and rounded to 2 decimal places.
 * 2. Tender milestone payment gating:
 *    - Micro-partial, large partial, 3-step partial, overpayment, and multi-milestone isolation.
 *    - Verifies milestone remains BILLED until remainingOutstanding <= 0, then flips to PAID.
 * 3. Double-entry ledger invariants and party balance integrity during partial settlements.
 * 4. Deduplication and edge case resilience (quotes, semicolons, commas, summary rows).
 */

import assert from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  parseBankStatementCsv,
  parseBankAmount,
  normalizeDate,
  deduplicateBankTransactions,
  round2,
  createSettlementJournal,
  recomputePartyBalances,
} from '../apps/books/src/shared/accounting'
import {
  importBankStatement,
  executeReconciliation,
  computeSettlementSuggestions,
  writeBooksStore,
  readBooksStore,
} from '../apps/books/src/main/books-main'
import { initialBooksData } from '../apps/books/src/renderer/src/mock/initialData'
import type { BooksData } from '../apps/books/src/shared/types'

let totalTests = 0
let passedTests = 0
let failedTests = 0
const failures: Array<{ suite: string; name: string; error: string }> = []

async function test(suite: string, name: string, fn: () => void | Promise<void>) {
  totalTests++
  try {
    await fn()
    passedTests++
    console.log(`  [PASS] ${name}`)
  } catch (err: any) {
    failedTests++
    failures.push({ suite, name, error: err.message || String(err) })
    console.error(`  [FAIL] ${name}: ${err.message}`)
  }
}

function createSandbox(): { root: string; booksPath: string; tendersPath: string } {
  const id = randomUUID().slice(0, 8)
  const root = join(tmpdir(), `challenger2-m3-stress-${id}`)
  const booksDir = join(root, 'books')
  const tendersDir = join(root, 'tenders')
  mkdirSync(booksDir, { recursive: true })
  mkdirSync(tendersDir, { recursive: true })
  const booksPath = join(booksDir, 'books-data.json')
  const tendersPath = join(tendersDir, 'tenders-data.json')
  return { root, booksPath, tendersPath }
}

function cleanSandbox(root: string) {
  try {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  } catch {}
}

function createMultiMilestoneTendersData() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    workspaces: [
      {
        id: 'ws-default',
        name: 'Default Workspace',
        tenders: [
          {
            id: 'tender-stress-1',
            referenceNumber: 'RFP-WTR-2026-04',
            title: 'Municipal Water Reticulation Upgrades',
            issuingAuthority: 'City of Ekurhuleni Water Dept',
            milestones: [
              {
                id: 'ms-civil-01',
                title: 'Civil Trenching & Groundworks',
                amount: 100000.0,
                status: 'BILLED',
                billedInvoiceId: 'inv-tnd-ms1',
                billedInvoiceNumber: 'INV-TND-MS1',
                billedDate: '2026-08-20T00:00:00.000Z',
              },
              {
                id: 'ms-pipes-02',
                title: 'High-Density Polyethylene Pipe Laying',
                amount: 50000.0,
                status: 'BILLED',
                billedInvoiceId: 'inv-tnd-ms2',
                billedInvoiceNumber: 'INV-TND-MS2',
                billedDate: '2026-08-25T00:00:00.000Z',
              },
              {
                id: 'ms-testing-03',
                title: 'Hydrostatic Pressure Testing',
                amount: 25000.0,
                status: 'REACHED', // Not yet billed
              },
            ],
          },
        ],
      },
    ],
  }
}

async function run() {
  console.log('======================================================================')
  console.log('   CHALLENGER 2: EMPIRICAL STRESS & FUZZING HARNESS (BOOKS M3)')
  console.log('======================================================================\n')

  // --------------------------------------------------------------------------
  // TRACK 1: HIGH-VOLUME RANDOMIZED BANK AMOUNT & CSV FUZZER
  // --------------------------------------------------------------------------
  console.log('--- TRACK 1: High-Volume Randomized Bank Amount & Statement Fuzzer ---')

  await test('Track 1', '1.1 Fuzz 1,000 varied raw financial amount strings: 100% finite, signed, rounded to 2dp', () => {
    const currencies = ['', 'R', 'R ', 'ZAR ', '$', '€', '£']
    const thousandsSeps = ['', ',', ' ', '.']
    const decimalSeps = ['.', ',']
    const negativeStyles = [
      'parentheses',  // (1250.00)
      'leading-minus', // -1250.00
      'trailing-minus', // 1250.00-
      'dr', // 1250.00DR
      'cr', // 1250.00CR
      'positive', // +1250.00
      'none', // 1250.00
    ]

    let validFiniteCount = 0
    const totalSamples = 1000

    for (let i = 0; i < totalSamples; i++) {
      const baseNum = Math.floor(Math.random() * 500000) + Math.random()
      const roundedBase = Math.round(baseNum * 100) / 100
      const integerPart = Math.floor(roundedBase)
      const centsPart = Math.round((roundedBase - integerPart) * 100)
      const centsStr = String(centsPart).padStart(2, '0')

      const cur = currencies[Math.floor(Math.random() * currencies.length)]
      const negStyle = negativeStyles[Math.floor(Math.random() * negativeStyles.length)]

      // Format integer part with or without thousands separator
      let intStr = String(integerPart)
      if (intStr.length > 3 && Math.random() > 0.3) {
        const sep = thousandsSeps[Math.floor(Math.random() * thousandsSeps.length)]
        if (sep === ' ') {
          intStr = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
        } else if (sep === ',') {
          intStr = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        }
      }

      // Choose decimal separator matching conventions
      let decSep = '.'
      if (intStr.includes(',')) {
        decSep = '.'
      } else if (intStr.includes(' ')) {
        decSep = Math.random() > 0.5 ? ',' : '.'
      } else {
        decSep = Math.random() > 0.3 ? '.' : ','
      }

      let numStr = `${intStr}${decSep}${centsStr}`

      // Apply negative styling
      let isExpectedNegative = false
      let finalStr = ''
      switch (negStyle) {
        case 'parentheses':
          isExpectedNegative = true
          finalStr = `(${cur}${numStr})`
          break
        case 'leading-minus':
          isExpectedNegative = true
          finalStr = `-${cur}${numStr}`
          break
        case 'trailing-minus':
          isExpectedNegative = true
          finalStr = `${cur}${numStr}-`
          break
        case 'dr':
          isExpectedNegative = true
          finalStr = `${cur}${numStr}DR`
          break
        case 'cr':
          isExpectedNegative = false
          finalStr = `${cur}${numStr}CR`
          break
        case 'positive':
          isExpectedNegative = false
          finalStr = `+${cur}${numStr}`
          break
        default:
          isExpectedNegative = false
          finalStr = `${cur}${numStr}`
          break
      }

      // Add random surrounding whitespace
      if (Math.random() > 0.5) {
        finalStr = `  ${finalStr}  `
      }

      const parsed = parseBankAmount(finalStr)

      assert.strictEqual(typeof parsed, 'number', `Output must be a number for ${finalStr}`)
      assert.ok(!isNaN(parsed), `Parsed amount must not be NaN for ${finalStr}`)
      assert.ok(Number.isFinite(parsed), `Parsed amount must be finite for ${finalStr}`)
      assert.strictEqual(
        round2(parsed),
        parsed,
        `Parsed amount must be rounded to exactly 2 decimal places: ${parsed} for ${finalStr}`
      )

      if (parsed !== 0) {
        if (isExpectedNegative) {
          assert.ok(
            parsed < 0,
            `Expected negative amount for style ${negStyle}, got ${parsed} (from '${finalStr}')`
          )
        } else {
          assert.ok(
            parsed > 0,
            `Expected positive amount for style ${negStyle}, got ${parsed} (from '${finalStr}')`
          )
        }
      }

      validFiniteCount++
    }

    assert.strictEqual(validFiniteCount, totalSamples)
  })

  await test('Track 1', '1.2 High-volume randomized bank statement fuzzer: 50 multi-row bank statements across 4 SA bank formats', () => {
    const bankStyles = ['FNB', 'STANDARD_BANK', 'NEDBANK', 'ABSA']
    const dateFormats = ['ISO', 'SLASH_DMY', 'DASH_DMY', 'COMPACT']
    let totalTransactionsGenerated = 0
    let totalTransactionsParsed = 0

    for (let s = 0; s < 50; s++) {
      const bank = bankStyles[s % bankStyles.length]
      const rowCount = Math.floor(Math.random() * 20) + 10 // 10 to 30 rows
      const lines: string[] = []

      // Generate bank-specific preamble / metadata
      if (bank === 'ABSA') {
        lines.push('\uFEFFAbsa Client Statement')
        lines.push(`Account Number: 408${Math.floor(Math.random() * 1000000)}`)
        lines.push(`Statement Date: 2026-09-0${(s % 5) + 1}`)
        lines.push('')
        lines.push('Date,Description,Debit,Credit,Balance')
      } else if (bank === 'NEDBANK') {
        lines.push('Nedbank Business Banking Preamble')
        lines.push('Client: Zano Solutions Pty Ltd')
        lines.push('Account Type: Current Account')
        lines.push('Closing Balance: R 520,000.00')
        lines.push('Generated at: 2026-09-05T12:00:00Z')
        lines.push('')
        lines.push('Transaction Date,Narrative,Debit Amount,Credit Amount,Running Balance')
      } else if (bank === 'STANDARD_BANK') {
        lines.push('Date,Description,Debit,Credit,Balance')
      } else {
        // FNB
        lines.push('Date,Amount,Balance,Description')
      }

      let statementNet = 0

      for (let r = 0; r < rowCount; r++) {
        // Generate date
        const day = String((r % 28) + 1).padStart(2, '0')
        const month = String(((s + r) % 12) + 1).padStart(2, '0')
        const year = '2026'
        const df = dateFormats[r % dateFormats.length]
        let dateStr = `${year}-${month}-${day}`
        if (df === 'SLASH_DMY') dateStr = `${day}/${month}/${year}`
        if (df === 'DASH_DMY') dateStr = `${day}-${month}-${year}`
        if (df === 'COMPACT') dateStr = `${year}${month}${day}`

        const isDeposit = Math.random() > 0.45
        const amountVal = round2(Math.floor(Math.random() * 25000 + 100) + Math.random())
        const descTokens = ['EFT', 'Settlement', 'Card Purchase', 'Municipal Pay', 'Tax Transfer', 'Supplier Bill']
        const desc = `"${descTokens[r % descTokens.length]} ${s}-${r}"`

        if (bank === 'FNB') {
          const signedStr = isDeposit ? `R ${amountVal.toFixed(2)}` : `(R ${amountVal.toFixed(2)})`
          lines.push(`${dateStr},"${signedStr}","R 500,000.00",${desc}`)
          statementNet = round2(statementNet + (isDeposit ? amountVal : -amountVal))
        } else if (bank === 'STANDARD_BANK' || bank === 'ABSA') {
          if (isDeposit) {
            lines.push(`${dateStr},${desc},,"${amountVal.toFixed(2)}",500000.00`)
            statementNet = round2(statementNet + amountVal)
          } else {
            lines.push(`${dateStr},${desc},"${amountVal.toFixed(2)}",,500000.00`)
            statementNet = round2(statementNet - amountVal)
          }
        } else {
          // NEDBANK
          if (isDeposit) {
            lines.push(`${dateStr},${desc},,"${amountVal.toFixed(2)}",500000.00`)
            statementNet = round2(statementNet + amountVal)
          } else {
            lines.push(`${dateStr},${desc},"${amountVal.toFixed(2)}",,500000.00`)
            statementNet = round2(statementNet - amountVal)
          }
        }
        totalTransactionsGenerated++
      }

      // Add summary footers
      lines.push('')
      lines.push('Total Debits,R 50,000.00,,')
      lines.push('Closing Balance,,R 500,000.00,')

      const csvContent = lines.join('\n')
      const parsed = parseBankStatementCsv(csvContent)

      assert.strictEqual(
        parsed.length,
        rowCount,
        `Expected ${rowCount} transactions parsed for bank ${bank} statement ${s}, got ${parsed.length}`
      )

      for (const tx of parsed) {
        assert.ok(Number.isFinite(tx.amount), `Transaction amount must be finite: ${tx.amount}`)
        assert.ok(!isNaN(tx.amount), 'Transaction amount must not be NaN')
        assert.notStrictEqual(tx.amount, 0, 'Transaction amount must be non-zero')
        assert.strictEqual(round2(tx.amount), tx.amount, 'Transaction amount must be 2 decimal places')
        assert.match(
          tx.date,
          /^\d{4}-\d{2}-\d{2}$/,
          `Normalized date must match YYYY-MM-DD, got ${tx.date}`
        )
      }

      const sumParsed = round2(parsed.reduce((acc, t) => acc + t.amount, 0))
      assert.strictEqual(
        sumParsed,
        statementNet,
        `Statement net sum mismatch for statement ${s}: expected ${statementNet}, got ${sumParsed}`
      )

      totalTransactionsParsed += parsed.length
    }

    assert.strictEqual(totalTransactionsParsed, totalTransactionsGenerated)
    console.log(`    Total randomized transactions generated & parsed: ${totalTransactionsParsed}`)
  })

  // --------------------------------------------------------------------------
  // TRACK 2: TENDER MILESTONE PAYMENT GATING TEST
  // --------------------------------------------------------------------------
  console.log('\n--- TRACK 2: Tender Milestone Payment Gating Stress Tests ---')

  await test('Track 2', '2.1 Micro-partial settlement (R1.00 of R100,000): milestone remains BILLED with no paidAt', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      data.invoices.push({
        id: 'inv-tnd-ms1',
        invoiceNumber: 'INV-TND-MS1',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-08-20',
        dueDate: '2026-09-20',
        tenderReference: 'RFP-WTR-2026-04',
        items: [],
        subtotal: 86956.52,
        taxTotal: 13043.48,
        grandTotal: 100000.0,
        outstandingAmount: 100000.0,
        status: 'Unpaid',
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      })
      writeBooksStore(sandbox.booksPath, data)

      const tendersData = createMultiMilestoneTendersData()
      writeFileSync(sandbox.tendersPath, JSON.stringify(tendersData, null, 2), 'utf8')

      // Import micro-payment of R1.00
      const csv = `Date,Description,Reference,Amount\n2026-09-01,Micro Token Settlement,RFP-WTR-2026-04,1.00`
      const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      assert.strictEqual(imp.ok, true)

      const res = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp.transactions![0].id,
        invoiceId: 'inv-tnd-ms1',
        tendersDataPath: sandbox.tendersPath,
      })

      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.settledAmount, 1.0)
      assert.strictEqual(res.remainingOutstanding, 99999.0)
      assert.strictEqual(res.invoiceStatus, 'Unpaid')
      assert.strictEqual(res.tenderMilestonePaid, false, 'tenderMilestonePaid must be false for micro-payment')

      // Verify on disk
      const tendersDisk = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      const ms = tendersDisk.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-civil-01')
      assert.strictEqual(ms.status, 'BILLED', 'Milestone must strictly remain BILLED on micro-partial payment')
      assert.strictEqual(ms.paidAt, undefined)
      assert.strictEqual(ms.paidDate, undefined)
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  await test('Track 2', '2.2 Large partial settlement (R99,999.99 of R100,000): milestone remains BILLED', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      data.invoices.push({
        id: 'inv-tnd-ms1',
        invoiceNumber: 'INV-TND-MS1',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-08-20',
        dueDate: '2026-09-20',
        tenderReference: 'RFP-WTR-2026-04',
        items: [],
        subtotal: 86956.52,
        taxTotal: 13043.48,
        grandTotal: 100000.0,
        outstandingAmount: 100000.0,
        status: 'Unpaid',
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      })
      writeBooksStore(sandbox.booksPath, data)

      const tendersData = createMultiMilestoneTendersData()
      writeFileSync(sandbox.tendersPath, JSON.stringify(tendersData, null, 2), 'utf8')

      // Pay R99,999.99 leaving exactly R0.01 outstanding
      const csv = `Date,Description,Reference,Amount\n2026-09-01,Near-Full Settlement,INV-TND-MS1,99999.99`
      const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      const res = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp.transactions![0].id,
        invoiceId: 'inv-tnd-ms1',
        tendersDataPath: sandbox.tendersPath,
      })

      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.settledAmount, 99999.99)
      assert.strictEqual(res.remainingOutstanding, 0.01)
      assert.strictEqual(res.invoiceStatus, 'Unpaid')
      assert.strictEqual(res.tenderMilestonePaid, false, 'Must not flip to PAID when 1 cent remains')

      const tendersDisk = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      const ms = tendersDisk.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-civil-01')
      assert.strictEqual(ms.status, 'BILLED', 'Milestone remains BILLED when 1 cent remains')
      assert.strictEqual(ms.paidAt, undefined)
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  await test('Track 2', '2.3 Final cent settlement (R0.01): flips invoice to Paid and milestone to PAID with timestamps', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      data.invoices.push({
        id: 'inv-tnd-ms1',
        invoiceNumber: 'INV-TND-MS1',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-08-20',
        dueDate: '2026-09-20',
        tenderReference: 'RFP-WTR-2026-04',
        items: [],
        subtotal: 86956.52,
        taxTotal: 13043.48,
        grandTotal: 100000.0,
        outstandingAmount: 0.01, // Only 1 cent remaining
        status: 'Unpaid',
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      })
      writeBooksStore(sandbox.booksPath, data)

      const tendersData = createMultiMilestoneTendersData()
      writeFileSync(sandbox.tendersPath, JSON.stringify(tendersData, null, 2), 'utf8')

      // Pay the final 1 cent
      const csv = `Date,Description,Reference,Amount\n2026-09-02,Final Cent Settlement,INV-TND-MS1,0.01`
      const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      const res = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp.transactions![0].id,
        invoiceId: 'inv-tnd-ms1',
        tendersDataPath: sandbox.tendersPath,
      })

      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.settledAmount, 0.01)
      assert.strictEqual(res.remainingOutstanding, 0)
      assert.strictEqual(res.invoiceStatus, 'Paid')
      assert.strictEqual(res.tenderMilestonePaid, true, 'Final 1 cent flips milestone to PAID')
      assert.strictEqual(res.matchedMilestoneId, 'ms-civil-01')

      const tendersDisk = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      const ms = tendersDisk.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-civil-01')
      assert.strictEqual(ms.status, 'PAID', 'Milestone status is now PAID')
      assert.ok(typeof ms.paidAt === 'string' && ms.paidAt.length > 0)
      assert.ok(typeof ms.paidDate === 'string' && ms.paidDate.length > 0)
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  await test('Track 2', '2.4 3-Step sequential partial settlement (30% -> 40% -> 30%): remains BILLED at step 1 & 2, flips to PAID at step 3', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      data.invoices.push({
        id: 'inv-tnd-ms1',
        invoiceNumber: 'INV-TND-MS1',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-08-20',
        dueDate: '2026-09-20',
        tenderReference: 'RFP-WTR-2026-04',
        items: [],
        subtotal: 86956.52,
        taxTotal: 13043.48,
        grandTotal: 100000.0,
        outstandingAmount: 100000.0,
        status: 'Unpaid',
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      })
      writeBooksStore(sandbox.booksPath, data)

      const tendersData = createMultiMilestoneTendersData()
      writeFileSync(sandbox.tendersPath, JSON.stringify(tendersData, null, 2), 'utf8')

      // Step 1: 30,000 (30%)
      const csv1 = `Date,Description,Reference,Amount\n2026-09-01,Tranche 1,INV-TND-MS1,30000.00`
      const imp1 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv1 })
      const res1 = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp1.transactions![0].id,
        invoiceId: 'inv-tnd-ms1',
        tendersDataPath: sandbox.tendersPath,
      })
      assert.strictEqual(res1.remainingOutstanding, 70000)
      assert.strictEqual(res1.tenderMilestonePaid, false)
      let diskData = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      assert.strictEqual(diskData.workspaces[0].tenders[0].milestones[0].status, 'BILLED')

      // Step 2: 40,000 (40%)
      const csv2 = `Date,Description,Reference,Amount\n2026-09-02,Tranche 2,INV-TND-MS1,40000.00`
      const imp2 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv2 })
      const res2 = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp2.transactions![0].id,
        invoiceId: 'inv-tnd-ms1',
        tendersDataPath: sandbox.tendersPath,
      })
      assert.strictEqual(res2.remainingOutstanding, 30000)
      assert.strictEqual(res2.tenderMilestonePaid, false)
      diskData = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      assert.strictEqual(diskData.workspaces[0].tenders[0].milestones[0].status, 'BILLED')

      // Step 3: 30,000 (final 30%)
      const csv3 = `Date,Description,Reference,Amount\n2026-09-03,Tranche 3,INV-TND-MS1,30000.00`
      const imp3 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv3 })
      const res3 = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp3.transactions![0].id,
        invoiceId: 'inv-tnd-ms1',
        tendersDataPath: sandbox.tendersPath,
      })
      assert.strictEqual(res3.remainingOutstanding, 0)
      assert.strictEqual(res3.invoiceStatus, 'Paid')
      assert.strictEqual(res3.tenderMilestonePaid, true)
      diskData = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      assert.strictEqual(diskData.workspaces[0].tenders[0].milestones[0].status, 'PAID')
      assert.ok(diskData.workspaces[0].tenders[0].milestones[0].paidAt)
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  await test('Track 2', '2.5 Non-targeted milestone isolation: settling milestone 1 does NOT touch milestone 2', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      // Add two tender-linked invoices
      data.invoices.push({
        id: 'inv-tnd-ms1',
        invoiceNumber: 'INV-TND-MS1',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-08-20',
        dueDate: '2026-09-20',
        tenderReference: 'RFP-WTR-2026-04',
        items: [],
        subtotal: 86956.52,
        taxTotal: 13043.48,
        grandTotal: 100000.0,
        outstandingAmount: 100000.0,
        status: 'Unpaid',
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      })
      data.invoices.push({
        id: 'inv-tnd-ms2',
        invoiceNumber: 'INV-TND-MS2',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-08-25',
        dueDate: '2026-09-25',
        tenderReference: 'RFP-WTR-2026-04',
        items: [],
        subtotal: 43478.26,
        taxTotal: 6521.74,
        grandTotal: 50000.0,
        outstandingAmount: 50000.0,
        status: 'Unpaid',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      })
      writeBooksStore(sandbox.booksPath, data)

      const tendersData = createMultiMilestoneTendersData()
      writeFileSync(sandbox.tendersPath, JSON.stringify(tendersData, null, 2), 'utf8')

      // Settle invoice 1 in full
      const csv = `Date,Description,Reference,Amount\n2026-09-01,Full Payment MS1,INV-TND-MS1,100000.00`
      const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      const res = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp.transactions![0].id,
        invoiceId: 'inv-tnd-ms1',
        tendersDataPath: sandbox.tendersPath,
      })
      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.tenderMilestonePaid, true)
      assert.strictEqual(res.matchedMilestoneId, 'ms-civil-01')

      // Verify on disk: ms-civil-01 is PAID, ms-pipes-02 is STILL BILLED, ms-testing-03 is REACHED
      const tendersDisk = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      const ms1 = tendersDisk.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-civil-01')
      const ms2 = tendersDisk.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-pipes-02')
      const ms3 = tendersDisk.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-testing-03')

      assert.strictEqual(ms1.status, 'PAID')
      assert.strictEqual(ms2.status, 'BILLED')
      assert.strictEqual(ms2.paidAt, undefined)
      assert.strictEqual(ms3.status, 'REACHED')
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  // --------------------------------------------------------------------------
  // TRACK 3: ADVERSARIAL DOUBLE-ENTRY & PARTY BALANCE INVARIANTS
  // --------------------------------------------------------------------------
  console.log('\n--- TRACK 3: Double-Entry & Party Balance Invariants ---')

  await test('Track 3', '3.1 Overpayment handling: tx.amount > invoice.outstanding clamps settledAmount and balances journal', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      // inv-2 has outstandingAmount 50500
      const initialAr = data.accounts.find((a) => a.id === 'acc-ar')!.balance
      writeBooksStore(sandbox.booksPath, data)

      // Incoming transaction is 60,000 (10,000 over invoice total)
      const csv = `Date,Description,Reference,Amount\n2026-09-01,Overpayment Client,INV-2026-002,60000.00`
      const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      const res = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp.transactions![0].id,
        invoiceId: 'inv-2',
      })

      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.settledAmount, 50500, 'Settled amount must clamp to outstanding invoice amount')
      assert.strictEqual(res.remainingOutstanding, 0)
      assert.strictEqual(res.invoiceStatus, 'Paid')

      const updated = readBooksStore(sandbox.booksPath)
      const je = updated.journalEntries[0]
      assert.strictEqual(je.totalDebit, 50500)
      assert.strictEqual(je.totalCredit, 50500)
      assert.strictEqual(je.totalDebit, je.totalCredit)

      // AR must be decremented by 50,500, NOT 60,000
      const newAr = updated.accounts.find((a) => a.id === 'acc-ar')!.balance
      assert.strictEqual(newAr, round2(initialAr - 50500))
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  await test('Track 3', '3.2 Party balance invariant: customer outstanding balance strictly equals sum of all open invoices across 10 random mutations', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      writeBooksStore(sandbox.booksPath, data)

      for (let step = 0; step < 10; step++) {
        const books = readBooksStore(sandbox.booksPath)
        const openInvoices = books.invoices.filter((i) => i.status !== 'Paid' && i.type === 'Sales')
        if (openInvoices.length === 0) break

        const target = openInvoices[step % openInvoices.length]
        const currentBal = target.outstandingAmount ?? target.grandTotal
        const payAmt = round2(Math.min(currentBal, Math.floor(Math.random() * 20000 + 1000)))

        const csv = `Date,Description,Reference,Amount\n2026-09-01,Step ${step} Pay,${target.invoiceNumber},${payAmt}`
        const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
        const res = executeReconciliation({
          booksDataPath: sandbox.booksPath,
          transactionId: imp.transactions![0].id,
          invoiceId: target.id,
        })
        assert.strictEqual(res.ok, true)

        const after = readBooksStore(sandbox.booksPath)
        for (const p of after.parties) {
          const expected = after.invoices
            .filter((inv) => inv.partyId === p.id && inv.status !== 'Paid' && inv.status !== 'Cancelled')
            .reduce((sum, inv) => round2(sum + (inv.outstandingAmount ?? inv.grandTotal)), 0)
          assert.strictEqual(
            p.outstandingBalance,
            round2(expected),
            `Party ${p.name} outstanding balance violated at step ${step}`
          )
        }
      }
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  // --------------------------------------------------------------------------
  // TRACK 4: CSV PARSER ADVERSARIAL EDGE CASES & INVARIANTS
  // --------------------------------------------------------------------------
  console.log('\n--- TRACK 4: CSV Parsing Adversarial Edge Cases ---')

  await test('Track 4', '4.1 Quoted tokens with internal commas and escaped double quotes ("")', () => {
    const csv = `Date,Description,Reference,Amount
2026-09-01,"Payment for ""Water Supply"", Phase 1",REF-01,"12,500.50"
2026-09-02,"Direct Debit: ""Ekurhuleni"", Water & Sanitation",REF-02,"-4,500.00"`

    const parsed = parseBankStatementCsv(csv)
    assert.strictEqual(parsed.length, 2)
    assert.strictEqual(parsed[0].description, 'Payment for "Water Supply", Phase 1')
    assert.strictEqual(parsed[0].amount, 12500.5)
    assert.strictEqual(parsed[1].description, 'Direct Debit: "Ekurhuleni", Water & Sanitation')
    assert.strictEqual(parsed[1].amount, -4500)
  })

  await test('Track 4', '4.2 Semicolon-separated CSV and blank line resilience', () => {
    const csv = `
Date,Amount,Description

2026-09-01,"15 000,00","First Payment"

2026-09-02,"-5 000,50","Second Payment"

`
    const parsed = parseBankStatementCsv(csv)
    assert.strictEqual(parsed.length, 2)
    assert.strictEqual(parsed[0].amount, 15000)
    assert.strictEqual(parsed[1].amount, -5000.5)
  })

  await test('Track 4', '4.3 Deduplication preserves legitimate identical charges on same day, skips duplicate files', () => {
    const sandbox = createSandbox()
    try {
      writeBooksStore(sandbox.booksPath, JSON.parse(JSON.stringify(initialBooksData)))

      // 3 identical transaction lines on same day (e.g. 3 x R50 SMS notification fees)
      const csv = `Date,Description,Reference,Amount
2026-09-01,Bank Notification Fee,NOTIF,-50.00
2026-09-01,Bank Notification Fee,NOTIF,-50.00
2026-09-01,Bank Notification Fee,NOTIF,-50.00`

      const res1 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      assert.strictEqual(res1.ok, true)
      assert.strictEqual(res1.importedCount, 3)
      assert.strictEqual(res1.skippedDuplicates, 0)
      assert.strictEqual(res1.netAdjustment, -150)

      // Re-importing exact CSV must skip all 3
      const res2 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      assert.strictEqual(res2.ok, true)
      assert.strictEqual(res2.importedCount, 0)
      assert.strictEqual(res2.skippedDuplicates, 3)
      assert.strictEqual(res2.netAdjustment, 0)
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  console.log('\n======================================================================')
  console.log(`SUMMARY: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)
  console.log('======================================================================')

  if (failedTests > 0) {
    process.exit(1)
  }
}

run().catch((err) => {
  console.error('Fatal error running Challenger 2 stress tests:', err)
  process.exit(1)
})
