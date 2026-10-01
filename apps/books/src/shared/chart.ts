// Zano Books chart of accounts & company defaults.
// Pure module (no electron imports) so both the main process and the
// renderer (setup wizard) can share it.
import type { Account, CompanySettings } from './types'

/** Neutral company defaults — the setup wizard collects real values. */
export const DEFAULT_BOOK_SETTINGS: CompanySettings = {
  companyName: '',
  taxNumber: '',
  currency: 'ZAR',
  currencySymbol: 'R',
  financialYearStart: '2026-03-01',
  address: '',
  email: '',
  phone: '',
  defaultTaxRate: 15,
  taxInclusive: true,
  registrationNumber: '',
}

/**
 * Payment terms applied when an invoice leaves the due date blank, in days.
 * Single source of truth for the previous hardcoded `+ 30 days` default.
 */
export const DEFAULT_PAYMENT_TERMS_DAYS = 30

/**
 * The default invoice print accent (#RRGGBB) — the module's teal, the colour
 * the classic PDF template has always used for its "Amount Due" emphasis.
 */
export const DEFAULT_INVOICE_ACCENT = '#0F766E'

/**
 * The six preset accents the settings UI offers (the module's palette, the
 * green and blue values a11y-darkened). The picker is swatches-only so the
 * accent can never be an arbitrary, off-palette colour.
 */
export const INVOICE_ACCENT_SWATCHES: { label: string; value: string }[] = [
  { label: 'Teal', value: '#0F766E' },
  { label: 'Blue', value: '#007BE0' },
  { label: 'Green', value: '#1B7A46' },
  { label: 'Red', value: '#C22626' },
  { label: 'Amber', value: '#B45309' },
  { label: 'Dark', value: '#1E293B' },
]

/** Hard cap for the letterhead footer text, enforced by migration and UI. */
export const LETTERHEAD_FOOTER_MAX = 200

/** Hard cap for the company registration number, enforced by migration and UI. */
export const REGISTRATION_NUMBER_MAX = 120

/**
 * Hard cap for the letterhead logo's data-URL text: a ~512 KB image encodes to
 * just under 700k base64 characters, so the cap bounds what a settings payload
 * — and the PDF embedder — may carry.
 */
export const MAX_LOGO_DATA_URL_CHARS = 700_000

/** True for a PNG/JPEG data URL inside the logo cap (the only accepted shape). */
export function isValidLogoDataUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_LOGO_DATA_URL_CHARS &&
    /^data:image\/(png|jpeg);base64,/.test(value)
  )
}

/** True for a literal #RRGGBB accent colour (the only accepted shape). */
export function isValidInvoiceAccent(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value)
}

/**
 * Ledger name for the bank account when the chart of accounts has no banking
 * account to resolve (see CORE_ACCOUNTS 'acc-bank'). The neutral name is
 * used instead of naming the founder's bank.
 */
export const DEFAULT_BANK_ACCOUNT_NAME = 'Business Cheque Account'

/**
 * Standard chart of accounts. All balances are 0 — balances are derived
 * from journal entries (ledger-first); stored balance fields are only a
 * serialization cache recomputed on every read/write.
 */
export const CORE_ACCOUNTS: Account[] = [
  // ASSETS
  {
    id: 'acc-asset',
    name: 'Application of Funds (Assets)',
    rootType: 'Asset',
    accountType: 'Current Asset',
    parentId: null,
    isGroup: true,
    balance: 0,
  },
  {
    id: 'acc-curr-asset',
    name: 'Current Assets',
    rootType: 'Asset',
    accountType: 'Current Asset',
    parentId: 'acc-asset',
    isGroup: true,
    balance: 0,
  },
  {
    id: 'acc-bank',
    name: 'Business Cheque Account',
    rootType: 'Asset',
    accountType: 'Bank',
    parentId: 'acc-curr-asset',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-cash',
    name: 'Petty Cash',
    rootType: 'Asset',
    accountType: 'Cash',
    parentId: 'acc-curr-asset',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-ar',
    name: 'Accounts Receivable (Debtors)',
    rootType: 'Asset',
    accountType: 'Receivable',
    parentId: 'acc-curr-asset',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-inventory',
    name: 'Inventory & Materials on Hand',
    rootType: 'Asset',
    accountType: 'Current Asset',
    parentId: 'acc-curr-asset',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-vat-in',
    name: 'SARS VAT Input Recoverable',
    rootType: 'Asset',
    accountType: 'Tax',
    parentId: 'acc-curr-asset',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-suspense',
    name: 'Bank Suspense / Clearing',
    rootType: 'Asset',
    accountType: 'Current Asset',
    parentId: 'acc-curr-asset',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-fixed-asset',
    name: 'Fixed Assets',
    rootType: 'Asset',
    accountType: 'Fixed Asset',
    parentId: 'acc-asset',
    isGroup: true,
    balance: 0,
  },
  {
    id: 'acc-equip',
    name: 'Office & IT Equipment',
    rootType: 'Asset',
    accountType: 'Fixed Asset',
    parentId: 'acc-fixed-asset',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-vehic',
    name: 'Site Utility Vehicles',
    rootType: 'Asset',
    accountType: 'Fixed Asset',
    parentId: 'acc-fixed-asset',
    isGroup: false,
    balance: 0,
  },

  // LIABILITIES
  {
    id: 'acc-liab',
    name: 'Source of Funds (Liabilities)',
    rootType: 'Liability',
    accountType: 'Current Liability',
    parentId: null,
    isGroup: true,
    balance: 0,
  },
  {
    id: 'acc-curr-liab',
    name: 'Current Liabilities',
    rootType: 'Liability',
    accountType: 'Current Liability',
    parentId: 'acc-liab',
    isGroup: true,
    balance: 0,
  },
  {
    id: 'acc-ap',
    name: 'Accounts Payable (Creditors)',
    rootType: 'Liability',
    accountType: 'Payable',
    parentId: 'acc-curr-liab',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-vat',
    name: 'SARS VAT Output Payable',
    rootType: 'Liability',
    accountType: 'Tax',
    parentId: 'acc-curr-liab',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-payroll-liab',
    name: 'Payroll & PAYE / UIF Liabilities',
    rootType: 'Liability',
    accountType: 'Current Liability',
    parentId: 'acc-curr-liab',
    isGroup: false,
    balance: 0,
  },

  // EQUITY
  {
    id: 'acc-equity',
    name: 'Equity & Reserves',
    rootType: 'Equity',
    accountType: 'Equity',
    parentId: null,
    isGroup: true,
    balance: 0,
  },
  {
    id: 'acc-retained',
    name: 'Retained Earnings',
    rootType: 'Equity',
    accountType: 'Equity',
    parentId: 'acc-equity',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-capital',
    name: 'Share Capital',
    rootType: 'Equity',
    accountType: 'Equity',
    parentId: 'acc-equity',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-owner-equity',
    name: "Owner's Drawings & Equity",
    rootType: 'Equity',
    accountType: 'Equity',
    parentId: 'acc-equity',
    isGroup: false,
    balance: 0,
  },

  // INCOME
  {
    id: 'acc-income',
    name: 'Income',
    rootType: 'Income',
    accountType: 'Direct Income',
    parentId: null,
    isGroup: true,
    balance: 0,
  },
  {
    id: 'acc-sales',
    name: 'Tender & Commercial Contracting Sales',
    rootType: 'Income',
    accountType: 'Direct Income',
    parentId: 'acc-income',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-consult',
    name: 'Professional Advisory Fees',
    rootType: 'Income',
    accountType: 'Direct Income',
    parentId: 'acc-income',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-interest-income',
    name: 'Interest & Investment Income',
    rootType: 'Income',
    accountType: 'Indirect Income',
    parentId: 'acc-income',
    isGroup: false,
    balance: 0,
  },

  // EXPENSES
  {
    id: 'acc-expense',
    name: 'Expenses',
    rootType: 'Expense',
    accountType: 'Direct Expense',
    parentId: null,
    isGroup: true,
    balance: 0,
  },
  {
    id: 'acc-materials',
    name: 'Direct Project Materials & Subcontractors',
    rootType: 'Expense',
    accountType: 'Direct Expense',
    parentId: 'acc-expense',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-salaries',
    name: 'Salaries & Wages',
    rootType: 'Expense',
    accountType: 'Indirect Expense',
    parentId: 'acc-expense',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-rent',
    name: 'Office Rent & Facilities',
    rootType: 'Expense',
    accountType: 'Indirect Expense',
    parentId: 'acc-expense',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-utilities',
    name: 'Water & Electricity Utilities',
    rootType: 'Expense',
    accountType: 'Indirect Expense',
    parentId: 'acc-expense',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-travel',
    name: 'Site Travel & Logistics',
    rootType: 'Expense',
    accountType: 'Indirect Expense',
    parentId: 'acc-expense',
    isGroup: false,
    balance: 0,
  },
  {
    id: 'acc-deprec',
    name: 'Depreciation & Amortization',
    rootType: 'Expense',
    accountType: 'Indirect Expense',
    parentId: 'acc-expense',
    isGroup: false,
    balance: 0,
  },
]

/** Chart of accounts with every balance zeroed (fresh ledger / setup). */
export const EMPTY_ACCOUNTS: Account[] = CORE_ACCOUNTS.map((a) => ({ ...a, balance: 0 }))
