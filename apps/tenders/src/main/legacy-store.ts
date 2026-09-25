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
//
//  * **It refuses a document it cannot faithfully represent.** A v2 payload
//    (`schemaVersion`/`revision`) or an unknown `version` marker is thrown back
//    at the caller before a directory, a temp file or a primary is touched. The
//    v1 writer has no representation for either, and `migrateAndValidateTenders`
//    reads a v2 document as a v1 one — so writing it would replace an
//    authoritative v2 file with `version: 1` and destroy the revision the v2
//    store conflicts against (see `legacyWriteRefusal`).
//  * **It refuses a requirement it cannot read at all**, loudly, rather than
//    dropping the row; a field it merely does not know is kept with a note naming
//    it (see `parseLegacyRequirement`).
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CompanyWorkspace,
  RequirementRecord,
  TenderRecord,
  TendersData,
} from '../shared/types'
import {
  MAX_TENDERS_STORE_FILE_BYTES,
  TENDERS_PERSISTENCE_FILE_NAME,
} from '../shared/tenders-persistence'
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

/** The v1 marker every payload this writer understands must carry, if it carries one. */
const KNOWN_V1_VERSIONS = new Set<number>([0, 1])
/** The `RequirementRecord.category` values this reader can vouch for. */
const REQUIREMENT_CATEGORIES = new Set([
  'MANDATORY_STAGE_1',
  'FUNCTIONALITY_STAGE_2',
  'FINANCIAL_STAGE_3',
  'GENERAL_RETURNABLE',
])

/** The `RequirementRecord.riskLevel` values this reader can vouch for. */
const RISK_LEVELS = new Set(['CRITICAL_DISQUALIFIER', 'POINT_SCORED', 'INFORMATIONAL'])


/** The store file's name, shared with the v2 store so the two cannot disagree. */
const LEGACY_STORE_FILE_NAME = TENDERS_PERSISTENCE_FILE_NAME

/**
 * Why `writeTendersStore` may not write this payload, or `null` when it may.
 *
 * The v1 writer is the LAST writer left in the legacy stack and the sole file it
 * understands is the `version: 1` envelope. It has no representation for the v2
 * document's `schemaVersion` or `revision`, and `migrateAndValidateTenders` reads
 * a v2 payload as a v1 one: `workspaces` still parses, `updatedAt` still parses,
 * and everything else — the schema version, the revision the authoritative store
 * conflicts against — is silently dropped on the way through.
 *
 * The consequence is not a cosmetic one. A caller that hands a v2 document to
 * this function replaces an authoritative v2 file with `version: 1` and loses the
 * revision metadata with it, so the next `loadStoreV2` reads a v1 envelope out of
 * the v2 store's own file. This is the data-loss path, so an unrepresentable
 * payload is REFUSED here rather than adapted: the caller is told, and the file
 * it was about to overwrite is left exactly as it was.
 */
function legacyWriteRefusal(data: unknown): string | null {
  if (!isRecord(data)) return null
  if ('schemaVersion' in data) {
    return `The Tenders writer cannot write a document that declares schemaVersion ${JSON.stringify(
      data.schemaVersion,
    )}: it writes only the version ${CURRENT_TENDERS_SCHEMA_VERSION} envelope, and writing this would replace an authoritative document with a v1 one.`
  }
  const version = data.version
  if (version !== undefined) {
    // A NUMBER, not a label: this is the v1 envelope's own marker, so a value
    // this writer does not know is a payload it cannot faithfully represent.
    // Reading tolerates an unknown version; writing one back would mint a marker
    // nobody has defined.
    if (
      typeof version !== 'number' ||
      !Number.isFinite(version) ||
      !KNOWN_V1_VERSIONS.has(version)
    ) {
      return `The Tenders writer cannot write a document whose version is ${JSON.stringify(
        version,
      )}; it writes only the version ${CURRENT_TENDERS_SCHEMA_VERSION} envelope.`
    }
  }
  return null
}

/**
 * One v1 requirement, field by field, or `null` when it cannot be read honestly.
 *
 * A key this reader does not know is no longer a reason to lose the requirement.
 * Dropping the record took the whole tender with it (the caller refuses a tender
 * whose requirements did not all parse), and a mandatory returnable that vanishes
 * from a tender with nothing recorded is precisely the failure this product exists
 * to prevent. So the field is refused — no value is invented for it, and it is not
 * carried into the document — while the requirement is kept and the unrecognised
 * key is named in `notes`, the field this app already shows the user for exactly
 * this kind of honest provenance.
 *
 * The line that stays where it was: a record with no `id`, no `title`, a
 * non-list `suggestedVaultDocIds`, or a present `category`/`riskLevel` that is
 * not one of the values this reader understands has nothing to keep and
 * nothing this reader may invent, so it is still `null` — and the caller still
 * refuses the tender loudly rather than dropping the row. A mis-typed enum
 * value must not ship raw and silently fall out of every known group in the
 * renderer; an ABSENT enum value is still defaulted below, exactly as before.
 */
function parseLegacyRequirement(raw: unknown): RequirementRecord | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !raw.id || typeof raw.title !== 'string') return null
  if (!Array.isArray(raw.suggestedVaultDocIds)) return null
  // Enum values are validated, not cast: a mis-typed `category`/`riskLevel`
  // used to pass through with a `??` default and a cast, then silently fall out
  // of every known group in the renderer. Absent is still defaulted below;
  // present-but-unknown is refused like any other shape this reader cannot
  // vouch for, and the caller refuses the whole tender loudly.
  const category = raw.category
  const riskLevel = raw.riskLevel
  if (
    (category !== undefined &&
      (typeof category !== 'string' || !REQUIREMENT_CATEGORIES.has(category))) ||
    (riskLevel !== undefined &&
      (typeof riskLevel !== 'string' || !RISK_LEVELS.has(riskLevel)))
  ) {
    return null
  }
  const unknownKeys = Object.keys(raw).filter((key) => !LEGACY_REQUIREMENT_KEYS.has(key))
  const box = isRecord(raw.boundingBox) ? raw.boundingBox : null
  const knownNotes = typeof raw.notes === 'string' ? raw.notes : null
  // Known fields ONLY. The record is built from the fields this reader
  // understands rather than spread from the raw object, so a key it does not
  // know is named in `notes` and otherwise left behind: carrying it through would
  // hand the renderer a value nothing here has validated.
  const known: Record<string, unknown> = {}
  for (const key of Object.keys(raw)) {
    if (LEGACY_REQUIREMENT_KEYS.has(key)) known[key] = raw[key]
  }
  return {
    ...(known as unknown as RequirementRecord),
    id: raw.id,
    title: raw.title,
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
    notes:
      unknownKeys.length === 0
        ? (knownNotes ?? undefined)
        : [knownNotes, unreadableRequirementNote(unknownKeys)]
            .filter((part): part is string => Boolean(part))
            .join(' '),
    suggestedVaultDocIds: raw.suggestedVaultDocIds.filter(
      (id): id is string => typeof id === 'string',
    ),
  }
}

/**
 * The sentence appended to `notes` when a requirement carries a field this reader
 * does not understand. It names the fields rather than being a generic warning:
 * "something was not understood" is not something a bidder can act on.
 */
function unreadableRequirementNote(unknownKeys: string[]): string {
  return `This requirement was saved by a newer version of the app. Its field${unknownKeys.length === 1 ? '' : 's'} ${unknownKeys.join(', ')} ${unknownKeys.length === 1 ? 'is' : 'are'} not understood here and ${unknownKeys.length === 1 ? 'was' : 'were'} not read. Everything else on this requirement is shown as saved.`
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
        if (requirements.length !== rawRequirements.length) {
          // REFUSED LOUDLY, and the whole tender with it. This used to `continue`,
          // which dropped the tender — its reference number, its closing date and
          // every requirement on it — from a document the reader then returned as
          // a success. A bidder whose tender silently disappeared from the app is
          // the failure this product exists to prevent, and there is nothing
          // honest to keep: a requirement with no id, no title or a non-list
          // `suggestedVaultDocIds` cannot be repaired without inventing one.
          //
          // A requirement carrying an unrecognised FIELD is a different case, and
          // it is kept with a note naming the field (see `parseLegacyRequirement`).
          const unreadable = rawRequirements.filter(
            (item) => parseLegacyRequirement(item) === null,
          ).length
          throw new LegacyTendersReadError(
            `Tender ${String(tender.id)} could not be read: ${unreadable} of its ${rawRequirements.length} requirements are not in a shape this version understands, so the tender was not loaded rather than loaded without them. Nothing was changed on disk.`,
          )
        }
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

/**
 * The file an argument names: the store file itself when it already ends in
 * `tenders-data.json`, otherwise `tenders-data.json` INSIDE the directory given.
 *
 * The reader and the writer used to spell this rule out twice with the same
 * question — "does the path end in the store file name?" — answered with a
 * suffix test. A caller's path that merely ENDS in those characters is not the
 * store file, and the writer's copy of the rule then did the wrong thing twice
 * over: it aimed the write one level too deep, and because the "directory" it
 * computed was the file it had been asked to write, it turned that file into a
 * DIRECTORY and wrote `tenders-data.json` inside it.
 *
 * One question, asked once: does the LAST path segment name the store file?
 */
function storeFilePath(baseDirOrPath: string): string {
  const lastSegment = baseDirOrPath.split(/[/\\]/).pop() ?? ''
  return lastSegment.toLowerCase() === LEGACY_STORE_FILE_NAME
    ? baseDirOrPath
    : join(baseDirOrPath, LEGACY_STORE_FILE_NAME)
}

export function readTendersStore(baseDirOrPath: string): TendersData {
  const filePath = storeFilePath(baseDirOrPath)
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
  // REFUSED BEFORE ANYTHING IS CREATED. A payload this writer cannot faithfully
  // represent must not reach `migrateAndValidateTenders` (which reads a v2
  // document as a v1 one) and must not cause a directory or a temp file to be
  // made: a refused write leaves the file it was aimed at exactly as it was.
  const refusal = legacyWriteRefusal(data)
  if (refusal) throw new Error(refusal)

  const filePath = storeFilePath(baseDirOrPath)
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
    // The bounded EBUSY/EPERM retry, through the same shared constants the
    // managed-document store's asynchronous form uses. This writer runs to
    // completion inside one call, so it takes the SYNCHRONOUS form; the two share
    // `isTransientRenameError`, the attempt count and the delay, which is what
    // keeps a transient lock from failing here but not there.
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
