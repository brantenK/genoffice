import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  watch,
  type FSWatcher,
} from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { app, dialog, ipcMain, shell, WebContentsView, type WebContents } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  MAX_DISCOVERY_DOCUMENT_FILE_NAME_CHARS,
  MAX_DISCOVERY_DOCUMENT_URL_CHARS,
  MAX_DISCOVERY_DOWNLOAD_BYTES,
  MAX_TENDERS_DIAGNOSTIC_DETAIL_KEYS,
  MAX_TENDERS_DIAGNOSTIC_MESSAGE_CHARS,
  MAX_TENDERS_DIAGNOSTIC_SOURCE_CHARS,
  MAX_TENDERS_DOCUMENT_UPLOAD_BYTES,
  MAX_TENDERS_MATRIX_EXPORT_BYTES,
  MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS,
  MAX_TENDERS_MATRIX_EXPORT_ROWS,
  MAX_TENDERS_REMINDER_LABEL_CHARS,
  MAX_TENDERS_REMINDER_LEAD_MS,
  MAX_TENDERS_REMINDER_THRESHOLDS,
  TENDERS_CHANNELS,
  type BillMilestoneRequest,
  type BillMilestoneResult,
  type CleanupDocumentTrashRequest,
  type CleanupDocumentTrashResponse,
  type DeleteDocumentRequest,
  type DeleteDocumentResponse,
  type DiagnosticsPathResponse,
  type DiscoveryDownloadDocumentRequest,
  type DiscoveryDownloadDocumentResponse,
  type DiscoveryListRequest,
  type DiscoveryListResponse,
  type DiscoveryReadCacheResponse,
  type DiscoveryRefreshRequest,
  type DiscoveryRefreshResponse,
  type DiscoveryReleaseRequest,
  type DiscoveryReleaseResponse,
  type ListDocumentTrashResponse,
  type ListRecoveryCandidatesResponse,
  type OpenDocumentRequest,
  type OpenDocumentResponse,
  type ReadDocumentRequest,
  type ReadDocumentResponse,
  type ReconcileDocumentsResponse,
  type RecordDiagnosticsResponse,
  type RemindersCheckResponse,
  type RemindersSetRequest,
  type RemindersSetResponse,
  type RemindersStateResponse,
  type ReplaceDocumentRequest,
  type ReplaceDocumentResponse,
  type RestoreDocumentRequest,
  type RestoreDocumentResponse,
  type RestoreRecoveryCandidateRequest,
  type RestoreRecoveryCandidateResponse,
  type SaveDocumentRequest,
  type SaveDocumentResponse,
  type TendersCloseFlushResult,
  type TendersIpcFailure,
} from '../shared/ipc'
import type {
  CompanyWorkspace,
  ContractMilestone,
  RequirementRecord,
  TenderReadinessSnapshot,
  TenderRecord,
  TendersData,
  TendersDataV2,
} from '../shared/types'
import {
  MAX_TENDERS_DOCUMENT_BYTES,
  MAX_TENDERS_IPC_PAYLOAD_BYTES,
  MAX_TENDERS_STORE_FILE_BYTES,
} from '../shared/tenders-persistence'
import type {
  ManagedFileLink,
  SaveTendersRequest,
  TendersPersistenceError,
  TendersRecoveryCandidate,
} from '../shared/tenders-persistence'
import {
  expectedReadinessBinding,
  generateProposalMarkdown,
  type ProposalInput,
} from './proposal-generator'
import { createTendersStore, type TendersStore } from './tenders-store'
import {
  createManagedDocumentStore,
  findManagedFileLinks,
  toManagedRelativePath,
  type ManagedDocumentStore,
} from './document-store'
import { buildCanonicalReadinessReport } from './readiness-binding'
import { milestonesAllowed } from '../shared/lifecycle'
import { assessReadiness } from '../shared/readiness'
import { validateTendersDataV2 } from '../shared/tenders-schema'
import {
  resolveTendersIntegrations,
  setInjectedTendersIntegrations,
  type TendersIntegrations,
} from './integrations'
import type { ReadinessBinding, ReadinessReport } from '../shared/readiness'
import {
  createDiscoveryClient,
  discoveryCacheDir,
  type DiscoveryClient,
  type DiscoveryClientOptions,
  type DiscoveryFetch,
  type DiscoveryFetchInit,
  type DiscoveryHttpResponse,
} from './discovery-client'
import {
  createRemindersScheduler,
  REMINDERS_RUNTIME_LIMITATION,
  type ReminderLog,
  type ReminderNotifier,
  type RemindersScheduler,
  type RemindersSchedulerOptions,
} from './reminders-scheduler'
import { isAllowedDiscoveryUrl, DISCOVERY_ALLOWED_HOSTS } from '../shared/discovery'
import type { ReminderSettings, ReminderTender } from '../shared/reminders'
import {
  createDiagnosticsLog,
  diagnosticsLogDir,
  recordDiagnosticsStart,
  type DiagnosticsLog,
} from './diagnostics-log'
import { MOCK_COMPANY } from '../renderer/src/mock/company'
import { MOCK_CUSTOMERS } from '../renderer/src/mock/customers'
import { MOCK_VAULT } from '../renderer/src/mock/vault'

export const CURRENT_TENDERS_SCHEMA_VERSION = 1
export const SEED_COMPANY_ID = 'co-thabo'

export const SEED_TENDER_WTR_04: TenderRecord = {
  id: 'tender-wtr-04',
  title: 'Bulk Water Metering & Valve Refurbishment',
  referenceNumber: 'RFP-WTR-2026-04',
  issuingBody: 'City of Ekurhuleni Water Dept',
  closingDate: '2026-10-31',
  submissionMethod: 'PHYSICAL',
  submissionAddress: 'Civic Centre, Kempton Park, Ekurhuleni',
  signatureChecks: {},
  status: 'IN_PROGRESS',
  createdAt: '2026-08-01T08:00:00Z',
  fileName: 'RFP-WTR-2026-04.pdf',
  fileUrl: '',
  numPages: 24,
  ocrPages: 0,
  estimatedValue: 243000,
  milestones: [
    {
      id: 'ms-01',
      name: 'Phase 1 Reservoir Valve Refurbishment',
      title: 'Phase 1 Reservoir Valve Refurbishment',
      description: 'Complete overhaul of high-pressure control valves per tender specification',
      amount: 145000,
      status: 'REACHED',
      dueDate: '2026-08-30',
      completedDate: '2026-08-28',
    },
    {
      id: 'ms-02',
      name: 'Phase 2 Ultrasonic Flow Meter Installation',
      title: 'Phase 2 Ultrasonic Flow Meter Installation',
      description: 'Install and calibrate digital flow sensors across metering points',
      amount: 98000,
      status: 'PENDING',
      dueDate: '2026-11-15',
    },
  ],
  requirements: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function createDefaultSeedWorkspaces(): CompanyWorkspace[] {
  return [
    {
      id: SEED_COMPANY_ID,
      name: 'Thabo Engineering (Pty) Ltd',
      company: { ...MOCK_COMPANY },
      customers: [...MOCK_CUSTOMERS],
      vault: [...MOCK_VAULT],
      tenders: [SEED_TENDER_WTR_04],
    },
  ]
}

// ── The legacy v1 read path (retired) ────────────────────────────────────────
//
// The v1 stack is a SECOND persistence architecture that used to run alongside
// the authoritative v2 store. It is retired, deliberately and in two parts:
//
//  * **No synthesis.** The reader used to answer an empty or non-object payload
//    with `createDefaultSeedWorkspaces()` — demo company, customers, vault and
//    the seeded RFP — which is exactly the behaviour the v2 path promises never
//    to do. It now reads back only what a v1 file actually contains. Nothing on
//    a shipping path can invent a customer, a compliance document or a tender.
//  * **No live watcher.** `registerTendersIpc` used to start a `fs.watch` over
//    `tenders-data.json` and broadcast the re-read document on
//    `tenders:data-changed`, which nothing subscribed to any more. The watcher
//    is no longer started in production: a background reader whose result no
//    consumer sees is pure risk (it re-read and re-broadcast on every write the
//    v2 store made to a file only the legacy stack cared about).
//
// What stays: `getStoredData` still answers with the on-disk document, because
// `e2e/tenders-regression-smoke.spec.ts` proves the channel is reachable and
// `tests/adversarial-stress.test.ts` reads a genuine v1 file back through it.
// `createDefaultSeedWorkspaces` / `startTendersStoreWatcher` / `broadcastTendersData`
// remain exported for the tests that pin their independent behaviour.
//
// This is the LAST writer removed from the legacy stack: `writeTendersStore` is
// no longer reachable from any IPC handler, and the sole shipping writer of
// `tenders-data.json` is the authoritative v2 store.

export const LEGACY_TENDERS_READ_FAILED =
  'The saved Tenders file could not be read. It was left exactly as it is; restore a recovery copy or repair the file before saving.'

/** One v1 requirement, field by field, or `null` when it cannot be read honestly. */
function parseLegacyRequirement(raw: unknown): RequirementRecord | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !raw.id || typeof raw.title !== 'string') return null
  if (!Array.isArray(raw.suggestedVaultDocIds)) return null
  // Unknown keys are refused rather than dropped: a field this reader does not
  // understand is a field it cannot vouch for, so the whole record fails to read.
  if (!Object.keys(raw).every((key) => LEGACY_REQUIREMENT_KEYS.has(key))) return null
  const box = isRecord(raw.boundingBox) ? raw.boundingBox : null
  return {
    ...(raw as unknown as RequirementRecord),
    category: (raw.category ?? 'GENERAL_RETURNABLE') as RequirementRecord['category'],
    isMandatory: raw.isMandatory === true,
    riskLevel: (raw.riskLevel ?? 'INFORMATIONAL') as RequirementRecord['riskLevel'],
    boundingBox: {
      top: typeof box?.top === 'number' ? box.top : 0,
      left: typeof box?.left === 'number' ? box.left : 0,
      width: typeof box?.width === 'number' ? box.width : 0,
      height: typeof box?.height === 'number' ? box.height : 0,
    },
    linkedVaultDocId: typeof raw.linkedVaultDocId === 'string' ? raw.linkedVaultDocId : null,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    suggestedVaultDocIds: raw.suggestedVaultDocIds.filter(
      (id): id is string => typeof id === 'string',
    ),
  }
}

const LEGACY_REQUIREMENT_KEYS = new Set([
  'id',
  'ruleKey',
  'title',
  'category',
  'isMandatory',
  'verbatimClause',
  'pageNumber',
  'boundingBox',
  'riskLevel',
  'order',
  'additionalClauses',
  'confidence',
  'notes',
  'suggestedBy',
  'status',
  'linkedVaultDocId',
  'reason',
  'notApplicableReason',
  'suggestedVaultDocIds',
])

/**
 * Read a workspace list back from a v1 file without inventing anything.
 *
 * The distinction this function draws is the one that matters: a missing
 * CONTAINER (`workspaces`, `customers`, `vault`, `tenders`, a tender's
 * `requirements`) reads as an empty list, because that is what the file says —
 * the user really has none. A missing PIECE OF DEMO DATA is not replaced with
 * `MOCK_CUSTOMERS`, `MOCK_VAULT` or `SEED_TENDER_WTR_04`, because those are
 * values the file does not contain. `migrateAndValidateTenders` used to do the
 * latter for the seeded company, which meant a store whose vault had been
 * emptied came back with seven compliance documents in it.
 *
 * A workspace still needs an id (it is the key every caller looks it up by) and,
 * for a tender, a `referenceNumber` is kept as it is written (including absent).
 */
function parseLegacyWorkspaces(raw: unknown, now: string): CompanyWorkspace[] {
  if (!Array.isArray(raw)) return []
  const workspaces: CompanyWorkspace[] = []
  for (const candidate of raw) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !candidate.id) continue
    const company = isRecord(candidate.company) ? candidate.company : {}
    const tenders: TenderRecord[] = []
    if (Array.isArray(candidate.tenders)) {
      for (const tender of candidate.tenders) {
        if (!isRecord(tender) || typeof tender.id !== 'string' || !tender.id) continue
        const rawRequirements = Array.isArray(tender.requirements) ? tender.requirements : []
        const requirements = rawRequirements
          .map(parseLegacyRequirement)
          .filter((item): item is RequirementRecord => item !== null)
        if (requirements.length !== rawRequirements.length) continue
        tenders.push({
          ...(tender as unknown as TenderRecord),
          closingDate: typeof tender.closingDate === 'string' ? tender.closingDate : '',
          submissionMethod:
            (tender.submissionMethod as TenderRecord['submissionMethod']) ?? 'ELECTRONIC',
          signatureChecks: isRecord(tender.signatureChecks)
            ? (tender.signatureChecks as Record<string, boolean>)
            : {},
          status: (tender.status as TenderRecord['status']) ?? 'IN_PROGRESS',
          createdAt: typeof tender.createdAt === 'string' ? tender.createdAt : now,
          fileName: typeof tender.fileName === 'string' ? tender.fileName : '',
          fileUrl: typeof tender.fileUrl === 'string' ? tender.fileUrl : '',
          numPages: typeof tender.numPages === 'number' ? tender.numPages : 0,
          ocrPages: typeof tender.ocrPages === 'number' ? tender.ocrPages : 0,
          requirements,
        })
      }
    }
    workspaces.push({
      ...(candidate as unknown as CompanyWorkspace),
      id: candidate.id,
      name:
        typeof candidate.name === 'string' && candidate.name
          ? candidate.name
          : String(company.name ?? ''),
      company: company as unknown as CompanyWorkspace['company'],
      customers: Array.isArray(candidate.customers)
        ? (candidate.customers as CompanyWorkspace['customers'])
        : [],
      vault: Array.isArray(candidate.vault) ? (candidate.vault as CompanyWorkspace['vault']) : [],
      tenders,
    })
  }
  return workspaces
}

/**
 * The legacy v1 envelope, read back field by field. An unreadable payload throws
 * `LegacyTendersReadError` rather than being answered with a synthesized or empty
 * document: an `{workspaces: []}` the user never chose is silent apparent data
 * loss on a path that runs before they open a view.
 *
 * `version` is accepted as found and normalized to the current schema version, so
 * a `version: 0` file written by an older build still reads. It is only rejected
 * when present and not a number, which is a payload this reader cannot interpret.
 */
export function migrateAndValidateTenders(raw: unknown): TendersData {
  const now = new Date().toISOString()
  if (!isRecord(raw)) throw new LegacyTendersReadError('The Tenders file is not a JSON document.')
  const rawVersion = raw.version
  if (
    rawVersion !== undefined &&
    (typeof rawVersion !== 'number' || !Number.isFinite(rawVersion))
  ) {
    throw new LegacyTendersReadError(
      `The Tenders file declares an unreadable version: ${JSON.stringify(rawVersion)}`,
    )
  }
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt : now
  const workspaces = parseLegacyWorkspaces(raw.workspaces, now)
  const activeCompanyId =
    typeof raw.activeCompanyId === 'string' && raw.activeCompanyId.trim()
      ? raw.activeCompanyId
      : (workspaces[0]?.id ?? '')
  const issuerTemplates = Array.isArray(raw.issuerTemplates)
    ? (raw.issuerTemplates as TendersData['issuerTemplates'])
    : []

  return {
    version: CURRENT_TENDERS_SCHEMA_VERSION,
    updatedAt,
    activeCompanyId,
    workspaces,
    issuerTemplates,
  }
}

/** A legacy payload that could not be read honestly. Never answered with a stub. */
export class LegacyTendersReadError extends Error {
  readonly code = 'READ_FAILED' as const
  constructor(message: string) {
    super(message)
    this.name = 'LegacyTendersReadError'
  }
}

export function readTendersStore(baseDirOrPath: string): TendersData {
  const filePath = baseDirOrPath.endsWith('tenders-data.json')
    ? baseDirOrPath
    : join(baseDirOrPath, 'tenders-data.json')
  // A file that is not there yet is a genuinely not-yet-existing store: the one
  // case where "nothing" is the honest answer, because it is also what the read
  // found. Nothing is synthesized into it.
  if (!existsSync(filePath)) {
    return {
      version: CURRENT_TENDERS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      activeCompanyId: '',
      workspaces: [],
      issuerTemplates: [],
    }
  }

  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch (err) {
    console.error('tenders-main: failed to read tenders-data.json:', err)
    throw new LegacyTendersReadError(errorMessage(err, 'The Tenders file could not be read.'))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (parseErr) {
    const backupPath = `${filePath}.corrupted.bak`
    try {
      writeFileSync(backupPath, content, 'utf8')
      console.warn(`tenders-main: Corrupted tenders file detected. Backed up to ${backupPath}`)
    } catch (bakErr) {
      console.error('tenders-main: Failed to write corrupted backup file', bakErr)
    }
    // Fails CLOSED. Returning `{workspaces: []}` here would present a corrupt
    // primary as an empty workspace — apparent data loss, silently, before the
    // user opens a view. Callers surface the failure and point at recovery.
    throw new LegacyTendersReadError(
      `The Tenders file is not valid JSON. A copy of the unreadable bytes was kept at ${backupPath}.`,
    )
  }

  try {
    return migrateAndValidateTenders(parsed)
  } catch (validationError) {
    throw new LegacyTendersReadError(
      errorMessage(validationError, 'The Tenders file could not be validated.'),
    )
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

// ── diagnostics ──────────────────────────────────────────────────────────────
//
// One sink for the whole main process, under the same Tenders data directory the
// store uses. Every failure this file already knows about — a corrupt store, a
// refused read, a dropped notification — used to reach `console.warn` and
// nothing else, which on a packaged build means it reached nowhere a support
// engineer can look. The sink owns rotation and the content rule; this file only
// decides what is worth recording.

let diagnosticsLog: DiagnosticsLog | null = null
let diagnosticsLogOverride: DiagnosticsLog | null = null

/**
 * The diagnostics sink for this process. `createDiagnosticsLog` takes an
 * injected clock, and the tests inject a whole sink through
 * `setTendersEngineOverrides({ diagnosticsLog })`, so no test writes to the real
 * data directory or waits on a real rotation.
 */
export function getTendersDiagnosticsLog(): DiagnosticsLog {
  if (engineOverrides.diagnosticsLog) return engineOverrides.diagnosticsLog
  if (diagnosticsLogOverride) return diagnosticsLogOverride
  if (diagnosticsLog) return diagnosticsLog
  diagnosticsLog = createDiagnosticsLog({
    dir: diagnosticsLogDir(app.getPath('userData')),
    ...(engineOverrides.now ? { now: engineOverrides.now } : {}),
  })
  return diagnosticsLog
}

/** The absolute path of the live log, for the user-facing "where is it" answer. */
export function tendersDiagnosticsPath(): string {
  return getTendersDiagnosticsLog().path()
}

/**
 * The running version, for the log's first line.
 *
 * `app.getVersion()` is always present in a real Electron process; this guards
 * the read so a host that does not expose it cannot make the startup
 * diagnostic the reason the app fails to start. A log line saying `unknown` is
 * still a log line that says what wrote it.
 */
function tendersAppVersion(): string {
  try {
    return typeof app.getVersion === 'function' ? app.getVersion() : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Test seam: install a sink, or `null` to rebuild the real one on next use. */
export function setTendersDiagnosticsLogForTests(log: DiagnosticsLog | null): void {
  diagnosticsLogOverride = log
}

function recordDiagnostic(
  level: 'info' | 'warn' | 'error',
  source: string,
  message: string,
  detail?: Record<string, unknown>,
): void {
  try {
    getTendersDiagnosticsLog().record({ level, source, message, ...(detail ? { detail } : {}) })
  } catch {
    // The sink never throws by contract; a sink that is not there yet must not
    // turn a diagnostic into a failure of the operation being diagnosed.
  }
}

/** Record a legacy-read refusal, naming the file and the reason. */
function noteLegacyReadFailure(path: string, error: unknown): void {
  recordDiagnostic('error', 'tenders-main', 'The saved Tenders file could not be read.', {
    path,
    reason: errorMessage(error, 'unknown'),
  })
}

/**
 * The recoverable copies main can see for a legacy file it could not read: the
 * `.corrupted.bak` it just quarantined alongside the live file. Deliberately NOT
 * the v2 store's own candidate list — that store owns a different document, and
 * offering its backups for a v1 file would be a recovery path that restores the
 * wrong thing.
 */
async function listLegacyRecoveryCandidates(): Promise<TendersRecoveryCandidate[]> {
  const candidates: TendersRecoveryCandidate[] = []
  const directory = getTendersBaseDir()
  try {
    for (const name of readdirSync(directory)) {
      if (!/\.corrupted\.bak$/.test(name)) continue
      const full = join(directory, name)
      try {
        const information = statSync(full)
        candidates.push({
          id: name,
          path: name,
          source: 'primary',
          reason: 'Quarantined copy of the file that could not be read.',
          updatedAt: information.mtime.toISOString(),
          valid: false,
          sizeBytes: information.size,
        })
      } catch {
        // the copy disappeared between listing and stat
      }
    }
  } catch {
    // the directory is unreadable; the failure above is the one to report
  }
  return candidates
}

const activeTendersWebContents = new Set<WebContents>()
const authoritativeTendersStores = new Map<string, TendersStore>()
let fileWatcher: FSWatcher | null = null
let lastBroadcastJson = ''
let watchDebounceTimer: ReturnType<typeof setTimeout> | null = null

export function registerTendersWebContents(wc: WebContents): void {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return
  activeTendersWebContents.add(wc)
  if (typeof wc.once === 'function') {
    wc.once('destroyed', () => {
      activeTendersWebContents.delete(wc)
    })
  }
}

export function unregisterTendersWebContents(wc: WebContents): void {
  activeTendersWebContents.delete(wc)
}

export function getActiveTendersWebContents(): WebContents[] {
  return Array.from(activeTendersWebContents).filter(
    (wc) => typeof wc.isDestroyed !== 'function' || !wc.isDestroyed(),
  )
}

function trustedRendererUrl(url: string): boolean {
  try {
    if (runtime.rendererUrl && new URL(url).origin === new URL(runtime.rendererUrl).origin)
      return true
    if (runtime.rendererFile) {
      const expected = runtime.rendererFile.startsWith('file:')
        ? runtime.rendererFile
        : pathToFileURL(resolve(runtime.rendererFile)).href
      return new URL(url).href === new URL(expected).href
    }
  } catch {}
  return false
}

function isTrustedTendersEvent(
  event: { sender?: unknown; senderFrame?: { url?: string; parent?: unknown } | null } | undefined,
): boolean {
  const sender = event?.sender
  if (!getActiveTendersWebContents().some((wc) => wc === sender)) return false
  if (event?.senderFrame?.parent !== undefined && event.senderFrame.parent !== null) return false
  // Fail closed when the trusted renderer origin was never configured: with no
  // expected origin there is no way to prove the sender is the real renderer.
  if (!runtime.rendererUrl && !runtime.rendererFile) return false
  const url =
    event?.senderFrame?.url ||
    (sender && typeof (sender as { getURL?: () => string }).getURL === 'function'
      ? (sender as { getURL: () => string }).getURL()
      : '')
  return typeof url === 'string' && trustedRendererUrl(url)
}

function isTrustedTendersWebContents(wc: WebContents): boolean {
  if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return false
  // Fail closed for an unconfigured origin, and for any object that cannot
  // report its URL (a real Electron WebContents always can).
  if (!runtime.rendererUrl && !runtime.rendererFile) return false
  if (typeof (wc as unknown as { getURL?: () => string }).getURL !== 'function') return false
  const url = (wc as unknown as { getURL: () => string }).getURL()
  return trustedRendererUrl(url)
}

function unauthorizedTendersRequest(): { ok: false; error: TendersPersistenceError } {
  return {
    ok: false,
    error: { code: 'INVALID_REQUEST', message: 'Sender is not a registered Tenders WebContents.' },
  }
}

/**
 * The authoritative store for the app-owned Tenders directory. There is NO
 * path override: the store location is always resolved in main from
 * `app.getPath('userData')`, so a renderer-supplied path can never reopen the
 * renderer-path hole (all callers pass no argument).
 */
function getAuthoritativeTendersStore(): TendersStore {
  const directory = resolve(getTendersBaseDir())
  const existing = authoritativeTendersStores.get(directory)
  if (existing) return existing
  const store = gateTendersCommits(
    createTendersStore({
      directory,
      onCommitted: async (document: TendersDataV2) => {
        const failures: string[] = []
        for (const wc of getActiveTendersWebContents()) {
          if (!isTrustedTendersWebContents(wc)) continue
          try {
            wc.send(TENDERS_CHANNELS.storeChangedV2, structuredClone(document))
          } catch (error: unknown) {
            failures.push(error instanceof Error ? error.message : String(error))
          }
        }
        if (failures.length > 0) throw new Error(failures.join('; '))
      },
    }),
  )
  authoritativeTendersStores.set(directory, store)
  return store
}

/**
 * Wrap the authoritative store so the submission-readiness gate is part of its
 * commit rather than the prelude of one IPC caller. `saveStoreV2` and the legacy
 * `saveStoredData` channel — plus the internal `mutate` used by CRM sync and
 * milestone billing — all commit through here, so a forged `ready: true`
 * receipt can no longer ride a sibling channel into the store.
 *
 * `restoreRecoveryCandidate` is deliberately not gated: its input is a
 * main-authored backup of a document that already committed through this gate,
 * never a renderer payload.
 */
function gateTendersCommits(store: TendersStore): TendersStore {
  const gate = async (document: unknown, previous: TendersDataV2 | null): Promise<void> => {
    if (!isRecord(document) || !claimsClearSubmissionReadiness(document)) return
    try {
      const repaired = repairSubmissionReadinessSnapshots(
        document as unknown as TendersDataV2,
        previous,
        new Date(),
      )
      if (repaired > 0) {
        const message = `Recomputed ${repaired} submission readiness checkpoint(s) that contradicted canonical readiness.`
        console.warn(`tenders-main: ${message}`)
        recordDiagnostic('warn', 'readiness-gate', message, { recomputed: repaired })
      }
    } catch {
      // A document malformed enough to break the recomputation cannot commit
      // either: the store validates the document before it writes.
    }
  }
  return {
    ...store,
    save: async (request) => {
      // The previously committed document is the baseline the carried-over
      // exemption compares against; read it only when a claim needs checking.
      const previous = claimsClearSubmissionReadiness(request?.document) ? await store.load() : null
      await gate(request?.document, previous?.ok ? previous.data : null)
      return store.save(request)
    },
    mutate: (expectedRevision, mutator) =>
      store.mutate(expectedRevision, async (document) => {
        const proposed = await mutator(document)
        await gate(proposed, document)
        return proposed
      }),
  }
}

const managedDocumentStores = new Map<string, ManagedDocumentStore>()

/** Managed-document metadata store for the active Tenders base directory. */
function getManagedDocumentStore(overrideUserData?: string): ManagedDocumentStore {
  const directory = resolve(getTendersBaseDir(overrideUserData))
  const existing = managedDocumentStores.get(directory)
  if (existing) return existing
  const store = createManagedDocumentStore({ baseDir: directory })
  managedDocumentStores.set(directory, store)
  return store
}

function validOptionalString(value: unknown, maxLength: number): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.length <= maxLength)
  )
}

const PROPOSAL_TOP_LEVEL_KEYS = new Set([
  'id',
  'title',
  'referenceNumber',
  'issuingBody',
  'closingDate',
  'estimatedValue',
  'pricingConfirmed',
  'requirements',
  'milestones',
  'signatureChecks',
  // Legacy renderer fields are accepted only to preserve caller compatibility; they are ignored.
  'readinessReport',
  'ready',
  'healthStatus',
])
const PROPOSAL_REQUIREMENT_KEYS = new Set([
  'id',
  'title',
  'verbatimClause',
  'isMandatory',
  'status',
  'linkedVaultDocId',
  'healthStatus',
  'ruleKey',
  'reason',
  'notApplicableReason',
  'notes',
])
const PROPOSAL_MILESTONE_KEYS = new Set(['id', 'name', 'title', 'amount', 'dueDate'])
const PROPOSAL_STATUSES = new Set(['FULFILLED', 'ACTION_REQUIRED', 'OUTSTANDING', 'NOT_APPLICABLE'])
const PROPOSAL_HEALTH_STATES = new Set([
  'VALID',
  'EXPIRED',
  'STALE_CERTIFICATION',
  'NO_EXPIRY_INFO',
  'UNKNOWN',
  'INVALID_DATE',
])

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function aggregateStringChars(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return value.length
  if (!value || typeof value !== 'object') return 0
  if (seen.has(value)) return Number.POSITIVE_INFINITY
  seen.add(value)
  let total = 0
  if (Array.isArray(value)) {
    for (const item of value) total += aggregateStringChars(item, seen)
  } else {
    for (const child of Object.values(value)) total += aggregateStringChars(child, seen)
  }
  return total
}

function validProposalPayload(value: unknown): value is ProposalInput {
  if (!isRecord(value)) return false
  if (!hasOnlyKeys(value, PROPOSAL_TOP_LEVEL_KEYS)) return false
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 256 * 1024) return false
  } catch {
    return false
  }
  if (aggregateStringChars(value) > 64 * 1024) return false
  if (
    !validOptionalString(value.title, 500) ||
    !validOptionalString(value.referenceNumber, 500) ||
    !validOptionalString(value.issuingBody, 500) ||
    !validOptionalString(value.closingDate, 120)
  )
    return false
  if (
    value.estimatedValue !== undefined &&
    (typeof value.estimatedValue !== 'number' ||
      !Number.isFinite(value.estimatedValue) ||
      value.estimatedValue < 0)
  )
    return false
  if (value.pricingConfirmed !== undefined && typeof value.pricingConfirmed !== 'boolean')
    return false
  if (value.id !== undefined && !validOptionalString(value.id, 200)) return false
  if (value.ready !== undefined && typeof value.ready !== 'boolean') return false
  if (!validOptionalString(value.healthStatus, 64)) return false
  if (value.readinessReport !== undefined && !isRecord(value.readinessReport)) return false

  if (value.requirements !== undefined) {
    if (!Array.isArray(value.requirements) || value.requirements.length > 500) return false
    for (const raw of value.requirements) {
      if (!isRecord(raw)) return false
      if (!hasOnlyKeys(raw, PROPOSAL_REQUIREMENT_KEYS)) return false
      const hasTitle =
        typeof raw.title === 'string' && raw.title.trim().length > 0 && raw.title.length <= 500
      const hasClause =
        typeof raw.verbatimClause === 'string' &&
        raw.verbatimClause.trim().length > 0 &&
        raw.verbatimClause.length <= 2000
      if (!hasTitle && !hasClause) return false
      if (
        !validOptionalString(raw.id, 200) ||
        !validOptionalString(raw.status, 64) ||
        !validOptionalString(raw.linkedVaultDocId, 500) ||
        !validOptionalString(raw.healthStatus, 64) ||
        !validOptionalString(raw.ruleKey, 100) ||
        !validOptionalString(raw.reason, 2000) ||
        !validOptionalString(raw.notApplicableReason, 2000) ||
        !validOptionalString(raw.notes, 2000)
      )
        return false
      if (raw.isMandatory !== undefined && typeof raw.isMandatory !== 'boolean') return false
      if (
        raw.status !== undefined &&
        (typeof raw.status !== 'string' || !PROPOSAL_STATUSES.has(raw.status))
      )
        return false
      if (
        raw.healthStatus !== undefined &&
        (typeof raw.healthStatus !== 'string' || !PROPOSAL_HEALTH_STATES.has(raw.healthStatus))
      )
        return false
    }
  }

  if (value.milestones !== undefined) {
    if (!Array.isArray(value.milestones) || value.milestones.length > 500) return false
    for (const raw of value.milestones) {
      if (!isRecord(raw)) return false
      if (!hasOnlyKeys(raw, PROPOSAL_MILESTONE_KEYS)) return false
      const hasName =
        typeof raw.name === 'string' && raw.name.trim().length > 0 && raw.name.length <= 500
      const hasTitle =
        typeof raw.title === 'string' && raw.title.trim().length > 0 && raw.title.length <= 500
      if (!hasName && !hasTitle) return false
      if (
        raw.amount !== undefined &&
        (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || raw.amount <= 0)
      )
        return false
      if (!validOptionalString(raw.dueDate, 120)) return false
    }
  }

  if (value.signatureChecks !== undefined) {
    if (!isRecord(value.signatureChecks) || Object.keys(value.signatureChecks).length > 50)
      return false
    if (Object.keys(value.signatureChecks).some((key) => key.length > 100)) return false
    if (Object.values(value.signatureChecks).some((checked) => typeof checked !== 'boolean'))
      return false
  }
  return true
}

function writeGeneratedProposal(content: string): string {
  const outputDir = join(getTendersBaseDir(), 'generated')
  mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  const outputPath = join(outputDir, `${randomUUID()}.md`)
  writeFileSync(outputPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return outputPath
}

export function broadcastTendersData(data: TendersData): void {
  const json = JSON.stringify(data)
  if (Buffer.byteLength(json, 'utf8') > MAX_TENDERS_DOCUMENT_BYTES) return
  lastBroadcastJson = json
  for (const wc of activeTendersWebContents) {
    if (isTrustedTendersWebContents(wc)) {
      try {
        wc.send(TENDERS_CHANNELS.dataChanged, data)
      } catch (err) {
        console.warn('tenders-main: failed to broadcast dataChanged to WebContents:', err)
      }
    }
  }
}

let watchedFilePath = ''

/**
 * Is this process a test runner? The legacy store watcher is a deliberate,
 * fully-executed piece of machinery that must not be running in production (see
 * the retirement note above), but the tests that pin its behaviour drive it
 * directly through `startTendersStoreWatcher`.
 */
function legacyWatcherAllowed(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
}

export function startTendersStoreWatcher(targetPath?: string): void {
  // Retirement guard for the production path: `registerTendersIpc` no longer
  // starts the watcher at all (`tenders:data-changed` has had zero subscribers
  // since the v2 store landed), and this second gate means even an accidental
  // re-introduction cannot put a live `fs.watch` back on a shipping build.
  // Tests set VITEST, so the watcher's own suite still exercises it for real.
  if (!legacyWatcherAllowed()) return
  const filePath = targetPath || getStoragePath()
  const dir = filePath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  if (fileWatcher) {
    if (watchedFilePath === filePath) {
      return
    }
    stopTendersStoreWatcher()
  }

  watchedFilePath = filePath
  try {
    fileWatcher = watch(dir, (_eventType, filename) => {
      if (filename && filename.includes('tenders-data.json') && !filename.endsWith('.tmp')) {
        if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
        watchDebounceTimer = setTimeout(() => {
          try {
            if (existsSync(filePath)) {
              const currentData = readTendersStore(filePath)
              const currentJson = JSON.stringify(currentData)
              if (currentJson !== lastBroadcastJson) {
                lastBroadcastJson = currentJson
                broadcastTendersData(currentData)
              }
            }
          } catch (err) {
            console.warn('tenders-main: error in file watcher handler:', err)
          }
        }, 100)
      }
    })
  } catch (err) {
    console.warn('tenders-main: could not start tenders-data.json watcher:', err)
  }
}

export function stopTendersStoreWatcher(): void {
  watchedFilePath = ''
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer)
    watchDebounceTimer = null
  }
  if (fileWatcher) {
    try {
      fileWatcher.close()
    } catch {}
    fileWatcher = null
  }
}

export function writeTendersStore(baseDirOrPath: string, data: unknown): void {
  const filePath = baseDirOrPath.endsWith('tenders-data.json')
    ? baseDirOrPath
    : join(baseDirOrPath, 'tenders-data.json')
  const dir = filePath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const validated = migrateAndValidateTenders(data)
  const serialized = JSON.stringify(validated, null, 2)
  // The store this file is read back through refuses anything above
  // `MAX_TENDERS_STORE_FILE_BYTES`, and what is written here is the same document
  // pretty-printed — indentation can push it past that ceiling (measured up to
  // 3.57x for arrays of empty strings). Checked before the temp file exists, so a
  // refused write leaves neither a temp file nor a primary the loader rejects.
  const serializedBytes = Buffer.byteLength(serialized, 'utf8')
  if (serializedBytes > MAX_TENDERS_STORE_FILE_BYTES) {
    throw new Error(
      `Serialized Tenders document would be ${serializedBytes} bytes on disk, above the ${MAX_TENDERS_STORE_FILE_BYTES}-byte store file limit.`,
    )
  }
  const tmp = `${filePath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
  try {
    writeFileSync(tmp, serialized, 'utf8')
    // Same bounded EBUSY/EPERM retry the managed documents get. The primary had
    // none, so a reader holding `tenders-data.json` open — a scanner, a sync
    // client, OneDrive — turned a perfectly good write into a hard failure.
    renameWithBoundedRetry(tmp, filePath)
    broadcastTendersData(validated)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    console.error('tenders-main: failed to atomically write tenders store', filePath, e)
    throw e
  }
}

export interface TendersRuntimeConfig {
  preloadPath: string
  rendererUrl?: string | undefined
  rendererFile: string
  openGeneratedPath?: (path: string) => boolean
  onOpenCrm?: (dealId?: string) => void
  onOpenBooks?: (invoiceId?: string) => void
  /**
   * Composition-root injected cross-app ports (CRM/Books). Omit to use the
   * built-in adapters; pass `{}` to run with integrations disabled.
   */
  integrations?: TendersIntegrations
}

let runtime: TendersRuntimeConfig = {
  preloadPath: '',
  rendererFile: '',
}

let ipcRegistered = false

export function getTendersBaseDir(overrideUserData?: string): string {
  const dir = join(overrideUserData || app.getPath('userData'), 'tenders')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function getTendersDocumentsDir(overrideUserData?: string): string {
  const dir = join(getTendersBaseDir(overrideUserData), 'documents')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function getTendersVaultDir(overrideUserData?: string): string {
  const dir = join(getTendersBaseDir(overrideUserData), 'vault')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function resolveSafeTendersPath(
  storedPath: string,
  overrideUserData?: string,
): { safe: boolean; fullPath: string; error?: string } {
  if (!storedPath || typeof storedPath !== 'string') {
    return { safe: false, fullPath: '', error: 'Stored path is required' }
  }
  if (storedPath.includes('\0')) {
    return { safe: false, fullPath: '', error: 'Null byte detected in path' }
  }
  const root = resolve(getTendersBaseDir(overrideUserData))
  const resolved = resolve(root, storedPath)
  const docsDir = resolve(getTendersDocumentsDir(overrideUserData))
  const docsDirWithSep = docsDir.endsWith(sep) ? docsDir : docsDir + sep
  const vaultDir = resolve(getTendersVaultDir(overrideUserData))
  const vaultDirWithSep = vaultDir.endsWith(sep) ? vaultDir : vaultDir + sep

  // Must strictly be inside either documents/ or vault/ subdirectories
  const isInsideDocs = resolved.startsWith(docsDirWithSep) && resolved !== docsDir
  const isInsideVault = resolved.startsWith(vaultDirWithSep) && resolved !== vaultDir

  if (!isInsideDocs && !isInsideVault) {
    return { safe: false, fullPath: '', error: 'Directory traversal detected' }
  }
  return { safe: true, fullPath: resolved }
}

/**
 * The confinement check that actually holds, on top of the lexical one above.
 *
 * `resolveSafeTendersPath` validates the TEXT: no `..`, no absolute path, no
 * drive-relative form. That is not containment. A symlink or NTFS junction
 * planted at one managed leaf — or replacing `documents/` itself — passes every
 * text check and still resolves outside the Tenders directory, and this product
 * ingests untrusted third-party PDFs, so the filesystem's own answer is the one
 * that has to be asserted.
 *
 * Resolves the real root and the real path and re-asserts the `documents/` or
 * `vault/` prefix against them. A real root that is itself a link (or sits under
 * a base directory that is one) is refused outright, because `realpath` would
 * have followed it and every prefix check afterwards would then agree with the
 * escape.
 */
export function resolveConfinedTendersPath(
  storedPath: string,
  overrideUserData?: string,
): { safe: boolean; fullPath: string; error?: string } {
  const lexical = resolveSafeTendersPath(storedPath, overrideUserData)
  if (!lexical.safe) return lexical
  const directory = storedPath.replace(/\\/g, '/').split('/')[0]
  if (directory !== 'documents' && directory !== 'vault') {
    // The two directories whose real root is checked below. A path that reaches
    // them by another spelling has already been refused by the lexical check, so
    // this is a belt-and-braces guard rather than the boundary.
    return { safe: false, fullPath: '', error: 'Directory traversal detected' }
  }
  const baseDir = resolve(getTendersBaseDir(overrideUserData))
  const lexicalRoot = join(baseDir, directory)
  try {
    if (lstatSync(baseDir).isSymbolicLink() || lstatSync(lexicalRoot).isSymbolicLink()) {
      return {
        safe: false,
        fullPath: '',
        error: 'The managed document directory is a link outside the Tenders data directory',
      }
    }
  } catch {
    return { safe: false, fullPath: '', error: 'File not found on disk' }
  }
  let realRoot: string
  let realFull: string
  try {
    realRoot = realpathSync(lexicalRoot)
    realFull = realpathSync(lexical.fullPath)
  } catch {
    return { safe: false, fullPath: '', error: 'File not found on disk' }
  }
  const normalizedRoot = realRoot.endsWith(sep) ? realRoot : realRoot + sep
  const compare = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value
  if (!compare(realFull).startsWith(compare(normalizedRoot))) {
    return {
      safe: false,
      fullPath: '',
      error: 'The stored path resolves outside the Tenders data directory',
    }
  }
  let leaf: ReturnType<typeof lstatSync>
  try {
    leaf = lstatSync(realFull)
  } catch {
    return { safe: false, fullPath: '', error: 'File not found on disk' }
  }
  // A link is never a document this app wrote: `saveDocumentFile` writes into a
  // name it composed, with `flag: 'wx'`.
  if (leaf.isSymbolicLink() || !leaf.isFile()) {
    return {
      safe: false,
      fullPath: '',
      error: 'The stored path is not a regular file inside the Tenders data directory',
    }
  }
  return { safe: true, fullPath: realFull }
}

export function atomicWriteDocumentFile(targetPath: string, buffer: Buffer): void {
  const dir = targetPath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const tmp = `${targetPath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
  try {
    writeFileSync(tmp, buffer)
    renameWithBoundedRetry(tmp, targetPath)
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    throw err
  }
}

/**
 * Atomic rename with a bounded retry for the two Windows-only transient codes.
 *
 * A reader holding the destination open (a scanner, a sync client, the app's own
 * `fs.watch` handler between two reads) makes `renameSync` fail with `EBUSY` or
 * `EPERM` on Windows even though nothing is wrong with the write. Every atomic
 * write in this file goes through here, so the primary `tenders-data.json` gets
 * the same treatment the managed documents always had — the asymmetry between
 * the two was the defect.
 *
 * The delay SLEEPS rather than spinning: the previous implementation burned a
 * full 15 ms of CPU per attempt waiting for a lock it was not holding, on the
 * main process's thread. Attempts are capped, so a genuinely locked destination
 * still fails with its own error rather than hanging the app.
 */
const RENAME_RETRY_ATTEMPTS = 3
const RENAME_RETRY_DELAY_MS = 15

export function renameWithBoundedRetry(from: string, to: string): void {
  let lastError: unknown = null
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error: unknown) {
      lastError = error
      const code = (error as { code?: unknown } | null)?.code
      if (code !== 'EBUSY' && code !== 'EPERM') throw error
      if (attempt < RENAME_RETRY_ATTEMPTS - 1) sleepSync(RENAME_RETRY_DELAY_MS)
    }
  }
  throw lastError
}

/** Block this thread for `ms`, without spinning a core for the whole duration. */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(shared, 0, 0, ms)
}

let lastSaveTimestamp = 0
export function getUniqueTimestamp(): number {
  const now = Date.now()
  lastSaveTimestamp = now > lastSaveTimestamp ? now : lastSaveTimestamp + 1
  return lastSaveTimestamp
}

export async function saveDocumentFile(
  req: SaveDocumentRequest,
  overrideUserData?: string,
): Promise<SaveDocumentResponse> {
  try {
    if (!req || typeof req !== 'object') {
      return { ok: false, error: 'Invalid request payload' }
    }
    const { fileName, buffer, category } = req
    if (!fileName || typeof fileName !== 'string') {
      return { ok: false, error: 'File name is required' }
    }
    if (!buffer) {
      return { ok: false, error: 'File buffer is required' }
    }
    if (category !== 'rfp' && category !== 'vault') {
      return { ok: false, error: 'Category must be either "rfp" or "vault"' }
    }
    const fileBuf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as any)
    // Bounded upload: reject before any filesystem work or sanitisation so an
    // oversized document cannot stream across IPC or be written.
    if (fileBuf.byteLength > MAX_TENDERS_DOCUMENT_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `Document exceeds the ${MAX_TENDERS_DOCUMENT_UPLOAD_BYTES}-byte upload limit.`,
      }
    }

    // Route through the managed-document store so every saved file gets durable
    // metadata (id/size/MIME/hash/timestamps). Filenames stay timestamped.
    const saved = await getManagedDocumentStore(overrideUserData).save({
      fileName,
      buffer: fileBuf,
      category,
    })
    if (!saved.ok) return { ok: false, error: saved.error }
    return {
      ok: true,
      storedPath: saved.record.relativePath,
      id: saved.record.id,
      record: saved.record,
    }
  } catch (err: any) {
    console.error('tenders-main: failed to save document file', err)
    return { ok: false, error: err?.message || 'Failed to save document' }
  }
}

export async function readDocumentFile(
  req: ReadDocumentRequest,
  overrideUserData?: string,
): Promise<ReadDocumentResponse> {
  try {
    if (!req || typeof req !== 'object' || !req.storedPath) {
      return { ok: false, error: 'Stored path is required' }
    }
    const check = resolveConfinedTendersPath(req.storedPath, overrideUserData)
    if (!check.safe) {
      return { ok: false, error: check.error || 'Invalid or unsafe path' }
    }
    if (!existsSync(check.fullPath)) {
      return { ok: false, error: 'File not found on disk' }
    }
    // Bounded read: never stream an oversized file back across IPC.
    if (statSync(check.fullPath).size > MAX_TENDERS_DOCUMENT_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `Document exceeds the ${MAX_TENDERS_DOCUMENT_UPLOAD_BYTES}-byte read limit.`,
      }
    }
    const buf = readFileSync(check.fullPath)
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return { ok: true, buffer: arrayBuffer }
  } catch (err: any) {
    console.error('tenders-main: failed to read document file', err)
    return { ok: false, error: err?.message || 'Failed to read document' }
  }
}

export async function openDocumentFile(
  req: OpenDocumentRequest,
  overrideUserData?: string,
): Promise<OpenDocumentResponse> {
  try {
    if (!req || typeof req !== 'object' || !req.storedPath) {
      return { ok: false, error: 'Stored path is required' }
    }
    // Confinement is proven against the real filesystem, not the text: a link
    // planted at a managed leaf would otherwise hand `shell.openPath` a path
    // that resolves outside the Tenders directory.
    const check = resolveConfinedTendersPath(req.storedPath, overrideUserData)
    if (!check.safe) {
      return { ok: false, error: check.error || 'Invalid or unsafe path' }
    }
    if (!existsSync(check.fullPath)) {
      return { ok: false, error: 'File not found on disk' }
    }
    // `shell.openPath` hands the file to the OS, which FOLLOWS a `.lnk` shortcut
    // and runs a launcher. A managed document is a PDF, a DOCX or an image —
    // never a shortcut or a launcher script — so the extension is refused here
    // rather than trusted to the shell.
    const extension = extname(check.fullPath).toLowerCase()
    if (WINDOWS_LAUNCHER_EXTENSIONS.has(extension)) {
      return {
        ok: false,
        error: `A ${extension} file is a launcher or shortcut and is not opened from Tenders.`,
      }
    }
    const openErr = await shell.openPath(check.fullPath)
    if (openErr) {
      return { ok: false, error: openErr }
    }
    return { ok: true }
  } catch (err: any) {
    console.error('tenders-main: failed to open document file', err)
    return { ok: false, error: err?.message || 'Failed to open document' }
  }
}

/**
 * Extensions the OS treats as a launcher rather than a document. Opening one
 * through `shell.openPath` runs whatever it points at or contains, which for a
 * `.lnk` means following an attacker-chosen target.
 */
const WINDOWS_LAUNCHER_EXTENSIONS = new Set([
  '.lnk',
  '.url',
  '.pif',
  '.scf',
  '.bat',
  '.cmd',
  '.ps1',
  '.vbs',
  '.js',
  '.hta',
  '.reg',
  '.msi',
  '.exe',
])

/**
 * Soft-delete a managed document: the file is MOVED to the Tenders trash (never
 * hard-unlinked) and can be restored across a restart. Returns the records that
 * still reference it so the UI can warn/confirm.
 *
 * The managed record id is preferred over the path (see `DeleteDocumentRequest`):
 * when an id is supplied it is resolved against the managed index, and a
 * `storedPath` that names a different document is rejected rather than silently
 * deleting the wrong file.
 */
export async function deleteDocumentFile(
  req: DeleteDocumentRequest,
  overrideUserData?: string,
): Promise<DeleteDocumentResponse> {
  try {
    if (!req || typeof req !== 'object') {
      return { ok: false, error: 'Invalid request payload' }
    }
    const requestedId = typeof req.id === 'string' && req.id.length > 0 ? req.id : ''
    if (!requestedId && !req.storedPath) {
      return { ok: false, error: 'Stored path is required' }
    }
    const store = getManagedDocumentStore(overrideUserData)
    let relativePath: string | null
    if (requestedId) {
      if (requestedId.length > 512) return { ok: false, error: 'Invalid managed document id' }
      const record = (await store.listRecords()).find((candidate) => candidate.id === requestedId)
      if (!record) return { ok: false, error: `Unknown managed document id: ${requestedId}` }
      relativePath = record.relativePath
      if (req.storedPath) {
        const claimed = toManagedRelativePath(req.storedPath)
        if (claimed !== relativePath) {
          return {
            ok: false,
            error: 'The supplied id and storedPath refer to different documents.',
          }
        }
      }
    } else {
      relativePath = toManagedRelativePath(req.storedPath)
    }
    if (!relativePath) {
      return { ok: false, error: 'Invalid or unsafe path' }
    }
    const trashed = await store.trash(relativePath)

    // Link-aware warnings (best-effort; a lookup failure never blocks the move).
    let links: ManagedFileLink[] = []
    try {
      const loaded = await getAuthoritativeTendersStore().load()
      if (loaded.ok) links = findManagedFileLinks(relativePath, loaded.data)
    } catch {
      // ignore link lookup failures
    }

    if (!trashed.ok) {
      // The file was already gone and untracked: deleting is idempotent.
      const full = join(getTendersBaseDir(overrideUserData), relativePath)
      if (!existsSync(full)) return { ok: true, ...(links.length ? { links } : {}) }
      return { ok: false, error: trashed.error }
    }

    const warnings = links.length
      ? [
          `This file is referenced by ${links.length} record(s); it was moved to trash and can be restored.`,
        ]
      : []
    return {
      ok: true,
      ...(links.length ? { links } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(trashed.entry ? { trashId: trashed.entry.id } : {}),
    }
  } catch (err: any) {
    console.error('tenders-main: failed to delete document file', err)
    return { ok: false, error: err?.message || 'Failed to delete document' }
  }
}

// ── Managed-document lifecycle helpers (Phase 5 WP-9) ────────────────────────

export async function listDocumentTrashFile(
  overrideUserData?: string,
): Promise<ListDocumentTrashResponse> {
  try {
    return { ok: true, entries: await getManagedDocumentStore(overrideUserData).listTrash() }
  } catch (err: any) {
    console.error('tenders-main: failed to list document trash', err)
    return { ok: false, error: err?.message || 'Failed to list document trash' }
  }
}

export async function restoreDocumentFile(
  req: RestoreDocumentRequest,
  overrideUserData?: string,
): Promise<RestoreDocumentResponse> {
  try {
    if (!req || typeof req !== 'object' || typeof req.id !== 'string' || req.id.length === 0) {
      return { ok: false, error: 'Trash entry id is required' }
    }
    const result = await getManagedDocumentStore(overrideUserData).restore(req.id)
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, record: result.record, storedPath: result.restoredPath }
  } catch (err: any) {
    console.error('tenders-main: failed to restore document', err)
    return { ok: false, error: err?.message || 'Failed to restore document' }
  }
}

export async function replaceDocumentFile(
  req: ReplaceDocumentRequest,
  overrideUserData?: string,
): Promise<ReplaceDocumentResponse> {
  try {
    if (
      !req ||
      typeof req !== 'object' ||
      typeof req.storedPath !== 'string' ||
      typeof req.fileName !== 'string'
    ) {
      return { ok: false, error: 'storedPath and fileName are required' }
    }
    if (!req.buffer) return { ok: false, error: 'File buffer is required' }
    const buffer = Buffer.isBuffer(req.buffer) ? req.buffer : Buffer.from(req.buffer as any)
    if (buffer.byteLength > MAX_TENDERS_DOCUMENT_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `Document exceeds the ${MAX_TENDERS_DOCUMENT_UPLOAD_BYTES}-byte upload limit.`,
      }
    }
    const result = await getManagedDocumentStore(overrideUserData).replace({
      storedPath: req.storedPath,
      fileName: req.fileName,
      buffer,
    })
    if (!result.ok) return { ok: false, error: result.error }
    return {
      ok: true,
      record: result.record,
      storedPath: result.record.relativePath,
      previousTrashed: result.previousTrashed,
      ...(result.warning ? { warning: result.warning } : {}),
    }
  } catch (err: any) {
    console.error('tenders-main: failed to replace document', err)
    return { ok: false, error: err?.message || 'Failed to replace document' }
  }
}

export async function reconcileDocumentFiles(
  overrideUserData?: string,
): Promise<ReconcileDocumentsResponse> {
  try {
    return { ok: true, reconciliation: await getManagedDocumentStore(overrideUserData).reconcile() }
  } catch (err: any) {
    console.error('tenders-main: failed to reconcile documents', err)
    return { ok: false, error: err?.message || 'Failed to reconcile documents' }
  }
}

export async function cleanupDocumentTrash(
  req: CleanupDocumentTrashRequest,
  overrideUserData?: string,
): Promise<CleanupDocumentTrashResponse> {
  try {
    if (req !== undefined && (typeof req !== 'object' || req === null)) {
      return { ok: false, error: 'Invalid cleanup request' }
    }
    if (
      req?.olderThanMs !== undefined &&
      (typeof req.olderThanMs !== 'number' || req.olderThanMs < 0)
    ) {
      return { ok: false, error: 'olderThanMs must be a non-negative number' }
    }
    const result = await getManagedDocumentStore(overrideUserData).cleanupTrash({
      all: req?.all === true,
      ...(typeof req?.olderThanMs === 'number' ? { olderThanMs: req.olderThanMs } : {}),
    })
    return { ok: true, removed: result.removed }
  } catch (err: any) {
    console.error('tenders-main: failed to clean up document trash', err)
    return { ok: false, error: err?.message || 'Failed to clean up document trash' }
  }
}

// ── Recovery helpers (Phase 5 WP-2 remainder) ────────────────────────────────

export async function listRecoveryCandidatesFile(): Promise<ListRecoveryCandidatesResponse> {
  try {
    const candidates = await getAuthoritativeTendersStore().listRecoveryCandidates()
    return { ok: true, candidates }
  } catch (err: any) {
    console.error('tenders-main: failed to list recovery candidates', err)
    return { ok: false, error: err?.message || 'Failed to list recovery candidates' }
  }
}

export async function restoreRecoveryCandidateFile(
  req: RestoreRecoveryCandidateRequest,
): Promise<RestoreRecoveryCandidateResponse> {
  try {
    if (!req || typeof req !== 'object' || typeof req.id !== 'string' || req.id.length === 0) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Candidate id is required.' } }
    }
    const result = await getAuthoritativeTendersStore().restoreRecoveryCandidate(req.id)
    if (!result.ok) {
      return { ok: false, error: { code: result.error.code, message: result.error.message } }
    }
    return { ok: true, data: result.data }
  } catch (err: any) {
    console.error('tenders-main: failed to restore recovery candidate', err)
    return {
      ok: false,
      error: { code: 'WRITE_FAILED', message: err?.message || 'Failed to restore candidate' },
    }
  }
}

function getStoragePath(): string {
  return join(getTendersBaseDir(), 'tenders-data.json')
}

export function configureTendersRuntime(config: TendersRuntimeConfig): void {
  if ('integrations' in config) setInjectedTendersIntegrations(config.integrations)
  runtime = { ...runtime, ...config }
}

/** Effective cross-app ports (injected by the shell, else built-in adapters). */
function getIntegrations(): TendersIntegrations {
  return resolveTendersIntegrations({ userDataDir: app.getPath('userData') })
}

/** Open the owning app at a returned entity (CRM deal / Books invoice). */
function openOwningApp(target: { app: 'crm' | 'books'; entityId?: string }): void {
  const integrations = getIntegrations()
  if (integrations.openAppAt) {
    integrations.openAppAt(target)
    return
  }
  // Legacy runtime callbacks remain supported for callers that have not
  // migrated to the typed `openAppAt` port.
  if (target.app === 'crm') runtime.onOpenCrm?.(target.entityId)
  else runtime.onOpenBooks?.(target.entityId)
}

/** Resolve a tender from the authoritative document (never from renderer paths). */
function findTenderById(
  document: TendersDataV2,
  tenderId: string,
): { workspace: TendersDataV2['workspaces'][number]; tender: TenderRecord } | null {
  for (const workspace of document.workspaces) {
    const tender = workspace.tenders.find((candidate) => candidate.id === tenderId)
    if (tender) return { workspace, tender }
  }
  return null
}

/** Main-side demo isolation: cross-app writes are refused for demo data. */
export const TENDERS_DEMO_WRITE_ERROR =
  'Demo workspace: CRM sync and Books billing are disabled for demonstration data.'

/** Main-side won-only gate for milestone billing (mirrors `milestonesAllowed`). */
export const tendersNotWonBillingError = (status: string): string =>
  `Milestone billing is only allowed for a won tender. Current status: ${status}.`

/** The checkpoints of a committed document, keyed by tender id. */
function indexReadinessSnapshots(
  document: TendersDataV2 | null,
): Map<string, TenderReadinessSnapshot> {
  const snapshots = new Map<string, TenderReadinessSnapshot>()
  for (const workspace of document?.workspaces ?? []) {
    for (const tender of workspace.tenders ?? []) {
      const snapshot = tender.submission?.readiness
      if (snapshot) snapshots.set(tender.id, snapshot)
    }
  }
  return snapshots
}

function sameReadinessSnapshot(a: TenderReadinessSnapshot, b: TenderReadinessSnapshot): boolean {
  const sameList = (left: string[], right: string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index])
  return (
    a.ready === b.ready &&
    a.score === b.score &&
    a.capturedAt === b.capturedAt &&
    sameList(a.failedCheckIds, b.failedCheckIds) &&
    sameList(a.blockingCheckIds, b.blockingCheckIds)
  )
}

/** True when any tender claims a blockers-free readiness checkpoint. */
export function claimsClearSubmissionReadiness(document: unknown): boolean {
  if (!isRecord(document) || !Array.isArray(document.workspaces)) return false
  return document.workspaces.some(
    (workspace) =>
      isRecord(workspace) &&
      Array.isArray(workspace.tenders) &&
      workspace.tenders.some(
        (tender) =>
          isRecord(tender) &&
          isRecord(tender.submission) &&
          isRecord(tender.submission.readiness) &&
          tender.submission.readiness.ready === true,
      ),
  )
}

/**
 * Recompute the readiness checkpoints this commit introduces or changes,
 * returning how many main corrected.
 *
 * A checkpoint is a renderer-authored claim about the moment a bid was
 * submitted, and the product's core promise is that its readiness receipt never
 * lies, so main lets a clear claim into the store only when it can attribute it
 * to a document canonical readiness agreed with:
 *
 *  - A checkpoint byte-identical (including `capturedAt`) to the one in the
 *    previously committed document is a CARRIED-OVER historical record: main
 *    accepted that exact value when it entered the store — every write path
 *    commits through `gateTendersCommits` — and it is not a claim about the
 *    document as it stands now, so later edits must not rewrite it.
 *  - Any other clear claim is new or changed and is accepted only when canonical
 *    readiness of the document being committed agrees with it AT THE COMMIT
 *    INSTANT, over every check. Excluding the wall-clock-dependent checks was
 *    the hole that let a renderer persist `ready: true` for a tender whose only
 *    blocker was a lapsed or absent closing date.
 *
 * A contradicted claim is REPLACED with the canonical verdict rather than
 * rejected (rejecting would let a contradicting renderer wedge the workspace),
 * and the renderer receives the corrected document, so the receipt it renders
 * matches what is on disk.
 *
 * Deliberate residual: a checkpoint already on disk that main never committed
 * (a store file written before this gate existed, or by a process outside main)
 * is trusted as a carried-over record. Corroborating a carried-over checkpoint
 * against the previous document instead was rejected: a checkpoint that was
 * truthful when recorded is contradicted by every later edit that blocks the
 * tender, so that rule would rewrite true history from the second such edit on.
 */
export function repairSubmissionReadinessSnapshots(
  incoming: TendersDataV2,
  previous: TendersDataV2 | null,
  now: Date = new Date(),
): number {
  const previousSnapshots = indexReadinessSnapshots(previous)

  let repaired = 0
  for (const workspace of incoming.workspaces ?? []) {
    for (const tender of workspace.tenders ?? []) {
      const submission = tender.submission
      const snapshot = submission?.readiness
      if (!submission || !snapshot || snapshot.ready !== true) continue
      const before = previousSnapshots.get(tender.id)
      if (before && sameReadinessSnapshot(before, snapshot)) continue

      // The gate runs on the raw payload, before the store's schema validation,
      // so a tender malformed enough to break the canonical assessment must not
      // abort the repair for the whole document (which would leave every other
      // claim unchecked too).
      const report = ((): ReturnType<typeof assessReadiness> | null => {
        try {
          return assessReadiness(tender, workspace.vault ?? [], workspace.company, now)
        } catch {
          return null
        }
      })()
      if (!report) {
        // No canonical verdict exists, so the clearance cannot be verified: it is
        // downgraded (never left as a claim of readiness) while the renderer's own
        // capture instant survives on the record.
        submission.readiness = {
          ready: false,
          score: 0,
          failedCheckIds: [...snapshot.failedCheckIds],
          blockingCheckIds: [...snapshot.blockingCheckIds],
          capturedAt: snapshot.capturedAt,
        }
        repaired += 1
        continue
      }
      if (report.ready) continue

      submission.readiness = {
        ready: false,
        score: report.score,
        failedCheckIds: report.checks.filter((check) => !check.passed).map((check) => check.id),
        blockingCheckIds: report.checks
          .filter((check) => check.blocking && !check.passed)
          .map((check) => check.id),
        capturedAt: snapshot.capturedAt,
      }
      repaired += 1
    }
  }
  return repaired
}

/**
 * Is the process running under a test runner? `resetTendersIpcForTests` deletes
 * the real `documents/`, `vault/`, `.trash`, `backups/` and
 * `managed-documents.json` under the user's Tenders directory, so it must never
 * run outside tests. Evaluated per call so a test can prove the refusal.
 */
function tendersTestModeActive(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
}

/** Test-only reset of the Tenders IPC surface and the on-disk fixtures. */
export function resetTendersIpcForTests(): void {
  if (!tendersTestModeActive()) {
    throw new Error(
      'resetTendersIpcForTests() is test-only and refuses to delete the user Tenders data.',
    )
  }
  for (const channel of Object.values(TENDERS_CHANNELS)) ipcMain.removeHandler(channel)
  stopTendersStoreWatcher()
  // A pending reminder timer must not outlive the reset: `start()` schedules a
  // real interval, and a test that left one running would keep the process (and
  // the next test's schedule) alive. The engine seams go with it, so the next
  // registration builds its client and schedule from whatever the test sets.
  setTendersEngineOverrides(null)
  activeTendersWebContents.clear()
  authoritativeTendersStores.clear()
  managedDocumentStores.clear()
  pendingCloseFlushes.clear()
  closeFlushWaiters.clear()
  // Drop the memoised diagnostics sink: it is built from `app.getPath('userData')`,
  // which a test changes between cases, so keeping it would point the next case's
  // diagnostics at the previous case's directory.
  diagnosticsLog = null
  const baseDirectory = getTendersBaseDir()
  try {
    rmSync(join(baseDirectory, 'documents'), { recursive: true, force: true })
  } catch {}
  try {
    rmSync(join(baseDirectory, 'vault'), { recursive: true, force: true })
  } catch {}
  try {
    rmSync(join(baseDirectory, '.trash'), { recursive: true, force: true })
  } catch {}
  try {
    rmSync(join(baseDirectory, 'backups'), { recursive: true, force: true })
  } catch {}
  try {
    rmSync(join(baseDirectory, 'managed-documents.json'), { force: true })
  } catch {}
  ipcRegistered = false
}

export function isTendersIpcRegisteredForTests(): boolean {
  return ipcRegistered
}

// ── Tender discovery + deadline reminders (the two wired engines) ────────────
//
// Both engines are complete and tested on their own; what this section adds is
// the transport and the lifecycle. Three rules shape it:
//
//  * **The renderer never names a network target.** The discovery client is
//    built here with the app's own cache directory, and a document link from the
//    feed is re-checked with the client's allow-list (`isAllowedDiscoveryUrl`)
//    before anything is requested.
//  * **A downloaded document becomes an ordinary managed document.** It is
//    written through the same managed-document store the RFP upload path uses
//    (`saveDocumentFile`), so it lands in `documents/` with durable metadata and
//    the renderer can read, open and delete it with the channels that already
//    exist. There is deliberately no second storage location.
//  * **Every side effect is injectable.** `setTendersEngineOverrides` swaps the
//    client factory, the scheduler factory, the download's fetch, the clock and
//    the notifier, so the whole IPC surface is provable with no network, no disk
//    and no waiting. Production never calls it.

/** The slice of a `Response` the document download uses (a superset of the client's). */
export interface DiscoveryDocumentResponse extends DiscoveryHttpResponse {
  /** Present on a real `Response`: the byte-exact fallback for a streamless one. */
  arrayBuffer?(): Promise<ArrayBuffer>
}

export type DiscoveryDocumentFetch = (
  url: string,
  init?: DiscoveryFetchInit,
) => Promise<DiscoveryDocumentResponse>

/** The real network, assignable to `DiscoveryDocumentFetch` (the typecheck proves it). */
const defaultDiscoveryDocumentFetch: DiscoveryDocumentFetch = (url, init) =>
  globalThis.fetch(url, init)

/** How long one document download may take. Mirrors the client's per-request bound. */
export const DISCOVERY_DOWNLOAD_TIMEOUT_MS = 45_000

/** Redirect hops followed while downloading, each re-checked against the allow-list. */
export const DISCOVERY_DOWNLOAD_MAX_REDIRECTS = 3

/**
 * The injected seams for the two engines. Every field is optional and the
 * defaults are the real thing, so production passes nothing and the tests can
 * replace exactly what they need to observe.
 */
export interface TendersEngineOverrides {
  /** The network the discovery client uses. */
  discoveryFetch?: DiscoveryFetch
  /** The network the document download uses. */
  documentFetch?: DiscoveryDocumentFetch
  /** Builds the discovery client (defaults to `createDiscoveryClient`). */
  createDiscoveryClient?: (options: DiscoveryClientOptions) => DiscoveryClient
  /** Builds the reminder scheduler (defaults to `createRemindersScheduler`). */
  createRemindersScheduler?: (options: RemindersSchedulerOptions) => RemindersScheduler
  /** Replaces the OS notifier (defaults to the Electron `Notification`). */
  reminderNotifier?: ReminderNotifier
  /** Replaces the reminder log hook (defaults to this app's console log). */
  reminderLog?: ReminderLog
  /** The clock the client and the scheduler read (defaults to the real one). */
  now?: () => Date
  /** Where the discovery client keeps its cache (defaults to the app's userData). */
  discoveryCacheDir?: string
  /** The scheduler's `userDataDir` (defaults to the app's userData). */
  remindersUserDataDir?: string
  /** Replaces the diagnostics sink (defaults to the real rotating file). */
  diagnosticsLog?: DiagnosticsLog
}

let engineOverrides: TendersEngineOverrides = {}
const discoveryClients = new Map<string, DiscoveryClient>()
let remindersScheduler: RemindersScheduler | null = null

/**
 * Replace (or clear) the engine seams. A client or a schedule built from the
 * previous seams is dropped rather than reused: mixing them would make the
 * transport unreproducible in exactly the tests this seam exists for.
 */
export function setTendersEngineOverrides(overrides: TendersEngineOverrides | null): void {
  engineOverrides = overrides ?? {}
  discoveryClients.clear()
  stopTendersReminders()
  remindersScheduler = null
}

/**
 * The app's reminder log. The scheduler reports every dropped notification and
 * every unreadable state file through this hook, so passing it is what keeps
 * "the platform could not show this" visible instead of silent.
 *
 * It now goes to the diagnostics file as well as the console. A reminder that
 * never reached the user is exactly the kind of contained failure a support
 * engineer needs to see afterwards, and `console.warn` on a packaged build is
 * read by nobody.
 */
const defaultReminderLog: ReminderLog = (event) => {
  const subject = [event.tenderId, event.thresholdId].filter(Boolean).join(' ')
  const line = `tenders-main: reminders: ${event.message}${subject ? ` (${subject})` : ''}`
  if (event.level === 'warn') console.warn(line)
  else console.info(line)
  recordDiagnostic(event.level === 'warn' ? 'warn' : 'info', 'reminders', event.message, {
    ...(event.tenderId ? { tenderId: event.tenderId } : {}),
    ...(event.thresholdId ? { thresholdId: event.thresholdId } : {}),
  })
}

/** The discovery client for this app's data directory (memoised per cache dir). */
function getDiscoveryClient(): DiscoveryClient {
  const cacheDir = engineOverrides.discoveryCacheDir ?? discoveryCacheDir(app.getPath('userData'))
  const existing = discoveryClients.get(cacheDir)
  if (existing) return existing
  const build = engineOverrides.createDiscoveryClient ?? createDiscoveryClient
  const client = build({
    cacheDir,
    ...(engineOverrides.discoveryFetch ? { fetchImpl: engineOverrides.discoveryFetch } : {}),
    ...(engineOverrides.now ? { now: engineOverrides.now } : {}),
  })
  discoveryClients.set(cacheDir, client)
  return client
}

/**
 * The authoritative tender list the schedule reads — resolved from the store
 * main owns, never from a renderer payload or a caller-supplied path. A load
 * that fails throws, so the scheduler reports "the tender list could not be
 * read" rather than mistaking an unreadable store for an empty one.
 */
async function readReminderTenders(): Promise<ReminderTender[]> {
  const loaded = await getAuthoritativeTendersStore().load()
  if (!loaded.ok) throw new Error(loaded.error.message)
  const tenders: ReminderTender[] = []
  for (const workspace of loaded.data.workspaces) {
    for (const tender of workspace.tenders) {
      tenders.push({
        id: tender.id,
        title: tender.title,
        closingDate: tender.closingDate,
        status: tender.status,
      })
    }
  }
  return tenders
}

function getRemindersScheduler(): RemindersScheduler {
  if (remindersScheduler) return remindersScheduler
  const build = engineOverrides.createRemindersScheduler ?? createRemindersScheduler
  remindersScheduler = build({
    userDataDir: engineOverrides.remindersUserDataDir ?? app.getPath('userData'),
    readTenders: readReminderTenders,
    log: engineOverrides.reminderLog ?? defaultReminderLog,
    ...(engineOverrides.reminderNotifier ? { notify: engineOverrides.reminderNotifier } : {}),
    ...(engineOverrides.now ? { now: engineOverrides.now } : {}),
  })
  return remindersScheduler
}

let remindersQuitHookRegistered = false

/**
 * Stop the schedule when the process is really going away, so no timer outlives
 * the app. `will-quit` rather than `before-quit`: the shell's dirty-document
 * close flow can cancel `before-quit`, and a cancelled quit must not silently
 * end reminders.
 */
function registerRemindersQuitHook(): void {
  if (remindersQuitHookRegistered) return
  if (typeof (app as { on?: unknown }).on !== 'function') return
  remindersQuitHookRegistered = true
  app.on('will-quit', () => stopTendersReminders())
}

/**
 * Start the deadline schedule. Called from `registerTendersIpc` — the same hook
 * that starts the store watcher — so the store is available before the first
 * check reads it. `start()` is idempotent and runs one check immediately, which
 * is what surfaces a deadline that fell due while the app was closed.
 *
 * The schedule is tied to the PROCESS, not to a window: it keeps running while
 * the app runs even if the user closes the Tenders tab, which is what lets a
 * deadline warning arrive while they are working elsewhere. `will-quit` is what
 * ends it (see `registerRemindersQuitHook`), and closing the app is the one
 * thing that does stop it — the scheduler's own `REMINDERS_RUNTIME_LIMITATION`
 * sentence states that to the user.
 */
export function startTendersReminders(): void {
  registerRemindersQuitHook()
  getRemindersScheduler().start()
}

/** Stop the schedule. Idempotent; safe to call when nothing was ever started. */
export function stopTendersReminders(): void {
  remindersScheduler?.stop()
}

// ── the document download ────────────────────────────────────────────────────

type DocumentBodyRead =
  { ok: true; bytes: Buffer } | { ok: false; reason: 'too-large' | 'unreadable' }

/**
 * Read a document body, refusing it the moment it passes `maxBytes` rather than
 * after it has all been buffered — a cap that only measures is not a cap. The
 * stream is preferred (a real `Response` always exposes one); a streamless
 * response falls back to its own bytes, and one with neither is refused rather
 * than decoded as text, because decoding a PDF as text would corrupt it.
 */
async function readCappedDocumentBody(
  response: DiscoveryDocumentResponse,
  maxBytes: number,
): Promise<DocumentBodyRead> {
  const reader = response.body?.getReader?.()
  if (reader) {
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        total += value.byteLength
        if (total > maxBytes) {
          try {
            await reader.cancel?.()
          } catch {
            // A body already being refused needs no polite close.
          }
          return { ok: false, reason: 'too-large' }
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock?.()
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { ok: true, bytes: Buffer.from(merged) }
  }
  if (typeof response.arrayBuffer === 'function') {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > maxBytes) return { ok: false, reason: 'too-large' }
    return { ok: true, bytes: Buffer.from(buffer) }
  }
  return { ok: false, reason: 'unreadable' }
}

/** Resolve a `Location` header against the URL that sent it, or null. */
function resolveDocumentRedirect(base: string, location: string): string | null {
  try {
    return new URL(location, base).toString()
  } catch {
    return null
  }
}

/**
 * The name a downloaded document is stored under. The caller's name wins when it
 * gave a usable one; otherwise the last segment of the link. Either way the
 * managed store sanitizes and clamps it (`sanitizeManagedFileName`), so nothing
 * here can put a path or an over-long name on disk.
 */
export function discoveryDocumentFileName(url: string, provided?: string): string {
  const claimed = typeof provided === 'string' ? provided.trim() : ''
  if (claimed) return claimed
  try {
    const segments = new URL(url).pathname.split('/').filter((segment) => segment.length > 0)
    const last = segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]).trim() : ''
    if (last) return last
  } catch {
    // The link was validated before this point; an unreadable one has no name.
  }
  return 'tender-document'
}

function discoveryFailure(
  code: string,
  message: string,
  extra: { url?: string; status?: number } = {},
): TendersIpcFailure {
  return { ok: false, error: { code, message, ...extra } }
}

const tooLargeDocumentMessage = (): string =>
  `The tender document is larger than the ${MAX_DISCOVERY_DOWNLOAD_BYTES} bytes this app will store, so it was not downloaded.`

/**
 * Download one tender document from the feed and store it as a managed document.
 *
 * The link comes from the renderer, so it is treated as hostile input: it is
 * re-checked against the discovery allow-list (https, exact Treasury host, no
 * embedded credentials) BEFORE any request, redirects are followed manually and
 * re-checked one hop at a time, the body is capped while it is read, and the
 * whole request has a timeout. What lands on disk is an ordinary managed
 * document, saved through the same store the RFP upload path uses.
 */
export async function downloadDiscoveryDocument(
  req: DiscoveryDownloadDocumentRequest,
  overrideUserData?: string,
): Promise<DiscoveryDownloadDocumentResponse> {
  if (!isRecord(req)) {
    return discoveryFailure(
      'INVALID_REQUEST',
      'A document download needs the tender document link to fetch.',
    )
  }
  const url = typeof req.url === 'string' ? req.url.trim() : ''
  if (!url || url.length > MAX_DISCOVERY_DOCUMENT_URL_CHARS) {
    return discoveryFailure(
      'INVALID_REQUEST',
      'A document download needs the tender document link to fetch.',
    )
  }
  const claimedName = typeof req.fileName === 'string' ? req.fileName.trim() : ''
  if (claimedName.length > MAX_DISCOVERY_DOCUMENT_FILE_NAME_CHARS) {
    return discoveryFailure(
      'INVALID_REQUEST',
      `A stored document name may be at most ${MAX_DISCOVERY_DOCUMENT_FILE_NAME_CHARS} characters.`,
    )
  }
  // Before the network, and before any disk work: the renderer may name a link,
  // but only an https URL on a Treasury host this app already reads is ever
  // requested. A plain-http link, a `file:` URL, a look-alike host such as
  // `ocds-api.etenders.gov.za.evil.example`, and a URL carrying credentials are
  // all refused here with nothing fetched.
  if (!isAllowedDiscoveryUrl(url)) {
    return discoveryFailure(
      'BLOCKED_URL',
      `Only tender documents on ${DISCOVERY_ALLOWED_HOSTS.join(', ')} can be downloaded, so that address was not requested.`,
      { url },
    )
  }

  const fetchImpl = engineOverrides.documentFetch ?? defaultDiscoveryDocumentFetch
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, DISCOVERY_DOWNLOAD_TIMEOUT_MS)

  try {
    let target = url
    let redirects = 0
    for (;;) {
      const response = await fetchImpl(target, {
        signal: controller.signal,
        headers: { accept: 'application/pdf, application/octet-stream, */*' },
        redirect: 'manual',
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.('location') ?? null
        const next = location === null ? null : resolveDocumentRedirect(target, location)
        if (
          next === null ||
          !isAllowedDiscoveryUrl(next) ||
          redirects >= DISCOVERY_DOWNLOAD_MAX_REDIRECTS
        ) {
          return discoveryFailure(
            'BLOCKED_URL',
            'The eTenders host redirected this document somewhere this app is not allowed to read, so nothing was downloaded.',
            { url: target, status: response.status },
          )
        }
        redirects += 1
        target = next
        continue
      }
      if (!(response.status >= 200 && response.status < 300)) {
        return discoveryFailure(
          'HTTP_STATUS',
          `The eTenders host refused this document with status ${response.status}.`,
          { url: target, status: response.status },
        )
      }
      const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
      if (Number.isFinite(declared) && declared > MAX_DISCOVERY_DOWNLOAD_BYTES) {
        return discoveryFailure('RESPONSE_TOO_LARGE', tooLargeDocumentMessage(), { url: target })
      }
      const body = await readCappedDocumentBody(response, MAX_DISCOVERY_DOWNLOAD_BYTES)
      if (!body.ok) {
        return body.reason === 'too-large'
          ? discoveryFailure('RESPONSE_TOO_LARGE', tooLargeDocumentMessage(), { url: target })
          : discoveryFailure(
              'NETWORK',
              'The eTenders host sent a document this app could not read, so nothing was saved.',
              { url: target },
            )
      }
      if (body.bytes.byteLength === 0) {
        return discoveryFailure(
          'MALFORMED_BODY',
          'The eTenders host answered this document link with nothing, so no document was saved.',
          { url: target },
        )
      }
      const bytes = body.bytes
      const saved = await getManagedDocumentStore(overrideUserData).save({
        fileName: discoveryDocumentFileName(target, claimedName),
        buffer: bytes,
        category: 'rfp',
      })
      if (!saved.ok) {
        return discoveryFailure(
          'CACHE_WRITE',
          `The document was downloaded but could not be saved into the tender document store: ${saved.error}`,
          { url: target },
        )
      }
      return {
        ok: true,
        record: saved.record,
        storedPath: saved.record.relativePath,
        fileName: saved.record.fileName,
        mimeType: saved.record.mimeType,
        byteLength: bytes.byteLength,
        buffer: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      }
    }
  } catch {
    return timedOut
      ? discoveryFailure(
          'TIMEOUT',
          `The eTenders host did not answer within ${Math.round(DISCOVERY_DOWNLOAD_TIMEOUT_MS / 1000)} seconds, so nothing was saved.`,
          { url },
        )
      : discoveryFailure(
          'NETWORK',
          'The eTenders host could not be reached, so nothing was saved.',
          { url },
        )
  } finally {
    clearTimeout(timer)
  }
}

// ── the reminder settings patch ──────────────────────────────────────────────

type ReminderSettingsPatch =
  { ok: true; patch: Partial<ReminderSettings> } | { ok: false; error: string }

/**
 * Validate a settings patch from the renderer. `normalizeReminderSettings` drops
 * unusable entries rather than refusing them, which is right for a file this app
 * wrote and wrong for a payload it was handed: a silently dropped threshold
 * would let a user believe a lead time was set when it was not. So an unusable
 * patch is refused whole, with a reason. Unknown keys are ignored, exactly as
 * `writeSettings` ignores them: a partial write changes what it names.
 */
export function validateReminderSettingsPatch(value: unknown): ReminderSettingsPatch {
  if (!isRecord(value)) {
    return { ok: false, error: 'A reminder settings change must be an object.' }
  }
  const patch: Partial<ReminderSettings> = {}
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') {
      return { ok: false, error: 'Reminders can only be switched on or off with true or false.' }
    }
    patch.enabled = value.enabled
  }
  if (value.thresholds !== undefined) {
    if (!Array.isArray(value.thresholds)) {
      return { ok: false, error: 'The reminder lead times must be a list.' }
    }
    if (value.thresholds.length > MAX_TENDERS_REMINDER_THRESHOLDS) {
      return {
        ok: false,
        error: `At most ${MAX_TENDERS_REMINDER_THRESHOLDS} reminder lead times can be set.`,
      }
    }
    const thresholds: ReminderSettings['thresholds'] = []
    for (const candidate of value.thresholds) {
      if (!isRecord(candidate)) {
        return { ok: false, error: 'Every reminder lead time needs an id and a lead time.' }
      }
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
      if (!id || id.length > MAX_TENDERS_REMINDER_LABEL_CHARS) {
        return {
          ok: false,
          error: `Every reminder lead time needs an id of at most ${MAX_TENDERS_REMINDER_LABEL_CHARS} characters.`,
        }
      }
      const leadMs = candidate.leadMs
      if (
        typeof leadMs !== 'number' ||
        !Number.isFinite(leadMs) ||
        leadMs <= 0 ||
        leadMs > MAX_TENDERS_REMINDER_LEAD_MS
      ) {
        return {
          ok: false,
          error: `A reminder lead time must be more than zero and at most ${MAX_TENDERS_REMINDER_LEAD_MS} milliseconds before closing.`,
        }
      }
      const label = typeof candidate.label === 'string' ? candidate.label.trim() : ''
      if (label.length > MAX_TENDERS_REMINDER_LABEL_CHARS) {
        return {
          ok: false,
          error: `A reminder label may be at most ${MAX_TENDERS_REMINDER_LABEL_CHARS} characters.`,
        }
      }
      thresholds.push({ id, label: label || id, leadMs })
    }
    patch.thresholds = thresholds
  }
  return { ok: true, patch }
}

export function registerTendersIpc(): void {
  if (ipcRegistered) return

  // The first line in the log file, so a file attached to a support request says
  // what wrote it and which build. This is the only caller of
  // `recordDiagnosticsStart`: the sink is built here for the first time, and the
  // `ipcRegistered` guard above keeps the line from being written twice. It is
  // written BEFORE anything else can record — `startTendersReminders` below
  // records its own info line on its first check, and a header that arrives
  // second is not a header.
  recordDiagnosticsStart(getTendersDiagnosticsLog(), tendersAppVersion())

  // The legacy `tenders-data.json` watcher is NOT started here any more. It read
  // the v1 file back on every change and broadcast it on `tenders:data-changed`,
  // a channel with no subscribers since the authoritative v2 store landed — a
  // background reader nobody consumed. `getStoredData` (below) still serves the
  // legacy file on demand; nothing watches it.
  // Best-effort startup reconciliation of managed documents (Phase 5 WP-9):
  // persist missing/orphaned state now; the renderer shows the full report via
  // `tenders:reconcile-documents`. A failure never blocks startup.
  void getManagedDocumentStore()
    .reconcile()
    .catch(() => {})

  // Deadline reminders start with the same hook as the store watcher, so the
  // store is available before the first check reads it. `start()` is idempotent
  // and runs one check immediately; `will-quit` stops the timer (see
  // `registerRemindersQuitHook`).
  startTendersReminders()

  ipcMain.handle(TENDERS_CHANNELS.loadStoreV2, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    const result = await getAuthoritativeTendersStore().load()
    if (!result.ok) {
      // A store that could not be read is the one failure a user will report as
      // "my data is gone", and the answer has to be in the record: the code, the
      // message and how many recovery copies main can see.
      recordDiagnostic('error', 'store', result.error.message, {
        code: result.error.code,
        candidates: result.recoveryCandidates?.length ?? 0,
      })
    }
    return result
  })

  ipcMain.handle(TENDERS_CHANNELS.saveStoreV2, async (_e, request: SaveTendersRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const payloadBytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
      if (payloadBytes > MAX_TENDERS_IPC_PAYLOAD_BYTES) {
        return {
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: `IPC payload exceeds ${MAX_TENDERS_IPC_PAYLOAD_BYTES} bytes.`,
          },
        }
      }
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: error instanceof Error ? error.message : 'IPC payload cannot be serialized.',
        },
      }
    }
    // A submission readiness checkpoint is a renderer-authored claim; the
    // authoritative store recomputes the ones a commit introduces or changes
    // against canonical readiness (see `gateTendersCommits`), so no write path —
    // this one or the legacy `saveStoredData` channel — can persist a clear
    // receipt for a blocked tender.
    const result = await getAuthoritativeTendersStore().save(request)
    if (result.ok) return result
    // A refused save is the failure the user sees as "my edit did not stick".
    // Recorded with its code, so an intermittent refusal can be attributed to
    // the branch that produced it rather than to "saving sometimes fails".
    recordDiagnostic('warn', 'store', result.error.message, { code: result.error.code })
    // Compact conflict payload: never ship the full authoritative document over
    // IPC. The renderer only needs the error and the current revision; it
    // reveals its conflict UI from `code`, and reloads via `loadStoreV2`.
    return {
      ok: false,
      error: {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.schemaIssues ? { schemaIssues: result.error.schemaIssues } : {}),
      },
      currentRevision: result.current?.revision ?? result.error.current?.revision,
    }
  })

  // Shell dirty-close guard reply: the renderer reports whether its debounced
  // edit was committed. The reply is accepted only from the very view the
  // request was sent to — a sender that cannot identify itself is not that view.
  ipcMain.handle(TENDERS_CHANNELS.closeFlushResult, async (_e, payload: unknown) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    const reply = isRecord(payload) ? payload : null
    const requestId = typeof reply?.requestId === 'number' ? reply.requestId : null
    const waiter = requestId === null ? undefined : closeFlushWaiters.get(requestId)
    const senderId = (_e.sender as { id?: unknown } | undefined)?.id
    const fromGuardedView =
      waiter !== undefined && typeof senderId === 'number' && senderId === waiter.webContentsId
    if (!waiter || requestId === null || !fromGuardedView) {
      return {
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'No close-flush request is outstanding for this reply.',
        },
      }
    }
    closeFlushWaiters.delete(requestId)
    waiter.settle({
      dirty: reply?.dirty === true,
      ok: reply?.ok === true,
      error: typeof reply?.error === 'string' && reply.error.length > 0 ? reply.error : null,
    })
    return { ok: true }
  })

  // Persistence in userData/tenders/
  //
  // The legacy read path. It answers with the file that is actually on disk, or
  // `null` when there is no file at all — never with a synthesized document and
  // never with a silent empty one. A file that exists but cannot be read or
  // parsed used to be reported as `null`, which the renderer showed as "no saved
  // data": apparent data loss, with the real failure invisible. It now fails
  // CLOSED with the shared `TendersIpcFailure` shape the other privileged
  // handlers already return, names the recovery copies main can see, and asks the
  // caller to restore one — the same posture `loadStoreV2` takes for the
  // authoritative store.
  ipcMain.handle(TENDERS_CHANNELS.getStoredData, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    const p = getStoragePath()
    if (!existsSync(p)) return null
    try {
      return JSON.stringify(readTendersStore(p))
    } catch (err) {
      noteLegacyReadFailure(p, err)
      const candidates = await listLegacyRecoveryCandidates()
      return {
        ok: false,
        error: {
          code: 'RECOVERY_REQUIRED',
          message: LEGACY_TENDERS_READ_FAILED,
        },
        ...(candidates.length ? { recoveryCandidates: candidates } : {}),
      }
    }
  })

  // Legacy write channel — v2 documents only. The shipping renderer persists
  // exclusively through `saveStoreV2`; this channel is kept for caller
  // compatibility but no longer writes outside the authoritative store. A v2
  // document commits through the same lock, revision check and atomic write
  // path, and a v1/legacy payload is rejected, so it can never re-seed demo
  // company/vault/tender data into (or overwrite) the user's store.
  ipcMain.handle(TENDERS_CHANNELS.saveStoredData, async (_e, json: string) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      let parsed: unknown
      try {
        parsed = typeof json === 'string' ? JSON.parse(json) : json
      } catch (error: any) {
        return { ok: false, error: error?.message || 'Failed to parse Tenders payload' }
      }
      const validated = validateTendersDataV2(parsed)
      if (!validated.ok) {
        return {
          ok: false,
          error: `Legacy persistence accepts only a schema-v2 document: ${validated.error.message}`,
        }
      }
      const result = await getAuthoritativeTendersStore().save({
        expectedRevision: validated.data.revision,
        document: validated.data,
      })
      if (result.ok) return { ok: true }
      recordDiagnostic('warn', 'store', result.error.message, { code: result.error.code })
      return { ok: false, error: result.error.message }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save stored data' }
    }
  })

  // Persistent Document & Vault Disk Storage (R2)
  ipcMain.handle(TENDERS_CHANNELS.saveDocument, async (_e, req: SaveDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return saveDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.readDocument, async (_e, req: ReadDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return readDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.openDocument, async (_e, req: OpenDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return openDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.deleteDocument, async (_e, req: DeleteDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return deleteDocumentFile(req)
  })

  // Managed-document lifecycle (Phase 5 WP-9). Every handler is behind the same
  // trusted-sender gate and validates its request shape before touching disk.
  ipcMain.handle(TENDERS_CHANNELS.listDocumentTrash, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return listDocumentTrashFile()
  })

  ipcMain.handle(TENDERS_CHANNELS.restoreDocument, async (_e, req: RestoreDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    if (
      !req ||
      typeof req !== 'object' ||
      typeof req.id !== 'string' ||
      req.id.length === 0 ||
      req.id.length > 512
    ) {
      return { ok: false, error: 'A valid trash entry id is required' }
    }
    return restoreDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.replaceDocument, async (_e, req: ReplaceDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    if (
      !req ||
      typeof req !== 'object' ||
      typeof req.storedPath !== 'string' ||
      typeof req.fileName !== 'string' ||
      req.fileName.length > 512
    ) {
      return { ok: false, error: 'storedPath and fileName are required' }
    }
    return replaceDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.reconcileDocuments, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return reconcileDocumentFiles()
  })

  ipcMain.handle(
    TENDERS_CHANNELS.cleanupDocumentTrash,
    async (_e, req: CleanupDocumentTrashRequest) => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      return cleanupDocumentTrash(req)
    },
  )

  // Rotating backups + explicit recovery (Phase 5 WP-2 remainder).
  ipcMain.handle(TENDERS_CHANNELS.listRecoveryCandidates, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return listRecoveryCandidatesFile()
  })

  ipcMain.handle(
    TENDERS_CHANNELS.restoreRecoveryCandidate,
    async (_e, req: RestoreRecoveryCandidateRequest) => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      if (
        !req ||
        typeof req !== 'object' ||
        typeof req.id !== 'string' ||
        req.id.length === 0 ||
        req.id.length > 512
      ) {
        return {
          ok: false,
          error: { code: 'INVALID_REQUEST', message: 'A valid candidate id is required.' },
        }
      }
      return restoreRecoveryCandidateFile(req)
    },
  )

  // ── Tender discovery ───────────────────────────────────────────────────────
  // Every handler is behind the same trusted-sender gate as the rest of this
  // file, validates the request's SHAPE (never its meaning — the client owns
  // what a window, an ocid or a document link means), and passes the client's
  // own result straight back, so the renderer sees exactly the message the
  // engine produced rather than a re-worded one.

  ipcMain.handle(
    TENDERS_CHANNELS.discoveryList,
    async (_e, request: DiscoveryListRequest): Promise<DiscoveryListResponse> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      if (!isRecord(request) || !isRecord(request.window)) {
        return discoveryFailure(
          'INVALID_REQUEST',
          'A discovery request needs a window with two dates in YYYY-MM-DD form, ending no earlier than it starts.',
        )
      }
      const from = request.window.from
      const to = request.window.to
      if (typeof from !== 'string' || typeof to !== 'string') {
        return discoveryFailure(
          'INVALID_REQUEST',
          'A discovery request needs a window with two dates in YYYY-MM-DD form, ending no earlier than it starts.',
        )
      }
      const pageSize = typeof request.pageSize === 'number' ? request.pageSize : undefined
      if (request.pageSize !== undefined && typeof request.pageSize !== 'number') {
        return discoveryFailure('INVALID_REQUEST', 'A discovery page size must be a number.')
      }
      if (
        pageSize !== undefined &&
        (!Number.isFinite(pageSize) || pageSize < 1 || pageSize > 100)
      ) {
        return discoveryFailure('INVALID_REQUEST', 'A discovery page size must be from 1 to 100.')
      }
      // The dates' meaning (a real civil date, a window the feed can answer) is
      // the client's own check, and its refusal is the one the user is shown.
      return getDiscoveryClient().listOpportunities({
        window: { from, to },
        ...(pageSize === undefined ? {} : { pageSize: Math.floor(pageSize) }),
      })
    },
  )

  ipcMain.handle(
    TENDERS_CHANNELS.discoveryRefresh,
    async (_e, request: DiscoveryRefreshRequest): Promise<DiscoveryRefreshResponse> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      if (request !== undefined && !isRecord(request)) {
        return discoveryFailure(
          'INVALID_REQUEST',
          'A discovery refresh takes no arguments but a window.',
        )
      }
      const window = isRecord(request) ? request.window : undefined
      if (window !== undefined) {
        if (!isRecord(window) || typeof window.from !== 'string' || typeof window.to !== 'string') {
          return discoveryFailure(
            'INVALID_REQUEST',
            'A discovery refresh needs a window with two dates in YYYY-MM-DD form, ending no earlier than it starts.',
          )
        }
        return getDiscoveryClient().refreshCache({ window: { from: window.from, to: window.to } })
      }
      return getDiscoveryClient().refreshCache()
    },
  )

  ipcMain.handle(
    TENDERS_CHANNELS.discoveryReadCache,
    async (_e): Promise<DiscoveryReadCacheResponse> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      // Reads the last successful fetch from disk; no network, so the list is
      // available offline exactly as the local rule engine is.
      return getDiscoveryClient().readCache()
    },
  )

  ipcMain.handle(
    TENDERS_CHANNELS.discoveryRelease,
    async (_e, request: DiscoveryReleaseRequest): Promise<DiscoveryReleaseResponse> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      const ocid = isRecord(request) && typeof request.ocid === 'string' ? request.ocid.trim() : ''
      if (!ocid || ocid.length > 128) {
        return discoveryFailure('INVALID_REQUEST', 'A release lookup needs the tender’s ocid.')
      }
      return getDiscoveryClient().fetchRelease(ocid)
    },
  )

  ipcMain.handle(
    TENDERS_CHANNELS.discoveryDownloadDocument,
    async (_e, request: DiscoveryDownloadDocumentRequest) => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      return downloadDiscoveryDocument(request)
    },
  )

  // ── Deadline reminders ─────────────────────────────────────────────────────
  // The schedule itself runs in main (`startTendersReminders`); these three
  // channels are the settings surface and a manual check. `writeSettings` rejects
  // when it could not persist, so that rejection is turned into an honest
  // `ok: false` here rather than being allowed to surface as an opaque IPC error;
  // `readState`/`checkNow` are documented never to reject, and their guards exist
  // so that if one ever did the renderer would still get an answer.

  ipcMain.handle(TENDERS_CHANNELS.remindersGet, async (_e): Promise<RemindersStateResponse> => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const state = await getRemindersScheduler().readState()
      return {
        ok: true,
        settings: state.settings,
        ledger: state.ledger,
        limitation: REMINDERS_RUNTIME_LIMITATION,
      }
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          code: 'READ_FAILED',
          message:
            error instanceof Error ? error.message : 'The reminder settings could not be read.',
        },
      }
    }
  })

  ipcMain.handle(
    TENDERS_CHANNELS.remindersSet,
    async (_e, settings: RemindersSetRequest): Promise<RemindersSetResponse> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      const validated = validateReminderSettingsPatch(settings)
      if (!validated.ok) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: validated.error } }
      }
      try {
        const written = await getRemindersScheduler().writeSettings(validated.patch)
        return { ok: true, settings: written, limitation: REMINDERS_RUNTIME_LIMITATION }
      } catch (error: unknown) {
        // `writeSettings` rejects when it could not persist, so a caller is never
        // told a lead time was saved when the next check would not honour it.
        return {
          ok: false,
          error: {
            code: 'WRITE_FAILED',
            message: `The reminder settings could not be saved: ${
              error instanceof Error ? error.message : 'the write failed'
            }`,
          },
        }
      }
    },
  )

  ipcMain.handle(TENDERS_CHANNELS.remindersCheck, async (_e): Promise<RemindersCheckResponse> => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const result = await getRemindersScheduler().checkNow()
      // The ledger stays in main: it is the memory that makes each reminder
      // once-only, not something a renderer should be able to write back.
      return { ok: true, fired: result.fired, reminders: result.reminders }
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          code: 'CHECK_FAILED',
          message:
            error instanceof Error ? error.message : 'The reminder check could not be completed.',
        },
      }
    }
  })

  // ── Diagnostics ────────────────────────────────────────────────────────────
  // The renderer reports a failure main cannot see (a refusal it detected, an
  // extraction that came back empty) and reads back where the log lives. Main
  // owns the bounds and the sink; the renderer can append entries but can never
  // read the log back, so the diagnostics surface is write-only from the UI.
  ipcMain.handle(
    TENDERS_CHANNELS.diagnosticsRecord,
    (_e, request: unknown): RecordDiagnosticsResponse => {
      if (!isTrustedTendersEvent(_e)) {
        return { ok: false, error: 'Sender is not a registered Tenders WebContents.' }
      }
      if (!isRecord(request)) return { ok: false, error: 'A diagnostics entry is required.' }
      const { level, source, message } = request
      if (level !== 'info' && level !== 'warn' && level !== 'error') {
        return { ok: false, error: 'A diagnostics level must be info, warn or error.' }
      }
      if (
        typeof source !== 'string' ||
        source.trim().length === 0 ||
        source.length > MAX_TENDERS_DIAGNOSTIC_SOURCE_CHARS
      ) {
        return {
          ok: false,
          error: `A diagnostics source is required and may be at most ${MAX_TENDERS_DIAGNOSTIC_SOURCE_CHARS} characters.`,
        }
      }
      if (
        typeof message !== 'string' ||
        message.trim().length === 0 ||
        message.length > MAX_TENDERS_DIAGNOSTIC_MESSAGE_CHARS
      ) {
        return {
          ok: false,
          error: `A diagnostics message is required and may be at most ${MAX_TENDERS_DIAGNOSTIC_MESSAGE_CHARS} characters.`,
        }
      }
      if (request.detail !== undefined && !isRecord(request.detail)) {
        return { ok: false, error: 'Diagnostics detail must be an object when supplied.' }
      }
      const detail = isRecord(request.detail) ? request.detail : null
      if (detail && Object.keys(detail).length > MAX_TENDERS_DIAGNOSTIC_DETAIL_KEYS) {
        return {
          ok: false,
          error: `Diagnostics detail may carry at most ${MAX_TENDERS_DIAGNOSTIC_DETAIL_KEYS} keys.`,
        }
      }
      try {
        getTendersDiagnosticsLog().record({
          level,
          source,
          message,
          ...(detail ? { detail } : {}),
        })
      } catch {
        // The sink never throws by contract; a renderer must not see an exception
        // for a diagnostic that could not be written.
      }
      return { ok: true }
    },
  )

  ipcMain.handle(TENDERS_CHANNELS.diagnosticsPath, (_e): DiagnosticsPathResponse => {
    if (!isTrustedTendersEvent(_e)) {
      return { ok: false, error: 'Sender is not a registered Tenders WebContents.' }
    }
    try {
      return { ok: true, path: tendersDiagnosticsPath() }
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error, 'The diagnostics log path is unavailable.') }
    }
  })

  // Cross-App: Export Compliance Matrix to Sheets
  ipcMain.handle(
    TENDERS_CHANNELS.exportMatrixToSheets,
    (_e, _tenderId: string, tenderTitle: string, matrixRows: any[]) => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      try {
        // Bounded before any CSV work: the export writes a temp file, so an
        // unbounded row/cell count would let a caller allocate an arbitrarily
        // large file from a single IPC message.
        if (_tenderId !== undefined && (typeof _tenderId !== 'string' || _tenderId.length > 200)) {
          return { ok: false, error: 'A valid tender id is required.' }
        }
        if (
          tenderTitle !== undefined &&
          (typeof tenderTitle !== 'string' || tenderTitle.length > 500)
        ) {
          return { ok: false, error: 'A valid tender title is required.' }
        }
        if (matrixRows !== undefined && !Array.isArray(matrixRows)) {
          return { ok: false, error: 'matrixRows must be an array.' }
        }
        const matrixRowList = matrixRows ?? []
        if (matrixRowList.length > MAX_TENDERS_MATRIX_EXPORT_ROWS) {
          return {
            ok: false,
            error: `Compliance matrix export is limited to ${MAX_TENDERS_MATRIX_EXPORT_ROWS} rows.`,
          }
        }
        for (const row of matrixRowList) {
          const cells: unknown[] = isRecord(row) ? Object.values(row) : [row]
          for (const value of cells) {
            if (typeof value === 'string' && value.length > MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS) {
              return {
                ok: false,
                error: `A compliance matrix cell exceeds ${MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS} characters.`,
              }
            }
          }
        }
        try {
          const payloadBytes = Buffer.byteLength(
            JSON.stringify({ tenderTitle: tenderTitle ?? '', matrixRows: matrixRowList }),
            'utf8',
          )
          if (payloadBytes > MAX_TENDERS_MATRIX_EXPORT_BYTES) {
            return {
              ok: false,
              error: `Compliance matrix export exceeds ${MAX_TENDERS_MATRIX_EXPORT_BYTES} bytes.`,
            }
          }
        } catch {
          return { ok: false, error: 'The compliance matrix payload cannot be serialized.' }
        }

        const BOM = '\uFEFF'
        const header =
          'Requirement ID,Category,Requirement Text,Mandatory / Disqualifier,Fulfillment Status,Linked Document,Health Status,Notes\n'
        // RFC 4180 quoting plus spreadsheet formula neutralisation: any cell
        // that begins with = + - @ TAB or CR is prefixed with an apostrophe so
        // a spreadsheet app cannot evaluate it as a formula. The BOM and
        // comma-delimited quoting are unchanged.
        const neutralizeFormula = (value: string): string =>
          /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
        const escapeCsv = (str: unknown): string => {
          if (str === null || str === undefined) return '""'
          const s = neutralizeFormula(String(str)).replace(/"/g, '""')
          return `"${s}"`
        }

        const rows = (matrixRows || [])
          .map((r, idx) => {
            const reqId = escapeCsv(r.id || `REQ-${idx + 1}`)
            const cat = escapeCsv((r.category || 'GENERAL').replace(/_/g, ' '))
            const reqText = escapeCsv(r.title || r.verbatimClause || r.requirementText || '')
            const isMand =
              r.isMandatory !== undefined
                ? Boolean(r.isMandatory)
                : r.mandatory !== undefined
                  ? Boolean(r.mandatory)
                  : r.riskLevel === 'HIGH' || r.riskLevel === 'CRITICAL'
            const mandText = escapeCsv(isMand ? 'Mandatory / Disqualifier' : 'Standard Returnable')
            const status = escapeCsv(r.status || 'UNDER_REVIEW')
            const linkedDoc = escapeCsv(r.linkedVaultDocId || r.linkedDocument || 'None')
            const health = escapeCsv(
              r.healthStatus || (r.linkedVaultDocId ? 'VALID' : 'NO_ATTACHMENT'),
            )
            const notes = escapeCsv(r.notes || r.reason || '')
            return [reqId, cat, reqText, mandText, status, linkedDoc, health, notes].join(',')
          })
          .join('\n')

        const csvContent = BOM + header + rows
        const sanitizedTitle = (tenderTitle || 'Tender').replace(/[^a-zA-Z0-9_-]/g, '_')
        const targetPath = join(
          tmpdir(),
          `${sanitizedTitle}_Compliance_Matrix_${getUniqueTimestamp()}.csv`,
        )
        writeFileSync(targetPath, csvContent, 'utf8')

        if (runtime.openGeneratedPath) {
          runtime.openGeneratedPath(targetPath)
        }
        return { ok: true, path: targetPath }
      } catch (e: any) {
        return { ok: false, error: e?.message || 'Failed to export compliance matrix to Sheets' }
      }
    },
  )

  // Cross-App: Draft Proposal in Docs
  ipcMain.handle(TENDERS_CHANNELS.draftProposalDoc, async (_e, tender: unknown) => {
    if (!isTrustedTendersEvent(_e)) {
      return { ok: false, error: 'Unauthorized Tenders WebContents sender' }
    }
    if (!validProposalPayload(tender)) {
      return { ok: false, error: 'Invalid proposal payload' }
    }
    try {
      // Main owns the canonical readiness snapshot: it resolves the requested
      // tender from the authoritative document (never from renderer-supplied
      // data), assesses company/vault readiness itself, and binds the report to
      // the exact tender id + revision + fingerprint. The generator verifies the
      // binding before it may emit ready language, so a stale or mismatched
      // report cannot clear a proposal.
      const requestedId =
        isRecord(tender) && typeof (tender as { id?: unknown }).id === 'string'
          ? (tender as { id: string }).id
          : ''
      let readinessReport: ReadinessReport | undefined
      let expectedBinding: (Partial<ReadinessBinding> & { required?: boolean }) | undefined
      if (requestedId) {
        const loaded = await getAuthoritativeTendersStore().load()
        if (loaded.ok) {
          const canonical = buildCanonicalReadinessReport(loaded.data, requestedId)
          // Derive the expectation from the requested id + loaded revision, not
          // from the report's own binding (that comparison would be tautological).
          // On any drift the binding is undefined, so the report is also withheld
          // and the generator cannot emit ready language.
          const binding = expectedReadinessBinding({
            requestedTenderId: requestedId,
            loadedRevision: loaded.data.revision,
            canonicalTenderId: canonical.tender?.id ?? '',
            reportBinding: canonical.report?.binding,
          })
          if (canonical.ok && canonical.report && binding) {
            readinessReport = canonical.report
            expectedBinding = binding
          }
        }
      }
      const content = generateProposalMarkdown(tender, { readinessReport, expectedBinding })
      const targetPath = writeGeneratedProposal(content)
      if (runtime.openGeneratedPath) runtime.openGeneratedPath(targetPath)
      return { ok: true, path: targetPath }
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to draft proposal in Docs' }
    }
  })

  // Cross-App: Sync with CRM (typed port; Tenders never touches the CRM store)
  ipcMain.handle(TENDERS_CHANNELS.syncWithCrm, async (_e, dealData: any) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const integrations = getIntegrations()
      const upsertTenderOpportunity = integrations.upsertTenderOpportunity
      // Resolve the port BEFORE any side effect: with CRM disabled there is no
      // partial application at all.
      if (!upsertTenderOpportunity) {
        return { ok: false, error: 'CRM integration is not configured.' }
      }

      const authoritativeStore = getAuthoritativeTendersStore()
      const loaded = await authoritativeStore.load()
      if (!loaded.ok) return { ok: false, error: loaded.error.message }

      const payloadTender: TenderRecord | undefined =
        dealData && typeof dealData.tender === 'object'
          ? (dealData.tender as TenderRecord)
          : undefined
      const tenderId =
        (typeof dealData?.tenderId === 'string' && dealData.tenderId) ||
        payloadTender?.id ||
        (typeof dealData?.id === 'string' && dealData.id.startsWith('deal-tender-')
          ? dealData.id.replace('deal-tender-', '')
          : '') ||
        ''

      const resolved = tenderId ? findTenderById(loaded.data, tenderId) : null
      // Main-side demo isolation: never write to CRM from a demonstration
      // workspace, even if the renderer guard were bypassed. Rejection happens
      // before any mutation, so there is no side effect.
      if (resolved?.workspace.dataOrigin === 'demo') {
        return { ok: false, error: TENDERS_DEMO_WRITE_ERROR }
      }
      // Identity and the back-link come from the canonical document; the deal
      // content prefers the renderer's explicit sync payload (its historical
      // contract), falling back to the canonical tender.
      const tender = payloadTender ?? resolved?.tender
      const effectiveTenderId = resolved?.tender.id ?? tenderId

      const deterministicDealId =
        (typeof dealData?.dealId === 'string' && dealData.dealId) ||
        (typeof dealData?.id === 'string' && dealData.id !== effectiveTenderId
          ? dealData.id
          : effectiveTenderId
            ? `deal-tender-${effectiveTenderId}`
            : `deal-tender-${Date.now()}`)

      const refNum =
        tender?.referenceNumber || dealData?.tenderReference || dealData?.referenceNumber || ''
      const rawTitle = tender?.title || dealData?.title || dealData?.name || 'Tender Opportunity'
      const title =
        refNum && rawTitle.startsWith(`${refNum} - `)
          ? rawTitle.replace(`${refNum} - `, '')
          : rawTitle
      const dealName = refNum ? `${refNum} - ${title}` : title
      const companyName =
        tender?.issuingBody || dealData?.companyName || 'Government / Enterprise Buyer'
      const rawAmount =
        typeof tender?.estimatedValue === 'number'
          ? tender.estimatedValue
          : typeof dealData?.amount === 'number' && Number.isFinite(dealData.amount)
            ? dealData.amount
            : 0
      const amount = Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : 0
      const stage = typeof dealData?.stage === 'string' ? dealData.stage : 'proposal'
      const expectedCloseDate =
        tender?.closingDate || dealData?.expectedCloseDate || dealData?.closingDate || undefined
      const notes =
        dealData?.notes ||
        (refNum
          ? `Tender Ref: ${refNum}\nIssuing Authority: ${companyName}`
          : `Issuing Authority: ${companyName}`)

      // Race fix (contracts §6 item 2): resolve the tender revision and commit the
      // back-link FIRST. A revision conflict therefore aborts before the CRM
      // write, so a conflict can never leave a deal that the tender does not
      // reference. The CRM upsert is idempotent (deterministic id), so a retry
      // after a later CRM failure reconciles to exactly one deal.
      if (resolved) {
        const expectedRevision =
          typeof dealData?.expectedRevision === 'number'
            ? dealData.expectedRevision
            : loaded.data.revision
        const committed = await authoritativeStore.mutate(expectedRevision, (document) => {
          const target = findTenderById(document, resolved.tender.id)
          if (target) target.tender.linkedCrmDealId = deterministicDealId
          return document
        })
        if (!committed.ok) {
          return {
            ok: false,
            error: committed.error.message,
            currentRevision: committed.current?.revision ?? committed.error.current?.revision,
          }
        }
      }

      let dealId = deterministicDealId
      try {
        const upserted = await upsertTenderOpportunity({
          dealId: deterministicDealId,
          tenderId: effectiveTenderId,
          tenderReference: refNum || null,
          name: dealName,
          companyName,
          amount,
          stage,
          expectedCloseDate,
          notes,
        })
        if (!upserted.ok) return { ok: false, error: upserted.error || 'CRM upsert failed.' }
        dealId = upserted.dealId || dealId
      } catch (crmError: unknown) {
        // The tender link already committed; the deterministic deal id makes a
        // retry safe and idempotent. Surface the error for the retry UI.
        return {
          ok: false,
          dealId: deterministicDealId,
          error: crmError instanceof Error ? crmError.message : String(crmError),
        }
      }

      return { ok: true, dealId }
    } catch (e: any) {
      return { ok: false, error: e?.message }
    }
  })

  // Cross-App: Record tender outcome on the CRM opportunity (typed port)
  ipcMain.handle(TENDERS_CHANNELS.updateTenderOutcome, async (_e, request: any) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const tenderId = typeof request?.tenderId === 'string' ? request.tenderId : ''
      const outcome = request?.outcome
      if (!tenderId) return { ok: false, error: 'A tender id is required.' }
      if (
        outcome !== 'won' &&
        outcome !== 'lost' &&
        outcome !== 'withdrawn' &&
        outcome !== 'cancelled'
      ) {
        return { ok: false, error: `Unknown tender outcome: ${String(outcome)}` }
      }
      const updateTenderOutcome = getIntegrations().updateTenderOutcome
      if (!updateTenderOutcome) {
        return { ok: false, error: 'CRM integration is not configured.' }
      }
      const loaded = await getAuthoritativeTendersStore().load()
      if (!loaded.ok) return { ok: false, error: loaded.error.message }
      const resolved = findTenderById(loaded.data, tenderId)
      if (!resolved) return { ok: false, error: `Tender not found: ${tenderId}` }
      const dealId =
        (typeof request?.dealId === 'string' && request.dealId) ||
        resolved.tender.linkedCrmDealId ||
        `deal-tender-${tenderId}`
      const result = await updateTenderOutcome({
        dealId,
        tenderId,
        outcome,
        amount: typeof request?.amount === 'number' ? request.amount : undefined,
        reason: typeof request?.reason === 'string' ? request.reason : undefined,
        noticeDate: typeof request?.noticeDate === 'string' ? request.noticeDate : undefined,
      })
      return result
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to record tender outcome' }
    }
  })

  ipcMain.handle(TENDERS_CHANNELS.openInCrm, (_e, dealId) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    const integrations = getIntegrations()
    if (integrations.openAppAt || runtime.onOpenCrm) {
      openOwningApp({ app: 'crm', entityId: typeof dealId === 'string' ? dealId : undefined })
      return { ok: true }
    }
    return { ok: false }
  })

  // Cross-App: Open Books tab
  ipcMain.handle(TENDERS_CHANNELS.openBooks, (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    if (getIntegrations().openAppAt || runtime.onOpenBooks) {
      openOwningApp({ app: 'books' })
      return true
    }
    return false
  })

  // Cross-App: Bill Milestone in Zano Books
  ipcMain.handle(
    TENDERS_CHANNELS.billMilestoneInBooks,
    async (
      _e,
      tenderIdOrPayload: string | BillMilestoneRequest,
      milestoneIdArg?: string,
    ): Promise<BillMilestoneResult | { ok: false; error: TendersPersistenceError }> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      try {
        let tenderId: string
        let milestoneId: string
        let tenderReference: string | undefined
        let customAmount: number | undefined
        let customNotes: string | undefined
        let expectedRevision: number | undefined

        if (typeof tenderIdOrPayload === 'object' && tenderIdOrPayload !== null) {
          tenderId = tenderIdOrPayload.tenderId
          milestoneId = tenderIdOrPayload.milestoneId
          tenderReference = tenderIdOrPayload.tenderReference
          customAmount = tenderIdOrPayload.amount
          customNotes = tenderIdOrPayload.notes
          expectedRevision = tenderIdOrPayload.expectedRevision
        } else {
          tenderId = String(tenderIdOrPayload || '')
          milestoneId = String(milestoneIdArg || '')
        }

        const issueMilestoneInvoice = getIntegrations().issueMilestoneInvoice
        if (!issueMilestoneInvoice) {
          return { ok: false, error: 'Books integration is not configured.' }
        }

        const authoritativeStore = getAuthoritativeTendersStore()
        const loadedTenders = await authoritativeStore.load()
        if (!loadedTenders.ok) return { ok: false, error: loadedTenders.error.message }
        const tendersData = loadedTenders.data

        const located =
          (tenderId ? findTenderById(tendersData, tenderId) : null) ??
          (() => {
            if (!tenderReference) return null
            for (const workspace of tendersData.workspaces) {
              const tender = workspace.tenders.find(
                (candidate) => candidate.referenceNumber === tenderReference,
              )
              if (tender) return { workspace, tender }
            }
            return null
          })()

        if (!located) {
          return {
            ok: false,
            error: `Tender not found: ${tenderId || tenderReference || 'unknown'}`,
          }
        }

        const foundTender = located.tender
        // Main-side demo isolation: a demonstration workspace may never raise an
        // invoice. Rejected before any reservation/side effect.
        if (located.workspace.dataOrigin === 'demo') {
          return { ok: false, error: TENDERS_DEMO_WRITE_ERROR }
        }
        const foundMilestone: ContractMilestone | undefined = foundTender.milestones?.find(
          (candidate) => candidate.id === milestoneId,
        )
        if (!foundMilestone) {
          return { ok: false, error: `Milestone not found: ${milestoneId}` }
        }

        const billingIdempotencyKey = `tender-milestone-${foundTender.id}-${foundMilestone.id}`

        // Already billed (e.g. a retry after a lost response): idempotent
        // success. Never post a second invoice. This reconciliation path is
        // exempt from the won gate below so a retry cannot double-post.
        if (foundMilestone.status === 'BILLED' || foundMilestone.billedInvoiceId) {
          return {
            ok: true,
            reconciled: true,
            invoiceId: foundMilestone.billedInvoiceId,
            invoiceNumber: foundMilestone.billedInvoiceNumber,
          }
        }

        // Won-only gating (mirrors shared/lifecycle `milestonesAllowed`): a
        // tender that is not won must not expose or raise milestone billing.
        if (foundMilestone.status !== 'REACHED') {
          return {
            ok: false,
            error: `Milestone is not reached. Current status: ${foundMilestone.status} (Milestone is not in REACHED status)`,
          }
        }

        if (!milestonesAllowed(foundTender.status)) {
          return { ok: false, error: tendersNotWonBillingError(foundTender.status) }
        }

        // The invoice amount is derived from the canonical milestone only, so a
        // caller cannot raise an invoice for an arbitrary amount on a won
        // tender. A supplied `amount` is a compatibility echo and must match the
        // milestone exactly; a mismatch is rejected rather than billed.
        const canonicalAmount = Number(foundMilestone.amount ?? 0)
        if (customAmount !== undefined) {
          const requestedAmount = Number(customAmount)
          if (!Number.isFinite(requestedAmount) || requestedAmount !== canonicalAmount) {
            return {
              ok: false,
              error: `The requested billing amount (${String(customAmount)}) does not match the milestone amount (${canonicalAmount}); the milestone amount is authoritative.`,
            }
          }
        }
        const billAmount = canonicalAmount
        if (billAmount <= 0) {
          return {
            ok: false,
            error: `Milestone billing amount must be greater than 0: ${billAmount}`,
          }
        }

        // Pre-post revision validation: `mutate` with an unchanged document is a
        // revision check, not a write (the store returns ok without committing),
        // so this is NOT a reservation. It does guarantee that a stale caller
        // posts zero invoices; a competing writer that moves the revision between
        // this check and the link commit is reconciled below, and the Books
        // idempotency key keeps it to at most one invoice.
        const reservationRevision = expectedRevision ?? tendersData.revision
        const reservation = await authoritativeStore.mutate(
          reservationRevision,
          (document) => document,
        )
        if (!reservation.ok) {
          return {
            ok: false,
            error: reservation.error.message,
            currentRevision: reservation.current?.revision ?? reservation.error.current?.revision,
          }
        }

        // Invoice identity comes from the canonical tender/milestone, never from
        // the caller: the party, the reference and the line description must not
        // be settable from a renderer payload.
        const issuer = foundTender.issuingBody || 'Issuing authority not recorded'
        const today = new Date().toISOString().split('T')[0]
        const dueDate =
          foundMilestone.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
        const ref = foundTender.referenceNumber || foundTender.id
        const mName = foundMilestone.name || foundMilestone.title || 'Delivery Milestone'
        const itemDescription = `${mName} per ${ref}`

        // Single posting path via the typed port; Books owns party resolution,
        // VAT-inclusive pricing, numbering, journal posting and persistence.
        // `billingIdempotencyKey` makes the post retry-safe.
        const invoice = await issueMilestoneInvoice({
          tenderId: foundTender.id,
          milestoneId: foundMilestone.id,
          idempotencyKey: billingIdempotencyKey,
          partyName: issuer,
          itemDescription,
          itemCode: 'TENDER-PROGRESS',
          accountId: 'acc-sales',
          accountName: 'Tender & Commercial Contracting Sales',
          amount: billAmount,
          tenderReference: ref,
          notes: customNotes || 'Payment terms: 30 days net from tax invoice submission.',
          date: today,
          dueDate,
        })

        if (!invoice.ok || !invoice.invoiceId) {
          return { ok: false, error: invoice.error || 'Failed to bill milestone in Books' }
        }

        const invoiceId = invoice.invoiceId
        const invoiceNumber = invoice.invoiceNumber

        const applyBilling = (document: TendersDataV2, at: string): void => {
          const target = findTenderById(document, foundTender.id)
          const milestone = target?.tender.milestones?.find(
            (candidate) => candidate.id === foundMilestone.id,
          )
          if (!milestone) return
          milestone.status = 'BILLED'
          milestone.billedInvoiceId = invoiceId
          milestone.billedInvoiceNumber = invoiceNumber
          milestone.billedAt = at
          milestone.billedDate = at
        }

        const nowIso = new Date().toISOString()
        let committed = await authoritativeStore.mutate(reservationRevision, (document) => {
          applyBilling(document, nowIso)
          return document
        })
        let reconciled = false
        let warning: string | undefined

        if (!committed.ok) {
          // Reconcile: a competing writer may already have billed this
          // milestone, or the revision moved. Reload once and either adopt the
          // existing billing or retry the link exactly once with the fresh
          // revision. The invoice already exists (and is deduped by key), so a
          // retry can never double-post.
          let latest = committed.current
          if (!latest) {
            const reloaded = await authoritativeStore.load()
            if (reloaded.ok) latest = reloaded.data
          }
          const latestData = latest ?? tendersData
          const latestTarget = findTenderById(latestData, foundTender.id)
          const latestMilestone = latestTarget?.tender.milestones?.find(
            (candidate) => candidate.id === foundMilestone.id,
          )
          if (latestMilestone?.status === 'BILLED' || latestMilestone?.billedInvoiceId) {
            reconciled = true
            warning = 'Milestone was already billed; reused the existing invoice.'
          } else {
            const retry = await authoritativeStore.mutate(latestData.revision, (document) => {
              applyBilling(document, nowIso)
              return document
            })
            if (retry.ok) {
              committed = retry
            } else {
              // The invoice exists (deduped by key), but this call could not
              // commit the tender link. Report failure so the UI surfaces the
              // retry; the retry reconciles without double-posting.
              return {
                ok: false,
                error:
                  'Invoice posted; the milestone link could not be committed. Retry to reconcile the tender.',
                invoiceId,
                invoiceNumber,
                tenderReference: ref,
                currentRevision: retry.current?.revision ?? latestData.revision,
              }
            }
          }
        }

        // Open the owning app at the returned invoice.
        openOwningApp({ app: 'books', entityId: invoiceId })

        return {
          ok: true,
          invoiceNumber,
          invoiceId,
          tenderReference: ref,
          grandTotal: invoice.grandTotal,
          subtotal: invoice.subtotal,
          taxTotal: invoice.taxTotal,
          ...(reconciled ? { reconciled: true } : {}),
          ...(warning ? { warning } : {}),
        }
      } catch (err: any) {
        return {
          ok: false,
          error: err?.message || 'Failed to bill milestone in Books',
        }
      }
    },
  )
  ipcRegistered = true
}

/**
 * Is this navigation target safe for the privileged Tenders view? Only the
 * configured trusted renderer origin/file and in-session `blob:` object URLs are
 * allowed; the origin check fails closed when no trusted renderer is configured.
 */
function allowedTendersNavigation(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false
  if (isTrustedRendererBlobUrl(url)) return true
  return trustedRendererUrl(url)
}

/**
 * Is this a `blob:` object URL owned by the trusted renderer?
 *
 * `blob:` is NOT an origin of its own: a blob URL inherits the origin of the
 * context that created it, and its serialization is
 * `blob:<creator-origin>/<uuid>`. That means `blob:https://attacker.example/x`
 * is a URL a foreign document can construct, and an unqualified
 * `url.startsWith('blob:')` would have allowed it to navigate the privileged
 * view. Only the renderer ever creates these in practice — the four call sites
 * are `URL.createObjectURL` in `renderer/src/calendar.ts`,
 * `renderer/src/components/TenderList.tsx`,
 * `renderer/src/components/Workspace.tsx` and `renderer/src/mock/vault.ts`, all
 * of which are the trusted view — so qualifying by that origin costs nothing and
 * closes the foreign-blob hole.
 *
 * The no-`//` prefix rule matches the HTML "blob URL" definition: the creator's
 * origin is serialized with a single leading slash, so anything of the form
 * `blob://host/...` is not a blob URL this renderer could have made.
 */
function isTrustedRendererBlobUrl(url: string): boolean {
  if (!url.startsWith('blob:')) return false
  if (!runtime.rendererUrl && !runtime.rendererFile) return false
  if (url.startsWith('blob://')) return false
  try {
    const creator = new URL(url.slice('blob:'.length))
    if (creator.origin === 'null' || creator.origin === '') return false
    return trustedRendererUrl(creator.href)
  } catch {
    return false
  }
}

/**
 * Deny-by-default navigation for the Tenders view (contracts §6 item 9). Values
 * like `VaultDoc.fileUrl` / `TenderRecord.fileUrl` are store data, so without
 * this a `window.open(doc.fileUrl, '_blank')` would follow an `http(s):` URL read
 * from the store, and any link or injected script could navigate the privileged
 * view away from the trusted renderer.
 */
export function applyTendersNavigationPolicy(wc: WebContents): void {
  if (!wc) return
  if (typeof wc.setWindowOpenHandler === 'function') {
    wc.setWindowOpenHandler(({ url }) => ({
      action: allowedTendersNavigation(url) ? 'allow' : 'deny',
    }))
  }
  if (typeof wc.on === 'function') {
    wc.on('will-navigate', (event, url) => {
      if (!allowedTendersNavigation(url)) event.preventDefault()
    })
  }
}

export function createTendersView(): WebContentsView {
  registerTendersIpc()

  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  registerTendersWebContents(view.webContents)
  applyTendersNavigationPolicy(view.webContents)

  if (runtime.rendererUrl) {
    void view.webContents.loadURL(runtime.rendererUrl)
  } else if (runtime.rendererFile && existsSync(runtime.rendererFile)) {
    void view.webContents.loadFile(runtime.rendererFile)
  }

  return view
}

// ── shell dirty-close guard ──────────────────────────────────────────────────
// Tenders autosaves behind a 300 ms debounce and holds the only copy of an edit
// until that save commits, so a window close inside the debounce window used to
// drop the edit silently. The shell therefore asks the view to flush before it
// closes (see the `win.on('close')` guard in apps/shell/src/main/index.ts).

/** In-flight close-guard flushes, keyed by the WebContents being guarded. */
const pendingCloseFlushes = new Map<number, Promise<TendersCloseFlushResult | null>>()
/** Resolvers for flush requests main has sent and not yet heard back about,
 *  keyed by the request id the requesting view was given. */
const closeFlushWaiters = new Map<
  number,
  { webContentsId: number; settle: (result: TendersCloseFlushResult | null) => void }
>()
let closeFlushRequestSeq = 0

/**
 * How long the close guard waits for the renderer's flush reply. A renderer that
 * does not answer cannot prove the edit is durable, so the guard prompts instead
 * of closing silently (same fail-closed shape as the docs close check).
 */
const CLOSE_FLUSH_TIMEOUT_MS = 10_000

/**
 * Ask the Tenders renderer to commit its debounced edit and report the outcome.
 * Resolves `null` when no reply arrives in time (a wedged or unloaded renderer).
 */
function requestCloseFlush(contents: WebContents): Promise<TendersCloseFlushResult | null> {
  const pending = pendingCloseFlushes.get(contents.id)
  if (pending) return pending
  const request = new Promise<TendersCloseFlushResult | null>((resolve) => {
    const requestId = (closeFlushRequestSeq += 1)
    const timer = setTimeout(() => {
      closeFlushWaiters.delete(requestId)
      resolve(null)
    }, CLOSE_FLUSH_TIMEOUT_MS)
    closeFlushWaiters.set(requestId, {
      webContentsId: contents.id,
      settle: (result) => {
        clearTimeout(timer)
        resolve(result)
      },
    })
    try {
      contents.send(TENDERS_CHANNELS.closeFlushRequest, requestId)
    } catch {
      // A send failure is a renderer that cannot answer — the same as a timeout.
      closeFlushWaiters.delete(requestId)
      clearTimeout(timer)
      resolve(null)
    }
  }).finally(() => {
    pendingCloseFlushes.delete(contents.id)
  })
  pendingCloseFlushes.set(contents.id, request)
  return request
}

/**
 * Last resort before uncommitted work is discarded: ask, never assume. A dialog
 * that cannot be shown fails closed (the window stays open).
 */
async function confirmDiscardingTendersChanges(
  parent: BrowserWindow | null | undefined,
  detail: string,
): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    message: 'Close Zanostack with unsaved Tenders changes?',
    detail,
    buttons: ['Close anyway', 'Keep Zanostack open'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  try {
    const { response } =
      parent && typeof parent.isDestroyed === 'function' && !parent.isDestroyed()
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options)
    return response === 0
  } catch {
    return false
  }
}

/**
 * Close guard for the Tenders view: `true` means the caller may close.
 * A clean renderer (nothing uncommitted) passes straight through; otherwise the
 * pending edit is committed first, and a flush that could not commit prompts
 * instead of dropping the edit.
 */
export async function requestTendersClose(
  contents: WebContents,
  parent?: BrowserWindow | null,
): Promise<boolean> {
  if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) {
    return true
  }
  // A view that has not finished loading holds no renderer state at all (the
  // store hydrates from disk after load), so there is nothing to flush and no
  // reply to wait for.
  if (typeof contents.isLoading === 'function' && contents.isLoading()) return true
  const outcome = await requestCloseFlush(contents)
  if (outcome === null) {
    return confirmDiscardingTendersChanges(
      parent,
      'Tenders did not respond to the close check, so its latest changes may not be saved.',
    )
  }
  if (outcome.ok || !outcome.dirty) return true
  return confirmDiscardingTendersChanges(
    parent,
    outcome.error
      ? `Your latest Tenders changes could not be saved: ${outcome.error}`
      : 'Your latest Tenders changes could not be saved.',
  )
}
