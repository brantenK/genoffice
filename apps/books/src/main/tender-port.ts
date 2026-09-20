// Books-owned implementation of the Tenders milestone-invoice port (Phase 4).
//
// Wraps the single sales-invoice posting path (`issueSalesInvoiceInBooks`) so
// Tenders never posts journals or touches the Books store itself. The stable
// `idempotencyKey` maps to the invoice's `crmDealId`, which Books dedupes on.
import { join } from 'node:path'
import { issueSalesInvoiceInBooks } from './books-core'
import type {
  MilestoneInvoiceInput,
  MilestoneInvoiceResult,
} from '../../../tenders/src/main/integrations'

export interface BooksTenderPortOptions {
  userDataDir: string
  /** Override the books store path (tests / alternate profiles). */
  booksDataPath?: string
}

export interface BooksTenderPort {
  booksDataPath: string
  issueMilestoneInvoice: (input: MilestoneInvoiceInput) => MilestoneInvoiceResult
}

export function createBooksTenderPort(options: BooksTenderPortOptions): BooksTenderPort {
  const booksDataPath =
    options.booksDataPath ?? join(options.userDataDir, 'books', 'books-data.json')

  const issueMilestoneInvoice = (input: MilestoneInvoiceInput): MilestoneInvoiceResult => {
    const result = issueSalesInvoiceInBooks({
      booksDataPath,
      partyName: input.partyName,
      itemDescription: input.itemDescription,
      amount: input.amount,
      itemCode: input.itemCode,
      accountId: input.accountId,
      accountName: input.accountName,
      tenderReference: input.tenderReference,
      crmDealId: input.idempotencyKey,
      notes: input.notes,
      date: input.date,
      dueDate: input.dueDate,
    })
    if (!result.ok || !result.invoice) {
      return { ok: false, error: result.error || 'Failed to issue milestone invoice' }
    }
    const invoice = result.invoice
    return {
      ok: true,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      subtotal: invoice.subtotal,
      taxTotal: invoice.taxTotal,
      grandTotal: invoice.grandTotal,
    }
  }

  return { booksDataPath, issueMilestoneInvoice }
}
