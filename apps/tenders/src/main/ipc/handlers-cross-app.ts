// The cross-app channels: the CRM sync/outcome/open ports, the Books tab and
// its milestone billing, the proposal draft, and the Sheets matrix export.
//
// Split out of `ipc/handlers.ts` with no behaviour change. Every one of them is a
// THIN transport over a typed port (`integrations.ts`) or over a file this app
// writes itself: Tenders never reaches into the CRM or Books store, and the ports
// are resolved before any side effect so a disabled integration produces no
// partial application at all.
import {
  TENDERS_CHANNELS,
  type BillMilestoneRequest,
  type BillMilestoneResult,
} from '../../shared/ipc'
import type { TendersPersistenceError } from '../../shared/tenders-persistence'
import type { ContractMilestone, TenderRecord, TendersDataV2 } from '../../shared/types'
import { milestonesAllowed } from '../../shared/lifecycle'
import { authoritativeStore as getAuthoritativeTendersStore } from '../store-registry'
import {
  getIntegrations,
  runtime,
  findTenderById,
  openOwningApp,
  TENDERS_DEMO_WRITE_ERROR,
  tendersNotWonBillingError,
} from '../composition-services'
import { isTrustedTendersEvent, unauthorizedTendersRequest } from './trust'
import type { TendersIpcRegistry } from './handler-context'

export function registerTendersCrossAppChannels(ipc: TendersIpcRegistry): void {
  // Cross-App: Sync with CRM (typed port; Tenders never touches the CRM store)
  ipc.handle(TENDERS_CHANNELS.syncWithCrm, async (_e, dealData: any) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const integrations = getIntegrations()
      const upsertTenderOpportunity = integrations.upsertTenderOpportunity
      // Resolve the port BEFORE any side effect: with CRM disabled there is no
      // partial application at all.
      if (!upsertTenderOpportunity) {
        return { ok: false, error: 'CRM integration is not configured.' }
      }

      const authoritativeStore = getAuthoritativeTendersStore()
      const loaded = await authoritativeStore.load()
      if (!loaded.ok) return { ok: false, error: loaded.error.message }

      // Validation (contracts §6 item 2): the caller's expected revision is
      // checked FIRST, before any side effect at all. It used to be read only
      // inside the mutate below — by which point nothing had been written, but
      // the caller's own validation had not run either, so a caller that was
      // simply wrong about the revision still reached the CRM port. A refusal
      // here writes nothing and opens nothing.
      const requestedRevision =
        typeof dealData?.expectedRevision === 'number' ? dealData.expectedRevision : null
      if (requestedRevision !== null && requestedRevision !== loaded.data.revision) {
        return {
          ok: false,
          error:
            `Revision conflict: expected revision ${requestedRevision} but the authoritative ` +
            `document is at revision ${loaded.data.revision}.`,
          currentRevision: loaded.data.revision,
        }
      }

      const payloadTender: TenderRecord | undefined =
        dealData && typeof dealData.tender === 'object'
          ? (dealData.tender as TenderRecord)
          : undefined
      const tenderId =
        (typeof dealData?.tenderId === 'string' && dealData.tenderId) ||
        payloadTender?.id ||
        (typeof dealData?.id === 'string' && dealData.id.startsWith('deal-tender-')
          ? dealData.id.replace('deal-tender-', '')
          : '') ||
        ''

      const resolved = tenderId ? findTenderById(loaded.data, tenderId) : null
      // Main-side demo isolation: never write to CRM from a demonstration
      // workspace, even if the renderer guard were bypassed. Rejection happens
      // before any mutation, so there is no side effect.
      if (resolved?.workspace.dataOrigin === 'demo') {
        return { ok: false, error: TENDERS_DEMO_WRITE_ERROR }
      }
      // Identity and the back-link come from the canonical document; the deal
      // content prefers the renderer's explicit sync payload (its historical
      // contract), falling back to the canonical tender.
      const tender = payloadTender ?? resolved?.tender
      const effectiveTenderId = resolved?.tender.id ?? tenderId

      const deterministicDealId =
        (typeof dealData?.dealId === 'string' && dealData.dealId) ||
        (typeof dealData?.id === 'string' && dealData.id !== effectiveTenderId
          ? dealData.id
          : effectiveTenderId
            ? `deal-tender-${effectiveTenderId}`
            : `deal-tender-${Date.now()}`)

      const refNum =
        tender?.referenceNumber || dealData?.tenderReference || dealData?.referenceNumber || ''
      const rawTitle = tender?.title || dealData?.title || dealData?.name || 'Tender Opportunity'
      const title =
        refNum && rawTitle.startsWith(`${refNum} - `)
          ? rawTitle.replace(`${refNum} - `, '')
          : rawTitle
      const dealName = refNum ? `${refNum} - ${title}` : title
      const companyName =
        tender?.issuingBody || dealData?.companyName || 'Government / Enterprise Buyer'
      const rawAmount =
        typeof tender?.estimatedValue === 'number'
          ? tender.estimatedValue
          : typeof dealData?.amount === 'number' && Number.isFinite(dealData.amount)
            ? dealData.amount
            : 0
      const amount = Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : 0
      const stage = typeof dealData?.stage === 'string' ? dealData.stage : 'proposal'
      const expectedCloseDate =
        tender?.closingDate || dealData?.expectedCloseDate || dealData?.closingDate || undefined
      const notes =
        dealData?.notes ||
        (refNum
          ? `Tender Ref: ${refNum}\nIssuing Authority: ${companyName}`
          : `Issuing Authority: ${companyName}`)

      // The CRM upsert runs first, and the back-link is committed only once it
      // has succeeded. `{ ok: true }` is returned only when BOTH halves are
      // durable: a deal that was written without the back-link leaves the tender
      // still calling itself unsynced, and a caller told "synced" for that is
      // being lied to. The CRM upsert is idempotent (deterministic id), so a
      // retry after a failed back-link reconciles to exactly one deal.
      let dealId = deterministicDealId
      try {
        const upserted = await upsertTenderOpportunity({
          dealId: deterministicDealId,
          tenderId: effectiveTenderId,
          tenderReference: refNum || null,
          name: dealName,
          companyName,
          amount,
          stage,
          expectedCloseDate,
          notes,
        })
        if (!upserted.ok) {
          // The deal was NOT written, so no back-link may be committed: the
          // authoritative document must not claim a sync that did not happen.
          return { ok: false, error: upserted.error || 'CRM upsert failed.' }
        }
        dealId = upserted.dealId || dealId
      } catch (crmError: unknown) {
        // Same reasoning as a refused upsert: the CRM write did not complete, so
        // the tender must not be back-linked and the caller must not be told the
        // sync succeeded. The deterministic deal id makes a retry safe.
        return {
          ok: false,
          dealId: deterministicDealId,
          error: crmError instanceof Error ? crmError.message : String(crmError),
        }
      }

      // The CRM write is done; commit the back-link now, against the revision the
      // authority is actually at. A conflict here is reported as a failure — the
      // deal exists and the retry is idempotent.
      if (resolved && dealId !== resolved.tender.linkedCrmDealId) {
        const committed = await authoritativeStore.mutate(loaded.data.revision, (document) => {
          const target = findTenderById(document, resolved.tender.id)
          if (target) target.tender.linkedCrmDealId = dealId
          return document
        })
        if (!committed.ok) {
          return {
            ok: false,
            dealId,
            error:
              `The CRM deal was saved, but the tender could not be linked to it ` +
              `(${committed.error.message}). Retrying is safe.`,
            currentRevision: committed.current?.revision ?? committed.error.current?.revision,
          }
        }
      }

      return { ok: true, dealId }
    } catch (e: any) {
      return { ok: false, error: e?.message }
    }
  })

  // Cross-App: Record tender outcome on the CRM opportunity (typed port)
  ipc.handle(TENDERS_CHANNELS.updateTenderOutcome, async (_e, request: any) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const tenderId = typeof request?.tenderId === 'string' ? request.tenderId : ''
      const outcome = request?.outcome
      if (!tenderId) return { ok: false, error: 'A tender id is required.' }
      if (
        outcome !== 'won' &&
        outcome !== 'lost' &&
        outcome !== 'withdrawn' &&
        outcome !== 'cancelled'
      ) {
        return { ok: false, error: `Unknown tender outcome: ${String(outcome)}` }
      }
      const updateTenderOutcome = getIntegrations().updateTenderOutcome
      if (!updateTenderOutcome) {
        return { ok: false, error: 'CRM integration is not configured.' }
      }
      const loaded = await getAuthoritativeTendersStore().load()
      if (!loaded.ok) return { ok: false, error: loaded.error.message }
      const resolved = findTenderById(loaded.data, tenderId)
      if (!resolved) return { ok: false, error: `Tender not found: ${tenderId}` }
      const dealId =
        (typeof request?.dealId === 'string' && request.dealId) ||
        resolved.tender.linkedCrmDealId ||
        `deal-tender-${tenderId}`
      const result = await updateTenderOutcome({
        dealId,
        tenderId,
        outcome,
        amount: typeof request?.amount === 'number' ? request.amount : undefined,
        reason: typeof request?.reason === 'string' ? request.reason : undefined,
        noticeDate: typeof request?.noticeDate === 'string' ? request.noticeDate : undefined,
      })
      return result
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to record tender outcome' }
    }
  })

  ipc.handle(TENDERS_CHANNELS.openInCrm, (_e, dealId) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    const integrations = getIntegrations()
    if (integrations.openAppAt || runtime.onOpenCrm) {
      openOwningApp({ app: 'crm', entityId: typeof dealId === 'string' ? dealId : undefined })
      return { ok: true }
    }
    return { ok: false }
  })

  // Cross-App: Open Books tab
  ipc.handle(TENDERS_CHANNELS.openBooks, (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    if (getIntegrations().openAppAt || runtime.onOpenBooks) {
      openOwningApp({ app: 'books' })
      return true
    }
    return false
  })

  // Cross-App: Bill Milestone in Zano Books
  ipc.handle(
    TENDERS_CHANNELS.billMilestoneInBooks,
    async (
      _e,
      tenderIdOrPayload: string | BillMilestoneRequest,
      milestoneIdArg?: string,
    ): Promise<BillMilestoneResult | { ok: false; error: TendersPersistenceError }> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      try {
        let tenderId: string
        let milestoneId: string
        let tenderReference: string | undefined
        let customAmount: number | undefined
        let customNotes: string | undefined
        let expectedRevision: number | undefined

        if (typeof tenderIdOrPayload === 'object' && tenderIdOrPayload !== null) {
          tenderId = tenderIdOrPayload.tenderId
          milestoneId = tenderIdOrPayload.milestoneId
          tenderReference = tenderIdOrPayload.tenderReference
          customAmount = tenderIdOrPayload.amount
          customNotes = tenderIdOrPayload.notes
          expectedRevision = tenderIdOrPayload.expectedRevision
        } else {
          tenderId = String(tenderIdOrPayload || '')
          milestoneId = String(milestoneIdArg || '')
        }

        const issueMilestoneInvoice = getIntegrations().issueMilestoneInvoice
        if (!issueMilestoneInvoice) {
          return { ok: false, error: 'Books integration is not configured.' }
        }

        const authoritativeStore = getAuthoritativeTendersStore()
        const loadedTenders = await authoritativeStore.load()
        if (!loadedTenders.ok) return { ok: false, error: loadedTenders.error.message }
        const tendersData = loadedTenders.data

        const located =
          (tenderId ? findTenderById(tendersData, tenderId) : null) ??
          (() => {
            if (!tenderReference) return null
            for (const workspace of tendersData.workspaces) {
              const tender = workspace.tenders.find(
                (candidate) => candidate.referenceNumber === tenderReference,
              )
              if (tender) return { workspace, tender }
            }
            return null
          })()

        if (!located) {
          return {
            ok: false,
            error: `Tender not found: ${tenderId || tenderReference || 'unknown'}`,
          }
        }

        const foundTender = located.tender
        // Main-side demo isolation: a demonstration workspace may never raise an
        // invoice. Rejected before any reservation/side effect.
        if (located.workspace.dataOrigin === 'demo') {
          return { ok: false, error: TENDERS_DEMO_WRITE_ERROR }
        }
        const foundMilestone: ContractMilestone | undefined = foundTender.milestones?.find(
          (candidate) => candidate.id === milestoneId,
        )
        if (!foundMilestone) {
          return { ok: false, error: `Milestone not found: ${milestoneId}` }
        }

        const billingIdempotencyKey = `tender-milestone-${foundTender.id}-${foundMilestone.id}`

        // Already billed (e.g. a retry after a lost response): idempotent
        // success. Never post a second invoice. This reconciliation path is
        // exempt from the won gate below so a retry cannot double-post.
        if (foundMilestone.status === 'BILLED' || foundMilestone.billedInvoiceId) {
          return {
            ok: true,
            reconciled: true,
            invoiceId: foundMilestone.billedInvoiceId,
            invoiceNumber: foundMilestone.billedInvoiceNumber,
          }
        }

        // Won-only gating (mirrors shared/lifecycle `milestonesAllowed`): a
        // tender that is not won must not expose or raise milestone billing.
        if (foundMilestone.status !== 'REACHED') {
          return {
            ok: false,
            error: `Milestone is not reached. Current status: ${foundMilestone.status} (Milestone is not in REACHED status)`,
          }
        }

        if (!milestonesAllowed(foundTender.status)) {
          return { ok: false, error: tendersNotWonBillingError(foundTender.status) }
        }

        // The invoice amount is derived from the canonical milestone only, so a
        // caller cannot raise an invoice for an arbitrary amount on a won
        // tender. A supplied `amount` is a compatibility echo and must match the
        // milestone exactly; a mismatch is rejected rather than billed.
        const canonicalAmount = Number(foundMilestone.amount ?? 0)
        if (customAmount !== undefined) {
          const requestedAmount = Number(customAmount)
          if (!Number.isFinite(requestedAmount) || requestedAmount !== canonicalAmount) {
            return {
              ok: false,
              error: `The requested billing amount (${String(customAmount)}) does not match the milestone amount (${canonicalAmount}); the milestone amount is authoritative.`,
            }
          }
        }
        const billAmount = canonicalAmount
        if (billAmount <= 0) {
          return {
            ok: false,
            error: `Milestone billing amount must be greater than 0: ${billAmount}`,
          }
        }

        // Pre-post revision validation: `mutate` with an unchanged document is a
        // revision check, not a write (the store returns ok without committing),
        // so this is NOT a reservation. It does guarantee that a stale caller
        // posts zero invoices; a competing writer that moves the revision between
        // this check and the link commit is reconciled below, and the Books
        // idempotency key keeps it to at most one invoice.
        const reservationRevision = expectedRevision ?? tendersData.revision
        const reservation = await authoritativeStore.mutate(
          reservationRevision,
          (document) => document,
        )
        if (!reservation.ok) {
          return {
            ok: false,
            error: reservation.error.message,
            currentRevision: reservation.current?.revision ?? reservation.error.current?.revision,
          }
        }

        // Invoice identity comes from the canonical tender/milestone, never from
        // the caller: the party, the reference and the line description must not
        // be settable from a renderer payload.
        const issuer = foundTender.issuingBody || 'Issuing authority not recorded'
        const today = new Date().toISOString().split('T')[0]
        const dueDate =
          foundMilestone.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
        const ref = foundTender.referenceNumber || foundTender.id
        const mName = foundMilestone.name || foundMilestone.title || 'Delivery Milestone'
        const itemDescription = `${mName} per ${ref}`

        // Single posting path via the typed port; Books owns party resolution,
        // VAT-inclusive pricing, numbering, journal posting and persistence.
        // `billingIdempotencyKey` makes the post retry-safe.
        const invoice = await issueMilestoneInvoice({
          tenderId: foundTender.id,
          milestoneId: foundMilestone.id,
          idempotencyKey: billingIdempotencyKey,
          partyName: issuer,
          itemDescription,
          itemCode: 'TENDER-PROGRESS',
          accountId: 'acc-sales',
          accountName: 'Tender & Commercial Contracting Sales',
          amount: billAmount,
          tenderReference: ref,
          notes: customNotes || 'Payment terms: 30 days net from tax invoice submission.',
          date: today,
          dueDate,
        })

        if (!invoice.ok || !invoice.invoiceId) {
          return { ok: false, error: invoice.error || 'Failed to bill milestone in Books' }
        }

        const invoiceId = invoice.invoiceId
        const invoiceNumber = invoice.invoiceNumber

        const applyBilling = (document: TendersDataV2, at: string): void => {
          const target = findTenderById(document, foundTender.id)
          const milestone = target?.tender.milestones?.find(
            (candidate) => candidate.id === foundMilestone.id,
          )
          if (!milestone) return
          milestone.status = 'BILLED'
          milestone.billedInvoiceId = invoiceId
          milestone.billedInvoiceNumber = invoiceNumber
          milestone.billedAt = at
          milestone.billedDate = at
        }

        const nowIso = new Date().toISOString()
        let committed = await authoritativeStore.mutate(reservationRevision, (document) => {
          applyBilling(document, nowIso)
          return document
        })
        let reconciled = false
        let warning: string | undefined

        if (!committed.ok) {
          // Reconcile: a competing writer may already have billed this
          // milestone, or the revision moved. Reload once and either adopt the
          // existing billing or retry the link exactly once with the fresh
          // revision. The invoice already exists (and is deduped by key), so a
          // retry can never double-post.
          let latest = committed.current
          if (!latest) {
            const reloaded = await authoritativeStore.load()
            if (reloaded.ok) latest = reloaded.data
          }
          const latestData = latest ?? tendersData
          const latestTarget = findTenderById(latestData, foundTender.id)
          const latestMilestone = latestTarget?.tender.milestones?.find(
            (candidate) => candidate.id === foundMilestone.id,
          )
          if (latestMilestone?.status === 'BILLED' || latestMilestone?.billedInvoiceId) {
            reconciled = true
            warning = 'Milestone was already billed; reused the existing invoice.'
          } else {
            const retry = await authoritativeStore.mutate(latestData.revision, (document) => {
              applyBilling(document, nowIso)
              return document
            })
            if (retry.ok) {
              committed = retry
            } else {
              // The invoice exists (deduped by key), but this call could not
              // commit the tender link. Report failure so the UI surfaces the
              // retry; the retry reconciles without double-posting.
              return {
                ok: false,
                error:
                  'Invoice posted; the milestone link could not be committed. Retry to reconcile the tender.',
                invoiceId,
                invoiceNumber,
                tenderReference: ref,
                currentRevision: retry.current?.revision ?? latestData.revision,
              }
            }
          }
        }

        // Open the owning app at the returned invoice.
        openOwningApp({ app: 'books', entityId: invoiceId })

        return {
          ok: true,
          invoiceNumber,
          invoiceId,
          tenderReference: ref,
          grandTotal: invoice.grandTotal,
          subtotal: invoice.subtotal,
          taxTotal: invoice.taxTotal,
          ...(reconciled ? { reconciled: true } : {}),
          ...(warning ? { warning } : {}),
        }
      } catch (err: any) {
        return {
          ok: false,
          error: err?.message || 'Failed to bill milestone in Books',
        }
      }
    },
  )
}
