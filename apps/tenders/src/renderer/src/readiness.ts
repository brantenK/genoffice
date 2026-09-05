// Bid-readiness gate: the pre-submission checklist that decides whether a
// tender can be marked READY_FOR_SUBMISSION. The classic SA trap this guards
// against: a certificate valid *today* can expire *before the closing date* —
// so linked documents are re-assessed with `assessDocHealth(doc, closingDate)`,
// not with today's date.
import type { CompanyProfile, TenderRecord, VaultDoc } from '../shared/types'
import { assessDocHealth, daysBetween } from './gap'
import { parseClosingDate } from './deadline'

/** Rule keys where a physical signature / initialling / form is the deliverable. */
export const SIGNATURE_RULE_KEYS = [
  'sbd_forms',
  'signed_initialled',
  'declaration',
  'original_docs',
]

export interface ReadinessCheck {
  id: string
  /** short label shown in the drawer */
  label: string
  /** explanation shown when the check fails */
  detail: string
  passed: boolean
  /** how severe a failure is: blocking failures prevent READY_FOR_SUBMISSION */
  blocking: boolean
}

export interface ReadinessReport {
  checks: ReadinessCheck[]
  /** true when every blocking check passes */
  ready: boolean
  /** counts for the summary pill */
  passedCount: number
  failedCount: number
  blockingFailedCount: number
  /** weighted 0–100 readiness score (checks are partial-credited, not binary) */
  score: number
  /** the failing check worth the most score points to fix next */
  nextBestAction: { label: string; detail: string } | null
}

/** How many score points each check is worth (sums to 100). Blocking
 *  disqualifier checks weigh the most; the advisory company-details check
 *  the least. */
const CHECK_WEIGHTS: Record<string, number> = {
  requirements: 30,
  'docs-at-closing': 25,
  deadline: 20,
  signatures: 15,
  'company-details': 10,
}

/** Documents linked to requirements, re-assessed as they will stand at closing. */
export interface DocAtClosing {
  doc: VaultDoc
  /** health as of the closing date, not today */
  healthAtClosing: ReturnType<typeof assessDocHealth>
  /** true when the doc will be expired/stale on closing day */
  willFail: boolean
  requirementTitles: string[]
}

export interface DetailMismatch {
  field: string
  tenderExpects: string | null
  companyHas: string | null
}

/**
 * Company-details consistency: does the profile carry the numbers the RFP's
 * returnables typically demand (registration, VAT, tax pin, B-BBEE, CSD)?
 * These are informational blockers — a missing tax PIN on the profile means
 * the SBD forms cannot be filled in consistently.
 */
export function checkCompanyDetails(
  tender: TenderRecord,
  company: CompanyProfile,
): DetailMismatch[] {
  const wants = (kw: RegExp): boolean =>
    tender.requirements.some((r) => kw.test(r.title) || kw.test(r.verbatimClause))

  const mismatches: DetailMismatch[] = []
  if (wants(/(registration|cipc|incorporat)/i) && !company.registrationNumber) {
    mismatches.push({
      field: 'Registration number',
      tenderExpects: 'CIPC registration number',
      companyHas: company.registrationNumber,
    })
  }
  if (wants(/(tax\s*pin|sars)/i) && !company.taxPin) {
    mismatches.push({
      field: 'Tax PIN',
      tenderExpects: 'SARS tax pin / TCS',
      companyHas: company.taxPin,
    })
  }
  if (wants(/(vat)/i) && !company.vatNumber) {
    mismatches.push({
      field: 'VAT number',
      tenderExpects: 'VAT registration number',
      companyHas: company.vatNumber,
    })
  }
  if (wants(/(bbbee|b-bbee|b-bbbee|broad[- ]based)/i) && !company.bbbeeLevel) {
    mismatches.push({
      field: 'B-BBEE level',
      tenderExpects: 'B-BBEE certificate / level',
      companyHas: company.bbbeeLevel,
    })
  }
  if (wants(/(csd|central supplier)/i) && !company.csdSupplierNumber) {
    mismatches.push({
      field: 'CSD supplier number',
      tenderExpects: 'CSD registration',
      companyHas: company.csdSupplierNumber,
    })
  }
  return mismatches
}

/** Signature checklist: rules whose deliverable is signed/initialled paper. */
export function signatureRuleKeys(tender: TenderRecord): string[] {
  return tender.requirements.map((r) => r.ruleKey).filter((k) => SIGNATURE_RULE_KEYS.includes(k))
}

/** All documents linked to requirements, judged at the closing date. */
export function docsAtClosing(tender: TenderRecord, vault: VaultDoc[]): DocAtClosing[] {
  const closing = parseClosingDate(tender.closingDate) ?? new Date(Date.now() + 90 * 86_400_000)

  const byDoc = new Map<string, DocAtClosing>()
  for (const req of tender.requirements) {
    const docId = req.linkedVaultDocId
    if (!docId) continue
    const doc = vault.find((d) => d.id === docId)
    if (!doc) continue
    const healthAtClosing = assessDocHealth(doc, closing)
    const entry = byDoc.get(docId)
    if (entry) {
      entry.requirementTitles.push(req.title)
    } else {
      byDoc.set(docId, {
        doc,
        healthAtClosing,
        willFail:
          healthAtClosing.health === 'EXPIRED' || healthAtClosing.health === 'STALE_CERTIFICATION',
        requirementTitles: [req.title],
      })
    }
  }
  return [...byDoc.values()]
}

/** Full readiness gate. `now` is injectable for tests. */
export function assessReadiness(
  tender: TenderRecord,
  vault: VaultDoc[],
  company: CompanyProfile,
  now: Date = new Date(),
): ReadinessReport {
  const checks: ReadinessCheck[] = []
  const reqs = tender.requirements

  // 1. every requirement resolved (FULFILLED or explicitly NOT_APPLICABLE)
  const unresolved = reqs.filter((r) => r.status !== 'FULFILLED' && r.status !== 'NOT_APPLICABLE')
  checks.push({
    id: 'requirements',
    label: `All ${reqs.length} requirements fulfilled or marked N/A`,
    detail:
      unresolved.length === 0
        ? 'Every requirement in the compliance matrix is resolved.'
        : `${unresolved.length} requirement(s) still outstanding or action-required: ${unresolved
            .slice(0, 3)
            .map((r) => r.title)
            .join(', ')}${unresolved.length > 3 ? '…' : ''}`,
    passed: unresolved.length === 0,
    blocking: true,
  })

  // 2. linked documents valid AT the closing date
  const docs = docsAtClosing(tender, vault)
  const failing = docs.filter((d) => d.willFail)
  checks.push({
    id: 'docs-at-closing',
    label: 'Linked documents valid on the closing date',
    detail:
      failing.length === 0
        ? docs.length === 0
          ? 'No documents linked yet.'
          : `All ${docs.length} linked document(s) remain valid through closing.`
        : failing
            .map(
              (d) =>
                `${d.doc.title} — ${
                  d.healthAtClosing.health === 'EXPIRED'
                    ? `expires ${Math.abs(d.healthAtClosing.daysUntilExpiry ?? 0)} days before closing`
                    : `police stamp will exceed the 90-day window before closing`
                }`,
            )
            .join('; '),
    passed: failing.length === 0,
    blocking: true,
  })

  // 3. signature checklist confirmed
  const sigKeys = signatureRuleKeys(tender)
  const sigMissing = sigKeys.filter((k) => !tender.signatureChecks[k])
  checks.push({
    id: 'signatures',
    label: 'Signature checklist completed',
    detail:
      sigKeys.length === 0
        ? 'No signature-dependent returnables detected.'
        : sigMissing.length === 0
          ? `All ${sigKeys.length} signature item(s) confirmed.`
          : `Not yet confirmed: ${sigMissing.map(labelForRule).join(', ')}`,
    passed: sigMissing.length === 0,
    blocking: true,
  })

  // 4. company-details consistency
  const mismatches = checkCompanyDetails(tender, company)
  checks.push({
    id: 'company-details',
    label: 'Company details on file match the returnables',
    detail:
      mismatches.length === 0
        ? 'Registration, tax, VAT, B-BBEE and CSD details are on file.'
        : mismatches.map((m) => `${m.field} missing on the company profile`).join('; '),
    passed: mismatches.length === 0,
    blocking: false,
  })

  // 5. deadline known and not passed
  const closing = parseClosingDate(tender.closingDate)
  const daysLeft = closing ? daysBetween(closing, now) : null
  checks.push({
    id: 'deadline',
    label: 'Closing date known and still in the future',
    detail:
      closing === null
        ? 'No closing date was lifted from the RFP — confirm the deadline manually.'
        : daysLeft !== null && daysLeft <= 0
          ? `This tender closed ${Math.abs(daysLeft)} day(s) ago.`
          : `${daysLeft} day(s) until closing.`,
    passed: closing !== null && (daysLeft ?? 0) > 0,
    blocking: true,
  })

  // ── weighted score ──────────────────────────────────────────────────────
  // Each check earns partial credit, so progress is visible even before a
  // check fully passes (e.g. 8/10 requirements fulfilled → 80% of its points).
  const resolved = reqs.filter(
    (r) => r.status === 'FULFILLED' || r.status === 'NOT_APPLICABLE',
  ).length
  const progress: Record<string, number> = {
    requirements: reqs.length === 0 ? 1 : resolved / reqs.length,
    'docs-at-closing': docs.length === 0 ? 0.6 : 1 - failing.length / docs.length,
    signatures: sigKeys.length === 0 ? 1 : (sigKeys.length - sigMissing.length) / sigKeys.length,
    'company-details': Math.max(0, 1 - mismatches.length / 5),
    deadline: closing === null ? 0.5 : (daysLeft ?? 0) > 0 ? 1 : 0,
  }

  let score = 0
  let biggestLoss = { check: null as ReadinessCheck | null, lost: 0 }
  for (const check of checks) {
    const weight = CHECK_WEIGHTS[check.id] ?? 10
    const p = Math.max(0, Math.min(progress[check.id] ?? (check.passed ? 1 : 0), 1))
    score += weight * p
    const lost = weight * (1 - p)
    if (lost > biggestLoss.lost) {
      biggestLoss = { check, lost }
    }
  }
  score = Math.round(score)

  const blockingFailed = checks.filter((c) => c.blocking && !c.passed)
  return {
    checks,
    ready: blockingFailed.length === 0,
    passedCount: checks.filter((c) => c.passed).length,
    failedCount: checks.filter((c) => !c.passed).length,
    blockingFailedCount: blockingFailed.length,
    score,
    nextBestAction: biggestLoss.check
      ? { label: biggestLoss.check.label, detail: biggestLoss.check.detail }
      : null,
  }
}

export function labelForRule(ruleKey: string): string {
  const map: Record<string, string> = {
    sbd_forms: 'SBD forms signed',
    signed_initialled: 'each page signed/initialled',
    declaration: 'declaration signed',
    original_docs: 'certified originals included',
  }
  return map[ruleKey] ?? ruleKey
}
