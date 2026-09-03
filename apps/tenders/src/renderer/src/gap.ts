// Client-side gap analysis: cross-reference shredded requirements against the
// company vault. Flags EXPIRED documents and stale (>90-day) police stamps,
// assigns fulfilment status + human-readable reasons.
import { RULE_BY_KEY } from '../shared/rules'
import type {
  DocHealth,
  FulfillmentStatus,
  RequirementRecord,
  VaultDoc
} from '../shared/types'

export const POLICE_STAMP_WINDOW_DAYS = 90

const DAY_MS = 86_400_000

export function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS)
}

export interface DocHealthReport {
  health: DocHealth
  /** negative = already expired */
  daysUntilExpiry: number | null
  daysSinceCertified: number | null
  /** days left inside the 90-day police stamp window (null when N/A) */
  stampDaysLeft: number | null
}

export function assessDocHealth(doc: VaultDoc, now: Date = new Date()): DocHealthReport {
  const daysUntilExpiry = doc.expiryDate ? daysBetween(new Date(doc.expiryDate), now) : null
  const daysSinceCertified = doc.certifiedDate ? daysBetween(now, new Date(doc.certifiedDate)) : null
  const stampDaysLeft =
    doc.isCertified && daysSinceCertified !== null
      ? POLICE_STAMP_WINDOW_DAYS - daysSinceCertified
      : null

  if (daysUntilExpiry !== null && daysUntilExpiry < 0) {
    return { health: 'EXPIRED', daysUntilExpiry, daysSinceCertified, stampDaysLeft }
  }
  if (stampDaysLeft !== null && stampDaysLeft < 0) {
    return { health: 'STALE_CERTIFICATION', daysUntilExpiry, daysSinceCertified, stampDaysLeft }
  }
  if (daysUntilExpiry === null && daysSinceCertified === null) {
    return { health: 'NO_EXPIRY_INFO', daysUntilExpiry, daysSinceCertified, stampDaysLeft }
  }
  return { health: 'VALID', daysUntilExpiry, daysSinceCertified, stampDaysLeft }
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
  vault: VaultDoc[]
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

const HEALTH_RANK: Record<DocHealth, number> = {
  VALID: 3,
  NO_EXPIRY_INFO: 2,
  STALE_CERTIFICATION: 1,
  EXPIRED: 0
}

/** Auto-assign status/reason/linked doc for one requirement. */
export function applyGapToRequirement(
  req: RequirementRecord,
  vault: VaultDoc[],
  now: Date = new Date()
): RequirementRecord {
  const matches = matchVaultDocsWithConfidence(req, vault)
  const suggested = matches.map((m) => m.doc.id)

  if (matches.length === 0) {
    return {
      ...req,
      suggestedVaultDocIds: [],
      linkedVaultDocId: null,
      status: 'OUTSTANDING',
      reason: 'No matching document found in the company vault.'
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
        top.confidence * 100
      )}%), confirm manually.`
    }
  }

  // Best linkable match: healthiest doc; tie-break on earliest expiry (freshest).
  const withReports = linkable.map((m) => ({ doc: m.doc, rep: assessDocHealth(m.doc, now) }))
  withReports.sort(
    (a, b) =>
      HEALTH_RANK[b.rep.health] - HEALTH_RANK[a.rep.health] ||
      (a.doc.expiryDate ?? '9999').localeCompare(b.doc.expiryDate ?? '9999')
  )
  const best = withReports[0]

  const status: FulfillmentStatus =
    best.rep.health === 'EXPIRED' || best.rep.health === 'STALE_CERTIFICATION'
      ? 'ACTION_REQUIRED'
      : 'FULFILLED'

  return {
    ...req,
    suggestedVaultDocIds: suggested,
    linkedVaultDocId: best.doc.id,
    status,
    reason: `${best.doc.title} — ${healthSummary(best.doc, best.rep)}`
  }
}

/** Re-run gap analysis for every requirement of a tender. */
export function applyGapToRequirements(
  reqs: RequirementRecord[],
  vault: VaultDoc[],
  now: Date = new Date()
): RequirementRecord[] {
  return reqs.map((r) => applyGapToRequirement(r, vault, now))
}
