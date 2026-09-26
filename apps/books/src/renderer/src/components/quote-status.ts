import type { Quotation, QuotationStatus } from '../../../shared/types'

/**
 * The status a quotation shows on screen: a live offer whose validity date has
 * passed reads as Expired, because that is what the user sees — the same
 * derivation the invoice Overdue badge uses (`displayInvoiceStatus`).
 *
 * Expired is a display state only and is never written to storage: a
 * quotation that lapsed while still Draft or Sent keeps that stored status,
 * so the record on disk never claims a lifecycle event nobody recorded.
 */
export function displayQuoteStatus(
  quote: Pick<Quotation, 'status' | 'validUntil'>,
  asOf: string,
): QuotationStatus {
  if (quote.status !== 'Draft' && quote.status !== 'Sent') return quote.status
  return quote.validUntil && quote.validUntil < asOf ? 'Expired' : quote.status
}

/** True when a row belongs to the active status chip (the badge's own status). */
export function quoteMatchesStatusFilter(
  quote: Pick<Quotation, 'status' | 'validUntil'>,
  filter: 'All' | QuotationStatus,
  asOf: string,
): boolean {
  return filter === 'All' || displayQuoteStatus(quote, asOf) === filter
}
