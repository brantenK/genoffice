/**
 * Phase 4 / Wave 2 lane C — built-Electron journey for WP-8 demo isolation.
 *
 * Covers, against the built shell:
 *   1. "Explore sample workspace" creates a clearly labelled sample workspace
 *      (SAMPLE markers + banner) and persists `dataOrigin: 'demo'` on disk;
 *   2. a corrupt store errors — the sample workspace is NEVER a recovery
 *      fallback;
 *   3. cross-app writes are gated from a sample workspace (CRM button disabled
 *      with the shared guard reason; Milestones/Books not exposed; no
 *      `crm/deals.json` or `books/books-data.json` write) and the
 *      copy-to-real-workspace affordance moves a tender into a user workspace
 *      with its sample submission/outcome left behind.
 *
 * Guard affordances asserted here (landed UI):
 *   • `Workspace.tsx` CRM button: `disabled` + title
 *     `SAMPLE_WRITE_BLOCKED_REASON` ("Sample workspace — CRM sync and Books
 *     billing are off…") while the active workspace is `dataOrigin: 'demo'`.
 *   • Milestones toolbar button is only rendered when `milestonesAllowed(status)`.
 *   • `TenderLifecyclePanel` sample section: badge title
 *     "Demonstration data — CRM and Books writes are off" and the
 *     "Copy into my workspace" button (disabled until an own workspace exists).
 *
 * Scratch `userData` under `%LOCALAPPDATA%\Temp\opencode`; no app-source edits.
 */
import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
import { readStore, pollStore, STORE_IMPORT_POLL_MS } from './tenders-timing'

/** `%LOCALAPPDATA%\Temp\opencode` on Windows (os.tmpdir() is %TEMP%). */
const SCRATCH_ROOT = join(tmpdir(), 'opencode')

const TENDER_REF = 'E2E/DEMO/2026/01'
const OWN_COMPANY = 'E2E Demo Owner Civils (Pty) Ltd'
const SAMPLE_WRITE_BLOCKED_REASON =
  'Sample workspace — CRM sync and Books billing are off for demonstration data. Copy the tender into your own workspace first.'
const COPY_LIFECYCLE_REASON = 'Copied from the sample workspace'

// ── scratch + store helpers ───────────────────────────────────────────────────

async function scratchUserData(): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  return mkdtemp(join(SCRATCH_ROOT, 'genoffice-e2e-'))
}

function storeFile(userDataDir: string): string {
  return join(userDataDir, 'tenders', 'tenders-data.json')
}

async function fileSignature(path: string): Promise<string> {
  try {
    const s = await stat(path)
    return `${s.size}:${Math.round(s.mtimeMs)}`
  } catch {
    return 'missing'
  }
}

/** Observable stability window (no raw sleep) before asserting "no write". */
async function expectFileStable(path: string, samples = 4, intervalMs = 250): Promise<void> {
  const expected = await fileSignature(path)
  let stable = 0
  await expect
    .poll(
      async () => {
        stable = (await fileSignature(path)) === expected ? stable + 1 : 0
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

function findTender(store: any, reference: string): any | undefined {
  return allTenders(store).find((tender) => tender?.referenceNumber === reference)
}

function workspacesWithTender(store: any, reference: string): any[] {
  return (store?.workspaces ?? []).filter((workspace: any) =>
    (workspace?.tenders ?? []).some((tender: any) => tender?.referenceNumber === reference),
  )
}

async function readDeals(userDataDir: string): Promise<any[]> {
  try {
    const raw = JSON.parse(await readFile(join(userDataDir, 'crm', 'deals.json'), 'utf8'))
    return Array.isArray(raw) ? raw : Array.isArray(raw?.deals) ? raw.deals : []
  } catch {
    return []
  }
}

// ── fixture generation (pdf-lib at runtime) ───────────────────────────────────

async function generateTenderPdf(targetPath: string, reference: string): Promise<void> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([595, 842])
  const lines = [
    'E2E WATER AUTHORITY',
    'REQUEST FOR PROPOSAL',
    'Supply of Water Metering Equipment',
    `Reference Number: ${reference}`,
    'Submit by email to bids@e2ewater.example.',
    'A valid SARS tax clearance certificate must accompany the proposal.',
    'A valid COIDA letter of good standing must accompany the proposal.',
  ]
  let y = 780
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 12, font })
    y -= 24
  }
  const bytes = await doc.save()
  await writeFile(targetPath, Buffer.from(bytes))
}

// ── shell + UI helpers ────────────────────────────────────────────────────────

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

async function exploreSampleWorkspace(tenders: Page): Promise<void> {
  await expect(tenders.getByRole('heading', { name: 'Explore sample workspace' })).toBeVisible({
    timeout: 20_000,
  })
  await tenders.getByRole('button', { name: 'Open sample workspace' }).click()
  await expect(tenders.getByText('SAMPLE', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  })
  await dismissTendersOnboarding(tenders)
}

async function importTender(tenders: Page, fixturePath: string): Promise<void> {
  await tenders.locator('nav').getByRole('button', { name: 'Tenders' }).click()
  await expect(tenders.getByRole('heading', { name: 'Tenders', level: 1 })).toBeVisible({
    timeout: 20_000,
  })
  await tenders.locator('input[type="file"][accept*="pdf"]').first().setInputFiles(fixturePath)
  await expect(tenders.getByRole('heading', { name: 'Compliance matrix' })).toBeVisible({
    timeout: 90_000,
  })
}

function lifecyclePanel(tenders: Page) {
  return tenders.getByRole('region', { name: 'Tender lifecycle' })
}

async function expandLifecycleDetails(tenders: Page): Promise<void> {
  const panel = lifecyclePanel(tenders)
  if ((await panel.getByText('Lifecycle history').count()) === 0) {
    await panel
      .getByRole('button', { name: /Details & history|Hide details/ })
      .first()
      .click()
  }
  await expect(panel.getByText('Lifecycle history')).toBeVisible({ timeout: 15_000 })
}

/** Ensure the workspace for `reference` is the active one. */
async function openTenderWorkspace(tenders: Page, reference: string): Promise<void> {
  const matrix = tenders.getByRole('heading', { name: 'Compliance matrix' })
  const headerHasReference = async (): Promise<boolean> => {
    if (!(await matrix.isVisible().catch(() => false))) return false
    return (await tenders.locator('main').getByText(reference, { exact: false }).count()) > 0
  }
  if (!(await headerHasReference())) {
    const back = tenders.locator('main').getByRole('button', { name: 'Tenders' }).first()
    if (await back.isVisible().catch(() => false)) await back.click()
    await expect(tenders.getByRole('heading', { name: 'Tenders', level: 1 })).toBeVisible({
      timeout: 20_000,
    })
    const card = tenders.locator('main li', { hasText: reference }).first()
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.click()
  }
  await expect(matrix).toBeVisible({ timeout: 20_000 })
}

/** Create an own (user) workspace from the sidebar switcher. */
async function addOwnWorkspaceViaSwitcher(tenders: Page, name: string): Promise<void> {
  await tenders.locator('[data-tour="tour-company-switcher"] button').first().click()
  await tenders.getByRole('button', { name: 'Add company' }).click()
  const dialog = tenders.getByRole('dialog', { name: 'Set up your company' })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await dialog.getByLabel('Trading name').fill(name)
  await dialog.getByRole('button', { name: 'Create workspace' }).click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
  await expect(tenders.getByText(name).first()).toBeVisible({ timeout: 15_000 })
}

/** Switch to the sample workspace from the switcher (the row carrying SAMPLE). */
async function switchToSampleWorkspace(tenders: Page): Promise<void> {
  await tenders.locator('[data-tour="tour-company-switcher"] button').first().click()
  const row = tenders
    .locator('[data-tour="tour-company-switcher"] li')
    .filter({ hasText: 'SAMPLE' })
    .first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.getByRole('button').first().click()
  await expect(lifecyclePanel(tenders).getByText('Sample workspace', { exact: true }).first())
    .toBeVisible({ timeout: 20_000 })
    .catch(() => {})
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
}

async function writeResult(name: string, result: JourneyResult): Promise<string> {
  await mkdir(ARTIFACTS_DIR, { recursive: true })
  const path = join(ARTIFACTS_DIR, `${name}.json`)
  await writeFile(path, JSON.stringify(result, null, 2), 'utf8')
  return path
}

// ── journeys ──────────────────────────────────────────────────────────────────

test.describe('Tenders demo isolation (WP-8)', () => {
  test.describe.configure({ timeout: 600_000 })

  test('1: sample workspace is labelled and carries dataOrigin demo on disk', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-demo-isolation-j1',
      })
      const tenders = await openTendersFromNav(run.app, run.page)

      await expect(tenders.getByRole('heading', { name: 'Set up company' })).toBeVisible({
        timeout: 20_000,
      })
      await exploreSampleWorkspace(tenders)

      // Clear labelling in the chrome.
      const banner = tenders.locator('[aria-label="Sample workspace"]')
      await expect(banner).toBeVisible({ timeout: 15_000 })
      await expect(banner.getByText('Sample workspace')).toBeVisible()
      await expect(banner.getByText(/demonstration data/)).toBeVisible()
      await expect(banner.getByRole('button', { name: 'Create your workspace' })).toBeVisible()
      expect(await tenders.getByText('SAMPLE', { exact: true }).count()).toBeGreaterThan(0)

      // Overview figures are labelled as demonstration data.
      await expect(tenders.getByText(/demonstration records, not your own data/)).toBeVisible({
        timeout: 15_000,
      })

      // The switcher lists the sample workspace with its SAMPLE marker.
      const switcher = tenders.locator('[data-tour="tour-company-switcher"]')
      await switcher.locator('button').first().click()
      await expect(switcher.getByText('SAMPLE', { exact: true }).first()).toBeVisible()
      screenshots.push(await shot(tenders, 'demo-j1-sample-workspace'))

      // On disk: exactly one workspace, demo origin, sample content, no tenders.
      const store = await pollStore(userDataDir, (s) =>
        (s.workspaces ?? []).some((ws: any) => ws.dataOrigin === 'demo'),
      )
      expect(store).toBeTruthy()
      expect(store.workspaces).toHaveLength(1)
      const demo = store.workspaces[0]
      expect(demo.dataOrigin).toBe('demo')
      expect(demo.name).toBe('Sample workspace')
      expect(demo.company.tradingName).toBeTruthy()
      expect(demo.customers.length).toBeGreaterThan(0)
      expect(demo.vault.length).toBeGreaterThan(0)
      expect(demo.tenders).toHaveLength(0)
      expect(store.schemaVersion).toBe(2)

      const result: JourneyResult = {
        journey: '1: sample workspace labelling + dataOrigin demo',
        status: 'PASS',
        detail: `one demo workspace "${demo.name}" persisted at revision ${store.revision}; SAMPLE markers + banner visible`,
        evidence: {
          userDataDir,
          dataOrigin: demo.dataOrigin,
          customers: demo.customers.length,
          vault: demo.vault.length,
          tenders: demo.tenders.length,
        },
        screenshots,
      }
      await writeResult('tenders-demo-isolation-journey-1', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-demo-isolation-j1').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('2: a corrupt store errors and never falls back to the sample workspace', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      const corrupt = '{ this is not valid tenders json'
      await mkdir(join(userDataDir, 'tenders'), { recursive: true })
      await writeFile(storeFile(userDataDir), corrupt, 'utf8')
      const signatureBefore = await fileSignature(storeFile(userDataDir))

      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-demo-isolation-j2',
      })
      const tenders = await openTendersFromNav(run.app, run.page)

      // Explicit error state, not demo data and not the first-use sample door.
      await expect(
        tenders.getByRole('heading', { name: 'Unable to load Tenders data' }),
      ).toBeVisible({ timeout: 20_000 })
      await expect(tenders.getByText('Data has not been modified or overwritten.')).toBeVisible()
      await expect(tenders.getByRole('button', { name: 'Retry loading' })).toBeVisible()
      await expect(tenders.getByText('Sample workspace')).toHaveCount(0)
      await expect(tenders.getByRole('button', { name: 'Open sample workspace' })).toHaveCount(0)
      await expect(tenders.getByRole('heading', { name: 'Set up company' })).toHaveCount(0)
      screenshots.push(await shot(tenders, 'demo-j2-corrupt-store-error'))

      // The corrupt file is untouched and no demo workspace was synthesised.
      expect(await fileSignature(storeFile(userDataDir))).toBe(signatureBefore)
      expect(await readFile(storeFile(userDataDir), 'utf8')).toBe(corrupt)
      expect(corrupt).not.toContain('demo')

      const result: JourneyResult = {
        journey: '2: corrupt store errors instead of loading the sample workspace',
        status: 'PASS',
        detail: 'explicit error screen with retry; corrupt file byte-identical; no demo fallback',
        evidence: { userDataDir, signatureBefore },
        screenshots,
      }
      await writeResult('tenders-demo-isolation-journey-2', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-demo-isolation-j2').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('3: cross-app writes are gated from the sample workspace and the copy path works', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-demo-isolation-j3',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await exploreSampleWorkspace(tenders)

      const fixture = join(userDataDir, 'demo-tender.pdf')
      await generateTenderPdf(fixture, TENDER_REF)
      await importTender(tenders, fixture)

      const store = await pollStore(userDataDir, (s) => Boolean(findTender(s, TENDER_REF)))
      const tender = findTender(store, TENDER_REF)
      expect(tender, 'tender imported into the sample workspace').toBeTruthy()
      expect(
        store.workspaces.every((ws: any) => ws.dataOrigin === 'demo'),
        'still inside the sample workspace',
      ).toBe(true)

      // CRM: disabled with the shared guard reason.
      const crm = tenders.getByRole('button', { name: 'CRM', exact: true })
      await expect(crm).toBeVisible({ timeout: 15_000 })
      await expect(crm).toBeDisabled()
      expect(await crm.getAttribute('title')).toContain(SAMPLE_WRITE_BLOCKED_REASON)

      // Milestones/Books: not exposed at all while writes are blocked.
      expect(
        await tenders.getByRole('button', { name: /^Milestones/ }).count(),
        'Books billing must not be exposed from a sample workspace',
      ).toBe(0)

      // The lifecycle panel carries the demonstration notice + copy affordance.
      await expandLifecycleDetails(tenders)
      const panel = lifecyclePanel(tenders)
      await expect(panel.getByText(/CRM sync and Books billing are switched off/)).toBeVisible()
      const copyButton = panel.getByRole('button', { name: 'Copy into my workspace' })
      await expect(copyButton).toBeVisible()
      await expect(copyButton).toBeDisabled()
      expect(await copyButton.getAttribute('title')).toContain(
        'Create your own company workspace first',
      )
      await expect(
        panel.getByText(/No own workspace yet — add one from the company switcher/),
      ).toBeVisible()
      screenshots.push(await shot(tenders, 'demo-j3-cross-app-guard'))

      // No cross-app writes at all from the sample workspace.
      const deals = await readDeals(userDataDir)
      expect(
        deals.some((deal) => deal?.tenderId === tender.id),
        'no CRM deal may be written for a demo-workspace tender',
      ).toBe(false)
      await expectFileStable(join(userDataDir, 'crm', 'deals.json'))
      expect(
        await fileSignature(join(userDataDir, 'books', 'books-data.json')),
        'no Books data may be written from demo',
      ).toBe('missing')

      // Create an own workspace, come back to the sample, then copy the tender.
      await addOwnWorkspaceViaSwitcher(tenders, OWN_COMPANY)
      await switchToSampleWorkspace(tenders)
      await openTenderWorkspace(tenders, TENDER_REF)
      await expandLifecycleDetails(tenders)
      await lifecyclePanel(tenders).getByRole('button', { name: 'Copy into my workspace' }).click()
      // The notice is rendered twice: sr-only live region + the visible paragraph.
      await expect(
        lifecyclePanel(tenders)
          .getByText(/Copied into/)
          .last(),
      ).toBeVisible({
        timeout: 15_000,
      })

      // The copy must be DURABLE: the panel shows a success notice either way,
      // so the authoritative store must accept the copied document and the save
      // indicator must never report a failure. If it does, the copy silently
      // disappears and the demo-isolation promise ("copy it into your own
      // workspace to work on it for real") is broken.
      let copy: any
      try {
        const copied = await pollStore(userDataDir, (s) =>
          workspacesWithTender(s, TENDER_REF).some(
            (workspace: any) =>
              workspace.dataOrigin === 'user' &&
              (workspace.tenders ?? []).some(
                (candidate: any) =>
                  candidate.referenceNumber === TENDER_REF &&
                  candidate.status === 'IN_PROGRESS' &&
                  candidate.lifecycle?.[0]?.reason === COPY_LIFECYCLE_REASON,
              ),
          ),
        )
        const owner = workspacesWithTender(copied, TENDER_REF).find(
          (workspace: any) => workspace.dataOrigin === 'user',
        )
        copy = owner?.tenders?.find((candidate: any) => candidate.referenceNumber === TENDER_REF)
        expect(copy, 'copied tender persisted in the user workspace').toBeTruthy()
        expect(copy.status).toBe('IN_PROGRESS')
        expect(copy.submission).toBeNull()
        expect(copy.outcome).toBeNull()
        expect(copy.linkedCrmDealId ?? null).toBeNull()
        expect(copy.lifecycle[0].reason).toBe(COPY_LIFECYCLE_REASON)
        // D1 regression guard: the copied tender must not carry vault references
        // the target workspace cannot satisfy (the schema rejects those).
        const targetVaultIds = new Set((owner?.vault ?? []).map((document: any) => document.id))
        for (const requirement of copy.requirements ?? []) {
          if (requirement.linkedVaultDocId !== null) {
            expect(
              targetVaultIds.has(requirement.linkedVaultDocId),
              `copied linkedVaultDocId ${requirement.linkedVaultDocId} must exist in the target workspace vault`,
            ).toBe(true)
          }
          for (const suggested of requirement.suggestedVaultDocIds ?? []) {
            expect(
              targetVaultIds.has(suggested),
              `copied suggestedVaultDocId ${suggested} must exist in the target workspace vault`,
            ).toBe(true)
          }
        }
        // A durable copy leaves no failure indicator behind.
        await expect(
          tenders.getByRole('alert').filter({ hasText: /Save failed/ }),
          'the copied tender must be accepted by the authoritative v2 store',
        ).toHaveCount(0)
        // The sample workspace keeps its own original record.
        expect(
          workspacesWithTender(copied, TENDER_REF).some(
            (workspace: any) => workspace.dataOrigin === 'demo',
          ),
          'the sample workspace keeps its demonstration tender',
        ).toBe(true)
      } catch (error) {
        const alerts = await tenders
          .getByRole('alert')
          .allInnerTexts()
          .catch(() => [] as string[])
        const disk = await readStore(userDataDir)
        await writeResult('tenders-demo-isolation-journey-3', {
          journey: '3: demo cross-app guard + copy-to-own-workspace',
          status: 'FAIL',
          detail: `the copied tender was not accepted by the authoritative store; UI alert = ${JSON.stringify(alerts)}`,
          evidence: {
            userDataDir,
            alerts,
            workspaces: (disk?.workspaces ?? []).map((workspace: any) => ({
              name: workspace.name,
              dataOrigin: workspace.dataOrigin,
              tenders: (workspace.tenders ?? []).map((candidate: any) => candidate.referenceNumber),
              vaultIds: (workspace.vault ?? []).map((doc: any) => doc.id),
            })),
          },
          screenshots,
        })
        throw error
      }

      // In the user workspace the CRM affordance is live again.
      await expect(
        tenders.getByRole('button', { name: 'CRM', exact: true }),
        'CRM is enabled once the same tender lives in an own workspace',
      ).toBeEnabled({ timeout: 15_000 })
      screenshots.push(await shot(tenders, 'demo-j3-copied-into-own-workspace'))

      const result: JourneyResult = {
        journey: '3: demo cross-app guard + copy-to-own-workspace',
        status: 'PASS',
        detail: `CRM disabled with the guard reason; no Milestones/Books exposure; no CRM/Books writes; copied ${TENDER_REF} into "${OWN_COMPANY}" with sample submission/outcome stripped`,
        evidence: {
          userDataDir,
          guardReason: SAMPLE_WRITE_BLOCKED_REASON,
          copyId: copy.id,
          copyLifecycle: copy.lifecycle,
        },
        screenshots,
      }
      await writeResult('tenders-demo-isolation-journey-3', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-demo-isolation-j3').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
