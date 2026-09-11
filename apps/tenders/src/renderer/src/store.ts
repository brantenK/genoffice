// Zanostack Tenders global state (Zustand): multi-company workspace with
// localStorage persistence. Each company owns its own vault, customers
// and tenders; the active company's data is exposed via derived slices
// (company / customers / vault / tenders) so existing selector call
// sites need no changes. Transient state (shred progress, pending
// viewer focus) is excluded from persistence, and blob-URL file
// references are blanked on rehydrate because object URLs die with
// the page session.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  AppPage,
  CompanyProfile,
  Customer,
  PageExtraction,
  RequirementRecord,
  SubmissionMethod,
  TenderRecord,
  TendersData,
  VaultDoc
} from '../shared/types'
import { findIssuerTemplate } from './issuer'
import { MOCK_COMPANY } from './mock/company'
import { MOCK_CUSTOMERS } from './mock/customers'
import { MOCK_VAULT } from './mock/vault'

export type View = 'list' | 'workspace'  // within the Tenders page
export type ShredStage = 'idle' | 'loading' | 'extracting' | 'shredding' | 'analysing' | 'done' | 'error'

interface ShredProgress {
  stage: ShredStage
  message: string
  page: number
  total: number
}

/** Everything a company owns, under a stable explicit id. */
export interface CompanyWorkspace {
  id: string
  name?: string
  company: CompanyProfile
  customers: Customer[]
  vault: VaultDoc[]
  tenders: TenderRecord[]
}

/** Letterhead analysis result — a recognized issuing-authority template. */
export interface IssuerTemplate {
  id: string
  /** normalized issuing-body name (uppercase, trimmed) */
  name: string
  /** display name (as lifted from the letterhead) */
  displayName: string
  /** postal / physical address lifted from the letterhead */
  address: string | null
  /** contact person + phone/email if present */
  contact: string | null
  /** e.g. "RFP Reference Number: DWS/RFP-YYYY/NNNN" style description */
  refStyle: string | null
  /** submission logistics commonly used by this issuer */
  submissionMethod: SubmissionMethod | null
  submissionAddress: string | null
  /** how many tenders from this issuer have been shredded */
  seenCount: number
  /** ISO timestamp of last sighting */
  lastSeen: string
}

interface TendersState {
  // ── navigation ──────────────────────────────────────────────────────────────
  page: AppPage
  setPage: (p: AppPage) => void

  // ── multi-company ────────────────────────────────────────────────────────────
  workspaces: CompanyWorkspace[]
  activeCompanyId: string
  setActiveCompany: (id: string) => void
  addCompany: (company: CompanyProfile) => string
  updateActiveCompany: (company: CompanyProfile) => void

  // ── company-scoped views (active company) ────────────────────────────────────
  company: CompanyProfile
  setCompany: (c: CompanyProfile) => void
  customers: Customer[]
  vault: VaultDoc[]
  tenders: TenderRecord[]
  activeCustomerId: string | null
  setActiveCustomer: (id: string | null) => void
  addCustomer: (c: Customer) => void
  removeCustomer: (id: string) => void

  // ── vault (workspace) ────────────────────────────────────────────────────
  addVaultDoc: (d: VaultDoc) => void
  updateVaultDoc: (id: string, patch: Partial<VaultDoc>) => void
  removeVaultDoc: (id: string) => void

  // ── tenders (workspace) ─────────────────────────────────────────────────────
  view: View
  activeTenderId: string | null
  activeRequirementId: string | null
  /** set when a checklist item requests viewer focus; viewer clears after scroll */
  pendingFocus: { requirementId: string; token: number } | null
  zoom: number
  currentPage: number
  shredding: ShredProgress | null

  // ── recognized issuer templates (letterhead analysis) ────────────────────────
  issuerTemplates: IssuerTemplate[]
  upsertIssuerTemplate: (tpl: IssuerTemplate) => IssuerTemplate
  removeIssuerTemplate: (id: string) => void

  // ── onboarding ───────────────────────────────────────────────────────────────
  /** persisted: has the user seen the first-launch welcome walkthrough? */
  onboardingDone: boolean
  setOnboardingDone: () => void
  /** reset so the welcome walkthrough shows again (Help menu) */
  restartOnboarding: () => void
  /** transient: is the interactive spotlight tour running? (never persisted) */
  tourActive: boolean
  startTour: () => void
  endTour: () => void

  // actions
  setView: (v: View) => void
  setActiveTender: (id: string | null) => void
  setActiveRequirement: (id: string | null) => void
  focusRequirement: (id: string) => void
  clearFocus: () => void
  setZoom: (z: number) => void
  setCurrentPage: (p: number) => void
  addTender: (t: TenderRecord) => void
  removeTender: (id: string) => void
  updateTender: (id: string, patch: Partial<TenderRecord>) => void
  updateRequirement: (tenderId: string, reqId: string, patch: Partial<RequirementRecord>) => void
  setSignatureCheck: (tenderId: string, ruleKey: string, checked: boolean) => void
  setShredding: (p: ShredProgress | null) => void
  rerunGap: () => void

  // ── main-renderer state synchronization ────────────────────────────────────
  loadFromMain: () => Promise<void>
  syncFromMain: (data: TendersData) => void
  saveToMain: () => void
}

export const SEED_TENDER_WTR_04: TenderRecord = {
  id: 'tender-wtr-04',
  title: 'Bulk Water Metering & Valve Refurbishment',
  referenceNumber: 'RFP-WTR-2026-04',
  issuingBody: 'City of Ekurhuleni Water Dept',
  closingDate: '2026-10-31',
  submissionMethod: 'PHYSICAL',
  submissionAddress: 'Civic Centre, Kempton Park, Ekurhuleni',
  signatureChecks: {},
  status: 'IN_PROGRESS',
  createdAt: '2026-08-01T08:00:00Z',
  fileName: 'RFP-WTR-2026-04.pdf',
  fileUrl: '',
  numPages: 24,
  ocrPages: 0,
  estimatedValue: 243000,
  milestones: [
    {
      id: 'ms-01',
      name: 'Phase 1 Reservoir Valve Refurbishment',
      title: 'Phase 1 Reservoir Valve Refurbishment',
      description: 'Complete overhaul of high-pressure control valves per tender specification',
      amount: 145000,
      status: 'REACHED',
      dueDate: '2026-08-30',
      completedDate: '2026-08-28',
    },
    {
      id: 'ms-02',
      name: 'Phase 2 Ultrasonic Flow Meter Installation',
      title: 'Phase 2 Ultrasonic Flow Meter Installation',
      description: 'Install and calibrate digital flow sensors across metering points',
      amount: 98000,
      status: 'PENDING',
      dueDate: '2026-11-15',
    },
  ],
  requirements: [],
}

const SEED_COMPANY_ID = 'co-thabo'

function seedWorkspaces(): CompanyWorkspace[] {
  return [
    {
      id: SEED_COMPANY_ID,
      company: { ...MOCK_COMPANY },
      customers: MOCK_CUSTOMERS,
      vault: MOCK_VAULT,
      tenders: [SEED_TENDER_WTR_04]
    }
  ]
}

let focusToken = 0
let companySeq = 0
let templateSeq = 0
let vaultSeq = 0

/** Mint a fresh vault doc id (used by the upload flow in DocumentsPage). */
export function newVaultDocId(): string {
  return `vd-${Date.now()}-${vaultSeq++}`
}

/** Derive the company-scoped slices for a given workspace list + active id. */
function deriveViews(workspaces: CompanyWorkspace[], activeCompanyId: string) {
  const ws = workspaces.find((w) => w.id === activeCompanyId) ?? workspaces[0]
  return {
    workspaces,
    activeCompanyId: ws.id,
    company: ws.company,
    customers: ws.customers,
    vault: ws.vault,
    tenders: ws.tenders
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let isSyncingFromMain = false
let lastSavedPayload: string | null = null

export function cancelPendingSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}

export function scheduleSaveToMain(): void {
  if (isSyncingFromMain) return
  if (typeof window === 'undefined' || !window.tendersApi?.saveStoredData) return

  cancelPendingSave()

  saveTimer = setTimeout(() => {
    saveTimer = null
    if (isSyncingFromMain) return
    const state = useTendersStore.getState()
    const envelope: TendersData = {
      version: 1,
      updatedAt: new Date().toISOString(),
      activeCompanyId: state.activeCompanyId,
      workspaces: state.workspaces,
      issuerTemplates: state.issuerTemplates,
    }
    const json = JSON.stringify(envelope)
    if (json === lastSavedPayload) return
    lastSavedPayload = json
    window.tendersApi?.saveStoredData(json)?.catch((err) => {
      console.error('tenders: failed to save store to main:', err)
    })
  }, 300)
}

export const useTendersStore = create<TendersState>()(
  persist(
    (set, get) => {
      /**
       * Patch the active workspace and re-sync all derived slices.
       * Every company-scoped mutation flows through here so the
       * derived slices (company/customers/vault/tenders) can never
       * drift out of sync with `workspaces`.
       */
      const patchActive = (patch: (ws: CompanyWorkspace) => Partial<CompanyWorkspace>): void => {
        const s = get()
        const workspaces = s.workspaces.map((ws) =>
          ws.id === s.activeCompanyId ? { ...ws, ...patch(ws) } : ws
        )
        const ws = workspaces.find((w) => w.id === s.activeCompanyId) ?? workspaces[0]
        set({
          workspaces,
          company: ws.company,
          customers: ws.customers,
          vault: ws.vault,
          tenders: ws.tenders
        })
      }

      const seed = seedWorkspaces()
      return {
        // ── navigation ──────────────────────────────────────────────────────────
        page: 'overview',
        setPage: (p) => set({ page: p }),

        // ── multi-company ────────────────────────────────────────────────────────
        workspaces: seed,
        activeCompanyId: SEED_COMPANY_ID,
        setActiveCompany: (id) => {
          const s = get()
          if (!s.workspaces.some((w) => w.id === id)) return
          const views = deriveViews(s.workspaces, id)
          // leaving any tender workspace context
          set({
            ...views,
            activeTenderId: null,
            activeRequirementId: null,
            activeCustomerId: null,
            view: 'list',
            currentPage: 1
          })
        },
        addCompany: (company) => {
          const id = `co-${Date.now()}-${companySeq++}`
          const ws: CompanyWorkspace = {
            id,
            company: { ...company },
            customers: [],
            vault: [],
            tenders: []
          }
          set({ workspaces: [...get().workspaces, ws] })
          get().setActiveCompany(id)
          return id
        },
        updateActiveCompany: (company) => patchActive(() => ({ company })),

        // ── company-scoped views (active company) ────────────────────────────────
        company: seed[0].company,
        setCompany: (c) => get().updateActiveCompany(c),
        customers: seed[0].customers,
        vault: seed[0].vault,
        tenders: seed[0].tenders,
        activeCustomerId: null,
        setActiveCustomer: (id) => set({ activeCustomerId: id }),
        addCustomer: (c) => patchActive((ws) => ({ customers: [...ws.customers, c] })),
        removeCustomer: (id) =>
          patchActive((ws) => ({ customers: ws.customers.filter((c) => c.id !== id) })),

        // ── vault (workspace) ──────────────────────────────────────────────
        addVaultDoc: (d) => patchActive((ws) => ({ vault: [...ws.vault, d] })),
        updateVaultDoc: (id, patch) =>
          patchActive((ws) => ({
            vault: ws.vault.map((d) => (d.id === id ? { ...d, ...patch } : d))
          })),
        removeVaultDoc: (id) =>
          patchActive((ws) => ({ vault: ws.vault.filter((d) => d.id !== id) })),

        // ── tenders (workspace) ─────────────────────────────────────────────────
        view: 'list',
        activeTenderId: null,
        activeRequirementId: null,
        pendingFocus: null,
        zoom: 1,
        currentPage: 1,
        shredding: null,

        setView: (v) => set({ view: v }),
        setActiveTender: (id) =>
          set({ activeTenderId: id, activeRequirementId: null, currentPage: 1, view: id ? 'workspace' : 'list' }),
        setActiveRequirement: (id) => set({ activeRequirementId: id }),
        focusRequirement: (id) =>
          set({
            activeRequirementId: id,
            pendingFocus: { requirementId: id, token: ++focusToken }
          }),
        clearFocus: () => set({ pendingFocus: null }),
        setZoom: (z) => set({ zoom: Math.min(3, Math.max(0.5, z)) }),
        setCurrentPage: (p) => set({ currentPage: p }),

        addTender: (t) => patchActive((ws) => ({ tenders: [...ws.tenders, t] })),

        removeTender: (id) => {
          const removingActive = get().activeTenderId === id
          patchActive((ws) => ({ tenders: ws.tenders.filter((t) => t.id !== id) }))
          if (removingActive) {
            set({ activeTenderId: null, view: 'list' })
          }
        },

        updateTender: (id, patch) =>
          patchActive((ws) => ({
            tenders: ws.tenders.map((t) => (t.id === id ? { ...t, ...patch } : t))
          })),

        updateRequirement: (tenderId, reqId, patch) =>
          patchActive((ws) => ({
            tenders: ws.tenders.map((t) =>
              t.id !== tenderId
                ? t
                : {
                    ...t,
                    requirements: t.requirements.map((r) => (r.id === reqId ? { ...r, ...patch } : r))
                  }
            )
          })),

        setSignatureCheck: (tenderId, ruleKey, checked) =>
          patchActive((ws) => ({
            tenders: ws.tenders.map((t) =>
              t.id !== tenderId
                ? t
                : { ...t, signatureChecks: { ...t.signatureChecks, [ruleKey]: checked } }
            )
          })),

        setShredding: (p) => set({ shredding: p }),

        // ── issuer templates ─────────────────────────────────────────────────────
        issuerTemplates: [],
        upsertIssuerTemplate: (tpl) => {
          // fuzzy match: same issuer under different renderings
          // ("Dept of …" vs "DEPARTMENT OF …" vs the "DWS" ref prefix)
          const existing = findIssuerTemplate(get().issuerTemplates, tpl.name, tpl.refStyle)
          if (existing) {
            const merged: IssuerTemplate = {
              ...existing,
              displayName: tpl.displayName || existing.displayName,
              address: tpl.address ?? existing.address,
              contact: tpl.contact ?? existing.contact,
              refStyle: tpl.refStyle ?? existing.refStyle,
              submissionMethod: tpl.submissionMethod ?? existing.submissionMethod,
              submissionAddress: tpl.submissionAddress ?? existing.submissionAddress,
              seenCount: existing.seenCount + 1,
              lastSeen: new Date().toISOString()
            }
            set({
              issuerTemplates: get().issuerTemplates.map((t) => (t.id === existing.id ? merged : t))
            })
            return merged
          }
          const created: IssuerTemplate = {
            ...tpl,
            // keep the incoming normalized name as the canonical template key
            name: tpl.name.toUpperCase().trim(),
            id: `iss-${Date.now()}-${templateSeq++}`,
            seenCount: Math.max(1, tpl.seenCount),
            lastSeen: new Date().toISOString()
          }
          set({ issuerTemplates: [...get().issuerTemplates, created] })
          return created
        },
        removeIssuerTemplate: (id) =>
          set({ issuerTemplates: get().issuerTemplates.filter((t) => t.id !== id) }),

        // ── onboarding ─────────────────────────────────────────────────────────
        onboardingDone: false,
        setOnboardingDone: () => set({ onboardingDone: true }),
        restartOnboarding: () => set({ onboardingDone: false }),
        tourActive: false,
        startTour: () => set({ tourActive: true }),
        endTour: () => set({ tourActive: false }),

        rerunGap: () => {
          // re-run gap analysis for the active tender (e.g. after linking docs)
          const state = get()
          const id = state.activeTenderId
          if (!id) return
          const tender = state.tenders.find((t) => t.id === id)
          if (!tender) return
          import('./gap').then(({ applyGapToRequirements }) => {
            const updated = applyGapToRequirements(tender.requirements, state.vault)
            get().updateTender(id, { requirements: updated })
          })
        },

        // ── main-renderer state synchronization ──────────────────────────────
        loadFromMain: async () => {
          if (typeof window === 'undefined' || !window.tendersApi?.getStoredData) {
            return
          }
          try {
            const rawJson = await window.tendersApi.getStoredData()
            if (rawJson) {
              const parsed = JSON.parse(rawJson) as TendersData
              if (parsed && Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0) {
                get().syncFromMain(parsed)
                return
              }
            }
            // If null or empty, seed is saved to main via saveStoredData
            const state = get()
            const seedEnvelope: TendersData = {
              version: 1,
              updatedAt: new Date().toISOString(),
              activeCompanyId: state.activeCompanyId || SEED_COMPANY_ID,
              workspaces: state.workspaces && state.workspaces.length > 0 ? state.workspaces : seedWorkspaces(),
              issuerTemplates: state.issuerTemplates || [],
            }
            const seedJson = JSON.stringify(seedEnvelope)
            lastSavedPayload = seedJson
            await window.tendersApi.saveStoredData(seedJson)
          } catch (err) {
            console.error('tenders: failed to load store from main:', err)
          }
        },

        syncFromMain: (data: TendersData) => {
          cancelPendingSave()
          if (!data || !Array.isArray(data.workspaces) || data.workspaces.length === 0) return

          lastSavedPayload = JSON.stringify(data)

          isSyncingFromMain = true
          try {
            const activeCompanyId = data.activeCompanyId || data.workspaces[0].id
            const views = deriveViews(data.workspaces, activeCompanyId)
            set({
              ...views,
              issuerTemplates: data.issuerTemplates || [],
              shredding: null,
              pendingFocus: null,
              tourActive: false,
            })
          } finally {
            isSyncingFromMain = false
          }
        },

        saveToMain: () => {
          scheduleSaveToMain()
        }
      }
    },
    {
      name: 'zanostack-tenders-v1',
      version: 1,
      partialize: (s) => ({
        page: s.page,
        workspaces: s.workspaces.map((ws) => ({
          ...ws,
          // Only blank fileUrl if it strictly starts with 'blob:'.
          // Stored disk paths (documents/... or vault/...) survive reloads.
          tenders: ws.tenders.map((t) =>
            t.fileUrl?.startsWith('blob:') ? { ...t, fileUrl: '' } : t
          ),
          // vault docs: only blob: URLs die with the session — static /demo/*
          // and stored paths survive reload, so blank ONLY the blob: ones.
          vault: ws.vault.map((d) =>
            d.fileUrl?.startsWith('blob:') ? { ...d, fileUrl: null } : d
          )
        })),
        activeCompanyId: s.activeCompanyId,
        activeCustomerId: s.activeCustomerId,
        view: s.view,
        activeTenderId: s.activeTenderId,
        activeRequirementId: s.activeRequirementId,
        zoom: s.zoom,
        currentPage: s.currentPage,
        issuerTemplates: s.issuerTemplates,
        onboardingDone: s.onboardingDone
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        // Ensure default seed tender RFP-WTR-2026-04 exists if tender list is empty
        for (const ws of state.workspaces) {
          if (!ws.tenders || ws.tenders.length === 0) {
            ws.tenders = [SEED_TENDER_WTR_04]
          } else if (!ws.tenders.some((t) => t.id === 'tender-wtr-04' || t.referenceNumber === 'RFP-WTR-2026-04')) {
            ws.tenders.push(SEED_TENDER_WTR_04)
          }
        }
        // Only wipe fileUrl if it strictly starts with 'blob:'
        state.workspaces = state.workspaces.map((ws) => ({
          ...ws,
          tenders: ws.tenders.map((t) =>
            t.fileUrl?.startsWith('blob:') ? { ...t, fileUrl: '' } : t
          ),
          // safety net for any blob: vault URL that slipped into storage
          vault: ws.vault.map((d) =>
            d.fileUrl?.startsWith('blob:') ? { ...d, fileUrl: null } : d
          )
        }))
        const activeWs = state.workspaces.find((w) => w.id === state.activeCompanyId) ?? state.workspaces[0]
        if (activeWs) {
          state.tenders = activeWs.tenders
        }
        // transient state must never leak in from storage
        state.shredding = null
        state.pendingFocus = null
        state.tourActive = false
      }
    }
  )
)

useTendersStore.subscribe((state, prevState) => {
  if (isSyncingFromMain) return
  if (
    state.workspaces !== prevState.workspaces ||
    state.activeCompanyId !== prevState.activeCompanyId ||
    state.issuerTemplates !== prevState.issuerTemplates
  ) {
    scheduleSaveToMain()
  }
})

export const useTenderGuard = useTendersStore

/** Convenience selector: active tender object. */
export const selectActiveTender = (s: TendersState): TenderRecord | null =>
  s.tenders.find((t) => t.id === s.activeTenderId) ?? null

/** Convenience selector: active company workspace. */
export const selectActiveCompanyWs = (s: TendersState): CompanyWorkspace =>
  s.workspaces.find((w) => w.id === s.activeCompanyId) ?? s.workspaces[0]

/** Build a TenderRecord from a completed shred. */
export function buildTenderRecord(
  id: string,
  fileName: string,
  fileUrl: string,
  ex: PageExtraction,
  requirements: RequirementRecord[],
  title: string,
  meta: {
    referenceNumber: string | null
    issuingBody: string | null
    closingDate: string | null
    submissionMethod: SubmissionMethod | null
    submissionAddress: string | null
  }
): TenderRecord {
  return {
    id,
    title,
    referenceNumber: meta.referenceNumber,
    issuingBody: meta.issuingBody,
    closingDate: meta.closingDate,
    submissionMethod: meta.submissionMethod,
    submissionAddress: meta.submissionAddress,
    signatureChecks: {},
    status: 'IN_PROGRESS',
    createdAt: new Date().toISOString(),
    fileName,
    fileUrl,
    numPages: ex.numPages,
    ocrPages: ex.ocrPages,
    requirements
  }
}
