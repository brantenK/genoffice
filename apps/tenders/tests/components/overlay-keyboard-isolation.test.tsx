/**
 * Dialog-over-drawer keyboard isolation (F7).
 *
 * A drawer and the confirm dialog that opens over it each register a
 * window-capture keydown trap (`useOverlayBehaviour`). Both fire per keydown —
 * `stopPropagation()` does not stop same-node listeners — so while the dialog
 * is open the drawer's trap still answers Escape and Tab:
 *
 *   * Escape: `MilestonesDrawer`'s confirm ("Create a tax invoice in Zano
 *     Books?") closed the drawer AND the dialog; only the dialog owns Escape.
 *   * Tab: the drawer's trap saw the focused control as outside its own
 *     focusable list and redirected focus back into the drawer, so forward Tab
 *     could never reach the dialog's confirm action.
 *
 * These are real-mount reproductions through `tests/helpers/render.tsx` of the
 * two drawers that mount a confirm dialog as a sibling overlay, exercising the
 * actual trap wiring (`Dialog.tsx` / `Drawer.tsx`), not a listener-code model.
 *
 * jsdom has no layout engine: `getClientRects()` is empty for every element,
 * which would make the traps' focusable lists empty and the Tab assertions
 * vacuous. The focusable list is what decides where the drawer's trap sends
 * focus, so `getClientRects` is stubbed to a non-empty rect for connected
 * elements — the same seam `drawer-toolbar-offset.test.ts` uses for geometry —
 * making the trap behave as it does in a real browser.
 *
 * The contract pinned here is the `aria-modal` isolation promise: a modal
 * dialog is the topmost overlay and owns Escape and Tab; the drawer underneath
 * must not capture keys while it is open, and the drawer's view state survives
 * Escape on the dialog.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusableWithin } from '../../src/renderer/src/components/Dialog'
import { MilestonesDrawer } from '../../src/renderer/src/components/MilestonesDrawer'
import { TrashDrawer } from '../../src/renderer/src/components/TrashDrawer'
import type {
  CompanyProfile,
  ContractMilestone,
  Customer,
  TenderRecord,
  TendersDataV2,
  TendersWorkspaceV2,
  VaultDoc,
} from '../../src/shared/types'
import type {
  ManagedFileTrashEntry,
  SaveTendersRequest,
  SaveTendersResult,
  TendersLoadResult,
} from '../../src/shared/tenders-persistence'
import { mount, unmountAll } from '../helpers/render'

const STORE_MODULE = '../../src/renderer/src/store'
const AT = '2026-09-01T00:00:00.000Z'

/** Dispatch a real window keydown inside `act`; reports whether it was prevented. */
function press(key: string): boolean {
  let prevented = false
  act(() => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    prevented = !window.dispatchEvent(event)
  })
  return prevented
}

/** A connected element has a rect (real-browser trap behaviour); detached has none. */
function stubClientRects(): void {
  const fakeRect = {
    x: 0,
    y: 0,
    top: 0,
    bottom: 10,
    left: 0,
    right: 10,
    width: 10,
    height: 10,
    toJSON: () => ({}),
  } as unknown as DOMRect
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.isConnected ? [fakeRect] : []) as unknown as DOMRectList
  })
}

function trashEntry(): ManagedFileTrashEntry {
  return {
    id: 't1',
    recordId: 'r1',
    fileName: 'cert.pdf',
    category: 'vault',
    size: 1234,
    hash: 'h1',
    trashedAt: AT,
    deletedFrom: 'vault/cert.pdf',
    trashedPath: '.trash/cert.pdf',
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  unmountAll()
  ;(window as unknown as Record<string, unknown>).tendersApi = undefined
})

describe('TrashDrawer defers to its Empty-the-trash confirm dialog', () => {
  beforeEach(() => {
    stubClientRects()
  })

  async function openConfirm() {
    ;(window as unknown as Record<string, unknown>).tendersApi = {
      listDocumentTrash: vi.fn().mockResolvedValue({ ok: true, entries: [trashEntry()] }),
    }
    let closed = false
    const view = mount(<TrashDrawer onClose={() => { closed = true }} />)
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
    view.click(view.getByText('Empty trash'))
    const dialog = view.getByTestId('trash-empty-dialog')
    return { view, dialog, closed: () => closed }
  }

  it('Escape on the dialog closes only the dialog; the drawer and its view survive', async () => {
    const { view, dialog, closed } = await openConfirm()
    const drawer = view.getByTestId('trash-drawer')

    press('Escape')

    expect(view.queryByTestId('trash-empty-dialog'), 'Escape closed the dialog').toBeNull()
    expect(view.getByTestId('trash-drawer'), 'the drawer stays open').toBe(drawer)
    expect(closed(), 'the drawer itself was not closed').toBe(false)
    expect(view.text(), 'the drawer view state survives').toContain('cert.pdf')
  })

  it('forward Tab stays inside the dialog and reaches the confirm action', async () => {
    const { view, dialog, closed } = await openConfirm()
    const dialogPanel = dialog.querySelector<HTMLElement>('[role="dialog"]')
    const cancel = dialogPanel!.querySelector<HTMLElement>('[data-autofocus]')!
    const confirm = view.getByTestId('trash-empty-confirm')
    cancel.focus()

    // Cancel's immediate next tab stop is the confirm action: a browser's
    // forward Tab from Cancel lands on it, and no trap may intercept that.
    const tabOrder = focusableWithin(dialogPanel!)
    expect(tabOrder, 'Cancel is a dialog tab stop').toContain(cancel)
    expect(
      tabOrder[tabOrder.indexOf(cancel) + 1],
      'forward Tab from Cancel reaches the confirm action',
    ).toBe(confirm)
    const prevented = press('Tab')
    expect(prevented, 'the drawer trap must not intercept forward Tab').toBe(false)
    expect(
      dialogPanel!.contains(document.activeElement),
      'focus never leaves the dialog (the drawer trap must not steal it)',
    ).toBe(true)

    // From the confirm (the dialog's last control) the dialog trap wraps back
    // to its first control — still inside the dialog, never into the drawer.
    confirm.focus()
    press('Tab')
    expect(
      dialogPanel!.contains(document.activeElement),
      'wrap-around stays in the dialog, not the drawer',
    ).toBe(true)
    expect(closed(), 'Tab never closes the drawer').toBe(false)
  })
})

describe('MilestonesDrawer defers to its Create-invoice confirm dialog', () => {
  beforeEach(() => {
    stubClientRects()
  })

  async function openConfirm() {
    const api = {
      loadStoreV2: vi.fn(),
      saveStoreV2: vi.fn(),
      onStoreChangedV2: vi.fn(() => () => {}),
      billMilestoneInBooks: vi.fn(),
      openBooks: vi.fn(),
    }
    ;(window as unknown as Record<string, unknown>).tendersApi = api
    api.loadStoreV2.mockResolvedValue({
      ok: true,
      status: 'loaded',
      data: documentV2(tender()),
      needsSave: false,
      warnings: [],
    } as TendersLoadResult)
    api.saveStoreV2.mockImplementation(async (request: SaveTendersRequest) => {
      const result: SaveTendersResult = {
        ok: true,
        data: {
          ...clone(request.document),
          revision: request.expectedRevision + 1,
          updatedAt: AT,
        },
      }
      return result
    })
    const mod = (await import(STORE_MODULE)) as unknown as {
      useTendersStore: { getState: () => any }
    }
    await mod.useTendersStore.getState().hydrateFromMain()
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
    mod.useTendersStore.getState().setActiveTender('tender-1')

    let closed = false
    const view = mount(<MilestonesDrawer onClose={() => { closed = true }} />)
    view.click(view.getByText('Bill Milestone in Zano Books'))
    const dialog = view.getByRole('dialog', { name: 'Create a tax invoice in Zano Books?' })
    return { view, dialog, closed: () => closed }
  }

  it('Escape on the dialog closes only the dialog; the drawer and its view survive', async () => {
    const { view, dialog, closed } = await openConfirm()
    const dialogPanel = dialog as HTMLElement
    const drawer = view.getByRole('dialog', { name: 'Contract Milestones' })

    press('Escape')

    expect(
      view.queryByRole('dialog', { name: 'Create a tax invoice in Zano Books?' }),
      'Escape closed the confirm dialog',
    ).toBeNull()
    expect(view.getByRole('dialog', { name: 'Contract Milestones' }), 'the drawer stays open').toBe(
      drawer,
    )
    expect(closed(), 'the drawer itself was not closed').toBe(false)
    expect(view.text(), 'the drawer view state survives').toContain('Phase 1 — Mobilisation')
  })

  it('forward Tab stays inside the dialog and reaches the confirm action', async () => {
    const { view, dialog, closed } = await openConfirm()
    const dialogPanel = dialog as HTMLElement
    const cancel = view.getByRole('button', { name: 'Cancel' })
    const confirm = view.getByRole('button', { name: 'Create the invoice' })
    cancel.focus()

    // Cancel's immediate next tab stop is the confirm action: a browser's
    // forward Tab from Cancel lands on it, and no trap may intercept that.
    const tabOrder = focusableWithin(dialogPanel!)
    expect(tabOrder, 'Cancel is a dialog tab stop').toContain(cancel)
    expect(
      tabOrder[tabOrder.indexOf(cancel) + 1],
      'forward Tab from Cancel reaches the confirm action',
    ).toBe(confirm)
    const prevented = press('Tab')
    expect(prevented, 'the drawer trap must not intercept forward Tab').toBe(false)
    expect(
      dialogPanel!.contains(document.activeElement),
      'focus never leaves the dialog (the drawer trap must not steal it)',
    ).toBe(true)

    // From the confirm (the dialog's last control) the dialog trap wraps back
    // to its first control — still inside the dialog, never into the drawer.
    confirm.focus()
    press('Tab')
    expect(
      dialogPanel!.contains(document.activeElement),
      'wrap-around stays in the dialog, not the drawer',
    ).toBe(true)
    expect(closed(), 'Tab never closes the drawer').toBe(false)
  })
})

// ── fixtures (mirrors tests/milestones-billing-feedback.test.ts) ──────────────

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function company(): CompanyProfile {
  return {
    name: 'Test Co',
    tradingName: 'Test Co',
    registrationNumber: 'REG-1',
    vatNumber: 'VAT-1',
    taxPin: 'TAX-1',
    bbbeeLevel: 'Level 2',
    bbbeeBlackOwnership: '51%',
    csdSupplierNumber: 'CSD-1',
    founded: '2019',
    employees: '25',
    industry: 'Construction',
    description: 'Synthetic company.',
    address: '1 Test Street',
    phone: '+27 10 000 0000',
    email: 'test@example.test',
    website: 'https://example.test',
    directors: [],
    projects: [],
  }
}

function customer(): Customer {
  return {
    id: 'cust-1',
    name: 'Example Customer',
    contactName: 'Contact',
    contactEmail: 'c@example.test',
    contactPhone: '+27 10 000 0001',
    industry: 'Public sector',
    status: 'ACTIVE',
    since: '2025-01-01',
    notes: 'Synthetic.',
    requiredDocs: [],
  }
}

function vaultDoc(): VaultDoc {
  return {
    id: 'vd-1',
    title: 'Tax clearance',
    category: 'COMPLIANCE',
    fileUrl: 'vault/tax.pdf',
    issueDate: null,
    expiryDate: '2027-01-01',
    isCertified: false,
    certifiedDate: null,
    metadata: {},
  }
}

function milestone(overrides: Partial<ContractMilestone> = {}): ContractMilestone {
  return {
    id: 'ms-1',
    name: 'Phase 1 — Mobilisation',
    description: 'Site establishment.',
    amount: 250000,
    dueDate: '2026-10-01',
    status: 'REACHED',
    ...overrides,
  }
}

function tender(overrides: Partial<TenderRecord> = {}): TenderRecord {
  return {
    id: 'tender-1',
    title: 'Supply and Delivery of Office Computers',
    referenceNumber: 'ICT/2026/041',
    issuingBody: 'Provincial Administration Office',
    closingDate: '2026-12-18',
    submissionMethod: 'ELECTRONIC',
    submissionAddress: null,
    signatureChecks: {},
    status: 'WON',
    createdAt: AT,
    fileName: 'rfp.pdf',
    fileUrl: 'documents/rfp.pdf',
    numPages: 4,
    ocrPages: 0,
    requirements: [],
    milestones: [milestone()],
    ...overrides,
  }
}

function documentV2(tenderRecord: TenderRecord): TendersDataV2 {
  const workspace: TendersWorkspaceV2 = {
    id: 'ws-1',
    name: 'Test Co',
    dataOrigin: 'user',
    company: company(),
    customers: [customer()],
    vault: [vaultDoc()],
    tenders: [tenderRecord],
  }
  return {
    schemaVersion: 2,
    revision: 4,
    updatedAt: AT,
    activeCompanyId: 'ws-1',
    workspaces: [workspace],
    issuerTemplates: [],
  }
}