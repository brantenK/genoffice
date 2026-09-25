/** Shared fixtures for the Books end-to-end journeys. */

import { DEFAULT_BOOK_SETTINGS, EMPTY_ACCOUNTS } from '../../src/shared/chart'
import type { BooksData, CompanySettings } from '../../src/shared/types'

export const BOOKS_SCHEMA_VERSION = 1

/** The envelope the first-run setup wizard saves: core chart, no activity. */
export function emptyLedger(settings: Partial<CompanySettings> = {}): BooksData {
  return {
    version: BOOKS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    settings: {
      ...DEFAULT_BOOK_SETTINGS,
      companyName: 'Branten Solutions (Pty) Ltd',
      taxNumber: '9123456789',
      financialYearStart: '2026-03-01',
      ...settings,
    },
    accounts: EMPTY_ACCOUNTS.map((account) => ({ ...account })),
    parties: [],
    invoices: [],
    journalEntries: [],
    bankTransactions: [],
    payments: [],
    auditLog: [],
  }
}

/** FNB: BOM, metadata preamble, one signed amount column, closing-balance row. */
export const FNB_STATEMENT_CSV = `\uFEFFFNB First National Bank
Account Number,62012345678
Statement Period,2026-08-01 to 2026-08-31
Date,Description,Amount,Balance,Reference
2026-08-03,EFT PAYMENT DEBICHECK,-1250.00,48750.00,REF10001
2026-08-05,DEPOSIT MOBILE CHEQUE,23000.00,71750.00,INV-2026-001
2026-08-12,CARD PURCHASE FUEL,-845.50,70904.50,REF10002
Closing Balance,70904.50`

/** Net movement of FNB_STATEMENT_CSV: -1250.00 + 23000.00 - 845.50. */
export const FNB_STATEMENT_NET = 20904.5

/** Standard Bank: separate Debit/Credit columns and a trailing balance column. */
export const STANDARD_BANK_STATEMENT_CSV = `Standard Bank of South Africa
Statement Number,STB-2026-08
Account: 0123456789
Transaction Date,Details,Debit,Credit,Balance
2026-08-04,POS PURCHASE WOOLWORTHS,450.00,,12450.00
2026-08-06,RFB CREDIT TRANSFER,,5000.00,17450.00
2026-08-15,STOP ORDER DEBIT,1200.00,,16250.00`

/** Net movement of STANDARD_BANK_STATEMENT_CSV: -450.00 + 5000.00 - 1200.00. */
export const STANDARD_BANK_STATEMENT_NET = 3350

/** Nedbank: quoted South African decimal-comma and space-thousands amounts. */
export const NEDBANK_STATEMENT_CSV = `Nedbank
Date,Description,Debit,Credit
2026/08/07,CARD PURCHASE TAKEAWAY,"1 250,50",
2026/08/09,DEPOSIT CASH,,"12 000,00"
2026/08/20,BANK CHARGES,"95,00",`

/** Net movement of NEDBANK_STATEMENT_CSV: -1250.50 + 12000.00 - 95.00. */
export const NEDBANK_STATEMENT_NET = 10654.5

/** Absa: signed single amount column with ISO-slash dates. */
export const ABSA_STATEMENT_CSV = `Absa Bank Limited
Account Number,4055123456
Date,Narrative,Amount,Balance
2026/08/11,ATM CASH WITHDRAWAL,-2000.00,8500.00
2026/08/18,CLIENT PAYMENT RECEIVED,15000.00,23500.00`

/** Net movement of ABSA_STATEMENT_CSV: -2000.00 + 15000.00. */
export const ABSA_STATEMENT_NET = 13000

/** A single FNB deposit that settles a 23000.00 sales invoice exactly. */
export const FNB_SETTLEMENT_CSV = `FNB First National Bank
Date,Description,Amount,Balance,Reference
2026-08-05,DEPOSIT MOBILE CHEQUE,23000.00,71750.00,INV-2026-001`

/** Net movement of FNB_SETTLEMENT_CSV. */
export const FNB_SETTLEMENT_NET = 23000

/** A deposit that matches an invoice amount exactly plus a smaller partial payment. */
export const FNB_PARTIAL_STATEMENT_CSV = `FNB First National Bank
Date,Description,Amount,Balance,Reference
2026-08-05,DEPOSIT MOBILE CHEQUE,23000.00,71750.00,INV-2026-001
2026-08-07,PARTIAL PAYMENT RECEIVED,5000.00,76750.00,INV-2026-001`
