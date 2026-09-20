// CRM-owned implementation of the Tenders integration ports (Phase 4, WP-10).
//
// CRM owns deal validation, audit, soft-delete and recovery: this adapter only
// translates the Tenders port payloads into `CrmStore` calls. Tenders never
// touches `crm/deals.json`; this module is composed by the shell.
import { CrmStore } from './crm-store'
import type { DealStage } from '../shared/types'
import type {
  TenderOpportunityInput,
  TenderOpportunityResult,
  TenderOutcomeInput,
  TenderOutcomeResult,
} from '../../../tenders/src/main/integrations'

const VALID_DEAL_STAGES: ReadonlySet<DealStage> = new Set([
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'won',
  'lost',
])

export interface CrmTenderPortOptions {
  userDataDir: string
  /** Inject a store (tests) instead of opening the profile directory. */
  store?: CrmStore
}

export interface CrmTenderPort {
  upsertTenderOpportunity: (input: TenderOpportunityInput) => TenderOpportunityResult
  updateTenderOutcome: (input: TenderOutcomeInput) => TenderOutcomeResult
  getStore: () => CrmStore
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function isValidStage(value: unknown): value is DealStage {
  return typeof value === 'string' && VALID_DEAL_STAGES.has(value as DealStage)
}

/**
 * Build the CRM side of the typed ports. `seed: false` keeps a tender sync from
 * creating CRM demo records on a fresh profile.
 */
export function createCrmTenderPort(options: CrmTenderPortOptions): CrmTenderPort {
  const store = options.store ?? new CrmStore(options.userDataDir, { seed: false })

  const upsertTenderOpportunity = (input: TenderOpportunityInput): TenderOpportunityResult => {
    try {
      store.assertMutationAllowed()
      const stage = isValidStage(input.stage) ? input.stage : 'proposal'
      const saved = store.saveDeal({
        id: input.dealId,
        name: input.name,
        companyName: input.companyName,
        amount: Number.isFinite(input.amount) && input.amount >= 0 ? input.amount : 0,
        stage,
        expectedCloseDate: input.expectedCloseDate,
        notes: input.notes,
        tenderId: input.tenderId,
        tenderReference: input.tenderReference ?? undefined,
      })
      return { ok: true, dealId: saved.id }
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error, 'Failed to upsert CRM opportunity') }
    }
  }

  const updateTenderOutcome = (input: TenderOutcomeInput): TenderOutcomeResult => {
    try {
      store.assertMutationAllowed()
      const existing = store
        .getDeals()
        .find(
          (deal) =>
            deal.id === input.dealId || (input.tenderId !== '' && deal.tenderId === input.tenderId),
        )
      if (!existing) return { ok: false, error: `CRM deal not found: ${input.dealId}` }

      const stage: DealStage = input.outcome === 'won' ? 'won' : 'lost'
      const suffix = [input.reason, input.noticeDate ? `Notice: ${input.noticeDate}` : '']
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .join(' — ')
      const notes = suffix ? [existing.notes, suffix].filter(Boolean).join('\n') : undefined
      const saved = store.saveDeal({
        id: existing.id,
        stage,
        tenderId: input.tenderId,
        ...(typeof input.amount === 'number' && Number.isFinite(input.amount)
          ? { amount: input.amount }
          : {}),
        ...(notes ? { notes } : {}),
      })
      return { ok: true, dealId: saved.id }
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error, 'Failed to record CRM outcome') }
    }
  }

  return { upsertTenderOpportunity, updateTenderOutcome, getStore: () => store }
}
