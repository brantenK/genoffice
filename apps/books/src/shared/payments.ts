import type {
  Account,
  BankPaymentLink,
  BankTransaction,
  BooksData,
  Invoice,
  InvoiceStatus,
  JournalEntry,
  JournalEntryItem,
  Party,
  Payment,
  PaymentAllocation,
} from './types'
import { round2 } from './accounting'

/**
 * Payments engine (pure — no electron/react imports).
 *
 * Ledger-first invariant: recording a payment NEVER mutates account balances
 * directly. `applyPayment` only applies the allocations to the invoices
 * (outstanding amounts + status); the caller then posts the balanced journal
 * entry produced by `createPaymentJournal` and recomputes every balance from
 * the journals. Deleting a payment reverses those journals and restores the
 * invoice outstanding amounts — balances always stay journal-derived.
 */

/** Input for recording a payment against open invoices of one party. */
export interface ApplyPaymentInput {
  /** Party id — or a party name (resolved case-insensitively). */
  partyId?: string
  /** Alternative to `partyId`: resolve the party by name. */
  partyName?: string
  /** Payment date (ISO YYYY-MM-DD). Defaults to today. */
  date?: string
  /**
   * 'received' (customer pays us), 'paid' (we pay a supplier) or 'refund'
   * (we refund a customer's credit balance against their sales credit notes).
   * Defaults from party.type; 'refund' is always explicit.
   */
  type?: 'received' | 'paid' | 'refund'
  /** Payment method (Bank Transfer / Cash / Card / Other). */
  method?: string
  /** External reference (EFT number, cheque number, ...). */
  reference?: string
  /** One allocation per open invoice of the party. */
  allocations: PaymentAllocation[]
}

export interface ApplyPaymentResult {
  ok: boolean
  payment?: Payment
  /** The full invoice list with applied allocations (outstanding/status updated). */
  updatedInvoices?: Invoice[]
  error?: string
}

/**
 * Validates a payment input against the ledger and applies the allocations
 * to the invoices. Pure: returns the new invoice array + the Payment; the
 * caller decides what to persist. Never touches account balances.
 */
export function applyPayment(data: BooksData, input: ApplyPaymentInput): ApplyPaymentResult {
  if (!data) return { ok: false, error: 'No ledger data' }
  const parties = Array.isArray(data.parties) ? data.parties : []
  const invoices = Array.isArray(data.invoices) ? data.invoices : []

  const partyId = String(input.partyId || '').trim()
  const partyName = String(input.partyName || '').trim()

  // Resolve the party by id or name (input.partyId may itself be a name).
  let party: Party | undefined
  if (partyId) {
    party =
      parties.find((p) => p.id === partyId) ||
      parties.find((p) => p.name.toLowerCase() === partyId.toLowerCase())
  }
  if (!party && partyName) {
    party = parties.find((p) => p.name.toLowerCase() === partyName.toLowerCase())
  }
  if (!party) {
    return { ok: false, error: `Party not found: ${partyName || partyId || '(none)'}` }
  }

  const allocations = Array.isArray(input.allocations) ? input.allocations : []
  if (allocations.length === 0) {
    return { ok: false, error: 'Payment must allocate at least one invoice' }
  }

  // Direction defaults from the party classification; 'refund' is explicit.
  const type: 'received' | 'paid' | 'refund' =
    input.type === 'received' || input.type === 'paid' || input.type === 'refund'
      ? input.type
      : party.type === 'Customer'
        ? 'received'
        : 'paid'

  const invoiceById = new Map(invoices.map((i) => [i.id, i]))
  const seen = new Set<string>()
  const resolved: { allocation: PaymentAllocation; invoice: Invoice }[] = []

  for (const alloc of allocations) {
    if (!alloc || typeof alloc.invoiceId !== 'string') {
      return { ok: false, error: 'Each allocation must reference an invoice' }
    }
    if (seen.has(alloc.invoiceId)) {
      return { ok: false, error: `Duplicate allocation for invoice ${alloc.invoiceId}` }
    }
    seen.add(alloc.invoiceId)

    const invoice = invoiceById.get(alloc.invoiceId)
    if (!invoice) {
      return { ok: false, error: `Invoice not found: ${alloc.invoiceId}` }
    }
    if (
      invoice.partyId !== party.id &&
      String(invoice.partyName || '').toLowerCase() !== party.name.toLowerCase()
    ) {
      return {
        ok: false,
        error: `Invoice ${invoice.invoiceNumber} does not belong to ${party.name}`,
      }
    }

    // Only open (non-Draft, non-Cancelled) invoices are payable.
    const status = String(invoice.status || '').toLowerCase()
    if (status === 'draft' || status === 'cancelled') {
      return { ok: false, error: `Invoice ${invoice.invoiceNumber} is ${invoice.status}` }
    }
    const outstanding = round2(
      invoice.outstandingAmount !== undefined && invoice.outstandingAmount !== null
        ? invoice.outstandingAmount
        : invoice.grandTotal,
    )

    // Direction sanity per payment type.
    if (type === 'refund') {
      // Refunds pay back a customer's credit balance: allocations must
      // reference the party's sales credit notes with a negative
      // outstanding (credit) balance.
      if (invoice.type !== 'Sales' || !invoice.creditNote) {
        return {
          ok: false,
          error: `Refunds can only be allocated against sales credit notes (${invoice.invoiceNumber})`,
        }
      }
      if (outstanding >= 0) {
        return {
          ok: false,
          error: `Credit note ${invoice.invoiceNumber} has no outstanding credit balance`,
        }
      }
    } else if (outstanding <= 0) {
      return {
        ok: false,
        error: `Invoice ${invoice.invoiceNumber} has no outstanding amount`,
      }
    }

    const amount = round2(Number(alloc.amount) || 0)
    if (amount <= 0) {
      return {
        ok: false,
        error: `Allocation amount for ${invoice.invoiceNumber} must be greater than 0`,
      }
    }
    const maxAlloc = type === 'refund' ? -outstanding : outstanding
    if (amount > maxAlloc) {
      return {
        ok: false,
        error: `Allocation amount ${amount} exceeds outstanding ${maxAlloc} for ${invoice.invoiceNumber}`,
      }
    }

    // Direction sanity: received only settles Sales, paid only settles Purchase.
    if (type === 'received' && invoice.type !== 'Sales') {
      return {
        ok: false,
        error: `Cannot record a received payment against Purchase bill ${invoice.invoiceNumber}`,
      }
    }
    if (type === 'paid' && invoice.type !== 'Purchase') {
      return {
        ok: false,
        error: `Cannot record a paid payment against Sales invoice ${invoice.invoiceNumber}`,
      }
    }

    resolved.push({
      allocation: {
        invoiceId: alloc.invoiceId,
        invoiceNumber: alloc.invoiceNumber || invoice.invoiceNumber,
        amount,
      },
      invoice,
    })
  }

  const total = round2(resolved.reduce((s, r) => s + r.allocation.amount, 0))

  const paymentId = `pay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const payment: Payment = {
    id: paymentId,
    partyId: party.id,
    partyName: party.name,
    date: input.date || new Date().toISOString().split('T')[0],
    type,
    method: input.method || undefined,
    reference: input.reference || undefined,
    allocations: resolved.map((r) => ({ ...r.allocation })),
    total,
    createdAt: new Date().toISOString(),
  }

  // Apply allocations: received/paid reduce a positive outstanding; refunds
  // reduce a credit balance (negative outstanding moves toward zero). Status
  // becomes 'Paid' only when the outstanding reaches exactly zero.
  const updatedInvoices = invoices.map((inv) => {
    const hit = resolved.find((r) => r.invoice.id === inv.id)
    if (!hit) return inv
    const outstanding = round2(
      inv.outstandingAmount !== undefined && inv.outstandingAmount !== null
        ? inv.outstandingAmount
        : inv.grandTotal,
    )
    const signed = type === 'refund' ? -hit.allocation.amount : hit.allocation.amount
    const nextOutstanding = round2(outstanding - signed)
    return {
      ...inv,
      outstandingAmount: nextOutstanding,
      status: (nextOutstanding === 0 ? 'Paid' : 'Unpaid') as InvoiceStatus,
      updatedAt: new Date().toISOString(),
    }
  })

  return { ok: true, payment, updatedInvoices }
}

/**
 * Common words never treated as significant party-name tokens when matching
 * bank-transaction text against a party, so 'EFT City of Ekurhuleni
 * settlement' matches 'City of Ekurhuleni Water Dept' via 'ekurhuleni'.
 */
const PARTY_TOKEN_STOP_WORDS = new Set([
  'city',
  'of',
  'the',
  'and',
  'dept',
  'ltd',
  'pty',
  'inc',
  'corp',
  'co',
])

/** Significant party-name tokens: words of length >= 4, minus stop words. */
function significantPartyTokens(name: string): string[] {
  return (name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !PARTY_TOKEN_STOP_WORDS.has(t))
}

/** Direction sanity for a payment versus a statement line. */
export function paymentDirectionMatchesTx(payment: Payment, tx: BankTransaction): boolean {
  if (payment.type === 'received') return tx.amount > 0
  if (payment.type === 'paid' || payment.type === 'refund') return tx.amount < 0
  return false
}

/** A transaction's exact payment coverage already attributed to it. */
export function paymentCoverage(tx: BankTransaction): number {
  return round2((tx.paymentLinks || []).reduce((sum, link) => sum + round2(link.amount || 0), 0))
}

/** The allocation whose invoice number appears in the statement text. */
export function matchedInvoiceAllocation(payment: Payment, tx: BankTransaction): PaymentAllocation | undefined {
  const haystack = `${tx.description || ''} ${tx.reference || ''}`.toLowerCase()
  return (
    (payment.allocations || []).find((a) => {
      const num = (a.invoiceNumber || '').toLowerCase()
      return num.length > 0 && haystack.includes(num)
    }) || (payment.allocations || [])[0]
  )
}

/** Text-only matching, shared by exact and partial coverage flows. */
export function paymentTextMatchesTransaction(payment: Payment, tx: BankTransaction): boolean {
  if (!payment || !tx || !paymentDirectionMatchesTx(payment, tx)) return false
  const haystack = `${tx.description || ''} ${tx.reference || ''}`.toLowerCase()
  const fullName = (payment.partyName || '').toLowerCase()
  const matchesParty =
    (fullName.length >= 6 && haystack.includes(fullName)) ||
    significantPartyTokens(payment.partyName).some((t) => haystack.includes(t))
  const matchesInvoice = (payment.allocations || []).some((a) => {
    const num = (a.invoiceNumber || '').toLowerCase()
    return num.length > 0 && haystack.includes(num)
  })
  return matchesParty || matchesInvoice
}

/** Exact-match predicate retained for callers/tests that require equal totals. */
export function paymentMatchesTransaction(payment: Payment, tx: BankTransaction): boolean {
  return (
    paymentTextMatchesTransaction(payment, tx) &&
    Math.abs(Math.abs(tx.amount) - round2(payment.total || 0)) < 0.01
  )
}

export interface ImportCoverage {
  coveredAmount: number
  fullyCovered: boolean
  matchedInvoiceId?: string
  paymentLinks: BankPaymentLink[]
}

/**
 * Plans durable, non-overlapping payment coverage for new statement lines.
 * Each payment can be consumed only once; each transaction is capped at its
 * actual amount. This prevents one payment covering two identical lines and
 * prevents multiple payments suppressing more than a line's cash movement.
 */
export function planImportCoverage(data: BooksData, newTxs: BankTransaction[]): Map<string, ImportCoverage> {
  const payments = Array.isArray(data.payments) ? data.payments : []
  // A payment may already cover only PART of an existing statement line.
  // Consume exactly the linked amount, leaving any remainder available for a
  // later matching transaction rather than dropping the whole payment.
  const usedByPayment = new Map<string, number>()
  for (const tx of data.bankTransactions || []) {
    for (const link of tx.paymentLinks || []) {
      usedByPayment.set(
        link.paymentId,
        round2((usedByPayment.get(link.paymentId) || 0) + round2(link.amount || 0)),
      )
    }
  }
  const remaining = new Map<string, number>()
  for (const payment of payments) {
    remaining.set(
      payment.id,
      Math.max(0, round2(round2(payment.total || 0) - (usedByPayment.get(payment.id) || 0))),
    )
  }

  const plan = new Map<string, ImportCoverage>()
  for (const tx of newTxs || []) {
    const txTotal = round2(Math.abs(tx.amount || 0))
    let remainingTx = txTotal
    const links: BankPaymentLink[] = []
    let matchedInvoiceId: string | undefined
    for (const payment of payments) {
      const available = round2(remaining.get(payment.id) || 0)
      if (available <= 0 || !paymentTextMatchesTransaction(payment, tx) || remainingTx <= 0) continue
      const covered = round2(Math.min(available, remainingTx))
      const allocation = matchedInvoiceAllocation(payment, tx)
      links.push({ paymentId: payment.id, amount: covered, invoiceId: allocation?.invoiceId })
      remaining.set(payment.id, round2(available - covered))
      remainingTx = round2(remainingTx - covered)
      if (!matchedInvoiceId && allocation) matchedInvoiceId = allocation.invoiceId
    }
    const coveredAmount = round2(txTotal - remainingTx)
    plan.set(tx.id, {
      coveredAmount,
      fullyCovered: txTotal > 0 && remainingTx <= 0.005,
      matchedInvoiceId,
      paymentLinks: links,
    })
  }
  return plan
}

/** Finds an import-first statement line with remaining coverage capacity. */
export function findMatchingUnreconciledTransaction(data: BooksData, payment: Payment): BankTransaction | null {
  const bankTx = Array.isArray(data.bankTransactions) ? data.bankTransactions : []
  for (const tx of bankTx) {
    if (tx.reconciled || !paymentTextMatchesTransaction(payment, tx)) continue
    if (round2(Math.abs(tx.amount) - paymentCoverage(tx)) > 0) return tx
  }
  return null
}

/**
 * Links a payment to an existing statement line by an exact partial amount.
 * The line becomes reconciled only when its full cash amount is covered.
 */
export function linkPaymentToBankTransaction(
  data: BooksData,
  payment: Payment,
): { bankTransactions: BankTransaction[]; matchedTransactionId?: string; coveredAmount?: number } {
  const bankTx = Array.isArray(data.bankTransactions) ? data.bankTransactions : []
  const match = findMatchingUnreconciledTransaction(data, payment)
  if (!match) return { bankTransactions: bankTx }
  const available = round2(Math.abs(match.amount) - paymentCoverage(match))
  const coveredAmount = round2(Math.min(available, payment.total || 0))
  if (coveredAmount <= 0) return { bankTransactions: bankTx }
  const allocation = matchedInvoiceAllocation(payment, match)
  return {
    bankTransactions: bankTx.map((tx) => {
      if (tx.id !== match.id) return tx
      const links = [...(tx.paymentLinks || []), { paymentId: payment.id, amount: coveredAmount, invoiceId: allocation?.invoiceId }]
      const totalCovered = round2(links.reduce((sum, link) => sum + link.amount, 0))
      const fullyCovered = Math.abs(totalCovered - Math.abs(tx.amount)) < 0.01
      return {
        ...tx,
        paymentLinks: links,
        reconciled: fullyCovered,
        matchedInvoiceId: fullyCovered ? allocation?.invoiceId : undefined,
        reconciledAt: fullyCovered ? new Date().toISOString() : undefined,
      }
    }),
    matchedTransactionId: match.id,
    coveredAmount,
  }
}

/**
 * Creates the balanced JournalEntry for a recorded payment:
 * - received: Dr Bank (total) / Cr Accounts Receivable (one item per allocation)
 * - paid:     Dr Accounts Payable (one item per allocation) / Cr Bank (total)
 * - refund:   Dr Accounts Receivable / Cr Bank (total)
 * Pass `opts.bankAccountId` (e.g. 'acc-suspense') when the cash leg must
 * clear an import journal's Suspense instead of moving Bank again — the
 * import already booked the bank movement (C1). Entry-level remarks always
 * embed `Payment ${payment.id}` so a reversal (deletePayment) can find and
 * remove the entry by id.
 */
export function createPaymentJournal(
  payment: Payment,
  invoices: Invoice[],
  accounts: Account[],
  entryNumber?: string,
  opts?: { bankAccountId?: string; suspenseAmount?: number },
): JournalEntry {
  const year = new Date(payment.date).getFullYear() || new Date().getFullYear()
  const randomSuffix = Math.random().toString(36).slice(2, 7)
  const entryNum = entryNumber || `JE-${year}-${String(Date.now()).slice(-4)}-${randomSuffix}`
  const total = round2(payment.total)

  const cashAccountId = opts?.bankAccountId || 'acc-bank'
  const bankAcc =
    accounts.find((a) => a.id === cashAccountId) ||
    accounts.find((a) => a.accountType === 'Bank') || {
      id: cashAccountId,
      name: 'Bank Account',
    }
  const suspenseAcc = accounts.find((a) => a.id === 'acc-suspense') || {
    id: 'acc-suspense',
    name: 'Bank Suspense / Clearing',
  }
  const suspenseAmount = round2(Math.min(Math.max(opts?.suspenseAmount || 0, 0), total))
  const bankAmount = round2(total - suspenseAmount)
  const invoiceById = new Map(invoices.map((i) => [i.id, i]))
  const baseRemark = `Payment ${payment.id} - ${payment.reference || payment.method || 'payment'}`

  const items: JournalEntryItem[] = []

  if (payment.type === 'received') {
    const arAcc = accounts.find((a) => a.id === 'acc-ar' || a.accountType === 'Receivable') || {
      id: 'acc-ar',
      name: 'Accounts Receivable (Debtors)',
    }
    if (bankAmount > 0) {
      items.push({
        id: `jei-pay-bank-${Date.now()}-${randomSuffix}`,
        accountId: bankAcc.id,
        accountName: bankAcc.name,
        debit: bankAmount,
        credit: 0,
        remark: baseRemark,
      })
    }
    if (suspenseAmount > 0) {
      items.push({
        id: `jei-pay-susp-${Date.now()}-${randomSuffix}`,
        accountId: suspenseAcc.id,
        accountName: suspenseAcc.name,
        debit: suspenseAmount,
        credit: 0,
        remark: `${baseRemark} (clears statement suspense)`,
      })
    }
    payment.allocations.forEach((alloc, idx) => {
      const invoice = invoiceById.get(alloc.invoiceId)
      const invoiceNumber = alloc.invoiceNumber || invoice?.invoiceNumber || alloc.invoiceId
      items.push({
        id: `jei-pay-ar-${idx + 1}-${Date.now()}-${randomSuffix}`,
        accountId: arAcc.id,
        accountName: arAcc.name,
        partyId: payment.partyId,
        partyName: payment.partyName,
        debit: 0,
        credit: round2(alloc.amount),
        remark: `Payment received: ${invoiceNumber}`,
      })
    })
  } else if (payment.type === 'refund') {
    // A customer refund pays back their credit balance: Cr Bank, Dr AR per
    // credit note (reduces the credit). Mirrors the settlement direction.
    const arAcc = accounts.find((a) => a.id === 'acc-ar' || a.accountType === 'Receivable') || {
      id: 'acc-ar',
      name: 'Accounts Receivable (Debtors)',
    }
    payment.allocations.forEach((alloc, idx) => {
      const invoice = invoiceById.get(alloc.invoiceId)
      const invoiceNumber = alloc.invoiceNumber || invoice?.invoiceNumber || alloc.invoiceId
      items.push({
        id: `jei-ref-ar-${idx + 1}-${Date.now()}-${randomSuffix}`,
        accountId: arAcc.id,
        accountName: arAcc.name,
        partyId: payment.partyId,
        partyName: payment.partyName,
        debit: round2(alloc.amount),
        credit: 0,
        remark: `Refund for ${invoiceNumber}`,
      })
    })
    if (bankAmount > 0) {
      items.push({
        id: `jei-ref-bank-${Date.now()}-${randomSuffix}`,
        accountId: bankAcc.id,
        accountName: bankAcc.name,
        debit: 0,
        credit: bankAmount,
        remark: baseRemark,
      })
    }
    if (suspenseAmount > 0) {
      items.push({
        id: `jei-ref-susp-${Date.now()}-${randomSuffix}`,
        accountId: suspenseAcc.id,
        accountName: suspenseAcc.name,
        debit: 0,
        credit: suspenseAmount,
        remark: `${baseRemark} (clears statement suspense)`,
      })
    }
  } else {
    const apAcc = accounts.find((a) => a.id === 'acc-ap' || a.accountType === 'Payable') || {
      id: 'acc-ap',
      name: 'Accounts Payable (Creditors)',
    }
    payment.allocations.forEach((alloc, idx) => {
      const invoice = invoiceById.get(alloc.invoiceId)
      const invoiceNumber = alloc.invoiceNumber || invoice?.invoiceNumber || alloc.invoiceId
      items.push({
        id: `jei-pay-ap-${idx + 1}-${Date.now()}-${randomSuffix}`,
        accountId: apAcc.id,
        accountName: apAcc.name,
        partyId: payment.partyId,
        partyName: payment.partyName,
        debit: round2(alloc.amount),
        credit: 0,
        remark: `Payment made: ${invoiceNumber}`,
      })
    })
    if (bankAmount > 0) {
      items.push({
        id: `jei-pay-bank-${Date.now()}-${randomSuffix}`,
        accountId: bankAcc.id,
        accountName: bankAcc.name,
        debit: 0,
        credit: bankAmount,
        remark: baseRemark,
      })
    }
    if (suspenseAmount > 0) {
      items.push({
        id: `jei-pay-susp-${Date.now()}-${randomSuffix}`,
        accountId: suspenseAcc.id,
        accountName: suspenseAcc.name,
        debit: 0,
        credit: suspenseAmount,
        remark: `${baseRemark} (clears statement suspense)`,
      })
    }
  }

  return {
    id: `je-${Date.now()}-${randomSuffix}`,
    entryNumber: entryNum,
    date: payment.date,
    items,
    totalDebit: total,
    totalCredit: total,
    remarks: baseRemark,
    posted: true,
  }
}

/**
 * Removes every allocation referencing the given invoice from the payment
 * list and drops payments that end up with no allocations. Used when an
 * invoice is edited (reverse-and-repost) or deleted, so stale Payment
 * records never survive their invoice's journals (C1).
 */
export function dropInvoiceFromPayments(
  payments: Payment[],
  invoiceId: string,
  invoiceNumber: string,
): Payment[] {
  return (payments || [])
    .map((p) => ({
      ...p,
      allocations: (p.allocations || []).filter(
        (a) => a.invoiceId !== invoiceId && a.invoiceNumber !== invoiceNumber,
      ),
    }))
    .filter((p) => p.allocations.length > 0)
}
