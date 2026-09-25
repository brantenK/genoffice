import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const testDir = join(tmpdir(), `tenders-ipc-test-${randomUUID().slice(0, 8)}`)

const {
  ipcHandlers,
  openedPaths,
  mockBroadcasts,
  removedHandlers,
  booksInvoiceCalls,
  preloadBridge,
  dialogState,
  invokeSender,
  engineSeams,
} = vi.hoisted(() => {
  /**
   * The seams the discovery + reminder wiring exposes
   * (`setTendersEngineOverrides`). `main/tenders-main.ts` builds both engines
   * through these, so installing the fakes before `registerTendersIpc()` proves
   * the whole new IPC surface with no network, no real schedule and no wall
   * time — and each fake records exactly what main asked it to do.
   */
  const reminderState: RemindersState = {
    settings: {
      enabled: true,
      thresholds: [{ id: '7d', label: '7 days', leadMs: 7 * 24 * 60 * 60 * 1000 }],
    },
    ledger: { version: 1, entries: [] },
  }
  /**
   * A refresh reply as the real client builds one. The cache is non-nullable in
   * `RefreshCacheSuccess`, so a default reply of `cache: null` was a shape the
   * client cannot produce — this one is what `refreshCache` actually resolves to.
   */
  const emptyCache: DiscoveryCacheEnvelope = {
    version: 1,
    fetchedAt: '2026-09-01T08:00:00.000Z',
    window: { from: '2026-08-25', to: '2026-09-01' },
    source: 'ocds-api',
    complete: true,
    opportunities: [],
    warnings: [],
  }
  const engineSeams = {
    /** The options main built the scheduler with — what proves the wiring. */
    schedulerOptions: [] as RemindersSchedulerOptions[],
    scheduler: {
      start: vi.fn<RemindersScheduler['start']>(),
      stop: vi.fn<RemindersScheduler['stop']>(),
      checkNow: vi.fn<RemindersScheduler['checkNow']>(async () => ({
        fired: 0,
        reminders: [],
        ledger: reminderState.ledger,
      })),
      readState: vi.fn<RemindersScheduler['readState']>(async () => reminderState),
      writeSettings: vi.fn<RemindersScheduler['writeSettings']>(async (patch) => ({
        ...reminderState.settings,
        ...patch,
      })),
      setReadTenders: vi.fn<RemindersScheduler['setReadTenders']>(),
    },
    reminderState,
    /** The options main built the discovery client with. */
    clientOptions: [] as DiscoveryClientOptions[],
    client: {
      listOpportunities: vi.fn<DiscoveryClient['listOpportunities']>(async () => ({
        ok: true,
        opportunities: [],
        issues: [],
        warnings: [],
        pages: 1,
        failedPages: 0,
        source: 'ocds-api',
        truncated: false,
      })),
      fetchRelease: vi.fn<DiscoveryClient['fetchRelease']>(async () => ({
        ok: true,
        opportunity: null,
        issues: [],
        warnings: [],
      })),
      refreshCache: vi.fn<DiscoveryClient['refreshCache']>(async () => ({
        ok: true,
        cache: emptyCache,
        complete: true,
        warnings: [],
      })),
      readCache: vi.fn<DiscoveryClient['readCache']>(async () => ({
        ok: true,
        cache: null,
        stale: true,
        warnings: [],
      })),
    },
    /** Every URL the document download asked for, and how it asked. */
    documentFetchCalls: [] as Array<{ url: string; init?: DiscoveryFetchInit }>,
    documentFetch: vi.fn<DiscoveryDocumentFetch>(async (url) => {
      throw new Error(`no document fetch was installed for ${url}`)
    }),
  }
  return {
    ipcHandlers: new Map<string, (...args: unknown[]) => any>(),
    openedPaths: [] as string[],
    mockBroadcasts: [] as Array<{ channel: string; data: any }>,
    removedHandlers: [] as string[],
    booksInvoiceCalls: [] as any[],
    preloadBridge: { key: '', api: undefined as unknown },
    /**
     * The WebContents a renderer-initiated `invoke` is modelled as coming from.
     * Real Electron hands the handler the calling WebContents, whose numeric `id`
     * the close-flush reply binding checks, so a test that drives the renderer on
     * behalf of a specific view sets this to that view.
     */
    invokeSender: { current: undefined as any },
    dialogState: {
      /** Index the stubbed message box answers with (1 = the safe "keep open"). */
      response: 1,
      calls: [] as Array<{ message: string; detail: string }>,
    },
    engineSeams,
  }
})

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
      removeHandler: (channel: string) => {
        removedHandlers.push(channel)
        ipcHandlers.delete(channel)
      },
    },
    // The preload module is imported below so the real projection runs; its
    // `invoke` is routed into the real registered main handlers, which makes the
    // preload -> main boundary testable end to end.
    contextBridge: {
      exposeInMainWorld: (key: string, api: unknown) => {
        preloadBridge.key = key
        preloadBridge.api = api
      },
    },
    ipcRenderer: {
      invoke: async (channel: string, ...args: unknown[]) => {
        const listener = ipcHandlers.get(channel)
        if (!listener) throw new Error(`No handler registered for ${channel}`)
        const sender: any = invokeSender.current ?? {
          isDestroyed: () => false,
          getURL: () => TRUSTED_RENDERER_URL,
          send: () => {},
          once: vi.fn(),
        }
        registerTendersWebContents(sender)
        registeredTestWebContents.push(sender)
        return listener(
          { sender, senderFrame: { url: TRUSTED_RENDERER_URL, parent: null } },
          ...args,
        )
      },
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    shell: {
      openPath: vi.fn(async (p: string) => {
        openedPaths.push(p)
        return ''
      }),
    },
    // The close guard's last-resort prompt. The stub records the copy it was
    // asked to show and answers with the configured button index.
    dialog: {
      showMessageBox: async (parentOrOptions: any, maybeOptions?: any) => {
        const options = maybeOptions ?? parentOrOptions
        dialogState.calls.push({
          message: String(options?.message ?? ''),
          detail: String(options?.detail ?? ''),
        })
        return { response: dialogState.response, checkboxChecked: false }
      },
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
  applyTendersNavigationPolicy,
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
  repairSubmissionReadinessSnapshots,
  requestTendersClose,
  resetTendersIpcForTests,
  resolveConfinedTendersPath,
  resolveSafeTendersPath,
  saveDocumentFile,
  SEED_COMPANY_ID,
  SEED_TENDER_WTR_04,
  setTendersEngineOverrides,
  setTendersDiagnosticsLogForTests,
  stopTendersReminders,
  unregisterTendersWebContents,
  writeTendersStore,
} from '../src/main/tenders-main'
import { MOCK_COMPANY } from '../src/renderer/src/mock/company'
import { MOCK_CUSTOMERS } from '../src/renderer/src/mock/customers'
import { MOCK_VAULT } from '../src/renderer/src/mock/vault'
import type {
  DiscoveryClient,
  DiscoveryClientOptions,
  DiscoveryFetchInit,
  DiscoveryHttpResponse,
} from '../src/main/discovery-client'
import type { DiscoveryDocumentFetch } from '../src/main/tenders-main'
import type { DiscoveryCacheEnvelope, Opportunity } from '../src/shared/discovery'
import { normaliseOpportunity } from '../src/shared/discovery'
import type { ReminderLedgerEntry } from '../src/shared/reminders'
import type {
  RemindersScheduler,
  RemindersSchedulerOptions,
  RemindersState,
} from '../src/main/reminders-scheduler'
import type { WebContents } from 'electron'
// Wrap (do not replace) the real Books posting so the existing invoice-numbering
// coverage still runs while F4 can assert the exact number of posts.
vi.mock('../../books/src/main/books-core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>
  return {
    ...actual,
    issueSalesInvoiceInBooks: (req: any) => {
      booksInvoiceCalls.push(req)
      return actual.issueSalesInvoiceInBooks(req)
    },
  }
})

import {
  MAX_DISCOVERY_DOWNLOAD_BYTES,
  MAX_TENDERS_DOCUMENT_UPLOAD_BYTES,
  MAX_TENDERS_MATRIX_EXPORT_BYTES,
  MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS,
  MAX_TENDERS_MATRIX_EXPORT_ROWS,
  MAX_TENDERS_REMINDER_THRESHOLDS,
  TENDERS_CHANNELS,
} from '../src/shared/ipc'
import { resetTendersIntegrationsForTests } from '../src/main/integrations'
import { createEmptyTendersDataV2, migrateTendersDataV1 } from '../src/shared/tenders-schema'
import type { TenderRecord, TendersData, TendersDataV1, TendersDataV2 } from '../src/shared/types'
// Importing the preload module runs `contextBridge.exposeInMainWorld`, which the
// mocked electron captures into `preloadBridge` so the real projection can be
// exercised against the real main handlers.
import '../src/preload/index'

const LOAD_STORE_V2_CHANNEL = 'tenders:load-store-v2'
const SAVE_STORE_V2_CHANNEL = 'tenders:save-store-v2'
const STORE_CHANGED_V2_CHANNEL = 'tenders:store-changed-v2'
const storeFile = join(testDir, 'tenders', 'tenders-data.json')
const registeredTestWebContents: any[] = []

/** Origin the main process must treat as the real Tenders renderer. */
const TRUSTED_RENDERER_URL = 'http://localhost:5179/'
const UNTRUSTED_RENDERER_URL = 'https://attacker.example/'

function validV2(revision = 0): TendersDataV2 {
  return { ...createEmptyTendersDataV2('2026-09-01T08:30:00.000Z'), revision }
}

/**
 * The demo company/vault/tender fixture, built HERE rather than read out of
 * `migrateAndValidateTenders(null)`.
 *
 * The reader used to synthesize this document for any empty payload, and the
 * tests below leaned on that as a convenient fixture factory. It no longer does
 * (see the main-process retirement note): an absent or unreadable store must not
 * become a demo company on any path, so the fixture is stated explicitly by the
 * test that wants it. Every assertion built on it is unchanged.
 */
function legacySeedFixture(): TendersDataV1 {
  return {
    version: 1,
    updatedAt: '2026-08-01T08:00:00.000Z',
    activeCompanyId: SEED_COMPANY_ID,
    workspaces: [
      {
        id: SEED_COMPANY_ID,
        name: 'Thabo Engineering (Pty) Ltd',
        company: { ...MOCK_COMPANY },
        customers: [...MOCK_CUSTOMERS],
        vault: [...MOCK_VAULT],
        tenders: [SEED_TENDER_WTR_04],
      },
    ],
    issuerTemplates: [],
  }
}

function validV1(): TendersDataV1 {
  const data = structuredClone(legacySeedFixture())
  data.version = 1
  data.updatedAt = '2026-08-20T09:15:30.000Z'
  data.workspaces[0].company.tradingName = 'IPC migration marker'
  return data
}

/**
 * A valid schema-v2 document carrying the seeded tender (ms-01 REACHED,
 * ms-02 PENDING) at the requested authoritative revision.
 */
function v2WithSeedTender(revision: number): TendersDataV2 {
  const migrated = migrateTendersDataV1(validV1(), '2026-09-01T08:30:00.000Z')
  if (!migrated.ok) throw new Error(`v2 fixture migration failed: ${migrated.error.message}`)
  return { ...migrated.data, revision }
}

/**
 * A valid schema-v2 document whose single tender is GENUINELY ready: every
 * requirement fulfilled with valid linked evidence, a future closing date,
 * confirmed pricing that matches the milestone total, and no intake/OCR gate.
 */
function v2WithReadyTender(revision: number): TendersDataV2 {
  const base = v2WithSeedTender(revision)
  // Keep the seeded vault (the seeded customers reference its documents) and add
  // the certificate the ready tender links.
  base.workspaces[0].vault = [
    ...base.workspaces[0].vault,
    {
      id: 'vault-tax',
      title: 'SARS Tax Clearance Certificate',
      category: 'COMPLIANCE',
      fileUrl: 'vault/tax-clearance.pdf',
      issueDate: '2026-01-01',
      expiryDate: '2099-12-31',
      isCertified: false,
      certifiedDate: null,
      metadata: {},
    },
  ]
  base.workspaces[0].tenders = [
    {
      id: 'tender-ready',
      title: 'Supply and Delivery of Office Computers',
      referenceNumber: 'ICT/2026/041',
      issuingBody: 'Provincial Administration Office',
      closingDate: '2099-12-18',
      submissionMethod: 'ELECTRONIC',
      submissionAddress: 'procurement@example.test',
      signatureChecks: {},
      status: 'IN_PROGRESS',
      createdAt: '2026-08-01T08:00:00Z',
      fileName: 'office-computers-rfp.pdf',
      fileUrl: 'documents/office-computers-rfp.pdf',
      numPages: 12,
      ocrPages: 0,
      estimatedValue: 115000,
      pricingConfirmed: true,
      requirements: [
        {
          id: 'req-tax',
          ruleKey: 'tax_pin',
          title: 'Valid SARS Tax Clearance / TCS PIN',
          category: 'MANDATORY_STAGE_1',
          isMandatory: true,
          verbatimClause: 'Bidders must submit valid proof of tax compliance.',
          pageNumber: 1,
          boundingBox: { top: 0.1, left: 0.1, width: 0.8, height: 0.05 },
          riskLevel: 'CRITICAL_DISQUALIFIER',
          order: 1,
          status: 'FULFILLED',
          linkedVaultDocId: 'vault-tax',
          reason: null,
          suggestedVaultDocIds: [],
        },
      ],
      milestones: [
        {
          id: 'ms-delivery',
          name: 'Delivery and acceptance',
          amount: 115000,
          dueDate: '2099-11-30',
          status: 'PENDING',
        },
      ],
    },
  ]
  return base
}

/** Locate `apps/tenders` whether Vitest runs from the workspace or the repo root. */
function resolveTendersDir(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, 'src', 'renderer', 'index.html'))) return dir
    if (existsSync(join(dir, 'apps', 'tenders', 'src', 'renderer', 'index.html')))
      return join(dir, 'apps', 'tenders')
    dir = dirname(dir)
  }
  throw new Error(`Could not locate apps/tenders from ${process.cwd()}`)
}

/**
 * The four members `main` touches on a renderer's `WebContents`.
 *
 * `WebContents` is a 140-member Electron class, so a test double for one is
 * written against this shape and cast where it meets Electron — the cast is at
 * the boundary, and the shape itself is checked wherever a double is written.
 */
type WebContentsDouble = Pick<WebContents, 'isDestroyed' | 'getURL' | 'once' | 'send'>

function registeredWebContents(
  send: (channel: string, data: unknown) => void = vi.fn(),
  url: string = TRUSTED_RENDERER_URL,
): any {
  const webContents: any = {
    isDestroyed: () => false,
    getURL: () => url,
    send,
    once: vi.fn(),
  }
  registerTendersWebContents(webContents)
  registeredTestWebContents.push(webContents)
  return webContents
}

/**
 * Frame contract shape expected by the remediated privileged handlers:
 * `event.senderFrame.url` is the caller frame URL and `event.senderFrame.parent`
 * is null only for the top frame.
 */
function trustedFrame(): any {
  return { url: TRUSTED_RENDERER_URL, parent: null }
}

function untrustedFrame(): any {
  return { url: UNTRUSTED_RENDERER_URL, parent: null }
}

function subFrame(): any {
  return { url: TRUSTED_RENDERER_URL, parent: {} }
}

function event(sender: any, senderFrame: any = trustedFrame()): { sender: any; senderFrame: any } {
  return { sender, senderFrame }
}

/**
 * A recording diagnostics sink, installed in place of the real one so no test
 * writes to the data directory. `diagnosticsLogForTests()` installs (or
 * re-installs) it and returns the entries it has collected, so each test starts
 * from a known-empty log.
 */
const recordedDiagnostics: Array<{
  level: 'info' | 'warn' | 'error'
  source: string
  message: string
  detail?: Record<string, unknown>
}> = []
let diagnosticsSinkInstalled = false

function diagnosticsLogForTests(): typeof recordedDiagnostics {
  if (!diagnosticsSinkInstalled) {
    setTendersDiagnosticsLogForTests({
      record: (entry) => {
        recordedDiagnostics.push(entry)
      },
      path: () => '/tmp/tenders-test-diagnostics.log',
      flush: async () => {},
    })
    diagnosticsSinkInstalled = true
  }
  recordedDiagnostics.length = 0
  return recordedDiagnostics
}

function deliveryRecorder(): {
  send: (channel: string, data: unknown) => void
  deliveries: Array<{ channel: string; data: any }>
} {
  const deliveries: Array<{ channel: string; data: any }> = []
  return {
    deliveries,
    send: (channel: string, data: unknown) => {
      deliveries.push({ channel, data: data as any })
    },
  }
}

// ── the discovery + reminder engine seams ────────────────────────────────────

/**
 * Install the fakes `main/tenders-main.ts` builds both engines through. Called
 * from `beforeAll` and from the describes that need a fresh schedule, so no test
 * in this file reaches the network, builds a real timer or reads the real clock.
 */
function installEngineSeams(): void {
  setTendersEngineOverrides({
    createDiscoveryClient: (options) => {
      engineSeams.clientOptions.push(options)
      return engineSeams.client as unknown as DiscoveryClient
    },
    createRemindersScheduler: (options) => {
      engineSeams.schedulerOptions.push(options)
      return engineSeams.scheduler as unknown as RemindersScheduler
    },
    documentFetch: (url, init) => {
      // Recorded in the wrapper, not in the mock's own implementation: a test
      // that installs a one-shot answer (`mockResolvedValueOnce`) replaces that
      // implementation, and the URL it was asked for still has to be visible.
      engineSeams.documentFetchCalls.push({ url, init })
      return engineSeams.documentFetch(url, init)
    },
  })
}

/** Forget what the fakes were asked, and restore their default answers. */
function resetEngineSeams(): void {
  engineSeams.schedulerOptions.length = 0
  engineSeams.clientOptions.length = 0
  engineSeams.documentFetchCalls.length = 0
  for (const record of [engineSeams.scheduler, engineSeams.client]) {
    for (const value of Object.values(record)) {
      const mock = value as { mockClear?: () => void }
      if (typeof mock.mockClear === 'function') mock.mockClear()
    }
  }
  engineSeams.documentFetch.mockClear()
  engineSeams.scheduler.checkNow.mockImplementation(async () => ({
    fired: 0,
    reminders: [],
    ledger: engineSeams.reminderState.ledger,
  }))
  engineSeams.scheduler.readState.mockImplementation(async () => ({
    settings: engineSeams.reminderState.settings,
    ledger: engineSeams.reminderState.ledger,
  }))
  engineSeams.scheduler.writeSettings.mockImplementation(async (patch: any) => ({
    ...engineSeams.reminderState.settings,
    ...patch,
  }))
  engineSeams.documentFetch.mockImplementation(async (url: string) => {
    throw new Error(`no document fetch was installed for ${url}`)
  })
}

/** What is currently in the managed `documents/` directory. */
function documentsDirEntries(): string[] {
  const dir = getTendersDocumentsDir(testDir)
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

type DocumentReply = DiscoveryHttpResponse & { arrayBuffer?(): Promise<ArrayBuffer> }

function bytesOf(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value
}

/** One buffered document reply, with a stream reader and its own bytes. */
function documentReply(options: {
  status?: number
  body?: string | Uint8Array
  contentLength?: number
  location?: string
  /** Omit the stream, so the download falls back to `arrayBuffer()`. */
  streamless?: boolean
}): DocumentReply {
  const status = options.status ?? 200
  const bytes = bytesOf(options.body ?? '')
  const headers: Record<string, string> = {}
  if (options.contentLength !== undefined) headers['content-length'] = String(options.contentLength)
  if (options.location !== undefined) headers.location = options.location
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: options.streamless
      ? null
      : {
          getReader: () => {
            let sent = false
            return {
              read: async () => {
                if (sent) return { done: true }
                sent = true
                return { done: false, value: bytes }
              },
            }
          },
        },
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
  }
}

/**
 * A reply that streams one chunk over and over, so the byte cap can be proved
 * while the body is read rather than from a declared length.
 */
function repeatingDocumentReply(chunkBytes: number, times: number): DocumentReply {
  const chunk = new Uint8Array(chunkBytes)
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: {
      getReader: () => {
        let sent = 0
        let cancelled = false
        return {
          read: async () => {
            if (cancelled || sent >= times) return { done: true }
            sent += 1
            return { done: false, value: chunk }
          },
          cancel: async () => {
            cancelled = true
          },
        }
      },
    },
  }
}

/** A due reminder, as the pure core shapes it. */
const DUE_REMINDER = {
  tenderId: SEED_TENDER_WTR_04.id,
  tenderTitle: SEED_TENDER_WTR_04.title,
  thresholdId: '2h',
  thresholdLabel: '2 hours',
  leadMs: 7_200_000,
  closingAt: '2026-10-31T21:59:00.000Z',
  closingDate: '2026-10-31',
  dueAt: '2026-10-31T19:59:00.000Z',
  remainingMs: 3_600_000,
  late: false,
  skippedThresholdIds: [],
  skippedThresholdLabels: [],
}

/** The ledger entry a fired `DUE_REMINDER` leaves behind, as the core writes it. */
function ledgerEntry(): ReminderLedgerEntry {
  return {
    tenderId: DUE_REMINDER.tenderId,
    thresholdId: DUE_REMINDER.thresholdId,
    closingAt: DUE_REMINDER.closingAt,
    handledAt: '2026-10-31T19:59:00.000Z',
    disposition: 'notified',
  }
}

/**
 * A real `Opportunity`, built through the app's own normaliser, so the fixture
 * cannot drift from the shape the discovery client actually hands to main.
 */
function opportunityFixture(overrides: Partial<Opportunity> = {}): Opportunity {
  const base = normaliseOpportunity({
    ocid: 'ocds-abc-1',
    tender: { title: 'Supply of water meters' },
  })
  if (base === null) throw new Error('the opportunity fixture did not normalise')
  return { ...base, ...overrides }
}

describe('Electron IPC Handlers & Security Validation', () => {
  beforeAll(() => {
    mkdirSync(testDir, { recursive: true })
    // The diagnostics sink goes in before anything can record through it, so no
    // test in this file writes a line into the real data directory.
    diagnosticsLogForTests()
    configureTendersRuntime({
      preloadPath: '',
      rendererUrl: TRUSTED_RENDERER_URL,
      rendererFile: '',
    })
    // The engine seams go in BEFORE registration: `registerTendersIpc` starts the
    // reminder schedule, and every discovery handler builds its client lazily, so
    // installing them here is what keeps this whole file off the network and off
    // a real timer.
    installEngineSeams()
    registerTendersIpc()
  })

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    rmSync(storeFile, { force: true })
    openedPaths.length = 0
    mockBroadcasts.length = 0
    removedHandlers.length = 0
    booksInvoiceCalls.length = 0
    invokeSender.current = undefined
    configureTendersRuntime({
      preloadPath: '',
      rendererUrl: TRUSTED_RENDERER_URL,
      rendererFile: '',
      onOpenCrm: undefined,
      onOpenBooks: undefined,
      openGeneratedPath: undefined,
    })
    // Keep handlers present even if a prior test exercised the reset API.
    registerTendersIpc()
  })

  afterEach(() => {
    for (const webContents of registeredTestWebContents.splice(0)) {
      unregisterTendersWebContents(webContents)
    }
    rmSync(storeFile, { force: true })
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
        getURL: () => TRUSTED_RENDERER_URL,
        send: (channel: string, data: any) => {
          if (channel === TENDERS_CHANNELS.dataChanged) received.push(data)
        },
        once: vi.fn(),
      }

      registerTendersWebContents(fakeWc)
      expect(getActiveTendersWebContents()).toContain(fakeWc)

      const testData: TendersData = legacySeedFixture()
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

      const testData: TendersData = legacySeedFixture()
      expect(() => broadcastTendersData(testData)).not.toThrow()
    })

    it.each([
      { channel: TENDERS_CHANNELS.getStoredData, args: [] as unknown[] },
      { channel: TENDERS_CHANNELS.saveStoredData, args: ['not-valid-json'] as unknown[] },
    ])('$channel cannot enroll its sender for proposal side effects', async ({ channel, args }) => {
      const persistenceHandler = ipcHandlers.get(channel)
      const draftHandler = ipcHandlers.get(TENDERS_CHANNELS.draftProposalDoc)
      expect(persistenceHandler).toBeDefined()
      expect(draftHandler).toBeDefined()
      const unregisteredSender: any = {
        isDestroyed: () => false,
        send: vi.fn(),
        once: vi.fn(),
      }

      await persistenceHandler!({ sender: unregisteredSender }, ...args)
      const wasEnrolledByPersistence = getActiveTendersWebContents().includes(unregisteredSender)
      const proposalResult = await draftHandler!(
        { sender: unregisteredSender },
        {
          title: 'Persistence sender must remain unauthorized',
          referenceNumber: 'SEC-IPC-01',
          issuingBody: 'Security Review',
          closingDate: '2099-12-31',
          estimatedValue: 100,
          pricingConfirmed: true,
          requirements: [
            {
              id: 'req-1',
              title: 'Known requirement',
              isMandatory: true,
              status: 'FULFILLED',
              linkedVaultDocId: 'vault-1',
              healthStatus: 'VALID',
            },
          ],
          milestones: [{ name: 'Delivery', amount: 100, dueDate: '2099-11-30' }],
        },
      )
      unregisterTendersWebContents(unregisteredSender)
      if (typeof proposalResult?.path === 'string') rmSync(proposalResult.path, { force: true })

      expect(wasEnrolledByPersistence).toBe(false)
      expect(proposalResult.ok).toBe(false)
      expect(proposalResult.path).toBeUndefined()
    })
  })

  describe('2. tenders:get-stored-data and tenders:save-stored-data Handlers', () => {
    it('getStoredData returns stored JSON from disk or null when absent', async () => {
      const getHandler = ipcHandlers.get(TENDERS_CHANNELS.getStoredData)
      expect(getHandler).toBeDefined()
      const sender = registeredWebContents()

      // Before file exists
      const initial = await getHandler!(event(sender))
      expect(initial).toBeNull()

      // After writing store file
      const storeFile = join(testDir, 'tenders', 'tenders-data.json')
      const data = legacySeedFixture()
      data.workspaces[0].company.tradingName = 'Thabo Engineering IPC Test'
      writeTendersStore(storeFile, data)

      const retrieved = await getHandler!(event(sender))
      expect(retrieved).not.toBeNull()
      const parsed = JSON.parse(retrieved)
      expect(parsed.workspaces[0].company.tradingName).toBe('Thabo Engineering IPC Test')
    })

    it('saveStoredData accepts only a schema-v2 document and commits it through the authoritative store', async () => {
      const saveHandler = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)
      expect(saveHandler).toBeDefined()
      const recorder = deliveryRecorder()
      const sender = registeredWebContents(recorder.send)

      const dataToSave = v2WithSeedTender(0)
      // Distinctive CONTENT, not just metadata: what the caller supplied must be
      // what lands on disk (the revision/updatedAt assertions below only prove
      // the store, not the payload, was committed).
      dataToSave.workspaces[0].tenders[0].estimatedValue = 999000
      dataToSave.workspaces[0].company.tradingName = 'Legacy v2 content marker'

      const result = await saveHandler!(event(sender), JSON.stringify(dataToSave))
      expect(result).toEqual({ ok: true })

      const storeFile = join(testDir, 'tenders', 'tenders-data.json')
      expect(existsSync(storeFile)).toBe(true)
      const onDisk = JSON.parse(readFileSync(storeFile, 'utf8'))
      expect(onDisk.workspaces[0].tenders[0].estimatedValue).toBe(999000)
      expect(onDisk.workspaces[0].company.tradingName).toBe('Legacy v2 content marker')
      // The store owns the revision and the timestamp; the legacy channel never
      // writes the file itself.
      expect(onDisk.schemaVersion).toBe(2)
      expect(onDisk.revision).toBe(1)
      expect(onDisk).not.toHaveProperty('version')
      expect(
        recorder.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL),
      ).toHaveLength(1)
    })

    it('saveStoredData rejects a v1 payload and can no longer synthesize seed data into the store', async () => {
      const saveHandler = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)
      expect(saveHandler).toBeDefined()
      const sender = registeredWebContents()

      const result = await saveHandler!(event(sender), JSON.stringify(validV1()))

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/schema-v2/i)
      // No store file was created, so no demo company/vault/tender was seeded.
      expect(existsSync(storeFile)).toBe(false)
      expect(readdirSync(join(testDir, 'tenders'))).not.toContain('tenders-data.json')
    })

    it('getStoredData rejects an unregistered caller with a typed failure and no read exposure', async () => {
      const getHandler = ipcHandlers.get(TENDERS_CHANNELS.getStoredData)
      expect(getHandler).toBeDefined()
      const unregisteredSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn() }

      // Seed an authoritative-looking legacy file that must not leak to the caller.
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const secretBytes = JSON.stringify({ version: 1, marker: 'must-not-be-read' }, null, 2)
      writeFileSync(storeFile, secretBytes, 'utf8')

      const result = await getHandler!(event(unregisteredSender as any))

      expect(typeof result).toBe('object')
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: expect.stringMatching(/authoriz|registered Tenders WebContents/i),
        },
      })
      expect(JSON.stringify(result)).not.toContain('must-not-be-read')
      expect(readFileSync(storeFile, 'utf8')).toBe(secretBytes)
    })

    it('saveStoredData rejects an unregistered caller with a typed failure and no write or broadcast', async () => {
      const saveHandler = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)
      expect(saveHandler).toBeDefined()
      const unregisteredSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
      const payload = JSON.stringify(legacySeedFixture())

      const result = await saveHandler!(event(unregisteredSender as any), payload)

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: expect.stringMatching(/authoriz|registered Tenders WebContents/i),
        },
      })
      expect(existsSync(storeFile)).toBe(false)
      expect(unregisteredSender.send).not.toHaveBeenCalled()
      expect(mockBroadcasts).toHaveLength(0)
    })
  })

  describe('2b. Phase 2 additive typed persistence IPC (RED)', () => {
    it('registers load/save v2 handlers and rejects unregistered senders with typed authorization failures and no effects', async () => {
      const loadHandler = ipcHandlers.get(LOAD_STORE_V2_CHANNEL)
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)
      expect(loadHandler).toBeDefined()
      expect(saveHandler).toBeDefined()
      const unregisteredSender: any = {
        isDestroyed: () => false,
        send: vi.fn(),
        once: vi.fn(),
      }

      const loadResult = await loadHandler!({ sender: unregisteredSender })
      const saveResult = await saveHandler!(
        { sender: unregisteredSender },
        {
          expectedRevision: 0,
          document: validV2(0),
        },
      )

      for (const result of [loadResult, saveResult]) {
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: expect.stringMatching(/authoriz|registered Tenders WebContents/i),
          },
        })
        expect(typeof result).toBe('object')
      }
      expect(existsSync(storeFile)).toBe(false)
      expect(unregisteredSender.send).not.toHaveBeenCalled()
      expect(getActiveTendersWebContents()).not.toContain(unregisteredSender)
      expect(mockBroadcasts).toHaveLength(0)
    })

    it('authorized load returns a genuinely empty not-found v2 revision zero without creating a file or demo data', async () => {
      const loadHandler = ipcHandlers.get(LOAD_STORE_V2_CHANNEL)
      expect(loadHandler).toBeDefined()
      const sender = registeredWebContents()

      const result = await loadHandler!(event(sender))

      expect(result).toEqual({
        ok: true,
        status: 'not-found',
        data: {
          schemaVersion: 2,
          revision: 0,
          updatedAt: expect.any(String),
          activeCompanyId: null,
          workspaces: [],
          issuerTemplates: [],
        },
        needsSave: false,
        warnings: [],
      })
      expect(typeof result).toBe('object')
      expect(JSON.stringify(result.data)).not.toMatch(/co-thabo|tender-wtr-04|vd-tax|demo/i)
      expect(existsSync(storeFile)).toBe(false)
    })

    it('authorized load migrates a valid v1 file in memory at revision zero while preserving data and source bytes', async () => {
      const loadHandler = ipcHandlers.get(LOAD_STORE_V2_CHANNEL)
      expect(loadHandler).toBeDefined()
      const sender = registeredWebContents()
      const input = validV1()
      const originalBytes = JSON.stringify(input, null, 2)
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      writeFileSync(storeFile, originalBytes, 'utf8')

      const result = await loadHandler!(event(sender))

      expect(result).toMatchObject({
        ok: true,
        status: 'migrated',
        needsSave: true,
        data: {
          schemaVersion: 2,
          revision: 0,
          activeCompanyId: input.activeCompanyId,
        },
      })
      expect(result.data.workspaces[0].company.tradingName).toBe('IPC migration marker')
      expect(result.data.workspaces[0].dataOrigin).toBeDefined()
      expect(readFileSync(storeFile, 'utf8')).toBe(originalBytes)
    })

    it('authorized load returns the exact revision and data from a valid v2 file', async () => {
      const loadHandler = ipcHandlers.get(LOAD_STORE_V2_CHANNEL)
      expect(loadHandler).toBeDefined()
      const sender = registeredWebContents()
      const input = validV2(7)
      input.issuerTemplates.push({
        id: 'ipc-v2-issuer',
        name: 'IPC v2 issuer',
        displayName: 'IPC v2 issuer',
        address: null,
        contact: null,
        refStyle: null,
        submissionMethod: null,
        submissionAddress: null,
        seenCount: 1,
        lastSeen: '2026-09-01T08:30:00.000Z',
      })
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      writeFileSync(storeFile, JSON.stringify(input, null, 2), 'utf8')

      const result = await loadHandler!(event(sender))

      expect(result).toEqual({
        ok: true,
        status: 'loaded',
        data: input,
        needsSave: false,
        warnings: [],
      })
      expect(typeof result).toBe('object')
    })

    it('authorized save commits revision one on disk before broadcasting the exact typed document to sender and every registered view', async () => {
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)
      expect(saveHandler).toBeDefined()
      const deliveries: Array<{
        recipient: string
        channel: string
        data: unknown
        diskAtDelivery: unknown
      }> = []
      const makeReceiver = (recipient: string) =>
        registeredWebContents((channel, data) => {
          if (channel !== STORE_CHANGED_V2_CHANNEL) return
          deliveries.push({
            recipient,
            channel,
            data,
            diskAtDelivery: JSON.parse(readFileSync(storeFile, 'utf8')),
          })
        })
      const sender = makeReceiver('sender')
      makeReceiver('other-view')
      const requested = validV2(0)

      const result = await saveHandler!(event(sender), { expectedRevision: 0, document: requested })

      expect(result).toEqual({
        ok: true,
        data: {
          ...requested,
          revision: 1,
          updatedAt: expect.any(String),
        },
      })
      expect(typeof result).toBe('object')
      expect(typeof result.data).toBe('object')
      const disk = JSON.parse(readFileSync(storeFile, 'utf8'))
      expect(disk).toEqual(result.data)
      expect(deliveries).toHaveLength(2)
      expect(deliveries.map(({ recipient }) => recipient).sort()).toEqual(['other-view', 'sender'])
      for (const delivery of deliveries) {
        expect(delivery.channel).toBe(STORE_CHANGED_V2_CHANNEL)
        expect(delivery.data).toEqual(result.data)
        expect(typeof delivery.data).toBe('object')
        expect(delivery.diskAtDelivery).toEqual(result.data)
      }

      result.data.issuerTemplates.push({
        id: 'caller-mutation',
        name: 'Caller mutation',
        displayName: 'Caller mutation',
        address: null,
        contact: null,
        refStyle: null,
        submissionMethod: null,
        submissionAddress: null,
        seenCount: 0,
        lastSeen: '2026-09-01T08:30:00.000Z',
      })
      expect(JSON.parse(readFileSync(storeFile, 'utf8'))).toEqual(disk)
    })

    it('rejects stale saves with a compact typed snapshot and performs no write or broadcast', async () => {
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)
      expect(saveHandler).toBeDefined()
      const sends = vi.fn()
      const sender = registeredWebContents(sends)
      const current = validV2(4)
      const stale = validV2(3)
      const originalBytes = JSON.stringify(current, null, 2)
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      writeFileSync(storeFile, originalBytes, 'utf8')

      const result = await saveHandler!(event(sender), { expectedRevision: 3, document: stale })

      // Compact conflict payload: the error and the current revision only — the
      // full authoritative document never crosses IPC.
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'REVISION_CONFLICT' },
        currentRevision: current.revision,
      })
      expect(result).not.toHaveProperty('data')
      expect(result).not.toHaveProperty('current')
      expect(result.error).not.toHaveProperty('current')
      expect(JSON.stringify(result)).not.toContain('"workspaces"')
      expect(readFileSync(storeFile, 'utf8')).toBe(originalBytes)
      expect(sends).not.toHaveBeenCalledWith(STORE_CHANGED_V2_CHANNEL, expect.anything())
    })

    it.each([
      ['invalid', { ...validV2(0), activeCompanyId: 'missing-workspace' }, 'INVALID_DATA'],
      ['future', { ...validV2(0), schemaVersion: 99 }, 'UNSUPPORTED_SCHEMA_VERSION'],
    ])(
      'rejects %s data on load and save without writing or broadcasting',
      async (_label, document, code) => {
        const loadHandler = ipcHandlers.get(LOAD_STORE_V2_CHANNEL)
        const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)
        expect(loadHandler).toBeDefined()
        expect(saveHandler).toBeDefined()
        const sends = vi.fn()
        const sender = registeredWebContents(sends)
        const originalBytes = JSON.stringify(document, null, 2)
        mkdirSync(join(testDir, 'tenders'), { recursive: true })
        writeFileSync(storeFile, originalBytes, 'utf8')

        const loadResult = await loadHandler!(event(sender))

        expect(loadResult).toMatchObject({ ok: false, error: { code } })
        expect(loadResult).not.toHaveProperty('data')
        expect(readFileSync(storeFile, 'utf8')).toBe(originalBytes)
        rmSync(storeFile, { force: true })

        const saveResult = await saveHandler!(event(sender), { expectedRevision: 0, document })

        expect(saveResult).toMatchObject({ ok: false, error: { code } })
        expect(saveResult).not.toHaveProperty('data')
        expect(existsSync(storeFile)).toBe(false)
        expect(sends).not.toHaveBeenCalledWith(STORE_CHANGED_V2_CHANNEL, expect.anything())
      },
    )

    it('a v1 payload can no longer create or downgrade the store, and a v2 payload must match the current revision', async () => {
      const legacySave = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)
      expect(legacySave).toBeDefined()
      const legacyGet = ipcHandlers.get(TENDERS_CHANNELS.getStoredData)
      expect(legacyGet).toBeDefined()
      const sender = registeredWebContents()
      const inputV1 = validV1()

      // No file exists yet: the v1 payload is still refused, so it cannot seed
      // demo company/vault/tender data into the user's store.
      const compatibilityResult = await legacySave!(event(sender), JSON.stringify(inputV1))

      expect(compatibilityResult.ok).toBe(false)
      expect(existsSync(storeFile)).toBe(false)

      const establishedV2 = validV2(12)
      const establishedBytes = JSON.stringify(establishedV2, null, 2)
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      writeFileSync(storeFile, establishedBytes, 'utf8')
      await legacyGet!(event(sender))
      expect(readFileSync(storeFile, 'utf8')).toBe(establishedBytes)

      const downgrade = validV1()
      downgrade.workspaces[0].company.tradingName = 'Must never overwrite v2'
      const rejected = await legacySave!(event(sender), JSON.stringify(downgrade))

      expect(rejected.ok).toBe(false)
      expect(rejected.error).toBeDefined()
      expect(readFileSync(storeFile, 'utf8')).toBe(establishedBytes)

      // A v2 payload for a stale revision is a conflict, not a write.
      const stale = await legacySave!(event(sender), JSON.stringify(validV2(11)))
      expect(stale.ok).toBe(false)
      expect(stale.error).toMatch(/revision|conflict/i)
      expect(readFileSync(storeFile, 'utf8')).toBe(establishedBytes)

      // The same payload at the current revision commits through the store.
      const accepted = await legacySave!(event(sender), JSON.stringify(validV2(12)))
      expect(accepted).toEqual({ ok: true })
      expect(JSON.parse(readFileSync(storeFile, 'utf8')).revision).toBe(13)
    })

    it.each([2, 3])(
      'legacy save refuses to overwrite an authoritative document with integer schemaVersion %i',
      async (schemaVersion) => {
        const legacySave = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)
        expect(legacySave).toBeDefined()
        const sender = registeredWebContents()
        mkdirSync(join(testDir, 'tenders'), { recursive: true })
        const authoritative = { schemaVersion, revision: 9, marker: 'authoritative-bytes' }
        const authoritativeBytes = JSON.stringify(authoritative, null, 2)
        writeFileSync(storeFile, authoritativeBytes, 'utf8')

        const result = await legacySave!(event(sender), JSON.stringify(validV1()))

        expect(result.ok).toBe(false)
        expect(result.error).toBeDefined()
        expect(readFileSync(storeFile, 'utf8')).toBe(authoritativeBytes)
      },
    )

    it('keeps a durably committed save successful when a post-commit broadcast throws', async () => {
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)
      expect(saveHandler).toBeDefined()
      const sender = registeredWebContents((channel) => {
        if (channel === STORE_CHANGED_V2_CHANNEL) throw new Error('simulated broadcast failure')
      })

      const result = await saveHandler!(event(sender), {
        expectedRevision: 0,
        document: validV2(0),
      })

      expect(result.ok).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.data.revision).toBe(1)
      expect(JSON.parse(readFileSync(storeFile, 'utf8'))).toEqual(result.data)
      if (result.postCommitError !== undefined) {
        expect(result.postCommitError).toMatch(/simulated broadcast failure/)
      }
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
      const fullRfp = join(
        getTendersDocumentsDir(testDir),
        rfpResult.storedPath!.replace('documents/', ''),
      )
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

    // The lexical checks above are necessary and not sufficient. `..` handling in
    // text cannot see a symlink: a link planted at a managed leaf — or replacing
    // `documents/` itself — passes every check above and still resolves outside
    // the Tenders directory. These tests plant the links and prove the refusal.
    it('refuses a leaf that is a symlink out of the base directory', async () => {
      const saved = await saveDocumentFile(
        { fileName: 'genuine.pdf', buffer: Buffer.from('genuine'), category: 'rfp' },
        testDir,
      )
      expect(saved.ok).toBe(true)
      const leaf = saved.storedPath!.replace('documents/', '')
      const leafPath = join(getTendersDocumentsDir(testDir), leaf)
      const secret = join(testDir, 'outside-secret.pdf')
      writeFileSync(secret, 'outside bytes', 'utf8')

      // A symlink the app did not write now sits where the managed document was.
      rmSync(leafPath, { force: true })
      symlinkSync(secret, leafPath, 'file')

      // The lexical resolver still says "safe" — which is exactly why the
      // confined resolver exists.
      expect(resolveSafeTendersPath(saved.storedPath!, testDir).safe).toBe(true)
      const confined = resolveConfinedTendersPath(saved.storedPath!, testDir)
      expect(confined.safe).toBe(false)
      expect(confined.error).toMatch(/link|outside the Tenders data directory|not a regular/i)

      // And every read path refuses it: the bytes outside the store never cross
      // IPC, and the file is never handed to the OS.
      const read = await readDocumentFile({ storedPath: saved.storedPath! }, testDir)
      expect(read.ok).toBe(false)
      expect(read.buffer).toBeUndefined()
      rmSync(leafPath, { force: true })
      const opened = await openDocumentFile({ storedPath: saved.storedPath! }, testDir)
      expect(opened.ok).toBe(false)
      expect(openedPaths.some((p) => p === secret)).toBe(false)
    })

    it('refuses a documents/ directory that is itself a link out of the base directory', async () => {
      const outsideDir = join(testDir, 'planted-documents')
      rmSync(outsideDir, { recursive: true, force: true })
      mkdirSync(outsideDir, { recursive: true })
      const docsDir = join(testDir, 'tenders', 'documents')
      rmSync(docsDir, { recursive: true, force: true })
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      symlinkSync(outsideDir, docsDir, 'dir')

      // A save may not write into the link...
      const saved = await saveDocumentFile(
        { fileName: 'evil.pdf', buffer: Buffer.from('evil'), category: 'rfp' },
        testDir,
      )
      expect(saved.ok).toBe(false)
      expect(readdirSync(outsideDir)).toEqual([])

      // ...and neither may a read resolve through it.
      expect(resolveConfinedTendersPath('documents/evil.pdf', testDir)).toMatchObject({
        safe: false,
      })
      rmSync(docsDir, { force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    })

    it.each(['.lnk', '.url', '.pif', '.scf'])(
      'refuses to hand a %s launcher to shell.openPath',
      async (extension) => {
        const saved = await saveDocumentFile(
          {
            fileName: `shortcut${extension}`,
            buffer: Buffer.from('not a document'),
            category: 'rfp',
          },
          testDir,
        )
        expect(saved.ok).toBe(true)

        const opened = await openDocumentFile({ storedPath: saved.storedPath! }, testDir)

        expect(opened.ok).toBe(false)
        expect(opened.error).toMatch(/launcher or shortcut/i)
        // `shell.openPath` was never reached, so the OS never followed the link.
        expect(openedPaths).toEqual([])
      },
    )

    it.each(['.docm', '.dotm', '.xlsm', '.xltm', '.xlam', '.pptm', '.potm', '.ppsm', '.sldm'])(
      'refuses to hand a %s macro container to shell.openPath',
      async (extension) => {
        const saved = await saveDocumentFile(
          {
            fileName: `third-party-tender${extension}`,
            buffer: Buffer.from('a container that may carry a VBA project'),
            category: 'rfp',
          },
          testDir,
        )
        // The file is still STORED — ingest is a separate decision from launch, and
        // a refusal to open must not silently discard the user's document.
        expect(saved.ok).toBe(true)

        const opened = await openDocumentFile({ storedPath: saved.storedPath! }, testDir)

        expect(opened.ok).toBe(false)
        // Honest copy: a macro container is not claimed to be a launcher.
        expect(opened.error).toMatch(/macros/i)
        expect(opened.error).not.toMatch(/launcher or shortcut/i)
        // The OS never received the path, so nothing ran.
        expect(openedPaths).toEqual([])
      },
    )

    it('still opens a macro-free document, so the refusal is not blanket', async () => {
      const saved = await saveDocumentFile(
        { fileName: 'ordinary-rfp.docx', buffer: Buffer.from('a plain document'), category: 'rfp' },
        testDir,
      )
      expect(saved.ok).toBe(true)

      const opened = await openDocumentFile({ storedPath: saved.storedPath! }, testDir)
      expect(opened.ok).toBe(true)
      expect(openedPaths).toHaveLength(1)
    })
  })

  describe('4b. The legacy v1 stack is retired, not merely quiet', () => {
    it('reads a genuine v1 file back without synthesizing any demo record', () => {
      // A user who deleted every customer, vault document and tender keeps them
      // deleted. The reader used to hand back MOCK_CUSTOMERS, MOCK_VAULT and
      // SEED_TENDER_WTR_04 for this exact payload.
      const emptied = {
        version: 1,
        updatedAt: '2026-08-20T09:15:30.000Z',
        activeCompanyId: SEED_COMPANY_ID,
        workspaces: [
          {
            id: SEED_COMPANY_ID,
            name: 'Thabo Engineering (Pty) Ltd',
            company: { ...MOCK_COMPANY },
            customers: [],
            vault: [],
            tenders: [],
          },
        ],
        issuerTemplates: [],
      }

      const read = migrateAndValidateTenders(emptied)

      expect(read.workspaces).toHaveLength(1)
      expect(read.workspaces[0].customers).toEqual([])
      expect(read.workspaces[0].vault).toEqual([])
      expect(read.workspaces[0].tenders).toEqual([])
      expect(JSON.stringify(read)).not.toContain(SEED_TENDER_WTR_04.referenceNumber)
    })

    it.each([
      { label: 'a null payload', payload: null },
      { label: 'a non-object payload', payload: 12345 },
      { label: 'an array', payload: [] },
      { label: 'a version that is not a number', payload: { version: 'one' } },
    ])('refuses to read $label into a document', ({ payload }) => {
      expect(() => migrateAndValidateTenders(payload)).toThrow(/not a JSON document|version/i)
    })

    it('does not start the legacy file watcher during IPC registration', async () => {
      // The watcher read `tenders-data.json` back on every change and broadcast it
      // on `tenders:data-changed`, a channel with zero subscribers. Registration
      // must not put a live `fs.watch` on the shipping process, so: write the
      // legacy file and prove nothing is broadcast back.
      resetTendersIpcForTests()
      diagnosticsLogForTests()
      configureTendersRuntime({
        preloadPath: '',
        rendererUrl: TRUSTED_RENDERER_URL,
        rendererFile: '',
      })
      registerTendersIpc()

      const deliveries: string[] = []
      registerTendersWebContents(
        registeredWebContents((channel: string) => deliveries.push(channel)),
      )
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      writeFileSync(storeFile, JSON.stringify(legacySeedFixture(), null, 2), 'utf8')

      // Comfortably past the watcher's 100 ms debounce.
      await new Promise((resolve) => setTimeout(resolve, 350))

      expect(deliveries).not.toContain(TENDERS_CHANNELS.dataChanged)
      expect(mockBroadcasts.filter((b) => b.channel === TENDERS_CHANNELS.dataChanged)).toEqual([])
    })
  })

  describe('4c. Diagnostics transport', () => {
    it('records a renderer entry through the main sink and answers where the log is', async () => {
      const recorded = diagnosticsLogForTests()
      const record = ipcHandlers.get(TENDERS_CHANNELS.diagnosticsRecord)!
      const path = ipcHandlers.get(TENDERS_CHANNELS.diagnosticsPath)!

      const written = await record(event(trustedSender()), {
        level: 'warn',
        source: 'renderer-store',
        message: 'A save was refused.',
        detail: { code: 'STORE_REFUSED' },
      })
      expect(written).toEqual({ ok: true })
      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toMatchObject({
        level: 'warn',
        source: 'renderer-store',
        message: 'A save was refused.',
      })

      const location = await path(event(trustedSender()))
      expect(location.ok).toBe(true)
      expect(location.path).toBe('/tmp/tenders-test-diagnostics.log')
    })

    it.each([
      { label: 'an unknown level', request: { level: 'fatal', source: 'a', message: 'b' } },
      { label: 'an empty source', request: { level: 'info', source: '  ', message: 'b' } },
      {
        label: 'an over-long source',
        request: { level: 'info', source: 'x'.repeat(65), message: 'b' },
      },
      { label: 'an empty message', request: { level: 'info', source: 'a', message: '' } },
      {
        label: 'an over-long message',
        request: { level: 'info', source: 'a', message: 'x'.repeat(2001) },
      },
      {
        label: 'a non-object detail',
        request: { level: 'info', source: 'a', message: 'b', detail: 'nope' },
      },
      {
        label: 'detail with too many keys',
        request: {
          level: 'info',
          source: 'a',
          message: 'b',
          detail: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i])),
        },
      },
    ])('refuses $label and records nothing', async ({ request }) => {
      const recorded = diagnosticsLogForTests()
      const record = ipcHandlers.get(TENDERS_CHANNELS.diagnosticsRecord)!

      const result = await record(event(trustedSender()), request)

      expect(result.ok).toBe(false)
      expect(result.error).toBeTruthy()
      expect(recorded).toHaveLength(0)
    })

    it('refuses every untrusted sender for both diagnostics channels', async () => {
      const recorded = diagnosticsLogForTests()
      for (const attempt of untrustedAttempts()) {
        const record = await ipcHandlers.get(TENDERS_CHANNELS.diagnosticsRecord)!(
          attempt.eventArg,
          { level: 'info', source: 'a', message: 'b' },
        )
        const path = await ipcHandlers.get(TENDERS_CHANNELS.diagnosticsPath)!(attempt.eventArg)
        expect.soft(record.ok, `${attempt.label} must not record`).toBe(false)
        expect.soft(path.ok, `${attempt.label} must not read the path`).toBe(false)
        expect.soft(path.path).toBeUndefined()
      }
      expect(recorded).toHaveLength(0)
    })

    it('reaches the sink for a read failure and a refused save on the store channels', async () => {
      const recorded = diagnosticsLogForTests()
      const loadHandler = ipcHandlers.get(TENDERS_CHANNELS.loadStoreV2)!
      const saveHandler = ipcHandlers.get(TENDERS_CHANNELS.saveStoreV2)!
      const sender = trustedSender()
      await saveHandler(event(sender), { expectedRevision: 0, document: validV2(0) })

      // Corrupt the primary: the load must report the failure AND leave a trace.
      writeFileSync(storeFile, '{broken', 'utf8')
      const load = await loadHandler(event(sender))
      expect(load.ok).toBe(false)
      expect(recorded.some((entry) => entry.source === 'store' && entry.level === 'error')).toBe(
        true,
      )

      // A stale save is a refusal the user sees as "my edit did not stick".
      recorded.length = 0
      const stale = await saveHandler(event(sender), { expectedRevision: 0, document: validV2(0) })
      expect(stale.ok).toBe(false)
      expect(recorded.some((entry) => entry.source === 'store' && entry.level === 'warn')).toBe(
        true,
      )
    })

    it('fails the legacy read closed on an unreadable file and names a recovery copy', async () => {
      const recorded = diagnosticsLogForTests()
      const getStoredData = ipcHandlers.get(TENDERS_CHANNELS.getStoredData)!
      const sender = trustedSender()

      // No file at all is the one genuinely-empty answer: `null`, not a stub.
      expect(await getStoredData(event(sender))).toBeNull()

      // A file that exists but cannot be parsed is NOT reported as "no saved
      // data" — that reads as data loss. It fails closed with the recovery shape.
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      writeFileSync(storeFile, '{ "version": 1, [BAD DATA]', 'utf8')

      const result = await getStoredData(event(sender))

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'RECOVERY_REQUIRED',
          message: expect.stringMatching(/could not be read/i),
        },
      })
      expect(result).not.toBeNull()
      expect(result.workspaces).toBeUndefined()
      // The quarantined copy is what the user is pointed at, and the failure is
      // in the diagnostics record.
      expect(existsSync(`${storeFile}.corrupted.bak`)).toBe(true)
      expect(result.recoveryCandidates?.[0]?.id).toBe('tenders-data.json.corrupted.bak')
      expect(
        recorded.some(
          (entry) => entry.level === 'error' && /could not be read/i.test(entry.message),
        ),
      ).toBe(true)
    })
  })

  describe('5. Cross-App Handlers: CRM, Sheets, Docs, and Books', () => {
    it('syncWithCrm keeps the authoritative v2 document, increments revision once, and broadcasts it', async () => {
      const syncHandler = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
      expect(syncHandler).toBeDefined()
      const recorder = deliveryRecorder()
      const sender = registeredWebContents(recorder.send)
      const storePath = join(testDir, 'tenders', 'tenders-data.json')
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const starting = v2WithSeedTender(5)
      writeFileSync(storePath, JSON.stringify(starting, null, 2), 'utf8')
      const tender = starting.workspaces[0].tenders[0]
      const crmDealsPath = join(testDir, 'crm', 'deals.json')

      const result = await syncHandler!(event(sender), {
        tender,
        tenderId: tender.id,
        crmDealsPath,
        tendersPath: storePath,
        userDataDir: testDir,
      })

      expect(result.ok).toBe(true)
      expect(result.dealId).toBe(`deal-tender-${tender.id}`)

      // Verify deals.json written with the expected authoritative fields
      expect(existsSync(crmDealsPath)).toBe(true)
      const crmEnvelope = JSON.parse(readFileSync(crmDealsPath, 'utf8'))
      const deal = crmEnvelope.deals.find((d: any) => d.id === `deal-tender-${tender.id}`)
      expect(deal).toBeDefined()
      expect(deal.tenderReference).toBe(tender.referenceNumber)
      expect(deal.amount).toBe(tender.estimatedValue)
      expect(deal.expectedCloseDate).toBe(tender.closingDate)

      // The persisted Tenders document must stay authoritative v2 at revision 6
      const disk = JSON.parse(readFileSync(storePath, 'utf8'))
      expect(disk.schemaVersion).toBe(2)
      expect(disk).not.toHaveProperty('version')
      expect(disk.revision).toBe(6)
      const backLinked = disk.workspaces[0].tenders.find((t: any) => t.id === tender.id)
      expect(backLinked.linkedCrmDealId).toBe(`deal-tender-${tender.id}`)

      const v2Deliveries = recorder.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL)
      expect(v2Deliveries).toHaveLength(1)
      expect(v2Deliveries[0].data).toEqual(disk)

      // Re-sync updates in place without downgrading the schema or duplicating the deal
      const resync = await syncHandler!(event(sender), {
        tender: { ...tender, estimatedValue: 300000 },
        tenderId: tender.id,
        crmDealsPath,
        tendersPath: storePath,
        userDataDir: testDir,
      })
      expect(resync.ok).toBe(true)
      const afterResync = JSON.parse(readFileSync(crmDealsPath, 'utf8'))
      expect(
        afterResync.deals.filter((d: any) => d.id === `deal-tender-${tender.id}`),
      ).toHaveLength(1)
      expect(afterResync.deals[0].amount).toBe(300000)
      expect(JSON.parse(readFileSync(storePath, 'utf8')).schemaVersion).toBe(2)
    })

    it('syncWithCrm reports a conflict instead of silently overwriting a newer authoritative revision', async () => {
      const syncHandler = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
      expect(syncHandler).toBeDefined()
      const recorder = deliveryRecorder()
      const sender = registeredWebContents(recorder.send)
      const storePath = join(testDir, 'tenders', 'tenders-data.json')
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const current = v2WithSeedTender(5)
      const currentBytes = JSON.stringify(current, null, 2)
      writeFileSync(storePath, currentBytes, 'utf8')
      const tender = current.workspaces[0].tenders[0]

      // The caller believes it is working from revision 4, but the authoritative
      // document is already at revision 5.
      const result = await syncHandler!(event(sender), {
        tender,
        tenderId: tender.id,
        expectedRevision: 4,
        crmDealsPath: join(testDir, 'crm', 'deals.json'),
        tendersPath: storePath,
        userDataDir: testDir,
      })

      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).toMatch(/conflict|revision/i)
      expect(readFileSync(storePath, 'utf8')).toBe(currentBytes)
      expect(
        recorder.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL),
      ).toHaveLength(0)
    })

    it('syncWithCrm does not report success and does not back-link when the CRM upsert fails', async () => {
      const syncHandler = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
      expect(syncHandler).toBeDefined()
      const recorder = deliveryRecorder()
      const sender = registeredWebContents(recorder.send)
      const storePath = join(testDir, 'tenders', 'tenders-data.json')
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const starting = v2WithSeedTender(5)
      const startingBytes = JSON.stringify(starting, null, 2)
      writeFileSync(storePath, startingBytes, 'utf8')
      const tender = starting.workspaces[0].tenders[0]

      // The CRM port refuses the write. Telling the caller `ok: true` here is the
      // lying success this test exists to prevent: the deal does not exist, so
      // the authoritative document must not claim a back-link to it either.
      configureTendersRuntime({
        preloadPath: '',
        rendererFile: '',
        integrations: {
          upsertTenderOpportunity: async () => ({ ok: false, error: 'CRM store is read-only.' }),
        },
      })

      try {
        const result = await syncHandler!(event(sender), { tender, tenderId: tender.id })

        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/CRM store is read-only/i)
        // The authoritative document is byte-identical: no back-link, no revision.
        expect(readFileSync(storePath, 'utf8')).toBe(startingBytes)
        expect(
          recorder.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL),
        ).toHaveLength(0)
      } finally {
        // `configureTendersRuntime` only ever SETS an injection (`{}` is the
        // explicit "integrations disabled" state), so an injected port outlives
        // the test that installed it and every later test in this file would run
        // with its own upsert removed. The reset hook is what actually clears it.
        resetTendersIntegrationsForTests()
      }
    })

    it('syncWithCrm does not report success when the CRM upsert throws', async () => {
      const syncHandler = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
      expect(syncHandler).toBeDefined()
      const sender = registeredWebContents()
      const storePath = join(testDir, 'tenders', 'tenders-data.json')
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const starting = v2WithSeedTender(5)
      const startingBytes = JSON.stringify(starting, null, 2)
      writeFileSync(storePath, startingBytes, 'utf8')
      const tender = starting.workspaces[0].tenders[0]

      configureTendersRuntime({
        preloadPath: '',
        rendererFile: '',
        integrations: {
          upsertTenderOpportunity: async () => {
            throw new Error('CRM app is not running')
          },
        },
      })

      try {
        const result = await syncHandler!(event(sender), { tender, tenderId: tender.id })

        expect(result.ok).toBe(false)
        expect(String(result.error)).toMatch(/CRM app is not running/)
        expect(readFileSync(storePath, 'utf8')).toBe(startingBytes)
      } finally {
        resetTendersIntegrationsForTests()
      }
    })

    it('syncWithCrm reports a failed back-link honestly instead of claiming a clean sync', async () => {
      const syncHandler = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
      expect(syncHandler).toBeDefined()
      const sender = registeredWebContents()
      const storePath = join(testDir, 'tenders', 'tenders-data.json')
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const starting = v2WithSeedTender(5)
      // A read-only store file: the CRM port succeeds, the back-link cannot be
      // written. The deal exists, so the sync is NOT complete and must not be
      // reported as one.
      writeFileSync(storePath, JSON.stringify(starting, null, 2), 'utf8')
      chmodSync(storePath, 0o444)
      const tender = starting.workspaces[0].tenders[0]
      const upserts: unknown[] = []

      configureTendersRuntime({
        preloadPath: '',
        rendererFile: '',
        integrations: {
          upsertTenderOpportunity: async (input: unknown) => {
            upserts.push(input)
            return { ok: true, dealId: `deal-tender-${tender.id}` }
          },
        },
      })

      try {
        const result = await syncHandler!(event(sender), { tender, tenderId: tender.id })

        expect(upserts).toHaveLength(1)
        expect(result.ok).toBe(false)
        expect(String(result.error)).toMatch(/could not be linked/i)
        expect(result.dealId).toBe(`deal-tender-${tender.id}`)
      } finally {
        chmodSync(storePath, 0o666)
        resetTendersIntegrationsForTests()
      }
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
      const exportSender = registeredWebContents()

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

      const res = await exportHandler!(
        event(exportSender),
        't-01',
        'Bulk Water Refurbishment',
        rows,
      )
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

      const registeredSender = registeredWebContents()

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
        milestones: [{ name: 'Phase 1 Mobilization', amount: 145000, dueDate: '2026-08-30' }],
      }

      const res = await draftHandler!(event(registeredSender), tender)
      expect(res.ok).toBe(true)
      expect(existsSync(res.path)).toBe(true)
      expect(generatedPaths).toContain(res.path)

      const content = readFileSync(res.path, 'utf8')
      expect(content).toContain('Commercial & Technical Tender Proposal')
      expect(content).toContain('RFP-WTR-2026-04')
      expect(content).toContain('City of Ekurhuleni')
      expect(content).toContain('Phase 1 Mobilization')
    })

    it('billMilestoneInBooks validates REACHED status and keeps the authoritative v2 document at revision plus one', async () => {
      const billHandler = ipcHandlers.get(TENDERS_CHANNELS.billMilestoneInBooks)
      expect(billHandler).toBeDefined()
      const recorder = deliveryRecorder()
      const sender = registeredWebContents(recorder.send)
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const starting = v2WithSeedTender(7)
      // Billing is won-only (main mirrors shared/lifecycle `milestonesAllowed`).
      starting.workspaces[0].tenders[0].status = 'WON'
      writeFileSync(storeFile, JSON.stringify(starting, null, 2), 'utf8')

      // Milestone ms-02 is PENDING -> should be rejected without touching the revision
      const rejectPending = await billHandler!(event(sender), 'tender-wtr-04', 'ms-02')
      expect(rejectPending.ok).toBe(false)
      expect(rejectPending.error).toContain('not in REACHED status')
      expect(JSON.parse(readFileSync(storeFile, 'utf8')).revision).toBe(7)

      // Milestone ms-01 is REACHED -> should succeed and commit revision 8
      const billSuccess = await billHandler!(event(sender), 'tender-wtr-04', 'ms-01')
      expect(billSuccess.ok).toBe(true)
      expect(billSuccess.invoiceNumber).toMatch(/^INV-\d{4}-\d{3}$/)
      expect(billSuccess.grandTotal).toBe(145000)

      const disk = JSON.parse(readFileSync(storeFile, 'utf8'))
      expect(disk.schemaVersion).toBe(2)
      expect(disk).not.toHaveProperty('version')
      expect(disk.revision).toBe(8)
      const ms01 = disk.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-01')
      expect(ms01?.status).toBe('BILLED')
      expect(ms01?.billedInvoiceNumber).toBe(billSuccess.invoiceNumber)
      expect(ms01?.billedInvoiceId).toBe(billSuccess.invoiceId)

      const v2Deliveries = recorder.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL)
      expect(v2Deliveries).toHaveLength(1)
      expect(v2Deliveries[0].data).toEqual(disk)
    })

    it('billMilestoneInBooks reports a conflict instead of silently overwriting a newer authoritative revision', async () => {
      const billHandler = ipcHandlers.get(TENDERS_CHANNELS.billMilestoneInBooks)
      expect(billHandler).toBeDefined()
      const recorder = deliveryRecorder()
      const sender = registeredWebContents(recorder.send)
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const current = v2WithSeedTender(7)
      current.workspaces[0].tenders[0].status = 'WON'
      const currentBytes = JSON.stringify(current, null, 2)
      writeFileSync(storeFile, currentBytes, 'utf8')

      const result = await billHandler!(event(sender), {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        expectedRevision: 6,
      })

      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).toMatch(/conflict|revision/i)
      expect(readFileSync(storeFile, 'utf8')).toBe(currentBytes)
      expect(
        recorder.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL),
      ).toHaveLength(0)
    })
  })

  describe('6. Bridge remediation contract (cod-7 / sec-2)', () => {
    it('accepts a registered trusted top-frame sender for privileged v2 handlers', async () => {
      const loadHandler = ipcHandlers.get(LOAD_STORE_V2_CHANNEL)
      expect(loadHandler).toBeDefined()
      const sender = registeredWebContents()

      const result = await loadHandler!(event(sender, trustedFrame()))

      expect(result).toMatchObject({ ok: true, status: 'not-found' })
    })

    it.each([
      { label: 'an untrusted top-frame URL', frame: untrustedFrame() },
      { label: 'a subframe sender', frame: subFrame() },
    ])('rejects a registered sender with $label', async ({ frame }) => {
      const loadHandler = ipcHandlers.get(LOAD_STORE_V2_CHANNEL)
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)
      expect(loadHandler).toBeDefined()
      expect(saveHandler).toBeDefined()
      const sender = registeredWebContents()

      const loadResult = await loadHandler!(event(sender, frame))
      const saveResult = await saveHandler!(event(sender, frame), {
        expectedRevision: 0,
        document: validV2(0),
      })

      for (const result of [loadResult, saveResult]) {
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: expect.stringMatching(/authoriz|trusted|registered Tenders WebContents/i),
          },
        })
      }
      expect(existsSync(storeFile)).toBe(false)
    })

    it('broadcasts new v2 payloads only to registered views whose URL is the trusted renderer', async () => {
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)
      expect(saveHandler).toBeDefined()
      const trusted = deliveryRecorder()
      const untrusted = deliveryRecorder()
      const trustedSender = registeredWebContents(trusted.send, TRUSTED_RENDERER_URL)
      registeredWebContents(untrusted.send, UNTRUSTED_RENDERER_URL)

      const result = await saveHandler!(event(trustedSender), {
        expectedRevision: 0,
        document: validV2(0),
      })

      expect(result.ok).toBe(true)
      const disk = JSON.parse(readFileSync(storeFile, 'utf8'))
      const trustedV2 = trusted.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL)
      expect(trustedV2).toHaveLength(1)
      expect(trustedV2[0].data).toEqual(disk)
      expect(
        untrusted.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL),
      ).toHaveLength(0)
    })

    it('exposes a test-visible reset API that clears handlers and allows clean re-registration', async () => {
      const mod = (await import('../src/main/tenders-main')) as Record<string, unknown>
      const reset = mod.resetTendersIpcForTests
      const isRegistered = mod.isTendersIpcRegisteredForTests
      expect.soft(typeof reset).toBe('function')
      expect.soft(typeof isRegistered).toBe('function')
      if (typeof reset === 'function' && typeof isRegistered === 'function') {
        try {
          expect((isRegistered as () => boolean)()).toBe(true)
          ;(reset as () => void)()
          expect(removedHandlers.length).toBeGreaterThan(0)
          for (const channel of removedHandlers) {
            expect(ipcHandlers.has(channel)).toBe(false)
          }
          expect((isRegistered as () => boolean)()).toBe(false)
        } finally {
          registerTendersIpc()
        }
        expect((isRegistered as () => boolean)()).toBe(true)
        expect(ipcHandlers.has(TENDERS_CHANNELS.loadStoreV2)).toBe(true)
      }
    })
  })

  describe('7. Privileged bridge hardening (F1–F4)', () => {
    const privilegedCalls: Array<{ label: string; channel: string; args: unknown[] }> = [
      {
        label: 'saveDocument',
        channel: TENDERS_CHANNELS.saveDocument,
        args: [{ fileName: 'evil.pdf', buffer: Buffer.from('evil'), category: 'rfp' }],
      },
      {
        label: 'readDocument',
        channel: TENDERS_CHANNELS.readDocument,
        args: [{ storedPath: 'documents/1_evil.pdf' }],
      },
      {
        label: 'openDocument',
        channel: TENDERS_CHANNELS.openDocument,
        args: [{ storedPath: 'documents/1_evil.pdf' }],
      },
      {
        label: 'deleteDocument',
        channel: TENDERS_CHANNELS.deleteDocument,
        args: [{ storedPath: 'documents/1_evil.pdf' }],
      },
      { label: 'syncWithCrm', channel: TENDERS_CHANNELS.syncWithCrm, args: [{}] },
      {
        label: 'billMilestoneInBooks',
        channel: TENDERS_CHANNELS.billMilestoneInBooks,
        args: ['tender-wtr-04', 'ms-01'],
      },
      {
        label: 'exportMatrixToSheets',
        channel: TENDERS_CHANNELS.exportMatrixToSheets,
        args: ['t1', 'Title', []],
      },
      { label: 'openInCrm', channel: TENDERS_CHANNELS.openInCrm, args: ['deal-tender-x'] },
      { label: 'openBooks', channel: TENDERS_CHANNELS.openBooks, args: [] },
      // Tender discovery + deadline reminders (the wired engines).
      {
        label: 'discoveryList',
        channel: TENDERS_CHANNELS.discoveryList,
        args: [{ window: { from: '2026-09-01', to: '2026-09-07' } }],
      },
      { label: 'discoveryRefresh', channel: TENDERS_CHANNELS.discoveryRefresh, args: [{}] },
      { label: 'discoveryReadCache', channel: TENDERS_CHANNELS.discoveryReadCache, args: [] },
      {
        label: 'discoveryFetchRelease',
        channel: TENDERS_CHANNELS.discoveryRelease,
        args: [{ ocid: 'ocds-abc-1' }],
      },
      {
        label: 'discoveryDownloadDocument',
        channel: TENDERS_CHANNELS.discoveryDownloadDocument,
        args: [{ url: 'https://www.etenders.gov.za/Documents/RFP.pdf' }],
      },
      { label: 'getReminders', channel: TENDERS_CHANNELS.remindersGet, args: [] },
      {
        label: 'setReminders',
        channel: TENDERS_CHANNELS.remindersSet,
        args: [{ enabled: false }],
      },
      { label: 'checkReminders', channel: TENDERS_CHANNELS.remindersCheck, args: [] },
    ]

    it.each(privilegedCalls)(
      '$label rejects unregistered, untrusted-origin, and subframe callers with typed INVALID_REQUEST',
      async ({ channel, args }) => {
        const handler = ipcHandlers.get(channel)
        expect(handler, `${channel} must be registered`).toBeDefined()
        const unregisteredSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
        const untrustedSender = registeredWebContents(vi.fn(), UNTRUSTED_RENDERER_URL)
        const subframeSender = registeredWebContents(vi.fn())
        const attempts = [
          { label: 'unregistered', eventArg: event(unregisteredSender as any) },
          { label: 'untrusted-origin', eventArg: event(untrustedSender, untrustedFrame()) },
          { label: 'subframe', eventArg: event(subframeSender, subFrame()) },
        ]

        for (const attempt of attempts) {
          const result = await handler!(attempt.eventArg, ...args)
          expect.soft(result, `${channel} must reject ${attempt.label}`).toMatchObject({
            ok: false,
            error: { code: 'INVALID_REQUEST' },
          })
        }
      },
    )

    it('performs no document, export, or navigation side effects for rejected senders', async () => {
      const untrustedSender = registeredWebContents(vi.fn(), UNTRUSTED_RENDERER_URL)
      const generated: string[] = []
      let crmOpened = false
      let booksOpened = false
      configureTendersRuntime({
        preloadPath: '',
        rendererFile: '',
        openGeneratedPath: (p: string) => {
          generated.push(p)
          return true
        },
        onOpenCrm: () => {
          crmOpened = true
        },
        onOpenBooks: () => {
          booksOpened = true
        },
      })

      try {
        const rejectedFrame = untrustedFrame()
        const save = await ipcHandlers.get(TENDERS_CHANNELS.saveDocument)!(
          event(untrustedSender, rejectedFrame),
          { fileName: 'evil.pdf', buffer: Buffer.from('evil'), category: 'rfp' },
        )
        expect.soft(save).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
        const docsDir = getTendersDocumentsDir(testDir)
        expect.soft(existsSync(docsDir) ? readdirSync(docsDir).length : 0).toBe(0)

        const exported = await ipcHandlers.get(TENDERS_CHANNELS.exportMatrixToSheets)!(
          event(untrustedSender, rejectedFrame),
          't1',
          'Title',
          [],
        )
        expect.soft(exported).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
        expect.soft(generated).toHaveLength(0)

        const opened = await ipcHandlers.get(TENDERS_CHANNELS.openDocument)!(
          event(untrustedSender, rejectedFrame),
          { storedPath: 'documents/1_evil.pdf' },
        )
        expect.soft(opened).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
        expect.soft(openedPaths).toHaveLength(0)

        await ipcHandlers.get(TENDERS_CHANNELS.openInCrm)!(
          event(untrustedSender, rejectedFrame),
          'deal-x',
        )
        await ipcHandlers.get(TENDERS_CHANNELS.openBooks)!(event(untrustedSender, rejectedFrame))
        expect(crmOpened).toBe(false)
        expect(booksOpened).toBe(false)
      } finally {
        configureTendersRuntime({
          preloadPath: '',
          rendererFile: '',
          onOpenCrm: undefined,
          onOpenBooks: undefined,
          openGeneratedPath: undefined,
        })
      }
    })

    it('F2: syncWithCrm ignores renderer-supplied tendersPath, crmDealsPath, and userDataDir', async () => {
      const syncHandler = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
      expect(syncHandler).toBeDefined()
      const sender = registeredWebContents()
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const starting = v2WithSeedTender(5)
      writeFileSync(storeFile, JSON.stringify(starting, null, 2), 'utf8')
      const tender = starting.workspaces[0].tenders[0]
      const hostileDir = join(tmpdir(), `tenders-hostile-${randomUUID().slice(0, 8)}`)
      mkdirSync(hostileDir, { recursive: true })
      const hostileTendersPath = join(hostileDir, 'tenders-data.json')
      const hostileCrmPath = join(hostileDir, 'deals.json')

      try {
        const result = await syncHandler!(event(sender), {
          tender,
          tenderId: tender.id,
          tendersPath: hostileTendersPath,
          crmDealsPath: hostileCrmPath,
          userDataDir: hostileDir,
        })

        console.log('DEBUG F2 result', JSON.stringify(result))
        expect(result.ok).toBe(true)
        expect(existsSync(hostileCrmPath)).toBe(false)
        expect(existsSync(hostileTendersPath)).toBe(false)

        const disk = JSON.parse(readFileSync(storeFile, 'utf8'))
        expect(disk.schemaVersion).toBe(2)
        expect(disk.revision).toBe(6)
        expect(
          disk.workspaces[0].tenders.find((t: any) => t.id === tender.id).linkedCrmDealId,
        ).toBe(`deal-tender-${tender.id}`)

        expect(existsSync(join(testDir, 'crm', 'deals.json'))).toBe(true)
      } finally {
        rmSync(hostileDir, { recursive: true, force: true })
      }
    })

    it('F3: the legacy v2 save commit reaches trusted views only', async () => {
      const saveHandler = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)
      expect(saveHandler).toBeDefined()
      const trusted = deliveryRecorder()
      const untrusted = deliveryRecorder()
      const sender = registeredWebContents(trusted.send, TRUSTED_RENDERER_URL)
      registeredWebContents(untrusted.send, UNTRUSTED_RENDERER_URL)

      const result = await saveHandler!(event(sender), JSON.stringify(validV2(0)))

      expect(result).toEqual({ ok: true })
      const trustedCommits = trusted.deliveries.filter(
        (d) => d.channel === STORE_CHANGED_V2_CHANNEL,
      )
      expect(trustedCommits).toHaveLength(1)
      expect(trustedCommits[0].data).toMatchObject({ schemaVersion: 2, revision: 1 })
      expect(
        untrusted.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL),
      ).toHaveLength(0)
    })

    it('F3: the watcher/legacy broadcast function skips untrusted navigated views', () => {
      const trusted = deliveryRecorder()
      const untrusted = deliveryRecorder()
      registeredWebContents(trusted.send, TRUSTED_RENDERER_URL)
      registeredWebContents(untrusted.send, UNTRUSTED_RENDERER_URL)

      broadcastTendersData(legacySeedFixture())

      expect(
        trusted.deliveries.filter((d) => d.channel === TENDERS_CHANNELS.dataChanged),
      ).toHaveLength(1)
      expect(
        untrusted.deliveries.filter((d) => d.channel === TENDERS_CHANNELS.dataChanged),
      ).toHaveLength(0)
    })

    it('F4: a conflicted milestone mutate posts no invoice and a retry posts at most one', async () => {
      const billHandler = ipcHandlers.get(TENDERS_CHANNELS.billMilestoneInBooks)
      expect(billHandler).toBeDefined()
      const sender = registeredWebContents()
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const starting = v2WithSeedTender(7)
      // Billing is won-only (main mirrors shared/lifecycle `milestonesAllowed`).
      starting.workspaces[0].tenders[0].status = 'WON'
      writeFileSync(storeFile, JSON.stringify(starting, null, 2), 'utf8')
      const bytesBefore = readFileSync(storeFile, 'utf8')

      const conflict = await billHandler!(event(sender), {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        expectedRevision: 6,
      })

      expect.soft(conflict.ok).toBe(false)
      expect.soft(booksInvoiceCalls).toHaveLength(0)
      expect.soft(readFileSync(storeFile, 'utf8')).toBe(bytesBefore)

      const retry = await billHandler!(event(sender), {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        expectedRevision: 7,
      })

      expect(retry.ok).toBe(true)
      expect(booksInvoiceCalls).toHaveLength(1)
      expect(JSON.parse(readFileSync(storeFile, 'utf8')).revision).toBe(8)
    })

    it('F5: syncWithCrm conflict returns a compact error, not the full authoritative document', async () => {
      const syncHandler = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
      expect(syncHandler).toBeDefined()
      const sender = registeredWebContents()
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const current = v2WithSeedTender(5)
      writeFileSync(storeFile, JSON.stringify(current, null, 2), 'utf8')
      const tender = current.workspaces[0].tenders[0]

      const result = await syncHandler!(event(sender), {
        tender,
        tenderId: tender.id,
        expectedRevision: 4,
      })

      expect(result.ok).toBe(false)
      expect(result).not.toHaveProperty('current')
      expect(JSON.stringify(result)).not.toContain('"workspaces"')
      expect(JSON.stringify(result)).toMatch(/REVISION_CONFLICT|conflict|currentRevision/i)
    })

    it('medium: legacy downgrade guard rejects a non-integer authoritative schemaVersion', async () => {
      const legacySave = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)
      expect(legacySave).toBeDefined()
      const sender = registeredWebContents()
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const authoritative = { schemaVersion: 2.5, revision: 9, marker: 'authoritative-bytes' }
      const authoritativeBytes = JSON.stringify(authoritative, null, 2)
      writeFileSync(storeFile, authoritativeBytes, 'utf8')

      const result = await legacySave!(event(sender), JSON.stringify(validV1()))

      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
      expect(readFileSync(storeFile, 'utf8')).toBe(authoritativeBytes)
    })
  })

  describe('WP-14 IPC, export and diagnostic hardening', () => {
    it('fails closed when the trusted renderer origin is unconfigured', async () => {
      configureTendersRuntime({ preloadPath: '', rendererUrl: '', rendererFile: '' })
      const sender = registeredWebContents()
      const delivered: string[] = []
      const double: WebContentsDouble = {
        isDestroyed: () => false,
        getURL: () => TRUSTED_RENDERER_URL,
        once: vi.fn(),
        send: (channel: string) => delivered.push(channel),
      }
      // The double is written against the four members main touches; Electron's
      // `WebContents` is a 140-member class, so this cast is the boundary where
      // the partial double meets it (its shape is checked at the literal above).
      const receiver = double as WebContents
      registerTendersWebContents(receiver)

      const load = await ipcHandlers.get(LOAD_STORE_V2_CHANNEL)!(event(sender))
      expect(load).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })

      const save = await ipcHandlers.get(TENDERS_CHANNELS.saveDocument)!(event(sender), {
        fileName: 'x.pdf',
        buffer: Buffer.from('%PDF-1.4'),
        category: 'rfp',
      })
      expect(save).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })

      // Broadcasts fail closed too: no configured origin ⇒ no delivery, even to
      // a registered WebContents that reports a URL.
      broadcastTendersData(legacySeedFixture())
      expect(delivered).not.toContain(TENDERS_CHANNELS.dataChanged)

      unregisterTendersWebContents(receiver)
    })

    it('bounds saveDocument uploads and rejects immediately over the limit', async () => {
      const saveDoc = ipcHandlers.get(TENDERS_CHANNELS.saveDocument)!
      const sender = registeredWebContents()
      const docsDir = getTendersDocumentsDir(testDir)
      const countDocs = () => (existsSync(docsDir) ? readdirSync(docsDir).length : 0)
      const before = countDocs()

      const over = await saveDoc(event(sender), {
        fileName: 'huge.pdf',
        buffer: Buffer.alloc(MAX_TENDERS_DOCUMENT_UPLOAD_BYTES + 1),
        category: 'vault',
      })
      expect(over.ok).toBe(false)
      expect(over.error).toMatch(/upload limit/i)
      // Rejected before any filesystem work.
      expect(countDocs()).toBe(before)

      const atLimit = await saveDoc(event(sender), {
        fileName: 'at-limit.pdf',
        buffer: Buffer.alloc(MAX_TENDERS_DOCUMENT_UPLOAD_BYTES),
        category: 'vault',
      })
      expect(atLimit.ok).toBe(true)
      expect(typeof atLimit.storedPath).toBe('string')
    })

    it('bounds readDocument so an oversized file is never streamed back', async () => {
      const readDoc = ipcHandlers.get(TENDERS_CHANNELS.readDocument)!
      const sender = registeredWebContents()
      const vaultDir = getTendersVaultDir(testDir)
      const oversize = join(vaultDir, 'oversize.pdf')
      writeFileSync(oversize, Buffer.alloc(MAX_TENDERS_DOCUMENT_UPLOAD_BYTES + 1))

      const res = await readDoc(event(sender), { storedPath: 'vault/oversize.pdf' })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/read limit/i)

      rmSync(oversize, { force: true })
    })

    it('neutralises formula-leading CSV cells while keeping RFC 4180 quoting and the BOM', async () => {
      const exportHandler = ipcHandlers.get(TENDERS_CHANNELS.exportMatrixToSheets)!
      const sender = registeredWebContents()

      const res = await exportHandler(event(sender), 't-1', 'Formula Export', [
        {
          id: '=CMD()',
          category: '@cat',
          title: '+SUM(A1)',
          status: '-1',
          linkedDocument: '\t=2+2',
          notes: '@import',
        },
      ])
      expect(res.ok).toBe(true)

      const raw = readFileSync(res.path)
      expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf])
      const row = raw
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .split('\n')[1]
      expect(row).toContain(`"'=CMD()"`)
      expect(row).toContain(`"'@cat"`)
      expect(row).toContain(`"'+SUM(A1)"`)
      expect(row).toContain(`"'-1"`)
      expect(row).toContain(`"'\t=2+2"`)
      expect(row).toContain(`"'@import"`)
      // No cell opens directly with a formula trigger character.
      expect(row).not.toMatch(/"(?:=|\+|@|-)/)
    })

    it('bounds the matrix export rows, cells, and total payload before writing', async () => {
      const exportHandler = ipcHandlers.get(TENDERS_CHANNELS.exportMatrixToSheets)!
      const sender = registeredWebContents()

      // Sized from the export's own byte ceiling (`MAX_TENDERS_MATRIX_EXPORT_BYTES`,
      // which the handler checks before it builds the CSV) and kept under the row
      // and per-cell ceilings, so this payload is over-bound for that check alone.
      // Deliberately not the IPC envelope's `MAX_TENDERS_IPC_PAYLOAD_BYTES`, which
      // is held above the export ceiling and therefore never binds here.
      const perCell = MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS - 1
      const oversizedRowCount = Math.ceil(MAX_TENDERS_MATRIX_EXPORT_BYTES / perCell) + 2
      expect(oversizedRowCount).toBeLessThanOrEqual(MAX_TENDERS_MATRIX_EXPORT_ROWS)
      const oversizedRows = (): Array<{ notes: string }> =>
        Array.from({ length: oversizedRowCount }, () => ({ notes: 'y'.repeat(perCell) }))
      const exportedBefore = readdirSync(tmpdir()).filter((name) =>
        name.startsWith('Oversized_Compliance_Matrix_'),
      )

      const tooMany = await exportHandler(
        event(sender),
        't-1',
        'Too many',
        Array.from({ length: MAX_TENDERS_MATRIX_EXPORT_ROWS + 1 }, (_v, i) => ({ id: `r-${i}` })),
      )
      expect(tooMany.ok).toBe(false)
      expect(tooMany.error).toMatch(/limited to \d+ rows/i)

      const hugeCell = await exportHandler(event(sender), 't-1', 'Huge cell', [
        { id: 'r-1', notes: 'x'.repeat(MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS + 1) },
      ])
      expect(hugeCell.ok).toBe(false)
      expect(hugeCell.error).toMatch(/cell exceeds/i)

      const notAnArray = await exportHandler(event(sender), 't-1', 'Bad shape', {} as any)
      expect(notAnArray.ok).toBe(false)
      expect(notAnArray.error).toMatch(/must be an array/i)

      // "Before writing" is part of the claim: the refusal must leave no CSV
      // behind in the export directory (compared against a pre-call listing —
      // the OS temp directory is shared and keeps earlier runs' exports).
      const oversized = await exportHandler(event(sender), 't-1', 'Oversized', oversizedRows())
      expect(oversized.ok).toBe(false)
      expect(oversized.error).toMatch(/exceeds \d+ bytes/i)
      expect(
        readdirSync(tmpdir()).filter((name) => name.startsWith('Oversized_Compliance_Matrix_')),
      ).toEqual(exportedBefore)
    })
  })

  describe('WP-14 navigation + renderer surface hardening', () => {
    it('denies window.open and will-navigate for anything but the trusted renderer or a blob URL', () => {
      const handlers: Record<string, (...args: any[]) => any> = {}
      const webContents: any = {
        isDestroyed: () => false,
        getURL: () => TRUSTED_RENDERER_URL,
        once: vi.fn(),
        send: vi.fn(),
        setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => {
          handlers.windowOpen = handler as any
        },
        on: (event: string, listener: (...args: any[]) => any) => {
          handlers[event] = listener
        },
      }

      applyTendersNavigationPolicy(webContents)

      // A store-supplied http(s) URL must never be followed.
      expect(handlers.windowOpen({ url: 'https://attacker.example/steal' })).toEqual({
        action: 'deny',
      })
      expect(handlers.windowOpen({ url: 'file:///C:/Windows/System32/calc.exe' })).toEqual({
        action: 'deny',
      })
      // The in-session object URLs the renderer creates stay usable.
      expect(handlers.windowOpen({ url: 'blob:http://localhost:5179/abc-123' })).toEqual({
        action: 'allow',
      })
      expect(handlers.windowOpen({ url: TRUSTED_RENDERER_URL })).toEqual({ action: 'allow' })

      const prevented: string[] = []
      const eventStub = { preventDefault: () => prevented.push('prevented') }
      handlers['will-navigate'](eventStub, 'https://attacker.example/')
      handlers['will-navigate'](eventStub, 'file:///etc/passwd')
      expect(prevented).toHaveLength(2)
      handlers['will-navigate'](eventStub, `${TRUSTED_RENDERER_URL}index.html`)
      expect(prevented).toHaveLength(2)

      // Fail closed when no trusted renderer origin is configured.
      configureTendersRuntime({ preloadPath: '', rendererUrl: '', rendererFile: '' })
      expect(handlers.windowOpen({ url: TRUSTED_RENDERER_URL })).toEqual({ action: 'deny' })
      handlers['will-navigate'](eventStub, TRUSTED_RENDERER_URL)
      expect(prevented).toHaveLength(3)
      configureTendersRuntime({
        preloadPath: '',
        rendererUrl: TRUSTED_RENDERER_URL,
        rendererFile: '',
      })
    })

    it('ships a restrictive CSP in the renderer document', () => {
      const html = readFileSync(join(resolveTendersDir(), 'src', 'renderer', 'index.html'), 'utf8')
      const match = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/)
      expect(match, 'renderer/index.html must declare a Content-Security-Policy').not.toBeNull()
      const csp = match![1]
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("script-src 'self'")
      expect(csp).toContain("worker-src 'self' blob:")
      // blob:/data: are the document-read path (a vault document opened from a
      // `blob:` URL); pdf.js keeps its worker through worker-src above.
      expect(csp).toContain("connect-src 'self' blob: data:")
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("base-uri 'none'")
      expect(csp).toContain("form-action 'none'")
      expect(csp).not.toContain("'unsafe-eval'")
      expect(csp).not.toContain('http://')
      // No WebSocket origin: the shipped document is `file://`, so a
      // `ws://localhost:*` grant would let a compromised renderer reach any
      // listener on the machine, and it is redundant in dev where the HMR socket
      // is same-origin.
      expect(csp).not.toContain('ws://')
    })
  })

  describe('Paid ready-proposal path (preload projection -> canonical readiness)', () => {
    const generatedPaths: string[] = []

    afterEach(() => {
      for (const path of generatedPaths.splice(0)) rmSync(path, { force: true })
    })

    function draftThroughBridge(tender: unknown): Promise<{ ok: boolean; path?: string }> {
      const api = preloadBridge.api as {
        draftProposalDoc: (input: unknown) => Promise<{ ok: boolean; path?: string }>
      }
      return api.draftProposalDoc(tender)
    }

    it('projects the tender id through the preload bridge so main can verify readiness', async () => {
      expect(preloadBridge.key).toBe('tendersApi')
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      writeFileSync(storeFile, JSON.stringify(v2WithReadyTender(3), null, 2), 'utf8')

      const tender = v2WithReadyTender(3).workspaces[0].tenders[0]
      const result = await draftThroughBridge(tender)
      expect(result.ok).toBe(true)
      expect(result.path).toEqual(expect.any(String))
      generatedPaths.push(result.path!)

      const content = readFileSync(result.path!, 'utf8')
      expect(content).toContain('**Proposal Status:** **READY FOR SUBMISSION**')
      expect(content).not.toContain('READINESS NOT INDEPENDENTLY VERIFIED')
      expect(content).toContain('**Readiness Verification:** Canonical readiness report supplied')
    })

    it('still drafts an unverified proposal when the payload carries no tender id', async () => {
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      writeFileSync(storeFile, JSON.stringify(v2WithReadyTender(3), null, 2), 'utf8')

      const tender = v2WithReadyTender(3).workspaces[0].tenders[0]
      // Exactly what the pre-fix projection produced: every readiness-relevant
      // field except `id`.
      const payload = {
        title: tender.title,
        referenceNumber: tender.referenceNumber,
        issuingBody: tender.issuingBody,
        closingDate: tender.closingDate,
        estimatedValue: tender.estimatedValue,
        pricingConfirmed: tender.pricingConfirmed,
        signatureChecks: tender.signatureChecks,
        requirements: tender.requirements.map((requirement) => ({
          id: requirement.id,
          title: requirement.title,
          verbatimClause: requirement.verbatimClause,
          isMandatory: requirement.isMandatory,
          status: requirement.status,
          linkedVaultDocId: requirement.linkedVaultDocId,
          ruleKey: requirement.ruleKey,
          reason: requirement.reason,
        })),
        milestones: tender.milestones?.map((milestone) => ({
          id: milestone.id,
          name: milestone.name,
          amount: milestone.amount,
          dueDate: milestone.dueDate,
        })),
      }

      const handler = ipcHandlers.get(TENDERS_CHANNELS.draftProposalDoc)!
      const sender = registeredWebContents()
      const result = await handler(event(sender), payload)
      expect(result.ok).toBe(true)
      generatedPaths.push(result.path)

      const content = readFileSync(result.path, 'utf8')
      expect(content).toContain(
        '**Proposal Status:** **DRAFT — READINESS NOT INDEPENDENTLY VERIFIED**',
      )
    })
  })

  describe('Submission readiness snapshots are verified against canonical readiness', () => {
    const CAPTURED_AT = '2026-09-10T09:00:00.000Z'

    function clearSnapshot(): Record<string, unknown> {
      return {
        ready: true,
        score: 100,
        failedCheckIds: [],
        blockingCheckIds: [],
        capturedAt: CAPTURED_AT,
      }
    }

    function submissionWith(snapshot: unknown): Record<string, unknown> {
      return {
        submittedAt: CAPTURED_AT,
        timeZone: null,
        method: 'ELECTRONIC',
        destination: 'https://portal.example.test',
        confirmationReference: 'REF-1',
        evidence: null,
        person: null,
        notes: null,
        readiness: snapshot,
        blockerOverrideReason: null,
      }
    }

    /** The ready fixture with its only requirement still outstanding (blocked). */
    function v2WithBlockedSubmission(revision: number): TendersDataV2 {
      const document = v2WithReadyTender(revision)
      const tender = document.workspaces[0].tenders[0]
      tender.requirements[0].status = 'OUTSTANDING'
      tender.status = 'SUBMITTED'
      tender.submission = submissionWith(clearSnapshot()) as any
      return document
    }

    function v2WithReadySubmission(revision: number): TendersDataV2 {
      const document = v2WithReadyTender(revision)
      const tender = document.workspaces[0].tenders[0]
      tender.status = 'SUBMITTED'
      tender.submission = submissionWith(clearSnapshot()) as any
      return document
    }

    /**
     * The ready fixture with its closing date in the past, so `deadline` is the
     * only blocking check that fails — and it is the one whose verdict depends on
     * wall-clock time, which is what made the old time-dependent carve-out
     * forgeable.
     */
    function v2WithExpiredDeadlineSubmission(revision: number): TendersDataV2 {
      const document = v2WithReadyTender(revision)
      const tender = document.workspaces[0].tenders[0]
      tender.closingDate = '2026-01-05'
      tender.status = 'SUBMITTED'
      tender.submission = submissionWith(clearSnapshot()) as any
      return document
    }

    it('recomputes a renderer-authored clear checkpoint for a blocked tender instead of persisting the lie', async () => {
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)!
      const sender = registeredWebContents()

      const result = await saveHandler(event(sender), {
        expectedRevision: 0,
        document: v2WithBlockedSubmission(0),
      })

      expect(result.ok).toBe(true)
      const persisted = JSON.parse(readFileSync(storeFile, 'utf8'))
      const readiness = persisted.workspaces[0].tenders[0].submission.readiness
      expect(readiness.ready).toBe(false)
      expect(readiness.blockingCheckIds).toContain('requirements')
      expect(readiness.capturedAt).toBe(CAPTURED_AT)
      // The renderer receives the corrected document, so the receipt it shows
      // matches what was persisted.
      expect(result.data.workspaces[0].tenders[0].submission.readiness.ready).toBe(false)
    })

    it('leaves a clear checkpoint that the canonical report agrees with untouched', async () => {
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)!
      const sender = registeredWebContents()

      const result = await saveHandler(event(sender), {
        expectedRevision: 0,
        document: v2WithReadySubmission(0),
      })

      expect(result.ok).toBe(true)
      const onDisk = JSON.parse(readFileSync(storeFile, 'utf8'))
      expect(onDisk.workspaces[0].tenders[0].submission.readiness).toEqual(clearSnapshot())
    })

    it('keeps an unchanged historical checkpoint even after the tender becomes blocked', async () => {
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)!
      const sender = registeredWebContents()
      const first = await saveHandler(event(sender), {
        expectedRevision: 0,
        document: v2WithReadySubmission(0),
      })
      expect(first.ok).toBe(true)

      // A later edit blocks a requirement: the frozen checkpoint is the record of
      // the earlier moment and must survive the save.
      const result = await saveHandler(event(sender), {
        expectedRevision: 1,
        document: v2WithBlockedSubmission(1),
      })

      expect(result.ok).toBe(true)
      const onDisk = JSON.parse(readFileSync(storeFile, 'utf8'))
      expect(onDisk.workspaces[0].tenders[0].submission.readiness.ready).toBe(true)
    })

    it('recomputes a forged clear checkpoint whose only canonical blocker is the closing date', async () => {
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)!
      const sender = registeredWebContents()

      const result = await saveHandler(event(sender), {
        expectedRevision: 0,
        document: v2WithExpiredDeadlineSubmission(0),
      })

      expect(result.ok).toBe(true)
      const onDisk = JSON.parse(readFileSync(storeFile, 'utf8'))
      const readiness = onDisk.workspaces[0].tenders[0].submission.readiness
      // The wall-clock-dependent check is part of the canonical verdict for a
      // claim main is seeing for the first time, so excluding it cannot be used
      // to persist a clearance the closing date denies.
      expect(readiness.ready).toBe(false)
      expect(readiness.blockingCheckIds).toContain('deadline')
    })

    it('refuses a forged clear checkpoint written through the legacy saveStoredData channel', async () => {
      const legacySave = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)!
      const sender = registeredWebContents()

      const result = await legacySave(event(sender), JSON.stringify(v2WithBlockedSubmission(0)))

      expect(result.ok).toBe(true)
      const onDisk = JSON.parse(readFileSync(storeFile, 'utf8'))
      const readiness = onDisk.workspaces[0].tenders[0].submission.readiness
      // Every write path commits through the same gate, so the sibling channel
      // cannot persist a receipt the canonical save path would have corrected.
      expect(readiness.ready).toBe(false)
      expect(readiness.blockingCheckIds).toContain('requirements')
    })

    it('cannot seed a forgery that then rides the carried-over-checkpoint exemption', async () => {
      const legacySave = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)!
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)!
      const sender = registeredWebContents()

      // Step 1: the sibling channel (the pre-fix bypass). Step 2: the same forged
      // document through the canonical path, byte-identical to what the renderer
      // believes is on disk — the exact shape the old byte-identical carve-out
      // waved through as a "historical record".
      const first = await legacySave(event(sender), JSON.stringify(v2WithBlockedSubmission(0)))
      expect(first.ok).toBe(true)
      const afterLegacy = JSON.parse(readFileSync(storeFile, 'utf8'))
      expect(afterLegacy.workspaces[0].tenders[0].submission.readiness.ready).toBe(false)

      const second = await saveHandler(event(sender), {
        expectedRevision: 1,
        document: v2WithBlockedSubmission(1),
      })

      expect(second.ok).toBe(true)
      const onDisk = JSON.parse(readFileSync(storeFile, 'utf8'))
      expect(onDisk.workspaces[0].tenders[0].submission.readiness.ready).toBe(false)
    })

    it('downgrades a clear claim whose canonical verdict cannot be computed at all', () => {
      // The gate runs on the raw payload, before the store's schema validation,
      // so one tender malformed enough to break the assessment must not exempt
      // the document (or that tender) from the gate.
      const document = v2WithReadySubmission(0) as any
      document.workspaces[0].tenders[0].requirements = [null]

      const repaired = repairSubmissionReadinessSnapshots(document, null, new Date(CAPTURED_AT))

      expect(repaired).toBe(1)
      const readiness = document.workspaces[0].tenders[0].submission.readiness
      expect(readiness.ready).toBe(false)
      expect(readiness.score).toBe(0)
      expect(readiness.capturedAt).toBe(CAPTURED_AT)
    })
  })

  describe('Milestone billing derives the amount from the canonical milestone', () => {
    it('rejects an inflated caller amount and posts no invoice', async () => {
      const billHandler = ipcHandlers.get(TENDERS_CHANNELS.billMilestoneInBooks)!
      const sender = registeredWebContents()
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const starting = v2WithSeedTender(7)
      starting.workspaces[0].tenders[0].status = 'WON'
      const bytesBefore = JSON.stringify(starting, null, 2)
      writeFileSync(storeFile, bytesBefore, 'utf8')

      const result = await billHandler(event(sender), {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        amount: 999999,
      })

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/does not match the milestone amount/i)
      expect(booksInvoiceCalls).toHaveLength(0)
      expect(readFileSync(storeFile, 'utf8')).toBe(bytesBefore)

      // The matching echo is still accepted and bills the canonical amount.
      const accepted = await billHandler(event(sender), {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        amount: 145000,
      })
      expect(accepted.ok).toBe(true)
      expect(accepted.grandTotal).toBe(145000)
      expect(booksInvoiceCalls).toHaveLength(1)
    })
  })

  /**
   * Dirty-close data loss: Tenders persists through a 300 ms debounce and has no
   * `beforeunload`, so a window close inside that window used to drop the edit.
   * The shell now flushes through `requestTendersClose` before it closes; these
   * tests drive that guard against the REAL renderer store, the REAL preload
   * bridge and the real main handlers.
   */
  describe('21. shell dirty-close guard (tenders:close-flush-request)', () => {
    afterEach(() => {
      vi.useRealTimers()
      dialogState.calls.length = 0
      dialogState.response = 1
      ;(window as unknown as Record<string, unknown>).tendersApi = undefined
    })

    /**
     * A fake Tenders view wired the way the real one is: main's flush request
     * runs the real renderer flush and answers through the real preload bridge,
     * whose `invoke` the electron mock routes into the real main handlers.
     */
    function closeGuardView(id = 9001): any {
      const webContents: any = {
        id,
        isDestroyed: () => false,
        getURL: () => TRUSTED_RENDERER_URL,
        send: (channel: string, payload: unknown) => {
          if (channel !== TENDERS_CHANNELS.closeFlushRequest) return
          // The reply the renderer sends back comes from THIS view, so the
          // mocked `ipcRenderer.invoke` must hand main this view as the sender.
          invokeSender.current = webContents
          void (async () => {
            const store = await import('../src/renderer/src/store')
            await store.respondToCloseFlushRequest(payload as number)
          })()
        },
        once: vi.fn(),
      }
      registerTendersWebContents(webContents)
      registeredTestWebContents.push(webContents)
      return webContents
    }

    /** A registered view that never answers the flush request. */
    function silentView(id = 9100): any {
      const webContents: any = {
        id,
        isDestroyed: () => false,
        getURL: () => TRUSTED_RENDERER_URL,
        send: vi.fn(),
        once: vi.fn(),
      }
      registerTendersWebContents(webContents)
      registeredTestWebContents.push(webContents)
      return webContents
    }

    /** Hydrate the real renderer store against the real main handlers. */
    async function hydratedStore(): Promise<typeof import('../src/renderer/src/store')> {
      window.localStorage.clear()
      ;(window as unknown as Record<string, unknown>).tendersApi = preloadBridge.api
      const store = await import('../src/renderer/src/store')
      await store.useTendersStore.getState().hydrateFromMain()
      return store
    }

    function addCompany(store: typeof import('../src/renderer/src/store'), name: string): void {
      const profile = legacySeedFixture().workspaces[0].company
      store.useTendersStore.getState().addCompany({ ...profile, name, tradingName: name })
    }

    it('rejects an untrusted sender for the flush reply', async () => {
      const handler = ipcHandlers.get(TENDERS_CHANNELS.closeFlushResult)
      expect(handler).toBeDefined()
      const untrusted: any = {
        isDestroyed: () => false,
        getURL: () => UNTRUSTED_RENDERER_URL,
        send: vi.fn(),
        once: vi.fn(),
      }

      const result = await handler!(event(untrusted, untrustedFrame()), {
        requestId: 1,
        dirty: true,
        ok: true,
        error: null,
      })

      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('INVALID_REQUEST')
      expect(result.error.message).toMatch(/authoriz|trusted|registered/i)
      expect(dialogState.calls).toEqual([])
    })

    it('flushes a debounced edit on close instead of dropping it', async () => {
      // Fake timers: the 300 ms autosave debounce can never fire on its own, so
      // the only way the edit reaches disk is the close-guard flush.
      vi.useFakeTimers()
      const store = await hydratedStore()
      addCompany(store, 'Dirty Close Civils (Pty) Ltd')

      // The edit exists only in renderer memory — nothing has been committed.
      expect(existsSync(storeFile)).toBe(false)

      await expect(requestTendersClose(closeGuardView(), null)).resolves.toBe(true)

      const committed = JSON.parse(readFileSync(storeFile, 'utf8')) as TendersDataV2
      expect(committed.revision).toBe(1)
      expect(committed.workspaces.map((workspace) => workspace.name)).toEqual([
        'Dirty Close Civils (Pty) Ltd',
      ])
      // A successful flush never prompts, and the renderer reports "saved".
      expect(dialogState.calls).toEqual([])
      expect(store.useTendersStore.getState().saveStatus).toBe('saved')
    })

    it('prompts instead of closing when the flush cannot commit', async () => {
      vi.useFakeTimers()
      const store = await hydratedStore()
      const originalSave = ipcHandlers.get(TENDERS_CHANNELS.saveStoreV2)
      ipcHandlers.set(TENDERS_CHANNELS.saveStoreV2, async () => ({
        ok: false,
        error: { code: 'WRITE_FAILED', message: 'forced close-guard write failure' },
      }))
      try {
        addCompany(store, 'Unflushable Civils (Pty) Ltd')

        // "Keep Zanostack open" (the default button) must abort the close.
        dialogState.response = 1
        await expect(requestTendersClose(closeGuardView(), null)).resolves.toBe(false)
        expect(dialogState.calls).toHaveLength(1)
        expect(dialogState.calls[0].detail).toMatch(/forced close-guard write failure/)
        expect(existsSync(storeFile)).toBe(false)

        // "Close anyway" is the only way past it — never a silent drop.
        dialogState.response = 0
        await expect(requestTendersClose(closeGuardView(), null)).resolves.toBe(true)
        expect(dialogState.calls).toHaveLength(2)
      } finally {
        if (originalSave) ipcHandlers.set(TENDERS_CHANNELS.saveStoreV2, originalSave)
      }
    })

    it('does not close silently when the renderer never answers', async () => {
      vi.useFakeTimers()
      dialogState.response = 1
      const pending = requestTendersClose(silentView(), null)
      await vi.advanceTimersByTimeAsync(11_000)

      await expect(pending).resolves.toBe(false)
      expect(dialogState.calls).toHaveLength(1)
      expect(dialogState.calls[0].detail).toMatch(/did not respond/i)
    })

    it('ignores a flush reply from any view other than the one being guarded', async () => {
      vi.useFakeTimers()
      dialogState.response = 1
      const guarded = silentView(9200)
      const pending = requestTendersClose(guarded, null)
      const requestId = guarded.send.mock.calls[0][1] as number
      expect(typeof requestId, 'the guarded view must have been asked to flush').toBe('number')

      const handler = ipcHandlers.get(TENDERS_CHANNELS.closeFlushResult)!
      const reply = { requestId, dirty: false, ok: true, error: null }

      // A registered, trusted view that is not the guarded one.
      const other = closeGuardView(9300)
      expect((await handler(event(other), reply)).ok).toBe(false)

      // A trusted view that cannot identify itself at all: the pre-fix
      // negative-form binding accepted this and waved the close through with no
      // flush at all.
      const anonymous: any = {
        isDestroyed: () => false,
        getURL: () => TRUSTED_RENDERER_URL,
        send: vi.fn(),
        once: vi.fn(),
      }
      registerTendersWebContents(anonymous)
      registeredTestWebContents.push(anonymous)
      expect((await handler(event(anonymous), reply)).ok).toBe(false)

      // Neither reply settled the waiter, so the guarded view's flush is still
      // outstanding and the close fails closed into the prompt.
      await vi.advanceTimersByTimeAsync(11_000)
      await expect(pending).resolves.toBe(false)
      expect(dialogState.calls).toHaveLength(1)
      expect(dialogState.calls[0].detail).toMatch(/did not respond/i)
    })
  })

  // ── Tender discovery + deadline reminders (the wired engines) ──────────────
  //
  // The two engines are complete and tested on their own; what these tests prove
  // is the transport — the trusted-sender gate on every new channel, the URL
  // allow-list in front of the document download, the store path the download
  // lands in, the settings round-trip, and the lifecycle of the schedule.

  const trustedSender = (): any => registeredWebContents()

  /** The three sender classes every privileged channel must refuse. */
  function untrustedAttempts(): Array<{ label: string; eventArg: any }> {
    const unregisteredSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
    const untrustedSender = registeredWebContents(vi.fn(), UNTRUSTED_RENDERER_URL)
    const subframeSender = registeredWebContents(vi.fn())
    return [
      { label: 'an unregistered sender', eventArg: event(unregisteredSender as any) },
      { label: 'an untrusted-origin sender', eventArg: event(untrustedSender, untrustedFrame()) },
      { label: 'a subframe sender', eventArg: event(subframeSender, subFrame()) },
    ]
  }

  const DISCOVERY_CHANNELS: Array<{ label: string; channel: string; args: unknown[] }> = [
    {
      label: 'discovery-list',
      channel: TENDERS_CHANNELS.discoveryList,
      args: [{ window: { from: '2026-09-01', to: '2026-09-07' } }],
    },
    { label: 'discovery-refresh', channel: TENDERS_CHANNELS.discoveryRefresh, args: [{}] },
    { label: 'discovery-read-cache', channel: TENDERS_CHANNELS.discoveryReadCache, args: [] },
    {
      label: 'discovery-release',
      channel: TENDERS_CHANNELS.discoveryRelease,
      args: [{ ocid: 'ocds-abc-1' }],
    },
    {
      label: 'discovery-download-document',
      channel: TENDERS_CHANNELS.discoveryDownloadDocument,
      args: [{ url: 'https://www.etenders.gov.za/Documents/RFP.pdf' }],
    },
  ]

  describe('22. Tender discovery IPC', () => {
    beforeEach(() => {
      resetEngineSeams()
      installEngineSeams()
    })

    it.each(DISCOVERY_CHANNELS)(
      '$label rejects every untrusted sender with zero engine side effects',
      async ({ channel, args }) => {
        const handler = ipcHandlers.get(channel)
        expect(handler, `${channel} must be registered`).toBeDefined()

        for (const attempt of untrustedAttempts()) {
          const result = await handler!(attempt.eventArg, ...args)
          expect.soft(result, `${channel} must refuse ${attempt.label}`).toMatchObject({
            ok: false,
            error: {
              code: 'INVALID_REQUEST',
              message: expect.stringMatching(/authoriz|trusted|registered Tenders WebContents/i),
            },
          })
        }

        // Zero side effects: no client call, no download, no file on disk.
        expect(engineSeams.client.listOpportunities).not.toHaveBeenCalled()
        expect(engineSeams.client.refreshCache).not.toHaveBeenCalled()
        expect(engineSeams.client.readCache).not.toHaveBeenCalled()
        expect(engineSeams.client.fetchRelease).not.toHaveBeenCalled()
        expect(engineSeams.documentFetchCalls).toHaveLength(0)
        expect(documentsDirEntries()).toEqual([])
      },
    )

    it('builds the client with the app cache directory under userData', async () => {
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryReadCache)!

      const result = await handler(event(trustedSender()))

      expect(result).toEqual({ ok: true, cache: null, stale: true, warnings: [] })
      expect(engineSeams.clientOptions).toHaveLength(1)
      expect(engineSeams.clientOptions[0].cacheDir).toBe(join(testDir, 'tenders', 'discovery'))
      expect(engineSeams.client.readCache).toHaveBeenCalledTimes(1)
    })

    it('lists opportunities through the client and returns its shapes unchanged', async () => {
      const opportunity = opportunityFixture()
      engineSeams.client.listOpportunities.mockResolvedValueOnce({
        ok: true,
        opportunities: [opportunity],
        issues: [{ path: 'releases[1]', code: 'missing-title', detail: 'no title' }],
        warnings: ['one page failed'],
        pages: 2,
        failedPages: 1,
        source: 'ocds-api',
        truncated: true,
      })
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryList)!

      const result = await handler(event(trustedSender()), {
        window: { from: '2026-09-01', to: '2026-09-07' },
        pageSize: 10,
      })

      expect(engineSeams.client.listOpportunities).toHaveBeenCalledWith({
        window: { from: '2026-09-01', to: '2026-09-07' },
        pageSize: 10,
      })
      expect(result.opportunities).toEqual([opportunity])
      expect(result.issues).toHaveLength(1)
      expect(result).toMatchObject({ ok: true, pages: 2, failedPages: 1, truncated: true })
      expect(result.warnings).toEqual(['one page failed'])
    })

    it('passes the client refusal through verbatim instead of re-wording it', async () => {
      engineSeams.client.listOpportunities.mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'That window spans 40 days. The eTenders feed reliably answers at most 7 days.',
        },
      })
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryList)!

      const result = await handler(event(trustedSender()), {
        window: { from: '2026-01-01', to: '2026-02-09' },
      })

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'That window spans 40 days. The eTenders feed reliably answers at most 7 days.',
        },
      })
    })

    it('refreshes with the caller window, or with none at all', async () => {
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryRefresh)!

      await handler(event(trustedSender()))
      expect(engineSeams.client.refreshCache).toHaveBeenLastCalledWith()

      await handler(event(trustedSender()), { window: { from: '2026-09-01', to: '2026-09-07' } })
      expect(engineSeams.client.refreshCache).toHaveBeenLastCalledWith({
        window: { from: '2026-09-01', to: '2026-09-07' },
      })
    })

    it('reads one release by ocid through the client', async () => {
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryRelease)!

      const result = await handler(event(trustedSender()), { ocid: '  ocds-abc-1  ' })

      expect(engineSeams.client.fetchRelease).toHaveBeenCalledWith('ocds-abc-1')
      expect(result).toEqual({ ok: true, opportunity: null, issues: [], warnings: [] })
    })

    it.each([
      { label: 'no window', request: {} },
      { label: 'a non-object window', request: { window: '2026-09-01' } },
      { label: 'a non-string window end', request: { window: { from: '2026-09-01', to: 5 } } },
      {
        label: 'a page size of zero',
        request: { window: { from: '2026-09-01', to: '2026-09-07' }, pageSize: 0 },
      },
      {
        label: 'a page size beyond the bound',
        request: { window: { from: '2026-09-01', to: '2026-09-07' }, pageSize: 500 },
      },
      {
        label: 'a non-numeric page size',
        request: { window: { from: '2026-09-01', to: '2026-09-07' }, pageSize: 'many' },
      },
    ])('refuses a list request with $label without calling the client', async ({ request }) => {
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryList)!

      const result = await handler(event(trustedSender()), request)

      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
      expect(engineSeams.client.listOpportunities).not.toHaveBeenCalled()
    })

    it.each([
      { label: 'a missing ocid', request: {} },
      { label: 'an empty ocid', request: { ocid: '   ' } },
      { label: 'an over-long ocid', request: { ocid: 'x'.repeat(129) } },
    ])('refuses a release lookup with $label without calling the client', async ({ request }) => {
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryRelease)!

      const result = await handler(event(trustedSender()), request)

      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
      expect(engineSeams.client.fetchRelease).not.toHaveBeenCalled()
    })
  })

  describe('23. Deadline reminder IPC', () => {
    beforeEach(() => {
      resetEngineSeams()
      installEngineSeams()
    })

    it.each([
      { label: 'reminders-get', channel: TENDERS_CHANNELS.remindersGet, args: [] as unknown[] },
      {
        label: 'reminders-set',
        channel: TENDERS_CHANNELS.remindersSet,
        args: [{ enabled: false }],
      },
      { label: 'reminders-check', channel: TENDERS_CHANNELS.remindersCheck, args: [] as unknown[] },
    ])(
      '$label rejects every untrusted sender with no scheduler call',
      async ({ channel, args }) => {
        const handler = ipcHandlers.get(channel)
        expect(handler, `${channel} must be registered`).toBeDefined()

        for (const attempt of untrustedAttempts()) {
          const result = await handler!(attempt.eventArg, ...args)
          expect.soft(result, `${channel} must refuse ${attempt.label}`).toMatchObject({
            ok: false,
            error: {
              code: 'INVALID_REQUEST',
              message: expect.stringMatching(/authoriz|trusted|registered Tenders WebContents/i),
            },
          })
        }

        expect(engineSeams.scheduler.readState).not.toHaveBeenCalled()
        expect(engineSeams.scheduler.writeSettings).not.toHaveBeenCalled()
        expect(engineSeams.scheduler.checkNow).not.toHaveBeenCalled()
      },
    )

    it('returns the persisted settings, the ledger and the honest runtime limitation', async () => {
      engineSeams.reminderState.settings = {
        enabled: false,
        thresholds: [{ id: '2h', label: '2 hours', leadMs: 7_200_000 }],
      }
      const handler = ipcHandlers.get(TENDERS_CHANNELS.remindersGet)!

      const result = await handler(event(trustedSender()))

      expect(result.settings).toEqual(engineSeams.reminderState.settings)
      expect(result.ledger).toEqual(engineSeams.reminderState.ledger)
      // The reach of a notification is stated, not implied: this is the sentence
      // the settings surface shows.
      expect(result.limitation).toMatch(/only while Zanostack Tenders is running/i)
      expect(result.limitation).toMatch(/no notification is sent at that time/i)
    })

    it('merges a settings patch through the scheduler and returns what was written', async () => {
      const handler = ipcHandlers.get(TENDERS_CHANNELS.remindersSet)!
      const thresholds = [{ id: '1d', label: '1 day', leadMs: 86_400_000 }]

      const result = await handler(event(trustedSender()), { enabled: false, thresholds })

      expect(engineSeams.scheduler.writeSettings).toHaveBeenCalledWith({
        enabled: false,
        thresholds,
      })
      expect(result).toMatchObject({
        ok: true,
        settings: { enabled: false, thresholds },
      })
      expect(result.limitation).toMatch(/only while Zanostack Tenders is running/i)
    })

    it('defaults a threshold label to its id, as the pure core does', async () => {
      const handler = ipcHandlers.get(TENDERS_CHANNELS.remindersSet)!

      await handler(event(trustedSender()), { thresholds: [{ id: '3d', leadMs: 259_200_000 }] })

      expect(engineSeams.scheduler.writeSettings).toHaveBeenCalledWith({
        thresholds: [{ id: '3d', label: '3d', leadMs: 259_200_000 }],
      })
    })

    it.each([
      { label: 'a settings change that is not an object', settings: 'off' },
      { label: 'a non-boolean switch', settings: { enabled: 'yes' } },
      { label: 'a threshold list that is not a list', settings: { thresholds: {} } },
      {
        label: 'more thresholds than the bound allows',
        settings: {
          thresholds: Array.from({ length: MAX_TENDERS_REMINDER_THRESHOLDS + 1 }, (_, index) => ({
            id: `t${index}`,
            leadMs: 60_000,
          })),
        },
      },
      { label: 'a zero lead time', settings: { thresholds: [{ id: 'x', leadMs: 0 }] } },
      { label: 'a negative lead time', settings: { thresholds: [{ id: 'x', leadMs: -1 }] } },
      {
        label: 'a non-numeric lead time',
        settings: { thresholds: [{ id: 'x', leadMs: '1 day' }] },
      },
      {
        label: 'a lead time beyond a year',
        settings: { thresholds: [{ id: 'x', leadMs: 366 * 24 * 60 * 60 * 1000 }] },
      },
      { label: 'a threshold with no id', settings: { thresholds: [{ leadMs: 60_000 }] } },
      {
        label: 'an over-long threshold id',
        settings: { thresholds: [{ id: 'x'.repeat(65), leadMs: 60_000 }] },
      },
    ])('refuses $label and saves nothing', async ({ settings }) => {
      const handler = ipcHandlers.get(TENDERS_CHANNELS.remindersSet)!

      const result = await handler(event(trustedSender()), settings)

      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
      expect(engineSeams.scheduler.writeSettings).not.toHaveBeenCalled()
    })

    it('reports a settings write that could not be persisted instead of claiming it was saved', async () => {
      engineSeams.scheduler.writeSettings.mockRejectedValueOnce(new Error('disk is read-only'))
      const handler = ipcHandlers.get(TENDERS_CHANNELS.remindersSet)!

      const result = await handler(event(trustedSender()), { enabled: false })

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'WRITE_FAILED', message: expect.stringContaining('disk is read-only') },
      })
    })

    it('runs one check through the scheduler and returns the reminders, never the ledger', async () => {
      engineSeams.scheduler.checkNow.mockResolvedValueOnce({
        fired: 1,
        reminders: [DUE_REMINDER],
        // A real ledger entry (main's memory of what it already showed), so the
        // test proves a ledger that exists is still withheld from the renderer.
        ledger: { version: 1, entries: [ledgerEntry()] },
      })
      const handler = ipcHandlers.get(TENDERS_CHANNELS.remindersCheck)!

      const result = await handler(event(trustedSender()))

      expect(result).toEqual({ ok: true, fired: 1, reminders: [DUE_REMINDER] })
      // The dedupe ledger is main's memory of what was already shown; a renderer
      // has no business writing it back.
      expect(result).not.toHaveProperty('ledger')
    })

    it('reports a check that failed instead of throwing into the renderer', async () => {
      engineSeams.scheduler.checkNow.mockRejectedValueOnce(new Error('the ledger is unreadable'))
      const handler = ipcHandlers.get(TENDERS_CHANNELS.remindersCheck)!

      const result = await handler(event(trustedSender()))

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'CHECK_FAILED',
          message: expect.stringContaining('the ledger is unreadable'),
        },
      })
    })
  })

  describe('24. discovery + reminder lifecycle', () => {
    it('starts the schedule on registration over the authoritative store, and stops it on teardown', async () => {
      // A fresh registration, so the schedule is built from these seams.
      resetTendersIpcForTests()
      resetEngineSeams()
      installEngineSeams()
      registerTendersIpc()

      expect(engineSeams.schedulerOptions).toHaveLength(1)
      const options = engineSeams.schedulerOptions[0]
      expect(options.userDataDir).toBe(testDir)
      expect(typeof options.readTenders).toBe('function')
      expect(engineSeams.scheduler.start).toHaveBeenCalledTimes(1)

      // The reader reads the AUTHORITATIVE store: commit a document and the
      // schedule sees its tenders, with exactly the four fields it needs.
      const saveHandler = ipcHandlers.get(TENDERS_CHANNELS.saveStoreV2)!
      const committed = await saveHandler(event(trustedSender()), {
        expectedRevision: 0,
        document: v2WithSeedTender(0),
      })
      expect(committed.ok).toBe(true)
      // `readTenders` is optional on the options; the assertion above proves main
      // passed one, so this reads it the way main's own scheduler does.
      await expect(options.readTenders!()).resolves.toEqual([
        {
          id: SEED_TENDER_WTR_04.id,
          title: SEED_TENDER_WTR_04.title,
          closingDate: SEED_TENDER_WTR_04.closingDate,
          status: SEED_TENDER_WTR_04.status,
        },
      ])

      // Teardown stops the timer; a test-only reset stops it too, so no interval
      // outlives the surface it belongs to.
      stopTendersReminders()
      expect(engineSeams.scheduler.stop).toHaveBeenCalledTimes(1)
      resetTendersIpcForTests()
      expect(engineSeams.scheduler.stop).toHaveBeenCalledTimes(2)

      // And re-registration rebuilds and restarts it.
      installEngineSeams()
      registerTendersIpc()
      expect(engineSeams.scheduler.start).toHaveBeenCalledTimes(2)
    })
  })

  describe('25. tender-document download', () => {
    const PDF_BYTES = '%PDF-1.7 tender document body'
    const ALLOWED = 'https://www.etenders.gov.za/Documents/RFP-WTR-2026-04.pdf'

    beforeEach(() => {
      resetEngineSeams()
      installEngineSeams()
    })

    it.each([
      { label: 'a plain-http link', url: 'http://www.etenders.gov.za/Documents/RFP.pdf' },
      { label: 'an off-host link', url: 'https://evil.example/RFP.pdf' },
      { label: 'a file: link', url: 'file:///C:/Windows/win.ini' },
      {
        label: 'a look-alike host',
        url: 'https://www.etenders.gov.za.evil.example/RFP.pdf',
      },
      {
        label: 'a link carrying credentials',
        url: 'https://user:secret@www.etenders.gov.za/RFP.pdf',
      },
      { label: 'something that is not a URL', url: 'not a url at all' },
    ])('refuses $label before any fetch or disk work', async ({ url }) => {
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryDownloadDocument)!
      const before = documentsDirEntries()

      const result = await handler(event(trustedSender()), { url })

      expect(result).toMatchObject({ ok: false, error: { code: 'BLOCKED_URL' } })
      expect(result.error.message).toMatch(/was not requested/i)
      expect(engineSeams.documentFetchCalls).toHaveLength(0)
      expect(documentsDirEntries()).toEqual(before)
    })

    it.each([
      { label: 'no link at all', request: {} },
      { label: 'a non-object request', request: 'https://www.etenders.gov.za/RFP.pdf' },
      {
        label: 'an over-long link',
        request: { url: `https://www.etenders.gov.za/${'a'.repeat(2100)}` },
      },
      {
        label: 'an over-long stored name',
        request: { url: 'https://www.etenders.gov.za/RFP.pdf', fileName: 'a'.repeat(513) },
      },
    ])('refuses a download request with $label, fetching nothing', async ({ request }) => {
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryDownloadDocument)!

      const result = await handler(event(trustedSender()), request)

      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
      expect(engineSeams.documentFetchCalls).toHaveLength(0)
    })

    it('downloads an allow-listed document into the managed store and returns its record and bytes', async () => {
      engineSeams.documentFetch.mockResolvedValueOnce(documentReply({ body: PDF_BYTES }))
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryDownloadDocument)!

      const result = await handler(event(trustedSender()), { url: ALLOWED })

      expect(engineSeams.documentFetchCalls).toHaveLength(1)
      expect(engineSeams.documentFetchCalls[0].url).toBe(ALLOWED)
      // Redirects are followed by main, one hop at a time, so each hop can be
      // re-checked against the allow-list.
      expect(engineSeams.documentFetchCalls[0].init?.redirect).toBe('manual')

      expect(result.ok).toBe(true)
      expect(result.storedPath).toMatch(/^documents\/\d+_RFP-WTR-2026-04\.pdf$/)
      expect(result.fileName).toBe('RFP-WTR-2026-04.pdf')
      expect(result.mimeType).toBe('application/pdf')
      expect(result.byteLength).toBe(Buffer.byteLength(PDF_BYTES))
      expect(result.record.relativePath).toBe(result.storedPath)
      expect(result.record.state).toBe('active')

      // The document is an ordinary managed document: on disk under documents/,
      // and readable through the channel the renderer already uses.
      const onDisk = join(
        getTendersDocumentsDir(testDir),
        result.storedPath.replace('documents/', ''),
      )
      expect(readFileSync(onDisk, 'utf8')).toBe(PDF_BYTES)
      const read = await readDocumentFile({ storedPath: result.storedPath }, testDir)
      expect(Buffer.from(read.buffer!).toString('utf8')).toBe(PDF_BYTES)
      expect(Buffer.from(result.buffer).toString('utf8')).toBe(PDF_BYTES)

      rmSync(onDisk, { force: true })
    })

    it('names the stored document from the link when the caller names none', async () => {
      engineSeams.documentFetch.mockResolvedValueOnce(documentReply({ body: PDF_BYTES }))
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryDownloadDocument)!

      const result = await handler(event(trustedSender()), {
        url: 'https://www.etenders.gov.za/Documents/Tender%20Pack.docx',
      })

      expect(result.ok).toBe(true)
      expect(result.fileName).toBe('Tender_Pack.docx')
      expect(result.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      rmSync(join(getTendersDocumentsDir(testDir), result.storedPath.replace('documents/', '')), {
        force: true,
      })
    })

    it('reads a streamless response through its own bytes rather than decoding it as text', async () => {
      const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10])
      engineSeams.documentFetch.mockResolvedValueOnce(
        documentReply({ body: bytes, streamless: true }),
      )
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryDownloadDocument)!

      const result = await handler(event(trustedSender()), { url: ALLOWED })

      expect(result.ok).toBe(true)
      const onDisk = join(
        getTendersDocumentsDir(testDir),
        result.storedPath.replace('documents/', ''),
      )
      expect([...readFileSync(onDisk)]).toEqual([...bytes])
      rmSync(onDisk, { force: true })
    })

    it('refuses a document larger than the store will accept, before reading the body', async () => {
      engineSeams.documentFetch.mockResolvedValueOnce(
        documentReply({ body: PDF_BYTES, contentLength: MAX_DISCOVERY_DOWNLOAD_BYTES + 1 }),
      )
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryDownloadDocument)!
      const before = documentsDirEntries()

      const result = await handler(event(trustedSender()), { url: ALLOWED })

      expect(result).toMatchObject({ ok: false, error: { code: 'RESPONSE_TOO_LARGE' } })
      expect(documentsDirEntries()).toEqual(before)
    })

    it('enforces the byte cap while the body is read, with no declared length', async () => {
      // 26 MiB in 1 MiB chunks: one mebibyte over the 25 MiB ceiling, and never
      // declared in advance.
      engineSeams.documentFetch.mockResolvedValueOnce(repeatingDocumentReply(1024 * 1024, 26))
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryDownloadDocument)!
      const before = documentsDirEntries()

      const result = await handler(event(trustedSender()), { url: ALLOWED })

      expect(result).toMatchObject({ ok: false, error: { code: 'RESPONSE_TOO_LARGE' } })
      expect(documentsDirEntries()).toEqual(before)
    })

    it.each([
      { label: 'an empty document', reply: documentReply({ body: '' }), code: 'MALFORMED_BODY' },
      {
        label: 'a refused request',
        reply: documentReply({ status: 503, body: 'unavailable' }),
        code: 'HTTP_STATUS',
      },
      {
        label: 'a not-found document',
        reply: documentReply({ status: 404, body: 'no' }),
        code: 'HTTP_STATUS',
      },
    ])('refuses $label and saves nothing', async ({ reply, code }) => {
      engineSeams.documentFetch.mockResolvedValueOnce(reply)
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryDownloadDocument)!
      const before = documentsDirEntries()

      const result = await handler(event(trustedSender()), { url: ALLOWED })

      expect(result).toMatchObject({ ok: false, error: { code } })
      expect(documentsDirEntries()).toEqual(before)
    })

    it('refuses a redirect off the allow-list instead of following it', async () => {
      engineSeams.documentFetch.mockResolvedValueOnce(
        documentReply({ status: 302, location: 'https://evil.example/RFP.pdf' }),
      )
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryDownloadDocument)!
      const before = documentsDirEntries()

      const result = await handler(event(trustedSender()), { url: ALLOWED })

      expect(result).toMatchObject({ ok: false, error: { code: 'BLOCKED_URL' } })
      expect(engineSeams.documentFetchCalls).toHaveLength(1)
      expect(documentsDirEntries()).toEqual(before)
    })

    it('follows a redirect that stays on the allow-list, and names the document from that hop', async () => {
      engineSeams.documentFetch
        .mockResolvedValueOnce(
          documentReply({ status: 302, location: 'https://data.etenders.gov.za/Files/RFP.pdf' }),
        )
        .mockResolvedValueOnce(documentReply({ body: PDF_BYTES }))
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryDownloadDocument)!

      const result = await handler(event(trustedSender()), { url: ALLOWED })

      expect(engineSeams.documentFetchCalls.map((call) => call.url)).toEqual([
        ALLOWED,
        'https://data.etenders.gov.za/Files/RFP.pdf',
      ])
      expect(result.ok).toBe(true)
      expect(result.fileName).toBe('RFP.pdf')
      rmSync(join(getTendersDocumentsDir(testDir), result.storedPath.replace('documents/', '')), {
        force: true,
      })
    })

    it('reports a host that could not be reached, saving nothing', async () => {
      engineSeams.documentFetch.mockRejectedValueOnce(new Error('socket hang up'))
      const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryDownloadDocument)!
      const before = documentsDirEntries()

      const result = await handler(event(trustedSender()), { url: ALLOWED })

      expect(result).toMatchObject({ ok: false, error: { code: 'NETWORK' } })
      expect(documentsDirEntries()).toEqual(before)
    })

    it('gives up on a host that never answers, saving nothing', async () => {
      vi.useFakeTimers()
      try {
        engineSeams.documentFetch.mockImplementationOnce(
          (_url: string, init?: DiscoveryFetchInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            }),
        )
        const handler = ipcHandlers.get(TENDERS_CHANNELS.discoveryDownloadDocument)!
        const before = documentsDirEntries()

        const pending = handler(event(trustedSender()), { url: ALLOWED })
        await vi.advanceTimersByTimeAsync(46_000)
        const result = await pending

        expect(result).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } })
        expect(documentsDirEntries()).toEqual(before)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
