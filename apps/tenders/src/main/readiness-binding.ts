// Main-owned canonical readiness snapshot (Phase 4 "Readiness snapshot binding").
//
// Loads the authoritative tender + its workspace company/vault, assesses
// readiness, and binds the report to the exact canonical inputs it was built
// from (tender id + document revision + fingerprint). The proposal generator
// verifies this binding before it may emit ready language.
import type { CompanyProfile, TenderRecord, TendersDataV2, VaultDoc } from '../shared/types'
import {
  assessReadiness,
  bindReadinessReport,
  readinessFingerprint,
  type ReadinessReport,
} from '../shared/readiness'

export interface CanonicalReadinessResult {
  ok: boolean
  error?: string
  tenderId?: string
  revision?: number
  tender?: TenderRecord
  company?: CompanyProfile
  vault?: VaultDoc[]
  report?: ReadinessReport
}

/**
 * Pure builder over an authoritative document. Returns a ready-bound report
 * whose `binding` identifies the exact tender/revision/fingerprint, or an error
 * when the tender is not part of the document.
 */
export function buildCanonicalReadinessReport(
  document: TendersDataV2,
  tenderId: string,
  now: Date = new Date(),
): CanonicalReadinessResult {
  if (!tenderId) return { ok: false, error: 'A tender id is required for readiness.' }
  for (const workspace of document.workspaces) {
    const tender = workspace.tenders.find((candidate) => candidate.id === tenderId)
    if (!tender) continue
    const report = assessReadiness(tender, workspace.vault, workspace.company, now)
    const binding = {
      tenderId,
      revision: document.revision,
      fingerprint: readinessFingerprint({
        tender,
        company: workspace.company,
        vault: workspace.vault,
      }),
      generatedAt: now.toISOString(),
    }
    return {
      ok: true,
      tenderId,
      revision: document.revision,
      tender,
      company: workspace.company,
      vault: workspace.vault,
      report: bindReadinessReport(report, binding),
    }
  }
  return { ok: false, error: `Tender not found in the authoritative document: ${tenderId}` }
}
