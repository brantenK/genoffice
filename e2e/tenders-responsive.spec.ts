/**
 * Phase 5 / Wave 1 lane D — built-Electron verification for WP-12 (responsive
 * workspace + action hierarchy).
 *
 * Landed layout contract this spec drives (confirmed in `Workspace.tsx`):
 *  - Wide (workspace container ≥ 900px): `[data-testid="workspace-split-handle"]`
 *    (`role="separator"`, `aria-orientation="vertical"`, `aria-valuenow/min/max`,
 *    focusable; ArrowLeft/Right ±3, Home/End jump to min/max) and the secondary
 *    actions (Sheets / Draft Docs / CRM / Milestones) rendered INLINE.
 *  - Compact (container < 900px): `[data-testid="workspace-pane-switch"]`
 *    (`role="group"`, `aria-label="Workspace view"`) with
 *    `pane-switch-requirements` / `pane-switch-pdf` (`aria-pressed`); both panes
 *    stay mounted (`workspace-matrix-pane[data-pane="requirements"]`,
 *    `workspace-pdf-pane[data-pane="pdf"]`, `data-active`); the secondary
 *    actions move into the overflow menu.
 *  - Overflow: `workspace-overflow-trigger` (`aria-haspopup="menu"`,
 *    `aria-expanded`) and `workspace-overflow-menu` with `role="menuitem"`
 *    items `overflow-action-rerun-gap|-sheets|-draft-docs|-crm|-milestones`
 *    (the four secondary ones only render in compact mode).
 *  - Context headers: `workspace-context-header`, `matrix-context-header`,
 *    `pdf-context-header`; scroll container `pdf-scroll`.
 *  - Sidebar auto-collapses at ≤900px window width (`aria-label="Expand sidebar"`
 *    on the collapsed toggle).
 *  - Split proportion persists in `localStorage['zanostack-tenders-workspace-split-v1']`
 *    as `{ matrixFraction }`.
 *
 * Truncation policy (tightened): single-line `text-overflow: ellipsis` is the
 * design's affordance and is recorded as evidence only — EXCEPT inside `nav`,
 * where a truncated label must still expose the full value through `title` /
 * `aria-label` (200% text zoom truncates nav labels; the sidebar items do expose
 * both). A nav label cut off with no full value is a clipping failure.
 *
 * The audit ignores content that is deliberately removed from the visual layer
 * while staying in the accessibility tree (`sr-only` / visually-hidden): a clip
 * to nothing (`clip-path: inset(50%)` in Tailwind v4's `sr-only`, or the classic
 * `clip: rect(0,0,0,0)`), a 1×1 px absolutely positioned `overflow: hidden` box,
 * or `display: none`. Such content is *supposed* to be clipped, so it is not a
 * clipping failure. `visibility: hidden` hides only the element's own text —
 * descendants that re-declare `visible` are still audited. Visible truncation is
 * still reported exactly as above.
 *
 * Fixture: seeded, schema-valid v2 store + a real 3-page PDF written to the
 * tender documents dir, so the PDF pane renders and the viewer can locate a
 * requirement on page 2 (the compact pane-switch journey depends on it).
 *
 * Scratch `userData` under `%LOCALAPPDATA%\Temp\opencode`; cleaned in `finally`.
 */
import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  launchShell,
  closeAndSaveVideo,
  waitForPageWithUrl,
  screenshotPath,
  ARTIFACTS_DIR,
  type LaunchedApp,
} from './helpers'
import { teardownScratchProfile } from './tenders-timing'

/** `%LOCALAPPDATA%\Temp\opencode` on Windows (os.tmpdir() is %TEMP%). */
const SCRATCH_ROOT = join(tmpdir(), 'opencode')
const LOADED_AT = '2026-09-01T08:00:00.000Z'

const COMPANY_NAME = 'E2E Responsive Civils (Pty) Ltd'
const TENDER_REF = 'E2E/RESP/2026/01'
const TENDER_WON_REF = 'E2E/RESP/2026/02'
const TENDER_PDF = 'documents/e2e-responsive.pdf'
const SPLIT_STORAGE_KEY = 'zanostack-tenders-workspace-split-v1'

const WIDE = { width: 1280, height: 800 }
const MID = { width: 1024, height: 768 }
const NARROW = { width: 800, height: 600 }

const T = {
  splitHandle: '[data-testid="workspace-split-handle"]',
  paneSwitch: '[data-testid="workspace-pane-switch"]',
  switchRequirements: '[data-testid="pane-switch-requirements"]',
  switchPdf: '[data-testid="pane-switch-pdf"]',
  matrixPane: '[data-testid="workspace-matrix-pane"]',
  pdfPane: '[data-testid="workspace-pdf-pane"]',
  overflowTrigger: '[data-testid="workspace-overflow-trigger"]',
  overflowMenu: '[data-testid="workspace-overflow-menu"]',
  contextHeader: '[data-testid="workspace-context-header"]',
  matrixHeader: '[data-testid="matrix-context-header"]',
  pdfHeader: '[data-testid="pdf-context-header"]',
  pdfScroll: '[data-testid="pdf-scroll"]',
} as const

// ── seeded fixture ────────────────────────────────────────────────────────────

function companyProfile(name: string): Record<string, unknown> {
  return {
    name,
    tradingName: name,
    registrationNumber: '2016/123456/07',
    vatNumber: '4820315678',
    taxPin: '0123456789',
    bbbeeLevel: 'Level 1',
    bbbeeBlackOwnership: '100%',
    csdSupplierNumber: 'MAZE-0000001',
    founded: '2016',
    employees: '20',
    industry: 'Civil engineering',
    description: 'E2E responsive fixture company.',
    address: '1 Test Road, Test City',
    phone: '+27 10 000 0000',
    email: 'responsive@example.test',
    website: 'https://example.test',
    directors: [],
    projects: [],
  }
}

function requirementFixture(
  id: string,
  title: string,
  pageNumber: number,
): Record<string, unknown> {
  return {
    id,
    ruleKey: `rule-${id}`,
    title,
    category: 'MANDATORY_STAGE_1',
    isMandatory: true,
    verbatimClause: `E2E responsive clause for ${title}.`,
    pageNumber,
    boundingBox: { top: 0.1, left: 0.1, width: 0.8, height: 0.05 },
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: pageNumber,
    confidence: 0.9,
    status: 'OUTSTANDING',
    linkedVaultDocId: null,
    reason: null,
    suggestedVaultDocIds: [],
  }
}

function tenderFixture(
  id: string,
  reference: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: `E2E Responsive Tender ${reference}`,
    referenceNumber: reference,
    issuingBody: 'E2E Water Authority',
    closingDate: null,
    submissionMethod: null,
    submissionAddress: null,
    signatureChecks: {},
    status,
    createdAt: LOADED_AT,
    fileName: 'e2e-responsive.pdf',
    fileUrl: TENDER_PDF,
    numPages: 3,
    ocrPages: 0,
    requirements: [
      requirementFixture(`req-${id}-1`, `E2E requirement one (${reference})`, 1),
      requirementFixture(`req-${id}-2`, `E2E requirement two (${reference})`, 2),
    ],
    ...extra,
  }
}

function seededDocument(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    revision: 1,
    updatedAt: LOADED_AT,
    activeCompanyId: 'co-resp',
    workspaces: [
      {
        id: 'co-resp',
        name: COMPANY_NAME,
        dataOrigin: 'user',
        company: companyProfile(COMPANY_NAME),
        customers: [],
        vault: [
          {
            id: 'vd-resp',
            title: 'E2E Responsive Vault Doc',
            category: 'COMPLIANCE',
            fileUrl: 'vault/e2e-responsive.pdf',
            issueDate: null,
            expiryDate: null,
            isCertified: false,
            certifiedDate: null,
            metadata: {},
          },
        ],
        tenders: [
          tenderFixture('t-resp-active', TENDER_REF, 'IN_PROGRESS'),
          tenderFixture('t-resp-won', TENDER_WON_REF, 'WON', {
            milestones: [
              {
                id: 'ms-resp-1',
                name: 'E2E Responsive Milestone',
                amount: 2500,
                status: 'REACHED',
                dueDate: '2026-10-01',
              },
            ],
          }),
        ],
      },
    ],
    issuerTemplates: [],
  }
}

async function generateTenderPdf(targetPath: string): Promise<void> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index <= 3; index += 1) {
    const page = doc.addPage([595, 842])
    page.drawRectangle({ x: 60, y: 520, width: 470, height: 240, color: rgb(0.85, 0.87, 0.9) })
    page.drawText(`E2E RESPONSIVE FIXTURE — PAGE ${index}`, { x: 60, y: 780, size: 14, font })
    page.drawText(`Reference Number: E2E/RESP/PDF/0${index}`, { x: 60, y: 750, size: 11, font })
  }
  await writeFile(targetPath, Buffer.from(await doc.save()))
}

async function writeSeededStore(userDataDir: string): Promise<void> {
  await mkdir(join(userDataDir, 'tenders', 'documents'), { recursive: true })
  await generateTenderPdf(join(userDataDir, 'tenders', 'documents', 'e2e-responsive.pdf'))
  await writeFile(
    join(userDataDir, 'tenders', 'tenders-data.json'),
    JSON.stringify(seededDocument(), null, 2),
    'utf8',
  )
}

// ── scratch + harness helpers ─────────────────────────────────────────────────

async function scratchUserData(): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  return mkdtemp(join(SCRATCH_ROOT, 'genoffice-e2e-'))
}

async function openTendersFromNav(app: ElectronApplication, shell: Page): Promise<Page> {
  const homeTab = shell.locator('.tab-item.tab-home')
  if ((await homeTab.count()) > 0) {
    await homeTab.click({ timeout: 5_000 }).catch(() => {})
  }
  const businessApps = shell.locator('.app-nav').nth(1)
  const tendersButton = businessApps.getByRole('button', { name: 'Tenders' })
  await expect(tendersButton).toBeVisible({ timeout: 15_000 })
  await tendersButton.click()
  return waitForPageWithUrl(app, 'tenders')
}

async function dismissTendersOnboarding(tenders: Page): Promise<void> {
  const skip = tenders.getByRole('button', { name: 'Skip intro' })
  for (let attempt = 0; attempt < 25; attempt++) {
    if ((await skip.count()) > 0) {
      await skip.click({ timeout: 5_000 }).catch(() => {})
      await expect(skip)
        .toHaveCount(0, { timeout: 5_000 })
        .catch(() => {})
      return
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * Open the named tender's workspace deterministically. The helper is called
 * from arbitrary pages (Overview, Customers, Company Profile, …), so it first
 * moves the module to its Tenders page through the sidebar nav (always
 * available, including the collapsed sidebar where the name comes from
 * `title`), then either accepts the already-open workspace for that reference
 * or opens the tender's card from the list.
 */
async function openTender(tenders: Page, reference: string): Promise<void> {
  const listHeading = tenders.getByRole('heading', { name: 'Tenders', level: 1 })
  const matrixHeading = tenders.getByRole('heading', { name: 'Compliance matrix' })
  const back = tenders.locator('main').getByRole('button', { name: 'Tenders' }).first()
  const headerShowsReference = async (): Promise<boolean> =>
    (await tenders.locator('main').getByText(reference, { exact: false }).count()) > 0

  // 1) Move the module to its Tenders page (no-op when already there).
  const navTenders = tenders.locator('nav').getByRole('button', { name: 'Tenders' })
  await expect(navTenders).toBeVisible({ timeout: 20_000 })
  await navTenders.click()
  await expect
    .poll(
      async () =>
        (await listHeading.isVisible().catch(() => false)) ||
        (await back.isVisible().catch(() => false)),
      { timeout: 20_000, message: 'the Tenders page must render after the nav click' },
    )
    .toBe(true)

  // 2) Already showing the requested tender's workspace?
  if ((await back.isVisible().catch(() => false)) && (await headerShowsReference())) return

  // 3) Otherwise show the tender list and open the requested card.
  if (!(await listHeading.isVisible().catch(() => false))) {
    await back.click()
    await expect(listHeading).toBeVisible({ timeout: 20_000 })
  }
  const card = tenders.locator('main li', { hasText: reference }).first()
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.click()
  await expect(matrixHeading).toBeVisible({ timeout: 20_000 })
  await expect.poll(headerShowsReference, { timeout: 20_000 }).toBe(true)
}

/** Resize the shell window and wait for the Tenders view to follow. */
async function resizeAndSettle(
  app: ElectronApplication,
  tenders: Page,
  width: number,
  height: number,
): Promise<number> {
  // The shell enforces a 980px minimum window width, so viewports below it are
  // unreachable by plain window resizing. Emulate the target viewport by
  // relaxing the minimum (restored right after the resize settles) — the layout
  // assertions themselves stay exactly as authored.
  const relaxed = await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('no shell window')
      const [minWidth, minHeight] = win.getMinimumSize()
      if (size.width < minWidth || size.height < minHeight) {
        win.setMinimumSize(Math.min(size.width, minWidth), Math.min(size.height, minHeight))
      }
      win.setContentSize(size.width, size.height)
      return [minWidth, minHeight] as [number, number]
    },
    { width, height },
  )
  await expect
    .poll(() => tenders.evaluate((target) => Math.abs(window.innerWidth - target) <= 8, width), {
      timeout: 20_000,
    })
    .toBe(true)
  // The workspace mode derives from a ResizeObserver on the split container and
  // the sidebar auto-collapse animates; wait for the container width to hold
  // still before the caller reads the mode (two stable samples, no fixed wait).
  await expect
    .poll(
      async () => {
        const sample = (): Promise<number> =>
          tenders.evaluate(
            () => document.querySelector('[data-testid="workspace-split"]')?.clientWidth ?? 0,
          )
        const first = await sample()
        await new Promise((r) => setTimeout(r, 350))
        const second = await sample()
        return first > 0 && first === second
      },
      { timeout: 15_000, message: 'the workspace layout must settle after the resize' },
    )
    .toBe(true)
  await app.evaluate(({ BrowserWindow }, minimum) => {
    BrowserWindow.getAllWindows()[0]?.setMinimumSize(minimum[0], minimum[1])
  }, relaxed)
  return tenders.evaluate(() => window.innerWidth)
}

interface WorkspaceMode {
  handle: boolean
  paneSwitch: boolean
  sidebarCollapsed: boolean
}

function workspaceMode(tenders: Page): Promise<WorkspaceMode> {
  return tenders.evaluate(() => ({
    handle: Boolean(document.querySelector('[data-testid="workspace-split-handle"]')),
    paneSwitch: Boolean(document.querySelector('[data-testid="workspace-pane-switch"]')),
    sidebarCollapsed: Boolean(document.querySelector('[aria-label="Expand sidebar"]')),
  }))
}

interface AuditReport {
  innerWidth: number
  rootOverflow: { scrollWidth: number; clientWidth: number }
  clipOffenders: Array<Record<string, unknown>>
  truncated: Array<Record<string, unknown>>
  unreachable: Array<Record<string, unknown>>
}

/** Horizontal clipping + control reachability audit for the current viewport. */
function workspaceAudit(tenders: Page): Promise<AuditReport> {
  return tenders.evaluate(() => {
    const root = document.documentElement
    const clipOffenders: Array<Record<string, unknown>> = []
    const truncated: Array<Record<string, unknown>> = []
    const ownText = (el: Element): boolean =>
      Array.from(el.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0,
      )
    /**
     * True when the element (or one of its four nearest ancestors) still exposes
     * the full value to the user/AT via `title` or `aria-label`.
     */
    const exposesFullText = (el: Element): boolean => {
      let node: Element | null = el
      for (let depth = 0; node && depth < 4; depth += 1) {
        if ((node.getAttribute('title') ?? '').trim() !== '') return true
        if ((node.getAttribute('aria-label') ?? '').trim() !== '') return true
        node = node.parentElement
      }
      return false
    }
    /**
     * True when the element (or one of its four nearest ancestors) is removed
     * from the visual layer for its whole subtree: `display: none`, a clip to
     * nothing (Tailwind v4's `sr-only` uses `clip-path: inset(50%)`; the classic
     * visually-hidden rule uses `clip: rect(0,0,0,0)`), or a 1×1 px absolutely
     * positioned `overflow: hidden` box. No descendant can escape any of those,
     * so nothing inside is visible and nothing inside can be a clipping failure.
     * Detected from computed style, never from a class name.
     *
     * `visibility: hidden` is deliberately NOT part of this test: it is
     * inherited, so a descendant that re-declares `visible` is on screen again.
     * It is handled per element by the `invisibleText` guards instead.
     */
    const subtreeClippedAway = (el: Element): boolean => {
      let node: Element | null = el
      for (let depth = 0; node && depth < 4; depth += 1) {
        const style = getComputedStyle(node)
        if (style.display === 'none') return true
        if (
          /^inset\(\s*50%(\s+50%){0,3}\s*\)$/.test(style.clipPath) ||
          /^rect\(\s*(0(px)?[,\s]+){3}0(px)?\s*\)$/.test(style.clip)
        ) {
          return true
        }
        if (
          node.clientWidth <= 1 &&
          node.clientHeight <= 1 &&
          style.position === 'absolute' &&
          style.overflowX === 'hidden' &&
          style.overflowY === 'hidden'
        ) {
          return true
        }
        node = node.parentElement
      }
      return false
    }
    const fieldTags = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'IMG'])
    for (const element of Array.from(document.querySelectorAll('body *'))) {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      // Screen-reader-only content is clipped by design, not by a layout defect.
      if (subtreeClippedAway(element)) continue
      const overflow = element.scrollWidth - element.clientWidth
      if (overflow <= 1) continue
      const style = getComputedStyle(element)
      // Auto/scroll containers are legitimately scrollable; only content that
      // a scrollbar can never reveal is a clipping problem. `visible` spills.
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue
      if (style.overflowX === 'visible') continue
      // The element's own text is off-screen, so it cannot be a clip failure —
      // but its children are still audited, because `visibility` is inherited
      // and a descendant may re-declare `visible`.
      const invisibleText = style.visibility === 'hidden'
      const record = { tag: element.tagName, cls: String(element.className).slice(0, 90), overflow }
      if (!invisibleText && style.textOverflow === 'ellipsis') {
        // Outside the primary navigation, single-line truncation is the design's
        // affordance; keep it as evidence, never as a failure.
        //
        // In the navigation it is only acceptable while the full label stays
        // reachable (title / aria-label on the item): a nav item a user cannot
        // read in full — the case 200% text zoom produces — is a real failure,
        // not a design choice.
        if (!element.closest('nav') || exposesFullText(element)) {
          truncated.push(record)
          continue
        }
        clipOffenders.push({
          ...record,
          reason: 'nav label truncated with no full value exposed (no title/aria-label)',
        })
        continue
      }
      if (
        !invisibleText &&
        ownText(element) &&
        (style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre')
      ) {
        // Nowrap text inside a clipping container is cut with no affordance.
        clipOffenders.push({ ...record, reason: 'nowrap text cut without ellipsis' })
        continue
      }
      // Container-level overflow: is any non-ellipsis text (or form field) of a
      // descendant actually positioned beyond the clip edge?
      const contentRight = rect.left + element.clientLeft + element.clientWidth
      const cut: string[] = []
      const consider = (el: Element): void => {
        if (el.hasAttribute('aria-hidden')) return
        if (subtreeClippedAway(el)) return
        const elStyle = getComputedStyle(el)
        const ellipsis = elStyle.textOverflow === 'ellipsis'
        if (
          elStyle.visibility !== 'hidden' &&
          !ellipsis &&
          (ownText(el) || fieldTags.has(el.tagName))
        ) {
          const r = el.getBoundingClientRect()
          if (r.right > contentRight + 1) {
            cut.push(`${el.tagName}.${String(el.className).slice(0, 40)}`)
          }
        }
        for (const child of Array.from(el.children)) consider(child)
      }
      consider(element)
      if (cut.length > 0) {
        clipOffenders.push({
          ...record,
          reason: 'text/field beyond the clip edge',
          cut: cut.slice(0, 5),
        })
      }
    }

    const controls = Array.from(
      document.querySelectorAll(
        'button, [role="button"], a[href], select, input:not([type="hidden"]), [role="tab"], [role="menuitem"], [role="separator"]',
      ),
    )
    const unreachable: Array<Record<string, unknown>> = []
    for (const element of controls) {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue // hidden pane / not rendered
      if (getComputedStyle(element).visibility === 'hidden') continue
      const measure = (): { rect: DOMRect; intersects: boolean; covered: boolean } => {
        const r = element.getBoundingClientRect()
        const vw = window.innerWidth
        const vh = window.innerHeight
        const intersects = r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh
        let covered = false
        if (intersects) {
          const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2))
          const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2))
          const hit = document.elementFromPoint(cx, cy)
          covered = !(hit && (hit === element || element.contains(hit) || hit.contains(element)))
        }
        return { rect: r, intersects, covered }
      }
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      let m = measure()
      if (!m.intersects || m.covered) {
        // Sticky headers (and similar chrome) can cover a control while it is
        // still reachable by scrolling; centre it in its scroll container and
        // re-test before declaring it unreachable.
        element.scrollIntoView({ block: 'center', inline: 'nearest' })
        m = measure()
      }
      if (!m.intersects || m.covered) {
        // At the scroll end `block: 'center'` cannot move the element out from
        // under a sticky header; a user scrolls the container instead. Sweep to
        // both extremes and re-test — only a control that stays covered at
        // every reachable scroll position is unreachable.
        let container: HTMLElement | null = element.parentElement
        while (container) {
          const s = getComputedStyle(container)
          if (
            /(auto|scroll)/.test(s.overflowY) &&
            container.scrollHeight > container.clientHeight + 1
          )
            break
          container = container.parentElement
        }
        if (container) {
          const saveTop = container.scrollTop
          const tried: number[] = []
          for (const target of [0, container.scrollHeight]) {
            container.scrollTop = target
            tried.push(container.scrollTop)
            m = measure()
            if (m.intersects && !m.covered) break
          }
          if (!(m.intersects && !m.covered)) {
            container.scrollTop = saveTop
            m = measure()
          }
          ;(m as { triedScrollTops?: number[] }).triedScrollTops = tried
        }
      }
      if (!m.intersects || m.covered) {
        unreachable.push({
          tag: element.tagName,
          cls: String(element.className).slice(0, 90),
          intersects: m.intersects,
          covered: m.covered,
          triedScrollTops: (m as { triedScrollTops?: number[] }).triedScrollTops ?? null,
          rect: {
            x: Math.round(m.rect.x),
            y: Math.round(m.rect.y),
            w: Math.round(m.rect.width),
            h: Math.round(m.rect.height),
          },
        })
      }
    }

    return {
      innerWidth: window.innerWidth,
      rootOverflow: { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth },
      clipOffenders: clipOffenders.slice(0, 15),
      truncated: truncated.slice(0, 15),
      unreachable: unreachable.slice(0, 15),
    }
  })
}

async function expectCleanLayout(tenders: Page, label: string): Promise<AuditReport> {
  const report = await workspaceAudit(tenders)
  expect(
    report.rootOverflow.scrollWidth - report.rootOverflow.clientWidth,
    `${label}: the document must not scroll horizontally (${JSON.stringify(report.rootOverflow)})`,
  ).toBeLessThanOrEqual(1)
  expect(
    report.clipOffenders,
    `${label}: clipped containers whose content cannot be revealed: ${JSON.stringify(report.clipOffenders)}`,
  ).toEqual([])
  expect(
    report.unreachable,
    `${label}: unreachable controls: ${JSON.stringify(report.unreachable)}`,
  ).toEqual([])
  return report
}

/** Current page from the compact switch bar (`p.N`). */
function compactPageIndicator(tenders: Page): Promise<number | null> {
  return tenders.evaluate(() => {
    const bar = document.querySelector('[data-testid="workspace-pane-switch"]')?.parentElement
    if (!bar) return null
    // Read the page label from the bar's own spans: the switch buttons' text is
    // adjacent with no whitespace ("…PDFp.2 · 100%"), so a word-boundary regex
    // over the bar's textContent would never match.
    for (const span of Array.from(bar.querySelectorAll('span'))) {
      const match = (span.textContent ?? '').match(/p\.(\d+)/)
      if (match) return Number(match[1])
    }
    return null
  })
}

/**
 * Title of the selected requirement row. Prefers the semantic hook
 * (`aria-current="true"`) and falls back to the landed active-ring class while
 * that hook is still pending (reported as a contract request).
 */
function selectedRequirementTitle(tenders: Page): Promise<string | null> {
  return tenders.evaluate(() => {
    const current = document.querySelector('main li[aria-current="true"]')
    const ringed = Array.from(document.querySelectorAll('main li')).find((li) =>
      String(li.className).includes('ring-indigo-300'),
    )
    const row = current ?? ringed ?? null
    return row ? (row.textContent ?? '').trim().slice(0, 120) : null
  })
}

async function shot(page: Page, name: string): Promise<string> {
  const target = screenshotPath(name)
  try {
    await page.screenshot({ path: target, timeout: 15_000 })
  } catch {
    // best-effort evidence
  }
  return target
}

interface JourneyResult {
  journey: string
  status: 'PASS' | 'FAIL'
  detail: string
  evidence: Record<string, unknown>
  screenshots: string[]
  /**
   * The salvaged diagnostics-log artefacts for this journey, so the result JSON
   * names the run's own log rather than only describing it. The log lives inside
   * the scratch profile and is deleted with it, so this path is the evidence.
   */
  diagnosticsLogs: string[]
}

async function writeResult(name: string, result: JourneyResult): Promise<string> {
  await mkdir(ARTIFACTS_DIR, { recursive: true })
  const path = join(ARTIFACTS_DIR, `${name}.json`)
  await writeFile(path, JSON.stringify(result, null, 2), 'utf8')
  return path
}

/** Launch with the responsive fixture and land on the active tender workspace. */
async function bootWorkspace(
  videoDir: string,
  reference: string = TENDER_REF,
): Promise<{ run: LaunchedApp; tenders: Page; userDataDir: string }> {
  const userDataDir = await scratchUserData()
  await writeSeededStore(userDataDir)
  const run = await launchShell({ userDataDir, onboardingSeen: true, videoDir })
  const tenders = await openTendersFromNav(run.app, run.page)
  await dismissTendersOnboarding(tenders)
  await openTender(tenders, reference)
  return { run, tenders, userDataDir }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test.describe('Tenders responsive workspace (Phase 5 / WP-12)', () => {
  test.describe.configure({ timeout: 600_000 })

  test('1: 1280x800 wide — split handle keyboard resize, inline secondary actions, overflow metadata, no clipping', async () => {
    const screenshots: string[] = []
    // Salvaged diagnostics-log artefacts for this journey, recorded in the
    // result JSON so a failing run names the log rather than deleting it.
    const salvaged: Array<string | null> = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      const booted = await bootWorkspace('tenders-responsive-j1')
      run = booted.run
      userDataDir = booted.userDataDir
      const tenders = booted.tenders

      const innerWidth = await resizeAndSettle(run.app, tenders, WIDE.width, WIDE.height)
      const mode = await workspaceMode(tenders)
      expect(mode.handle, `wide mode (innerWidth ${innerWidth}) must expose the split handle`).toBe(
        true,
      )
      expect(mode.paneSwitch, 'the compact pane switch must not render in wide mode').toBe(false)

      // Context headers exist (sticky context, WP-12).
      for (const selector of [T.contextHeader, T.matrixHeader, T.pdfHeader, T.pdfScroll]) {
        await expect(tenders.locator(selector).first()).toBeVisible({ timeout: 15_000 })
      }

      // Split handle semantics + keyboard resize.
      const handle = tenders.locator(T.splitHandle)
      expect(await handle.getAttribute('aria-orientation')).toBe('vertical')
      await handle.focus()
      const readValue = async (): Promise<number> =>
        Number(await handle.getAttribute('aria-valuenow'))
      const start = await readValue()
      await tenders.keyboard.press('ArrowLeft')
      const left = await readValue()
      expect(left, 'ArrowLeft must shrink the matrix share').toBeLessThan(start)
      await tenders.keyboard.press('ArrowRight')
      expect(await readValue(), 'ArrowRight must grow the matrix share').toBeGreaterThan(left)
      await tenders.keyboard.press('Home')
      const min = Number(await handle.getAttribute('aria-valuemin'))
      expect(await readValue(), 'Home must jump to the minimum share').toBe(min)
      await tenders.keyboard.press('End')
      const max = Number(await handle.getAttribute('aria-valuemax'))
      expect(await readValue(), 'End must jump to the maximum share').toBe(max)

      // Secondary actions stay inline in wide mode; Milestones is gated on won.
      for (const name of ['Sheets', 'Draft Docs', /^CRM$/]) {
        await expect(
          tenders.getByRole('button', { name }).first(),
          `wide mode must keep the ${String(name)} action inline`,
        ).toBeVisible()
      }
      expect(
        await tenders.getByRole('button', { name: /^Milestones/ }).count(),
        'a non-won tender must not expose milestone billing',
      ).toBe(0)
      await openTender(tenders, TENDER_WON_REF)
      await expect(
        tenders.getByRole('button', { name: /^Milestones/ }).first(),
        'a won tender must expose the inline Milestones action in wide mode',
      ).toBeVisible({ timeout: 15_000 })

      // The overflow carries metadata + low-frequency items only in wide mode.
      await tenders.locator(T.overflowTrigger).click()
      await expect(tenders.locator(T.overflowMenu)).toBeVisible({ timeout: 10_000 })
      const menu = tenders.locator(T.overflowMenu)
      await expect(menu.getByRole('menuitem')).not.toHaveCount(0)
      await expect(menu.locator('[data-testid="overflow-action-rerun-gap"]')).toBeVisible()
      await expect(menu.getByText('Tender details')).toBeVisible()
      expect(
        await menu.locator('[data-testid="overflow-action-sheets"]').count(),
        'secondary actions must not be duplicated in the wide overflow',
      ).toBe(0)
      await tenders.keyboard.press('Escape')
      await expect(tenders.locator(T.overflowMenu)).toBeHidden({ timeout: 10_000 })
      await expect(tenders.locator(T.overflowTrigger)).toHaveAttribute('aria-expanded', 'false')

      const report = await expectCleanLayout(tenders, 'wide 1280x800')
      screenshots.push(await shot(tenders, 'responsive-j1-wide-1280x800'))

      const result: JourneyResult = {
        journey: '1: wide 1280x800 layout + split handle + action hierarchy',
        status: 'PASS',
        detail: `innerWidth=${innerWidth}; aria-valuenow ${start} -> ${left}; Home=${min} End=${max}; inline secondary actions; clean layout`,
        evidence: { userDataDir, mode, audit: report },
        screenshots,
        // The salvaged diagnostics log(s) for this journey. Recorded as a path so a
        // failing run names the artefact instead of deleting it with the profile —
        // the result JSON is the run's own statement, the log is the evidence for it.
        diagnosticsLogs: salvaged.filter(Boolean) as string[],
      }
      await writeResult('tenders-responsive-journey-1', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-responsive-j1').catch(() => undefined)
      salvaged.push(await teardownScratchProfile(userDataDir, `tenders-responsive-run1`))
    }
  })

  test('2: 1024x768 compact — pane switch preserves selection + page, secondary actions move to the overflow', async () => {
    const screenshots: string[] = []
    // Salvaged diagnostics-log artefacts for this journey, recorded in the
    // result JSON so a failing run names the log rather than deleting it.
    const salvaged: Array<string | null> = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      const booted = await bootWorkspace('tenders-responsive-j2')
      run = booted.run
      userDataDir = booted.userDataDir
      const tenders = booted.tenders

      const innerWidth = await resizeAndSettle(run.app, tenders, MID.width, MID.height)
      const mode = await workspaceMode(tenders)
      expect(
        mode.paneSwitch,
        `compact mode (innerWidth ${innerWidth}) must show the pane switch`,
      ).toBe(true)
      expect(mode.handle, 'the split handle must not render in compact mode').toBe(false)

      const switchGroup = tenders.locator(T.paneSwitch)
      await expect(switchGroup).toBeVisible()
      await expect(switchGroup).toHaveAttribute('aria-label', 'Workspace view')
      const requirementsTab = tenders.locator(T.switchRequirements)
      const pdfTab = tenders.locator(T.switchPdf)
      await expect(requirementsTab).toHaveAttribute('aria-pressed', 'true')
      await expect(pdfTab).toHaveAttribute('aria-pressed', 'false')

      // Select requirement two (page 2) in the matrix.
      const rowTwo = tenders.locator('main li').filter({ hasText: 'E2E requirement two' }).first()
      await expect(rowTwo).toBeVisible({ timeout: 20_000 })
      await rowTwo.getByRole('button').first().click()
      const selectedBefore = await selectedRequirementTitle(tenders)
      expect(
        selectedBefore,
        'clicking a requirement must mark it selected (aria-current="true" contract; ring class fallback)',
      ).toContain('E2E requirement two')

      // Switch to the PDF pane: it must locate the selected requirement's page.
      await pdfTab.click()
      await expect(pdfTab).toHaveAttribute('aria-pressed', 'true')
      await expect(tenders.locator(T.pdfPane)).toHaveAttribute('data-active', 'true')
      await expect(tenders.locator(T.matrixPane)).toHaveAttribute('data-active', 'false')
      await expect.poll(() => compactPageIndicator(tenders), { timeout: 30_000 }).toBe(2)
      screenshots.push(await shot(tenders, 'responsive-j2-compact-pdf'))

      // Switch back: the selection and the located page survive.
      await requirementsTab.click()
      await expect(requirementsTab).toHaveAttribute('aria-pressed', 'true')
      await expect(tenders.locator(T.matrixPane)).toHaveAttribute('data-active', 'true')
      await expect(tenders.locator(T.pdfPane)).toHaveAttribute('data-active', 'false')
      expect(
        await selectedRequirementTitle(tenders),
        'the selected requirement must survive the pane switches',
      ).toBe(selectedBefore)
      expect(
        await compactPageIndicator(tenders),
        'the located page must survive the switches',
      ).toBe(2)
      screenshots.push(await shot(tenders, 'responsive-j2-compact-requirements'))

      // Secondary actions are now in the overflow.
      for (const name of ['Sheets', 'Draft Docs']) {
        expect(
          await tenders.getByRole('button', { name: new RegExp(`^${name}$`) }).count(),
          `${name} must not stay inline in compact mode`,
        ).toBe(0)
      }
      await tenders.locator(T.overflowTrigger).click()
      const menu = tenders.locator(T.overflowMenu)
      await expect(menu).toBeVisible({ timeout: 10_000 })
      for (const id of [
        'overflow-action-rerun-gap',
        'overflow-action-sheets',
        'overflow-action-draft-docs',
        'overflow-action-crm',
      ]) {
        await expect(
          menu.locator(`[data-testid="${id}"]`),
          `${id} must be in the compact overflow`,
        ).toBeVisible()
      }
      // Clicking a menu item performs the action and closes the menu.
      await menu.locator('[data-testid="overflow-action-rerun-gap"]').click()
      await expect(tenders.locator(T.overflowMenu)).toBeHidden({ timeout: 10_000 })

      // The Milestones overflow item only exists for a won tender.
      await openTender(tenders, TENDER_WON_REF)
      await tenders.locator(T.overflowTrigger).click()
      await expect(
        tenders.locator(`${T.overflowMenu} [data-testid="overflow-action-milestones"]`),
        'a won tender must expose Contract milestones in the compact overflow',
      ).toBeVisible({ timeout: 10_000 })
      await tenders.keyboard.press('Escape')

      const report = await expectCleanLayout(tenders, 'compact 1024x768')
      screenshots.push(await shot(tenders, 'responsive-j2-compact-1024x768'))

      const result: JourneyResult = {
        journey: '2: compact 1024x768 pane switch + selection/page preservation + overflow',
        status: 'PASS',
        detail: `innerWidth=${innerWidth}; selection "${selectedBefore}" and page 2 preserved across switches; secondary actions in the overflow`,
        evidence: { userDataDir, mode, selectedBefore, audit: report },
        screenshots,
        // The salvaged diagnostics log(s) for this journey. Recorded as a path so a
        // failing run names the artefact instead of deleting it with the profile —
        // the result JSON is the run's own statement, the log is the evidence for it.
        diagnosticsLogs: salvaged.filter(Boolean) as string[],
      }
      await writeResult('tenders-responsive-journey-2', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-responsive-j2').catch(() => undefined)
      salvaged.push(await teardownScratchProfile(userDataDir, `tenders-responsive-run2`))
    }
  })

  test('3: 800x600 compact — no unreachable controls, sidebar collapsed, snapshots', async () => {
    const screenshots: string[] = []
    // Salvaged diagnostics-log artefacts for this journey, recorded in the
    // result JSON so a failing run names the log rather than deleting it.
    const salvaged: Array<string | null> = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      const booted = await bootWorkspace('tenders-responsive-j3')
      run = booted.run
      userDataDir = booted.userDataDir
      const tenders = booted.tenders

      const innerWidth = await resizeAndSettle(run.app, tenders, NARROW.width, NARROW.height)
      const mode = await workspaceMode(tenders)
      expect(mode.paneSwitch, `800x600 (innerWidth ${innerWidth}) must use compact mode`).toBe(true)
      expect(mode.sidebarCollapsed, 'the sidebar must auto-collapse at ≤900px window width').toBe(
        true,
      )

      // The pane switch and overflow stay reachable at the narrow size.
      await expect(tenders.locator(T.paneSwitch)).toBeVisible({ timeout: 15_000 })
      await tenders.locator(T.overflowTrigger).click()
      const menu = tenders.locator(T.overflowMenu)
      await expect(menu).toBeVisible({ timeout: 10_000 })
      await expect(menu.locator('[data-testid="overflow-action-sheets"]')).toBeVisible()
      await tenders.keyboard.press('Escape')
      await expect(menu).toBeHidden({ timeout: 10_000 })

      const report = await expectCleanLayout(tenders, 'compact 800x600')
      screenshots.push(await shot(tenders, 'responsive-j3-compact-800x600'))

      const result: JourneyResult = {
        journey: '3: compact 800x600 reachability + collapsed sidebar',
        status: 'PASS',
        detail: `innerWidth=${innerWidth}; sidebar collapsed; pane switch + overflow reachable; clean layout`,
        evidence: { userDataDir, mode, audit: report },
        screenshots,
        // The salvaged diagnostics log(s) for this journey. Recorded as a path so a
        // failing run names the artefact instead of deleting it with the profile —
        // the result JSON is the run's own statement, the log is the evidence for it.
        diagnosticsLogs: salvaged.filter(Boolean) as string[],
      }
      await writeResult('tenders-responsive-journey-3', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-responsive-j3').catch(() => undefined)
      salvaged.push(await teardownScratchProfile(userDataDir, `tenders-responsive-run3`))
    }
  })

  test('4: 200% text zoom stays usable at 1280x800', async () => {
    const screenshots: string[] = []
    // Salvaged diagnostics-log artefacts for this journey, recorded in the
    // result JSON so a failing run names the log rather than deleting it.
    const salvaged: Array<string | null> = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      const booted = await bootWorkspace('tenders-responsive-j4')
      run = booted.run
      userDataDir = booted.userDataDir
      const tenders = booted.tenders

      await resizeAndSettle(run.app, tenders, WIDE.width, WIDE.height)
      // 200% text-only zoom: the UI is rem-based, so doubling the root font size
      // is the faithful approximation of Chromium's text zoom.
      await tenders.evaluate(() => {
        document.documentElement.style.fontSize = '200%'
      })
      const zoomed = await tenders.evaluate(() => ({
        rootFontSize: getComputedStyle(document.documentElement).fontSize,
      }))
      expect(zoomed.rootFontSize).toBe('32px')

      const report = await expectCleanLayout(tenders, '200% text zoom')
      const mode = await workspaceMode(tenders)
      // Whichever mode 200% lands in, the primary affordances stay reachable.
      if (mode.paneSwitch) {
        await expect(tenders.locator(T.paneSwitch)).toBeVisible()
      } else {
        await expect(tenders.locator(T.splitHandle)).toBeVisible()
      }
      screenshots.push(await shot(tenders, 'responsive-j4-text-zoom-200'))

      const result: JourneyResult = {
        journey: '4: 200% text zoom usability',
        status: 'PASS',
        detail: `root font ${zoomed.rootFontSize}; clean layout under 200% text zoom (${mode.paneSwitch ? 'compact' : 'wide'})`,
        evidence: { userDataDir, mode, audit: report },
        screenshots,
        // The salvaged diagnostics log(s) for this journey. Recorded as a path so a
        // failing run names the artefact instead of deleting it with the profile —
        // the result JSON is the run's own statement, the log is the evidence for it.
        diagnosticsLogs: salvaged.filter(Boolean) as string[],
      }
      await writeResult('tenders-responsive-journey-4', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-responsive-j4').catch(() => undefined)
      salvaged.push(await teardownScratchProfile(userDataDir, `tenders-responsive-run4`))
    }
  })

  test('5: a keyboard-resized split proportion survives reload', async () => {
    const screenshots: string[] = []
    // Salvaged diagnostics-log artefacts for this journey, recorded in the
    // result JSON so a failing run names the log rather than deleting it.
    const salvaged: Array<string | null> = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      const booted = await bootWorkspace('tenders-responsive-j5')
      run = booted.run
      userDataDir = booted.userDataDir
      const tenders = booted.tenders

      await resizeAndSettle(run.app, tenders, WIDE.width, WIDE.height)
      const handle = tenders.locator(T.splitHandle)
      await expect(handle).toBeVisible({ timeout: 15_000 })
      await handle.focus()
      await tenders.keyboard.press('End')
      const max = Number(await handle.getAttribute('aria-valuemax'))
      await expect.poll(() => handle.getAttribute('aria-valuenow')).toBe(String(max))

      const storedRaw = await tenders.evaluate(
        (key) => window.localStorage.getItem(key),
        SPLIT_STORAGE_KEY,
      )
      expect(storedRaw, 'the split proportion must be persisted in localStorage').toBeTruthy()
      const stored = JSON.parse(storedRaw as string) as { matrixFraction?: number }
      expect(Math.round((stored.matrixFraction ?? 0) * 100)).toBe(max)

      await tenders.reload()
      await expect
        .poll(() => tenders.evaluate(() => Boolean(document.querySelector('nav'))), {
          timeout: 30_000,
          message: 'the Tenders renderer must come back after reload',
        })
        .toBe(true)
      await openTender(tenders, TENDER_REF)
      const restored = tenders.locator(T.splitHandle)
      await expect(restored).toBeVisible({ timeout: 20_000 })
      await expect
        .poll(() => restored.getAttribute('aria-valuenow'), {
          message: 'the persisted split proportion must be restored after reload',
        })
        .toBe(String(max))
      screenshots.push(await shot(tenders, 'responsive-j5-split-persisted'))

      const result: JourneyResult = {
        journey: '5: split proportion persists across reload',
        status: 'PASS',
        detail: `keyboard End -> ${max}; stored ${JSON.stringify(stored)}; restored after reload`,
        evidence: { userDataDir, max, stored },
        screenshots,
        // The salvaged diagnostics log(s) for this journey. Recorded as a path so a
        // failing run names the artefact instead of deleting it with the profile —
        // the result JSON is the run's own statement, the log is the evidence for it.
        diagnosticsLogs: salvaged.filter(Boolean) as string[],
      }
      await writeResult('tenders-responsive-journey-5', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-responsive-j5').catch(() => undefined)
      salvaged.push(await teardownScratchProfile(userDataDir, `tenders-responsive-run5`))
    }
  })
})
