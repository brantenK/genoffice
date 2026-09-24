// Client-side gap analysis: cross-reference shredded requirements against the
// company vault. Flags EXPIRED documents and stale (>90-day) police stamps,
// assigns fulfilment status + human-readable reasons.
//
// Document health and the day maths are NOT implemented here: they are the
// canonical shared ones (`assessDocHealth` / `daysBetween` in
// `shared/readiness.ts`), so the vault UI, the renewal runway and the readiness
// gate can never disagree about whether a document is valid.
import { RULE_BY_KEY } from '../shared/rules'
import {
  assessDocHealth as assessCanonicalDocHealth,
  daysBetween,
  healthWillFail,
  POLICE_STAMP_WINDOW_DAYS,
  type ReadinessDocHealth,
} from '../../shared/readiness'
import type { DocHealth, FulfillmentStatus, RequirementRecord, VaultDoc } from '../shared/types'

export { daysBetween, POLICE_STAMP_WINDOW_DAYS }

export interface DocHealthReport {
  health: DocHealth
  /** negative = already expired */
  daysUntilExpiry: number | null
  daysSinceCertified: number | null
  /** days left inside the 90-day police stamp window (null when N/A) */
  stampDaysLeft: number | null
}

/**
 * The shared report is the single implementation; this narrows its two extra
 * states onto the vault UI's four-state `DocHealth` contract. The narrowing is
 * presentation only: `applyGapToRequirement` classifies a requirement from the
 * canonical six-state health (with the rule's own `validityKind`), so a
 * requirement is never auto-marked FULFILLED for a document the readiness gate
 * blocks as `UNKNOWN` / `INVALID_DATE`.
 */
function toDocHealth(health: ReadinessDocHealth): DocHealth {
  return health === 'UNKNOWN' || health === 'INVALID_DATE' ? 'NO_EXPIRY_INFO' : health
}

export function assessDocHealth(doc: VaultDoc, now: Date = new Date()): DocHealthReport {
  const report = assessCanonicalDocHealth(doc, now)
  return {
    health: toDocHealth(report.health),
    daysUntilExpiry: report.daysUntilExpiry,
    daysSinceCertified: report.daysSinceCertified,
    stampDaysLeft: report.stampDaysLeft,
  }
}

/** Health summary over the canonical (six-state) health, for requirement reasons. */
function canonicalHealthSummary(
  doc: VaultDoc,
  report: { health: ReadinessDocHealth } & Omit<DocHealthReport, 'health'>,
): string {
  switch (report.health) {
    case 'UNKNOWN':
      return 'expiry/certification information is unknown — confirm the date on file'
    case 'INVALID_DATE':
      return 'the date on file is not a valid date — correct it in the vault'
    default:
      return healthSummary(doc, { ...report, health: toDocHealth(report.health) })
  }
}

export function healthSummary(doc: VaultDoc, report: DocHealthReport): string {
  switch (report.health) {
    case 'EXPIRED':
      return `Expired ${Math.abs(report.daysUntilExpiry ?? 0)} days ago`
    case 'STALE_CERTIFICATION':
      return `Police stamp ${report.daysSinceCertified} days old — exceeds ${POLICE_STAMP_WINDOW_DAYS}-day window`
    case 'VALID': {
      if (report.stampDaysLeft !== null) {
        return `Valid — stamp fresh, ${report.stampDaysLeft} stamp days left`
      }
      if (report.daysUntilExpiry !== null) {
        return `Valid — expires in ${report.daysUntilExpiry} days`
      }
      return 'Valid'
    }
    default:
      return 'No expiry date on file'
  }
}

/** A vault doc scored against a requirement rule's hints. */
export interface VaultMatch {
  doc: VaultDoc
  /** 0–1 confidence: keyword overlap + category agreement */
  confidence: number
}

/** Minimum confidence to auto-link a vault doc to a requirement.
 *  Below this, the doc is still suggested but never silently linked —
 *  wrong auto-links are a compliance risk, so they stay user-confirmed. */
export const AUTO_LINK_THRESHOLD = 0.5

/** Score vault docs against a requirement rule's hints: keyword overlap on
 *  the title, boosted when the doc's category agrees with the rule hint.
 *  Returns candidates sorted by confidence (desc). */
export function matchVaultDocsWithConfidence(
  req: RequirementRecord,
  vault: VaultDoc[],
): VaultMatch[] {
  const rule = RULE_BY_KEY[req.ruleKey]
  if (!rule) return []
  const keywords = rule.vaultHints.keywords.map((k) => k.toLowerCase())

  const matches: VaultMatch[] = []
  for (const doc of vault) {
    const title = doc.title.toLowerCase()
    const hits = keywords.filter((k) => title.includes(k))
    if (hits.length === 0) continue

    // keyword coverage: how many distinct hints this doc's title carries
    const coverage = hits.length / keywords.length
    let confidence = Math.min(0.35 + hits.length * 0.2, 0.8) * (0.7 + 0.3 * coverage)

    // category agreement is a strong signal (e.g. FINANCIAL 'vat' doc vs the
    // SARS tax-clearance rule) — reward it, penalize disagreement
    const hintCategory = rule.vaultHints.category
    if (hintCategory) {
      if (doc.category === hintCategory) confidence += 0.15
      else confidence -= 0.2
    }

    confidence = Math.max(0, Math.min(confidence, 1))
    matches.push({ doc, confidence })
  }

  matches.sort((a, b) => b.confidence - a.confidence)
  return matches
}

/** Back-compat: vault docs matching a requirement rule's hints (confidence order). */
export function matchVaultDocs(req: RequirementRecord, vault: VaultDoc[]): VaultDoc[] {
  return matchVaultDocsWithConfidence(req, vault).map((m) => m.doc)
}

const HEALTH_RANK: Record<ReadinessDocHealth, number> = {
  VALID: 3,
  NO_EXPIRY_INFO: 2,
  UNKNOWN: 1,
  STALE_CERTIFICATION: 1,
  EXPIRED: 0,
  INVALID_DATE: 0,
}

/** Auto-assign status/reason/linked doc for one requirement. */
export function applyGapToRequirement(
  req: RequirementRecord,
  vault: VaultDoc[],
  now: Date = new Date(),
): RequirementRecord {
  const matches = matchVaultDocsWithConfidence(req, vault)
  const suggested = matches.map((m) => m.doc.id)

  if (matches.length === 0) {
    return {
      ...req,
      suggestedVaultDocIds: [],
      linkedVaultDocId: null,
      status: 'OUTSTANDING',
      reason: 'No matching document found in the company vault.',
    }
  }

  // Only docs confident enough may be linked automatically. Below the
  // threshold the top candidate becomes a hint the user confirms manually —
  // silently linking a wrong doc is a worse compliance risk than a false gap.
  const linkable = matches.filter((m) => m.confidence >= AUTO_LINK_THRESHOLD)

  if (linkable.length === 0) {
    const top = matches[0]
    return {
      ...req,
      suggestedVaultDocIds: suggested,
      linkedVaultDocId: null,
      status: 'OUTSTANDING',
      reason: `Possible match: ${top.doc.title} — low confidence (${Math.round(
        top.confidence * 100,
      )}%), confirm manually.`,
    }
  }

  // Best linkable match: healthiest doc; tie-break on earliest expiry (freshest).
  // The canonical health is computed WITH the rule's own validity kind, so the
  // status below is the same verdict the readiness gate reaches for this
  // document at the closing date.
  const validityKind = RULE_BY_KEY[req.ruleKey]?.validityKind
  const withReports = linkable.map((m) => ({
    doc: m.doc,
    rep: assessCanonicalDocHealth(m.doc, now, validityKind),
  }))
  withReports.sort(
    (a, b) =>
      HEALTH_RANK[b.rep.health] - HEALTH_RANK[a.rep.health] ||
      (a.doc.expiryDate ?? '9999').localeCompare(b.doc.expiryDate ?? '9999'),
  )
  const best = withReports[0]

  // `healthWillFail` is the readiness module's own list: a requirement can never
  // be auto-fulfilled by a document the readiness gate blocks.
  const status: FulfillmentStatus = healthWillFail(best.rep.health)
    ? 'ACTION_REQUIRED'
    : 'FULFILLED'

  return {
    ...req,
    suggestedVaultDocIds: suggested,
    linkedVaultDocId: best.doc.id,
    status,
    reason: `${best.doc.title} — ${canonicalHealthSummary(best.doc, best.rep)}`,
  }
}

/** Re-run gap analysis for every requirement of a tender. */
export function applyGapToRequirements(
  reqs: RequirementRecord[],
  vault: VaultDoc[],
  now: Date = new Date(),
): RequirementRecord[] {
  return reqs.map((r) => applyGapToRequirement(r, vault, now))
}
