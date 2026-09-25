// The proposal channel: draft the bid document from a canonical readiness
// snapshot.
//
// Split out of `ipc/handlers.ts` with no behaviour change. This is the one
// channel that may emit "ready" language, so its gate rejects with the bare-string
// shape the tests pin rather than `unauthorizedTendersRequest()`, and everything
// it accepts is preflighted by `./proposal-payload`.
import { TENDERS_CHANNELS } from '../../shared/ipc'
import type { ReadinessBinding, ReadinessReport } from '../../shared/readiness'
import { isRecord } from '../readiness-snapshot'
import { buildCanonicalReadinessReport } from '../readiness-binding'
import { expectedReadinessBinding, generateProposalMarkdown } from '../proposal-generator'
import { authoritativeStore as getAuthoritativeTendersStore } from '../store-registry'
import { runtime } from '../composition-services'
import { validProposalPayload, writeGeneratedProposal } from './proposal-payload'
import { isTrustedTendersEvent } from './trust'
import type { TendersIpcRegistry } from './handler-context'

export function registerTendersProposalChannels(ipc: TendersIpcRegistry): void {
  // Cross-App: Draft Proposal in Docs
  ipc.handle(TENDERS_CHANNELS.draftProposalDoc, async (_e, tender: unknown) => {
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
}
