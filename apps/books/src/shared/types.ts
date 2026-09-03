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

export interface BooksData {
  version?: number
  updatedAt?: string
  settings: CompanySettings
  accounts: Account[]
  parties: Party[]
  invoices: Invoice[]
  journalEntries: JournalEntry[]
  bankTransactions?: BankTransaction[]
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
}

export type BooksNavigationTab =
  | 'dashboard'
  | 'banking'
  | 'invoices'
  | 'purchases'
  | 'parties'
  | 'accounts'
  | 'journal'
  | 'reports'
  | 'settings'

export type ReportType = 'profit-loss' | 'balance-sheet' | 'general-ledger' | 'trial-balance'

