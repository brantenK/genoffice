import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountsMatchJournals, allJournalsBalanced, round2 } from '../src/shared/accounting'
import {
  dropInvoiceFromPayments,
  applyPayment,
  createPaymentJournal,
  linkPaymentToBankTransaction,
} from '../src/shared/payments'
import { validateCreditNote } from '../src/shared/credit-notes'
import { taxRegister } from '../src/shared/reports'
import { issueSalesInvoiceInBooks, readBooksStore } from '../src/main/books-core'
import { useBooksStore } from '../src/renderer/src/store'
import { initialBooksData } from '../src/renderer/src/mock/initialData'
import type { Invoice, Payment } from '../src/shared/types'

/**
 * Regression tests for the phase-2 deep-review findings (C1, I1, I2, I3, M2).
 */
describe('Phase-2 review fixes', () => {
  let testDir: string
  let booksDataPath: string

  beforeEach(() => {
    testDir = join(tmpdir(), `books-review-fixes-${randomUUID().slice(0, 8)}`)
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

  const createSalesInvoice = async (id: string, rate: number, status: 'Unpaid' | 'Paid') =>
    useBooksStore.getState().saveInvoice({
      id,
      type: 'Sales',
      partyName: 'Review Co',
      status,
      items: [{ id: 'it-1', description: 'Works', qty: 1, rate, taxRate: 15, amount: rate }],
    })

  describe('C1: payment records die with their reversed journals', () => {
    it('pay -> edit (Paid, larger) -> deletePayment never inflates Bank', async () => {
      await createSalesInvoice('inv-c1', 10000, 'Unpaid')
      const inv = storeState().invoices.find((i) => i.id === 'inv-c1')!
      const pay = await useBooksStore.getState().recordPayment({
        partyId: inv.partyId,
        allocations: [
          { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, amount: inv.grandTotal },
        ],
      })
      expect(pay.ok).toBe(true)
      expect(storeState().payments).toHaveLength(1)
      const paymentId = storeState().payments[0].id
      const bankAfterPay = storeState().accounts.find((a) => a.id === 'acc-bank')!.balance

      // Edit the paid invoice to a larger amount, keeping status Paid.
      await createSalesInvoice('inv-c1', 20000, 'Paid')
      const d = storeState()
      const invAfter = d.invoices.find((i) => i.id === 'inv-c1')!
      // I5: a paid invoice raised is no longer fully paid.
      expect(invAfter.status).toBe('Unpaid')
      expect(invAfter.outstandingAmount).toBe(round2(11500))
      // The payment record referencing the old posting is gone.
      expect(d.payments).toHaveLength(0)
      expectStoreInvariants()

      // deletePayment on the (already dropped) payment is a safe no-op.
      await useBooksStore.getState().deletePayment(paymentId)
      expectStoreInvariants()
      const final = storeState()
      const bank = final.accounts.find((a) => a.id === 'acc-bank')!.balance
      const ar = final.accounts.find((a) => a.id === 'acc-ar')!.balance
      // Bank only ever received the original 11,500; AR = opening + 11,500.
      expect(bank).toBe(bankAfterPay)
      expect(ar).toBe(round2(195500 + 11500))
      const invEnd = final.invoices.find((i) => i.id === 'inv-c1')!
      expect(invEnd.outstandingAmount).toBe(round2(11500))
      // Ledger agrees with the invoice: AR delta == outstanding.
      expect(round2(ar - 195500)).toBe(invEnd.outstandingAmount)
    })

    it('pay -> deleteInvoice drops the payment record and restores baseline', async () => {
      await createSalesInvoice('inv-c1-del', 10000, 'Unpaid')
      const inv = storeState().invoices.find((i) => i.id === 'inv-c1-del')!
      const pay = await useBooksStore.getState().recordPayment({
        partyId: inv.partyId,
        allocations: [
          { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, amount: inv.grandTotal },
        ],
      })
      expect(pay.ok).toBe(true)
      expect(storeState().payments).toHaveLength(1)

      await useBooksStore.getState().deleteInvoice('inv-c1-del')
      expectStoreInvariants()
      const d = storeState()
      // The payment record referencing the deleted invoice is gone.
      expect(d.payments).toHaveLength(0)
      expect(d.accounts.find((a) => a.id === 'acc-ar')!.balance).toBe(195500)
      expect(d.accounts.find((a) => a.id === 'acc-bank')!.balance).toBe(485250)
    })

    it('partial pay -> edit keeps the paid portion and drops the payment record', async () => {
      await createSalesInvoice('inv-c1-part', 10000, 'Unpaid')
      const inv = storeState().invoices.find((i) => i.id === 'inv-c1-part')!
      const pay = await useBooksStore.getState().recordPayment({
        partyId: inv.partyId,
        allocations: [{ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, amount: 5000 }],
      })
      expect(pay.ok).toBe(true)
      const bankBefore = storeState().accounts.find((a) => a.id === 'acc-bank')!.balance

      await createSalesInvoice('inv-c1-part', 20000, 'Unpaid')
      expectStoreInvariants()
      const d = storeState()
      const invAfter = d.invoices.find((i) => i.id === 'inv-c1-part')!
      expect(invAfter.outstandingAmount).toBe(round2(18000))
      expect(d.payments).toHaveLength(0)
      const bank = d.accounts.find((a) => a.id === 'acc-bank')!.balance
      const ar = d.accounts.find((a) => a.id === 'acc-ar')!.balance
      expect(bank).toBe(bankBefore) // only 5,000 ever received
      expect(ar).toBe(round2(195500 + 18000))
      // Ledger agrees with the invoice.
      expect(round2(ar - 195500)).toBe(invAfter.outstandingAmount)
    })
  })

  describe('I3: payment vs unreconciled bank transaction — unified by linking (phase 3)', () => {
    it('applyPayment succeeds despite a matching unreconciled tx, which is then pre-reconciled', () => {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as typeof initialBooksData
      data.bankTransactions = [
        {
          id: 'tx-1',
          accountId: 'acc-bank',
          date: '2026-09-10',
          description: 'EFT City of Ekurhuleni settlement',
          amount: 145000,
          reconciled: false,
        },
      ]
      const party = data.parties.find((p) => p.name === 'City of Ekurhuleni Water Dept')!

      // Phase 3 replaces the phase-2 hard reject with unification: the
      // payment IS the bank movement, so recording it succeeds and the
      // matching statement line is pre-reconciled — it can never double-post.
      const res = applyPayment(data, {
        partyId: party.id,
        allocations: [
          {
            invoiceId: 'inv-1',
            invoiceNumber: 'INV-2026-001',
            amount: 145000,
          },
        ],
      })
      expect(res.ok).toBe(true)

      const linked = linkPaymentToBankTransaction(data, res.payment!)
      expect(linked.matchedTransactionId).toBe('tx-1')
      const tx = linked.bankTransactions.find((t) => t.id === 'tx-1')!
      expect(tx.reconciled).toBe(true)
      expect(tx.matchedInvoiceId).toBe('inv-1')
      expect(tx.reconciledAt).toBeTruthy()
    })
  })

  describe('I2: cumulative credit-note cap', () => {
    it('a second full credit note against the same invoice is rejected', () => {
      const original: Invoice = {
        id: 'inv-1',
        invoiceNumber: 'INV-2026-001',
        type: 'Sales',
        partyId: 'p-1',
        partyName: 'P',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        items: [],
        subtotal: 10000,
        taxTotal: 1500,
        grandTotal: 11500,
        outstandingAmount: 11500,
        status: 'Unpaid',
        createdAt: '',
        updatedAt: '',
      }
      const existing: Invoice = {
        ...original,
        id: 'cn-1',
        invoiceNumber: 'CN-2026-001',
        creditNote: true,
        creditedInvoiceId: original.id,
        createdAt: '',
        updatedAt: '',
      }
      const second: Invoice = {
        ...existing,
        id: 'cn-2',
        invoiceNumber: 'CN-2026-002',
      }
      const first = validateCreditNote({
        invoice: existing,
        originalInvoice: original,
        paidAmount: 0,
      })
      expect(first.ok).toBe(true)
      const secondRes = validateCreditNote({
        invoice: second,
        originalInvoice: original,
        paidAmount: 0,
        existingCreditNotes: [existing],
      })
      expect(secondRes.ok).toBe(false)
      expect(secondRes.error).toMatch(/cumulative/i)
    })
  })

  describe('I1: tax register nets credit notes', () => {
    it('a full credit note cancels the original sales VAT in the register', () => {
      const base: Invoice = {
        id: 'x',
        invoiceNumber: 'INV-2026-001',
        type: 'Sales',
        partyId: 'p-1',
        partyName: 'P',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        status: 'Unpaid',
        items: [
          {
            id: 'i1',
            itemCode: 'A',
            description: 'A',
            accountId: 'acc-sales',
            accountName: 'Sales',
            qty: 1,
            rate: 10000,
            taxRate: 15,
            amount: 10000,
          },
        ],
        subtotal: 10000,
        taxTotal: 1500,
        grandTotal: 11500,
        outstandingAmount: 11500,
        createdAt: '',
        updatedAt: '',
      }
      const creditNote: Invoice = {
        ...base,
        id: 'cn-1',
        invoiceNumber: 'CN-2026-001',
        creditNote: true,
        creditedInvoiceId: base.id,
      }
      const rows = taxRegister([base, creditNote])
      const totalRow = rows.find((r) => r.taxRate === null)!
      expect(totalRow.salesTax).toBe(0)
      expect(totalRow.salesTaxable).toBe(0)
    })
  })

  describe('M2: zero-rated invoices through the cross-app path', () => {
    it('issueSalesInvoiceInBooks with taxRate 0 produces a zero-rated invoice', () => {
      const res = issueSalesInvoiceInBooks({
        booksDataPath,
        partyName: 'Zero Rated Co',
        itemDescription: 'Export services',
        amount: 10000,
        taxRate: 0,
      })
      expect(res.ok).toBe(true)
      expect(res.invoice!.taxTotal).toBe(0)
      expect(res.invoice!.grandTotal).toBe(10000)
      const data = readBooksStore(booksDataPath)
      expect(data.journalEntries.every((je) => allJournalsBalanced([je]))).toBe(true)
    })
  })

  describe('dropInvoiceFromPayments', () => {
    it('removes allocations for the invoice and drops emptied payments', () => {
      const p1: Payment = {
        id: 'pay-1',
        partyId: 'p-1',
        partyName: 'P',
        date: '2026-09-01',
        type: 'received',
        allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 5000 }],
        total: 5000,
        createdAt: '',
      }
      const p2: Payment = {
        id: 'pay-2',
        partyId: 'p-2',
        partyName: 'P2',
        date: '2026-09-02',
        type: 'received',
        allocations: [
          { invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 3000 },
          { invoiceId: 'inv-2', invoiceNumber: 'INV-2026-002', amount: 2000 },
        ],
        total: 5000,
        createdAt: '',
      }
      const result = dropInvoiceFromPayments([p1, p2], 'inv-1', 'INV-2026-001')
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('pay-2')
      expect(result[0].allocations).toEqual([
        { invoiceId: 'inv-2', invoiceNumber: 'INV-2026-002', amount: 2000 },
      ])
    })
  })

  describe('Refund payments (customer credit balances)', () => {
    const creditNoteData = (outstanding = -11500): typeof initialBooksData => {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as typeof initialBooksData
      data.invoices = [
        {
          id: 'cn-1',
          invoiceNumber: 'CN-2026-001',
          type: 'Sales',
          partyId: 'party-1',
          partyName: 'City of Ekurhuleni Water Dept',
          date: '2026-09-01',
          dueDate: '2026-10-01',
          items: [],
          subtotal: 10000,
          taxTotal: 1500,
          grandTotal: 11500,
          outstandingAmount: outstanding,
          status: 'Unpaid',
          creditNote: true,
          creditedInvoiceId: 'inv-1',
          createdAt: '',
          updatedAt: '',
        },
      ]
      return data
    }

    it('applyPayment accepts a refund against a credit note and reduces the credit', () => {
      const data = creditNoteData()
      const res = applyPayment(data, {
        partyId: 'party-1',
        type: 'refund',
        allocations: [{ invoiceId: 'cn-1', invoiceNumber: 'CN-2026-001', amount: 5000 }],
      })
      expect(res.ok).toBe(true)
      expect(res.payment!.type).toBe('refund')
      expect(res.updatedInvoices![0].outstandingAmount).toBe(-6500)
    })

    it('applyPayment rejects refunds against invoices, purchases and over-credits', () => {
      const notCN = creditNoteData()
      notCN.invoices = [
        {
          id: 'inv-x',
          invoiceNumber: 'INV-2026-001',
          type: 'Sales',
          partyId: 'party-1',
          partyName: 'City of Ekurhuleni Water Dept',
          date: '2026-09-01',
          dueDate: '2026-10-01',
          items: [],
          subtotal: 10000,
          taxTotal: 1500,
          grandTotal: 11500,
          outstandingAmount: 11500,
          status: 'Unpaid',
          createdAt: '',
          updatedAt: '',
        },
      ]
      const onInvoice = applyPayment(notCN, {
        partyId: 'party-1',
        type: 'refund',
        allocations: [{ invoiceId: 'inv-x', invoiceNumber: 'INV-2026-001', amount: 1000 }],
      })
      expect(onInvoice.ok).toBe(false)
      expect(onInvoice.error).toMatch(/credit notes/i)

      const data = creditNoteData(-11500)
      const over = applyPayment(data, {
        partyId: 'party-1',
        type: 'refund',
        allocations: [{ invoiceId: 'cn-1', invoiceNumber: 'CN-2026-001', amount: 12000 }],
      })
      expect(over.ok).toBe(false)
      expect(over.error).toMatch(/exceeds outstanding/)
    })

    it('createPaymentJournal posts a balanced refund journal (Dr AR / Cr Bank)', () => {
      const data = creditNoteData()
      const res = applyPayment(data, {
        partyId: 'party-1',
        type: 'refund',
        allocations: [{ invoiceId: 'cn-1', invoiceNumber: 'CN-2026-001', amount: 11500 }],
      })
      expect(res.ok).toBe(true)
      const journal = createPaymentJournal(
        res.payment!,
        res.updatedInvoices!,
        initialBooksData.accounts,
      )
      expect(allJournalsBalanced([journal])).toBe(true)
      expect(journal.totalDebit).toBe(11500)
      const arItem = journal.items.find((i) => i.accountId === 'acc-ar')!
      const bankItem = journal.items.find((i) => i.accountId === 'acc-bank')!
      expect(arItem.debit).toBe(11500)
      expect(bankItem.credit).toBe(11500)
      expect(journal.remarks).toContain(res.payment!.id)
    })

    it('store recordPayment(refund) + deletePayment round-trip keeps invariants', async () => {
      useBooksStore.setState({
        data: JSON.parse(JSON.stringify(creditNoteData())),
      })
      const res = await useBooksStore.getState().recordPayment({
        partyId: 'party-1',
        type: 'refund',
        allocations: [{ invoiceId: 'cn-1', invoiceNumber: 'CN-2026-001', amount: 5000 }],
      })
      expect(res.ok).toBe(true)
      expectStoreInvariants()
      const d = storeState()
      const bank = d.accounts.find((a) => a.id === 'acc-bank')!.balance
      const ar = d.accounts.find((a) => a.id === 'acc-ar')!.balance
      // Refund pays out 5,000: bank down, AR credit reduced (195,500 + 5,000).
      expect(bank).toBe(round2(485250 - 5000))
      expect(ar).toBe(round2(195500 + 5000))
      const cn = d.invoices.find((i) => i.id === 'cn-1')!
      expect(cn.outstandingAmount).toBe(-6500)

      await useBooksStore.getState().deletePayment(d.payments[0].id)
      expectStoreInvariants()
      const final = storeState()
      expect(final.accounts.find((a) => a.id === 'acc-bank')!.balance).toBe(485250)
      expect(final.accounts.find((a) => a.id === 'acc-ar')!.balance).toBe(195500)
      expect(final.invoices.find((i) => i.id === 'cn-1')!.outstandingAmount).toBe(-11500)
    })
  })
})
