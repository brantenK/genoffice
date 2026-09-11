export type AccountRoot = 'Asset' | 'Liability' | 'Equity' | 'Income' | 'Expense'

export type AccountType =
  | 'Bank'
  | 'Cash'
  | 'Receivable'
  | 'Payable'
  | 'Tax'
  | 'Direct Income'
  | 'Indirect Income'
  | 'Direct Expense'
  | 'Indirect Expense'
  | 'Fixed Asset'
  | 'Current Asset'
  | 'Current Liability'
  | 'Equity'

export interface Account {
  id: string
  name: string
  rootType: AccountRoot
  accountType: AccountType
  parentId: string | null
  isGroup: boolean
  balance: number
}

export type PartyType = 'Customer' | 'Supplier'

export interface Party {
  id: string
  name: string
  type: PartyType
  email?: string
  phone?: string
  taxId?: string
  address?: string
  outstandingBalance: number
}

export interface InvoiceItem {
  id: string
  itemCode: string
  description: string
  accountId: string
  accountName: string
  qty: number
  rate: number
  taxRate: number // e.g., 15 for 15% VAT
  amount: number
  /** Percentage discount applied to this line BEFORE tax (0–100). */
  discountRate?: number
}

export type InvoiceStatus = 'Draft' | 'Unpaid' | 'Paid' | 'Overdue' | 'Cancelled'
export type InvoiceType = 'Sales' | 'Purchase'

export interface Invoice {
  id: string
  invoiceNumber: string
  type: InvoiceType
  partyId: string
  partyName: string
  date: string
  dueDate: string
  items: InvoiceItem[]
  subtotal: number
  taxTotal: number
  grandTotal: number
  outstandingAmount: number
  status: InvoiceStatus
  notes?: string
  tenderReference?: string
  crmDealId?: string
  /** True for a credit note: reverses a previously posted invoice. */
  creditNote?: boolean
  /** For credit notes: the id of the invoice being credited. */
  creditedInvoiceId?: string
  /** Invoice-level discount (VAT-exclusive), applied before tax. */
  discountTotal?: number
  /** Round-off adjustment so grandTotal lands on a round number. */
  roundOff?: number
  createdAt: string
  updatedAt: string
}

export interface JournalEntryItem {
  id: string
  accountId: string
  accountName: string
  partyId?: string
  partyName?: string
  debit: number
  credit: number
  remark?: string
}

export interface JournalEntry {
  id: string
  entryNumber: string
  date: string
  items: JournalEntryItem[]
  totalDebit: number
  totalCredit: number
  remarks?: string
  posted: boolean
}

export interface CompanySettings {
  companyName: string
  taxNumber: string
  currency: string
  currencySymbol: string
  financialYearStart: string
  address: string
  email: string
  phone: string
  /** Default VAT rate (%) applied to new invoice lines. */
  defaultTaxRate?: number
  /** When true, line rates entered are VAT-inclusive. */
  taxInclusive?: boolean
  /** Last closed financial-period end date (YYYY-MM-DD). Dates at or before
   * this are locked: no new or edited invoices may post into them. */
  closedThrough?: string
}

/** A recorded payment's exact coverage of a bank-statement line. */
export interface BankPaymentLink {
  paymentId: string
  amount: number
  invoiceId?: string
}

export interface BankTransaction {
  id: string
  accountId: string // 'acc-bank'
  date: string // YYYY-MM-DD
  description: string
  reference?: string
  amount: number // positive = deposit, negative = withdrawal
  reconciled: boolean
  matchedInvoiceId?: string
  reconciledAt?: string
  /** Payment allocations that cover all or part of this statement line. */
  paymentLinks?: BankPaymentLink[]
}

export interface SettlementSuggestion {
  transactionId: string
  invoiceId: string
  invoiceNumber: string
  partyName: string
  invoiceType: 'Sales' | 'Purchase'
  amount: number
  confidence: 'HIGH' | 'MEDIUM'
  reason: string
}

/** A payment allocation against a specific invoice. */
export interface PaymentAllocation {
  invoiceId: string
  invoiceNumber: string
  amount: number
}

/** A recorded payment: money received from a customer, paid to a supplier, or a customer refund. */
export interface Payment {
  id: string
  partyId: string
  partyName: string
  date: string
  type: 'received' | 'paid' | 'refund'
  method?: string
  reference?: string
  allocations: PaymentAllocation[]
  total: number
  createdAt: string
}

/** An immutable audit-log entry recording a ledger mutation. */
export interface AuditEntry {
  id: string
  timestamp: string
  action: string
  summary: string
  actor?: string
  invoiceNumber?: string
  paymentId?: string
  amount?: number
}

export interface BooksData {
  version?: number
  updatedAt?: string
  settings: CompanySettings
  accounts: Account[]
  parties: Party[]
  invoices: Invoice[]
  journalEntries: JournalEntry[]
  bankTransactions?: BankTransaction[]
  payments?: Payment[]
  auditLog?: AuditEntry[]
}

export interface BooksDataEnvelope {
  version: number
  updatedAt: string
  settings: CompanySettings
  accounts: Account[]
  parties: Party[]
  invoices: Invoice[]
  journalEntries: JournalEntry[]
  bankTransactions?: BankTransaction[]
  payments?: Payment[]
  auditLog?: AuditEntry[]
}

export type BooksNavigationTab =
  | 'dashboard'
  | 'banking'
  | 'payments'
  | 'invoices'
  | 'purchases'
  | 'parties'
  | 'accounts'
  | 'journal'
  | 'reports'
  | 'audit'
  | 'settings'

export type ReportType = 'profit-loss' | 'balance-sheet' | 'general-ledger' | 'trial-balance'
