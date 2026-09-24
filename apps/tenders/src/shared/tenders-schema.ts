import type {
  BoundingBox,
  CompanyDirector,
  CompanyProfile,
  CompanyProject,
  CompanyWorkspace,
  ContractMilestone,
  Customer,
  CustomerDoc,
  FieldReview,
  IntakeVerification,
  IssuerTemplate,
  PageExtractionState,
  RequirementRecord,
  RequirementReview,
  ReviewCandidate,
  ReviewFieldKey,
  ReviewFieldState,
  TenderDataOrigin,
  TenderLifecycleEvent,
  TenderOutcomeRecord,
  TenderReadinessSnapshot,
  TenderRecord,
  TenderSubmissionEvidence,
  TenderSubmissionRecord,
  TendersDataV1,
  TendersDataV2,
  TendersWorkspaceV2,
  ValueProvenance,
  VaultDoc,
} from './types'
import { parseClosingDate } from './readiness'
import {
  MAX_TENDERS_AGGREGATE_STRING_CHARS,
  MAX_TENDERS_ADDITIONAL_CLAUSES_PER_REQUIREMENT,
  MAX_TENDERS_CUSTOMERS_PER_WORKSPACE,
  MAX_TENDERS_DYNAMIC_ENTRIES,
  MAX_TENDERS_DYNAMIC_KEY_CHARS,
  MAX_TENDERS_ISSUER_TEMPLATES,
  MAX_TENDERS_LIFECYCLE_HISTORY,
  MAX_TENDERS_MILESTONES_PER_TENDER,
  MAX_TENDERS_PAGE_STATES,
  MAX_TENDERS_READINESS_BLOCKERS,
  MAX_TENDERS_REQUIREMENTS_PER_TENDER,
  MAX_TENDERS_REQUIRED_DOCS_PER_CUSTOMER,
  MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD,
  MAX_TENDERS_REVIEW_CONFLICTS,
  MAX_TENDERS_REVIEW_REQUIREMENTS,
  MAX_TENDERS_SCHEMA_ISSUES,
  MAX_TENDERS_SINGLE_STRING_CHARS,
  MAX_TENDERS_TENDERS_PER_WORKSPACE,
  MAX_TENDERS_VAULT_DOCS_PER_WORKSPACE,
  MAX_TENDERS_WORKSPACES,
} from './tenders-persistence'

export const TENDERS_SCHEMA_VERSION = 2 as const

export type TendersSchemaIssueCode = 'INVALID' | 'MISSING' | 'UNSUPPORTED' | 'NOT_IMPLEMENTED'

export interface TendersSchemaIssue {
  path: string
  code: TendersSchemaIssueCode | string
  message: string
  value?: unknown
}

export interface TendersSchemaError {
  code: TendersSchemaIssueCode | string
  message: string
  issues: TendersSchemaIssue[]
}

export type TendersSchemaResult<T> =
  | {
      ok: true
      data: T
      sourceVersion: 1 | 2
      migrated: boolean
      warnings: string[]
    }
  | { ok: false; error: TendersSchemaError; issues: TendersSchemaIssue[] }

export type TendersDataSchemaIssue = TendersSchemaIssue
export type TendersDataSchemaError = TendersSchemaError
export type TendersDataSchemaResult<T> = TendersSchemaResult<T>

type UnknownRecord = Record<string, unknown>

class Issues {
  readonly items: TendersSchemaIssue[] = []

  add(path: string, code: TendersSchemaIssueCode, message: string, value?: unknown): void {
    if (this.items.length >= MAX_TENDERS_SCHEMA_ISSUES) return
    this.items.push({ path, code, message, ...(value === undefined ? {} : { value }) })
  }
}

const TOP_V1 = new Set(['version', 'updatedAt', 'activeCompanyId', 'workspaces', 'issuerTemplates'])
const TOP_V2 = new Set([
  'schemaVersion',
  'revision',
  'updatedAt',
  'activeCompanyId',
  'workspaces',
  'issuerTemplates',
])
const WORKSPACE_V1 = new Set(['id', 'name', 'company', 'customers', 'vault', 'tenders'])
const WORKSPACE_V2 = new Set([...WORKSPACE_V1, 'dataOrigin'])
const COMPANY = new Set([
  'name',
  'tradingName',
  'registrationNumber',
  'vatNumber',
  'taxPin',
  'bbbeeLevel',
  'bbbeeBlackOwnership',
  'csdSupplierNumber',
  'founded',
  'employees',
  'industry',
  'description',
  'address',
  'phone',
  'email',
  'website',
  'directors',
  'projects',
  'archivedAt',
])
const DIRECTOR = new Set(['name', 'role', 'idNumber'])
const PROJECT = new Set([
  'id',
  'title',
  'client',
  'value',
  'period',
  'status',
  'description',
  'sector',
])
const CUSTOMER = new Set([
  'id',
  'name',
  'contactName',
  'contactEmail',
  'contactPhone',
  'industry',
  'status',
  'since',
  'notes',
  'requiredDocs',
  'archivedAt',
])
const CUSTOMER_DOC = new Set(['docCategory', 'label', 'fulfilled', 'linkedVaultDocId'])
const VAULT = new Set([
  'id',
  'title',
  'category',
  'fileUrl',
  'issueDate',
  'expiryDate',
  'isCertified',
  'certifiedDate',
  'metadata',
])
const TENDER = new Set([
  'id',
  'title',
  'referenceNumber',
  'issuingBody',
  'closingDate',
  'submissionMethod',
  'submissionAddress',
  'signatureChecks',
  'status',
  'createdAt',
  'fileName',
  'fileUrl',
  'numPages',
  'ocrPages',
  'requirements',
  'linkedCrmDealId',
  'estimatedValue',
  'pricingConfirmed',
  'milestones',
  'intakeVerification',
  'dataOrigin',
  'submission',
  'outcome',
  'lifecycle',
])
/**
 * Allowed per-tender origins. `'demo'` is the only representable value: absent
 * means the user's own import, so this flag can label demonstration data but can
 * never claim user provenance (billing/sync privilege is gated on the
 * workspace-level `dataOrigin`, which the renderer cannot reach through here).
 */
const TENDER_DATA_ORIGINS = new Set(['demo'])
const SUBMISSION = new Set([
  'submittedAt',
  'timeZone',
  'method',
  'destination',
  'confirmationReference',
  'evidence',
  'person',
  'notes',
  'readiness',
  'blockerOverrideReason',
])
const SUBMISSION_EVIDENCE = new Set(['kind', 'reference', 'note'])
const READINESS_SNAPSHOT = new Set([
  'ready',
  'score',
  'failedCheckIds',
  'blockingCheckIds',
  'capturedAt',
])
const OUTCOME = new Set([
  'status',
  'noticeDate',
  'reason',
  'awardedValue',
  'evidenceReference',
  'recordedAt',
])
const LIFECYCLE_EVENT = new Set(['at', 'from', 'to', 'reason'])
const REQUIREMENT = new Set([
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
const CLAUSE = new Set(['text', 'pageNumber'])
const MILESTONE = new Set([
  'id',
  'name',
  'title',
  'description',
  'amount',
  'dueDate',
  'completedDate',
  'status',
  'billedInvoiceId',
  'billedInvoiceNumber',
  'billedAt',
  'billedDate',
])
const ISSUER = new Set([
  'id',
  'name',
  'displayName',
  'address',
  'contact',
  'refStyle',
  'submissionMethod',
  'submissionAddress',
  'seenCount',
  'lastSeen',
])
const REVIEW_FIELD_KEYS = new Set([
  'title',
  'referenceNumber',
  'issuingBody',
  'contactEmail',
  'closingDate',
  'submissionMethod',
  'submissionDestination',
  'estimatedValue',
])
const INTAKE_VERIFICATION = new Set([
  'fields',
  'requirements',
  'pages',
  'contactEmail',
  'conflicts',
  'createdAt',
  'updatedAt',
])
const FIELD_REVIEW = new Set([
  'extractedValue',
  'sourcePage',
  'sourceClause',
  'confidence',
  'candidates',
  'state',
  'reviewedAt',
  'suggestedBy',
])
const REVIEW_CANDIDATE = new Set(['value', 'sourcePage', 'sourceClause', 'score', 'suggestedBy'])
const REQUIREMENT_REVIEW = new Set(['state', 'originalTitle', 'originalCategory', 'correctedAt'])
const PAGE_EXTRACTION = new Set(['pageNumber', 'state', 'method', 'confidence', 'reviewedAt'])

const DOC_CATEGORIES = new Set(['COMPLIANCE', 'FINANCIAL', 'TECHNICAL', 'GOVERNANCE', 'CV'])
const REQUIREMENT_CATEGORIES = new Set([
  'MANDATORY_STAGE_1',
  'FUNCTIONALITY_STAGE_2',
  'FINANCIAL_STAGE_3',
  'GENERAL_RETURNABLE',
])
const RISKS = new Set(['CRITICAL_DISQUALIFIER', 'POINT_SCORED', 'INFORMATIONAL'])
const CUSTOMER_STATUSES = new Set(['ACTIVE', 'PROSPECT', 'INACTIVE'])
const PROJECT_STATUSES = new Set(['COMPLETED', 'IN_PROGRESS', 'BIDDING', 'ON_HOLD'])
const TENDER_STATUSES = new Set([
  'IN_PROGRESS',
  'READY_TO_ASSEMBLE',
  'PACK_GENERATED',
  'READY_FOR_SUBMISSION',
  'SUBMITTED',
  'SUBMITTED_EVIDENCED',
  'WON',
  'LOST',
  'WITHDRAWN',
  'CANCELLED',
  'ARCHIVED',
])
const OUTCOME_STATUSES = new Set(['pending', 'won', 'lost', 'withdrawn', 'cancelled'])
const SUBMISSION_METHODS = new Set(['PHYSICAL', 'ELECTRONIC', 'EMAIL'])
const FULFILLMENT_STATUSES = new Set([
  'FULFILLED',
  'ACTION_REQUIRED',
  'OUTSTANDING',
  'NOT_APPLICABLE',
])
const MILESTONE_STATUSES = new Set(['PENDING', 'REACHED', 'BILLED', 'PAID'])
const REVIEW_FIELD_STATES = new Set(['unconfirmed', 'confirmed', 'corrected', 'not_stated'])
const REQUIREMENT_REVIEW_STATES = new Set(['unreviewed', 'verified'])
/**
 * Allowed provenance markers (see `ValueProvenance`). Closed on purpose: an
 * unrecognised origin is rejected rather than stored, so a value's origin can
 * never be recorded as something the schema does not understand.
 */
const VALUE_PROVENANCES = new Set(['parser', 'ai'])
const PAGE_EXTRACTION_STATUSES = new Set([
  'native',
  'ocr-required',
  'ocr-unavailable',
  'ocr-failed',
  'manually-reviewed',
  'ai-extracted',
])

function record(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function has(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/**
 * Own-property presence that matches JSON serialization semantics: a property
 * whose value is exactly `undefined` is treated as absent. Required-field
 * checks keep using `has()` so a genuinely missing key is still rejected.
 */
function hasDefined(value: UnknownRecord, key: string): boolean {
  return has(value, key) && value[key] !== undefined
}

function objectAt(
  value: unknown,
  path: string,
  allowed: Set<string>,
  issues: Issues,
): UnknownRecord | undefined {
  if (!record(value)) {
    issues.add(path, 'INVALID', 'Expected an object.', value)
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.add(path ? `${path}.${key}` : key, 'INVALID', 'Unknown field.')
  }
  return value
}

function required(value: UnknownRecord, key: string, path: string, issues: Issues): unknown {
  if (!has(value, key)) {
    issues.add(`${path}.${key}`, 'MISSING', 'Required field is missing.')
    return undefined
  }
  return value[key]
}

function stringValue(
  value: unknown,
  path: string,
  issues: Issues,
  nonEmpty = false,
): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > MAX_TENDERS_SINGLE_STRING_CHARS ||
    (nonEmpty && value.trim().length === 0)
  ) {
    issues.add(path, 'INVALID', 'Expected a string.', value)
    return undefined
  }
  return value
}

function optionalString(
  value: UnknownRecord,
  key: string,
  path: string,
  issues: Issues,
  nullable = false,
): string | null | undefined {
  if (!hasDefined(value, key)) return undefined
  const candidate = value[key]
  if (candidate === null && nullable) return null
  return stringValue(candidate, `${path}.${key}`, issues)
}

function booleanValue(value: unknown, path: string, issues: Issues): boolean | undefined {
  if (typeof value !== 'boolean') issues.add(path, 'INVALID', 'Expected a boolean.', value)
  return typeof value === 'boolean' ? value : undefined
}

function finiteNumber(
  value: unknown,
  path: string,
  issues: Issues,
  integer = false,
): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value))
  ) {
    issues.add(path, 'INVALID', 'Expected a finite number.', value)
    return undefined
  }
  return value
}

function nonnegativeNumber(value: unknown, path: string, issues: Issues): number | undefined {
  const parsed = finiteNumber(value, path, issues)
  if (parsed !== undefined && parsed < 0)
    issues.add(path, 'INVALID', 'Expected a non-negative number.', value)
  return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

function boundedUnit(value: unknown, path: string, issues: Issues): number | undefined {
  const parsed = finiteNumber(value, path, issues)
  if (parsed !== undefined && (parsed < 0 || parsed > 1))
    issues.add(path, 'INVALID', 'Expected a number between zero and one.', value)
  return parsed !== undefined && parsed >= 0 && parsed <= 1 ? parsed : undefined
}

function nonnegativeInteger(value: unknown, path: string, issues: Issues): number | undefined {
  const parsed = finiteNumber(value, path, issues, true)
  if (parsed !== undefined && parsed < 0)
    issues.add(path, 'INVALID', 'Expected a non-negative integer.', value)
  return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

function arrayValue(value: unknown, path: string, issues: Issues): unknown[] | undefined {
  if (!Array.isArray(value)) {
    issues.add(path, 'INVALID', 'Expected an array.', value)
    return undefined
  }
  return value
}

function enumValue(
  value: unknown,
  path: string,
  allowed: Set<string>,
  issues: Issues,
): string | undefined {
  if (typeof value !== 'string' || !allowed.has(value)) {
    issues.add(path, 'INVALID', 'Invalid enum value.', value)
    return undefined
  }
  return value
}

function validCivilDate(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
  return day <= days
}

function validRfc3339(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  )
  if (!match) return false
  const hours = Number(match[4])
  const minutes = Number(match[5])
  const seconds = Number(match[6])
  if (
    !validCivilDate(Number(match[1]), Number(match[2]), Number(match[3])) ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  )
    return false
  const offset = match[7]
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59))
    return false
  return Number.isFinite(Date.parse(value))
}

function validCivilDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return validCivilDate(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)),
    Number(value.slice(8, 10)),
  )
}

function validStoredDate(value: unknown, allowNull = false): boolean {
  return (allowNull && value === null) || validCivilDateString(value) || validRfc3339(value)
}

function requiredStringObject(
  value: unknown,
  path: string,
  allowed: Set<string>,
  issues: Issues,
): UnknownRecord | undefined {
  return objectAt(value, path, allowed, issues)
}

function parseBoundingBox(value: unknown, path: string, issues: Issues): BoundingBox | undefined {
  const object = requiredStringObject(
    value,
    path,
    new Set(['top', 'left', 'width', 'height']),
    issues,
  )
  if (!object) return undefined
  const top = boundedUnit(required(object, 'top', path, issues), `${path}.top`, issues)
  const left = boundedUnit(required(object, 'left', path, issues), `${path}.left`, issues)
  const width = boundedUnit(required(object, 'width', path, issues), `${path}.width`, issues)
  const height = boundedUnit(required(object, 'height', path, issues), `${path}.height`, issues)
  if (left !== undefined && width !== undefined && left + width > 1)
    issues.add(path, 'INVALID', 'Bounding box exceeds horizontal page extent.')
  if (top !== undefined && height !== undefined && top + height > 1)
    issues.add(path, 'INVALID', 'Bounding box exceeds vertical page extent.')
  return { top: top ?? 0, left: left ?? 0, width: width ?? 0, height: height ?? 0 }
}

function parseDirector(value: unknown, path: string, issues: Issues): CompanyDirector | undefined {
  const object = requiredStringObject(value, path, DIRECTOR, issues)
  if (!object) return undefined
  return {
    name: stringValue(required(object, 'name', path, issues), `${path}.name`, issues) ?? '',
    role: stringValue(required(object, 'role', path, issues), `${path}.role`, issues) ?? '',
    idNumber:
      stringValue(required(object, 'idNumber', path, issues), `${path}.idNumber`, issues) ?? '',
  }
}

function parseProject(value: unknown, path: string, issues: Issues): CompanyProject | undefined {
  const object = requiredStringObject(value, path, PROJECT, issues)
  if (!object) return undefined
  return {
    id: stringValue(required(object, 'id', path, issues), `${path}.id`, issues, true) ?? '',
    title: stringValue(required(object, 'title', path, issues), `${path}.title`, issues) ?? '',
    client: stringValue(required(object, 'client', path, issues), `${path}.client`, issues) ?? '',
    value: stringValue(required(object, 'value', path, issues), `${path}.value`, issues) ?? '',
    period: stringValue(required(object, 'period', path, issues), `${path}.period`, issues) ?? '',
    status: (enumValue(
      required(object, 'status', path, issues),
      `${path}.status`,
      PROJECT_STATUSES,
      issues,
    ) ?? 'ON_HOLD') as CompanyProject['status'],
    description:
      stringValue(required(object, 'description', path, issues), `${path}.description`, issues) ??
      '',
    sector: stringValue(required(object, 'sector', path, issues), `${path}.sector`, issues) ?? '',
  }
}

function parseCompany(value: unknown, path: string, issues: Issues): CompanyProfile | undefined {
  const object = requiredStringObject(value, path, COMPANY, issues)
  if (!object) return undefined
  const directorsRaw =
    arrayValue(required(object, 'directors', path, issues), `${path}.directors`, issues) ?? []
  const projectsRaw =
    arrayValue(required(object, 'projects', path, issues), `${path}.projects`, issues) ?? []
  const archivedAt = optionalNullableRfc3339(object, 'archivedAt', path, issues)
  return {
    name: stringValue(required(object, 'name', path, issues), `${path}.name`, issues) ?? '',
    tradingName:
      stringValue(required(object, 'tradingName', path, issues), `${path}.tradingName`, issues) ??
      '',
    registrationNumber:
      stringValue(
        required(object, 'registrationNumber', path, issues),
        `${path}.registrationNumber`,
        issues,
      ) ?? '',
    vatNumber:
      stringValue(required(object, 'vatNumber', path, issues), `${path}.vatNumber`, issues) ?? '',
    taxPin: stringValue(required(object, 'taxPin', path, issues), `${path}.taxPin`, issues) ?? '',
    bbbeeLevel:
      stringValue(required(object, 'bbbeeLevel', path, issues), `${path}.bbbeeLevel`, issues) ?? '',
    bbbeeBlackOwnership:
      stringValue(
        required(object, 'bbbeeBlackOwnership', path, issues),
        `${path}.bbbeeBlackOwnership`,
        issues,
      ) ?? '',
    csdSupplierNumber:
      stringValue(
        required(object, 'csdSupplierNumber', path, issues),
        `${path}.csdSupplierNumber`,
        issues,
      ) ?? '',
    founded:
      stringValue(required(object, 'founded', path, issues), `${path}.founded`, issues) ?? '',
    employees:
      stringValue(required(object, 'employees', path, issues), `${path}.employees`, issues) ?? '',
    industry:
      stringValue(required(object, 'industry', path, issues), `${path}.industry`, issues) ?? '',
    description:
      stringValue(required(object, 'description', path, issues), `${path}.description`, issues) ??
      '',
    address:
      stringValue(required(object, 'address', path, issues), `${path}.address`, issues) ?? '',
    phone: stringValue(required(object, 'phone', path, issues), `${path}.phone`, issues) ?? '',
    email: stringValue(required(object, 'email', path, issues), `${path}.email`, issues) ?? '',
    website:
      stringValue(required(object, 'website', path, issues), `${path}.website`, issues) ?? '',
    directors: directorsRaw
      .map((item, index) => parseDirector(item, `${path}.directors.${index}`, issues))
      .filter((item): item is CompanyDirector => item !== undefined),
    projects: projectsRaw
      .map((item, index) => parseProject(item, `${path}.projects.${index}`, issues))
      .filter((item): item is CompanyProject => item !== undefined),
    ...(archivedAt === undefined ? {} : { archivedAt }),
  }
}

function parseCustomerDoc(value: unknown, path: string, issues: Issues): CustomerDoc | undefined {
  const object = requiredStringObject(value, path, CUSTOMER_DOC, issues)
  if (!object) return undefined
  const linked = required(object, 'linkedVaultDocId', path, issues)
  if (linked !== null) stringValue(linked, `${path}.linkedVaultDocId`, issues)
  return {
    docCategory: (enumValue(
      required(object, 'docCategory', path, issues),
      `${path}.docCategory`,
      DOC_CATEGORIES,
      issues,
    ) ?? 'COMPLIANCE') as CustomerDoc['docCategory'],
    label: stringValue(required(object, 'label', path, issues), `${path}.label`, issues) ?? '',
    fulfilled:
      booleanValue(required(object, 'fulfilled', path, issues), `${path}.fulfilled`, issues) ??
      false,
    linkedVaultDocId:
      linked === null ? null : (stringValue(linked, `${path}.linkedVaultDocId`, issues) ?? null),
  }
}

function parseCustomer(value: unknown, path: string, issues: Issues): Customer | undefined {
  const object = requiredStringObject(value, path, CUSTOMER, issues)
  if (!object) return undefined
  const docs =
    boundedArray(
      required(object, 'requiredDocs', path, issues),
      `${path}.requiredDocs`,
      issues,
      MAX_TENDERS_REQUIRED_DOCS_PER_CUSTOMER,
    ) ?? []
  const since = stringValue(required(object, 'since', path, issues), `${path}.since`, issues) ?? ''
  if (!validCivilDateString(since))
    issues.add(`${path}.since`, 'INVALID', 'Expected a valid civil date.', since)
  const archivedAt = optionalNullableRfc3339(object, 'archivedAt', path, issues)
  return {
    id: stringValue(required(object, 'id', path, issues), `${path}.id`, issues, true) ?? '',
    name: stringValue(required(object, 'name', path, issues), `${path}.name`, issues) ?? '',
    contactName:
      stringValue(required(object, 'contactName', path, issues), `${path}.contactName`, issues) ??
      '',
    contactEmail:
      stringValue(required(object, 'contactEmail', path, issues), `${path}.contactEmail`, issues) ??
      '',
    contactPhone:
      stringValue(required(object, 'contactPhone', path, issues), `${path}.contactPhone`, issues) ??
      '',
    industry:
      stringValue(required(object, 'industry', path, issues), `${path}.industry`, issues) ?? '',
    status: (enumValue(
      required(object, 'status', path, issues),
      `${path}.status`,
      CUSTOMER_STATUSES,
      issues,
    ) ?? 'INACTIVE') as Customer['status'],
    since,
    notes: stringValue(required(object, 'notes', path, issues), `${path}.notes`, issues) ?? '',
    requiredDocs: docs
      .map((item, index) => parseCustomerDoc(item, `${path}.requiredDocs.${index}`, issues))
      .filter((item): item is CustomerDoc => item !== undefined),
    ...(archivedAt === undefined ? {} : { archivedAt }),
  }
}

function parseVault(value: unknown, path: string, issues: Issues): VaultDoc | undefined {
  const object = requiredStringObject(value, path, VAULT, issues)
  if (!object) return undefined
  const category = enumValue(
    required(object, 'category', path, issues),
    `${path}.category`,
    DOC_CATEGORIES,
    issues,
  )
  const metadataValue = required(object, 'metadata', path, issues)
  let metadata: Record<string, string> = {}
  if (!record(metadataValue)) issues.add(`${path}.metadata`, 'INVALID', 'Expected an object.')
  else {
    const entries = Object.entries(metadataValue)
    if (entries.length > MAX_TENDERS_DYNAMIC_ENTRIES)
      issues.add(`${path}.metadata`, 'INVALID', 'Dynamic entry count exceeds limit.')
    metadata = Object.fromEntries(
      entries.map(([key, item]) => {
        if (key.length > MAX_TENDERS_DYNAMIC_KEY_CHARS)
          issues.add(`${path}.metadata.${key}`, 'INVALID', 'Dynamic key exceeds length limit.')
        return [key, stringValue(item, `${path}.metadata.${key}`, issues) ?? '']
      }),
    )
  }
  const nullableString = (key: string): string | null => {
    const item = required(object, key, path, issues)
    if (item === null) return null
    return stringValue(item, `${path}.${key}`, issues) ?? null
  }
  for (const key of ['issueDate', 'expiryDate', 'certifiedDate']) {
    if (hasDefined(object, key) && !validStoredDate(object[key], true))
      issues.add(
        `${path}.${key}`,
        'INVALID',
        'Expected a valid civil date or RFC3339 timestamp.',
        object[key],
      )
  }
  return {
    id: stringValue(required(object, 'id', path, issues), `${path}.id`, issues, true) ?? '',
    title: stringValue(required(object, 'title', path, issues), `${path}.title`, issues) ?? '',
    category: (category ?? 'COMPLIANCE') as VaultDoc['category'],
    fileUrl: nullableString('fileUrl'),
    issueDate: nullableString('issueDate'),
    expiryDate: nullableString('expiryDate'),
    isCertified:
      booleanValue(required(object, 'isCertified', path, issues), `${path}.isCertified`, issues) ??
      false,
    certifiedDate: nullableString('certifiedDate'),
    metadata,
  }
}

function parseRequirement(
  value: unknown,
  path: string,
  issues: Issues,
): RequirementRecord | undefined {
  const object = requiredStringObject(value, path, REQUIREMENT, issues)
  if (!object) return undefined
  const clauses = hasDefined(object, 'additionalClauses')
    ? boundedArray(
        object.additionalClauses,
        `${path}.additionalClauses`,
        issues,
        MAX_TENDERS_ADDITIONAL_CLAUSES_PER_REQUIREMENT,
      )
    : undefined
  const additionalClauses = clauses
    ?.map((item, index) => {
      const clause = requiredStringObject(
        item,
        `${path}.additionalClauses.${index}`,
        CLAUSE,
        issues,
      )
      return clause
        ? {
            text:
              stringValue(
                required(clause, 'text', `${path}.additionalClauses.${index}`, issues),
                `${path}.additionalClauses.${index}.text`,
                issues,
              ) ?? '',
            pageNumber:
              nonnegativeInteger(
                required(clause, 'pageNumber', `${path}.additionalClauses.${index}`, issues),
                `${path}.additionalClauses.${index}.pageNumber`,
                issues,
              ) ?? 0,
          }
        : undefined
    })
    .filter((item): item is { text: string; pageNumber: number } => item !== undefined)
  const linked = required(object, 'linkedVaultDocId', path, issues)
  const reason = required(object, 'reason', path, issues)
  const applicable = hasDefined(object, 'notApplicableReason')
    ? object.notApplicableReason
    : undefined
  return {
    id: stringValue(required(object, 'id', path, issues), `${path}.id`, issues, true) ?? '',
    ruleKey:
      stringValue(required(object, 'ruleKey', path, issues), `${path}.ruleKey`, issues) ?? '',
    title: stringValue(required(object, 'title', path, issues), `${path}.title`, issues) ?? '',
    category: (enumValue(
      required(object, 'category', path, issues),
      `${path}.category`,
      REQUIREMENT_CATEGORIES,
      issues,
    ) ?? 'GENERAL_RETURNABLE') as RequirementRecord['category'],
    isMandatory:
      booleanValue(required(object, 'isMandatory', path, issues), `${path}.isMandatory`, issues) ??
      false,
    verbatimClause:
      stringValue(
        required(object, 'verbatimClause', path, issues),
        `${path}.verbatimClause`,
        issues,
      ) ?? '',
    pageNumber:
      nonnegativeInteger(
        required(object, 'pageNumber', path, issues),
        `${path}.pageNumber`,
        issues,
      ) ?? 0,
    boundingBox: parseBoundingBox(
      required(object, 'boundingBox', path, issues),
      `${path}.boundingBox`,
      issues,
    ) ?? { top: 0, left: 0, width: 0, height: 0 },
    riskLevel: (enumValue(
      required(object, 'riskLevel', path, issues),
      `${path}.riskLevel`,
      RISKS,
      issues,
    ) ?? 'INFORMATIONAL') as RequirementRecord['riskLevel'],
    order:
      nonnegativeInteger(required(object, 'order', path, issues), `${path}.order`, issues) ?? 0,
    ...(additionalClauses === undefined ? {} : { additionalClauses }),
    ...(hasDefined(object, 'confidence')
      ? { confidence: boundedUnit(object.confidence, `${path}.confidence`, issues) }
      : {}),
    ...(hasDefined(object, 'notes')
      ? { notes: stringValue(object.notes, `${path}.notes`, issues) }
      : {}),
    ...provenanceField(object, path, issues),
    status: (enumValue(
      required(object, 'status', path, issues),
      `${path}.status`,
      FULFILLMENT_STATUSES,
      issues,
    ) ?? 'OUTSTANDING') as RequirementRecord['status'],
    linkedVaultDocId:
      linked == null ? null : (stringValue(linked, `${path}.linkedVaultDocId`, issues) ?? null),
    reason: reason == null ? null : (stringValue(reason, `${path}.reason`, issues) ?? null),
    ...(hasDefined(object, 'notApplicableReason')
      ? {
          notApplicableReason:
            applicable === null
              ? null
              : (stringValue(applicable, `${path}.notApplicableReason`, issues) ?? null),
        }
      : {}),
    suggestedVaultDocIds: (() => {
      const ids =
        arrayValue(
          required(object, 'suggestedVaultDocIds', path, issues),
          `${path}.suggestedVaultDocIds`,
          issues,
        ) ?? []
      return ids.map(
        (id, index) => stringValue(id, `${path}.suggestedVaultDocIds.${index}`, issues) ?? '',
      )
    })(),
  }
}

function parseMilestone(
  value: unknown,
  path: string,
  issues: Issues,
): ContractMilestone | undefined {
  const object = requiredStringObject(value, path, MILESTONE, issues)
  if (!object) return undefined
  const optional = (key: string): string | undefined =>
    optionalString(object, key, path, issues) as string | undefined
  for (const key of ['dueDate', 'completedDate']) {
    if (hasDefined(object, key) && !validCivilDateString(object[key]))
      issues.add(`${path}.${key}`, 'INVALID', 'Expected a valid civil date.', object[key])
  }
  if (hasDefined(object, 'billedDate') && !validStoredDate(object.billedDate))
    issues.add(
      `${path}.billedDate`,
      'INVALID',
      'Expected a valid civil date or RFC3339 timestamp.',
      object.billedDate,
    )
  if (hasDefined(object, 'billedAt') && !validRfc3339(object.billedAt))
    issues.add(
      `${path}.billedAt`,
      'INVALID',
      'Expected a valid RFC3339 timestamp.',
      object.billedAt,
    )
  return {
    id: stringValue(required(object, 'id', path, issues), `${path}.id`, issues, true) ?? '',
    name: stringValue(required(object, 'name', path, issues), `${path}.name`, issues) ?? '',
    ...(hasDefined(object, 'title') ? { title: optional('title') } : {}),
    ...(hasDefined(object, 'description') ? { description: optional('description') } : {}),
    amount:
      nonnegativeNumber(required(object, 'amount', path, issues), `${path}.amount`, issues) ?? 0,
    ...(hasDefined(object, 'dueDate') ? { dueDate: optional('dueDate') } : {}),
    ...(hasDefined(object, 'completedDate') ? { completedDate: optional('completedDate') } : {}),
    status: (enumValue(
      required(object, 'status', path, issues),
      `${path}.status`,
      MILESTONE_STATUSES,
      issues,
    ) ?? 'PENDING') as ContractMilestone['status'],
    ...(hasDefined(object, 'billedInvoiceId')
      ? { billedInvoiceId: optional('billedInvoiceId') }
      : {}),
    ...(hasDefined(object, 'billedInvoiceNumber')
      ? { billedInvoiceNumber: optional('billedInvoiceNumber') }
      : {}),
    ...(hasDefined(object, 'billedAt') ? { billedAt: optional('billedAt') } : {}),
    ...(hasDefined(object, 'billedDate') ? { billedDate: optional('billedDate') } : {}),
  }
}

function requiredNullableString(
  object: UnknownRecord,
  key: string,
  path: string,
  issues: Issues,
): string | null {
  const item = required(object, key, path, issues)
  if (item === null) return null
  return stringValue(item, `${path}.${key}`, issues) ?? null
}

function nullableRfc3339(value: unknown, path: string, issues: Issues): string | null {
  if (value === null) return null
  if (typeof value === 'string' && validRfc3339(value)) return value
  issues.add(path, 'INVALID', 'Expected a valid RFC3339 timestamp or null.', value)
  return null
}

function requiredNullableRfc3339(
  object: UnknownRecord,
  key: string,
  path: string,
  issues: Issues,
): string | null {
  return nullableRfc3339(required(object, key, path, issues), `${path}.${key}`, issues)
}

/** Additive optional nullable RFC3339: undefined when the key is absent. */
function optionalNullableRfc3339(
  object: UnknownRecord,
  key: string,
  path: string,
  issues: Issues,
): string | null | undefined {
  if (!hasDefined(object, key)) return undefined
  return nullableRfc3339(object[key], `${path}.${key}`, issues)
}

function nullableNonnegativeInteger(value: unknown, path: string, issues: Issues): number | null {
  if (value === null) return null
  return nonnegativeInteger(value, path, issues) ?? null
}

function nullableBoundedUnit(value: unknown, path: string, issues: Issues): number | null {
  if (value === null) return null
  return boundedUnit(value, path, issues) ?? null
}

function parseReviewCandidate(
  value: unknown,
  path: string,
  issues: Issues,
): ReviewCandidate | undefined {
  const object = requiredStringObject(value, path, REVIEW_CANDIDATE, issues)
  if (!object) return undefined
  return {
    value: stringValue(required(object, 'value', path, issues), `${path}.value`, issues) ?? '',
    sourcePage: nullableNonnegativeInteger(
      required(object, 'sourcePage', path, issues),
      `${path}.sourcePage`,
      issues,
    ),
    sourceClause: requiredNullableString(object, 'sourceClause', path, issues),
    score: boundedUnit(required(object, 'score', path, issues), `${path}.score`, issues) ?? 0,
    ...provenanceField(object, path, issues),
  }
}

/**
 * Additive optional provenance marker. Omitted entirely when the key is absent,
 * so a document written before the marker existed round-trips unchanged, and an
 * unrecognised value is an issue rather than a silent coercion to `'parser'`.
 */
function provenanceField(
  object: UnknownRecord,
  path: string,
  issues: Issues,
): { suggestedBy?: ValueProvenance } {
  if (!hasDefined(object, 'suggestedBy')) return {}
  const parsed = enumValue(object.suggestedBy, `${path}.suggestedBy`, VALUE_PROVENANCES, issues)
  return parsed === undefined ? {} : { suggestedBy: parsed as ValueProvenance }
}

function parseFieldReview(value: unknown, path: string, issues: Issues): FieldReview | undefined {
  const object = requiredStringObject(value, path, FIELD_REVIEW, issues)
  if (!object) return undefined
  const candidates =
    boundedArray(
      required(object, 'candidates', path, issues),
      `${path}.candidates`,
      issues,
      MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD,
    ) ?? []
  return {
    extractedValue: requiredNullableString(object, 'extractedValue', path, issues),
    sourcePage: nullableNonnegativeInteger(
      required(object, 'sourcePage', path, issues),
      `${path}.sourcePage`,
      issues,
    ),
    sourceClause: requiredNullableString(object, 'sourceClause', path, issues),
    confidence: nullableBoundedUnit(
      required(object, 'confidence', path, issues),
      `${path}.confidence`,
      issues,
    ),
    candidates: candidates
      .map((item, index) => parseReviewCandidate(item, `${path}.candidates.${index}`, issues))
      .filter((item): item is ReviewCandidate => item !== undefined),
    state: (enumValue(
      required(object, 'state', path, issues),
      `${path}.state`,
      REVIEW_FIELD_STATES,
      issues,
    ) ?? 'unconfirmed') as ReviewFieldState,
    reviewedAt: nullableRfc3339(
      required(object, 'reviewedAt', path, issues),
      `${path}.reviewedAt`,
      issues,
    ),
    ...provenanceField(object, path, issues),
  }
}

function parseRequirementReview(
  value: unknown,
  path: string,
  issues: Issues,
): RequirementReview | undefined {
  const object = requiredStringObject(value, path, REQUIREMENT_REVIEW, issues)
  if (!object) return undefined
  const categoryRaw = required(object, 'originalCategory', path, issues)
  let originalCategory: RequirementReview['originalCategory'] = null
  if (categoryRaw !== null) {
    const parsed = enumValue(
      categoryRaw,
      `${path}.originalCategory`,
      REQUIREMENT_CATEGORIES,
      issues,
    )
    originalCategory = (parsed as RequirementReview['originalCategory']) ?? null
  }
  return {
    state: (enumValue(
      required(object, 'state', path, issues),
      `${path}.state`,
      REQUIREMENT_REVIEW_STATES,
      issues,
    ) ?? 'unreviewed') as RequirementReview['state'],
    originalTitle: requiredNullableString(object, 'originalTitle', path, issues),
    originalCategory,
    correctedAt: nullableRfc3339(
      required(object, 'correctedAt', path, issues),
      `${path}.correctedAt`,
      issues,
    ),
  }
}

function parsePageExtractionState(
  value: unknown,
  path: string,
  issues: Issues,
): PageExtractionState | undefined {
  const object = requiredStringObject(value, path, PAGE_EXTRACTION, issues)
  if (!object) return undefined
  return {
    pageNumber:
      nonnegativeInteger(
        required(object, 'pageNumber', path, issues),
        `${path}.pageNumber`,
        issues,
      ) ?? 0,
    state: (enumValue(
      required(object, 'state', path, issues),
      `${path}.state`,
      PAGE_EXTRACTION_STATUSES,
      issues,
    ) ?? 'native') as PageExtractionState['state'],
    method: requiredNullableString(object, 'method', path, issues),
    confidence: nullableBoundedUnit(
      required(object, 'confidence', path, issues),
      `${path}.confidence`,
      issues,
    ),
    reviewedAt: nullableRfc3339(
      required(object, 'reviewedAt', path, issues),
      `${path}.reviewedAt`,
      issues,
    ),
  }
}

function parseIntakeVerification(
  value: unknown,
  path: string,
  issues: Issues,
): IntakeVerification | undefined {
  const object = requiredStringObject(value, path, INTAKE_VERIFICATION, issues)
  if (!object) return undefined

  const fieldsRaw = requiredStringObject(
    required(object, 'fields', path, issues),
    `${path}.fields`,
    REVIEW_FIELD_KEYS,
    issues,
  )
  const fields: Partial<Record<ReviewFieldKey, FieldReview>> = {}
  if (fieldsRaw) {
    for (const key of Object.keys(fieldsRaw)) {
      const parsed = parseFieldReview(fieldsRaw[key], `${path}.fields.${key}`, issues)
      if (parsed) fields[key as ReviewFieldKey] = parsed
    }
  }

  const requirementsRaw = required(object, 'requirements', path, issues)
  let requirements: Record<string, RequirementReview> = {}
  if (!record(requirementsRaw)) {
    issues.add(`${path}.requirements`, 'INVALID', 'Expected an object.')
  } else {
    const entries = Object.entries(requirementsRaw)
    if (entries.length > MAX_TENDERS_REVIEW_REQUIREMENTS)
      issues.add(`${path}.requirements`, 'INVALID', 'Collection exceeds limit.')
    requirements = Object.fromEntries(
      entries
        .map(([key, item]) => {
          if (key.length > MAX_TENDERS_DYNAMIC_KEY_CHARS)
            issues.add(
              `${path}.requirements.${key}`,
              'INVALID',
              'Dynamic key exceeds length limit.',
            )
          return [key, parseRequirementReview(item, `${path}.requirements.${key}`, issues)] as const
        })
        .filter(([, parsed]) => parsed !== undefined),
    ) as Record<string, RequirementReview>
  }

  const pages = hasDefined(object, 'pages')
    ? boundedArray(object.pages, `${path}.pages`, issues, MAX_TENDERS_PAGE_STATES)
    : undefined
  const conflicts =
    boundedArray(
      required(object, 'conflicts', path, issues),
      `${path}.conflicts`,
      issues,
      MAX_TENDERS_REVIEW_CONFLICTS,
    ) ?? []
  const createdAtRaw = required(object, 'createdAt', path, issues)
  const updatedAtRaw = required(object, 'updatedAt', path, issues)
  if (typeof createdAtRaw !== 'string' || !validRfc3339(createdAtRaw))
    issues.add(`${path}.createdAt`, 'INVALID', 'Expected a valid RFC3339 timestamp.', createdAtRaw)
  if (typeof updatedAtRaw !== 'string' || !validRfc3339(updatedAtRaw))
    issues.add(`${path}.updatedAt`, 'INVALID', 'Expected a valid RFC3339 timestamp.', updatedAtRaw)

  return {
    fields,
    requirements,
    ...(pages === undefined
      ? {}
      : {
          pages: pages
            .map((item, index) => parsePageExtractionState(item, `${path}.pages.${index}`, issues))
            .filter((item): item is PageExtractionState => item !== undefined),
        }),
    contactEmail: requiredNullableString(object, 'contactEmail', path, issues),
    conflicts: conflicts.map(
      (item, index) => stringValue(item, `${path}.conflicts.${index}`, issues) ?? '',
    ),
    createdAt: typeof createdAtRaw === 'string' ? createdAtRaw : '',
    updatedAt: typeof updatedAtRaw === 'string' ? updatedAtRaw : '',
  }
}

function parseReadinessSnapshot(
  value: unknown,
  path: string,
  issues: Issues,
): TenderReadinessSnapshot | undefined {
  const object = requiredStringObject(value, path, READINESS_SNAPSHOT, issues)
  if (!object) return undefined
  const failedRaw =
    boundedArray(
      required(object, 'failedCheckIds', path, issues),
      `${path}.failedCheckIds`,
      issues,
      MAX_TENDERS_READINESS_BLOCKERS,
    ) ?? []
  const blockingRaw =
    boundedArray(
      required(object, 'blockingCheckIds', path, issues),
      `${path}.blockingCheckIds`,
      issues,
      MAX_TENDERS_READINESS_BLOCKERS,
    ) ?? []
  const capturedAtRaw = required(object, 'capturedAt', path, issues)
  if (typeof capturedAtRaw !== 'string' || !validRfc3339(capturedAtRaw))
    issues.add(
      `${path}.capturedAt`,
      'INVALID',
      'Expected a valid RFC3339 timestamp.',
      capturedAtRaw,
    )
  return {
    ready: booleanValue(required(object, 'ready', path, issues), `${path}.ready`, issues) ?? false,
    score:
      nonnegativeInteger(required(object, 'score', path, issues), `${path}.score`, issues) ?? 0,
    failedCheckIds: failedRaw.map(
      (item, index) => stringValue(item, `${path}.failedCheckIds.${index}`, issues) ?? '',
    ),
    blockingCheckIds: blockingRaw.map(
      (item, index) => stringValue(item, `${path}.blockingCheckIds.${index}`, issues) ?? '',
    ),
    capturedAt: typeof capturedAtRaw === 'string' ? capturedAtRaw : '',
  }
}

function parseSubmissionEvidence(
  value: unknown,
  path: string,
  issues: Issues,
): TenderSubmissionEvidence | undefined {
  const object = requiredStringObject(value, path, SUBMISSION_EVIDENCE, issues)
  if (!object) return undefined
  return {
    kind: stringValue(required(object, 'kind', path, issues), `${path}.kind`, issues, true) ?? '',
    reference: requiredNullableString(object, 'reference', path, issues),
    note: requiredNullableString(object, 'note', path, issues),
  }
}

function parseSubmission(
  value: unknown,
  path: string,
  issues: Issues,
): TenderSubmissionRecord | undefined {
  const object = requiredStringObject(value, path, SUBMISSION, issues)
  if (!object) return undefined
  const submittedAtRaw = required(object, 'submittedAt', path, issues)
  if (typeof submittedAtRaw !== 'string' || !validRfc3339(submittedAtRaw))
    issues.add(
      `${path}.submittedAt`,
      'INVALID',
      'Expected a valid RFC3339 timestamp.',
      submittedAtRaw,
    )
  const evidenceRaw = hasDefined(object, 'evidence') ? object.evidence : null
  const evidence =
    evidenceRaw === null
      ? null
      : (parseSubmissionEvidence(evidenceRaw, `${path}.evidence`, issues) ?? null)
  const readinessRaw = hasDefined(object, 'readiness') ? object.readiness : null
  const readiness =
    readinessRaw === null
      ? null
      : (parseReadinessSnapshot(readinessRaw, `${path}.readiness`, issues) ?? null)
  return {
    submittedAt: typeof submittedAtRaw === 'string' ? submittedAtRaw : '',
    timeZone: requiredNullableString(object, 'timeZone', path, issues),
    method: (enumValue(
      required(object, 'method', path, issues),
      `${path}.method`,
      SUBMISSION_METHODS,
      issues,
    ) ?? 'PHYSICAL') as TenderSubmissionRecord['method'],
    destination: requiredNullableString(object, 'destination', path, issues),
    confirmationReference: requiredNullableString(object, 'confirmationReference', path, issues),
    evidence,
    person: requiredNullableString(object, 'person', path, issues),
    notes: requiredNullableString(object, 'notes', path, issues),
    readiness,
    blockerOverrideReason: requiredNullableString(object, 'blockerOverrideReason', path, issues),
  }
}

function parseOutcome(
  value: unknown,
  path: string,
  issues: Issues,
): TenderOutcomeRecord | undefined {
  const object = requiredStringObject(value, path, OUTCOME, issues)
  if (!object) return undefined
  const recordedAtRaw = required(object, 'recordedAt', path, issues)
  if (typeof recordedAtRaw !== 'string' || !validRfc3339(recordedAtRaw))
    issues.add(
      `${path}.recordedAt`,
      'INVALID',
      'Expected a valid RFC3339 timestamp.',
      recordedAtRaw,
    )
  const awardedRaw = required(object, 'awardedValue', path, issues)
  return {
    status: (enumValue(
      required(object, 'status', path, issues),
      `${path}.status`,
      OUTCOME_STATUSES,
      issues,
    ) ?? 'pending') as TenderOutcomeRecord['status'],
    noticeDate: requiredNullableRfc3339(object, 'noticeDate', path, issues),
    reason: requiredNullableString(object, 'reason', path, issues),
    awardedValue:
      awardedRaw === null
        ? null
        : (nonnegativeNumber(awardedRaw, `${path}.awardedValue`, issues) ?? null),
    evidenceReference: requiredNullableString(object, 'evidenceReference', path, issues),
    recordedAt: typeof recordedAtRaw === 'string' ? recordedAtRaw : '',
  }
}

function parseLifecycleEvent(
  value: unknown,
  path: string,
  issues: Issues,
): TenderLifecycleEvent | undefined {
  const object = requiredStringObject(value, path, LIFECYCLE_EVENT, issues)
  if (!object) return undefined
  const atRaw = required(object, 'at', path, issues)
  if (typeof atRaw !== 'string' || !validRfc3339(atRaw))
    issues.add(`${path}.at`, 'INVALID', 'Expected a valid RFC3339 timestamp.', atRaw)
  const fromRaw = required(object, 'from', path, issues)
  const from =
    fromRaw === null ? null : (enumValue(fromRaw, `${path}.from`, TENDER_STATUSES, issues) ?? null)
  return {
    at: typeof atRaw === 'string' ? atRaw : '',
    from: from as TenderLifecycleEvent['from'],
    to: (enumValue(required(object, 'to', path, issues), `${path}.to`, TENDER_STATUSES, issues) ??
      'IN_PROGRESS') as TenderLifecycleEvent['to'],
    reason: requiredNullableString(object, 'reason', path, issues),
  }
}

function parseTender(value: unknown, path: string, issues: Issues): TenderRecord | undefined {
  const object = requiredStringObject(value, path, TENDER, issues)
  if (!object) return undefined
  const requirements =
    boundedArray(
      required(object, 'requirements', path, issues),
      `${path}.requirements`,
      issues,
      MAX_TENDERS_REQUIREMENTS_PER_TENDER,
    ) ?? []
  const milestones = hasDefined(object, 'milestones')
    ? boundedArray(
        object.milestones,
        `${path}.milestones`,
        issues,
        MAX_TENDERS_MILESTONES_PER_TENDER,
      )
    : undefined
  const intakeVerification = hasDefined(object, 'intakeVerification')
    ? parseIntakeVerification(object.intakeVerification, `${path}.intakeVerification`, issues)
    : undefined
  const submissionRaw = hasDefined(object, 'submission') ? object.submission : undefined
  const submission: TenderSubmissionRecord | null | undefined =
    submissionRaw === undefined
      ? undefined
      : submissionRaw === null
        ? null
        : parseSubmission(submissionRaw, `${path}.submission`, issues)
  const outcomeRaw = hasDefined(object, 'outcome') ? object.outcome : undefined
  const outcome: TenderOutcomeRecord | null | undefined =
    outcomeRaw === undefined
      ? undefined
      : outcomeRaw === null
        ? null
        : parseOutcome(outcomeRaw, `${path}.outcome`, issues)
  const lifecycle = hasDefined(object, 'lifecycle')
    ? boundedArray(object.lifecycle, `${path}.lifecycle`, issues, MAX_TENDERS_LIFECYCLE_HISTORY)
    : undefined
  const signaturesValue = required(object, 'signatureChecks', path, issues)
  let signatures: Record<string, boolean> = {}
  if (!record(signaturesValue))
    issues.add(`${path}.signatureChecks`, 'INVALID', 'Expected an object.')
  else {
    const signatureEntries = Object.entries(signaturesValue)
    if (signatureEntries.length > MAX_TENDERS_DYNAMIC_ENTRIES)
      issues.add(`${path}.signatureChecks`, 'INVALID', 'Dynamic entry count exceeds limit.')
    const entries = signatureEntries.map(([key, checked]) => {
      if (key.length > MAX_TENDERS_DYNAMIC_KEY_CHARS)
        issues.add(`${path}.signatureChecks.${key}`, 'INVALID', 'Dynamic key exceeds length limit.')
      return [
        key,
        booleanValue(checked, `${path}.signatureChecks.${key}`, issues) ?? false,
      ] as const
    })
    signatures = Object.fromEntries(entries)
  }
  const createdAt =
    stringValue(required(object, 'createdAt', path, issues), `${path}.createdAt`, issues) ?? ''
  if (!validRfc3339(createdAt))
    issues.add(`${path}.createdAt`, 'INVALID', 'Expected a valid RFC3339 timestamp.', createdAt)
  const nullableString = (key: string): string | null => {
    const item = required(object, key, path, issues)
    return item === null ? null : (stringValue(item, `${path}.${key}`, issues) ?? null)
  }
  const closingDate = nullableString('closingDate')
  if (closingDate !== null && parseClosingDate(closingDate) === null) {
    issues.add(
      `${path}.closingDate`,
      'INVALID',
      'Expected a supported closing date format.',
      closingDate,
    )
  }
  return {
    id: stringValue(required(object, 'id', path, issues), `${path}.id`, issues, true) ?? '',
    title: stringValue(required(object, 'title', path, issues), `${path}.title`, issues) ?? '',
    referenceNumber: nullableString('referenceNumber'),
    issuingBody: nullableString('issuingBody'),
    closingDate,
    submissionMethod: (required(object, 'submissionMethod', path, issues) === null
      ? null
      : enumValue(
          object.submissionMethod,
          `${path}.submissionMethod`,
          SUBMISSION_METHODS,
          issues,
        )) as TenderRecord['submissionMethod'],
    submissionAddress: nullableString('submissionAddress'),
    signatureChecks: signatures,
    status: (enumValue(
      required(object, 'status', path, issues),
      `${path}.status`,
      TENDER_STATUSES,
      issues,
    ) ?? 'IN_PROGRESS') as TenderRecord['status'],
    createdAt,
    fileName:
      stringValue(required(object, 'fileName', path, issues), `${path}.fileName`, issues) ?? '',
    fileUrl:
      stringValue(required(object, 'fileUrl', path, issues), `${path}.fileUrl`, issues) ?? '',
    numPages:
      nonnegativeInteger(required(object, 'numPages', path, issues), `${path}.numPages`, issues) ??
      0,
    ocrPages:
      nonnegativeInteger(required(object, 'ocrPages', path, issues), `${path}.ocrPages`, issues) ??
      0,
    requirements: requirements
      .map((item, index) => parseRequirement(item, `${path}.requirements.${index}`, issues))
      .filter((item): item is RequirementRecord => item !== undefined),
    ...(hasDefined(object, 'linkedCrmDealId')
      ? {
          linkedCrmDealId:
            object.linkedCrmDealId === null
              ? null
              : (stringValue(object.linkedCrmDealId, `${path}.linkedCrmDealId`, issues) ?? null),
        }
      : {}),
    ...(hasDefined(object, 'estimatedValue')
      ? {
          estimatedValue:
            object.estimatedValue === null
              ? null
              : (nonnegativeNumber(object.estimatedValue, `${path}.estimatedValue`, issues) ??
                null),
        }
      : {}),
    ...(hasDefined(object, 'pricingConfirmed')
      ? {
          pricingConfirmed:
            booleanValue(object.pricingConfirmed, `${path}.pricingConfirmed`, issues) ?? false,
        }
      : {}),
    ...(milestones === undefined
      ? {}
      : {
          milestones: milestones
            .map((item, index) => parseMilestone(item, `${path}.milestones.${index}`, issues))
            .filter((item): item is ContractMilestone => item !== undefined),
        }),
    ...(intakeVerification === undefined ? {} : { intakeVerification }),
    ...(hasDefined(object, 'dataOrigin')
      ? {
          // `enumValue` records INVALID and returns undefined for anything that
          // is not exactly 'demo', so 'user' cannot be asserted through this
          // field. The fallback keeps the label on the safe side: an
          // unrecognised value can never be read as user provenance.
          dataOrigin: (enumValue(
            object.dataOrigin,
            `${path}.dataOrigin`,
            TENDER_DATA_ORIGINS,
            issues,
          ) ?? 'demo') as TenderDataOrigin,
        }
      : {}),
    ...(submission === undefined ? {} : { submission }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(lifecycle === undefined
      ? {}
      : {
          lifecycle: lifecycle
            .map((item, index) => parseLifecycleEvent(item, `${path}.lifecycle.${index}`, issues))
            .filter((item): item is TenderLifecycleEvent => item !== undefined),
        }),
  }
}

function parseWorkspace(
  value: unknown,
  path: string,
  issues: Issues,
  v2: boolean,
): CompanyWorkspace | TendersWorkspaceV2 | undefined {
  const object = requiredStringObject(value, path, v2 ? WORKSPACE_V2 : WORKSPACE_V1, issues)
  if (!object) return undefined
  const customers =
    boundedArray(
      required(object, 'customers', path, issues),
      `${path}.customers`,
      issues,
      MAX_TENDERS_CUSTOMERS_PER_WORKSPACE,
    ) ?? []
  const vault =
    boundedArray(
      required(object, 'vault', path, issues),
      `${path}.vault`,
      issues,
      MAX_TENDERS_VAULT_DOCS_PER_WORKSPACE,
    ) ?? []
  const tenders =
    boundedArray(
      required(object, 'tenders', path, issues),
      `${path}.tenders`,
      issues,
      MAX_TENDERS_TENDERS_PER_WORKSPACE,
    ) ?? []
  return {
    id: stringValue(required(object, 'id', path, issues), `${path}.id`, issues, true) ?? '',
    ...(hasDefined(object, 'name')
      ? { name: stringValue(object.name, `${path}.name`, issues) }
      : {}),
    company:
      parseCompany(required(object, 'company', path, issues), `${path}.company`, issues) ??
      ({} as CompanyProfile),
    customers: customers
      .map((item, index) => parseCustomer(item, `${path}.customers.${index}`, issues))
      .filter((item): item is Customer => item !== undefined),
    vault: vault
      .map((item, index) => parseVault(item, `${path}.vault.${index}`, issues))
      .filter((item): item is VaultDoc => item !== undefined),
    tenders: tenders
      .map((item, index) => parseTender(item, `${path}.tenders.${index}`, issues))
      .filter((item): item is TenderRecord => item !== undefined),
    ...(v2
      ? {
          dataOrigin: (enumValue(
            required(object, 'dataOrigin', path, issues),
            `${path}.dataOrigin`,
            new Set(['user', 'demo']),
            issues,
          ) ?? 'user') as TendersWorkspaceV2['dataOrigin'],
        }
      : {}),
  }
}

function parseIssuer(value: unknown, path: string, issues: Issues): IssuerTemplate | undefined {
  const object = requiredStringObject(value, path, ISSUER, issues)
  if (!object) return undefined
  const nullable = (key: string): string | null => {
    const item = required(object, key, path, issues)
    return item === null ? null : (stringValue(item, `${path}.${key}`, issues) ?? null)
  }
  const lastSeen =
    stringValue(required(object, 'lastSeen', path, issues), `${path}.lastSeen`, issues) ?? ''
  if (!validRfc3339(lastSeen))
    issues.add(`${path}.lastSeen`, 'INVALID', 'Expected a valid RFC3339 timestamp.', lastSeen)
  return {
    id: stringValue(required(object, 'id', path, issues), `${path}.id`, issues, true) ?? '',
    name: stringValue(required(object, 'name', path, issues), `${path}.name`, issues) ?? '',
    displayName:
      stringValue(required(object, 'displayName', path, issues), `${path}.displayName`, issues) ??
      '',
    address: nullable('address'),
    contact: nullable('contact'),
    refStyle: nullable('refStyle'),
    submissionMethod: (required(object, 'submissionMethod', path, issues) === null
      ? null
      : enumValue(
          object.submissionMethod,
          `${path}.submissionMethod`,
          SUBMISSION_METHODS,
          issues,
        )) as IssuerTemplate['submissionMethod'],
    submissionAddress: nullable('submissionAddress'),
    seenCount:
      nonnegativeInteger(
        required(object, 'seenCount', path, issues),
        `${path}.seenCount`,
        issues,
      ) ?? 0,
    lastSeen,
  }
}

function unique(values: string[], path: string, issues: Issues): void {
  const seen = new Set<string>()
  values.forEach((value, index) => {
    if (seen.has(value)) issues.add(`${path}.${index}.id`, 'INVALID', 'Duplicate ID.')
    seen.add(value)
  })
}

function semanticChecks(data: TendersDataV2, issues: Issues): void {
  const workspaceIds = data.workspaces.map((workspace) => workspace.id)
  unique(workspaceIds, 'workspaces', issues)
  if (data.activeCompanyId !== null && !workspaceIds.includes(data.activeCompanyId))
    issues.add('activeCompanyId', 'INVALID', 'Active workspace does not exist.')
  if (data.activeCompanyId === null && data.workspaces.length > 0)
    issues.add('activeCompanyId', 'INVALID', 'Active workspace is required when workspaces exist.')
  data.workspaces.forEach((workspace, workspaceIndex) => {
    unique(
      workspace.customers.map((customer) => customer.id),
      `workspaces.${workspaceIndex}.customers`,
      issues,
    )
    unique(
      workspace.vault.map((document) => document.id),
      `workspaces.${workspaceIndex}.vault`,
      issues,
    )
    unique(
      workspace.company.projects.map((project) => project.id),
      `workspaces.${workspaceIndex}.company.projects`,
      issues,
    )
    const vaultIds = new Set(workspace.vault.map((document) => document.id))
    workspace.customers.forEach((customer, customerIndex) => {
      customer.requiredDocs.forEach((requiredDoc, requiredDocIndex) => {
        if (requiredDoc.linkedVaultDocId !== null && !vaultIds.has(requiredDoc.linkedVaultDocId)) {
          issues.add(
            `workspaces.${workspaceIndex}.customers.${customerIndex}.requiredDocs.${requiredDocIndex}.linkedVaultDocId`,
            'INVALID',
            'Referenced vault document is not in this workspace.',
          )
        }
      })
    })
    unique(
      workspace.tenders.map((tender) => tender.id),
      `workspaces.${workspaceIndex}.tenders`,
      issues,
    )
    const references = new Set<string>()
    workspace.tenders.forEach((tender, tenderIndex) => {
      const tenderPath = `workspaces.${workspaceIndex}.tenders.${tenderIndex}`
      if (tender.referenceNumber !== null) {
        if (references.has(tender.referenceNumber))
          issues.add(`${tenderPath}.referenceNumber`, 'INVALID', 'Duplicate tender reference.')
        references.add(tender.referenceNumber)
      }
      unique(
        tender.requirements.map((requirement) => requirement.id),
        `${tenderPath}.requirements`,
        issues,
      )
      if (tender.ocrPages > tender.numPages)
        issues.add(`${tenderPath}.ocrPages`, 'INVALID', 'OCR pages cannot exceed total pages.')
      if (tender.intakeVerification?.pages) {
        const seenPages = new Set<number>()
        tender.intakeVerification.pages.forEach((page, pageIndex) => {
          const pagePath = `${tenderPath}.intakeVerification.pages.${pageIndex}.pageNumber`
          if (page.pageNumber < 1 || page.pageNumber > tender.numPages)
            issues.add(
              pagePath,
              'INVALID',
              'Page extraction state must be within the tender page range.',
            )
          if (seenPages.has(page.pageNumber))
            issues.add(pagePath, 'INVALID', 'Duplicate page extraction state.')
          seenPages.add(page.pageNumber)
        })
      }
      if (tender.numPages === 0 && tender.requirements.length > 0)
        issues.add(
          `workspaces.${workspaceIndex}.tenders.${tenderIndex}.numPages`,
          'INVALID',
          'A zero-page tender cannot contain requirements.',
        )
      tender.requirements.forEach((requirement, requirementIndex) => {
        const requirementPath = `workspaces.${workspaceIndex}.tenders.${tenderIndex}.requirements.${requirementIndex}`
        if (requirement.pageNumber < 1 || requirement.pageNumber > tender.numPages)
          issues.add(
            `${requirementPath}.pageNumber`,
            'INVALID',
            'Requirement page must be within the tender page range.',
          )
        if (requirement.linkedVaultDocId !== null && !vaultIds.has(requirement.linkedVaultDocId))
          issues.add(
            `${requirementPath}.linkedVaultDocId`,
            'INVALID',
            'Referenced vault document is not in this workspace.',
          )
        requirement.suggestedVaultDocIds.forEach((id, suggestionIndex) => {
          if (!vaultIds.has(id))
            issues.add(
              `${requirementPath}.suggestedVaultDocIds.${suggestionIndex}`,
              'INVALID',
              'Suggested vault document is not in this workspace.',
            )
        })
        requirement.additionalClauses?.forEach((clause, clauseIndex) => {
          if (clause.pageNumber < 1 || clause.pageNumber > tender.numPages)
            issues.add(
              `${requirementPath}.additionalClauses.${clauseIndex}.pageNumber`,
              'INVALID',
              'Clause page must be within the tender page range.',
            )
        })
      })
      if (tender.milestones)
        unique(
          tender.milestones.map((milestone) => milestone.id),
          `workspaces.${workspaceIndex}.tenders.${tenderIndex}.milestones`,
          issues,
        )
    })
  })
  unique(
    data.issuerTemplates.map((issuer) => issuer.id),
    'issuerTemplates',
    issues,
  )
}

function failure(
  issues: Issues,
  code?: TendersSchemaIssueCode,
): TendersSchemaResult<TendersDataV2> {
  const finalCode =
    code ?? (issues.items[0]?.code as TendersSchemaIssueCode | undefined) ?? 'INVALID'
  const normalized = finalCode === 'MISSING' || finalCode === 'UNSUPPORTED' ? finalCode : 'INVALID'
  return {
    ok: false,
    error: {
      code: normalized,
      message: issues.items[0]?.message ?? 'Invalid Tenders data.',
      issues: issues.items,
    },
    issues: issues.items,
  }
}

function success(
  data: TendersDataV2,
  sourceVersion: 1 | 2,
  migrated: boolean,
  warnings: string[] = [],
): TendersSchemaResult<TendersDataV2> {
  return { ok: true, data, sourceVersion, migrated, warnings }
}

function parseV2(input: unknown, issues: Issues): TendersDataV2 | undefined {
  const object = objectAt(input, '', TOP_V2, issues)
  if (!object) return undefined
  const schemaVersion = finiteNumber(
    required(object, 'schemaVersion', '', issues),
    'schemaVersion',
    issues,
    true,
  )
  if (schemaVersion !== undefined && schemaVersion !== 2)
    issues.add('schemaVersion', 'UNSUPPORTED', 'Unsupported schema version.', schemaVersion)
  const revision = finiteNumber(required(object, 'revision', '', issues), 'revision', issues, true)
  if (revision !== undefined && (revision < 0 || !Number.isSafeInteger(revision)))
    issues.add('revision', 'INVALID', 'Revision must be a non-negative safe integer.', revision)
  const updatedAt = required(object, 'updatedAt', '', issues)
  if (!validRfc3339(updatedAt))
    issues.add('updatedAt', 'INVALID', 'Expected a valid RFC3339 timestamp.', updatedAt)
  const active = required(object, 'activeCompanyId', '', issues)
  if (active !== null) stringValue(active, 'activeCompanyId', issues)
  const workspaces =
    boundedArray(
      required(object, 'workspaces', '', issues),
      'workspaces',
      issues,
      MAX_TENDERS_WORKSPACES,
    ) ?? []
  const issuers =
    boundedArray(
      required(object, 'issuerTemplates', '', issues),
      'issuerTemplates',
      issues,
      MAX_TENDERS_ISSUER_TEMPLATES,
    ) ?? []
  const parsedWorkspaces = workspaces
    .map((item, index) => parseWorkspace(item, `workspaces.${index}`, issues, true))
    .filter((item): item is TendersWorkspaceV2 => item !== undefined)
  const data: TendersDataV2 = {
    schemaVersion: 2,
    revision: revision ?? 0,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
    activeCompanyId: active === null ? null : typeof active === 'string' ? active : null,
    workspaces: parsedWorkspaces,
    issuerTemplates: issuers
      .map((item, index) => parseIssuer(item, `issuerTemplates.${index}`, issues))
      .filter((item): item is IssuerTemplate => item !== undefined),
  }
  semanticChecks(data, issues)
  return data
}

function parseV1(
  input: unknown,
  issues: Issues,
  compatibilityTimestamp?: string,
): TendersDataV1 | undefined {
  const object = objectAt(input, '', TOP_V1, issues)
  if (!object) return undefined
  const version = finiteNumber(required(object, 'version', '', issues), 'version', issues, true)
  if (version !== undefined && version !== 1)
    issues.add('version', 'UNSUPPORTED', 'Unsupported schema version.', version)
  const rawUpdated = hasDefined(object, 'updatedAt') ? object.updatedAt : undefined
  let updatedAt: string | undefined
  if (validRfc3339(rawUpdated)) updatedAt = rawUpdated
  else if (compatibilityTimestamp !== undefined) updatedAt = compatibilityTimestamp
  else issues.add('updatedAt', 'INVALID', 'Expected a valid RFC3339 timestamp.', rawUpdated)
  const active = stringValue(
    required(object, 'activeCompanyId', '', issues),
    'activeCompanyId',
    issues,
  )
  const workspaces =
    arrayValue(required(object, 'workspaces', '', issues), 'workspaces', issues) ?? []
  const issuers =
    arrayValue(required(object, 'issuerTemplates', '', issues), 'issuerTemplates', issues) ?? []
  const parsedWorkspaces = workspaces
    .map((item, index) => parseWorkspace(item, `workspaces.${index}`, issues, false))
    .filter((item): item is TendersWorkspaceV2 => item !== undefined)
    .map(({ dataOrigin: _origin, ...workspace }) => workspace)
  const data: TendersDataV1 = {
    version: 1,
    updatedAt: updatedAt ?? '',
    activeCompanyId: active ?? '',
    workspaces: parsedWorkspaces,
    issuerTemplates: issuers
      .map((item, index) => parseIssuer(item, `issuerTemplates.${index}`, issues))
      .filter((item): item is IssuerTemplate => item !== undefined),
  }
  const ids = data.workspaces.map((workspace) => workspace.id)
  unique(ids, 'workspaces', issues)
  if (data.activeCompanyId && !ids.includes(data.activeCompanyId))
    issues.add('activeCompanyId', 'INVALID', 'Active workspace does not exist.')
  data.workspaces.forEach((workspace, workspaceIndex) => {
    unique(
      workspace.customers.map((customer) => customer.id),
      `workspaces.${workspaceIndex}.customers`,
      issues,
    )
    unique(
      workspace.vault.map((document) => document.id),
      `workspaces.${workspaceIndex}.vault`,
      issues,
    )
    unique(
      workspace.tenders.map((tender) => tender.id),
      `workspaces.${workspaceIndex}.tenders`,
      issues,
    )
    const refs = new Set<string>()
    workspace.tenders.forEach((tender, tenderIndex) => {
      if (tender.referenceNumber !== null) {
        if (refs.has(tender.referenceNumber))
          issues.add(
            `workspaces.${workspaceIndex}.tenders.${tenderIndex}.referenceNumber`,
            'INVALID',
            'Duplicate tender reference.',
          )
        refs.add(tender.referenceNumber)
      }
    })
  })
  unique(
    data.issuerTemplates.map((issuer) => issuer.id),
    'issuerTemplates',
    issues,
  )
  return data
}

function migratedAt(value: Date | string): string | undefined {
  if (value instanceof Date) return isNaN(value.getTime()) ? undefined : value.toISOString()
  return validRfc3339(value) ? value : undefined
}

// Complete historical-domain fingerprint. It is intentionally based on the full
// serialized v1 domain, never on IDs or a subset of fields.
function historicalDemoFingerprint(value: unknown): string | null {
  let serialized: string
  const canonicalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonicalize)
    if (record(candidate)) {
      return Object.fromEntries(
        Object.keys(candidate)
          .sort()
          .map((key) => [key, canonicalize(candidate[key])]),
      )
    }
    return candidate
  }
  try {
    serialized = JSON.stringify(canonicalize(value))
  } catch {
    return null
  }
  let hash = 14695981039346656037n
  for (const byte of new TextEncoder().encode(serialized)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 1099511628211n)
  }
  const fingerprint = hash.toString(16).padStart(16, '0')
  if (fingerprint !== HISTORICAL_DEMO_FINGERPRINT) return null
  return base64Encode(new TextEncoder().encode(serialized)) === HISTORICAL_DEMO_CANONICAL_BASE64
    ? fingerprint
    : null
}

const HISTORICAL_DEMO_FINGERPRINT = '007a251b7a2b1647'
const HISTORICAL_DEMO_CANONICAL_BASE64 =
  'eyJhY3RpdmVDb21wYW55SWQiOiJjby10aGFibyIsImlzc3VlclRlbXBsYXRlcyI6W10sInVwZGF0ZWRBdCI6IjIwMjYtMDgtMDFUMDg6MDA6MDAuMDAwWiIsInZlcnNpb24iOjEsIndvcmtzcGFjZXMiOlt7ImNvbXBhbnkiOnsiYWRkcmVzcyI6IjE0IERpZXNlbCBSb2FkLCBTZWJlbnphIEluZHVzdHJpYWwgUGFyaywgRWRlbnZhbGUsIEdhdXRlbmcgMTYxMCIsImJiYmVlQmxhY2tPd25lcnNoaXAiOiIxMDAlIiwiYmJiZWVMZXZlbCI6IkxldmVsIDEgKEVNRSkiLCJjc2RTdXBwbGllck51bWJlciI6Ik1BWkUtNDQ1MTkwMiIsImRlc2NyaXB0aW9uIjoiVGhhYm8gRW5naW5lZXJpbmcgKFB0eSkgTHRkIGlzIGEgMTAwJSBibGFjay1vd25lZCBTb3V0aCBBZnJpY2FuIGVuZ2luZWVyaW5nIGZpcm0gc3BlY2lhbGlzaW5nIGluIGNpdmlsIGluZnJhc3RydWN0dXJlLCBlbGVjdHJpY2FsIGluc3RhbGxhdGlvbiwgYW5kIHdhdGVyIHJldGljdWxhdGlvbiBwcm9qZWN0cy4gRm91bmRlZCBpbiAyMDE0LCB0aGUgY29tcGFueSBoYXMgZ3Jvd24gZnJvbSBhIHNtYWxsIHN1Yi1jb250cmFjdG9yIGludG8gYSByZWNvZ25pc2VkIHByaW1lIGNvbnRyYWN0b3IgZGVsaXZlcmluZyBnb3Zlcm5tZW50IGFuZCBwcml2YXRlLXNlY3RvciBwcm9qZWN0cyBhY3Jvc3MgR2F1dGVuZywgTGltcG9wbywgYW5kIHRoZSBOb3J0aCBXZXN0LiIsImRpcmVjdG9ycyI6W3siaWROdW1iZXIiOiI3ODAxMDE1MjYzMDgzIiwibmFtZSI6IlRoYWJvIE1va29lbmEiLCJyb2xlIjoiTWFuYWdpbmcgRGlyZWN0b3IifSx7ImlkTnVtYmVyIjoiODMwMjI0MDA5MTA4NSIsIm5hbWUiOiJMaW5kaXdlIE5haWRvbyIsInJvbGUiOiJGaW5hbmNlIERpcmVjdG9yIn0seyJpZE51bWJlciI6Ijc5MTIxNTUwMzcwODIiLCJuYW1lIjoiU2lidXNpc28gU2l0aG9sZSIsInJvbGUiOiJUZWNobmljYWwgRGlyZWN0b3IifV0sImVtYWlsIjoiaW5mb0B0aGFib2VuZ2luZWVyaW5nLmNvLnphIiwiZW1wbG95ZWVzIjoiNDIiLCJmb3VuZGVkIjoiMjAxNCIsImluZHVzdHJ5IjoiQ2l2aWwgJiBFbGVjdHJpY2FsIEVuZ2luZWVyaW5nIiwibmFtZSI6IlRoYWJvIEVuZ2luZWVyaW5nIChQdHkpIEx0ZCIsInBob25lIjoiKzI3IDExIDQ1MiA5OTAwIiwicHJvamVjdHMiOlt7ImNsaWVudCI6IkxldGhhYm8gSW5mcmFzdHJ1Y3R1cmUgKFB0eSkgTHRkIC8gU0FOUkFMIiwiZGVzY3JpcHRpb24iOiJGdWxsIHJvYWQgcmVoYWJpbGl0YXRpb24gb2YgMTIuNiBrbSBvZiBwcm92aW5jaWFsIHJvYWQgaW5jbHVkaW5nIHN0b3Jtd2F0ZXIgdXBncmFkZXMsIGd1YXJkcmFpbHMsIGFuZCBsaW5lIG1hcmtpbmcuIFByb2plY3QgZGVsaXZlcmVkIG9uLXRpbWUgYW5kIHdpdGhpbiBidWRnZXQuIiwiaWQiOiJwLTEiLCJwZXJpb2QiOiIyMDIz4oCTMjAyNCIsInNlY3RvciI6IkNpdmlsIiwic3RhdHVzIjoiQ09NUExFVEVEIiwidGl0bGUiOiJWYWFsIFJpdmVyIFJvYWQgUmVoYWJpbGl0YXRpb24g4oCUIFBoYXNlIDIiLCJ2YWx1ZSI6IlIgMTguNCBtaWxsaW9uIn0seyJjbGllbnQiOiJFa3VyaHVsZW5pIE1ldHJvIE11bmljaXBhbGl0eSIsImRlc2NyaXB0aW9uIjoiUmVwbGFjZW1lbnQgb2YgYWdlaW5nIE1WL0xWIGRpc3RyaWJ1dGlvbiBuZXR3b3JrIGFjcm9zcyBab25lIDQgcmVzaWRlbnRpYWwgYXJlYS4gSW5zdGFsbGVkIDM4IG5ldyBtaW5pLXN1YnN0YXRpb25zIGFuZCAxNCBrbSBvZiB1bmRlcmdyb3VuZCBjYWJsaW5nLiIsImlkIjoicC0yIiwicGVyaW9kIjoiMjAyNOKAkzIwMjUiLCJzZWN0b3IiOiJFbGVjdHJpY2FsIiwic3RhdHVzIjoiQ09NUExFVEVEIiwidGl0bGUiOiJFa3VyaHVsZW5pIFpvbmUgNCBFbGVjdHJpY2FsIEluZnJhc3RydWN0dXJlIFVwZ3JhZGUiLCJ2YWx1ZSI6IlIgNi43IG1pbGxpb24ifSx7ImNsaWVudCI6IkRlcGFydG1lbnQgb2YgV2F0ZXIgYW5kIFNhbml0YXRpb24iLCJkZXNjcmlwdGlvbiI6IkRlc2lnbiBhbmQgY29uc3RydWN0aW9uIG9mIGJ1bGsgd2F0ZXIgc3VwcGx5IGluZnJhc3RydWN0dXJlIHNlcnZpbmcgNCAyMDAgaG91c2Vob2xkcyBpbiB0aGUgU2VraHVraHVuZSBEaXN0cmljdC4gQ3VycmVudGx5IGF0IDY4JSBjb21wbGV0aW9uLiIsImlkIjoicC0zIiwicGVyaW9kIjoiMjAyNOKAkzIwMjYiLCJzZWN0b3IiOiJXYXRlciIsInN0YXR1cyI6IklOX1BST0dSRVNTIiwidGl0bGUiOiJTZWtodWtodW5lIFdhdGVyIFJldGljdWxhdGlvbiBQcm9qZWN0IiwidmFsdWUiOiJSIDI0LjEgbWlsbGlvbiJ9LHsiY2xpZW50IjoiRWt1cmh1bGVuaSBNZXRybyBNdW5pY2lwYWxpdHkiLCJkZXNjcmlwdGlvbiI6Ik5ldyBhY2Nlc3Mgcm9hZCwgcGVyaW1ldGVyIGZlbmNpbmcsIGFuZCAxMjAtYmF5IHBhcmtpbmcgZmFjaWxpdHkgZm9yIHRoZSBUZW1iaXNhIENvbW11bml0eSBIZWFsdGggQ2VudHJlLiIsImlkIjoicC00IiwicGVyaW9kIjoiMjAyMuKAkzIwMjMiLCJzZWN0b3IiOiJDaXZpbCIsInN0YXR1cyI6IkNPTVBMRVRFRCIsInRpdGxlIjoiVGVtYmlzYSBDbGluaWMgQWNjZXNzIFJvYWQgYW5kIFBhcmtpbmciLCJ2YWx1ZSI6IlIgMy4yIG1pbGxpb24ifSx7ImNsaWVudCI6IkVza29tIEhvbGRpbmdzIFNPQyBMdGQiLCJkZXNjcmlwdGlvbiI6IkFubnVhbCBtYWludGVuYW5jZSBjb250cmFjdCBmb3IgMjIwIGttIG9mIDEzMiBrViB0cmFuc21pc3Npb24gbGluZSBpbmNsdWRpbmcgdG93ZXIgaW5zcGVjdGlvbnMsIHN0cmluZ2luZyByZXBhaXJzLCBhbmQgdmVnZXRhdGlvbiBjbGVhcmluZy4iLCJpZCI6InAtNSIsInBlcmlvZCI6IjIwMjHigJMyMDIzIiwic2VjdG9yIjoiRWxlY3RyaWNhbCIsInN0YXR1cyI6IkNPTVBMRVRFRCIsInRpdGxlIjoiRXNrb20gU3ViLXRyYW5zbWlzc2lvbiBMaW5lIE1haW50ZW5hbmNlIOKAlCBMaW1wb3BvIEVhc3QiLCJ2YWx1ZSI6IlIgOS44IG1pbGxpb24ifSx7ImNsaWVudCI6IkRlcGFydG1lbnQgb2YgV2F0ZXIgYW5kIFNhbml0YXRpb24iLCJkZXNjcmlwdGlvbiI6IlRlbmRlciBjdXJyZW50bHkgaW4gcHJlcGFyYXRpb24uIFNjb3BlIGluY2x1ZGVzIGJ1bGsgcmF3IHdhdGVyIHBpcGVsaW5lICg0MiBrbSksIHB1bXAgc3RhdGlvbiwgYW5kIHRlbGVtZXRyeSBzeXN0ZW0gZm9yIHRoZSBPbGlmYW50cyBSaXZlciBzeXN0ZW0uIiwiaWQiOiJwLTYiLCJwZXJpb2QiOiIyMDI24oCTIiwic2VjdG9yIjoiV2F0ZXIiLCJzdGF0dXMiOiJCSURESU5HIiwidGl0bGUiOiJEV1MvUkZQLTIwMjYvMDAzNCDigJQgT2xpZmFudHMgUml2ZXIgQnVsayBXYXRlciIsInZhbHVlIjoiVEJEIChiaWQgaW4gcHJlcGFyYXRpb24pIn1dLCJyZWdpc3RyYXRpb25OdW1iZXIiOiJDSzIwMTQvMTIzNDU2Ny8wNyIsInRheFBpbiI6IkNJVFgtMjAyNi04ODQtMDE5MiIsInRyYWRpbmdOYW1lIjoiVGhhYm8gRW5naW5lZXJpbmciLCJ2YXROdW1iZXIiOiI0MjIwMTg5MDM0Iiwid2Vic2l0ZSI6Ind3dy50aGFib2VuZ2luZWVyaW5nLmNvLnphIn0sImN1c3RvbWVycyI6W3siY29udGFjdEVtYWlsIjoiZGluZW9AbGV0aGFiby1pbmZyYS5jby56YSIsImNvbnRhY3ROYW1lIjoiRGluZW8gTGV0aGFibyIsImNvbnRhY3RQaG9uZSI6IisyNyAxMSA4MzQgMDAxMiIsImlkIjoiYy0xIiwiaW5kdXN0cnkiOiJDaXZpbCBFbmdpbmVlcmluZyIsIm5hbWUiOiJMZXRoYWJvIEluZnJhc3RydWN0dXJlIChQdHkpIEx0ZCIsIm5vdGVzIjoiTWFpbiBjb250cmFjdG9yIG9uIHRoZSBWYWFsIFJpdmVyIHJvYWQgcmVoYWJpbGl0YXRpb24gcHJvamVjdC4gUmVxdWlyZXMgYW5udWFsIGNvbXBsaWFuY2UgcGFjayByZW5ld2FsIGVhY2ggTWFyY2guIiwicmVxdWlyZWREb2NzIjpbeyJkb2NDYXRlZ29yeSI6IkNPTVBMSUFOQ0UiLCJmdWxmaWxsZWQiOnRydWUsImxhYmVsIjoiU0FSUyBUYXggQ2xlYXJhbmNlIChUQ1MgUElOKSIsImxpbmtlZFZhdWx0RG9jSWQiOiJ2ZC10YXgifSx7ImRvY0NhdGVnb3J5IjoiQ09NUExJQU5DRSIsImZ1bGZpbGxlZCI6ZmFsc2UsImxhYmVsIjoiQ09JREEgTGV0dGVyIG9mIEdvb2QgU3RhbmRpbmciLCJsaW5rZWRWYXVsdERvY0lkIjoidmQtY29pZGEifSx7ImRvY0NhdGVnb3J5IjoiQ09NUExJQU5DRSIsImZ1bGZpbGxlZCI6dHJ1ZSwibGFiZWwiOiJCLUJCRUUgQWZmaWRhdml0IC8gQ2VydGlmaWNhdGUiLCJsaW5rZWRWYXVsdERvY0lkIjoidmQtYmJiZWUifSx7ImRvY0NhdGVnb3J5IjoiR09WRVJOQU5DRSIsImZ1bGZpbGxlZCI6dHJ1ZSwibGFiZWwiOiJDSVBDIENlcnRpZmljYXRlIG9mIEluY29ycG9yYXRpb24iLCJsaW5rZWRWYXVsdERvY0lkIjoidmQtY2lwYyJ9LHsiZG9jQ2F0ZWdvcnkiOiJDT01QTElBTkNFIiwiZnVsZmlsbGVkIjp0cnVlLCJsYWJlbCI6IkNlcnRpZmllZCBEaXJlY3RvciBJRCBDb3BpZXMiLCJsaW5rZWRWYXVsdERvY0lkIjoidmQtZGlyZWN0b3JzIn1dLCJzaW5jZSI6IjIwMjMtMDMtMTAiLCJzdGF0dXMiOiJBQ1RJVkUifSx7ImNvbnRhY3RFbWFpbCI6InByb2N1cmVtZW50QGR3cy5nb3YuemEiLCJjb250YWN0TmFtZSI6IlNpcGhvIE5rb3NpIiwiY29udGFjdFBob25lIjoiKzI3IDEyIDMzNiA3NTAwIiwiaWQiOiJjLTIiLCJpbmR1c3RyeSI6IkdvdmVybm1lbnQiLCJuYW1lIjoiRGVwYXJ0bWVudCBvZiBXYXRlciBhbmQgU2FuaXRhdGlvbiIsIm5vdGVzIjoiTmF0aW9uYWwgZ292ZXJubWVudCBjbGllbnQuIFN0cmljdCBTQ00gY29tcGxpYW5jZSByZXF1aXJlZC4gQW5udWFsIENTRCB2ZXJpZmljYXRpb24gbWFuZGF0b3J5LiIsInJlcXVpcmVkRG9jcyI6W3siZG9jQ2F0ZWdvcnkiOiJDT01QTElBTkNFIiwiZnVsZmlsbGVkIjp0cnVlLCJsYWJlbCI6IlNBUlMgVGF4IENsZWFyYW5jZSAoVENTIFBJTikiLCJsaW5rZWRWYXVsdERvY0lkIjoidmQtdGF4In0seyJkb2NDYXRlZ29yeSI6IkNPTVBMSUFOQ0UiLCJmdWxmaWxsZWQiOmZhbHNlLCJsYWJlbCI6IkNPSURBIExldHRlciBvZiBHb29kIFN0YW5kaW5nIiwibGlua2VkVmF1bHREb2NJZCI6InZkLWNvaWRhIn0seyJkb2NDYXRlZ29yeSI6IkNPTVBMSUFOQ0UiLCJmdWxmaWxsZWQiOnRydWUsImxhYmVsIjoiQi1CQkVFIEFmZmlkYXZpdCAvIENlcnRpZmljYXRlIiwibGlua2VkVmF1bHREb2NJZCI6InZkLWJiYmVlIn0seyJkb2NDYXRlZ29yeSI6IkdPVkVSTkFOQ0UiLCJmdWxmaWxsZWQiOnRydWUsImxhYmVsIjoiQ0lQQyBDZXJ0aWZpY2F0ZSBvZiBJbmNvcnBvcmF0aW9uIiwibGlua2VkVmF1bHREb2NJZCI6InZkLWNpcGMifSx7ImRvY0NhdGVnb3J5IjoiQ09NUExJQU5DRSIsImZ1bGZpbGxlZCI6dHJ1ZSwibGFiZWwiOiJDU0QgU3VwcGxpZXIgUmVnaXN0cmF0aW9uIiwibGlua2VkVmF1bHREb2NJZCI6InZkLWNzZCJ9LHsiZG9jQ2F0ZWdvcnkiOiJHT1ZFUk5BTkNFIiwiZnVsZmlsbGVkIjp0cnVlLCJsYWJlbCI6IlNCRCA0IFByZWZlcmVuY2UgUG9pbnRzIEZvcm0iLCJsaW5rZWRWYXVsdERvY0lkIjoidmQtc2JkIn1dLCJzaW5jZSI6IjIwMjQtMDEtMjIiLCJzdGF0dXMiOiJBQ1RJVkUifSx7ImNvbnRhY3RFbWFpbCI6InNjbUBla3VyaHVsZW5pLmdvdi56YSIsImNvbnRhY3ROYW1lIjoiWmFuZWxlIE1va2hlc2kiLCJjb250YWN0UGhvbmUiOiIrMjcgMTEgOTk5IDAwMDAiLCJpZCI6ImMtMyIsImluZHVzdHJ5IjoiTG9jYWwgR292ZXJubWVudCIsIm5hbWUiOiJFa3VyaHVsZW5pIE1ldHJvIE11bmljaXBhbGl0eSIsIm5vdGVzIjoiRWxlY3RyaWNhbCBpbmZyYXN0cnVjdHVyZSB1cGdyYWRlIHByb2dyYW1tZS4gUmVxdWlyZXMgcHJvb2Ygb2YgcHJvZmVzc2lvbmFsIGluZGVtbml0eSBpbnN1cmFuY2UuIiwicmVxdWlyZWREb2NzIjpbeyJkb2NDYXRlZ29yeSI6IkNPTVBMSUFOQ0UiLCJmdWxmaWxsZWQiOnRydWUsImxhYmVsIjoiU0FSUyBUYXggQ2xlYXJhbmNlIChUQ1MgUElOKSIsImxpbmtlZFZhdWx0RG9jSWQiOiJ2ZC10YXgifSx7ImRvY0NhdGVnb3J5IjoiQ09NUExJQU5DRSIsImZ1bGZpbGxlZCI6ZmFsc2UsImxhYmVsIjoiQ09JREEgTGV0dGVyIG9mIEdvb2QgU3RhbmRpbmciLCJsaW5rZWRWYXVsdERvY0lkIjoidmQtY29pZGEifSx7ImRvY0NhdGVnb3J5IjoiQ09NUExJQU5DRSIsImZ1bGZpbGxlZCI6dHJ1ZSwibGFiZWwiOiJCLUJCRUUgQWZmaWRhdml0IC8gQ2VydGlmaWNhdGUiLCJsaW5rZWRWYXVsdERvY0lkIjoidmQtYmJiZWUifSx7ImRvY0NhdGVnb3J5IjoiR09WRVJOQU5DRSIsImZ1bGZpbGxlZCI6dHJ1ZSwibGFiZWwiOiJDSVBDIENlcnRpZmljYXRlIG9mIEluY29ycG9yYXRpb24iLCJsaW5rZWRWYXVsdERvY0lkIjoidmQtY2lwYyJ9LHsiZG9jQ2F0ZWdvcnkiOiJDT01QTElBTkNFIiwiZnVsZmlsbGVkIjp0cnVlLCJsYWJlbCI6IkNlcnRpZmllZCBEaXJlY3RvciBJRCBDb3BpZXMiLCJsaW5rZWRWYXVsdERvY0lkIjoidmQtZGlyZWN0b3JzIn0seyJkb2NDYXRlZ29yeSI6IkZJTkFOQ0lBTCIsImZ1bGZpbGxlZCI6ZmFsc2UsImxhYmVsIjoiUHJvZmVzc2lvbmFsIEluZGVtbml0eSBJbnN1cmFuY2UiLCJsaW5rZWRWYXVsdERvY0lkIjpudWxsfV0sInNpbmNlIjoiMjAyNC0wNi0wMSIsInN0YXR1cyI6IkFDVElWRSJ9LHsiY29udGFjdEVtYWlsIjoidmVuZG9yQHRyYW5zbmV0Lm5ldCIsImNvbnRhY3ROYW1lIjoiTHVuZ2VsbyBEbGFtaW5pIiwiY29udGFjdFBob25lIjoiKzI3IDExIDMwOCAzMDAwIiwiaWQiOiJjLTQiLCJpbmR1c3RyeSI6IlN0YXRlLU93bmVkIEVudGl0eSIsIm5hbWUiOiJUcmFuc25ldCBTT0MgTHRkIiwibm90ZXMiOiJQb3RlbnRpYWwgY29udHJhY3QgZm9yIHBvcnQgZXF1aXBtZW50IG1haW50ZW5hbmNlLiBWZW5kb3IgcmVnaXN0cmF0aW9uIG5vdCB5ZXQgc3VibWl0dGVkLiIsInJlcXVpcmVkRG9jcyI6W3siZG9jQ2F0ZWdvcnkiOiJDT01QTElBTkNFIiwiZnVsZmlsbGVkIjp0cnVlLCJsYWJlbCI6IlNBUlMgVGF4IENsZWFyYW5jZSAoVENTIFBJTikiLCJsaW5rZWRWYXVsdERvY0lkIjoidmQtdGF4In0seyJkb2NDYXRlZ29yeSI6IkNPTVBMSUFOQ0UiLCJmdWxmaWxsZWQiOmZhbHNlLCJsYWJlbCI6IkNPSURBIExldHRlciBvZiBHb29kIFN0YW5kaW5nIiwibGlua2VkVmF1bHREb2NJZCI6InZkLWNvaWRhIn0seyJkb2NDYXRlZ29yeSI6IkNPTVBMSUFOQ0UiLCJmdWxmaWxsZWQiOnRydWUsImxhYmVsIjoiQi1CQkVFIEFmZmlkYXZpdCAvIENlcnRpZmljYXRlIiwibGlua2VkVmF1bHREb2NJZCI6InZkLWJiYmVlIn0seyJkb2NDYXRlZ29yeSI6IkdPVkVSTkFOQ0UiLCJmdWxmaWxsZWQiOnRydWUsImxhYmVsIjoiQ0lQQyBDZXJ0aWZpY2F0ZSBvZiBJbmNvcnBvcmF0aW9uIiwibGlua2VkVmF1bHREb2NJZCI6InZkLWNpcGMifV0sInNpbmNlIjoiMjAyNS0wMi0xNCIsInN0YXR1cyI6IlBST1NQRUNUIn0seyJjb250YWN0RW1haWwiOiJzdXBwbGllckBlc2tvbS5jby56YSIsImNvbnRhY3ROYW1lIjoiUmVmaWx3ZSBUYXUiLCJjb250YWN0UGhvbmUiOiIrMjcgMTEgODAwIDgxMTEiLCJpZCI6ImMtNSIsImluZHVzdHJ5IjoiU3RhdGUtT3duZWQgRW50aXR5IiwibmFtZSI6IkVza29tIEhvbGRpbmdzIFNPQyBMdGQiLCJub3RlcyI6IlByZXZpb3VzIGVsZWN0cmljYWwgc3ViY29udHJhY3Rpbmcgd29yay4gQ29udHJhY3QgZW5kZWQgMjAyMy4gS2VlcCBvbiByZWNvcmQgZm9yIHJlLWVuZ2FnZW1lbnQuIiwicmVxdWlyZWREb2NzIjpbeyJkb2NDYXRlZ29yeSI6IkNPTVBMSUFOQ0UiLCJmdWxmaWxsZWQiOnRydWUsImxhYmVsIjoiU0FSUyBUYXggQ2xlYXJhbmNlIChUQ1MgUElOKSIsImxpbmtlZFZhdWx0RG9jSWQiOiJ2ZC10YXgifSx7ImRvY0NhdGVnb3J5IjoiQ09NUExJQU5DRSIsImZ1bGZpbGxlZCI6dHJ1ZSwibGFiZWwiOiJCLUJCRUUgQWZmaWRhdml0IC8gQ2VydGlmaWNhdGUiLCJsaW5rZWRWYXVsdERvY0lkIjoidmQtYmJiZWUifSx7ImRvY0NhdGVnb3J5IjoiR09WRVJOQU5DRSIsImZ1bGZpbGxlZCI6dHJ1ZSwibGFiZWwiOiJDSVBDIENlcnRpZmljYXRlIG9mIEluY29ycG9yYXRpb24iLCJsaW5rZWRWYXVsdERvY0lkIjoidmQtY2lwYyJ9XSwic2luY2UiOiIyMDIxLTA5LTA1Iiwic3RhdHVzIjoiSU5BQ1RJVkUifV0sImlkIjoiY28tdGhhYm8iLCJuYW1lIjoiVGhhYm8gRW5naW5lZXJpbmcgKFB0eSkgTHRkIiwidGVuZGVycyI6W3siY2xvc2luZ0RhdGUiOiIyMDI2LTEwLTMxIiwiY3JlYXRlZEF0IjoiMjAyNi0wOC0wMVQwODowMDowMFoiLCJlc3RpbWF0ZWRWYWx1ZSI6MjQzMDAwLCJmaWxlTmFtZSI6IlJGUC1XVFItMjAyNi0wNC5wZGYiLCJmaWxlVXJsIjoiIiwiaWQiOiJ0ZW5kZXItd3RyLTA0IiwiaXNzdWluZ0JvZHkiOiJDaXR5IG9mIEVrdXJodWxlbmkgV2F0ZXIgRGVwdCIsIm1pbGVzdG9uZXMiOlt7ImFtb3VudCI6MTQ1MDAwLCJjb21wbGV0ZWREYXRlIjoiMjAyNi0wOC0yOCIsImRlc2NyaXB0aW9uIjoiQ29tcGxldGUgb3ZlcmhhdWwgb2YgaGlnaC1wcmVzc3VyZSBjb250cm9sIHZhbHZlcyBwZXIgdGVuZGVyIHNwZWNpZmljYXRpb24iLCJkdWVEYXRlIjoiMjAyNi0wOC0zMCIsImlkIjoibXMtMDEiLCJuYW1lIjoiUGhhc2UgMSBSZXNlcnZvaXIgVmFsdmUgUmVmdXJiaXNobWVudCIsInN0YXR1cyI6IlJFQUNIRUQiLCJ0aXRsZSI6IlBoYXNlIDEgUmVzZXJ2b2lyIFZhbHZlIFJlZnVyYmlzaG1lbnQifSx7ImFtb3VudCI6OTgwMDAsImRlc2NyaXB0aW9uIjoiSW5zdGFsbCBhbmQgY2FsaWJyYXRlIGRpZ2l0YWwgZmxvdyBzZW5zb3JzIGFjcm9zcyBtZXRlcmluZyBwb2ludHMiLCJkdWVEYXRlIjoiMjAyNi0xMS0xNSIsImlkIjoibXMtMDIiLCJuYW1lIjoiUGhhc2UgMiBVbHRyYXNvbmljIEZsb3cgTWV0ZXIgSW5zdGFsbGF0aW9uIiwic3RhdHVzIjoiUEVORElORyIsInRpdGxlIjoiUGhhc2UgMiBVbHRyYXNvbmljIEZsb3cgTWV0ZXIgSW5zdGFsbGF0aW9uIn1dLCJudW1QYWdlcyI6MjQsIm9jclBhZ2VzIjowLCJyZWZlcmVuY2VOdW1iZXIiOiJSRlAtV1RSLTIwMjYtMDQiLCJyZXF1aXJlbWVudHMiOltdLCJzaWduYXR1cmVDaGVja3MiOnt9LCJzdGF0dXMiOiJJTl9QUk9HUkVTUyIsInN1Ym1pc3Npb25BZGRyZXNzIjoiQ2l2aWMgQ2VudHJlLCBLZW1wdG9uIFBhcmssIEVrdXJodWxlbmkiLCJzdWJtaXNzaW9uTWV0aG9kIjoiUEhZU0lDQUwiLCJ0aXRsZSI6IkJ1bGsgV2F0ZXIgTWV0ZXJpbmcgJiBWYWx2ZSBSZWZ1cmJpc2htZW50In1dLCJ2YXVsdCI6W3siY2F0ZWdvcnkiOiJDT01QTElBTkNFIiwiY2VydGlmaWVkRGF0ZSI6bnVsbCwiZXhwaXJ5RGF0ZSI6IjIwMjctMDctMTIiLCJmaWxlVXJsIjoiL2RlbW8vdmF1bHQvdGF4LWNsZWFyYW5jZS5wZGYiLCJpZCI6InZkLXRheCIsImlzQ2VydGlmaWVkIjpmYWxzZSwiaXNzdWVEYXRlIjoiMjAyNi0wNy0xMiIsIm1ldGFkYXRhIjp7IlN0YXR1cyI6IkFjdGl2ZSDigJQgY29tcGxpYW50IiwiVENTIFBJTiI6IkNJVFgtMjAyNi04ODQtMDE5MiJ9LCJ0aXRsZSI6IlNBUlMgVGF4IENsZWFyYW5jZSBDZXJ0aWZpY2F0ZSAoVENTIFBJTikifSx7ImNhdGVnb3J5IjoiQ09NUExJQU5DRSIsImNlcnRpZmllZERhdGUiOm51bGwsImV4cGlyeURhdGUiOiIyMDI2LTA3LTA0IiwiZmlsZVVybCI6Ii9kZW1vL3ZhdWx0L2NvaWRhLWdvb2Qtc3RhbmRpbmcucGRmIiwiaWQiOiJ2ZC1jb2lkYSIsImlzQ2VydGlmaWVkIjpmYWxzZSwiaXNzdWVEYXRlIjoiMjAyNS0wNy0wNSIsIm1ldGFkYXRhIjp7IkNvbXBlbnNhdGlvbiBGdW5kIHJlZiI6IkNGLTc3MTkwMiIsIlN0YXR1cyI6IkVYUElSRUQifSwidGl0bGUiOiJDT0lEQSBMZXR0ZXIgb2YgR29vZCBTdGFuZGluZyJ9LHsiY2F0ZWdvcnkiOiJDT01QTElBTkNFIiwiY2VydGlmaWVkRGF0ZSI6IjIwMjYtMDQtMTAiLCJleHBpcnlEYXRlIjoiMjAyNy0wNC0wOSIsImZpbGVVcmwiOiIvZGVtby92YXVsdC9iYmJlZS1hZmZpZGF2aXQucGRmIiwiaWQiOiJ2ZC1iYmJlZSIsImlzQ2VydGlmaWVkIjp0cnVlLCJpc3N1ZURhdGUiOiIyMDI2LTA0LTEwIiwibWV0YWRhdGEiOnsiQmxhY2sgb3duZXJzaGlwIjoiMTAwJSIsIkxldmVsIjoiTGV2ZWwgMSAoRU1FKSJ9LCJ0aXRsZSI6IkItQkJFRSBTd29ybiBBZmZpZGF2aXQgKEVNRSkifSx7ImNhdGVnb3J5IjoiR09WRVJOQU5DRSIsImNlcnRpZmllZERhdGUiOm51bGwsImV4cGlyeURhdGUiOm51bGwsImZpbGVVcmwiOiIvZGVtby92YXVsdC9jaXBjLXJlZ2lzdHJhdGlvbi5wZGYiLCJpZCI6InZkLWNpcGMiLCJpc0NlcnRpZmllZCI6ZmFsc2UsImlzc3VlRGF0ZSI6IjIwMTQtMDMtMjAiLCJtZXRhZGF0YSI6eyJSZWdpc3RyYXRpb24gbnVtYmVyIjoiQ0syMDE0LzEyMzQ1NjcvMDciLCJTdGF0dXMiOiJJbiBidXNpbmVzcyJ9LCJ0aXRsZSI6IkNJUEMgQ2VydGlmaWNhdGUgb2YgSW5jb3Jwb3JhdGlvbiJ9LHsiY2F0ZWdvcnkiOiJDT01QTElBTkNFIiwiY2VydGlmaWVkRGF0ZSI6IjIwMjYtMDgtMTgiLCJleHBpcnlEYXRlIjpudWxsLCJmaWxlVXJsIjoiL2RlbW8vdmF1bHQvZGlyZWN0b3ItaWRzLnBkZiIsImlkIjoidmQtZGlyZWN0b3JzIiwiaXNDZXJ0aWZpZWQiOnRydWUsImlzc3VlRGF0ZSI6bnVsbCwibWV0YWRhdGEiOnsiQ2VydGlmaWVkIGJ5IjoiU0EgUG9saWNlIFNlcnZpY2VzIiwiRGlyZWN0b3JzIjoiVC4gTW9rb2VuYSwgTC4gTmFpZG9vLCBTLiBTaXRob2xlIn0sInRpdGxlIjoiQ2VydGlmaWVkIElEIENvcGllcyDigJQgRGlyZWN0b3JzIn0seyJjYXRlZ29yeSI6IkdPVkVSTkFOQ0UiLCJjZXJ0aWZpZWREYXRlIjpudWxsLCJleHBpcnlEYXRlIjpudWxsLCJmaWxlVXJsIjpudWxsLCJpZCI6InZkLXNiZCIsImlzQ2VydGlmaWVkIjpmYWxzZSwiaXNzdWVEYXRlIjpudWxsLCJtZXRhZGF0YSI6eyJTdGF0dXMiOiJTaWduZWQsIG9uIGZpbGUifSwidGl0bGUiOiJDb21wbGV0ZWQgU0JEIDQgUmV0dXJuYWJsZSBGb3JtIn0seyJjYXRlZ29yeSI6IkNPTVBMSUFOQ0UiLCJjZXJ0aWZpZWREYXRlIjpudWxsLCJleHBpcnlEYXRlIjpudWxsLCJmaWxlVXJsIjpudWxsLCJpZCI6InZkLWNzZCIsImlzQ2VydGlmaWVkIjpmYWxzZSwiaXNzdWVEYXRlIjoiMjAyNi0wMS0xNSIsIm1ldGFkYXRhIjp7IlN0YXR1cyI6IkFjdGl2ZSIsIlN1cHBsaWVyIG51bWJlciI6Ik1BWkUtNDQ1MTkwMiJ9LCJ0aXRsZSI6IkNTRCBSZWdpc3RyYXRpb24gUmVwb3J0In1dfV19'

function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function boundedArray(
  value: unknown,
  path: string,
  issues: Issues,
  limit: number,
): unknown[] | undefined {
  const array = arrayValue(value, path, issues)
  if (array && array.length > limit)
    issues.add(path, 'INVALID', `Collection exceeds limit of ${limit}.`)
  return array
}

/**
 * Counts string content the way JSON serialization would, without rejecting an
 * acyclic but shared object graph (a reused sub-object is serialized once per
 * occurrence). Only a true cycle — a reference to an ancestor on the current
 * recursion path — is fatal. Subtree sizes are memoized per object so the walk
 * stays linear; a cyclic subtree yields a value above the aggregate bound.
 */
function aggregateStrings(value: unknown): number {
  const overflow = MAX_TENDERS_AGGREGATE_STRING_CHARS + 1
  const memo = new Map<object, number>()
  const ancestors = new Set<object>()

  const visit = (node: unknown): number => {
    if (typeof node === 'string') return node.length
    if (!node || typeof node !== 'object') return 0
    if (ancestors.has(node)) return overflow
    const cached = memo.get(node)
    if (cached !== undefined) return cached

    ancestors.add(node)
    let total = 0
    const children: unknown[] = Array.isArray(node) ? node : Object.values(node as UnknownRecord)
    for (const child of children) {
      total += visit(child)
      if (total > overflow) {
        total = overflow
        break
      }
    }
    ancestors.delete(node)
    memo.set(node, total)
    return total
  }

  return visit(value)
}

function normalizedLegacyPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

function legacyVaultCandidates(vault: VaultDoc[], reference: string): VaultDoc[] {
  const normalizedReference = normalizedLegacyPath(reference)
  const referenceBase = normalizedReference.split('/').pop() ?? normalizedReference
  const referenceStem = referenceBase.replace(/\.[^.]+$/, '')
  return vault.filter((document) => {
    if (typeof document.fileUrl !== 'string') return false
    const path = normalizedLegacyPath(document.fileUrl)
    const base = path.split('/').pop() ?? path
    const stem = base.replace(/\.[^.]+$/, '')
    return path === normalizedReference || base === referenceBase || stem === referenceStem
  })
}

function rewriteLegacyVaultReferences(
  data: TendersDataV2,
  issues: Issues,
  warnings: string[],
): void {
  data.workspaces.forEach((workspace, workspaceIndex) => {
    const rewrite = (reference: string, path: string): string => {
      if (workspace.vault.some((document) => document.id === reference)) return reference
      const candidates = legacyVaultCandidates(workspace.vault, reference)
      if (candidates.length !== 1) {
        issues.add(
          path,
          'INVALID',
          candidates.length === 0
            ? 'Legacy vault reference is unmatched.'
            : 'Legacy vault reference is ambiguous.',
          reference,
        )
        return reference
      }
      const canonicalId = candidates[0].id
      warnings.push(`LEGACY_VAULT_REFERENCE_REWRITTEN ${path}: ${reference} -> ${canonicalId}`)
      return canonicalId
    }
    workspace.customers.forEach((customer, customerIndex) => {
      customer.requiredDocs.forEach((requiredDoc, requiredDocIndex) => {
        if (requiredDoc.linkedVaultDocId !== null) {
          requiredDoc.linkedVaultDocId = rewrite(
            requiredDoc.linkedVaultDocId,
            `workspaces.${workspaceIndex}.customers.${customerIndex}.requiredDocs.${requiredDocIndex}.linkedVaultDocId`,
          )
        }
      })
    })
    workspace.tenders.forEach((tender, tenderIndex) => {
      tender.requirements.forEach((requirement, requirementIndex) => {
        const base = `workspaces.${workspaceIndex}.tenders.${tenderIndex}.requirements.${requirementIndex}`
        if (requirement.linkedVaultDocId !== null)
          requirement.linkedVaultDocId = rewrite(
            requirement.linkedVaultDocId,
            `${base}.linkedVaultDocId`,
          )
        requirement.suggestedVaultDocIds = requirement.suggestedVaultDocIds.map(
          (reference, suggestionIndex) =>
            rewrite(reference, `${base}.suggestedVaultDocIds.${suggestionIndex}`),
        )
      })
    })
  })
}

export function validateTendersDataV2(input: unknown): TendersSchemaResult<TendersDataV2> {
  const issues = new Issues()
  if (aggregateStrings(input) > MAX_TENDERS_AGGREGATE_STRING_CHARS)
    issues.add(
      '',
      'INVALID',
      `Aggregate string content exceeds limit of ${MAX_TENDERS_AGGREGATE_STRING_CHARS}.`,
    )
  const data = parseV2(input, issues)
  return data && issues.items.length === 0 ? success(data, 2, false) : failure(issues)
}

export function migrateTendersDataV1(
  input: TendersDataV1,
  now: Date | string = new Date(),
): TendersSchemaResult<TendersDataV2> {
  const fallback = migratedAt(now)
  const issues = new Issues()
  if (fallback === undefined)
    issues.add('migratedAt', 'INVALID', 'Injected migration timestamp must be valid RFC3339.')
  const data = parseV1(input, issues, fallback)
  if (!data || issues.items.length > 0) return failure(issues)
  const wasTimestampValid = validRfc3339((input as unknown as UnknownRecord).updatedAt)
  const warnings = wasTimestampValid ? [] : ['updatedAt replaced with injected migratedAt']
  const migrated: TendersDataV2 = {
    schemaVersion: 2,
    revision: 0,
    updatedAt: data.updatedAt,
    activeCompanyId: data.activeCompanyId || null,
    workspaces: data.workspaces.map((workspace) => ({
      ...workspace,
      dataOrigin:
        historicalDemoFingerprint(input) === HISTORICAL_DEMO_FINGERPRINT ? 'demo' : 'user',
    })),
    issuerTemplates: data.issuerTemplates,
  }
  rewriteLegacyVaultReferences(migrated, issues, warnings)
  if (issues.items.length > 0) return failure(issues)
  const validated = validateTendersDataV2(migrated)
  if (!validated.ok) return validated
  return success(validated.data, 1, true, warnings)
}

export function migrateTendersData(
  input: unknown,
  now: Date | string = new Date(),
): TendersSchemaResult<TendersDataV2> {
  if (!record(input)) return failure(new Issues())
  if (typeof input.schemaVersion === 'number' && input.schemaVersion > 2) {
    const issues = new Issues()
    issues.add('schemaVersion', 'UNSUPPORTED', 'Unsupported schema version.', input.schemaVersion)
    return failure(issues, 'UNSUPPORTED')
  }
  if (typeof input.version === 'number' && input.version > 1) {
    const issues = new Issues()
    issues.add('version', 'UNSUPPORTED', 'Unsupported schema version.', input.version)
    return failure(issues, 'UNSUPPORTED')
  }
  if (input.schemaVersion === 2) {
    const validated = validateTendersDataV2(input)
    return validated.ok ? { ...validated, sourceVersion: 2, migrated: false } : validated
  }
  if (input.version === 1) return migrateTendersDataV1(input as unknown as TendersDataV1, now)
  return failure(new Issues())
}

export function createEmptyTendersDataV2(now: Date | string = new Date()): TendersDataV2 {
  const date = now instanceof Date ? now : new Date(now)
  const iso = isNaN(date.getTime()) ? '' : date.toISOString()
  if (!validRfc3339(iso) || (typeof now === 'string' && !validRfc3339(now))) {
    throw new Error('createEmptyTendersDataV2 requires a valid RFC3339 timestamp or Date.')
  }
  return {
    schemaVersion: TENDERS_SCHEMA_VERSION,
    revision: 0,
    updatedAt: iso,
    activeCompanyId: null,
    workspaces: [],
    issuerTemplates: [],
  }
}
