import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const testDir = join(tmpdir(), `tenders-ipc-test-${randomUUID().slice(0, 8)}`)

const { ipcHandlers, openedPaths, mockBroadcasts } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => any>(),
  openedPaths: [] as string[],
  mockBroadcasts: [] as Array<{ channel: string; data: any }>,
}))

vi.mock('electron', () => {
  return {
    app: {
      getPath: (name: string) => {
        if (name === 'userData') return testDir
        return testDir
      },
      isReady: () => true,
    },
    ipcMain: {
      handle: (channel: string, listener: (...args: any[]) => any) => {
        ipcHandlers.set(channel, listener)
      },
    },
    shell: {
      openPath: vi.fn(async (p: string) => {
        openedPaths.push(p)
        return ''
      }),
    },
    WebContentsView: class MockWebContentsView {
      webContents = {
        isDestroyed: () => false,
        send: (channel: string, data: any) => {
          mockBroadcasts.push({ channel, data })
        },
        once: vi.fn(),
      }
    },
  }
})

import {
  broadcastTendersData,
  configureTendersRuntime,
  deleteDocumentFile,
  getActiveTendersWebContents,
  getTendersDocumentsDir,
  getTendersVaultDir,
  migrateAndValidateTenders,
  openDocumentFile,
  readDocumentFile,
  readTendersStore,
  registerTendersIpc,
  registerTendersWebContents,
  resolveSafeTendersPath,
  saveDocumentFile,
  SEED_TENDER_WTR_04,
  unregisterTendersWebContents,
  writeTendersStore,
} from '../src/main/tenders-main'
import { TENDERS_CHANNELS } from '../src/shared/ipc'
import type { TenderRecord, TendersData } from '../src/shared/types'

describe('Electron IPC Handlers & Security Validation', () => {
  beforeAll(() => {
    mkdirSync(testDir, { recursive: true })
    registerTendersIpc()
  })

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    openedPaths.length = 0
    mockBroadcasts.length = 0
  })

  afterAll(() => {
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    } catch {}
  })

  describe('1. tenders:data-changed Push Notifications & WebContents Tracking', () => {
    it('registers active WebContents and broadcasts tenders:data-changed events', () => {
      const received: any[] = []
      const fakeWc: any = {
        isDestroyed: () => false,
        send: (channel: string, data: any) => {
          if (channel === TENDERS_CHANNELS.dataChanged) received.push(data)
        },
        once: vi.fn(),
      }

      registerTendersWebContents(fakeWc)
      expect(getActiveTendersWebContents()).toContain(fakeWc)

      const testData: TendersData = migrateAndValidateTenders(null)
      broadcastTendersData(testData)

      expect(received).toHaveLength(1)
      expect(received[0].version).toBe(1)
      expect(received[0].activeCompanyId).toBe(testData.activeCompanyId)

      // Unregister
      unregisterTendersWebContents(fakeWc)
      expect(getActiveTendersWebContents()).not.toContain(fakeWc)
    })

    it('prunes destroyed WebContents automatically without throwing', () => {
      let isDead = false
      const fakeWc: any = {
        isDestroyed: () => isDead,
        send: vi.fn(),
        once: vi.fn(),
      }

      registerTendersWebContents(fakeWc)
      expect(getActiveTendersWebContents()).toContain(fakeWc)

      isDead = true
      expect(getActiveTendersWebContents()).not.toContain(fakeWc)

      const testData: TendersData = migrateAndValidateTenders(null)
      expect(() => broadcastTendersData(testData)).not.toThrow()
    })
  })

  describe('2. tenders:get-stored-data and tenders:save-stored-data Handlers', () => {
    it('getStoredData returns stored JSON from disk or null when absent', async () => {
      const getHandler = ipcHandlers.get(TENDERS_CHANNELS.getStoredData)
      expect(getHandler).toBeDefined()

      // Before file exists
      const initial = await getHandler!({ sender: null })
      expect(initial).toBeNull()

      // After writing store file
      const storeFile = join(testDir, 'tenders', 'tenders-data.json')
      const data = migrateAndValidateTenders(null)
      data.workspaces[0].company.tradingName = 'Thabo Engineering IPC Test'
      writeTendersStore(storeFile, data)

      const retrieved = await getHandler!({ sender: null })
      expect(retrieved).not.toBeNull()
      const parsed = JSON.parse(retrieved)
      expect(parsed.workspaces[0].company.tradingName).toBe('Thabo Engineering IPC Test')
    })

    it('saveStoredData persists payload atomically and broadcasts update', async () => {
      const saveHandler = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)
      expect(saveHandler).toBeDefined()

      const dataToSave = migrateAndValidateTenders(null)
      dataToSave.workspaces[0].tenders[0].estimatedValue = 999000

      const result = await saveHandler!({ sender: null }, JSON.stringify(dataToSave))
      expect(result.ok).toBe(true)

      const storeFile = join(testDir, 'tenders', 'tenders-data.json')
      expect(existsSync(storeFile)).toBe(true)
      const onDisk = readTendersStore(storeFile)
      expect(onDisk.workspaces[0].tenders[0].estimatedValue).toBe(999000)
    })
  })

  describe('3. Managed Document Storage Handlers (save, read, open, delete)', () => {
    it('saveDocumentFile persists RFP and Vault buffers with sanitized timestamped filenames', async () => {
      const rfpBuffer = Buffer.from('Mock RFP document content')
      const rfpResult = await saveDocumentFile(
        {
          fileName: '../../malicious_name.pdf',
          buffer: rfpBuffer,
          category: 'rfp',
        },
        testDir,
      )

      expect(rfpResult.ok).toBe(true)
      expect(rfpResult.storedPath).toMatch(/^documents\/\d+_malicious_name\.pdf$/)

      const vaultBuffer = Buffer.from('Mock Vault certificate content')
      const vaultResult = await saveDocumentFile(
        {
          fileName: 'tax clearance certificate.pdf',
          buffer: vaultBuffer,
          category: 'vault',
        },
        testDir,
      )

      expect(vaultResult.ok).toBe(true)
      expect(vaultResult.storedPath).toMatch(/^vault\/\d+_tax_clearance_certificate\.pdf$/)

      // Confirm files physically exist on disk
      const fullRfp = join(getTendersDocumentsDir(testDir), rfpResult.storedPath!.replace('documents/', ''))
      expect(existsSync(fullRfp)).toBe(true)
      expect(readFileSync(fullRfp, 'utf8')).toBe('Mock RFP document content')
    })

    it('readDocumentFile retrieves stored documents as valid ArrayBuffers', async () => {
      const saved = await saveDocumentFile(
        {
          fileName: 'sample.pdf',
          buffer: Buffer.from('Sample PDF binary stream'),
          category: 'rfp',
        },
        testDir,
      )

      const readResult = await readDocumentFile({ storedPath: saved.storedPath! }, testDir)
      expect(readResult.ok).toBe(true)
      expect(readResult.buffer).toBeDefined()
      expect(readResult.buffer!.byteLength).toBeGreaterThan(0)
      expect(
        readResult.buffer instanceof ArrayBuffer ||
          (readResult.buffer as any)?.constructor?.name === 'ArrayBuffer',
      ).toBe(true)

      const text = Buffer.from(readResult.buffer!).toString('utf8')
      expect(text).toBe('Sample PDF binary stream')
    })

    it('openDocumentFile delegates safely to shell.openPath', async () => {
      const saved = await saveDocumentFile(
        {
          fileName: 'open-test.pdf',
          buffer: Buffer.from('Content to open'),
          category: 'vault',
        },
        testDir,
      )

      const openResult = await openDocumentFile({ storedPath: saved.storedPath! }, testDir)
      expect(openResult.ok).toBe(true)
      expect(openedPaths.length).toBeGreaterThan(0)
      expect(openedPaths[0]).toContain('open-test.pdf')
    })

    it('deleteDocumentFile removes document from disk idempotently', async () => {
      const saved = await saveDocumentFile(
        {
          fileName: 'delete-me.pdf',
          buffer: Buffer.from('Content to delete'),
          category: 'rfp',
        },
        testDir,
      )

      const delResult1 = await deleteDocumentFile({ storedPath: saved.storedPath! }, testDir)
      expect(delResult1.ok).toBe(true)

      // Subsequent delete of already deleted file is idempotent
      const delResult2 = await deleteDocumentFile({ storedPath: saved.storedPath! }, testDir)
      expect(delResult2.ok).toBe(true)
    })
  })

  describe('4. Path Traversal Security Validation (resolveSafeTendersPath)', () => {
    it('allows legitimate relative paths strictly within documents/ and vault/', () => {
      const docsCheck = resolveSafeTendersPath('documents/1234_sample.pdf', testDir)
      expect(docsCheck.safe).toBe(true)
      expect(docsCheck.fullPath).toContain('documents')

      const vaultCheck = resolveSafeTendersPath('vault/5678_certificate.pdf', testDir)
      expect(vaultCheck.safe).toBe(true)
      expect(vaultCheck.fullPath).toContain('vault')
    })

    it('strictly prevents escaping storage directories via directory traversal tokens', () => {
      const attacks = [
        '../../etc/passwd',
        '..\\..\\Windows\\System32\\cmd.exe',
        'documents/../../../secret.txt',
        'vault/../../tenders-data.json',
        'documents/../tenders-data.json',
        'documents/..',
        'vault/..',
        '/etc/shadow',
        'C:\\Windows\\System32\\notepad.exe',
        '\\\\server\\share\\file.pdf',
      ]

      for (const attack of attacks) {
        const check = resolveSafeTendersPath(attack, testDir)
        expect(check.safe, `Expected ${attack} to be rejected`).toBe(false)
        expect(check.error).toBe('Directory traversal detected')
      }
    })

    it('strictly prevents null byte injection attacks', () => {
      const check = resolveSafeTendersPath('documents/file.pdf\0.png', testDir)
      expect(check.safe).toBe(false)
      expect(check.error).toBe('Null byte detected in path')
    })
  })

  describe('5. Cross-App Handlers: CRM, Sheets, Docs, and Books', () => {
    it('syncWithCrm synchronizes tender into CRM deal with deterministic ID and back-link', async () => {
      const syncHandler = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
      expect(syncHandler).toBeDefined()

      // Seed tenders store
      const storePath = join(testDir, 'tenders', 'tenders-data.json')
      const tendersData = migrateAndValidateTenders(null)
      writeTendersStore(storePath, tendersData)

      const tender = tendersData.workspaces[0].tenders[0]
      const crmDealsPath = join(testDir, 'crm', 'deals.json')

      const result = await syncHandler!({ sender: null }, {
        tender,
        tenderId: tender.id,
        crmDealsPath,
        tendersPath: storePath,
        userDataDir: testDir,
      })

      expect(result.ok).toBe(true)
      expect(result.dealId).toBe(`deal-tender-${tender.id}`)

      // Verify deals.json written
      expect(existsSync(crmDealsPath)).toBe(true)
      const crmEnvelope = JSON.parse(readFileSync(crmDealsPath, 'utf8'))
      const deal = crmEnvelope.deals.find((d: any) => d.id === `deal-tender-${tender.id}`)
      expect(deal).toBeDefined()
      expect(deal.tenderReference).toBe(tender.referenceNumber)
      expect(deal.amount).toBe(tender.estimatedValue)
      expect(deal.expectedCloseDate).toBe(tender.closingDate)

      // Verify tender.linkedCrmDealId was back-linked in tenders-data.json
      const updatedTenders = readTendersStore(storePath)
      const updatedTender = updatedTenders.workspaces[0].tenders[0]
      expect(updatedTender.linkedCrmDealId).toBe(`deal-tender-${tender.id}`)

      // Re-sync: should update in place without creating duplicate deals
      const resync = await syncHandler!({ sender: null }, {
        tender: { ...tender, estimatedValue: 300000 },
        tenderId: tender.id,
        crmDealsPath,
        tendersPath: storePath,
        userDataDir: testDir,
      })
      expect(resync.ok).toBe(true)
      const afterResync = JSON.parse(readFileSync(crmDealsPath, 'utf8'))
      expect(afterResync.deals.filter((d: any) => d.id === `deal-tender-${tender.id}`)).toHaveLength(1)
      expect(afterResync.deals[0].amount).toBe(300000)
    })

    it('exportMatrixToSheets outputs strict RFC 4180 unspaced comma delimiter and UTF-8 BOM', async () => {
      const exportHandler = ipcHandlers.get(TENDERS_CHANNELS.exportMatrixToSheets)
      expect(exportHandler).toBeDefined()

      const generatedPaths: string[] = []
      configureTendersRuntime({
        preloadPath: '',
        rendererFile: '',
        openGeneratedPath: (p: string) => {
          generatedPaths.push(p)
          return true
        },
      })

      const rows = [
        {
          id: 'REQ-01',
          category: 'TAX_COMPLIANCE',
          title: 'SARS Tax Clearance Certificate (PIN)',
          isMandatory: true,
          status: 'FULFILLED',
          linkedVaultDocId: 'vd-tax',
          healthStatus: 'VALID',
          notes: 'Standard annual clearance, verified online',
        },
      ]

      const res = await exportHandler!({ sender: null }, 't-01', 'Bulk Water Refurbishment', rows)
      expect(res.ok).toBe(true)
      expect(existsSync(res.path)).toBe(true)
      expect(generatedPaths).toContain(res.path)

      const raw = readFileSync(res.path)
      // Check UTF-8 BOM: 0xEF, 0xBB, 0xBF
      expect(raw[0]).toBe(0xef)
      expect(raw[1]).toBe(0xbb)
      expect(raw[2]).toBe(0xbf)

      const text = raw.toString('utf8')
      const lines = text.replace(/^\uFEFF/, '').split('\n')
      expect(lines[0]).toBe(
        'Requirement ID,Category,Requirement Text,Mandatory / Disqualifier,Fulfillment Status,Linked Document,Health Status,Notes',
      )
      expect(lines[1]).toContain('"REQ-01"')
      expect(lines[1]).toContain('"TAX COMPLIANCE"')
      expect(lines[1]).toContain('"Mandatory / Disqualifier"')
      expect(lines[1]).toContain('"vd-tax"')
    })

    it('draftProposalDoc generates markdown proposal and invokes tab navigation', async () => {
      const draftHandler = ipcHandlers.get(TENDERS_CHANNELS.draftProposalDoc)
      expect(draftHandler).toBeDefined()

      const generatedPaths: string[] = []
      configureTendersRuntime({
        preloadPath: '',
        rendererFile: '',
        openGeneratedPath: (p: string) => {
          generatedPaths.push(p)
          return true
        },
      })

      const tender = {
        title: 'Bulk Water Refurbishment',
        referenceNumber: 'RFP-WTR-2026-04',
        issuingBody: 'City of Ekurhuleni',
        closingDate: '2026-10-31',
        estimatedValue: 243000,
        requirements: [],
        milestones: [
          { name: 'Phase 1 Mobilization', amount: 145000, dueDate: '2026-08-30' },
        ],
      }

      const res = await draftHandler!({ sender: null }, tender)
      expect(res.ok).toBe(true)
      expect(existsSync(res.path)).toBe(true)
      expect(generatedPaths).toContain(res.path)

      const content = readFileSync(res.path, 'utf8')
      expect(content).toContain('Commercial & Technical Tender Proposal')
      expect(content).toContain('RFP-WTR-2026-04')
      expect(content).toContain('City of Ekurhuleni')
      expect(content).toContain('Phase 1 Mobilization')
    })

    it('billMilestoneInBooks validates milestone REACHED status and updates tenders-data.json', async () => {
      const billHandler = ipcHandlers.get(TENDERS_CHANNELS.billMilestoneInBooks)
      expect(billHandler).toBeDefined()

      // Seed tenders store
      const storeFile = join(testDir, 'tenders', 'tenders-data.json')
      const data = migrateAndValidateTenders(null)
      writeTendersStore(storeFile, data)

      // Milestone ms-02 is PENDING -> should be rejected
      const rejectPending = await billHandler!({ sender: null }, 'tender-wtr-04', 'ms-02')
      expect(rejectPending.ok).toBe(false)
      expect(rejectPending.error).toContain('not in REACHED status')

      // Milestone ms-01 is REACHED -> should succeed
      const billSuccess = await billHandler!({ sender: null }, 'tender-wtr-04', 'ms-01')
      expect(billSuccess.ok).toBe(true)
      expect(billSuccess.invoiceNumber).toMatch(/^INV-\d{4}-\d{3}$/)
      expect(billSuccess.grandTotal).toBe(145000)

      // Verify tenders-data.json updated to BILLED
      const updatedData = readTendersStore(storeFile)
      const ms01 = updatedData.workspaces[0].tenders[0].milestones!.find((m) => m.id === 'ms-01')
      expect(ms01?.status).toBe('BILLED')
      expect(ms01?.billedInvoiceNumber).toBe(billSuccess.invoiceNumber)
      expect(ms01?.billedInvoiceId).toBe(billSuccess.invoiceId)
    })
  })
})
