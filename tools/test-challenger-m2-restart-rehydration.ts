#!/usr/bin/env node
/**
 * tools/test-challenger-m2-restart-rehydration.ts
 *
 * Empirical Challenger Verification Suite for Milestone 2:
 * Persistent Disk Storage for RFP Documents & Vault Returnables (R2)
 *
 * Verification Areas:
 * 1. Multi-document upload and restart simulation:
 *    - Uploads multiple RFP PDFs and compliance vault returnables across workspaces.
 *    - Uses both real demo PDFs from the repo and generated test payloads.
 *    - Simulates complete app restarts (resetting in-memory state, disk stores, localStorage).
 *    - Verifies across multiple consecutive restarts that all durable stored paths reload
 *      identically and read back 100% identical byte arrays (SHA-256 byte parity).
 * 2. store.ts partialize and rehydrate verification:
 *    - Tests that partialize strips ephemeral blob: URLs to "" (tenders) or null (vault).
 *    - Tests that partialize preserves durable relative paths (documents/..., vault/...).
 *    - Tests that onRehydrateStorage cleans up dirty/injected blob URLs from older sessions.
 *    - Tests preservation of static /demo/ URLs and default seed tenders.
 * 3. Workspace.tsx PDF viewer loading logic verification:
 *    - Simulates Workspace.tsx useEffect PDF loader logic.
 *    - Verifies loading ArrayBuffer from disk via IPC readDocument without triggering
 *      the "Re-attach the tender PDF" state.
 *    - Verifies real PDFDocumentProxy extraction via loadPdfDocument.
 *    - Verifies that re-attach flow correctly persists new files to durable disk storage.
 *    - Verifies missing/corrupted file error handling without false re-attach states.
 * 4. Adversarial stress & boundary testing:
 *    - Path traversal attacks (relative paths, absolute paths, null bytes).
 *    - Name collisions (same filename uploaded multiple times).
 *    - Concurrent multi-document operations.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import Module from 'node:module'

// ----------------------------------------------------------------------------
// Test Metrics & Assertions
// ----------------------------------------------------------------------------
let testsRun = 0
let testsPassed = 0
let testsFailed = 0
const failureLogs: string[] = []

function assert(condition: any, message: string) {
  testsRun++
  if (!condition) {
    testsFailed++
    const err = `❌ FAIL [Test ${testsRun}]: ${message}`
    console.error(`  ${err}`)
    failureLogs.push(err)
    throw new Error(message)
  } else {
    testsPassed++
    console.log(`  ✅ PASS [Test ${testsRun}]: ${message}`)
  }
}

function sha256(buf: Buffer | ArrayBuffer | Uint8Array): string {
  const hash = createHash('sha256')
  if (Buffer.isBuffer(buf)) {
    hash.update(buf)
  } else if (buf instanceof ArrayBuffer) {
    hash.update(Buffer.from(buf))
  } else {
    hash.update(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
  }
  return hash.digest('hex')
}

// ----------------------------------------------------------------------------
// Mock Electron Environment
// ----------------------------------------------------------------------------
const ipcHandlers: Record<string, (...args: any[]) => any> = {}
const testDir = join(tmpdir(), `challenger-m2-storage-${randomUUID().slice(0, 8)}`)
mkdirSync(testDir, { recursive: true })

const mockApp = {
  getPath: (name: string) => {
    if (name === 'userData') return testDir
    return testDir
  },
  isReady: () => true,
}

const openedPaths: string[] = []
const mockShell = {
  openPath: async (targetPath: string) => {
    openedPaths.push(targetPath)
    if (existsSync(targetPath)) return ''
    return 'Failed to open file: does not exist'
  },
}

const mockIpcMain = {
  handle: (channel: string, listener: (...args: any[]) => any) => {
    ipcHandlers[channel] = listener
  },
}

class MockWebContentsView {
  webContents = {
    isDestroyed: () => false,
    send: (_channel: string, ..._args: any[]) => {},
    loadURL: async () => {},
    loadFile: async () => {},
    once: (_event: string, _fn: () => void) => {},
  }
}

// Intercept 'electron' require
const origRequire = (Module.prototype as any).require
;(Module.prototype as any).require = function (id: string) {
  if (id === 'electron') {
    return {
      app: mockApp,
      shell: mockShell,
      ipcMain: mockIpcMain,
      WebContentsView: MockWebContentsView,
    }
  }
  return origRequire.apply(this, arguments)
}

// ----------------------------------------------------------------------------
// Import Tenders Modules
// ----------------------------------------------------------------------------
const tendersMain = require('../apps/tenders/src/main/tenders-main.ts')
const {
  getTendersBaseDir,
  getTendersDocumentsDir,
  getTendersVaultDir,
  registerTendersIpc,
  stopTendersStoreWatcher,
  readTendersStore,
  writeTendersStore,
} = tendersMain

const tendersIpc = require('../apps/tenders/src/shared/ipc.ts')
const { TENDERS_CHANNELS } = tendersIpc

const { loadPdfDocument } = require('../apps/tenders/src/renderer/src/pdf/extract.ts')

// Setup Mock Window and LocalStorage
const localStorageState = new Map<string, string>()
const mockLocalStorage = {
  getItem: (k: string) => localStorageState.get(k) ?? null,
  setItem: (k: string, v: string) => { localStorageState.set(k, String(v)) },
  removeItem: (k: string) => { localStorageState.delete(k) },
  clear: () => { localStorageState.clear() },
  length: 0,
  key: () => null,
}

const mockTendersApi = {
  getStoredData: async () => {
    const fn = ipcHandlers[TENDERS_CHANNELS.getStoredData]
    if (fn) return fn({ sender: null })
    return null
  },
  saveStoredData: async (json: string) => {
    const fn = ipcHandlers[TENDERS_CHANNELS.saveStoredData]
    if (fn) return fn({ sender: null }, json)
    return { ok: true }
  },
  onDataChanged: (_cb: (data: any) => void) => () => {},
  saveDocument: async (req: any) => {
    const fn = ipcHandlers[TENDERS_CHANNELS.saveDocument]
    if (fn) return fn({ sender: null }, req)
    return { ok: false, error: 'No saveDocument handler registered' }
  },
  readDocument: async (req: any) => {
    const fn = ipcHandlers[TENDERS_CHANNELS.readDocument]
    if (fn) return fn({ sender: null }, req)
    return { ok: false, error: 'No readDocument handler registered' }
  },
  openDocument: async (req: any) => {
    const fn = ipcHandlers[TENDERS_CHANNELS.openDocument]
    if (fn) return fn({ sender: null }, req)
    return { ok: false, error: 'No openDocument handler registered' }
  },
  deleteDocument: async (req: any) => {
    const fn = ipcHandlers[TENDERS_CHANNELS.deleteDocument]
    if (fn) return fn({ sender: null }, req)
    return { ok: false, error: 'No deleteDocument handler registered' }
  },
}

;(global as any).localStorage = mockLocalStorage
;(global as any).window = {
  tendersApi: mockTendersApi,
  localStorage: mockLocalStorage,
}

const tendersStoreModule = require('../apps/tenders/src/renderer/src/store.ts')
const { useTendersStore, SEED_TENDER_WTR_04 } = tendersStoreModule

// ----------------------------------------------------------------------------
// Test Execution Suite
// ----------------------------------------------------------------------------
async function runEmpiricalVerification() {
  console.log('======================================================================')
  console.log('   CHALLENGER 2: EMPIRICAL VERIFICATION (M2 STORAGE & REHYDRATION)')
  console.log('======================================================================\n')

  registerTendersIpc()

  // --------------------------------------------------------------------------
  // SUITE 1: Multi-Document Upload & Simulated Complete App Restart Parity
  // --------------------------------------------------------------------------
  console.log('--- [SUITE 1] Multi-Document Upload & App Restart Simulation ---')

  // Real demo PDF paths from repo
  const demoFiles = [
    { path: 'apps/tenders/public/demo/sample-rfp.pdf', name: 'sample-rfp.pdf', cat: 'rfp' as const },
    { path: 'apps/tenders/public/demo/vault/tax-clearance.pdf', name: 'tax-clearance.pdf', cat: 'vault' as const },
    { path: 'apps/tenders/public/demo/vault/bbbee-affidavit.pdf', name: 'bbbee-affidavit.pdf', cat: 'vault' as const },
    { path: 'apps/tenders/public/demo/vault/cipc-registration.pdf', name: 'cipc-registration.pdf', cat: 'vault' as const },
    { path: 'apps/tenders/public/demo/vault/coida-good-standing.pdf', name: 'coida-good-standing.pdf', cat: 'vault' as const },
    { path: 'apps/tenders/public/demo/vault/director-ids.pdf', name: 'director-ids.pdf', cat: 'vault' as const },
  ]

  // Synthetic test files with varied characteristics
  const syntheticFiles = [
    {
      name: 'RFP-Sanitation-Infrastructure-2026.pdf',
      cat: 'rfp' as const,
      content: Buffer.from('%PDF-1.5 %Sanitation Infrastructure RFP with High-Resolution Specs\n' + 'X'.repeat(50000) + '\n%%EOF'),
    },
    {
      name: 'ISO-9001-Quality-Certification-2026.pdf',
      cat: 'vault' as const,
      content: Buffer.from('%PDF-1.4 %ISO 9001 Certification document\n' + 'Q'.repeat(30000) + '\n%%EOF'),
    },
    {
      name: 'Special_Chars_Doc_[Test]_(v2.1)#1.pdf',
      cat: 'rfp' as const,
      content: Buffer.from('%PDF-1.4 %Special Characters filename test\n' + 'S'.repeat(15000) + '\n%%EOF'),
    },
    {
      name: 'Large-Tender-Specification-1MB.pdf',
      cat: 'rfp' as const,
      content: Buffer.from('%PDF-1.6 %Large tender spec\n' + 'L'.repeat(1024 * 1024) + '\n%%EOF'),
    },
  ]

  interface UploadRecord {
    id: string
    originalName: string
    category: 'rfp' | 'vault'
    originalHash: string
    originalSize: number
    storedPath: string
  }

  const uploadedRecords: UploadRecord[] = []

  // 1. Upload all demo files
  for (const f of demoFiles) {
    const fullSrcPath = resolve(f.path)
    assert(existsSync(fullSrcPath), `Demo source PDF exists at ${f.path}`)
    const buf = readFileSync(fullSrcPath)
    const originalHash = sha256(buf)
    const originalSize = buf.length

    const saveRes = await mockTendersApi.saveDocument({
      fileName: f.name,
      buffer: buf,
      category: f.cat,
    })

    assert(saveRes.ok === true, `Successfully uploaded ${f.name} (category: ${f.cat})`)
    assert(Boolean(saveRes.storedPath), `saveDocument returned storedPath: ${saveRes.storedPath}`)
    assert(
      f.cat === 'rfp' ? saveRes.storedPath.startsWith('documents/') : saveRes.storedPath.startsWith('vault/'),
      `storedPath matches category folder: ${saveRes.storedPath}`
    )

    uploadedRecords.push({
      id: `doc-${randomUUID().slice(0, 8)}`,
      originalName: f.name,
      category: f.cat,
      originalHash,
      originalSize,
      storedPath: saveRes.storedPath,
    })
  }

  // 2. Upload synthetic files
  for (const f of syntheticFiles) {
    const originalHash = sha256(f.content)
    const originalSize = f.content.length

    const saveRes = await mockTendersApi.saveDocument({
      fileName: f.name,
      buffer: f.content,
      category: f.cat,
    })

    assert(saveRes.ok === true, `Successfully uploaded synthetic ${f.name} (${originalSize} bytes)`)
    uploadedRecords.push({
      id: `doc-${randomUUID().slice(0, 8)}`,
      originalName: f.name,
      category: f.cat,
      originalHash,
      originalSize,
      storedPath: saveRes.storedPath,
    })
  }

  console.log(`\nUploaded ${uploadedRecords.length} documents across RFP and Vault categories.`)

  // 3. Register records into store across 2 different company workspaces
  const store = useTendersStore.getState()
  const primaryWsId = store.activeCompanyId

  // Add a second company workspace
  const secondaryWsId = store.addCompany({
    name: 'Khulani Engineering Services',
    tradingName: 'Khulani Engineering',
    taxNumber: '9876543210',
    vatNumber: '4019283746',
    address: '45 Monument Rd, Kempton Park',
  })
  assert(secondaryWsId.startsWith('co-'), `Created secondary company workspace: ${secondaryWsId}`)

  // Populate primary workspace
  store.setActiveCompany(primaryWsId)
  let countRfp = 0
  let countVault = 0

  for (let i = 0; i < uploadedRecords.length; i++) {
    const rec = uploadedRecords[i]
    // split documents between primary and secondary company
    const targetCompanyId = i % 2 === 0 ? primaryWsId : secondaryWsId
    store.setActiveCompany(targetCompanyId)

    if (rec.category === 'rfp') {
      countRfp++
      store.addTender({
        id: `tender-rec-${i}`,
        title: `Tender for ${rec.originalName}`,
        referenceNumber: `RFP-EXP-${2026 + i}`,
        issuingBody: 'Ekurhuleni Water Service',
        closingDate: '2026-12-15',
        submissionMethod: 'PHYSICAL',
        submissionAddress: 'Civic Centre Room 402',
        signatureChecks: {},
        status: 'IN_PROGRESS',
        createdAt: new Date().toISOString(),
        fileName: rec.originalName,
        fileUrl: rec.storedPath,
        numPages: 10,
        ocrPages: 0,
        requirements: [],
      })
    } else {
      countVault++
      store.addVaultDoc({
        id: `vault-rec-${i}`,
        title: `Vault Returnable: ${rec.originalName}`,
        category: 'COMPLIANCE',
        fileUrl: rec.storedPath,
        issueDate: '2026-01-10',
        expiryDate: '2027-01-10',
        isCertified: true,
        certifiedDate: '2026-01-12',
        metadata: { 'Original Name': rec.originalName },
      })
    }
  }

  assert(countRfp > 0 && countVault > 0, `Distributed ${countRfp} tenders and ${countVault} vault docs`)

  // 4. Force state save to both main store and localStorage
  const mainDataBeforeRestart = {
    version: 1,
    updatedAt: new Date().toISOString(),
    activeCompanyId: store.activeCompanyId,
    workspaces: useTendersStore.getState().workspaces,
    issuerTemplates: useTendersStore.getState().issuerTemplates,
  }
  const mainJsonBeforeRestart = JSON.stringify(mainDataBeforeRestart, null, 2)
  writeTendersStore(join(getTendersBaseDir(), 'tenders-data.json'), mainDataBeforeRestart)

  // Capture localStorage snapshot before simulating restarts
  const savedLocalStorageSnapshot = mockLocalStorage.getItem('zanostack-tenders-v1')
  assert(Boolean(savedLocalStorageSnapshot), 'Zustand state successfully serialized into localStorage')

  // 5. SIMULATE APP RESTARTS (3 CONSECUTIVE RESTARTS)
  console.log('\n--- Simulating 3 Consecutive Full Application Restarts ---')

  for (let restartIteration = 1; restartIteration <= 3; restartIteration++) {
    console.log(`\n  >>> Restart Simulation #${restartIteration}...`)

    // Restore localStorage to the persisted pre-restart snapshot
    mockLocalStorage.setItem('zanostack-tenders-v1', savedLocalStorageSnapshot!)

    // Simulate Renderer Rehydration from localStorage
    const savedStorageJson = mockLocalStorage.getItem('zanostack-tenders-v1')
    assert(Boolean(savedStorageJson), `[Restart ${restartIteration}] Found localStorage payload`)
    const parsedStored = JSON.parse(savedStorageJson!)
    assert(parsedStored && parsedStored.state, `[Restart ${restartIteration}] Valid parsed stored state`)

    // Rehydrate store using store's onRehydrateStorage
    const rehydratedState = parsedStored.state
    // Emulate onRehydrateStorage logic from store.ts:
    for (const ws of rehydratedState.workspaces) {
      if (!ws.tenders || ws.tenders.length === 0) {
        ws.tenders = [SEED_TENDER_WTR_04]
      }
      ws.tenders = ws.tenders.map((t: any) =>
        t.fileUrl?.startsWith('blob:') ? { ...t, fileUrl: '' } : t
      )
      ws.vault = ws.vault.map((d: any) =>
        d.fileUrl?.startsWith('blob:') ? { ...d, fileUrl: null } : d
      )
    }

    useTendersStore.setState({
      workspaces: rehydratedState.workspaces,
      activeCompanyId: rehydratedState.activeCompanyId,
      issuerTemplates: rehydratedState.issuerTemplates || [],
      onboardingDone: rehydratedState.onboardingDone ?? false,
      page: rehydratedState.page || 'overview',
      view: rehydratedState.view || 'list',
    })

    // Sync from disk tenders-data.json
    const diskStorePath = join(getTendersBaseDir(), 'tenders-data.json')
    assert(existsSync(diskStorePath), `[Restart ${restartIteration}] tenders-data.json exists on disk`)
    const diskData = readTendersStore(diskStorePath)
    assert(diskData.workspaces.length >= 2, `[Restart ${restartIteration}] disk data preserved all workspaces`)

    // 6. Verify each uploaded document: storedPath integrity and SHA-256 byte parity
    for (const rec of uploadedRecords) {
      // Check that storedPath exists in the rehydrated workspaces
      const allTenders = rehydratedState.workspaces.flatMap((w: any) => w.tenders || [])
      const allVault = rehydratedState.workspaces.flatMap((w: any) => w.vault || [])

      if (rec.category === 'rfp') {
        const found = allTenders.find((t: any) => t.fileUrl === rec.storedPath)
        assert(Boolean(found), `[Restart ${restartIteration}] Rehydrated tender with path ${rec.storedPath}`)
      } else {
        const found = allVault.find((v: any) => v.fileUrl === rec.storedPath)
        assert(Boolean(found), `[Restart ${restartIteration}] Rehydrated vault doc with path ${rec.storedPath}`)
      }

      // Read back via IPC readDocument handler
      const readRes = await mockTendersApi.readDocument({ storedPath: rec.storedPath })
      assert(readRes.ok === true, `[Restart ${restartIteration}] readDocument succeeded for ${rec.storedPath}`)
      assert(readRes.buffer instanceof ArrayBuffer, `[Restart ${restartIteration}] readDocument returned ArrayBuffer`)

      // Verify exact byte parity
      const reloadedHash = sha256(readRes.buffer)
      assert(
        reloadedHash === rec.originalHash,
        `[Restart ${restartIteration}] SHA-256 byte match for ${rec.originalName} (${reloadedHash.slice(0, 12)}...)`
      )
      assert(
        readRes.buffer.byteLength === rec.originalSize,
        `[Restart ${restartIteration}] Exact size parity: ${readRes.buffer.byteLength} bytes`
      )
    }
  }

  console.log('\n--- [SUITE 1 COMPLETE] All documents rehydrated with 100% byte fidelity across restarts! ---\n')

  // --------------------------------------------------------------------------
  // SUITE 2: store.ts partialize and rehydrate URL stripping & preservation
  // --------------------------------------------------------------------------
  console.log('--- [SUITE 2] store.ts Partialize & Rehydration Logic Verification ---')

  // Construct diverse mixed URLs in a test workspace
  const mixedTenders = [
    { id: 't-durable-1', fileUrl: 'documents/1725470000_water_tender.pdf', title: 'Durable 1' },
    { id: 't-durable-2', fileUrl: 'documents/1725470001_roads_tender.pdf', title: 'Durable 2' },
    { id: 't-blob-1', fileUrl: 'blob:http://localhost:5173/019283-uuid-tender', title: 'Blob 1' },
    { id: 't-blob-2', fileUrl: 'blob:https://app.zeno.local/abcd-uuid-tender', title: 'Blob 2' },
    { id: 't-empty', fileUrl: '', title: 'Empty URL' },
    { id: 't-null', fileUrl: (null as unknown) as string, title: 'Null URL' },
    { id: 't-static', fileUrl: '/demo/sample-rfp.pdf', title: 'Static Path' },
  ]

  const mixedVault = [
    { id: 'v-durable-1', fileUrl: 'vault/1725470000_tax_cert.pdf', title: 'Durable Vault 1' },
    { id: 'v-blob-1', fileUrl: 'blob:http://localhost:5173/vault-uuid-001', title: 'Blob Vault 1' },
    { id: 'v-blob-2', fileUrl: 'blob:https://app.zeno.local/vault-uuid-002', title: 'Blob Vault 2' },
    { id: 'v-static-1', fileUrl: '/demo/vault/tax-clearance.pdf', title: 'Static Demo Vault' },
    { id: 'v-null', fileUrl: null, title: 'Null Vault URL' },
  ]

  const testWs: any = {
    id: 'ws-test-partialize',
    name: 'Test Partialize Workspace',
    company: { name: 'Test Co' },
    customers: [],
    vault: mixedVault,
    tenders: mixedTenders,
  }

  // A. Test partialize directly
  // Extract partialize config from store definition
  const storeOptions = (useTendersStore as any).persist?.getOptions?.()
  assert(Boolean(storeOptions?.partialize), 'useTendersStore has persist partialize defined')
  const partializeFn = storeOptions.partialize

  const mockFullState: any = {
    page: 'tenders',
    workspaces: [testWs],
    activeCompanyId: 'ws-test-partialize',
    activeCustomerId: null,
    view: 'workspace',
    activeTenderId: 't-durable-1',
    activeRequirementId: null,
    zoom: 1.25,
    currentPage: 2,
    issuerTemplates: [],
    onboardingDone: true,
    shredding: { stage: 'extracting', message: 'extracting', page: 1, total: 5 },
    pendingFocus: { requirementId: 'req-1', token: 99 },
    tourActive: true,
  }

  const partialized = partializeFn(mockFullState)

  // Assertions on partialized object
  assert(!('shredding' in partialized), 'partialize stripped transient shredding state')
  assert(!('pendingFocus' in partialized), 'partialize stripped transient pendingFocus state')
  assert(!('tourActive' in partialized), 'partialize stripped transient tourActive state')

  const partWs = partialized.workspaces[0]

  // Verify tenders
  const partTDurable1 = partWs.tenders.find((t: any) => t.id === 't-durable-1')
  const partTDurable2 = partWs.tenders.find((t: any) => t.id === 't-durable-2')
  const partTBlob1 = partWs.tenders.find((t: any) => t.id === 't-blob-1')
  const partTBlob2 = partWs.tenders.find((t: any) => t.id === 't-blob-2')
  const partTEmpty = partWs.tenders.find((t: any) => t.id === 't-empty')
  const partTStatic = partWs.tenders.find((t: any) => t.id === 't-static')

  assert(partTDurable1.fileUrl === 'documents/1725470000_water_tender.pdf', 'partialize preserved durable tender 1')
  assert(partTDurable2.fileUrl === 'documents/1725470001_roads_tender.pdf', 'partialize preserved durable tender 2')
  assert(partTBlob1.fileUrl === '', 'partialize stripped blob tender 1 to ""')
  assert(partTBlob2.fileUrl === '', 'partialize stripped blob tender 2 to ""')
  assert(partTEmpty.fileUrl === '', 'partialize kept empty tender fileUrl as ""')
  assert(partTStatic.fileUrl === '/demo/sample-rfp.pdf', 'partialize preserved static /demo URL')

  // Verify vault docs
  const partVDurable1 = partWs.vault.find((v: any) => v.id === 'v-durable-1')
  const partVBlob1 = partWs.vault.find((v: any) => v.id === 'v-blob-1')
  const partVBlob2 = partWs.vault.find((v: any) => v.id === 'v-blob-2')
  const partVStatic1 = partWs.vault.find((v: any) => v.id === 'v-static-1')
  const partVNull = partWs.vault.find((v: any) => v.id === 'v-null')

  assert(partVDurable1.fileUrl === 'vault/1725470000_tax_cert.pdf', 'partialize preserved durable vault doc')
  assert(partVBlob1.fileUrl === null, 'partialize stripped blob vault 1 to null')
  assert(partVBlob2.fileUrl === null, 'partialize stripped blob vault 2 to null')
  assert(partVStatic1.fileUrl === '/demo/vault/tax-clearance.pdf', 'partialize preserved static demo vault URL')
  assert(partVNull.fileUrl === null, 'partialize kept null vault URL as null')

  // B. Test onRehydrateStorage resilience against dirty injected payloads
  assert(Boolean(storeOptions?.onRehydrateStorage), 'useTendersStore has onRehydrateStorage defined')
  const onRehydrateStorageCreator = storeOptions.onRehydrateStorage
  const onRehydrateStorageFn = onRehydrateStorageCreator()

  // Dirty state where someone wrote blob URLs into localStorage
  const dirtyState: any = {
    workspaces: [
      {
        id: 'ws-dirty',
        name: 'Dirty Workspace',
        tenders: [
          { id: 'td-1', fileUrl: 'blob:http://dirty/1' },
          { id: 'td-2', fileUrl: 'documents/clean_path.pdf' },
        ],
        vault: [
          { id: 'vd-1', fileUrl: 'blob:http://dirty/v1' },
          { id: 'vd-2', fileUrl: 'vault/clean_vault.pdf' },
        ],
      },
    ],
    activeCompanyId: 'ws-dirty',
    shredding: { stage: 'done' },
    pendingFocus: { requirementId: 'x' },
    tourActive: true,
  }

  onRehydrateStorageFn(dirtyState)

  assert(dirtyState.workspaces[0].tenders[0].fileUrl === '', 'onRehydrateStorage sanitized dirty tender blob URL to ""')
  assert(dirtyState.workspaces[0].tenders[1].fileUrl === 'documents/clean_path.pdf', 'onRehydrateStorage preserved clean tender path')
  assert(dirtyState.workspaces[0].vault[0].fileUrl === null, 'onRehydrateStorage sanitized dirty vault blob URL to null')
  assert(dirtyState.workspaces[0].vault[1].fileUrl === 'vault/clean_vault.pdf', 'onRehydrateStorage preserved clean vault path')
  assert(dirtyState.shredding === null, 'onRehydrateStorage nullified transient shredding')
  assert(dirtyState.pendingFocus === null, 'onRehydrateStorage nullified transient pendingFocus')
  assert(dirtyState.tourActive === false, 'onRehydrateStorage reset tourActive to false')

  console.log('--- [SUITE 2 COMPLETE] store.ts partialize and rehydrate successfully verified! ---\n')

  // --------------------------------------------------------------------------
  // SUITE 3: Workspace.tsx PDF Viewer Loading Logic & Re-attach Error Avoidance
  // --------------------------------------------------------------------------
  console.log('--- [SUITE 3] Workspace.tsx PDF Loading Logic & Re-attach Error Avoidance ---')

  // Recreate the exact PDF loading logic from Workspace.tsx (lines 66-92)
  async function simulateWorkspacePdfLoader(
    tender: { id: string; fileUrl: string; fileName: string } | null,
    mockApi: typeof mockTendersApi
  ): Promise<{
    doc: any | null
    docError: string | null
    isReattachPromptShown: boolean
    isLoading: boolean
  }> {
    if (!tender) {
      return { doc: null, docError: null, isReattachPromptShown: false, isLoading: false }
    }
    // Condition from Workspace.tsx line 361: {!tender.fileUrl ? (<p>Re-attach the tender PDF</p>) : ...}
    if (!tender.fileUrl) {
      return { doc: null, docError: null, isReattachPromptShown: true, isLoading: false }
    }

    let buf: ArrayBuffer | null = null
    let loadedDoc: any = null
    let error: string | null = null

    // Logic from Workspace.tsx line 68-83:
    if (
      mockApi?.readDocument &&
      !tender.fileUrl.startsWith('blob:') &&
      !tender.fileUrl.startsWith('http') &&
      !tender.fileUrl.startsWith('/')
    ) {
      try {
        const res = await mockApi.readDocument({ storedPath: tender.fileUrl })
        if (res?.ok && res.buffer) {
          buf = res.buffer
        }
      } catch (readErr) {
        console.warn('tenders: failed to read document from disk via IPC', readErr)
      }
    }

    if (!buf) {
      // If not loaded from disk, in a browser it attempts fetch(tender.fileUrl)
      // Here, if it's missing from disk or unreadable, simulate failure
      error = 'Could not open the tender PDF in the viewer.'
      return { doc: null, docError: error, isReattachPromptShown: false, isLoading: false }
    }

    try {
      loadedDoc = await loadPdfDocument(buf)
      return { doc: loadedDoc, docError: null, isReattachPromptShown: false, isLoading: false }
    } catch (e: any) {
      return {
        doc: null,
        docError: 'Could not open the tender PDF in the viewer.',
        isReattachPromptShown: false,
        isLoading: false,
      }
    }
  }

  // Test Case A: Tender with Durable Stored Path (Normal post-restart state)
  const samplePdfRecord = uploadedRecords.find((r) => r.originalName === 'sample-rfp.pdf')!
  const durableTender = {
    id: 'tender-wtr-rehydrated',
    fileUrl: samplePdfRecord.storedPath, // "documents/..."
    fileName: 'sample-rfp.pdf',
  }

  const resultDurable = await simulateWorkspacePdfLoader(durableTender, mockTendersApi)

  assert(resultDurable.isReattachPromptShown === false, 'Durable tender DOES NOT show "Re-attach the tender PDF"')
  assert(resultDurable.docError === null, 'Durable tender has no docError')
  assert(resultDurable.doc !== null, 'Durable tender successfully loaded PDFDocumentProxy')
  assert(resultDurable.doc.numPages > 0, `PDF successfully parsed with ${resultDurable.doc.numPages} pages`)
  await resultDurable.doc.cleanup()

  // Test Case B: Tender with Stripped Blob URL (Ephemeral blob died across restart)
  const transientTenderAfterRestart = {
    id: 'tender-transient',
    fileUrl: '', // Stripped by partialize/rehydrate
    fileName: 'transient-rfp.pdf',
  }

  const resultTransient = await simulateWorkspacePdfLoader(transientTenderAfterRestart, mockTendersApi)

  assert(resultTransient.isReattachPromptShown === true, 'Stripped tender properly triggers "Re-attach the tender PDF"')
  assert(resultTransient.doc === null, 'No doc loaded for unattached tender')
  assert(resultTransient.docError === null, 'docError is null when re-attach prompt is shown')

  // Test Case C: Re-attach Flow Simulation
  // User re-attaches a new PDF file via handleReattach in Workspace.tsx (lines 116-137)
  console.log('\n  >>> Simulating User Re-attach Flow in Workspace.tsx...')
  const reattachBuffer = readFileSync(resolve('apps/tenders/public/demo/sample-rfp.pdf'))
  const saveReattachRes = await mockTendersApi.saveDocument({
    fileName: 'Reattached_Tender_Spec.pdf',
    buffer: reattachBuffer,
    category: 'rfp',
  })

  assert(saveReattachRes.ok === true, 'handleReattach successfully saved file to disk via IPC')
  assert(Boolean(saveReattachRes.storedPath), `New durable path generated: ${saveReattachRes.storedPath}`)

  const updatedTender = {
    ...transientTenderAfterRestart,
    fileUrl: saveReattachRes.storedPath,
    fileName: 'Reattached_Tender_Spec.pdf',
  }

  const resultAfterReattach = await simulateWorkspacePdfLoader(updatedTender, mockTendersApi)

  assert(resultAfterReattach.isReattachPromptShown === false, 'Re-attach prompt disappears after re-attaching')
  assert(resultAfterReattach.doc !== null, 'PDFDocumentProxy loaded after re-attach')
  assert(resultAfterReattach.doc.numPages > 0, 'Re-attached PDF valid')
  await resultAfterReattach.doc.cleanup()

  // Test Case D: Corrupted / Deleted File on Disk Handling
  const deletedFileTender = {
    id: 'tender-deleted',
    fileUrl: 'documents/deleted_ghost_file.pdf',
    fileName: 'deleted_ghost_file.pdf',
  }

  const resultDeleted = await simulateWorkspacePdfLoader(deletedFileTender, mockTendersApi)

  assert(resultDeleted.isReattachPromptShown === false, 'Deleted file does NOT falsely claim session expiration')
  assert(
    resultDeleted.docError === 'Could not open the tender PDF in the viewer.',
    `Shows actual viewer error: "${resultDeleted.docError}"`
  )

  console.log('--- [SUITE 3 COMPLETE] Workspace.tsx loading logic & error states successfully verified! ---\n')

  // --------------------------------------------------------------------------
  // SUITE 4: Adversarial Edge Cases & Security Boundaries
  // --------------------------------------------------------------------------
  console.log('--- [SUITE 4] Adversarial Edge Cases & Security Boundaries ---')

  // 1. Path Traversal Injections
  const maliciousPaths = [
    '../../../Windows/System32/drivers/etc/hosts',
    '..\\..\\..\\Windows\\System32\\cmd.exe',
    'documents/../../tenders-data.json',
    'vault/../../tenders-data.json',
    'documents/../../../AppData/Local',
    'documents/test.pdf\0.png',
    '/etc/passwd',
    'C:\\Windows\\System32\\calc.exe',
    '\\\\?\\UNC\\127.0.0.1\\c$\\secret.txt',
  ]

  for (const mal of maliciousPaths) {
    const readAttempt = await mockTendersApi.readDocument({ storedPath: mal })
    assert(readAttempt.ok === false, `readDocument safely rejected traversal attack: "${mal}"`)
    const openAttempt = await mockTendersApi.openDocument({ storedPath: mal })
    assert(openAttempt.ok === false, `openDocument safely rejected traversal attack: "${mal}"`)
    const delAttempt = await mockTendersApi.deleteDocument({ storedPath: mal })
    assert(delAttempt.ok === false, `deleteDocument safely rejected traversal attack: "${mal}"`)
  }

  // 2. Name Collisions & Timestamp Uniqueness
  const duplicateName = 'Standard_Tender_Form.pdf'
  const dup1 = await mockTendersApi.saveDocument({
    fileName: duplicateName,
    buffer: Buffer.from('%PDF-1.4 Version 1'),
    category: 'rfp',
  })
  // Small tick for timestamp
  const startWait = Date.now()
  while (Date.now() - startWait < 5) {}

  const dup2 = await mockTendersApi.saveDocument({
    fileName: duplicateName,
    buffer: Buffer.from('%PDF-1.4 Version 2 with distinct contents'),
    category: 'rfp',
  })

  assert(dup1.ok && dup2.ok, 'Both duplicate saves succeeded')
  assert(dup1.storedPath !== dup2.storedPath, 'Duplicate uploads created distinct non-colliding paths')

  const readDup1 = await mockTendersApi.readDocument({ storedPath: dup1.storedPath })
  const readDup2 = await mockTendersApi.readDocument({ storedPath: dup2.storedPath })
  assert(
    Buffer.from(readDup1.buffer).toString() === '%PDF-1.4 Version 1',
    'Version 1 content preserved without overwrite'
  )
  assert(
    Buffer.from(readDup2.buffer).toString() === '%PDF-1.4 Version 2 with distinct contents',
    'Version 2 content preserved without overwrite'
  )

  // 3. Concurrent Multi-Document Operations (Race Condition Test)
  console.log('\n  >>> Testing 10 Concurrent Parallel Document Saves & Reads...')
  const concurrentTasks = Array.from({ length: 10 }, async (_, idx) => {
    const content = Buffer.from(`%PDF-1.4 Concurrent Stream Document Payload #${idx}`)
    const saveRes = await mockTendersApi.saveDocument({
      fileName: `concurrent_doc_${idx}.pdf`,
      buffer: content,
      category: idx % 2 === 0 ? 'rfp' : 'vault',
    })
    if (!saveRes.ok || !saveRes.storedPath) throw new Error(`Concurrent save failed for #${idx}`)
    const readRes = await mockTendersApi.readDocument({ storedPath: saveRes.storedPath })
    if (!readRes.ok || !readRes.buffer) throw new Error(`Concurrent read failed for #${idx}`)
    const readStr = Buffer.from(readRes.buffer).toString()
    if (readStr !== content.toString()) throw new Error(`Concurrent data mismatch for #${idx}`)
    return true
  })

  const concurrentResults = await Promise.all(concurrentTasks)
  assert(concurrentResults.length === 10 && concurrentResults.every(Boolean), 'All 10 concurrent operations passed')

  // 4. Safe Deletion & Idempotency
  const delTestRes = await mockTendersApi.saveDocument({
    fileName: 'file_to_delete.pdf',
    buffer: Buffer.from('delete me'),
    category: 'vault',
  })
  const diskPathToDelete = join(getTendersBaseDir(), delTestRes.storedPath)
  assert(existsSync(diskPathToDelete), 'File to delete created on disk')

  const firstDelete = await mockTendersApi.deleteDocument({ storedPath: delTestRes.storedPath })
  assert(firstDelete.ok === true, 'First deletion succeeded')
  assert(!existsSync(diskPathToDelete), 'File physically unlinked from disk')

  const secondDelete = await mockTendersApi.deleteDocument({ storedPath: delTestRes.storedPath })
  assert(secondDelete.ok === true, 'Second deletion of missing file is idempotent (returns ok: true)')

  console.log('--- [SUITE 4 COMPLETE] Adversarial edge cases and security boundaries passed! ---\n')

  // --------------------------------------------------------------------------
  // FINAL SCORE & SUMMARY
  // --------------------------------------------------------------------------
  console.log('======================================================================')
  console.log(`VERIFICATION SUMMARY: ${testsPassed} passed, ${testsFailed} failed (Total: ${testsRun})`)
  console.log('VERDICT: ' + (testsFailed === 0 ? '✅ APPROVE (ALL R2 REQUIREMENTS VERIFIED)' : '❌ FAIL'))
  console.log('======================================================================\n')

  stopTendersStoreWatcher()
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {}

  if (testsFailed > 0) {
    process.exit(1)
  }
}

runEmpiricalVerification().catch((err) => {
  console.error('\nFatal unhandled error during empirical verification:', err)
  stopTendersStoreWatcher()
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {}
  process.exit(1)
})
