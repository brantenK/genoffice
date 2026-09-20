// Typed cross-app integration ports for Tenders (Phase 4, WP-10).
//
// Tenders owns the workflow but NOT the CRM/Books data files. Every cross-app
// write goes through one of the small typed ports below; the shell is the
// composition root and injects concrete implementations via
// `configureTendersRuntime({ integrations })`. Tenders never reads or writes
// the CRM deal store (or the Books store) itself.
//
// Ports are intentionally narrow and promise-based so an in-process adapter and
// an out-of-process one are interchangeable, and so the core workflow can run
// with integrations disabled (an explicit `integrations: {}` injection).

export type TenderLifecycleOutcome = 'won' | 'lost' | 'withdrawn' | 'cancelled'

export interface TenderOpportunityInput {
  /** Deterministic, tender-derived deal id (`deal-tender-<tenderId>`). */
  dealId: string
  tenderId: string
  tenderReference: string | null
  /** Fully-composed deal name (reference-prefixed when a reference exists). */
  name: string
  companyName: string
  amount: number
  stage?: string
  expectedCloseDate?: string
  notes?: string
}

export interface TenderOpportunityResult {
  ok: boolean
  dealId?: string
  error?: string
}

export interface TenderOutcomeInput {
  dealId: string
  tenderId: string
  outcome: TenderLifecycleOutcome
  amount?: number
  reason?: string
  noticeDate?: string
}

export interface TenderOutcomeResult {
  ok: boolean
  dealId?: string
  error?: string
}

export interface MilestoneInvoiceInput {
  tenderId: string
  milestoneId: string
  /**
   * Stable idempotency key. Books dedupes on this so a retry (or a crash
   * between posting and the tender commit) can never create a second invoice.
   */
  idempotencyKey: string
  partyName: string
  itemDescription: string
  amount: number
  tenderReference?: string
  itemCode?: string
  accountId?: string
  accountName?: string
  notes?: string
  date?: string
  dueDate?: string
}

export interface MilestoneInvoiceResult {
  ok: boolean
  invoiceId?: string
  invoiceNumber?: string
  subtotal?: number
  taxTotal?: number
  grandTotal?: number
  error?: string
}

export interface OpenEntityTarget {
  app: 'crm' | 'books'
  entityId?: string
}

/**
 * The full port surface. Every method is optional so an environment can inject
 * a subset; a missing port means the owning app is disabled (handlers return a
 * typed error and the core Tenders workflow is unaffected).
 */
export interface TendersIntegrations {
  upsertTenderOpportunity?: (
    input: TenderOpportunityInput,
  ) => TenderOpportunityResult | Promise<TenderOpportunityResult>
  updateTenderOutcome?: (
    input: TenderOutcomeInput,
  ) => TenderOutcomeResult | Promise<TenderOutcomeResult>
  issueMilestoneInvoice?: (
    input: MilestoneInvoiceInput,
  ) => MilestoneInvoiceResult | Promise<MilestoneInvoiceResult>
  /** Open the owning app at a returned entity (CRM deal / Books invoice). */
  openAppAt?: (target: OpenEntityTarget) => void
}

export interface TendersIntegrationOptions {
  userDataDir: string
  /** Override for tests / alternate profiles. */
  crmUserDataDir?: string
  booksUserDataDir?: string
}

let injectedIntegrations: TendersIntegrations | null = null
let integrationsInjected = false
const defaultIntegrations = new Map<string, TendersIntegrations>()

/**
 * Called by `configureTendersRuntime`. Passing `undefined` restores the
 * built-in adapters; passing an object (including `{}`) uses exactly that
 * object — `{}` is the explicit "integrations disabled" state.
 */
export function setInjectedTendersIntegrations(value: TendersIntegrations | undefined): void {
  integrationsInjected = true
  injectedIntegrations = value ?? null
}

/** Test hook: forget the injected/default integrations. */
export function resetTendersIntegrationsForTests(): void {
  integrationsInjected = false
  injectedIntegrations = null
  defaultIntegrations.clear()
}

/**
 * Built-in adapters. They lazily import the CRM/Books-owned implementations so
 * this module (and Tenders main) never touches their stores directly. The shell
 * overrides these with its own composition.
 */
function getDefaultTendersIntegrations(options: TendersIntegrationOptions): TendersIntegrations {
  const key = `${options.crmUserDataDir ?? options.userDataDir}|${options.booksUserDataDir ?? options.userDataDir}`
  const existing = defaultIntegrations.get(key)
  if (existing) return existing

  let crmPort: TendersIntegrations | null = null
  let booksPort: TendersIntegrations | null = null

  const integrations: TendersIntegrations = {
    async upsertTenderOpportunity(input) {
      if (!crmPort) {
        const mod = await import('../../../crm/src/main/tender-port')
        crmPort = mod.createCrmTenderPort({
          userDataDir: options.crmUserDataDir ?? options.userDataDir,
        }) as TendersIntegrations
      }
      return crmPort.upsertTenderOpportunity!(input)
    },
    async updateTenderOutcome(input) {
      if (!crmPort) {
        const mod = await import('../../../crm/src/main/tender-port')
        crmPort = mod.createCrmTenderPort({
          userDataDir: options.crmUserDataDir ?? options.userDataDir,
        }) as TendersIntegrations
      }
      return crmPort.updateTenderOutcome!(input)
    },
    async issueMilestoneInvoice(input) {
      if (!booksPort) {
        const mod = await import('../../../books/src/main/tender-port')
        booksPort = mod.createBooksTenderPort({
          userDataDir: options.booksUserDataDir ?? options.userDataDir,
        }) as TendersIntegrations
      }
      return booksPort.issueMilestoneInvoice!(input)
    },
  }

  defaultIntegrations.set(key, integrations)
  return integrations
}

/** Resolve the effective ports for this runtime (injected wins, else defaults). */
export function resolveTendersIntegrations(
  options: TendersIntegrationOptions,
): TendersIntegrations {
  if (integrationsInjected) return injectedIntegrations ?? {}
  return getDefaultTendersIntegrations(options)
}
