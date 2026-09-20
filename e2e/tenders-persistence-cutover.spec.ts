/**
 * Phase 2 / Task 2B — built-Electron journey for the Tenders renderer v2
 * persistence cutover (`docs/tenders-hardening/phase-2-remaining.md`).
 *
 * The renderer store is now a cache over the authoritative on-disk v2 document
 * (`userData/tenders/tenders-data.json`) reached through
 * `loadStoreV2` / `saveStoreV2` / `onStoreChangedV2`. This spec proves the
 * user-visible accept criteria against the real built shell:
 *
 *   1. hydrate -> create/edit a tender or requirement -> save -> restart
 *      survives (fresh profile, no demo)
 *   1b. the same restart-survival promise for a supported UI domain entity
 *      (vault document upload)
 *   2. a legacy v1 file migrates exactly once and stays v2 across restarts
 *   3. a forced WRITE_FAILED shows "Save failed" + Retry, keeps the edit, and
 *      Retry succeeds
 *   4. a forced REVISION_CONFLICT shows "Conflict" + "Reload from disk", never
 *      blind-overwrites, and reload adopts the newer committed document
 *   5. localStorage holds UI preferences only — no domain payloads
 *
 * Observed result: all six journeys pass. Journey 1 exercises the RFP-shred
 * path that previously tripped the v2 schema (shared `boundingBox` references /
 * own-`undefined` optionals); both the shredder and the schema were fixed, so
 * the shredded tender/requirement now persists and survives restart. See the
 * per-journey `e2e/artifacts/*.json` evidence.
 *
 * Isolation: every journey uses a scratch `userData` under
 * `%LOCALAPPDATA%\Temp\opencode` (never the real profile), closes only the
 * Electron processes it launched through the shared harness, and removes its
 * scratch dir when done.
 *
 * Forcing save outcomes: `window.tendersApi` is a frozen contextBridge object,
 * so it cannot be monkeypatched from the renderer. Instead the genuine
 * `tenders:save-store-v2` IPC handler is wrapped in the main process
 * (`ipcMain._invokeHandlers`) to return a forced error, then restored — the
 * renderer path exercised is exactly the production one.
 *
 * Build first: `npm run build -w @genoffice/tenders && npm run build -w @genoffice/shell`.
 * No application source is modified by this spec.
 */
import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  launchShell,
  closeAndSaveVideo,
  waitForPageWithUrl,
  screenshotPath,
  ARTIFACTS_DIR,
  SHELL_DIR,
  type LaunchedApp,
} from './helpers'

const TENDERS_DEMO_DIR = resolve(SHELL_DIR, '..', 'tenders', 'public', 'demo')
const SAMPLE_RFP = join(TENDERS_DEMO_DIR, 'sample-rfp.pdf')
const VAULT_PDF = join(TENDERS_DEMO_DIR, 'vault', 'tax-clearance.pdf')

/** `%LOCALAPPDATA%\Temp\opencode` on Windows (os.tmpdir() is %TEMP%). */
const SCRATCH_ROOT = join(tmpdir(), 'opencode')
const SAVE_CHANNEL = 'tenders:save-store-v2'

const COMPANY_ONE = 'E2E Cutover Civils (Pty) Ltd'
const COMPANY_TWO = 'E2E Second Company (Pty) Ltd'
const COMPANY_THREE = 'E2E Third Company (Pty) Ltd'
const LS_SENTINEL_COMPANY = 'E2E-LOCALSTORAGE-SENTINEL-CO'
const LEGACY_COMPANY = 'Legacy Migration Civils (Pty) Ltd'
const DISK_ONLY_CUSTOMER = 'DISK-ONLY-CUSTOMER-ACME'

const COMPANY_NAME_PLACEHOLDER = 'e.g. Lephalale Civils (Pty) Ltd'
const LOADED_AT = '2026-08-01T08:00:00.000Z'

// ── scratch profile + store helpers ───────────────────────────────────────────

async function scratchUserData(): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  return mkdtemp(join(SCRATCH_ROOT, 'genoffice-e2e-'))
}

function storeFile(userDataDir: string): string {
  return join(userDataDir, 'tenders', 'tenders-data.json')
}

async function readStore(userDataDir: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(storeFile(userDataDir), 'utf8'))
  } catch {
    return null
  }
}

async function writeStoreRaw(userDataDir: string, document: unknown): Promise<void> {
  await mkdir(join(userDataDir, 'tenders'), { recursive: true })
  await writeFile(storeFile(userDataDir), JSON.stringify(document, null, 2), 'utf8')
}

async function pollStore(
  userDataDir: string,
  predicate: (store: any) => boolean,
  timeoutMs = 25_000,
): Promise<any | null> {
  const deadline = Date.now() + timeoutMs
  let last: any | null = null
  while (Date.now() < deadline) {
    last = await readStore(userDataDir)
    if (last && predicate(last)) return last
    await new Promise((r) => setTimeout(r, 200))
  }
  return last
}

async function storeSignature(userDataDir: string): Promise<string> {
  try {
    const s = await stat(storeFile(userDataDir))
    return `${s.size}:${Math.round(s.mtimeMs)}`
  } catch {
    return 'missing'
  }
}

/**
 * Observe that the store file stays byte-identical across several polls before
 * proceeding — an observable stability window (no raw sleep) used to catch a
 * stray re-commit after hydration.
 */
async function expectStoreStable(
  userDataDir: string,
  expectedSignature: string,
  samples = 4,
  intervalMs = 250,
): Promise<void> {
  let stable = 0
  await expect
    .poll(
      async () => {
        const signature = await storeSignature(userDataDir)
        stable = signature === expectedSignature ? stable + 1 : 0
        return stable
      },
      { timeout: intervalMs * samples + 4_000, intervals: [intervalMs] },
    )
    .toBeGreaterThanOrEqual(samples)
}

function allTenders(store: any): any[] {
  const out: any[] = []
  for (const workspace of store?.workspaces ?? []) {
    for (const tender of workspace?.tenders ?? []) out.push(tender)
  }
  return out
}

function findRequirement(store: any, predicate: (r: any) => boolean): any | undefined {
  for (const tender of allTenders(store)) {
    for (const requirement of tender?.requirements ?? []) {
      if (predicate(requirement)) return requirement
    }
  }
  return undefined
}

function workspaceNames(store: any): string[] {
  return (store?.workspaces ?? []).map((ws: any) => ws?.name ?? ws?.company?.tradingName ?? '')
}

// ── main-process save-handler control ─────────────────────────────────────────

type InvokeHandler = (...args: unknown[]) => unknown

function wrapSaveHandlerForFailure(app: ElectronApplication, message: string): Promise<void> {
  return app.evaluate(({ ipcMain }, msg) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, InvokeHandler> })
      ._invokeHandlers
    const channel = 'tenders:save-store-v2'
    const original = map.get(channel)
    if (!original) throw new Error('tenders:save-store-v2 handler is not registered')
    ;(globalThis as unknown as Record<string, unknown>).__e2eTendersOriginalSave = original
    let failed = false
    map.set(channel, async (event: unknown, request: unknown) => {
      if (!failed) {
        failed = true
        return { ok: false, error: { code: 'WRITE_FAILED', message: msg } }
      }
      return original(event, request)
    })
  }, message)
}

function wrapSaveHandlerForConflict(app: ElectronApplication, message: string): Promise<void> {
  return app.evaluate(({ ipcMain }, msg) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, InvokeHandler> })
      ._invokeHandlers
    const channel = 'tenders:save-store-v2'
    const original = map.get(channel)
    if (!original) throw new Error('tenders:save-store-v2 handler is not registered')
    ;(globalThis as unknown as Record<string, unknown>).__e2eTendersOriginalSave = original
    map.set(channel, async () => ({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: msg },
    }))
  }, message)
}

function restoreSaveHandler(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ ipcMain }, channel) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, InvokeHandler> })
      ._invokeHandlers
    const original = (globalThis as unknown as Record<string, unknown>).__e2eTendersOriginalSave
    if (map && typeof original === 'function') {
      map.set(channel, original as InvokeHandler)
    }
  }, SAVE_CHANNEL)
}

// ── shell navigation + UI helpers ─────────────────────────────────────────────

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

async function expectSaveState(page: Page, label: string, timeout = 20_000): Promise<void> {
  await expect(page.getByText(label, { exact: true }).first()).toBeVisible({ timeout })
}

async function shot(page: Page, name: string): Promise<string> {
  const target = screenshotPath(name)
  try {
    await page.screenshot({ path: target, timeout: 15_000 })
  } catch {
    // best-effort evidence only
  }
  return target
}

async function createFirstCompany(tenders: Page, name: string): Promise<void> {
  await expect(tenders.getByRole('heading', { name: 'No company workspaces yet' })).toBeVisible({
    timeout: 20_000,
  })
  await tenders.getByRole('button', { name: 'Create company workspace' }).click()
  const input = tenders.getByPlaceholder(COMPANY_NAME_PLACEHOLDER)
  await expect(input).toBeVisible()
  await input.fill(name)
  await tenders.getByRole('button', { name: 'Create workspace' }).click()
  await expect(tenders.getByText(name).first()).toBeVisible({ timeout: 15_000 })
  await dismissTendersOnboarding(tenders)
}

async function addCompanyViaSwitcher(tenders: Page, name: string): Promise<void> {
  await tenders.locator('[data-tour="tour-company-switcher"] button').first().click()
  await tenders.getByRole('button', { name: 'Add company' }).click()
  // WP-8 replaced the old inline add-company modal with the shared
  // CompanyFormDialog ("Set up your company").
  const dialog = tenders.getByRole('dialog', { name: 'Set up your company' })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await dialog.getByLabel('Trading name').fill(name)
  await dialog.getByRole('button', { name: 'Create workspace' }).click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
}

/** Open the tender workspace (list card -> compliance matrix) for `title`. */
async function ensureTenderWorkspace(tenders: Page, title: string): Promise<void> {
  await tenders.locator('nav').getByRole('button', { name: 'Tenders' }).click()
  const matrix = tenders.getByRole('heading', { name: 'Compliance matrix' })
  if (!(await matrix.isVisible().catch(() => false))) {
    const card = tenders.locator('main li', { hasText: title }).first()
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.click()
  }
  await expect(matrix).toBeVisible({ timeout: 20_000 })
}

/** Leave the workspace and return to the tender list (dropzone) view. */
async function backToTenderList(tenders: Page): Promise<void> {
  const back = tenders.locator('main').getByRole('button', { name: 'Tenders' }).first()
  if (await back.isVisible().catch(() => false)) await back.click()
  await expect(tenders.getByRole('heading', { name: 'Tenders', level: 1 })).toBeVisible({
    timeout: 20_000,
  })
}

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Minimal, schema-valid legacy v1 envelope (company + one tender/requirement). */
function legacyV1Document(): unknown {
  return {
    version: 1,
    updatedAt: LOADED_AT,
    activeCompanyId: 'co-legacy',
    workspaces: [
      {
        id: 'co-legacy',
        name: LEGACY_COMPANY,
        company: {
          name: LEGACY_COMPANY,
          tradingName: LEGACY_COMPANY,
          registrationNumber: '2014/123456/07',
          vatNumber: '4820111222',
          taxPin: '9012345678',
          bbbeeLevel: 'Level 1',
          bbbeeBlackOwnership: '100%',
          csdSupplierNumber: 'MAAA0000001',
          founded: '2014',
          employees: '40',
          industry: 'Civil engineering',
          description: 'Legacy v1 fixture for the migration journey.',
          address: '1 Legacy Road, Polokwane',
          phone: '+27 15 000 0000',
          email: 'legacy@example.test',
          website: 'https://legacy.example.test',
          directors: [],
          projects: [],
        },
        customers: [],
        vault: [],
        tenders: [
          {
            id: 'tender-legacy-1',
            title: 'Legacy Reservoir Upgrade',
            referenceNumber: 'LEG/RFP/2026/01',
            issuingBody: 'Legacy Water Board',
            closingDate: null,
            submissionMethod: 'ELECTRONIC',
            submissionAddress: null,
            signatureChecks: {},
            status: 'IN_PROGRESS',
            createdAt: LOADED_AT,
            fileName: 'legacy-rfp.pdf',
            fileUrl: 'documents/legacy-rfp.pdf',
            numPages: 5,
            ocrPages: 0,
            requirements: [
              {
                id: 'req-legacy-1',
                ruleKey: 'rule-legacy-1',
                title: 'Legacy requirement one',
                category: 'MANDATORY_STAGE_1',
                isMandatory: true,
                verbatimClause: 'The bidder must submit a valid tax clearance.',
                pageNumber: 1,
                boundingBox: { top: 0.1, left: 0.1, width: 0.8, height: 0.05 },
                riskLevel: 'CRITICAL_DISQUALIFIER',
                order: 1,
                confidence: 0.9,
                status: 'OUTSTANDING',
                linkedVaultDocId: null,
                reason: null,
                suggestedVaultDocIds: [],
              },
            ],
          },
        ],
      },
    ],
    issuerTemplates: [],
  }
}

interface JourneyResult {
  journey: string
  status: 'PASS' | 'FAIL'
  detail: string
  evidence: Record<string, unknown>
  screenshots: string[]
  videos: string[]
}

async function writeResult(name: string, result: JourneyResult): Promise<string> {
  await mkdir(ARTIFACTS_DIR, { recursive: true })
  const path = join(ARTIFACTS_DIR, `${name}.json`)
  await writeFile(path, JSON.stringify(result, null, 2), 'utf8')
  return path
}

/**
 * Generate a one-page text PDF at runtime (pdf-lib) so a journey can control
 * the exact lines the shredder extracts — used by the B1 closing-date journey
 * to plant a "Closing Date" value the strict schema rejects.
 */
async function generateTextPdf(targetPath: string, lines: string[]): Promise<void> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  let y = 780
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 12, font })
    y -= 24
  }
  const bytes = await doc.save()
  await writeFile(targetPath, Buffer.from(bytes))
}

// ── journeys ──────────────────────────────────────────────────────────────────

test.describe('Tenders renderer v2 persistence cutover (Task 2B)', () => {
  test.describe.configure({ timeout: 600_000 })

  test('journey 1: hydrate -> create tender/requirement -> save -> restart survives', async () => {
    const userDataDir = await scratchUserData()
    const screenshots: string[] = []
    const videos: string[] = []
    let run1: LaunchedApp | undefined
    let run2: LaunchedApp | undefined
    try {
      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-persistence-cutover-j1-run1',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)
      await dismissTendersOnboarding(tenders)

      // Fresh profile: empty workspace, no demo seeding, no store file yet.
      await expect(tenders.getByRole('heading', { name: 'No company workspaces yet' })).toBeVisible(
        {
          timeout: 20_000,
        },
      )
      await expect(tenders.getByText('Thabo Engineering')).toHaveCount(0)
      await expect(tenders.getByText('RFP-WTR-2026-04')).toHaveCount(0)
      expect(await readStore(userDataDir), 'not-found must not write a store file').toBeNull()
      screenshots.push(await shot(tenders, 'cutover-j1-fresh-empty'))

      // Create the first company -> first authoritative commit.
      await createFirstCompany(tenders, COMPANY_ONE)
      await expectSaveState(tenders, 'Saved')
      const afterCompany = await pollStore(
        userDataDir,
        (s) => s.schemaVersion === 2 && s.workspaces?.length === 1,
      )
      expect(afterCompany, 'company commit written to disk').toBeTruthy()
      expect(workspaceNames(afterCompany)).toContain(COMPANY_ONE)

      // Create a tender + requirements by shredding the demo RFP.
      await tenders.locator('nav').getByRole('button', { name: 'Tenders' }).click()
      await expect(tenders.getByRole('heading', { name: 'Tenders', level: 1 })).toBeVisible({
        timeout: 20_000,
      })
      await tenders.locator('input[type="file"][accept*="pdf"]').first().setInputFiles(SAMPLE_RFP)
      await expect(tenders.getByRole('heading', { name: 'Compliance matrix' })).toBeVisible({
        timeout: 90_000,
      })

      // Edit a requirement status -> the cutover must persist the domain change
      // through the authoritative v2 store (gate on the on-disk commit first, so
      // this never races the "Saved" indicator).
      const expand = tenders.locator('button[title="Show clause details"]').first()
      await expect(expand).toBeVisible()
      await expand.click()
      const statusSelect = tenders.locator('select:has(option[value="FULFILLED"])').first()
      await expect(statusSelect).toBeVisible()
      const from = await statusSelect.inputValue()
      const to = from === 'FULFILLED' ? 'ACTION_REQUIRED' : 'FULFILLED'
      await statusSelect.selectOption(to)
      await expect(statusSelect).toHaveValue(to)
      screenshots.push(await shot(tenders, 'cutover-j1-requirement-changed'))

      const afterEdit = await pollStore(
        userDataDir,
        (s) => Boolean(findRequirement(s, (r) => r.status === to)),
        30_000,
      )
      const changed = findRequirement(afterEdit, (r) => r.status === to)
      if (!changed) {
        const alerts = await tenders
          .getByRole('alert')
          .allInnerTexts()
          .catch(() => [] as string[])
        const disk = await readStore(userDataDir)
        await writeResult('tenders-persistence-cutover-journey-1', {
          journey: 'hydrate -> create tender/requirement -> save -> restart survives',
          status: 'FAIL',
          detail: `The authoritative v2 store rejected the shredded tender/requirement; SaveStatus alert = ${JSON.stringify(alerts)}`,
          evidence: {
            userDataDir,
            saveStatusAlerts: alerts,
            diskRevision: disk?.revision ?? null,
            diskWorkspaces: disk ? workspaceNames(disk) : null,
            diskTenderCount: disk?.workspaces?.[0]?.tenders?.length ?? null,
          },
          screenshots,
          videos: videos.filter(Boolean),
        })
        throw new Error(
          `Tenders v2 persistence did not accept the shredded tender/requirement. ` +
            `Observed SaveStatus: ${alerts.join(' | ') || '(none)'}. ` +
            `Disk tenders: ${disk?.workspaces?.[0]?.tenders?.length ?? 'n/a'}.`,
        )
      }
      await expectSaveState(tenders, 'Saved')
      const tenderTitle = allTenders(afterEdit)[0]?.title as string
      const revisionBeforeRestart = afterEdit.revision
      expect(revisionBeforeRestart).toBeGreaterThanOrEqual(1)

      videos.push((await closeAndSaveVideo(run1, 'tenders-persistence-cutover-j1-run1')) ?? '')
      run1 = undefined

      // Relaunch against the SAME scratch profile.
      run2 = await launchShell({
        userDataDir,
        videoDir: 'tenders-persistence-cutover-j1-run2',
      })
      const tenders2 = await openTendersFromNav(run2.app, run2.page)
      await dismissTendersOnboarding(tenders2)
      await expectSaveState(tenders2, 'Saved')

      const afterRestart = await readStore(userDataDir)
      const persisted = findRequirement(afterRestart, (r) => r.id === changed.id)
      expect(persisted?.status, 'changed requirement survives restart on disk').toBe(to)
      expect(afterRestart.revision).toBe(revisionBeforeRestart)

      await ensureTenderWorkspace(tenders2, tenderTitle)
      const row = tenders2.locator('li', { hasText: changed.title }).first()
      await expect(row).toBeVisible({ timeout: 20_000 })
      const expand2 = row.locator('button[title="Show clause details"]')
      if ((await expand2.count()) > 0) await expand2.first().click()
      await expect(row.locator('select:has(option[value="FULFILLED"])').first()).toHaveValue(to)
      screenshots.push(await shot(tenders2, 'cutover-j1-restart-persisted'))

      const result: JourneyResult = {
        journey: 'hydrate -> edit -> save -> restart survives',
        status: 'PASS',
        detail: `${COMPANY_ONE}; requirement "${changed.title}" ${from} -> ${to}; revision ${revisionBeforeRestart}`,
        evidence: {
          userDataDir,
          workspace: COMPANY_ONE,
          tenderTitle,
          changedRequirement: { id: changed.id, title: changed.title, from, to },
          revisionBeforeRestart,
        },
        screenshots,
        videos: videos.filter(Boolean),
      }
      await writeResult('tenders-persistence-cutover-journey-1', result)
    } finally {
      if (run1)
        await closeAndSaveVideo(run1, 'tenders-persistence-cutover-j1-run1').catch(() => undefined)
      if (run2)
        await closeAndSaveVideo(run2, 'tenders-persistence-cutover-j1-run2').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  /**
   * Complementary to journey 1: journey 1 covers a shredded tender/requirement
   * surviving restart, while this journeys the same hydrate -> edit -> save ->
   * restart promise for a second supported UI-created domain entity (a vault
   * document upload) so both persistence shapes are exercised end-to-end.
   */
  test('journey 1b: supported domain change (vault upload) survives restart', async () => {
    const userDataDir = await scratchUserData()
    const screenshots: string[] = []
    const videos: string[] = []
    const vaultTitle = 'E2E Cutover Vault Doc'
    let run1: LaunchedApp | undefined
    let run2: LaunchedApp | undefined
    try {
      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-persistence-cutover-j1b-run1',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)
      await dismissTendersOnboarding(tenders)
      await createFirstCompany(tenders, COMPANY_ONE)
      await expectSaveState(tenders, 'Saved')

      // Upload a vault document through the Documents page.
      await tenders.locator('nav').getByRole('button', { name: 'Documents' }).click()
      await expect(tenders.getByRole('heading', { name: 'Documents' })).toBeVisible({
        timeout: 20_000,
      })
      await tenders.getByRole('button', { name: 'Upload document' }).click()
      await expect(tenders.getByRole('heading', { name: 'Add company document' })).toBeVisible()
      await tenders.getByPlaceholder('e.g. SARS Tax Clearance Certificate').fill(vaultTitle)
      await tenders
        .locator('input[type="file"][accept="application/pdf"]')
        .last()
        .setInputFiles(VAULT_PDF)
      await tenders.getByRole('button', { name: 'Add to vault' }).click()
      await expect(tenders.getByText(vaultTitle).first()).toBeVisible({ timeout: 20_000 })

      const committed = await pollStore(
        userDataDir,
        (s) => (s.workspaces?.[0]?.vault ?? []).some((d: any) => d.title === vaultTitle),
        30_000,
      )
      const doc = (committed?.workspaces?.[0]?.vault ?? []).find((d: any) => d.title === vaultTitle)
      expect(doc, 'vault document committed to the authoritative store').toBeTruthy()
      await expectSaveState(tenders, 'Saved')
      const revision = committed.revision
      screenshots.push(await shot(tenders, 'cutover-j1b-vault-saved'))

      videos.push((await closeAndSaveVideo(run1, 'tenders-persistence-cutover-j1b-run1')) ?? '')
      run1 = undefined

      run2 = await launchShell({
        userDataDir,
        videoDir: 'tenders-persistence-cutover-j1b-run2',
      })
      const tenders2 = await openTendersFromNav(run2.app, run2.page)
      await dismissTendersOnboarding(tenders2)
      await tenders2.locator('nav').getByRole('button', { name: 'Documents' }).click()
      await expect(tenders2.getByText(vaultTitle).first()).toBeVisible({ timeout: 20_000 })
      const afterRestart = await readStore(userDataDir)
      expect(afterRestart.revision, 'vault commit survives restart').toBe(revision)
      expect((afterRestart.workspaces[0].vault as any[]).some((d) => d.title === vaultTitle)).toBe(
        true,
      )
      screenshots.push(await shot(tenders2, 'cutover-j1b-restart-persisted'))

      const result: JourneyResult = {
        journey: 'supported domain change (vault upload) survives restart',
        status: 'PASS',
        detail: `${COMPANY_ONE}; vault "${vaultTitle}" committed at revision ${revision} and present after restart`,
        evidence: { userDataDir, vaultTitle, revision },
        screenshots,
        videos: videos.filter(Boolean),
      }
      await writeResult('tenders-persistence-cutover-journey-1b', result)
    } finally {
      if (run1)
        await closeAndSaveVideo(run1, 'tenders-persistence-cutover-j1b-run1').catch(() => undefined)
      if (run2)
        await closeAndSaveVideo(run2, 'tenders-persistence-cutover-j1b-run2').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('journey 2: legacy v1 migrates once and stays v2 across a restart', async () => {
    const userDataDir = await scratchUserData()
    const screenshots: string[] = []
    const videos: string[] = []
    let run1: LaunchedApp | undefined
    let run2: LaunchedApp | undefined
    try {
      await writeStoreRaw(userDataDir, legacyV1Document())

      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-persistence-cutover-j2-run1',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)
      await dismissTendersOnboarding(tenders)

      await expect(tenders.getByText(LEGACY_COMPANY).first()).toBeVisible({ timeout: 20_000 })
      await expectSaveState(tenders, 'Saved')

      const migrated = await pollStore(
        userDataDir,
        (s) => s.schemaVersion === 2 && workspaceNames(s).includes(LEGACY_COMPANY),
      )
      expect(migrated, 'legacy v1 migrated to v2 on disk').toBeTruthy()
      expect(migrated.schemaVersion).toBe(2)
      expect(migrated.revision, 'migration commit bumps revision off 0').toBeGreaterThanOrEqual(1)
      expect(migrated.workspaces[0].dataOrigin).toBe('user')
      expect(migrated.workspaces[0].tenders?.[0]?.title).toBe('Legacy Reservoir Upgrade')
      const revisionAfterMigration = migrated.revision
      const updatedAfterMigration = migrated.updatedAt
      const signatureAfterMigration = await storeSignature(userDataDir)
      screenshots.push(await shot(tenders, 'cutover-j2-migrated'))

      videos.push((await closeAndSaveVideo(run1, 'tenders-persistence-cutover-j2-run1')) ?? '')
      run1 = undefined

      // Second launch against the same profile must NOT re-commit.
      run2 = await launchShell({ userDataDir, videoDir: 'tenders-persistence-cutover-j2-run2' })
      const tenders2 = await openTendersFromNav(run2.app, run2.page)
      await dismissTendersOnboarding(tenders2)
      await expectSaveState(tenders2, 'Saved')
      await expect(tenders2.getByText(LEGACY_COMPANY).first()).toBeVisible({ timeout: 20_000 })
      // Observe that a stray debounced re-commit never lands after hydration.
      await expectStoreStable(userDataDir, signatureAfterMigration)

      const afterSecond = await readStore(userDataDir)
      expect(afterSecond.schemaVersion).toBe(2)
      expect(afterSecond.revision, 'second launch must not re-commit').toBe(revisionAfterMigration)
      expect(afterSecond.updatedAt, 'second launch must not rewrite the file').toBe(
        updatedAfterMigration,
      )
      expect(await storeSignature(userDataDir)).toBe(signatureAfterMigration)
      screenshots.push(await shot(tenders2, 'cutover-j2-second-launch-stable'))

      const result: JourneyResult = {
        journey: 'v1 migration once, stays v2',
        status: 'PASS',
        detail: `migrated to schemaVersion 2 revision ${revisionAfterMigration}; unchanged after restart`,
        evidence: {
          userDataDir,
          revisionAfterMigration,
          updatedAfterMigration,
          signatureAfterMigration,
        },
        screenshots,
        videos: videos.filter(Boolean),
      }
      await writeResult('tenders-persistence-cutover-journey-2', result)
    } finally {
      if (run1)
        await closeAndSaveVideo(run1, 'tenders-persistence-cutover-j2-run1').catch(() => undefined)
      if (run2)
        await closeAndSaveVideo(run2, 'tenders-persistence-cutover-j2-run2').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('journey 3: forced WRITE_FAILED shows Save failed + Retry, keeps the edit, Retry succeeds', async () => {
    const userDataDir = await scratchUserData()
    const screenshots: string[] = []
    const videos: string[] = []
    let run: LaunchedApp | undefined
    try {
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-persistence-cutover-j3',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)
      await createFirstCompany(tenders, COMPANY_ONE)
      await expectSaveState(tenders, 'Saved')
      const before = await pollStore(userDataDir, (s) => s.workspaces?.length === 1)
      expect(workspaceNames(before)).toEqual([COMPANY_ONE])

      // Force the next save to fail once, then delegate to the real store.
      await wrapSaveHandlerForFailure(run.app, 'Forced write failure (E2E journey 3)')

      await addCompanyViaSwitcher(tenders, COMPANY_TWO)
      await expectSaveState(tenders, 'Save failed', 25_000)
      await expect(tenders.getByRole('button', { name: 'Retry' })).toBeVisible()
      // The unsaved edit must be retained in the UI (active company switched).
      await expect(
        tenders.locator('[data-tour="tour-company-switcher"]').getByText(COMPANY_TWO).first(),
      ).toBeVisible()
      // ...but it must not be on disk while the save is failing.
      const duringFailure = await readStore(userDataDir)
      expect(workspaceNames(duringFailure)).toEqual([COMPANY_ONE])
      screenshots.push(await shot(tenders, 'cutover-j3-save-failed'))

      await tenders.getByRole('button', { name: 'Retry' }).click()
      await expectSaveState(tenders, 'Saved', 25_000)
      const afterRetry = await pollStore(userDataDir, (s) =>
        workspaceNames(s).includes(COMPANY_TWO),
      )
      expect(workspaceNames(afterRetry)).toEqual([COMPANY_ONE, COMPANY_TWO])
      await restoreSaveHandler(run.app)
      screenshots.push(await shot(tenders, 'cutover-j3-retry-saved'))

      const result: JourneyResult = {
        journey: 'save failure -> Retry',
        status: 'PASS',
        detail: `WRITE_FAILED shown; edit kept; Retry persisted ${COMPANY_TWO} (revision ${afterRetry.revision})`,
        evidence: {
          userDataDir,
          revisionBefore: before.revision,
          revisionAfterRetry: afterRetry.revision,
          workspacesAfterRetry: workspaceNames(afterRetry),
        },
        screenshots,
        videos: videos.filter(Boolean),
      }
      await writeResult('tenders-persistence-cutover-journey-3', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-persistence-cutover-j3').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('journey 4: forced REVISION_CONFLICT shows Conflict + Reload, no blind overwrite', async () => {
    const userDataDir = await scratchUserData()
    const screenshots: string[] = []
    const videos: string[] = []
    let run: LaunchedApp | undefined
    try {
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-persistence-cutover-j4',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)
      await createFirstCompany(tenders, COMPANY_ONE)
      await expectSaveState(tenders, 'Saved')
      const base = await pollStore(userDataDir, (s) => s.workspaces?.length === 1)
      expect(workspaceNames(base)).toEqual([COMPANY_ONE])

      // Externally advance the on-disk revision (a "newer" committed document).
      const advanced = JSON.parse(JSON.stringify(base))
      advanced.revision = base.revision + 1
      advanced.updatedAt = new Date().toISOString()
      advanced.workspaces[0].customers = [
        ...(advanced.workspaces[0].customers ?? []),
        {
          id: 'cust-disk-only',
          name: DISK_ONLY_CUSTOMER,
          contactName: 'Disk Contact',
          contactEmail: 'disk@example.test',
          contactPhone: '+27 10 000 0009',
          industry: 'Public sector',
          status: 'ACTIVE',
          since: '2025-01-01',
          notes: 'Written externally by the conflict journey.',
          requiredDocs: [],
        },
      ]
      await writeStoreRaw(userDataDir, advanced)
      // The v2 renderer intentionally does NOT auto-adopt arbitrary external
      // file edits (the store watcher only broadcasts the legacy channel), so
      // the newer revision stays invisible until the user reloads — exactly the
      // conflict scenario.

      // Force every save while conflicted to report REVISION_CONFLICT.
      await wrapSaveHandlerForConflict(
        run.app,
        `Forced conflict: expected ${base.revision} but found ${advanced.revision} (E2E journey 4)`,
      )

      await addCompanyViaSwitcher(tenders, COMPANY_TWO)
      await expectSaveState(tenders, 'Conflict', 25_000)
      await expect(tenders.getByRole('button', { name: 'Reload from disk' })).toBeVisible()
      // Local conflicting edit is retained in the UI.
      await expect(
        tenders.locator('[data-tour="tour-company-switcher"]').getByText(COMPANY_TWO).first(),
      ).toBeVisible()
      // No blind overwrite: observe the disk document stay byte-identical (it
      // keeps the newer revision + payload) while the conflict is on screen.
      const conflictedSignature = await storeSignature(userDataDir)
      await expectStoreStable(userDataDir, conflictedSignature)
      const whileConflicted = await readStore(userDataDir)
      expect(whileConflicted.revision, 'disk revision must not be overwritten').toBe(
        advanced.revision,
      )
      expect(workspaceNames(whileConflicted)).toEqual([COMPANY_ONE])
      expect(JSON.stringify(whileConflicted)).toContain(DISK_ONLY_CUSTOMER)
      screenshots.push(await shot(tenders, 'cutover-j4-conflict'))

      // Reload from disk adopts the committed document and clears the conflict.
      await tenders.getByRole('button', { name: 'Reload from disk' }).click()
      await expectSaveState(tenders, 'Saved', 25_000)
      await expect(tenders.getByText('Conflict', { exact: true })).toHaveCount(0)
      await tenders.locator('nav').getByRole('button', { name: 'Customers' }).click()
      await expect(tenders.getByText(DISK_ONLY_CUSTOMER).first()).toBeVisible({ timeout: 20_000 })
      screenshots.push(await shot(tenders, 'cutover-j4-reloaded'))

      // Next save uses the advanced (disk) revision, proving it was adopted.
      await restoreSaveHandler(run.app)
      await tenders.locator('[data-tour="tour-company-switcher"] button').first().click()
      await tenders.getByRole('button', { name: 'Add company' }).click()
      await tenders.getByPlaceholder(COMPANY_NAME_PLACEHOLDER).fill(COMPANY_THREE)
      await tenders.getByRole('button', { name: 'Create workspace' }).click()
      await expectSaveState(tenders, 'Saved', 25_000)
      const afterThird = await pollStore(userDataDir, (s) => s.revision === advanced.revision + 1)
      expect(afterThird.revision, 'next save adopted the disk revision').toBe(advanced.revision + 1)
      expect(workspaceNames(afterThird)).toContain(COMPANY_THREE)

      const result: JourneyResult = {
        journey: 'revision conflict',
        status: 'PASS',
        detail: `Conflict surfaced at disk revision ${advanced.revision}; no overwrite; reload adopted it; next save -> revision ${afterThird.revision}`,
        evidence: {
          userDataDir,
          baseRevision: base.revision,
          advancedRevision: advanced.revision,
          revisionAfterNextSave: afterThird.revision,
          diskOnlyCustomer: DISK_ONLY_CUSTOMER,
        },
        screenshots,
        videos: videos.filter(Boolean),
      }
      await writeResult('tenders-persistence-cutover-journey-4', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-persistence-cutover-j4').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('journey 5: localStorage holds UI preferences only, no domain payloads', async () => {
    const userDataDir = await scratchUserData()
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    try {
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-persistence-cutover-j5',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)
      await createFirstCompany(tenders, LS_SENTINEL_COMPANY)
      await expectSaveState(tenders, 'Saved')
      // The sentinel domain data is authoritative on disk...
      const store = await pollStore(userDataDir, (s) =>
        JSON.stringify(s).includes(LS_SENTINEL_COMPANY),
      )
      expect(store, 'sentinel domain data persisted on disk').toBeTruthy()

      // ...and must not leak into localStorage.
      const dump = await tenders.evaluate(() => {
        const out: Record<string, string | null> = {}
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key) out[key] = localStorage.getItem(key)
        }
        return out
      })
      const keys = Object.keys(dump)
      const blob = Object.entries(dump)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')

      expect(
        keys.some((k) => k.includes('zanostack-tenders-v1')),
        'legacy v1 key purged',
      ).toBe(false)
      expect(keys).not.toContain('workspaces')
      expect(keys).not.toContain('tenders')
      expect(keys).not.toContain('customers')
      expect(keys).not.toContain('vault')
      expect(blob).not.toMatch(/"workspaces"\s*:/)
      expect(blob).not.toMatch(/"customers"\s*:/)
      expect(blob).not.toMatch(/"vault"\s*:/)
      expect(blob).not.toMatch(/"tenders"\s*:/)
      expect(blob).not.toContain(LS_SENTINEL_COMPANY)
      // The UI-only preference key is allowed.
      expect(keys).toContain('zanostack-tenders-ui')
      screenshots.push(await shot(tenders, 'cutover-j5-localstorage'))

      const result: JourneyResult = {
        journey: 'no domain data in localStorage',
        status: 'PASS',
        detail: `localStorage keys: ${keys.join(', ')}; domain payloads only on disk`,
        evidence: {
          userDataDir,
          localStorageKeys: keys,
          hasUiKey: keys.includes('zanostack-tenders-ui'),
        },
        screenshots,
        videos: [],
      }
      await writeResult('tenders-persistence-cutover-journey-5', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-persistence-cutover-j5').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  /**
   * B1 regression (Oracle blocking case): a "Closing Date" value the renderer's
   * permissive display parser accepts but the strict schema parser rejects must
   * not brick the workspace. The shredder now persists `closingDate` only when
   * the shared strict `parseClosingDate` accepts it (else `null`), and the
   * renderer pre-validates the document before `saveStoreV2`.
   *
   * "Friday, 30 November 2026 (11:00)" is accepted by the display parser but
   * rejected by the strict parser (leading weekday name + parenthesised time),
   * so it must be stored as `null` while the tender still persists and later
   * saves keep working.
   */
  test('journey 6 (B1): a schema-rejected closing date does not brick persistence', async () => {
    const userDataDir = await scratchUserData()
    const screenshots: string[] = []
    const videos: string[] = []
    const fixtureAwkward = join(userDataDir, 'closing-date-awkward.pdf')
    const fixtureValid = join(userDataDir, 'closing-date-valid.pdf')
    const AWKWARD_REF = 'E2E/B1/2026/01'
    const VALID_REF = 'E2E/B1/2026/02'
    const AWKWARD_CLOSING_DATE = 'Friday, 30 November 2026 (11:00)'
    // Strict `parseClosingDate` accepts this form (trailing "11:00" time suffix),
    // so it is the control proving the extractor really matched the date line.
    const STRICT_VALID_CLOSING_DATE = '30 November 2026 11:00'
    const CLAUSE = 'A valid SARS tax clearance certificate must accompany the proposal.'
    let run: LaunchedApp | undefined
    try {
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-persistence-cutover-j6',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)
      await createFirstCompany(tenders, COMPANY_ONE)
      await expectSaveState(tenders, 'Saved')

      await generateTextPdf(fixtureAwkward, [
        'REQUEST FOR PROPOSAL',
        `Reference Number: ${AWKWARD_REF}`,
        `Closing Date: ${AWKWARD_CLOSING_DATE}`,
        CLAUSE,
      ])

      // ── Awkward closing date: must persist with closingDate=null ────────────
      await tenders.locator('nav').getByRole('button', { name: 'Tenders' }).click()
      await expect(tenders.getByRole('heading', { name: 'Tenders', level: 1 })).toBeVisible({
        timeout: 20_000,
      })
      await tenders
        .locator('input[type="file"][accept*="pdf"]')
        .first()
        .setInputFiles(fixtureAwkward)
      await expect(tenders.getByRole('heading', { name: 'Compliance matrix' })).toBeVisible({
        timeout: 90_000,
      })
      await expect(tenders.getByText(/\d+ requirements · click to locate in PDF/)).toBeVisible()

      const committedAwkward = await pollStore(
        userDataDir,
        (s) => allTenders(s).some((t: any) => t.referenceNumber === AWKWARD_REF),
        30_000,
      )
      const awkwardTender = allTenders(committedAwkward).find(
        (t: any) => t.referenceNumber === AWKWARD_REF,
      )
      expect(awkwardTender, 'tender with the divergent closing date must persist').toBeTruthy()
      expect(
        awkwardTender.closingDate,
        'strict-invalid closing date must be stored as null',
      ).toBeNull()
      expect(awkwardTender.requirements.length).toBeGreaterThan(0)
      // Not bricked: the workspace reaches "Saved" with no field-level save error.
      await expectSaveState(tenders, 'Saved')
      await expect(tenders.getByText('Save failed', { exact: true })).toHaveCount(0)
      await expect(tenders.getByText('Conflict', { exact: true })).toHaveCount(0)
      screenshots.push(await shot(tenders, 'cutover-j6-closing-date-persisted'))

      // A later requirement-status change on the awkward tender must still save.
      const expand = tenders.locator('button[title="Show clause details"]').first()
      await expect(expand).toBeVisible()
      await expand.click()
      const statusSelect = tenders.locator('select:has(option[value="FULFILLED"])').first()
      await expect(statusSelect).toBeVisible()
      const from = await statusSelect.inputValue()
      const to = from === 'FULFILLED' ? 'ACTION_REQUIRED' : 'FULFILLED'
      await statusSelect.selectOption(to)
      await expect(statusSelect).toHaveValue(to)

      const afterEdit = await pollStore(
        userDataDir,
        (s) => Boolean(findRequirement(s, (r) => r.status === to)),
        30_000,
      )
      const changed = findRequirement(afterEdit, (r) => r.status === to)
      expect(
        changed,
        'requirement status change after the awkward closing date must still save',
      ).toBeTruthy()
      await expectSaveState(tenders, 'Saved')
      screenshots.push(await shot(tenders, 'cutover-j6-requirement-saved'))

      // ── Control: a strict-valid closing date IS retained ────────────────────
      await generateTextPdf(fixtureValid, [
        'REQUEST FOR PROPOSAL',
        `Reference Number: ${VALID_REF}`,
        `Closing Date: ${STRICT_VALID_CLOSING_DATE}`,
        CLAUSE,
      ])
      await backToTenderList(tenders)
      await tenders.locator('input[type="file"][accept*="pdf"]').first().setInputFiles(fixtureValid)
      await expect(tenders.getByRole('heading', { name: 'Compliance matrix' })).toBeVisible({
        timeout: 90_000,
      })
      const committedValid = await pollStore(
        userDataDir,
        (s) => allTenders(s).some((t: any) => t.referenceNumber === VALID_REF),
        30_000,
      )
      const validTender = allTenders(committedValid).find(
        (t: any) => t.referenceNumber === VALID_REF,
      )
      expect(
        validTender,
        'control tender with a strict-valid closing date must persist',
      ).toBeTruthy()
      expect(validTender.closingDate, 'strict-valid closing date must be retained verbatim').toBe(
        STRICT_VALID_CLOSING_DATE,
      )
      await expectSaveState(tenders, 'Saved')
      screenshots.push(await shot(tenders, 'cutover-j6-control-valid-date'))

      const result: JourneyResult = {
        journey: 'B1: schema-rejected closing date stored null without bricking persistence',
        status: 'PASS',
        detail:
          `tender ${AWKWARD_REF} persisted with closingDate=null and edited (requirement ${changed.id} ${from} -> ${to}); ` +
          `control ${VALID_REF} retained closingDate="${STRICT_VALID_CLOSING_DATE}"`,
        evidence: {
          userDataDir,
          awkwardClosingDate: AWKWARD_CLOSING_DATE,
          storedClosingDateAwkward: awkwardTender.closingDate,
          storedClosingDateValid: validTender.closingDate,
          awkwardTenderReference: awkwardTender.referenceNumber,
          validTenderReference: validTender.referenceNumber,
          requirementCount: awkwardTender.requirements.length,
          revision: committedValid.revision,
        },
        screenshots,
        videos,
      }
      await writeResult('tenders-persistence-cutover-journey-6', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-persistence-cutover-j6').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
