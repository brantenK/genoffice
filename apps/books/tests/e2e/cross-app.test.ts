// @vitest-environment node

import { readFileSync, rmSync } from 'node:fs'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { BOOKS_CHANNELS } from '../../src/shared/ipc'
import { bootBooksE2E, type BooksE2ESession } from '../helpers/books-e2e'
import { emptyLedger } from './fixtures'

vi.mock('electron', async () => {
  const { createElectronModule } = await import('../helpers/electron-mock')
  return createElectronModule()
})

// Booting the real module re-imports its whole graph; the shared runner is
// slow under parallel load, so these journeys get more room than the unit suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

interface FileResult {
  ok: boolean
  path?: string
  error?: string
}

describe('Books e2e: cross-app exports', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  it('writes a spreadsheet export to disk and reports it to the runtime', async () => {
    const csv = 'Account,Debit,Credit\nacc-bank,23000.00,0.00'
    const result = await session.invoke<FileResult>(
      BOOKS_CHANNELS.exportToSheets,
      'Trial Balance / 2026',
      csv,
    )
    expect(result.ok).toBe(true)
    expect(result.path).toMatch(/Trial_Balance___2026_\d+\.csv$/)
    expect(readFileSync(result.path!, 'utf8')).toBe(csv)
    expect(session.openedPaths()).toEqual([result.path])
    rmSync(result.path!, { force: true })
  })

  it('renders a real invoice PDF from the stored company settings', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Bulk water pipeline maintenance',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)

    const result = await session.invoke<FileResult>(
      BOOKS_CHANNELS.openInPdf,
      issued.invoice,
      'Unused Fallback Name',
    )
    expect(result.ok).toBe(true)
    expect(result.path).toMatch(/Tax_Invoice_INV-2026-001\.pdf$/)

    const bytes = readFileSync(result.path!)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(1000)
    expect(session.openedPaths()).toContain(result.path!)
    rmSync(result.path!, { force: true })
  })

  it('reports the cross-app open handlers as unconfigured', async () => {
    expect(await session.invoke(BOOKS_CHANNELS.openInCrm)).toBe(false)
    expect(await session.invoke(BOOKS_CHANNELS.openInTenders)).toBe(false)
  })
})
