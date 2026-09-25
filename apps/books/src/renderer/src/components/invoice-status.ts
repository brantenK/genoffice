import type { Invoice, InvoiceStatus } from '../../../shared/types'

/**
 * The status a document shows on screen: an unpaid invoice past its due date
 * reads as Overdue, because that is what the user sees. Every other stored
 * status is shown exactly as stored, so a paid, draft or cancelled document can
 * never be dressed up as overdue.
 *
 * Defined once and used by both the badge and the status filter, so the chip
 * can never select a different set of rows than the badges it sits above.
 */
export function displayInvoiceStatus(
  status: InvoiceStatus,
  dueDate: string | undefined,
  asOf: string,
): InvoiceStatus {
  if (status !== 'Unpaid') return status
  return dueDate && dueDate < asOf ? 'Overdue' : 'Unpaid'
}

/** True when a row belongs to the active status chip (the badge's own status). */
export function invoiceMatchesStatusFilter(
  invoice: Pick<Invoice, 'status' | 'dueDate'>,
  filter: 'All' | InvoiceStatus,
  asOf: string,
): boolean {
  return filter === 'All' || displayInvoiceStatus(invoice.status, invoice.dueDate, asOf) === filter
}
