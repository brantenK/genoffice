import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountsMatchJournals, allJournalsBalanced, round2 } from '../src/shared/accounting'
import {
  importBankStatement,
  executeReconciliationCore,
  readBooksStore,
  writeBooksStore,
} from '../src/main/books-core'
import { useBooksStore } from '../src/renderer/src/store'
import { initialBooksData } from '../src/renderer/src/mock/initialData'

/**
 * Phase-3 workstream 4: payment ↔ bank-reconciliation unification.
 *
 * The payment IS the bank movement. Recording a payment pre-reconciles any
 * matching unreconciled statement line (it can never double-post), and
 * importing a statement line that a recorded payment already covered stores
 * it pre-reconciled WITHOUT posting a second bank/suspense journal.
 */
describe('Payment ↔ bank-reconciliation unification (phase 3, workstream 4)', () => {
  let testDir: string
  let booksDataPath: string

  beforeEach(() => {
    testDir = join(tmpdir(), `books-unification-${randomUUID().slice(0, 8)}`)
    mkdirSync(testDir, { recursive: true })
    booksDataPath = join(testDir, 'books-data.json')
    useBooksStore.setState({
      activeTab: 'dashboard',
      data: JSON.parse(JSON.stringify(initialBooksData)),
      needsSetup: false,
      activeInvoiceId: null,
      invoiceStatusFilter: 'All',
      activeReport: 'profit-loss',
      printInvoice: null,
      searchTerm: '',
    })
  })

  afterEach(() => {
    try {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
    } catch {}
  })

  const storeState = () => useBooksStore.getState().data
  const expectStoreInvariants = () => {
    const d = storeState()
    expect(allJournalsBalanced(d.journalEntries)).toBe(true)
    expect(accountsMatchJournals(d.accounts, d.journalEntries)).toBe(true)
  }

  // The statement line for the 145,000 INV-2026-001 payment.
  const statementCsv = [
    'Date,Description,Reference,Amount',
    '2026-09-10,"EFT City of Ekurhuleni settlement","",145000.00',
  ].join('\n')

  it('Flow A — payment first: Bank moves exactly once, re-import of the line is deduped', async () => {
    // The statement was imported earlier, but its line is still unreconciled.
    useBooksStore.setState({
      data: {
        ...storeState(),
        bankTransactions: [
          {
            id: 'tx-a-1',
            accountId: 'acc-bank',
            date: '2026-09-10',
            description: 'EFT City of Ekurhuleni settlement',
            reference: '',
            amount: 145000,
            reconciled: false,
          },
        ],
      },
    })

    const res = await useBooksStore.getState().recordPayment({
      partyId: 'party-1',
      date: '2026-09-06',
      method: 'Bank Transfer',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 145000 }],
    })
    expect(res.ok).toBe(true)
    expectStoreInvariants()

    const d = storeState()
    const tx = d.bankTransactions!.find((t) => t.id === 'tx-a-1')!
    // The payment IS the bank movement: the statement line is pre-reconciled
    // and can never double-post or be reconciled again.
    expect(tx.reconciled).toBe(true)
    expect(tx.matchedInvoiceId).toBe('inv-1')
    expect(tx.reconciledAt).toBeTruthy()
    expect(d.invoices.find((i) => i.id === 'inv-1')!.status).toBe('Paid')

    const bank = d.accounts.find((a) => a.id === 'acc-bank')!
    // Bank moved exactly ONCE — only the payment journal (Dr Bank / Cr AR);
    // the statement line contributed nothing.
    expect(bank.balance).toBe(round2(485250 + 145000))
    expect(d.accounts.find((a) => a.id === 'acc-suspense')!.balance).toBe(0)

    // Importing a statement containing that same line (same date,
    // description, amount): the pre-reconciled tx is an existing fingerprint,
    // so dedup skips it as a duplicate — no second Bank journal.
    writeBooksStore(booksDataPath, storeState())
    const imp = importBankStatement({ booksDataPath, csvContent: statementCsv })
    expect(imp.ok).toBe(true)
    expect(imp.importedCount).toBe(0)
    expect(imp.skippedDuplicates).toBe(1)

    const onDisk = readBooksStore(booksDataPath)
    expect(allJournalsBalanced(onDisk.journalEntries)).toBe(true)
    expect(accountsMatchJournals(onDisk.accounts, onDisk.journalEntries)).toBe(true)
    expect(onDisk.journalEntries.length).toBe(d.journalEntries.length)
    expect(onDisk.accounts.find((a) => a.id === 'acc-bank')!.balance).toBe(round2(485250 + 145000))
    expect(onDisk.accounts.find((a) => a.id === 'acc-suspense')!.balance).toBe(0)
    expect(onDisk.bankTransactions!.find((t) => t.id === 'tx-a-1')!.reconciled).toBe(true)
  })

  it('Flow B — import first, then payment: payment links the tx, no third booking', async () => {
    // Import the statement first (real books-core path + temp dir): the line
    // is unreconciled and posts Dr Bank / Cr Suspense.
    writeBooksStore(booksDataPath, storeState())
    const imp = importBankStatement({ booksDataPath, csvContent: statementCsv })
    expect(imp.ok).toBe(true)
    expect(imp.importedCount).toBe(1)
    expect(imp.skippedDuplicates).toBe(0)

    const imported = readBooksStore(booksDataPath)
    const tx = imported.bankTransactions![0]
    expect(tx.reconciled).toBe(false)
    expect(imported.accounts.find((a) => a.id === 'acc-bank')!.balance).toBe(
      round2(485250 + 145000),
    )
    expect(imported.accounts.find((a) => a.id === 'acc-suspense')!.balance).toBe(round2(-145000))

    // The renderer loads the imported ledger, then the user records the
    // payment for the same cash.
    useBooksStore.setState({ data: imported })
    const pay = await useBooksStore.getState().recordPayment({
      partyId: 'party-1',
      date: '2026-09-06',
      method: 'Bank Transfer',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 145000 }],
    })
    expect(pay.ok).toBe(true)
    expectStoreInvariants()

    const d = storeState()
    const linkedTx = d.bankTransactions!.find((t) => t.id === tx.id)!
    expect(linkedTx.reconciled).toBe(true)
    expect(linkedTx.matchedInvoiceId).toBe('inv-1')
    expect(linkedTx.reconciledAt).toBeTruthy()
    expect(d.invoices.find((i) => i.id === 'inv-1')!.status).toBe('Paid')
    expect(d.accounts.find((a) => a.id === 'acc-ar')!.balance).toBe(round2(195500 - 145000))

    // C1 fix: the payment's cash leg clears Suspense (Dr Suspense / Cr AR) —
    // the import journal already booked the bank movement, so Bank moves
    // EXACTLY once (baseline + 145000) and Suspense returns to zero.
    const bank = d.accounts.find((a) => a.id === 'acc-bank')!.balance
    expect(bank).toBe(round2(485250 + 145000))
    const suspense = d.accounts.find((a) => a.id === 'acc-suspense')!.balance
    expect(suspense).toBe(0)


    // Re-importing the same statement line is deduped — no third Bank journal.
    writeBooksStore(booksDataPath, storeState())
    const reimp = importBankStatement({ booksDataPath, csvContent: statementCsv })
    expect(reimp.ok).toBe(true)
    expect(reimp.importedCount).toBe(0)
    expect(reimp.skippedDuplicates).toBe(1)
    const after = readBooksStore(booksDataPath)
    expect(after.accounts.find((a) => a.id === 'acc-bank')!.balance).toBe(bank)
    // Suspense stays zero: the payment's C1 leg cleared the import journal's
    // Suspense, and the deduped re-import posts nothing.
    expect(after.accounts.find((a) => a.id === 'acc-suspense')!.balance).toBe(0)

    // Reconciliation of the linked tx is rejected (already reconciled), so no
    // settlement journal can be posted on top either.
    const recon = executeReconciliationCore({
      booksDataPath,
      transactionId: tx.id,
      invoiceId: 'inv-1',
    })
    expect(recon.ok).toBe(false)
  })

  it('C2 — partial payment + import books Bank exactly once per source (remainder journal)', async () => {
    // Record a PARTIAL payment of 50,000 against inv-1 (outstanding 145,000).
    const partialPay = await useBooksStore.getState().recordPayment({
      partyId: 'party-1',
      date: '2026-09-06',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 50000 }],
    })
    expect(partialPay.ok).toBe(true)
    const afterPay = storeState()
    expect(afterPay.accounts.find((a) => a.id === 'acc-bank')!.balance).toBe(round2(485250 + 50000))

    // Import a statement line for the full 145,000: only the uncovered
    // remainder (95,000) posts to Bank — the payment already booked 50,000.
    writeBooksStore(booksDataPath, afterPay)
    const imp = importBankStatement({
      booksDataPath,
      csvContent: [
        'Date,Description,Reference,Amount',
        '2026-09-10,"EFT City of Ekurhuleni settlement INV-2026-001","",145000.00',
      ].join('\n'),
    })
    expect(imp.ok).toBe(true)
    const imported = readBooksStore(booksDataPath)
    const bank = imported.accounts.find((a) => a.id === 'acc-bank')!.balance
    // 50,000 (payment) + 95,000 (remainder) = the statement's 145,000.
    expect(bank).toBe(round2(485250 + 145000))
    expect(allJournalsBalanced(imported.journalEntries)).toBe(true)
    expect(accountsMatchJournals(imported.accounts, imported.journalEntries)).toBe(true)
    // The partially covered line stays unreconciled (the user can settle the
    // remaining outstanding with it).
    expect(imported.bankTransactions![0].reconciled).toBe(false)
  })

  it('I1 — deletePayment un-links the transaction and re-books its bank movement', async () => {
    // Payment-first flow: put an unreconciled statement line in place first,
    // then record the payment — recordPayment links it (reconciled + matched).
    useBooksStore.setState({
      data: {
        ...storeState(),
        bankTransactions: [
          {
            id: 'tx-pre-recon',
            accountId: 'acc-bank',
            date: '2026-09-10',
            description: 'EFT City of Ekurhuleni settlement',
            amount: 145000,
            reconciled: false,
          },
        ],
      },
    })
    const pay = await useBooksStore.getState().recordPayment({
      partyId: 'party-1',
      date: '2026-09-06',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 145000 }],
    })
    expect(pay.ok).toBe(true)
    const paymentId = storeState().payments[0].id
    expect(storeState().bankTransactions!.find((t) => t.id === 'tx-pre-recon')!.reconciled).toBe(true)

    // Deleting the payment must un-link the tx AND post its import journal so
    // the cash stays in the Bank ledger (the tx had no import journal of its
    // own — the payment WAS the bank movement).
    await useBooksStore.getState().deletePayment(paymentId)
    expectStoreInvariants()
    const d = storeState()
    const tx = d.bankTransactions!.find((t) => t.id === 'tx-pre-recon')
    expect(tx).toBeDefined()
    expect(tx!.reconciled).toBe(false)
    expect(tx!.matchedInvoiceId).toBeUndefined()
    expect(
      d.journalEntries.some(
        (je) => je.remarks && je.remarks.includes('Bank statement import: tx-pre-recon'),
      ),
    ).toBe(true)
    expect(d.accounts.find((a) => a.id === 'acc-bank')!.balance).toBe(round2(485250 + 145000))
    expect(d.invoices.find((i) => i.id === 'inv-1')!.outstandingAmount).toBe(145000)
  })

  it('I2 — direction-blind matches are rejected: a supplier payment never covers a deposit', async () => {
    const { paymentMatchesTransaction } = await import('../src/shared/payments')
    const paidPayment = {
      id: 'pay-x',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      date: '2026-09-06',
      type: 'paid' as const,
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 100 }],
      total: 100,
      createdAt: '',
    }
    expect(paymentMatchesTransaction(paidPayment, {
      id: 'tx-dep',
      accountId: 'acc-bank',
      date: '2026-09-10',
      description: 'EFT City of Ekurhuleni',
      amount: 100,
      reconciled: false,
    })).toBe(false)
    const receivedPayment = { ...paidPayment, type: 'received' as const, partyId: 'party-supp-1', partyName: 'Apex Valve Supplies (Pty) Ltd' }
    expect(paymentMatchesTransaction(receivedPayment, {
      id: 'tx-wd',
      accountId: 'acc-bank',
      date: '2026-09-10',
      description: 'Apex Valve Supplies withdrawal',
      amount: -100,
      reconciled: false,
    })).toBe(false)
  })
})