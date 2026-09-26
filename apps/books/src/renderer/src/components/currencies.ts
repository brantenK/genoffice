import type { Invoice } from '../../../shared/types'

/**
 * The fixed currency list the invoice form offers beside the company's base
 * currency. There is no FX-rate service — the user types the exchange rate —
 * so this list only names codes the module knows how to display.
 */
export const EXTRA_CURRENCIES: string[] = ['USD', 'EUR', 'GBP', 'KES', 'BWP', 'NAD']

/** The currency an invoice is denominated in; an absent field means the base. */
export function invoiceCurrencyCode(inv: Pick<Invoice, 'currency'>, baseCurrency: string): string {
  return (inv.currency || '').trim() || baseCurrency
}

/** True when the invoice is denominated in the ledger's base currency. */
export function isBaseCurrency(inv: Pick<Invoice, 'currency'>, baseCurrency: string): boolean {
  return invoiceCurrencyCode(inv, baseCurrency).toUpperCase() === baseCurrency.toUpperCase()
}

/** The tag shown beside a foreign-currency amount; '' when the invoice is in base. */
export function currencyTag(inv: Pick<Invoice, 'currency'>, baseCurrency: string): string {
  return isBaseCurrency(inv, baseCurrency) ? '' : invoiceCurrencyCode(inv, baseCurrency)
}
