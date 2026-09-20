/**
 * Phase 5 / Wave 1 lane D — built-Electron verification for WP-13 (theme +
 * accessibility).
 *
 * Contract this spec expects the Tenders layout/a11y lanes to expose:
 *
 * THEME
 *  - The renderer follows the suite theme event (driven here through the shell's
 *    `window.aiOffice.setTheme()`, as in `e2e/theme-pipeline.spec.ts`):
 *      explicit 'light' | 'dark' → `document.documentElement[data-theme] = value`
 *      'system'                  → the shell resolves the OS scheme and stamps
 *                                  the resolved value (data-theme="light|dark");
 *                                  Electron 43 does not propagate
 *                                  `nativeTheme.themeSource` to
 *                                  `prefers-color-scheme`
 *  - `system` follows `prefers-color-scheme` (simulated by setting
 *    `nativeTheme.themeSource` from the main process).
 *  - The choice survives relaunch.
 *  - PDF page canvases and document colours are theme-invariant.
 *
 *  The token/CSS layer and the event plumbing are asserted separately so a
 *  missing listener produces one precise failure (1b) instead of masking the
 *  layer that already works (1a).
 *
 * ACCESSIBILITY
 *  - Every dialog/drawer is `role="dialog"` + `aria-modal="true"` with an
 *    accessible name and a heading; Escape closes it; focus is trapped while
 *    open and restored to the opener on close. Overlays: OnboardingModal,
 *    CompanyFormDialog, CustomerFormDialog, ReadinessDrawer, VaultDrawer,
 *    MilestonesDrawer, TrashDrawer (`documents-trash-button` → labelled
 *    "Trashed documents"), SubmissionDialog, OutcomeDialog, GuidedTour.
 *  - Icon-only controls carry an accessible name; interactive targets are at
 *    least 24x24 CSS px.
 *
 * AXE: `axe-core` is a devDependency; the scan injects `axe-core/axe.min.js`
 * from node_modules and fails loudly on a failed injection or a no-op engine
 * (window.axe version check + a knowingly-broken sentinel fixture must be
 * detected) — it can never report a vacuous pass. The scan only skips itself
 * when axe cannot be resolved at all (run `npm install`).
 *
 * Scratch `userData` under `%LOCALAPPDATA%\Temp\opencode`; cleaned in `finally`.
 */
import { test, expect } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
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

/** `%LOCALAPPDATA%\Temp\opencode` on Windows (os.tmpdir() is %TEMP%). */
const SCRATCH_ROOT = join(tmpdir(), 'opencode')
const LOADED_AT = '2026-09-01T08:00:00.000Z'

const COMPANY_NAME = 'E2E A11y Theme Civils (Pty) Ltd'
const TENDER_REF = 'E2E/A11Y/2026/01'
const TENDER_WON_REF = 'E2E/A11Y/2026/02'
const TENDER_READY_REF = 'E2E/A11Y/2026/03'
const TENDER_SUBMITTED_REF = 'E2E/A11Y/2026/04'

const TOKENS = ['--surface', '--text', '--text-secondary', '--border', '--gs-panel-bg'] as const

// ── seeded store fixture (every overlay reachable without long chains) ────────

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
    description: 'E2E accessibility fixture company.',
    address: '1 Test Road, Test City',
    phone: '+27 10 000 0000',
    email: 'a11y@example.test',
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
    verbatimClause: `E2E clause for ${title}.`,
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
    title: `E2E A11y Tender ${reference}`,
    referenceNumber: reference,
    issuingBody: 'E2E Water Authority',
    closingDate: null,
    submissionMethod: null,
    submissionAddress: null,
    signatureChecks: {},
    status,
    createdAt: LOADED_AT,
    fileName: 'e2e-a11y.pdf',
    fileUrl: '',
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
    activeCompanyId: 'co-a11y',
    workspaces: [
      {
        id: 'co-a11y',
        name: COMPANY_NAME,
        dataOrigin: 'user',
        company: companyProfile(COMPANY_NAME),
        customers: [
          {
            id: 'cust-a11y',
            name: 'E2E A11y Buyer',
            contactName: 'A11y Contact',
            contactEmail: 'buyer@example.test',
            contactPhone: '+27 10 000 0001',
            industry: 'Public sector',
            status: 'ACTIVE',
            since: '2025-01-01',
            notes: 'E2E a11y fixture customer.',
            requiredDocs: [],
          },
        ],
        vault: [
          {
            id: 'vd-a11y',
            title: 'E2E Vault Doc',
            category: 'COMPLIANCE',
            fileUrl: 'vault/e2e-a11y.pdf',
            issueDate: null,
            expiryDate: null,
            isCertified: false,
            certifiedDate: null,
            metadata: {},
          },
        ],
        tenders: [
          tenderFixture('t-a11y-active', TENDER_REF, 'IN_PROGRESS'),
          tenderFixture('t-a11y-won', TENDER_WON_REF, 'WON', {
            milestones: [
              {
                id: 'ms-a11y-1',
                name: 'E2E A11y Milestone',
                amount: 2500,
                status: 'REACHED',
                dueDate: '2026-10-01',
              },
            ],
          }),
          tenderFixture('t-a11y-ready', TENDER_READY_REF, 'READY_FOR_SUBMISSION'),
          tenderFixture('t-a11y-submitted', TENDER_SUBMITTED_REF, 'SUBMITTED'),
        ],
      },
    ],
    issuerTemplates: [],
  }
}

async function writeSeededStore(userDataDir: string): Promise<void> {
  await mkdir(join(userDataDir, 'tenders'), { recursive: true })
  await writeFile(
    join(userDataDir, 'tenders', 'tenders-data.json'),
    JSON.stringify(seededDocument(), null, 2),
    'utf8',
  )
}

// ── scratch + fixture helpers ─────────────────────────────────────────────────

async function scratchUserData(): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  return mkdtemp(join(SCRATCH_ROOT, 'genoffice-e2e-'))
}

async function generateTenderPdf(targetPath: string): Promise<void> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([595, 842])
  page.drawRectangle({ x: 60, y: 520, width: 470, height: 240, color: rgb(0.85, 0.87, 0.9) })
  page.drawRectangle({ x: 90, y: 600, width: 120, height: 60, color: rgb(0.75, 0.2, 0.2) })
  let y = 780
  for (const line of [
    'E2E A11Y THEME FIXTURE',
    'Reference Number: E2E/A11Y/PDF/01',
    'A valid SARS tax clearance certificate must accompany the proposal.',
    'A valid COIDA letter of good standing must accompany the proposal.',
  ]) {
    page.drawText(line, { x: 60, y, size: 12, font })
    y -= 26
  }
  await writeFile(targetPath, Buffer.from(await doc.save()))
}

// ── shell + navigation helpers ────────────────────────────────────────────────

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

async function createCompany(tenders: Page, name: string): Promise<void> {
  await expect(tenders.getByRole('heading', { name: 'No company workspaces yet' })).toBeVisible({
    timeout: 20_000,
  })
  await tenders.getByRole('button', { name: 'Create company workspace' }).click()
  const dialog = tenders.getByRole('dialog', { name: 'Set up your company' })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await dialog.getByLabel('Trading name').fill(name)
  await dialog.getByRole('button', { name: 'Create workspace' }).click()
  await expect(tenders.getByText(name).first()).toBeVisible({ timeout: 15_000 })
  await dismissTendersOnboarding(tenders)
}

async function gotoPage(tenders: Page, label: string): Promise<void> {
  await tenders.locator('nav').getByRole('button', { name: label }).click()
}

/**
 * Return to the Tenders list even when a workspace is currently open: the
 * module keeps the last-open tender, so the nav click alone can land on a
 * workspace where the tender cards are not rendered.
 */
async function openTendersList(tenders: Page): Promise<void> {
  await gotoPage(tenders, 'Tenders')
  const listHeading = tenders.getByRole('heading', { name: 'Tenders', level: 1 })
  const back = tenders.locator('main').getByRole('button', { name: 'Tenders' }).first()
  if (
    !(await listHeading.isVisible().catch(() => false)) &&
    (await back.isVisible().catch(() => false))
  ) {
    await back.click()
  }
  await expect(listHeading).toBeVisible({ timeout: 20_000 })
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

/** Drive the suite theme through the shell's own API (theme-pipeline.spec.ts). */
async function setSuiteTheme(shell: Page, theme: 'light' | 'dark' | 'system'): Promise<void> {
  await shell.evaluate(async (value) => {
    const api = (window as unknown as { aiOffice?: { setTheme(v: string): Promise<void> } })
      .aiOffice
    if (!api) throw new Error('shell window.aiOffice is unavailable')
    await api.setTheme(value)
  }, theme)
}

/** Apply the theme attribute exactly as the renderer contract requires. */
async function applyThemeAttribute(page: Page, theme: 'light' | 'dark' | 'system'): Promise<void> {
  await page.evaluate((value) => {
    if (value === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', value)
  }, theme)
}

async function simulateOsScheme(app: ElectronApplication, scheme: 'dark' | 'light'): Promise<void> {
  await app.evaluate(({ nativeTheme }, value) => {
    nativeTheme.themeSource = value
  }, scheme)
}

/**
 * Flip the simulated OS scheme and wait until the renderer has stamped the
 * resolved theme. The shell deduplicates theme broadcasts, so when the native
 * side already matches the target scheme the helper first flips to the opposite
 * scheme to force a publish. Deterministic whatever the host OS scheme is.
 */
async function applySystemScheme(
  app: ElectronApplication,
  page: Page,
  scheme: 'dark' | 'light',
): Promise<void> {
  const nowDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
  if ((scheme === 'dark') === nowDark) {
    await simulateOsScheme(app, scheme === 'dark' ? 'light' : 'dark')
  }
  await simulateOsScheme(app, scheme)
  await expect
    .poll(() => themeSignature(page).then((s) => s.attr), {
      message: `system mode must resolve and stamp data-theme="${scheme}" for an OS-${scheme} scheme`,
    })
    .toBe(scheme)
}

interface ThemeSignature {
  attr: string | null
  mediaDark: boolean
  tokens: Record<string, string>
  bodyBackground: string
  panelBackground: string
}

async function themeSignature(page: Page): Promise<ThemeSignature> {
  return page.evaluate(
    (names) => {
      const cs = getComputedStyle(document.documentElement)
      const tokens: Record<string, string> = {}
      for (const name of names) tokens[name] = cs.getPropertyValue(name).trim()
      const main = document.querySelector('main')
      return {
        attr: document.documentElement.getAttribute('data-theme'),
        mediaDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
        tokens,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        panelBackground: main ? getComputedStyle(main).backgroundColor : '',
      }
    },
    TOKENS as unknown as string[],
  )
}

/** Stable hash of every rendered PDF canvas + the page wrapper colours. */
async function pdfSignature(page: Page): Promise<{
  canvasCount: number
  hash: string
  pageBackgrounds: string[]
  canvasBackgrounds: string[]
}> {
  return page.evaluate(() => {
    const canvases = Array.from(
      document.querySelectorAll('[data-page] canvas'),
    ) as HTMLCanvasElement[]
    let hash = 2166136261
    const mix = (value: string): void => {
      for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 16777619) >>> 0
      }
    }
    for (const canvas of canvases) {
      try {
        mix(canvas.toDataURL('image/png'))
      } catch {
        mix('unreadable')
      }
    }
    const pages = Array.from(document.querySelectorAll('[data-page]')) as HTMLElement[]
    return {
      canvasCount: canvases.length,
      hash: String(hash),
      pageBackgrounds: pages.map((el) => getComputedStyle(el).backgroundColor),
      canvasBackgrounds: canvases.map((el) => getComputedStyle(el).backgroundColor),
    }
  })
}

/**
 * Hash the PDF canvases only once their pixels have settled. pdf.js renders
 * each page asynchronously after the canvas mounts, so hashing immediately can
 * capture a partially painted canvas and produce a spurious light/dark diff.
 */
async function settledPdfSignature(page: Page): Promise<Awaited<ReturnType<typeof pdfSignature>>> {
  let prev = await pdfSignature(page)
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.waitForTimeout(350)
    const next = await pdfSignature(page)
    if (next.hash === prev.hash && next.canvasCount === prev.canvasCount) return next
    prev = next
  }
  return prev
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
  status: 'PASS' | 'FAIL' | 'SKIPPED'
  detail: string
  evidence: Record<string, unknown>
  screenshots: string[]
}

async function writeResult(name: string, result: JourneyResult): Promise<string> {
  await mkdir(ARTIFACTS_DIR, { recursive: true })
  const path = join(ARTIFACTS_DIR, `${name}.json`)
  await writeFile(path, JSON.stringify(result, null, 2), 'utf8')
  return path
}

// ── axe dependency (devDependency; injection/sentinel checked, never vacuous) ─

function resolveAxeSource(): string | null {
  const candidates: string[] = []
  try {
    const require = createRequire(join(__dirname, '..', 'package.json'))
    candidates.push(require.resolve('axe-core/axe.min.js'))
  } catch {
    // fall through to the explicit node_modules paths
  }
  candidates.push(join(__dirname, '..', 'node_modules', 'axe-core', 'axe.min.js'))
  candidates.push(
    join(
      __dirname,
      '..',
      'node_modules',
      '@axe-core',
      'playwright',
      'node_modules',
      'axe-core',
      'axe.min.js',
    ),
  )
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  return null
}

const AXE_SOURCE = resolveAxeSource()
const AXE_AVAILABLE = AXE_SOURCE !== null

interface AxeViolation {
  id: string
  impact: string | null
  help: string
  nodeCount: number
  targets: unknown[]
  samples: string[]
}

/**
 * Run axe against the whole document. Throws when axe cannot be injected or
 * reports no version — a failed injection must fail the scan, never be coerced
 * into an empty (clean-looking) violation list.
 */
async function runAxe(page: Page): Promise<AxeViolation[]> {
  if (!AXE_SOURCE) {
    throw new Error(
      'axe-core is not resolvable — the scan cannot run (it is a devDependency; run `npm install`)',
    )
  }
  const source = await readFile(AXE_SOURCE, 'utf8')
  await page.addScriptTag({ content: source })
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe?: { version?: string; run(ctx: unknown, opts: unknown): Promise<{ violations: any[] }> }
      }
    ).axe
    if (!axe || !axe.version) {
      throw new Error('axe-core injection failed: window.axe is unavailable')
    }
    const results = await axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      resultTypes: ['violations'],
    })
    return results.violations.map((violation: any) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodeCount: violation.nodes.length,
      targets: violation.nodes.slice(0, 3).map((node: any) => node.target),
      samples: violation.nodes.slice(0, 3).map((node: any) => String(node.html).slice(0, 160)),
    }))
  })
}

interface AxeSentinel {
  version: string
  detected: string[]
}

/**
 * Non-vacuous sentinel: a knowingly-broken fixture (unnamed image + empty
 * button) must be DETECTED by the injected engine, so a failed injection or a
 * silently no-op axe can never masquerade as a clean scan.
 */
async function runAxeSentinel(page: Page): Promise<AxeSentinel> {
  if (!AXE_SOURCE) {
    throw new Error(
      'axe-core is not resolvable — the sentinel cannot run (it is a devDependency; run `npm install`)',
    )
  }
  const source = await readFile(AXE_SOURCE, 'utf8')
  await page.addScriptTag({ content: source })
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe?: { version?: string; run(ctx: unknown, opts: unknown): Promise<{ violations: any[] }> }
      }
    ).axe
    if (!axe || !axe.version) {
      throw new Error('axe-core injection failed: window.axe is unavailable')
    }
    const fixture = document.createElement('div')
    fixture.id = 'axe-sentinel-fixture'
    fixture.setAttribute('style', 'position: fixed; left: -9999px; top: 0')
    fixture.innerHTML =
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10">' +
      '<button type="button" style="width: 24px; height: 24px"></button>'
    document.body.appendChild(fixture)
    try {
      const results = await axe.run(fixture, {
        runOnly: { type: 'rule', values: ['image-alt', 'button-name'] },
        resultTypes: ['violations'],
      })
      return {
        version: axe.version,
        detected: results.violations.map((violation: any) => violation.id).sort(),
      }
    } finally {
      fixture.remove()
    }
  })
}

function seriousViolations(
  violations: Array<{ id: string; impact: string | null }>,
): Array<{ id: string; impact: string | null }> {
  return violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
}

// ── tests ─────────────────────────────────────────────────────────────────────

test.describe('Tenders a11y + theme (Phase 5 / WP-13)', () => {
  test.describe.configure({ timeout: 600_000 })

  test('1a: system mode follows the OS scheme and matches the explicit light/dark token sets', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-a11y-theme-j1a',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)
      await createCompany(tenders, COMPANY_NAME)

      await applyThemeAttribute(tenders, 'dark')
      await expect.poll(() => themeSignature(tenders).then((s) => s.attr)).toBe('dark')
      const dark = await themeSignature(tenders)

      await applyThemeAttribute(tenders, 'light')
      await expect.poll(() => themeSignature(tenders).then((s) => s.attr)).toBe('light')
      const light = await themeSignature(tenders)
      expect(
        dark.tokens['--surface'],
        'the dark token set must differ from the light token set',
      ).not.toBe(light.tokens['--surface'])

      // System mode is resolved in the shell main process (Electron 43 does not
      // propagate nativeTheme.themeSource to prefers-color-scheme), so drive the
      // real path: the suite theme event selects 'system', main reads
      // nativeTheme.shouldUseDarkColors, republishes the concrete value and the
      // renderer stamps it.
      await setSuiteTheme(run.page, 'system')
      await applySystemScheme(run.app, tenders, 'light')
      await applySystemScheme(run.app, tenders, 'dark')
      const systemDark = await themeSignature(tenders)
      await applySystemScheme(run.app, tenders, 'light')
      const systemLight = await themeSignature(tenders)

      expect(systemDark.tokens, 'system+dark must match the explicit dark tokens').toEqual(
        dark.tokens,
      )
      expect(systemLight.tokens, 'system+light must match the explicit light tokens').toEqual(
        light.tokens,
      )
      screenshots.push(await shot(tenders, 'a11y-theme-j1a-signatures'))

      const result: JourneyResult = {
        journey: '1a: system scheme + token equivalence',
        status: 'PASS',
        detail:
          'system+dark matches explicit dark tokens; system+light matches explicit light tokens; the shell resolves system from nativeTheme and the renderer stamps the resolved data-theme',
        evidence: { userDataDir, dark, light, systemDark, systemLight },
        screenshots,
      }
      await writeResult('tenders-a11y-theme-journey-1a', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-a11y-theme-j1a').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('1b: the suite theme event drives data-theme and the choice survives relaunch', async () => {
    const screenshots: string[] = []
    let run1: LaunchedApp | undefined
    let run2: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-a11y-theme-j1b-run1',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)
      await dismissTendersOnboarding(tenders)
      await createCompany(tenders, COMPANY_NAME)

      // Reference token sets from the documented attribute path, so the suite
      // event assertions compare effective rendering rather than one particular
      // implementation of system-mode resolution.
      await applyThemeAttribute(tenders, 'dark')
      const refDark = await themeSignature(tenders)
      await applyThemeAttribute(tenders, 'light')
      const refLight = await themeSignature(tenders)
      expect(refDark.tokens['--surface']).not.toBe(refLight.tokens['--surface'])

      // The renderer must listen to the suite theme event and mirror it.
      await setSuiteTheme(run1.page, 'dark')
      await expect
        .poll(() => themeSignature(tenders).then((s) => s.attr), {
          message:
            'Tenders must follow app:theme-changed (data-theme="dark" for the dark suite theme)',
        })
        .toBe('dark')
      await expect
        .poll(() => themeSignature(tenders).then((s) => s.tokens), {
          message: 'the dark suite theme must render the dark token set',
        })
        .toEqual(refDark.tokens)

      await setSuiteTheme(run1.page, 'light')
      await expect
        .poll(() => themeSignature(tenders).then((s) => s.attr), {
          message: 'Tenders must follow the suite theme event for light',
        })
        .toBe('light')
      await expect
        .poll(() => themeSignature(tenders).then((s) => s.tokens), {
          message: 'the light suite theme must render the light token set',
        })
        .toEqual(refLight.tokens)

      // System mode: the shell resolves the stored preference against the OS
      // scheme and republishes the concrete value, which the renderer stamps as
      // data-theme (Electron 43 cannot propagate themeSource to
      // prefers-color-scheme).
      await setSuiteTheme(run1.page, 'system')
      await applySystemScheme(run1.app, tenders, 'light')
      await expect
        .poll(() => themeSignature(tenders).then((s) => s.tokens), {
          message: 'system mode under an OS-light scheme must render the light token set',
        })
        .toEqual(refLight.tokens)
      await applySystemScheme(run1.app, tenders, 'dark')
      await expect
        .poll(() => themeSignature(tenders).then((s) => s.tokens), {
          message: 'system mode under an OS-dark scheme must render the dark token set',
        })
        .toEqual(refDark.tokens)
      screenshots.push(await shot(tenders, 'a11y-theme-j1b-system-resolution'))

      // Persisted explicit choice survives relaunch.
      await setSuiteTheme(run1.page, 'dark')
      await expect.poll(() => themeSignature(tenders).then((s) => s.attr)).toBe('dark')
      await closeAndSaveVideo(run1, 'tenders-a11y-theme-j1b-run1')
      run1 = undefined

      run2 = await launchShell({ userDataDir, videoDir: 'tenders-a11y-theme-j1b-run2' })
      const tenders2 = await openTendersFromNav(run2.app, run2.page)
      await expect
        .poll(() => themeSignature(tenders2).then((s) => s.attr), {
          message: 'the persisted theme must apply after relaunch',
        })
        .toBe('dark')
      const afterRelaunch = await themeSignature(tenders2)
      expect(afterRelaunch.tokens).toEqual(refDark.tokens)

      const result: JourneyResult = {
        journey: '1b: suite theme event plumbing + system resolution + relaunch persistence',
        status: 'PASS',
        detail:
          "explicit dark/light follow the suite event and render the matching token sets; system mode is resolved and stamped by the shell against the simulated OS scheme; 'dark' persists across relaunch",
        evidence: { userDataDir, refDark, refLight, afterRelaunch },
        screenshots,
      }
      await writeResult('tenders-a11y-theme-journey-1b', result)
    } finally {
      if (run1) await closeAndSaveVideo(run1, 'tenders-a11y-theme-j1b-run1').catch(() => undefined)
      if (run2) await closeAndSaveVideo(run2, 'tenders-a11y-theme-j1b-run2').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('2: PDF page rendering and document colours do not change with the UI theme', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-a11y-theme-j2',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)
      await createCompany(tenders, COMPANY_NAME)

      const fixture = join(userDataDir, 'a11y-theme-fixture.pdf')
      await generateTenderPdf(fixture)
      await tenders.locator('nav').getByRole('button', { name: 'Tenders' }).click()
      await tenders.locator('input[type="file"][accept*="pdf"]').first().setInputFiles(fixture)
      await expect(tenders.getByRole('heading', { name: 'Compliance matrix' })).toBeVisible({
        timeout: 90_000,
      })
      await expect(tenders.locator('[data-page] canvas').first()).toBeVisible({ timeout: 30_000 })

      const lightSig = await settledPdfSignature(tenders)
      expect(lightSig.canvasCount, 'at least one PDF page canvas rendered').toBeGreaterThan(0)

      await applyThemeAttribute(tenders, 'dark')
      await expect.poll(() => themeSignature(tenders).then((s) => s.attr)).toBe('dark')
      const darkSig = await settledPdfSignature(tenders)

      // System mode through the real path: the shell resolves 'system' against
      // the OS scheme and the renderer stamps the resolved data-theme.
      await setSuiteTheme(run.page, 'system')
      await applySystemScheme(run.app, tenders, 'dark')
      const systemDarkSig = await settledPdfSignature(tenders)

      expect(darkSig.canvasCount).toBe(lightSig.canvasCount)
      expect(darkSig.hash, 'PDF canvas pixels must be identical in dark UI').toBe(lightSig.hash)
      expect(systemDarkSig.hash, 'PDF canvas pixels must be identical under system dark').toBe(
        lightSig.hash,
      )
      expect(darkSig.pageBackgrounds, 'PDF page wrappers must keep document colours').toEqual(
        lightSig.pageBackgrounds,
      )
      expect(darkSig.canvasBackgrounds).toEqual(lightSig.canvasBackgrounds)
      screenshots.push(await shot(tenders, 'a11y-theme-j2-pdf-dark'))

      const result: JourneyResult = {
        journey: '2: PDF/document colours are theme-invariant',
        status: 'PASS',
        detail: `canvas hash identical across light/dark/system-dark (${lightSig.canvasCount} canvases); page backgrounds identical`,
        evidence: { userDataDir, lightSig, darkSig, systemDarkSig },
        screenshots,
      }
      await writeResult('tenders-a11y-theme-journey-2', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-a11y-theme-j2').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('3: no critical/serious axe violations on core pages and overlays', async () => {
    test.skip(
      !AXE_AVAILABLE,
      'axe-core is a devDependency but is not resolvable in this checkout — run `npm install`. ' +
        'The scan injects `axe-core/axe.min.js` from node_modules with page.addScriptTag and fails ' +
        'loudly (injection version check + sentinel fixture) instead of reporting a vacuous pass. ' +
        'Looked for: ' +
        [
          'node_modules/axe-core/axe.min.js (repo root, via require.resolve)',
          'node_modules/axe-core/axe.min.js',
          'node_modules/@axe-core/playwright/node_modules/axe-core/axe.min.js',
        ].join(' | '),
    )
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      await writeSeededStore(userDataDir)
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-a11y-theme-j3',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)

      // Non-vacuous sentinel first: the injected engine must detect a
      // knowingly-broken fixture, so a failed injection can never look like a
      // clean scan.
      const sentinel = await runAxeSentinel(tenders)
      expect(
        sentinel.detected,
        `the axe sentinel must detect the broken fixture (axe ${sentinel.version})`,
      ).toEqual(['button-name', 'image-alt'])

      const records: Array<{ label: string; violations: unknown[]; all: unknown[] }> = []
      const scan = async (
        label: string,
        open: () => Promise<void>,
        close?: () => Promise<void>,
      ) => {
        await open()
        const violations = await runAxe(tenders)
        records.push({ label, violations: seriousViolations(violations), all: violations })
        if (close) await close()
      }

      for (const page of ['Overview', 'Customers', 'Documents', 'Tenders', 'Company Profile']) {
        await scan(`page:${page}`, async () => {
          await gotoPage(tenders, page)
        })
      }

      await scan(
        'dialog:company-edit',
        async () => {
          await gotoPage(tenders, 'Company Profile')
          await tenders.getByRole('button', { name: 'Edit profile' }).click()
          await expect(tenders.getByRole('dialog', { name: 'Edit company profile' })).toBeVisible()
        },
        async () => {
          await tenders.keyboard.press('Escape')
        },
      )
      await scan(
        'dialog:customer-create',
        async () => {
          await gotoPage(tenders, 'Customers')
          await tenders.getByRole('button', { name: 'Add customer' }).click()
          await expect(tenders.getByRole('dialog', { name: 'Add a customer' })).toBeVisible()
        },
        async () => {
          await tenders.keyboard.press('Escape')
        },
      )
      await scan('drawer:readiness', async () => {
        await openTender(tenders, TENDER_REF)
        await tenders.getByRole('button', { name: 'Bid readiness' }).click()
        await expect(tenders.getByText('Bid readiness').first()).toBeVisible()
      })
      await scan('drawer:vault', async () => {
        await openTender(tenders, TENDER_REF)
        await tenders.getByRole('button', { name: 'Company vault' }).click()
      })
      await scan('drawer:milestones', async () => {
        await openTender(tenders, TENDER_WON_REF)
        await tenders
          .getByRole('button', { name: /^Milestones/ })
          .first()
          .click()
        await expect(tenders.getByRole('heading', { name: 'Contract Milestones' })).toBeVisible()
      })
      await scan(
        'drawer:trash',
        async () => {
          await gotoPage(tenders, 'Documents')
          await tenders.locator('[data-testid="documents-trash-button"]').click()
          await expect(tenders.getByRole('dialog', { name: 'Trashed documents' })).toBeVisible({
            timeout: 15_000,
          })
        },
        async () => {
          await tenders.keyboard.press('Escape')
        },
      )
      await scan(
        'dialog:tender-delete',
        async () => {
          await openTendersList(tenders)
          const removeButton = tenders
            .locator('main li', { hasText: TENDER_REF })
            .getByRole('button', { name: 'Remove tender' })
            .first()
          await expect(removeButton).toBeVisible({ timeout: 20_000 })
          await removeButton.click()
          await expect(tenders.locator('[data-testid="delete-tender-dialog"]')).toBeVisible({
            timeout: 15_000,
          })
        },
        async () => {
          await tenders.keyboard.press('Escape')
        },
      )
      await scan(
        'dialog:limitations',
        async () => {
          await gotoPage(tenders, 'Tutorials')
          const trigger = tenders.getByRole('button', { name: 'What Tenders does not do' }).first()
          await expect(trigger).toBeVisible({ timeout: 20_000 })
          await trigger.click()
          await expect(
            tenders.getByRole('dialog', { name: 'What Tenders does not do' }),
          ).toBeVisible({ timeout: 15_000 })
        },
        async () => {
          await tenders.keyboard.press('Escape')
        },
      )
      await scan(
        'dialog:submission',
        async () => {
          await openTender(tenders, TENDER_READY_REF)
          const panel = tenders.getByRole('region', { name: 'Tender lifecycle' })
          await panel.getByRole('button', { name: /^Record submission/ }).click()
          await expect(tenders.getByRole('dialog', { name: 'Record the submission' })).toBeVisible()
        },
        async () => {
          await tenders.keyboard.press('Escape')
        },
      )
      await scan(
        'dialog:outcome',
        async () => {
          await openTender(tenders, TENDER_SUBMITTED_REF)
          const panel = tenders.getByRole('region', { name: 'Tender lifecycle' })
          await panel
            .getByRole('button', { name: /^Record outcome/ })
            .first()
            .click()
          await expect(
            tenders.getByRole('dialog', { name: 'Record the tender outcome' }),
          ).toBeVisible()
        },
        async () => {
          await tenders.keyboard.press('Escape')
        },
      )
      await scan('panel:extraction-review', async () => {
        await openTender(tenders, TENDER_REF)
        await tenders
          .getByRole('button', { name: /Review extraction/ })
          .first()
          .click()
        await expect(tenders.getByRole('region', { name: 'Extraction review' })).toBeVisible()
      })
      screenshots.push(await shot(tenders, 'a11y-theme-j3-axe'))

      const failures = records.filter((entry) => entry.violations.length > 0)
      const result: JourneyResult = {
        journey: '3: axe scan (critical/serious = 0)',
        status: failures.length === 0 ? 'PASS' : 'FAIL',
        detail:
          failures.length === 0
            ? `${records.length} surfaces scanned; no critical/serious violations`
            : `${failures.length}/${records.length} surfaces with critical/serious violations: ` +
              failures.map((entry) => entry.label).join(', '),
        evidence: {
          userDataDir,
          axeSource: AXE_SOURCE,
          axeVersion: sentinel.version,
          sentinel: sentinel.detected,
          surfaces: records,
        },
        screenshots,
      }
      await writeResult('tenders-a11y-theme-journey-3', result)
      expect(
        failures,
        `critical/serious axe violations: ${JSON.stringify(failures, null, 2)}`,
      ).toEqual([])
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-a11y-theme-j3').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('4: dialogs/drawers have labelled headings, aria-modal, Escape close, focus trap + restore', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      await writeSeededStore(userDataDir)
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-a11y-theme-j4',
      })
      const tenders = await openTendersFromNav(run.app, run.page)

      const outcomes: Array<Record<string, unknown>> = []
      const failures: string[] = []

      const checkSemantics = async (
        label: string,
        dialog: Locator,
      ): Promise<Record<string, unknown>> => {
        const record: Record<string, unknown> = { label }
        try {
          await expect(dialog, `${label}: role=dialog must be present`).toBeVisible({
            timeout: 10_000,
          })
          expect(
            await dialog.getAttribute('aria-modal'),
            `${label}: aria-modal="true" required`,
          ).toBe('true')
          const name = (await dialog.getAttribute('aria-label')) ?? ''
          const labelledBy = (await dialog.getAttribute('aria-labelledby')) ?? ''
          expect(
            name.length > 0 || labelledBy.length > 0,
            `${label}: an accessible name (aria-label/aria-labelledby) is required`,
          ).toBe(true)
          const heading = dialog.locator('h1, h2, h3').first()
          expect(await heading.count(), `${label}: a labelled heading is required`).toBeGreaterThan(
            0,
          )
          await expect(heading).toBeVisible()

          let escaped = false
          for (let i = 0; i < 40; i += 1) {
            await tenders.keyboard.press('Tab')
            const inside = await dialog
              .evaluate((el) => el.contains(document.activeElement))
              .catch(() => false)
            if (!inside) {
              escaped = true
              break
            }
          }
          expect(escaped, `${label}: focus must be trapped while open`).toBe(false)

          await tenders.keyboard.press('Escape')
          await expect(dialog, `${label}: Escape must close the overlay`).toBeHidden({
            timeout: 10_000,
          })
          record.escapeClosed = true
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error)
          failures.push(`${label}: ${record.error}`)
          await tenders.keyboard.press('Escape').catch(() => {})
        }
        outcomes.push(record)
        return record
      }

      // OnboardingModal: shown until dismissed, no opener to restore to.
      const onboarding = tenders.getByRole('dialog', { name: /welcome|Zanostack Tenders/i })
      if ((await onboarding.count()) > 0) {
        await checkSemantics('onboarding modal', onboarding)
      }
      await dismissTendersOnboarding(tenders)

      interface Overlay {
        label: string
        opener: () => Promise<Locator>
        dialog: () => Locator
      }
      const overlays: Overlay[] = [
        {
          label: 'company form (edit)',
          opener: async () => {
            await gotoPage(tenders, 'Company Profile')
            const button = tenders.getByRole('button', { name: 'Edit profile' })
            await button.click()
            return button
          },
          dialog: () => tenders.getByRole('dialog', { name: 'Edit company profile' }),
        },
        {
          label: 'customer form (create)',
          opener: async () => {
            await gotoPage(tenders, 'Customers')
            const button = tenders.getByRole('button', { name: 'Add customer' })
            await button.click()
            return button
          },
          dialog: () => tenders.getByRole('dialog', { name: 'Add a customer' }),
        },
        {
          label: 'readiness drawer',
          opener: async () => {
            await openTender(tenders, TENDER_REF)
            const button = tenders.getByRole('button', { name: 'Bid readiness' })
            await button.click()
            return button
          },
          dialog: () => tenders.getByRole('dialog', { name: /Bid readiness/ }),
        },
        {
          label: 'vault drawer',
          opener: async () => {
            await openTender(tenders, TENDER_REF)
            const button = tenders.getByRole('button', { name: 'Company vault' })
            await button.click()
            return button
          },
          dialog: () => tenders.getByRole('dialog', { name: /vault/i }),
        },
        {
          label: 'milestones drawer',
          opener: async () => {
            await openTender(tenders, TENDER_WON_REF)
            const button = tenders.getByRole('button', { name: /^Milestones/ }).first()
            await button.click()
            return button
          },
          dialog: () => tenders.getByRole('dialog', { name: /milestones/i }),
        },
        {
          label: 'trash drawer',
          opener: async () => {
            await gotoPage(tenders, 'Documents')
            const button = tenders.locator('[data-testid="documents-trash-button"]')
            await button.click()
            return button
          },
          dialog: () => tenders.getByRole('dialog', { name: 'Trashed documents' }),
        },
        {
          label: 'tender-delete dialog',
          opener: async () => {
            await openTendersList(tenders)
            const button = tenders
              .locator('main li', { hasText: TENDER_REF })
              .getByRole('button', { name: 'Remove tender' })
              .first()
            await button.click()
            return button
          },
          dialog: () => tenders.locator('[data-testid="delete-tender-dialog"] [role="dialog"]'),
        },
        {
          label: 'limitations notice',
          opener: async () => {
            await gotoPage(tenders, 'Tutorials')
            const button = tenders.getByRole('button', { name: 'What Tenders does not do' }).first()
            await button.click()
            return button
          },
          dialog: () => tenders.getByRole('dialog', { name: 'What Tenders does not do' }),
        },
        {
          label: 'submission dialog',
          opener: async () => {
            await openTender(tenders, TENDER_READY_REF)
            const button = tenders
              .getByRole('region', { name: 'Tender lifecycle' })
              .getByRole('button', { name: /^Record submission/ })
            await button.click()
            return button
          },
          dialog: () => tenders.getByRole('dialog', { name: 'Record the submission' }),
        },
        {
          label: 'outcome dialog',
          opener: async () => {
            await openTender(tenders, TENDER_SUBMITTED_REF)
            const button = tenders
              .getByRole('region', { name: 'Tender lifecycle' })
              .getByRole('button', { name: /^Record outcome/ })
              .first()
            await button.click()
            return button
          },
          dialog: () => tenders.getByRole('dialog', { name: 'Record the tender outcome' }),
        },
      ]

      for (const overlay of overlays) {
        const opener = await overlay.opener()
        const dialog = overlay.dialog()
        const record = await checkSemantics(overlay.label, dialog)
        if (!record.error) {
          const restored = await opener.evaluate(
            (el) => el === document.activeElement || el.contains(document.activeElement),
          )
          if (!restored) {
            record.error = 'focus was not restored to the opener after close'
            failures.push(`${overlay.label}: ${record.error}`)
          } else {
            record.focusRestored = true
          }
        }
      }
      screenshots.push(await shot(tenders, 'a11y-theme-j4-dialog-semantics'))

      expect(failures, `overlay semantics failures:\n${failures.join('\n')}`).toEqual([])
      const result: JourneyResult = {
        journey: '4: overlay dialog semantics (name/modal/Escape/trap/restore)',
        status: 'PASS',
        detail: `${outcomes.length} overlays verified`,
        evidence: { userDataDir, outcomes },
        screenshots,
      }
      await writeResult('tenders-a11y-theme-journey-4', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-a11y-theme-j4').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('5: icon-only controls are named, hit targets >= 24px, and a keyboard-only journey works', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      await writeSeededStore(userDataDir)
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-a11y-theme-j5',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)

      const surfaces = ['Overview', 'Customers', 'Documents', 'Tenders', 'Company Profile']
      const unnamed: Array<{ surface: string; html: string }> = []
      const undersized: Array<{ surface: string; html: string; w: number; h: number }> = []
      for (const surface of surfaces) {
        await gotoPage(tenders, surface)
        const report = await tenders.evaluate(() => {
          const visible = (el: Element): boolean => {
            const rect = (el as HTMLElement).getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          }
          const named = (el: Element): boolean =>
            Boolean(
              (el.getAttribute('aria-label') ?? '').trim() ||
              (el.getAttribute('title') ?? '').trim() ||
              (el.textContent ?? '').trim() ||
              (el.getAttribute('aria-labelledby') ?? '').trim(),
            )
          const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
          const unnamed = buttons
            .filter((el) => visible(el) && !named(el))
            .map((el) => el.outerHTML.slice(0, 140))
          const targets = Array.from(
            document.querySelectorAll(
              'button, [role="button"], a[href], select, input:not([type="hidden"]), [role="tab"], [role="menuitem"]',
            ),
          )
          const undersized = targets
            .filter((el) => visible(el))
            .map((el) => {
              const rect = el.getBoundingClientRect()
              return {
                html: el.outerHTML.slice(0, 140),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
              }
            })
            .filter((entry) => entry.w < 24 || entry.h < 24)
          return { unnamed, undersized }
        })
        for (const html of report.unnamed) unnamed.push({ surface, html })
        for (const entry of report.undersized) undersized.push({ surface, ...entry })
      }
      screenshots.push(await shot(tenders, 'a11y-theme-j5-controls'))
      expect(
        unnamed,
        `icon-only controls without an accessible name: ${JSON.stringify(unnamed, null, 2)}`,
      ).toEqual([])
      expect(
        undersized,
        `interactive targets below 24x24px: ${JSON.stringify(undersized, null, 2)}`,
      ).toEqual([])

      // No keyboard trap on the core surface: Tab keeps moving and reaches at
      // least min(8, N) distinct focusable identities, where N is the number of
      // distinct identities present on the page. Identity is tag + accessible
      // name — sibling controls share class names, which would collapse them.
      await gotoPage(tenders, 'Tenders')
      const focusIdentity = (): Promise<string> =>
        tenders.evaluate(() => {
          const el = document.activeElement as HTMLElement | null
          if (!el || el === document.body) return 'body'
          const name = (
            el.getAttribute('aria-label') ??
            el.getAttribute('title') ??
            el.textContent ??
            ''
          )
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 48)
          return `${el.tagName}:${JSON.stringify(name)}`
        })
      const domFocusables = await tenders.evaluate(() => {
        const names = new Set<string>()
        for (const el of Array.from(
          document.querySelectorAll(
            'button, [role="button"], a[href], select, input:not([type="hidden"]), [role="tab"], [tabindex]',
          ),
        )) {
          if (el.hasAttribute('disabled')) continue
          const tabindex = el.getAttribute('tabindex')
          if (tabindex !== null && Number(tabindex) < 0) continue
          const rect = (el as HTMLElement).getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) continue
          const name = (
            el.getAttribute('aria-label') ??
            el.getAttribute('title') ??
            el.textContent ??
            ''
          )
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 48)
          names.add(`${el.tagName}:${JSON.stringify(name)}`)
        }
        return names.size
      })
      const visited: string[] = []
      for (let i = 0; i < 40; i += 1) {
        await tenders.keyboard.press('Tab')
        visited.push(await focusIdentity())
      }
      const distinct = new Set(visited).size
      expect(
        distinct,
        `Tab must move between controls (no trap): reached ${distinct} distinct focusables ` +
          `(page exposes ${domFocusables}): ${JSON.stringify([...new Set(visited)])}`,
      ).toBeGreaterThanOrEqual(Math.min(domFocusables, 8))

      // Keyboard-only critical action: operate a requirement status select.
      await openTender(tenders, TENDER_REF)
      const firstRow = tenders.locator('main li', { hasText: 'E2E requirement one' }).first()
      await expect(firstRow).toBeVisible({ timeout: 20_000 })
      const expand = firstRow.locator('button[title="Show clause details"]').first()
      await expand.focus()
      await tenders.keyboard.press('Enter')
      const select = firstRow.locator('select:has(option[value="FULFILLED"])').first()
      await expect(select).toBeVisible()
      const before = await select.inputValue()
      const after = before === 'FULFILLED' ? 'ACTION_REQUIRED' : 'FULFILLED'
      const optionValues = await select.evaluate((el) =>
        Array.from((el as HTMLSelectElement).options).map((option) => option.value),
      )
      const targetIndex = optionValues.indexOf(after)
      expect(targetIndex, `${after} must be selectable`).toBeGreaterThanOrEqual(0)
      await select.focus()
      await tenders.keyboard.press('Home')
      for (let i = 0; i < targetIndex; i += 1) await tenders.keyboard.press('ArrowDown')
      await tenders.keyboard.press('Enter')
      await expect(select).toHaveValue(after)
      await expect(tenders.getByText('Saved', { exact: true }).first()).toBeVisible({
        timeout: 20_000,
      })
      screenshots.push(await shot(tenders, 'a11y-theme-j5-keyboard-journey'))

      const result: JourneyResult = {
        journey: '5: named icon controls, 24px targets, keyboard-only journey',
        status: 'PASS',
        detail: `0 unnamed icon controls; 0 undersized targets; keyboard status change ${before} -> ${after}`,
        evidence: {
          userDataDir,
          unnamed,
          undersized,
          domFocusables,
          distinct,
          visitedSample: visited.slice(0, 10),
        },
        screenshots,
      }
      await writeResult('tenders-a11y-theme-journey-5', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-a11y-theme-j5').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
