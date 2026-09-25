// The legacy v1 `tenders-data.json` stack — read, validate and (test-only) write.
//
// Split out of `main/tenders-main.ts` with no behaviour change. This is the
// module the notes below describe: a SECOND persistence architecture that used
// to run alongside the authoritative v2 store, now retired from every shipping
// path but still reachable on demand.
//
//  * **No synthesis.** The reader answers an empty or non-object payload by
//    reading what the file actually contains, never with `createDefaultSeedWorkspaces()`
//    — demo company, customers, vault and the seeded RFP — which is exactly the
//    behaviour the v2 path promises never to do. Nothing here can invent a
//    customer, a compliance document or a tender.
//  * **No live watcher.** The `fs.watch` over `tenders-data.json` used to live
//    beside this reader and broadcast on `tenders:data-changed`, a channel with
//    no subscribers. It is no longer started in production (see
//    `main/legacy-store-watcher.ts`).
//
// What stays: `readTendersStore` still answers with the on-disk document, because
// `e2e/tenders-regression-smoke.spec.ts` proves the channel is reachable and
// `tests/adversarial-stress.test.ts` reads a genuine v1 file back through it.
//
// This is the LAST writer removed from the legacy stack: `writeTendersStore` is
// no longer reachable from any IPC handler, and the sole shipping writer of
// `tenders-data.json` is the authoritative v2 store.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CompanyWorkspace,
  RequirementRecord,
  TenderRecord,
  TendersData,
} from '../shared/types'
import { MAX_TENDERS_STORE_FILE_BYTES } from '../shared/tenders-persistence'
import { isRecord } from './readiness-snapshot'
import { errorMessage } from './main-utils'
import { renameWithBoundedRetry } from './tenders-paths'

/** The current v1 envelope version this reader normalizes to. */
export const CURRENT_TENDERS_SCHEMA_VERSION = 1

/**
 * The broadcast the legacy writer makes after a successful commit.
 *
 * Injected rather than imported, so this module does not depend on the v2
 * store's broadcast machinery: `tenders-main.ts` wires the real
 * `broadcastTendersData` in at composition time. The default is a no-op, which
 * is correct for the only shipping caller — `writeTendersStore` is unreachable
 * from every IPC handler, so nothing in production ever reaches this line.
 */
let legacyBroadcast: (data: TendersData) => void = () => {}

/** Install the broadcast the legacy writer calls after a committed write. */
export function setLegacyTendersBroadcast(broadcast: (data: TendersData) => void): void {
  legacyBroadcast = broadcast
}

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
    legacyBroadcast(validated)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    console.error('tenders-main: failed to atomically write tenders store', filePath, e)
    throw e
  }
}
