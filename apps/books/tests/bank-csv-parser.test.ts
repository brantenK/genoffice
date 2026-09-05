import { describe, it, expect } from 'vitest'
import {
  parseBankAmount,
  normalizeDate,
  splitCsvRow,
  parseBankStatementCsv,
  deduplicateBankTransactions,
} from '../src/shared/accounting'
import type { BankTransaction } from '../src/shared/types'

describe('F19 Bank CSV Statement Parser & Deduplication Suite', () => {
  describe('parseBankAmount Financial Cleaning', () => {
    it('handles standard South African Rand tokens (R, ZAR, $) and commas', () => {
      expect(parseBankAmount('R 1,250.50')).toBe(1250.50)
      expect(parseBankAmount('ZAR 45,000.00')).toBe(45000)
      expect(parseBankAmount('$500.25')).toBe(500.25)
      expect(parseBankAmount('R123.45')).toBe(123.45)
    })

    it('handles parenthetical negatives (1,250.00) -> -1250.00', () => {
      expect(parseBankAmount('(1,250.00)')).toBe(-1250.00)
      expect(parseBankAmount('(R 450.75)')).toBe(-450.75)
      expect(parseBankAmount('(350,00)')).toBe(-350.00)
    })

    it('handles trailing minus signs and accounting DR/CR suffixes', () => {
      expect(parseBankAmount('1250.00-')).toBe(-1250.00)
      expect(parseBankAmount('500.00DR')).toBe(-500.00)
      expect(parseBankAmount('500.00CR')).toBe(500.00)
      expect(parseBankAmount('1250.00 dr')).toBe(-1250.00)
    })

    it('handles South African decimal commas and spaces as thousands separators', () => {
      // SABS / South African decimal comma: 1250,50 -> 1250.50
      expect(parseBankAmount('1250,50')).toBe(1250.50)
      expect(parseBankAmount('1 250,50')).toBe(1250.50)
      expect(parseBankAmount('1 250.50')).toBe(1250.50)
      expect(parseBankAmount('1.250,50')).toBe(1250.50)
      expect(parseBankAmount('12,345,678.90')).toBe(12345678.90)
    })

    it('handles null, undefined, empty, and invalid strings gracefully', () => {
      expect(parseBankAmount(null)).toBe(0)
      expect(parseBankAmount(undefined)).toBe(0)
      expect(parseBankAmount('')).toBe(0)
      expect(parseBankAmount('   ')).toBe(0)
      expect(parseBankAmount('N/A')).toBe(0)
    })
  })

  describe('normalizeDate Format Normalization', () => {
    it('normalizes various date patterns to ISO YYYY-MM-DD', () => {
      expect(normalizeDate('2026-09-05')).toBe('2026-09-05')
      expect(normalizeDate('2026/09/05')).toBe('2026-09-05')
      expect(normalizeDate('05/09/2026')).toBe('2026-09-05')
      expect(normalizeDate('05-09-2026')).toBe('2026-09-05')
      expect(normalizeDate('20260905')).toBe('2026-09-05')
    })
  })

  describe('South African Bank Formats Parsing', () => {
    it('parses FNB CSV format with signed amounts, R tokens, and parenthetical fees', () => {
      const fnbCsv = `Date,Amount,Description,Reference
2026-09-01,"R 25,000.00","Cust Settlement Transnet","INV-2026-001"
2026-09-02,"(1,250.00)","Monthly Account Fee","FNB-FEE-01"
2026-09-03,"-3,500.00","Site Hardware Purchase","CARD-9918"`

      const txs = parseBankStatementCsv(fnbCsv)
      expect(txs).toHaveLength(3)

      expect(txs[0].date).toBe('2026-09-01')
      expect(txs[0].amount).toBe(25000.00)
      expect(txs[0].description).toBe('Cust Settlement Transnet')
      expect(txs[0].reference).toBe('INV-2026-001')
      expect(txs[0].accountId).toBe('acc-bank')

      expect(txs[1].date).toBe('2026-09-02')
      expect(txs[1].amount).toBe(-1250.00)
      expect(txs[1].description).toBe('Monthly Account Fee')

      expect(txs[2].date).toBe('2026-09-03')
      expect(txs[2].amount).toBe(-3500.00)
    })

    it('parses Standard Bank CSV format with separate Debit and Credit columns', () => {
      const stdBankCsv = `Date,Description,Reference,Debit,Credit
2026-09-01,Supplier Payment Fasteners,PB-001,45000.00,
2026-09-02,Client Milestone Payment,INV-002,,115000.00
2026-09-03,Fuel Fill-up,PETROL,-850.50,`

      const txs = parseBankStatementCsv(stdBankCsv)
      expect(txs).toHaveLength(3)

      // Debit column is negative
      expect(txs[0].amount).toBe(-45000.00)
      expect(txs[0].description).toBe('Supplier Payment Fasteners')
      expect(txs[0].reference).toBe('PB-001')

      // Credit column is positive
      expect(txs[1].amount).toBe(115000.00)
      expect(txs[1].description).toBe('Client Milestone Payment')

      // Debit column with negative sign is still negative (not double inverted)
      expect(txs[2].amount).toBe(-850.50)
    })

    it('parses Nedbank format by dynamically skipping introductory account metadata headers', () => {
      const nedbankCsv = `"Account Name:","Zano Consulting & Engineering"
"Account Number:","1987263541"
"Branch Code:","198765"
"Statement Period:","01/09/2026 to 30/09/2026"
Date,Transaction Description,Reference Number,Amount
2026/09/05,EFT From Customer Alpha,INV-NED-01,34500.00
2026/09/06,Fibre Internet Monthly,FIBRE-01,-1499.00
Total Turnover: 33001.00`

      const txs = parseBankStatementCsv(nedbankCsv)
      expect(txs).toHaveLength(2)

      expect(txs[0].date).toBe('2026-09-05')
      expect(txs[0].description).toBe('EFT From Customer Alpha')
      expect(txs[0].reference).toBe('INV-NED-01')
      expect(txs[0].amount).toBe(34500.00)

      expect(txs[1].date).toBe('2026-09-06')
      expect(txs[1].amount).toBe(-1499.00)
    })

    it('parses Absa format with UTF-8 BOM, metadata header, and decimal comma numbers', () => {
      const absaCsv = `\uFEFF"Absa Corporate Cheque Account"
"Account:","40-8912-3456"
Date,Particulars,Reference,Transaction Amount
2026-09-08,Customer Progress Payment,INV-ABSA-01,"1 250,50"
2026-09-09,Courier Delivery Waybill,WAYBILL-99,"(350,00)"`

      const txs = parseBankStatementCsv(absaCsv)
      expect(txs).toHaveLength(2)

      expect(txs[0].date).toBe('2026-09-08')
      expect(txs[0].amount).toBe(1250.50)
      expect(txs[0].description).toBe('Customer Progress Payment')
      expect(txs[0].reference).toBe('INV-ABSA-01')

      expect(txs[1].date).toBe('2026-09-09')
      expect(txs[1].amount).toBe(-350.00)
    })

    it('returns empty array when CSV text is empty or has no transaction lines', () => {
      expect(parseBankStatementCsv('')).toEqual([])
      expect(parseBankStatementCsv('Just some random text\nWithout columns')).toEqual([])
    })
  })

  describe('Resilient Frequency-Based Deduplication', () => {
    it('skips 100% of duplicates when re-importing the exact same CSV', () => {
      const csv = `Date,Amount,Description,Reference
2026-09-01,15000.00,Client Deposit,INV-001
2026-09-02,-1250.00,Bank Charge,FEE-01`

      const firstPass = parseBankStatementCsv(csv)
      const res1 = deduplicateBankTransactions(firstPass, [])
      expect(res1.toAdd).toHaveLength(2)
      expect(res1.skippedDuplicates).toBe(0)
      expect(res1.netAdjustment).toBe(13750.00)

      // Re-import with firstPass existing
      const res2 = deduplicateBankTransactions(firstPass, res1.toAdd)
      expect(res2.toAdd).toHaveLength(0)
      expect(res2.skippedDuplicates).toBe(2)
      expect(res2.netAdjustment).toBe(0)
    })

    it('preserves legitimate identical same-day charges and avoids duplicates on re-import', () => {
      // Two identical R45 charges on same date
      const incoming: BankTransaction[] = [
        { id: 'tx-1', accountId: 'acc-bank', date: '2026-09-01', description: 'ATM Cash Withdrawal Fee', reference: 'FEE', amount: -45, reconciled: false },
        { id: 'tx-2', accountId: 'acc-bank', date: '2026-09-01', description: 'ATM Cash Withdrawal Fee', reference: 'FEE', amount: -45, reconciled: false },
      ]

      // First import: both must be accepted
      const res1 = deduplicateBankTransactions(incoming, [])
      expect(res1.toAdd).toHaveLength(2)
      expect(res1.skippedDuplicates).toBe(0)
      expect(res1.netAdjustment).toBe(-90)

      // Second import with the 2 charges existing in store: must be skipped
      const res2 = deduplicateBankTransactions(incoming, res1.toAdd)
      expect(res2.toAdd).toHaveLength(0)
      expect(res2.skippedDuplicates).toBe(2)
      expect(res2.netAdjustment).toBe(0)
    })

    it('does not collide transactions with different references or descriptions', () => {
      const existing: BankTransaction[] = [
        { id: 'tx-1', accountId: 'acc-bank', date: '2026-09-01', description: 'Contractor Payment A', reference: 'REF-001', amount: -5000, reconciled: false },
      ]
      const incoming: BankTransaction[] = [
        { id: 'tx-2', accountId: 'acc-bank', date: '2026-09-01', description: 'Contractor Payment B', reference: 'REF-002', amount: -5000, reconciled: false },
      ]

      const res = deduplicateBankTransactions(incoming, existing)
      expect(res.toAdd).toHaveLength(1)
      expect(res.skippedDuplicates).toBe(0)
      expect(res.toAdd[0].reference).toBe('REF-002')
    })
  })
})
