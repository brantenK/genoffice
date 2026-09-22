# Technical Blueprint: Renderer v2 Persistence Cutover (Task 2B)

## Executive Summary
This document specifies the complete technical blueprint and implementation plan for Phase 2, Task 2B of the Tenders hardening initiative in `apps/tenders`. 
The renderer store is cut over from legacy `localStorage` persistence and legacy IPC (`getStoredData` / `saveStoredData`) to the authoritative, compare-and-swap (CAS) v2 store (`loadStoreV2`, `saveStoreV2`, `onStoreChangedV2`).
All domain records (workspaces, tenders, customers, vault documents) are purged from `localStorage`.
A dedicated theme-compliant `SaveStatus` indicator is integrated into the workspace chrome to surface Loading, Saving, Saved, Save Failed (with Retry), and Revision Conflict (with Reload).
Furthermore, PDF extraction bounding box normalization (`clampNormalizedBox`) is specified to resolve the IEEE-754 coordinate overflow that triggers schema rejections.

---

## 1. Problem Statement & Baseline Survey

### 1.1 Legacy Architecture Weaknesses
1. **Dual Source of Truth**:
   - `apps/tenders/src/renderer/src/store.ts` uses Zustand's `persist` middleware configured with key `'zanostack-tenders-v1'`.
   - The entire domain state (`workspaces`, `tenders`, `customers`, `vault`, `issuerTemplates`) is serialized to the browser's `localStorage`.
   - On rehydration (`onRehydrateStorage`), if `workspaces` is empty, it automatically synthesizes demo seed data (`SEED_TENDER_WTR_04`), preventing clean first-run workspaces.
   - Saves to the main process are asynchronously debounced via `saveStoredData(json)` without revision tracking or atomic concurrency control.
2. **Silent Overwrites & Conflict Blindness**:
   - Multiple windows or external operations (e.g., cross-app milestone billing from Books or CRM sync) mutating `tenders-data.json` can be blindly overwritten by stale renderer state.
   - When save fails, errors are logged to console (`console.error`), leaving the user believing changes are saved while local edits might be lost on tab close or reload.
3. **Bounding Box Float Invariant Violation**:
   - During PDF shredding (`extractSinglePage` in `extract.ts`), coordinate math produces bounding boxes where `left + width > 1` by minute floating point drift (e.g. `1.009205882`).
   - The v2 schema strictly enforces `left + width <= 1` and `top + height <= 1`. Unclamped boxes cause the authoritative store's `validateTendersDataV2` to reject the entire document on `saveStoreV2` or `syncWithCrm`.

### 1.2 Available v2 Foundation (Already Implemented in Phase 1 & 2A)
- **Schema & DTOs**: `apps/tenders/src/shared/tenders-schema.ts` and `tenders-persistence.ts` define `TendersDataV2`, `SaveTendersRequest`, `SaveTendersResult`, `TendersLoadResult`.
- **Authoritative Store**: `apps/tenders/src/main/tenders-store.ts` provides atomic temp-file write, rename, fsync, readback, CAS revision checks (`expectedRevision`), and lock queues.
- **IPC & Preload Bridge**: `apps/tenders/src/preload/index.ts` and `apps/tenders/src/shared/ipc.ts` expose:
  - `window.tendersApi.loadStoreV2(): Promise<TendersLoadResult>`
  - `window.tendersApi.saveStoreV2(req: SaveTendersRequest): Promise<SaveTendersResult>`
  - `window.tendersApi.onStoreChangedV2(cb: (data: TendersDataV2) => void): () => void`
- **RED Test Specification**: `apps/tenders/tests/renderer-store-v2.test.ts` exists with 12 comprehensive unit/integration test cases encoding every target requirement.
- **Draft Components**: `apps/tenders/src/renderer/src/components/SaveStatus.tsx` and `FirstRunEmpty.tsx` are already drafted with full GenOffice CSS theme compliance.

---

## 2. Store Architecture Blueprint (`apps/tenders/src/renderer/src/store.ts`)

### 2.1 State Model
Extend `TendersState` with authoritative persistence lifecycle fields:

```ts
export type HydrationStatus = 'loading' | 'ready' | 'error'
export type SaveStatus = 'loading' | 'saving' | 'saved' | 'error' | 'conflict'

export interface TendersState {
  // Navigation & UI preferences (persisted in localStorage)
  page: AppPage
  setPage: (p: AppPage) => void
  view: View
  setView: (v: View) => void
  zoom: number
  setZoom: (z: number) => void
  currentPage: number
  setCurrentPage: (p: number) => void
  onboardingDone: boolean
  setOnboardingDone: () => void
  restartOnboarding: () => void
  tourActive: boolean
  startTour: () => void
  endTour: () => void

  // Multi-company domain records (NOT in localStorage; authoritative in v2 store)
  workspaces: TendersWorkspaceV2[]
  activeCompanyId: string | null
  setActiveCompany: (id: string) => void
  addCompany: (company: CompanyProfile) => string
  updateActiveCompany: (company: CompanyProfile) => void

  // Active company derived slices
  company: CompanyProfile
  setCompany: (c: CompanyProfile) => void
  customers: Customer[]
  vault: VaultDoc[]
  tenders: TenderRecord[]
  activeCustomerId: string | null
  setActiveCustomer: (id: string | null) => void
  addCustomer: (c: Customer) => void
  removeCustomer: (id: string) => void

  // Workspace sub-slices
  activeTenderId: string | null
  activeRequirementId: string | null
  pendingFocus: { requirementId: string; token: number } | null
  shredding: ShredProgress | null
  issuerTemplates: IssuerTemplate[]

  // Authoritative v2 Store State & Actions
  hydrationStatus: HydrationStatus
  hydrationError: string | null
  saveStatus: SaveStatus
  saveError: string | null
  hasWorkspaces: boolean

  hydrateFromMain: () => Promise<void>
  reloadCommittedFromMain: () => Promise<void>
  retrySave: () => void

  // Actions
  // ... addVaultDoc, updateVaultDoc, removeVaultDoc, addTender, removeTender, updateTender, updateRequirement, setSignatureCheck, rerunGap
}
```

### 2.2 Module-Level Lifecycle Tracking
To avoid race conditions, stale closures, and duplicate migration calls in React StrictMode:

```ts
let committedRevision = 0
let isSyncingFromMain = false
let isMigrating = false
let isHydrating = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let storeChangedUnsub: (() => void) | null = null
```

### 2.3 Safe Empty Fallback for Company Views
When `workspaces` is empty (`hasWorkspaces === false`), derived slices must not be undefined or crash on string methods:

```ts
export const EMPTY_COMPANY: CompanyProfile = {
  name: '',
  tradingName: '',
  registrationNumber: '',
  vatNumber: '',
  taxPin: '',
  bbbeeLevel: '',
  bbbeeBlackOwnership: '',
  csdSupplierNumber: '',
  founded: '',
  employees: '',
  industry: '',
  description: '',
  address: '',
  phone: '',
  email: '',
  website: '',
  directors: [],
  projects: [],
}

function deriveViews(workspaces: TendersWorkspaceV2[], activeCompanyId: string | null) {
  const ws = workspaces.find((w) => w.id === activeCompanyId) ?? workspaces[0]
  if (!ws) {
    return {
      workspaces,
      activeCompanyId: null,
      company: EMPTY_COMPANY,
      customers: [],
      vault: [],
      tenders: [],
      hasWorkspaces: false,
    }
  }
  return {
    workspaces,
    activeCompanyId: ws.id,
    company: ws.company,
    customers: ws.customers,
    vault: ws.vault,
    tenders: ws.tenders,
    hasWorkspaces: true,
  }
}
```

### 2.4 Hydration Implementation (`hydrateFromMain`)
Handling the four distinct load outcomes:

```ts
hydrateFromMain: async () => {
  if (typeof window === 'undefined' || !window.tendersApi?.loadStoreV2) {
    set({ hydrationStatus: 'ready' })
    return
  }

  // Ensure multi-window broadcast listener is registered
  if (!storeChangedUnsub && window.tendersApi?.onStoreChangedV2) {
    storeChangedUnsub = window.tendersApi.onStoreChangedV2((externalDoc: TendersDataV2) => {
      // Ignore echoes of already-current or older revision
      if (externalDoc.revision <= committedRevision) return
      committedRevision = externalDoc.revision
      isSyncingFromMain = true
      try {
        const activeId = externalDoc.activeCompanyId || (externalDoc.workspaces[0]?.id ?? null)
        const views = deriveViews(externalDoc.workspaces, activeId)
        set({
          ...views,
          issuerTemplates: externalDoc.issuerTemplates || [],
          saveStatus: 'saved',
          saveError: null,
        })
      } finally {
        isSyncingFromMain = false
      }
    })
  }

  if (isHydrating) return
  isHydrating = true
  set({ hydrationStatus: 'loading', hydrationError: null })

  try {
    const res = await window.tendersApi.loadStoreV2()
    if (!res.ok) {
      set({
        hydrationStatus: 'error',
        hydrationError: res.error.message || 'Unable to read Tenders data.',
        saveStatus: 'error',
        saveError: res.error.message || 'Store load failed.',
      })
      return
    }

    committedRevision = res.data.revision

    if (res.status === 'not-found') {
      // 1. not-found: clean empty workspace with zero demo seeding
      isSyncingFromMain = true
      try {
        set({
          workspaces: [],
          activeCompanyId: null,
          company: EMPTY_COMPANY,
          customers: [],
          vault: [],
          tenders: [],
          issuerTemplates: [],
          hasWorkspaces: false,
          hydrationStatus: 'ready',
          hydrationError: null,
          saveStatus: 'saved',
          saveError: null,
        })
      } finally {
        isSyncingFromMain = false
      }
      return
    }

    if (res.status === 'loaded') {
      // 2. loaded: adopt committed snapshot directly
      isSyncingFromMain = true
      try {
        const activeId = res.data.activeCompanyId || (res.data.workspaces[0]?.id ?? null)
        const views = deriveViews(res.data.workspaces, activeId)
        set({
          ...views,
          issuerTemplates: res.data.issuerTemplates || [],
          hasWorkspaces: res.data.workspaces.length > 0,
          hydrationStatus: 'ready',
          hydrationError: null,
          saveStatus: 'saved',
          saveError: null,
        })
      } finally {
        isSyncingFromMain = false
      }
      return
    }

    if (res.status === 'migrated') {
      // 3. migrated: adopt data, commit once at expectedRevision 0 if needsSave is true
      isSyncingFromMain = true
      try {
        const activeId = res.data.activeCompanyId || (res.data.workspaces[0]?.id ?? null)
        const views = deriveViews(res.data.workspaces, activeId)
        set({
          ...views,
          issuerTemplates: res.data.issuerTemplates || [],
          hasWorkspaces: res.data.workspaces.length > 0,
          hydrationStatus: 'ready',
          hydrationError: null,
        })
      } finally {
        isSyncingFromMain = false
      }

      if (res.needsSave && !isMigrating) {
        isMigrating = true
        try {
          const saveRes = await window.tendersApi.saveStoreV2({
            expectedRevision: 0,
            document: res.data,
          })
          if (saveRes.ok) {
            committedRevision = saveRes.data.revision
            set({ saveStatus: 'saved', saveError: null })
          } else {
            set({
              saveStatus: saveRes.error.code === 'REVISION_CONFLICT' ? 'conflict' : 'error',
              saveError: saveRes.error.message,
            })
          }
        } catch (saveErr) {
          set({
            saveStatus: 'error',
            saveError: saveErr instanceof Error ? saveErr.message : String(saveErr),
          })
        }
      }
      return
    }
  } catch (err) {
    set({
      hydrationStatus: 'error',
      hydrationError: err instanceof Error ? err.message : String(err),
      saveStatus: 'error',
      saveError: err instanceof Error ? err.message : String(err),
    })
  } finally {
    isHydrating = false
  }
}
```

### 2.5 Mutation Persistence Pipeline (`scheduleSaveToMain`)
```ts
export function cancelPendingSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}

export function scheduleSaveToMain(): void {
  if (isSyncingFromMain) return
  if (typeof window === 'undefined' || !window.tendersApi?.saveStoreV2) return

  const currentStatus = useTendersStore.getState().saveStatus
  if (currentStatus === 'conflict') {
    // Never blind-write when conflicted!
    return
  }

  cancelPendingSave()

  saveTimer = setTimeout(async () => {
    saveTimer = null
    const s = useTendersStore.getState()
    if (s.saveStatus === 'conflict') return

    const expectedRevision = committedRevision
    const document: TendersDataV2 = {
      schemaVersion: 2,
      revision: expectedRevision,
      updatedAt: new Date().toISOString(),
      activeCompanyId: s.activeCompanyId,
      workspaces: s.workspaces,
      issuerTemplates: s.issuerTemplates || [],
    }

    useTendersStore.setState({ saveStatus: 'saving', saveError: null })

    try {
      const result = await window.tendersApi!.saveStoreV2({
        expectedRevision,
        document,
      })

      if (result.ok) {
        committedRevision = result.data.revision
        useTendersStore.setState({ saveStatus: 'saved', saveError: null })
      } else {
        if (result.error.code === 'REVISION_CONFLICT') {
          useTendersStore.setState({ saveStatus: 'conflict', saveError: result.error.message })
        } else {
          useTendersStore.setState({ saveStatus: 'error', saveError: result.error.message })
        }
      }
    } catch (err) {
      useTendersStore.setState({
        saveStatus: 'error',
        saveError: err instanceof Error ? err.message : String(err),
      })
    }
  }, 300)
}
```

### 2.6 Retry and Reload Actions
```ts
retrySave: () => {
  cancelPendingSave()
  scheduleSaveToMain()
},

reloadCommittedFromMain: async () => {
  if (typeof window === 'undefined' || !window.tendersApi?.loadStoreV2) return
  cancelPendingSave()
  set({ saveStatus: 'loading', saveError: null })
  try {
    const res = await window.tendersApi.loadStoreV2()
    if (res.ok) {
      committedRevision = res.data.revision
      isSyncingFromMain = true
      try {
        const activeId = res.data.activeCompanyId || (res.data.workspaces[0]?.id ?? null)
        const views = deriveViews(res.data.workspaces, activeId)
        set({
          ...views,
          issuerTemplates: res.data.issuerTemplates || [],
          hasWorkspaces: res.data.workspaces.length > 0,
          saveStatus: 'saved',
          saveError: null,
        })
      } finally {
        isSyncingFromMain = false
      }
    } else {
      set({ saveStatus: 'error', saveError: res.error.message })
    }
  } catch (err) {
    set({ saveStatus: 'error', saveError: err instanceof Error ? err.message : String(err) })
  }
}
```

### 2.7 Zustand Persist Configuration
Replace `'zanostack-tenders-v1'` with `'zanostack-tenders-ui'`. Strip all domain data:
```ts
persist(
  (set, get) => ({
    // ... store definition
  }),
  {
    name: 'zanostack-tenders-ui',
    version: 1,
    partialize: (s) => ({
      page: s.page,
      view: s.view,
      zoom: s.zoom,
      currentPage: s.currentPage,
      onboardingDone: s.onboardingDone,
      activeTenderId: s.activeTenderId,
      activeRequirementId: s.activeRequirementId,
    }),
    onRehydrateStorage: () => (state) => {
      if (!state) return
      // Clear transient state only. Do NOT synthesize mock data!
      state.shredding = null
      state.pendingFocus = null
      state.tourActive = false
    }
  }
)
```

---

## 3. UI Hydration & Component Integration (`App.tsx`, `SaveStatus.tsx`, `FirstRunEmpty.tsx`)

### 3.1 `apps/tenders/src/renderer/src/components/App.tsx`
Replace legacy `loadFromMain` and `onDataChanged`:
1. **Hydration Lifecycle**:
   ```tsx
   useEffect(() => {
     void useTendersStore.getState().hydrateFromMain()
   }, [])
   ```
2. **Four Hydration States**:
   - `hydrationStatus === 'loading'`: Render a calm loading indicator (centered spinner with GenOffice theme colors).
   - `hydrationStatus === 'error'`: Render an explicit error state (`Unable to load Tenders data`, with error detail and `hydrateFromMain` retry button). Do NOT render empty workspace or trigger overwrite.
   - `hydrationStatus === 'ready' && !hasWorkspaces`: Render `FirstRunEmpty` with `onCreateCompany={() => setAddingCompany(true)}`.
   - `hydrationStatus === 'ready' && hasWorkspaces`: Render the full application workspace.
3. **Mounting `SaveStatus`**:
   - In `Workspace.tsx` top header toolbar (`div.ml-auto.flex.items-center`).
   - In `App.tsx` top-right chrome or sidebar header so that save status, saving spinner, save failures (with Retry), and conflicts (with Reload) are visible on every page.

---

## 4. PDF Bounding Box Clamp (`extract.ts` & `pdf-box-bounds.test.ts`)

In `apps/tenders/src/renderer/src/pdf/extract.ts`:
Export `clampNormalizedBox` and `unionBoxes` to strictly satisfy `0 <= left + width <= 1` and `0 <= top + height <= 1`:

```ts
export function clampNormalizedBox(box: BoundingBox): BoundingBox {
  const left = Math.max(0, Math.min(1, box.left))
  const top = Math.max(0, Math.min(1, box.top))
  const width = Math.max(0, Math.min(1 - left, box.width))
  const height = Math.max(0, Math.min(1 - top, box.height))
  return { left, top, width, height }
}

export function unionBoxes(boxes: BoundingBox[]): BoundingBox {
  if (boxes.length === 0) return { top: 0, left: 0, width: 0, height: 0 }
  const top = Math.max(0, Math.min(1, Math.min(...boxes.map((b) => b.top))))
  const left = Math.max(0, Math.min(1, Math.min(...boxes.map((b) => b.left))))
  const bottom = Math.max(0, Math.min(1, Math.max(...boxes.map((b) => b.top + b.height))))
  const right = Math.max(0, Math.min(1, Math.max(...boxes.map((b) => b.left + b.width))))
  return clampNormalizedBox({
    top,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  })
}
```
Apply `clampNormalizedBox` in `extractSinglePage` when pushing items to `items`:
```ts
box: clampNormalizedBox({
  top: top / viewport.height,
  left: left / viewport.width,
  width: (right - left) / viewport.width,
  height: (bottom - top) / viewport.height,
})
```
This immediately turns all 8 tests in `apps/tenders/tests/pdf-box-bounds.test.ts` from RED to GREEN.

---

## 5. Implementation Sequence for the Worker

1. **Step 1: Export Box Clamping in `extract.ts`**:
   - Implement and export `clampNormalizedBox` and `unionBoxes` in `apps/tenders/src/renderer/src/pdf/extract.ts`.
   - Verify: `npm test -w @genoffice/tenders -- tests/pdf-box-bounds.test.ts` (8 passing).
2. **Step 2: Implement Store v2 in `store.ts`**:
   - Update `useTendersStore` with `hydrateFromMain`, `reloadCommittedFromMain`, `retrySave`, `hasWorkspaces`, `hydrationStatus`, `saveStatus`, etc.
   - Configure UI-only localStorage persistence under `zanostack-tenders-ui`.
   - Verify: `npm test -w @genoffice/tenders -- tests/renderer-store-v2.test.ts` (all 12 passing).
3. **Step 3: Update `App.tsx` & Mount `SaveStatus`**:
   - Wire `hydrateFromMain()` in `App.tsx`'s `useEffect`.
   - Add loading and error boundary screens.
   - Render `FirstRunEmpty` when `!hasWorkspaces`.
   - Mount `<SaveStatus />` in `App.tsx` and `Workspace.tsx`.
   - Clean up outdated copy in `TutorialsPage.tsx`.
4. **Step 4: Full Validation & Guard Verification**:
   - `npm test -w @genoffice/tenders` (all 608 tests pass with 0 failures).
   - `npm run typecheck -w @genoffice/tenders` (0 errors).
   - `npm run build -w @genoffice/tenders` and `npm run build -w @genoffice/shell` (both build clean).
   - `npm run check:theme-colors` (clean, 0 raw hex/rgb).
   - `npm run format:check` (clean).
