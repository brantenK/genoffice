import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  writeBooksStore,
  readBooksStore,
  migrateAndValidateBooks,
  CORE_ACCOUNTS,
  CURRENT_BOOKS_SCHEMA_VERSION,
  DEFAULT_BOOK_SETTINGS,
} from '../src/main/books-main'
import type { BooksDataEnvelope, Account } from '../src/shared/types'

describe('F20 & F3 Chart of Accounts Harmonization & Resilient Persistence Suite', () => {
  let testDir: string
  let booksFilePath: string

  beforeEach(() => {
    testDir = join(tmpdir(), `books-persist-test-${randomUUID().slice(0, 8)}`)
    mkdirSync(testDir, { recursive: true })
    booksFilePath = join(testDir, 'books-data.json')
  })

  afterEach(() => {
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    } catch {}
  })

  describe('Atomic Writes & File Integrity', () => {
    it('writes store atomically and leaves no orphaned .tmp files', () => {
      const data: BooksDataEnvelope = {
        version: CURRENT_BOOKS_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        settings: { ...DEFAULT_BOOK_SETTINGS },
        accounts: [...CORE_ACCOUNTS],
        parties: [
          { id: 'p1', name: 'Test Customer', type: 'Customer', outstandingBalance: 5000 },
        ],
        invoices: [],
        journalEntries: [],
        bankTransactions: [],
      }

      writeBooksStore(booksFilePath, data)

      expect(existsSync(booksFilePath)).toBe(true)

      const files = readdirSync(testDir)
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'))
      expect(tmpFiles).toHaveLength(0)

      const readBack = readBooksStore(booksFilePath)
      expect(readBack.parties).toHaveLength(1)
      expect(readBack.parties[0].name).toBe('Test Customer')
      expect(readBack.parties[0].outstandingBalance).toBe(5000)
    })

    it('creates destination directory if it does not already exist', () => {
      const nestedPath = join(testDir, 'nested', 'deep', 'books-data.json')
      writeBooksStore(nestedPath, {
        version: CURRENT_BOOKS_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        settings: { ...DEFAULT_BOOK_SETTINGS },
        accounts: [...CORE_ACCOUNTS],
        parties: [],
        invoices: [],
        journalEntries: [],
        bankTransactions: [],
      })

      expect(existsSync(nestedPath)).toBe(true)
    })
  })

  describe('Corrupt JSON Recovery & Automatic Backups', () => {
    it('backs up corrupted JSON to .corrupt-[timestamp] and .corrupted.bak and returns safe default', () => {
      const malformedJson = '{"version": 1, "accounts": [{"id": "acc-bank", "balance": 1000' // broken syntax
      writeFileSync(booksFilePath, malformedJson, 'utf8')

      // Reading should not crash
      const recovered = readBooksStore(booksFilePath)
      expect(recovered.version).toBe(CURRENT_BOOKS_SCHEMA_VERSION)
      expect(recovered.accounts.length).toBeGreaterThanOrEqual(CORE_ACCOUNTS.length)

      // Verify backup files were generated
      const files = readdirSync(testDir)
      const timestampedBak = files.find((f) => f.includes('.corrupt-'))
      const legacyBak = files.find((f) => f.endsWith('.corrupted.bak'))

      expect(timestampedBak).toBeDefined()
      expect(legacyBak).toBeDefined()

      const legacyContent = readFileSync(join(testDir, legacyBak!), 'utf8')
      expect(legacyContent).toBe(malformedJson)
    })

    it('returns default schema envelope when reading non-existent file', () => {
      const missingPath = join(testDir, 'does-not-exist.json')
      const data = readBooksStore(missingPath)
      expect(data.version).toBe(CURRENT_BOOKS_SCHEMA_VERSION)
      expect(data.accounts).toHaveLength(CORE_ACCOUNTS.length)
      expect(data.settings.companyName).toBe(DEFAULT_BOOK_SETTINGS.companyName)
    })
  })

  describe('Safe Schema Migrations & Chart of Accounts Backfilling', () => {
    it('backfills all 22 standard accounts + 8 root/group nodes if missing from legacy payload', () => {
      // Legacy store with only 2 accounts
      const legacyPayload = {
        version: 0,
        settings: { companyName: 'Legacy Company' },
        accounts: [
          { id: 'acc-bank', name: 'Old Bank Account', balance: 50000 },
          { id: 'acc-sales', name: 'Old Sales', balance: 120000 },
        ],
        parties: [],
        invoices: [],
      }

      const migrated = migrateAndValidateBooks(legacyPayload)
      expect(migrated.version).toBe(CURRENT_BOOKS_SCHEMA_VERSION)
      expect(migrated.settings.companyName).toBe('Legacy Company')

      // Preserved existing account balances
      const bankAcc = migrated.accounts.find((a) => a.id === 'acc-bank')!
      expect(bankAcc.balance).toBe(50000)

      const salesAcc = migrated.accounts.find((a) => a.id === 'acc-sales')!
      expect(salesAcc.balance).toBe(120000)

      // Verified backfilled accounts
      const coreIds = CORE_ACCOUNTS.map((a) => a.id)
      for (const id of coreIds) {
        const found = migrated.accounts.find((a) => a.id === id)
        expect(found).toBeDefined()
        expect(found?.rootType).toBeDefined()
      }

      // Root group accounts hierarchy intact
      const assetGroup = migrated.accounts.find((a) => a.id === 'acc-asset')!
      expect(assetGroup.isGroup).toBe(true)
      expect(assetGroup.parentId).toBeNull()

      const currAsset = migrated.accounts.find((a) => a.id === 'acc-curr-asset')!
      expect(currAsset.parentId).toBe('acc-asset')
    })

    it('preserves extra extension fields in bank transactions and settings', () => {
      const payloadWithExtensions = {
        version: 1,
        settings: {
          ...DEFAULT_BOOK_SETTINGS,
          customVatCertificate: 'VAT-998822',
        },
        accounts: [...CORE_ACCOUNTS],
        bankTransactions: [
          {
            id: 'tx-custom-1',
            date: '2026-09-01',
            description: 'SWIFT Transfer',
            amount: 50000,
            reconciled: false,
            swiftMt103Ref: 'SWIFT-ZA-99182',
            interbankTraceId: 'TRACE-001',
          },
        ],
      }

      const migrated = migrateAndValidateBooks(payloadWithExtensions)
      const tx = migrated.bankTransactions[0] as any
      expect(tx.swiftMt103Ref).toBe('SWIFT-ZA-99182')
      expect(tx.interbankTraceId).toBe('TRACE-001')
      expect((migrated.settings as any).customVatCertificate).toBe('VAT-998822')
    })

    it('migrates null or non-object raw inputs to safe complete envelopes', () => {
      const resNull = migrateAndValidateBooks(null)
      expect(resNull.version).toBe(CURRENT_BOOKS_SCHEMA_VERSION)
      expect(resNull.accounts.length).toBe(CORE_ACCOUNTS.length)

      const resString = migrateAndValidateBooks('corrupted string')
      expect(resString.version).toBe(CURRENT_BOOKS_SCHEMA_VERSION)
    })
  })
})
