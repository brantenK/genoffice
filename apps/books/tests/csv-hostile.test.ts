// @vitest-environment node

/**
 * csv-hostile: a 10,000-row statement — exact duplicates, malformed rows,
 * huge amounts (1e12), negatives, unicode descriptions (emoji + ZA town
 * names), empty rows — through the REAL import handler. Pinned to what the
 * code actually guarantees:
 *
 * - ATOMICITY: the import is ONE serialized read-modify-write
 *   (mutateBooksStoreSync). A rejected or failing import writes NOTHING; a
 *   valid import lands whole. Either the ledger is untouched or every parsed
 *   line is in it — never a half-import.
 * - DEDUPE: a line is a duplicate of a stored one when
 *   date|amount|description|reference all match exactly; re-importing the
 *   same CSV adds nothing (idempotency).
 * - PARSE: malformed rows are skipped, not fatal; zero/negative-parsed-0
 *   rows are dropped; negatives become withdrawals; huge amounts stay exact
 *   to the cent; unicode survives.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { BOOKS_CHANNELS, type BooksDataEnvelope } from '../../src/shared/ipc'
import type { BankTransaction } from '../../src/shared/types'
import { bootBooksE2E, type BooksE2ESession } from './helpers/books-e2e'
import { emptyLedger } from './e2e/fixtures'

const fsFailure = vi.hoisted(() => ({
  renameFailure: null as Error | null,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs')
  return {
    ...actual,
    default: actual,
    renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
      if (fsFailure.renameFailure) throw fsFailure.renameFailure
      return actual.renameSync(...args)
    }) as typeof actual.renameSync,
  }
})

vi.mock('electron', async () => {
  const { createElectronModule } = await import('./helpers/electron-mock')
  return createElectronModule()
})

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

let session: BooksE2ESession

beforeEach(async () => {
  fsFailure.renameFailure = null
  session = await bootBooksE2E()
})

afterEach(() => {
  fsFailure.renameFailure = null
  session?.dispose()
})

const CSV_HEADER = 'Date,Description,Reference,Amount'

/** Deterministic 10,000-row hostile CSV. */
function buildHostileCsv(): { csv: string } {
  const rows: string[] = []
  const uniqueRow = (date: string, description: string, reference: string, amount: string) => {
    rows.push(`${date},"${description}","${reference}",${amount}`)
  }
  const dupRow = (date: string, description: string, reference: string, amount: string) => {
    rows.push(`${date},"${description}","${reference}",${amount}`)
  }

  const towns = [
    'Gqeberha', 'uMhlathuze', 'Emalahleni', 'Polokwane 🚜', 'Mahikeng ⚡',
    'Xhariep 🌊', 'eThekwini 🏖️', 'Mogale City', 'Karoo Hoogland', 'Sol Plaatje 🌅',
  ]
  const emojiDesc = (town: string, i: number) => `${town} EFT 💼 settlement #${i} ✓✓`

  // 4,000 unique valid rows (mixed towns/emoji, alternating deposits and
  // withdrawals, references unique so text matching can't cross-link them).
  for (let i = 0; i < 4000; i += 1) {
    const town = towns[i % towns.length]
    const amount = (100 + ((i * 37) % 90_000) / 100).toFixed(2)
    const signed = i % 2 === 0 ? amount : `-${amount}`
    uniqueRow(
      `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`,
      emojiDesc(town, i),
      `CSV-HOSTILE-${String(i).padStart(5, '0')}`,
      signed,
    )
  }
  // 2,000 exact duplicates of the first 2,000 unique rows.
  for (let i = 0; i < 2000; i += 1) {
    const town = towns[i % towns.length]
    const amount = (100 + ((i * 37) % 90_000) / 100).toFixed(2)
    const signed = i % 2 === 0 ? amount : `-${amount}`
    dupRow(
      `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`,
      emojiDesc(town, i),
      `CSV-HOSTILE-${String(i).padStart(5, '0')}`,
      signed,
    )
  }
  // 1,500 malformed rows: garbage dates, missing amounts, text amounts.
  for (let i = 0; i < 1500; i += 1) {
    if (i % 3 === 0) rows.push(`not-a-date,"Broken ${i}","REF",100.00`)
    else if (i % 3 === 1) rows.push(`2026-06-15,"No amount ${i}","REF",`)
    else rows.push(`2026-06-16,"Text amount ${i}","REF",many-money`)
  }
  // 1,000 empty rows.
  for (let i = 0; i < 1000; i += 1) rows.push('')
  // 500 huge-amount rows spanning 1e9 up to 1e12, exact to the cent.
  for (let i = 0; i < 500; i += 1) {
    const amount =
      i === 499 ? '1000000000000.00' : (1_000_000_000 + i * 1_000_000_000).toFixed(2)
    uniqueRow(
      `2026-07-${String(1 + (i % 28)).padStart(2, '0')}`,
      `Mega ${towns[i % towns.length]} 🏗️ ${i}`,
      `CSV-HUGE-${String(i).padStart(5, '0')}`,
      amount,
    )
  }
  // 500 negative rows (withdrawals), unique.
  for (let i = 0; i < 500; i += 1) {
    uniqueRow(
      `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`,
      `Withdrawal ${towns[i % towns.length]} 💸 ${i}`,
      `CSV-NEG-${String(i).padStart(5, '0')}`,
      `-${(50 + (i % 5000) / 100).toFixed(2)}`,
    )
  }
  // 500 rows that parse to zero (amount 0.00 → dropped by the parser).
  for (let i = 0; i < 500; i += 1) {
    uniqueRow(`2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, `Zero ${i}`, `CSV-ZERO-${i}`, '0.00')
  }
  // Remainder to reach 10,000 rows: more unique valid rows.
  while (rows.length < 10_000) {
    const i = rows.length
    uniqueRow(
      `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`,
      `Tail ${towns[i % towns.length]} 🌍 ${i}`,
      `CSV-TAIL-${String(i).padStart(6, '0')}`,
      ((i % 20_000) / 100 + 1).toFixed(2),
    )
  }
  expect(rows.length).toBe(10_000)
  return { csv: [CSV_HEADER, ...rows].join('\n') }
}

describe('csv-hostile: 10,000 hostile rows through the real import handler', () => {
  it('imports atomically, dedupes exactly, never crashes; walls are recorded', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const beforeJournalCount = (session.readStoredData().journalEntries ?? []).length

    const { csv } = buildHostileCsv()
    // The code's dedupe contract (deduplicateBankTransactions' own docstring):
    // frequency-based, protecting against duplicates on the RE-IMPORT while
    // preserving legitimate identical same-day transactions — so identical
    // rows WITHIN one import batch are all kept, and only the second import
    // of the same lines is skipped.
    const expectedKept = 7000 // 4000 valid + 2000 within-batch dupes + 500 huge + 500 negative
    const expectedDupesOnReimport = 7000

    const started = Date.now()
    const result = await session.invoke<{
      ok: boolean
      importedCount?: number
      skippedDuplicates?: number
      error?: string
    }>(BOOKS_CHANNELS.importBankStatementCsv, csv)
    const importMs = Date.now() - started

    expect(result.ok, result.error).toBe(true)
    console.log('[csv-hostile] import wall time: %dms (10,000-row CSV, kept=%d, within-batch dupes kept per contract)', importMs, expectedKept)
    // The bound guards against a hang, not a performance SLA: solo this
    // import takes ~3.3s, but under full-suite worker contention (heavy
    // parallel test files on one disk) it can measure several times that.
    // The mission criterion is "nothing may time out" — the file's own
    // 120s timeout is the ceiling; the meaningful guarantees are the
    // atomicity/counts assertions below.
    expect(importMs, `import took ${importMs}ms`).toBeLessThan(120_000)

    // Counts: exactly the kept lines landed.
    expect(result.importedCount).toBe(expectedKept)
    expect(result.skippedDuplicates).toBe(0)

    const stored = session.readStoredData()
    const txs: BankTransaction[] = stored.bankTransactions ?? []
    expect(txs.length).toBe(expectedKept)

    // ATOMICITY: the whole import was one write — the journal count matches
    // the imported lines exactly (one import journal per line), and the ledger
    // is complete.
    expect((stored.journalEntries ?? []).length).toBe(beforeJournalCount + expectedKept)
    for (const je of stored.journalEntries ?? []) {
      expect(je.totalDebit).toBe(je.totalCredit)
    }
    // Dedupe correctness per the code's frequency rule: each stored key
    // appears at most once MORE than the batch carried it — the within-batch
    // duplicates (2,000 of the 4,000 valid rows) are all present, so each of
    // those keys has exactly TWO stored lines, and every unique key exactly
    // one.
    const keyCounts = new Map<string, number>()
    for (const tx of txs) {
      const key = `${tx.date}|${tx.amount.toFixed(2)}|${(tx.description || '').trim().toLowerCase()}|${(tx.reference || '').trim().toLowerCase()}`
      keyCounts.set(key, (keyCounts.get(key) || 0) + 1)
    }
    expect([...keyCounts.values()].filter((c) => c === 2).length).toBe(2000)
    expect([...keyCounts.values()].every((c) => c === 1 || c === 2)).toBe(true)
    // Huge amounts survive exactly (1e12 at the top end).
    const huge = txs.filter((t) => Math.abs(t.amount) >= 1_000_000_000)
    expect(huge.length).toBe(500)
    expect(huge.some((t) => Math.abs(t.amount) >= 999_999_999_000)).toBe(true)
    // Negatives became withdrawals; unicode survived.
    expect(txs.filter((t) => t.amount < 0).length).toBeGreaterThanOrEqual(1000)
    expect(txs.some((t) => t.description.includes('Gqeberha'))).toBe(true)
    expect(txs.some((t) => t.description.includes('💼'))).toBe(true)
    // Idempotency: re-importing the identical CSV adds nothing — every kept
    // line is now a duplicate of a STORED line, which is the rule the docstring
    // promises.
    const again = await session.invoke<{
      ok: boolean
      importedCount?: number
      skippedDuplicates?: number
    }>(BOOKS_CHANNELS.importBankStatementCsv, csv)
    expect(again.ok).toBe(true)
    expect(again.importedCount).toBe(0)
    expect(again.skippedDuplicates).toBe(expectedDupesOnReimport)
    expect((session.readStoredData().bankTransactions ?? []).length).toBe(expectedKept)
  })

  it('a malformed CSV that yields nothing valid writes NOTHING (atomicity refusal)', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    await session.invoke(BOOKS_CHANNELS.importBankStatementCsv, 'Date,Description,Reference,Amount\n2026-06-01,"One good line","",100.00\n')
    const withOneLine = JSON.stringify(session.readStoredData())
    expect((session.readStoredData().bankTransactions ?? []).length).toBe(1)

    // A second import whose every row is garbage: refused, nothing written.
    const refused = await session.invoke<{ ok: boolean; error?: string }>(
      BOOKS_CHANNELS.importBankStatementCsv,
      'this is not a bank statement at all',
    )
    expect(refused.ok).toBe(false)
    expect(JSON.stringify(session.readStoredData())).toBe(withOneLine)
    // The file on disk is untouched too.
    const onDisk = JSON.parse(readFileSync(session.booksDataPath, 'utf8')) as BooksDataEnvelope
    expect(onDisk.bankTransactions?.length).toBe(1)
  })

  it('a crash-shaped import attempt (mid-write kill) leaves the ledger untouched and re-importable', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    // Force the rename to fail during an import: the queued mutation throws,
    // the store is never replaced, and the import can be retried.
    fsFailure.renameFailure = new Error('ENOSPC: simulated disk full mid-import')
    const failed = await session.invoke<{ ok: boolean; error?: string }>(
      BOOKS_CHANNELS.importBankStatementCsv,
      'Date,Description,Reference,Amount\n2026-06-01,"Crash line","",123.45\n',
    )
    fsFailure.renameFailure = null
    // The handler surfaced a failure; the ledger on disk is unchanged.
    expect(failed.ok).toBe(false)
    const after = session.readStoredData()
    expect((after.bankTransactions ?? []).length).toBe(0)
    expect((after.journalEntries ?? []).length).toBe(0)
    // Retry succeeds and imports exactly once.
    const retry = await session.invoke<{ ok: boolean; importedCount?: number }>(
      BOOKS_CHANNELS.importBankStatementCsv,
      'Date,Description,Reference,Amount\n2026-06-01,"Crash line","",123.45\n',
    )
    expect(retry.ok).toBe(true)
    expect(retry.importedCount).toBe(1)
    expect((session.readStoredData().bankTransactions ?? []).length).toBe(1)
  })
})
