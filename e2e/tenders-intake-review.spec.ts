/**
 * Phase 3 / Wave 4 — built-Electron verification of the Tenders intake-review
 * (extraction review / correction) flow, plus the readiness gating it drives.
 *
 * The renderer now carries an authoritative `TenderRecord.intakeVerification`
 * slice (fields, requirements, pages). Every ticket below is exercised through
 * real UI against the built shell, and cross-checked against the on-disk
 * `tenders-data.json`:
 *
 *   1. a fresh import opens the mandatory extraction-review gate
 *   2. correcting/confirming a critical field + a requirement + a "not stated"
 *      decision lowers the gate count and completes the review
 *   3. readiness is BLOCKED while any critical field is unconfirmed, and never
 *      falsely clears
 *   4. a textless (scanned) page is classified OCR-required and blocks readiness
 *      until the page-review control marks it reviewed
 *   5. review/confirmation state is authoritative and survives a restart
 *
 * Isolation: scratch `userData` under `%LOCALAPPDATA%\Temp\opencode`; generated
 * fixtures live inside it and are removed with it. No application source changes.
 */
import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

/** `%LOCALAPPDATA%\Temp\opencode` on Windows (os.tmpdir() is %TEMP%). */
const SCRATCH_ROOT = join(tmpdir(), 'opencode')
const COMPANY_NAME = 'E2E Intake Civils (Pty) Ltd'
const COMPANY_NAME_PLACEHOLDER = 'e.g. Lephalale Civils (Pty) Ltd'

const TENDER_REF = 'E2E/IR/2026/01'
const TENDER_SUBTITLE = 'Supply of Water Metering Equipment'
const AWKWARD_CLOSING_DATE = 'Friday, 30 November 2026 (11:00)'
const CORRECTED_CLOSING_DATE = '31 October 2026 at 11:00'
const ADDED_REQUIREMENT_TITLE = 'E2E Added Requirement (Annexure Z)'

const FIELD_LABELS = [
  'Tender title',
  'Reference number',
  'Issuing body',
  'Contact email',
  'Closing date & time',
  'Submission method',
  'Submission destination',
  'Value',
] as const

// ── scratch + store helpers ───────────────────────────────────────────────────

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

function findTender(store: any, reference: string): any | undefined {
  for (const workspace of store?.workspaces ?? []) {
    for (const tender of workspace?.tenders ?? []) {
      if (tender?.referenceNumber === reference) return tender
    }
  }
  return undefined
}

// ── fixture generation (pdf-lib at runtime) ───────────────────────────────────

interface IntakeFixtureOptions {
  lines: string[]
  /** Number of trailing pages containing graphics only (no text layer). */
  scannedPages?: number
}

async function generateIntakePdf(targetPath: string, options: IntakeFixtureOptions): Promise<void> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)

  const page = doc.addPage([595, 842])
  let y = 780
  for (const line of options.lines) {
    page.drawText(line, { x: 50, y, size: 12, font })
    y -= 24
  }

  for (let index = 0; index < (options.scannedPages ?? 0); index += 1) {
    const scanned = doc.addPage([595, 842])
    scanned.drawRectangle({
      x: 60,
      y: 500,
      width: 470,
      height: 250,
      color: rgb(0.92, 0.92, 0.92),
      borderColor: rgb(0.25, 0.25, 0.25),
      borderWidth: 1,
    })
    for (let line = 0; line < 6; line += 1) {
      scanned.drawLine({
        start: { x: 90, y: 710 - line * 28 },
        end: { x: 500, y: 710 - line * 28 },
        thickness: 2,
        color: rgb(0.4, 0.4, 0.4),
      })
    }
  }

  const bytes = await doc.save()
  await writeFile(targetPath, Buffer.from(bytes))
}

function textTenderLines(): string[] {
  return [
    'E2E WATER AUTHORITY',
    'REQUEST FOR PROPOSAL',
    TENDER_SUBTITLE,
    `Reference Number: ${TENDER_REF}`,
    `Closing Date: ${AWKWARD_CLOSING_DATE}`,
    'Submit by email to bids@e2ewater.example.',
    'Contact email: clarifications@e2ewater.example',
    'A valid SARS tax clearance certificate must accompany the proposal.',
    'A valid COIDA letter of good standing must accompany the proposal.',
  ]
}

// ── shell navigation / shared UI helpers ──────────────────────────────────────

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
  const input = tenders.getByPlaceholder(COMPANY_NAME_PLACEHOLDER)
  await expect(input).toBeVisible()
  await input.fill(name)
  await tenders.getByRole('button', { name: 'Create workspace' }).click()
  await expect(tenders.getByText(name).first()).toBeVisible({ timeout: 15_000 })
  await dismissTendersOnboarding(tenders)
}

/** Import a PDF from the tender-list dropzone and wait for the workspace. */
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

/** Ensure the named tender's workspace (compliance matrix) is open. */
async function ensureTenderWorkspace(tenders: Page, reference: string): Promise<void> {
  const matrix = tenders.getByRole('heading', { name: 'Compliance matrix' })
  if (!(await matrix.isVisible().catch(() => false))) {
    await tenders.locator('nav').getByRole('button', { name: 'Tenders' }).click()
    const card = tenders.locator('main li', { hasText: reference }).first()
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.click()
  }
  await expect(matrix).toBeVisible({ timeout: 20_000 })
}

async function openReview(tenders: Page): Promise<void> {
  const panel = tenders.getByRole('region', { name: 'Extraction review' })
  if (!(await panel.isVisible().catch(() => false))) {
    await tenders
      .getByRole('button', { name: /Review extraction/ })
      .first()
      .click()
  }
  await expect(panel).toBeVisible({ timeout: 15_000 })
}

async function closeReview(tenders: Page): Promise<void> {
  const back = tenders.getByRole('button', { name: 'Back to matrix' })
  if (await back.count()) await back.click()
}

/** Pending count shown on the toolbar "Review extraction" badge (0 = complete). */
async function reviewPendingCount(tenders: Page): Promise<number> {
  const button = tenders.getByRole('button', { name: /Review extraction/ }).first()
  const text = (await button.innerText()).replace(/\s+/g, ' ').trim()
  const match = text.match(/(\d+)\s*$/)
  return match ? Number(match[1]) : 0
}

function fieldGroup(tenders: Page, label: string) {
  return tenders.getByRole('group', { name: label, exact: true })
}

async function decideField(tenders: Page, label: string, value?: string): Promise<void> {
  const group = fieldGroup(tenders, label)
  await expect(group).toBeVisible()
  if (value !== undefined) {
    const control = group.getByRole('textbox')
    await control.fill(value)
    await control.press('Enter')
  }
  const confirm = group.getByRole('button', { name: 'Confirm' })
  if (await confirm.isEnabled()) await confirm.click()
  else await group.getByRole('button', { name: 'Not stated' }).click()
}

async function decideEveryField(tenders: Page): Promise<void> {
  for (const label of FIELD_LABELS) {
    await decideField(tenders, label)
  }
}

async function verifyRemainingRequirements(tenders: Page): Promise<void> {
  const bulk = tenders.getByRole('button', { name: /Mark remaining requirements verified/ })
  if ((await bulk.count()) > 0) await bulk.click()
}

interface ReadinessState {
  ready: boolean
  buttonPresent: boolean
  buttonDisabled: boolean
  intakeBlocked: boolean
  intakeLabelPresent: boolean
  intakeDetail: string
  pageBlocked: boolean
  pageLabelPresent: boolean
  pageDetail: string
}

async function readinessState(tenders: Page): Promise<ReadinessState> {
  await tenders.getByRole('button', { name: 'Bid readiness' }).click()
  await expect(tenders.getByRole('heading', { name: 'Bid readiness' })).toBeVisible({
    timeout: 15_000,
  })
  const ready = (await tenders.getByText(/All blocking checks pass/).count()) > 0
  const button = tenders.getByRole('button', { name: 'Mark ready to submit' })
  const buttonPresent = (await button.count()) > 0
  const buttonDisabled = buttonPresent ? await button.isDisabled() : false
  const intakeFail = tenders.getByText(/readiness-critical field\(s\) are still unconfirmed/)
  const intakeBlocked = (await intakeFail.count()) > 0
  const intakeLabelPresent =
    (await tenders
      .getByText('Every readiness-critical field has been explicitly confirmed')
      .count()) > 0
  const pageFail = tenders.getByText(/are not readable without review/)
  const pageBlocked = (await pageFail.count()) > 0
  const pageLabelPresent =
    (await tenders.getByText('Every scanned page is OCR-extracted or manually reviewed').count()) >
    0
  const intakeDetail = intakeBlocked ? await intakeFail.first().innerText() : ''
  const pageDetail = pageBlocked ? await pageFail.first().innerText() : ''
  const close = tenders.getByRole('button', { name: 'Close readiness' })
  if (await close.count()) await close.click()
  return {
    ready,
    buttonPresent,
    buttonDisabled,
    intakeBlocked,
    intakeLabelPresent,
    intakeDetail,
    pageBlocked,
    pageLabelPresent,
    pageDetail,
  }
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

// ── scenarios ─────────────────────────────────────────────────────────────────

test.describe('Tenders intake review (Phase 3 / Wave 4)', () => {
  test.describe.configure({ timeout: 600_000 })

  test('1+3: fresh import opens the mandatory review gate and readiness is blocked until confirmed', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-intake-review-j1',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)
      await createCompany(tenders, COMPANY_NAME)
      const fixture = join(userDataDir, 'intake-text.pdf')
      await generateIntakePdf(fixture, { lines: textTenderLines() })
      await importTender(tenders, fixture)
      screenshots.push(await shot(tenders, 'intake-j1-gate'))

      // (1) Mandatory review gate is present right after import.
      await expect(tenders.getByText('Extraction review incomplete')).toBeVisible({
        timeout: 20_000,
      })
      const pending = await reviewPendingCount(tenders)
      expect(pending, 'fresh import must show outstanding review work').toBeGreaterThan(0)

      await openReview(tenders)
      await expect(tenders.getByText('Review incomplete', { exact: true })).toBeVisible()
      await expect(tenders.getByText('Review complete', { exact: true })).toHaveCount(0)
      // Critical fields start unconfirmed (the closing date is strict-invalid).
      await expect(fieldGroup(tenders, 'Closing date & time')).toBeVisible()
      await expect(fieldGroup(tenders, 'Closing date & time').getByText('Corrected')).toHaveCount(0)
      screenshots.push(await shot(tenders, 'intake-j1-review-open'))

      // On disk the review is authoritative and unconfirmed.
      const store = await pollStore(userDataDir, (s) => Boolean(findTender(s, TENDER_REF)))
      const tender = findTender(store, TENDER_REF)
      expect(tender?.intakeVerification, 'intakeVerification persisted on the tender').toBeTruthy()
      expect(tender.closingDate).toBeNull()
      const fieldStates = Object.fromEntries(
        Object.entries(tender.intakeVerification.fields ?? {}).map(([k, v]: any) => [k, v.state]),
      )
      expect(fieldStates.closingDate).toBe('unconfirmed')
      expect(fieldStates.title).toBe('unconfirmed')

      // (3) Readiness is blocked and must NOT falsely clear while unconfirmed.
      const before = await readinessState(tenders)
      expect(before.ready, 'readiness must not be ready while a field is unconfirmed').toBe(false)
      expect(before.buttonDisabled, 'ready action must be disabled').toBe(true)
      expect(before.intakeBlocked, 'intake-review block must be the failing gate').toBe(true)
      expect(before.intakeLabelPresent, 'the intake-review check is rendered').toBe(true)
      screenshots.push(await shot(tenders, 'intake-j1+3-readiness-blocked'))

      const result: JourneyResult = {
        journey: '1+3: mandatory review gate + readiness blocked (no false clear)',
        status: 'PASS',
        detail: `fresh import: ${pending} pending review items; readiness blocked with intake gate failing`,
        evidence: { userDataDir, pending, before, closingDate: tender.closingDate },
        screenshots,
      }
      await writeResult('tenders-intake-review-journey-1-3', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-intake-review-j1').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('2: correcting a critical field, reclassifying/adding a requirement and marking not stated completes the review', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-intake-review-j2',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)
      await createCompany(tenders, COMPANY_NAME)
      const fixture = join(userDataDir, 'intake-text.pdf')
      await generateIntakePdf(fixture, { lines: textTenderLines() })
      await importTender(tenders, fixture)

      const pendingBefore = await reviewPendingCount(tenders)
      expect(pendingBefore).toBeGreaterThan(0)

      // Correct the readiness-critical closing date (strict-invalid on import).
      await openReview(tenders)
      await decideField(tenders, 'Closing date & time', CORRECTED_CLOSING_DATE)
      const closingGroup = fieldGroup(tenders, 'Closing date & time')
      await expect(closingGroup.getByText('Corrected')).toBeVisible()
      const pendingAfterCorrection = await reviewPendingCount(tenders)
      expect(
        pendingAfterCorrection,
        'the review gate count must drop after a decision',
      ).toBeLessThan(pendingBefore)
      screenshots.push(await shot(tenders, 'intake-j2-closing-corrected'))

      // Reclassify a requirement in the matrix.
      await closeReview(tenders)
      await ensureTenderWorkspace(tenders, TENDER_REF)
      const firstRow = tenders.locator('main ul li').first()
      await firstRow.locator('button[title="Show clause details"]').first().click()
      const stage = firstRow.locator('select[title="Reclassify this requirement"]')
      await expect(stage).toBeVisible()
      const originalCategory = await stage.inputValue()
      const targetCategory =
        originalCategory === 'FUNCTIONALITY_STAGE_2' ? 'MANDATORY_STAGE_1' : 'FUNCTIONALITY_STAGE_2'
      await stage.selectOption(targetCategory)
      const reclassStore = await pollStore(
        userDataDir,
        (s) => {
          const t = findTender(s, TENDER_REF)
          return (t?.requirements ?? []).some(
            (r: any) =>
              r.category === targetCategory &&
              t.intakeVerification?.requirements?.[r.id]?.originalCategory === originalCategory,
          )
        },
        30_000,
      )
      const reclassified = (findTender(reclassStore, TENDER_REF)?.requirements ?? []).find(
        (r: any) => r.category === targetCategory,
      )
      expect(reclassified, 'reclassified requirement persisted with provenance').toBeTruthy()

      // Add a requirement the parser missed.
      await tenders.getByRole('button', { name: 'Add requirement' }).click()
      const form = tenders
        .locator('form')
        .filter({ hasText: 'Add a requirement the parser missed' })
      await expect(form).toBeVisible()
      await form
        .getByPlaceholder('e.g. Signed pricing schedule (Annexure B)')
        .fill(ADDED_REQUIREMENT_TITLE)
      await form.getByRole('button', { name: 'Add requirement' }).click()
      const addedStore = await pollStore(
        userDataDir,
        (s) => {
          const t = findTender(s, TENDER_REF)
          const added = (t?.requirements ?? []).find(
            (r: any) => r.title === ADDED_REQUIREMENT_TITLE,
          )
          return Boolean(
            added && t.intakeVerification?.requirements?.[added.id]?.state === 'verified',
          )
        },
        30_000,
      )
      expect(
        (findTender(addedStore, TENDER_REF)?.requirements ?? []).some(
          (r: any) => r.title === ADDED_REQUIREMENT_TITLE,
        ),
        'manually added requirement persisted and pre-verified',
      ).toBe(true)

      // Decide the remaining fields (well-sourced confirmed, empty -> not stated)
      // and verify any weak requirements, then the review completes.
      await openReview(tenders)
      await decideEveryField(tenders)
      await verifyRemainingRequirements(tenders)
      await expect(tenders.getByText('Review complete')).toBeVisible({ timeout: 20_000 })
      await expect(tenders.getByText('Extraction reviewed')).toBeVisible()
      expect(await reviewPendingCount(tenders)).toBe(0)
      screenshots.push(await shot(tenders, 'intake-j2-review-complete'))

      const finalStore = await pollStore(userDataDir, (s) => {
        const tender = findTender(s, TENDER_REF)
        const fields = tender?.intakeVerification?.fields ?? {}
        return (
          tender?.closingDate === CORRECTED_CLOSING_DATE &&
          fields.closingDate?.state === 'corrected' &&
          fields.estimatedValue?.state === 'not_stated'
        )
      })
      const finalTender = findTender(finalStore, TENDER_REF)
      expect(finalTender.closingDate).toBe(CORRECTED_CLOSING_DATE)
      const states = Object.fromEntries(
        Object.entries(finalTender.intakeVerification.fields ?? {}).map(([k, v]: any) => [
          k,
          v.state,
        ]),
      )
      expect(states.closingDate).toBe('corrected')
      expect(states.estimatedValue, 'an unresolved field was marked not stated').toBe('not_stated')

      const result: JourneyResult = {
        journey: '2: correct field + reclassify/add requirement + not stated completes review',
        status: 'PASS',
        detail: `pending ${pendingBefore} -> ${pendingAfterCorrection} -> 0; closing date corrected; requirement reclassified ${originalCategory} -> ${targetCategory}; added ${ADDED_REQUIREMENT_TITLE}`,
        evidence: {
          userDataDir,
          pendingBefore,
          pendingAfterCorrection,
          originalCategory,
          targetCategory,
          fieldStates: states,
        },
        screenshots,
      }
      await writeResult('tenders-intake-review-journey-2', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-intake-review-j2').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('3: confirming the critical fields clears the intake block without a false clear', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-intake-review-j3',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)
      await createCompany(tenders, COMPANY_NAME)
      const fixture = join(userDataDir, 'intake-text.pdf')
      await generateIntakePdf(fixture, { lines: textTenderLines() })
      await importTender(tenders, fixture)

      const before = await readinessState(tenders)
      expect(before.ready).toBe(false)
      expect(before.intakeBlocked).toBe(true)
      expect(before.buttonDisabled).toBe(true)

      await openReview(tenders)
      await decideField(tenders, 'Closing date & time', CORRECTED_CLOSING_DATE)
      await decideEveryField(tenders)
      await verifyRemainingRequirements(tenders)
      await expect(tenders.getByText('Review complete')).toBeVisible({ timeout: 20_000 })

      const after = await readinessState(tenders)
      expect(after.intakeBlocked, 'intake-review block must clear once fields are confirmed').toBe(
        false,
      )
      // No false clear: ready iff every blocking check passed (the ready action
      // is enabled exactly when readiness reports ready).
      expect(after.buttonDisabled).toBe(!after.ready)
      screenshots.push(await shot(tenders, 'intake-j3-readiness-after'))

      const result: JourneyResult = {
        journey: '3: confirming critical fields clears the intake block (no false clear)',
        status: 'PASS',
        detail: `intake block before=${before.intakeBlocked} after=${after.intakeBlocked}; ready=${after.ready}`,
        evidence: { userDataDir, before, after },
        screenshots,
      }
      await writeResult('tenders-intake-review-journey-3', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-intake-review-j3').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('4: a textless scanned page is OCR-required, blocks readiness, and clears when reviewed', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-intake-review-j4',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)
      await createCompany(tenders, COMPANY_NAME)
      const fixture = join(userDataDir, 'intake-scanned.pdf')
      await generateIntakePdf(fixture, { lines: textTenderLines(), scannedPages: 1 })
      await importTender(tenders, fixture)

      await openReview(tenders)
      const pageReview = tenders.getByRole('region', { name: 'Page review' })
      await expect(pageReview).toBeVisible({ timeout: 20_000 })
      // The app must never imply the scanned page was read.
      await expect(pageReview.getByText('No text layer', { exact: true }).first()).toBeVisible()
      await expect(
        pageReview.getByText(/Zanostack does not read scanned pages/).first(),
      ).toBeVisible()
      await expect(pageReview.getByText('Text layer', { exact: true })).toHaveCount(0)
      await expect(tenders.getByText(/1 page to review/).first()).toBeVisible()
      screenshots.push(await shot(tenders, 'intake-j4-scanned-page-blocked'))

      // It must block readiness with the page-extraction gate.
      const blocked = await readinessState(tenders)
      expect(blocked.ready).toBe(false)
      expect(blocked.pageLabelPresent, 'page-extraction check is rendered').toBe(true)
      expect(blocked.pageBlocked, 'page-extraction check is failing').toBe(true)
      expect(blocked.pageDetail, 'the scanned page is named in the block').toContain(
        'p.2 (ocr-required)',
      )

      // Mark the page reviewed -> it no longer blocks.
      await openReview(tenders)
      await pageReview.getByRole('button', { name: 'Mark reviewed' }).first().click()
      await expect(pageReview.getByText('All pages readable')).toBeVisible({ timeout: 15_000 })
      const showResolved = pageReview.getByRole('button', { name: /readable page/ })
      if (await showResolved.count()) await showResolved.click()
      await expect(pageReview.getByText('Reviewed', { exact: true }).first()).toBeVisible()
      await expect(pageReview.getByText(/Zanostack does not read scanned pages/)).toHaveCount(0)

      const store = await pollStore(
        userDataDir,
        (s) => {
          const pages = findTender(s, TENDER_REF)?.intakeVerification?.pages ?? []
          return pages.some((p: any) => p.pageNumber === 2 && p.state === 'manually-reviewed')
        },
        30_000,
      )
      const tender = findTender(store, TENDER_REF)
      const page2 = (tender?.intakeVerification?.pages ?? []).find((p: any) => p.pageNumber === 2)
      expect(page2?.state).toBe('manually-reviewed')
      expect(page2?.method).toBeNull()
      expect(tender.ocrPages).toBe(1)

      const after = await readinessState(tenders)
      expect(after.pageBlocked, 'the page-extraction block must clear once reviewed').toBe(false)
      expect(
        after.intakeBlocked,
        'field review is still outstanding, so the intake block remains',
      ).toBe(true)
      screenshots.push(await shot(tenders, 'intake-j4-page-reviewed'))

      const result: JourneyResult = {
        journey: '4: scanned page classified OCR-required, blocks, clears when reviewed',
        status: 'PASS',
        detail: `page 2 state=manually-reviewed method=null; ocrPages=${tender.ocrPages}; page block ${blocked.pageBlocked} -> ${after.pageBlocked}`,
        evidence: { userDataDir, page2, ocrPages: tender.ocrPages, blocked, after },
        screenshots,
      }
      await writeResult('tenders-intake-review-journey-4', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-intake-review-j4').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('5: review/confirmation state is authoritative and survives a restart', async () => {
    const screenshots: string[] = []
    let run1: LaunchedApp | undefined
    let run2: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-intake-review-j5-run1',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)
      await dismissTendersOnboarding(tenders)
      await createCompany(tenders, COMPANY_NAME)
      const fixture = join(userDataDir, 'intake-text.pdf')
      await generateIntakePdf(fixture, { lines: textTenderLines() })
      await importTender(tenders, fixture)

      await openReview(tenders)
      await decideField(tenders, 'Closing date & time', CORRECTED_CLOSING_DATE)
      await decideEveryField(tenders)
      await verifyRemainingRequirements(tenders)
      await expect(tenders.getByText('Review complete')).toBeVisible({ timeout: 20_000 })

      const committed = await pollStore(userDataDir, (s) => {
        const fields = findTender(s, TENDER_REF)?.intakeVerification?.fields ?? {}
        return (
          fields.closingDate?.state === 'corrected' && fields.estimatedValue?.state === 'not_stated'
        )
      })
      const committedTender = findTender(committed, TENDER_REF)
      expect(committedTender.closingDate).toBe(CORRECTED_CLOSING_DATE)
      const revisionBefore = committed.revision

      // Not in localStorage: the review is authoritative on disk.
      const lsKeys = await tenders.evaluate(() => Object.keys(window.localStorage))
      expect(lsKeys.some((k) => k.includes('intake') || k.includes('review'))).toBe(false)
      expect(lsKeys).toContain('zanostack-tenders-ui')

      await closeAndSaveVideo(run1, 'tenders-intake-review-j5-run1')
      run1 = undefined

      run2 = await launchShell({
        userDataDir,
        videoDir: 'tenders-intake-review-j5-run2',
      })
      const tenders2 = await openTendersFromNav(run2.app, run2.page)
      await dismissTendersOnboarding(tenders2)
      await ensureTenderWorkspace(tenders2, TENDER_REF)
      await expect(tenders2.getByText('Extraction reviewed')).toBeVisible({ timeout: 20_000 })

      await openReview(tenders2)
      await expect(fieldGroup(tenders2, 'Closing date & time').getByText('Corrected')).toBeVisible()
      await expect(fieldGroup(tenders2, 'Value').getByText('Not stated').first()).toBeVisible()
      const closingInput = fieldGroup(tenders2, 'Closing date & time').getByRole('textbox')
      await expect(closingInput).toHaveValue(CORRECTED_CLOSING_DATE)
      screenshots.push(await shot(tenders2, 'intake-j5-restart-persisted'))

      const afterRestart = await readStore(userDataDir)
      const restored = findTender(afterRestart, TENDER_REF)
      expect(restored.intakeVerification.fields.closingDate.state).toBe('corrected')
      expect(restored.intakeVerification.fields.estimatedValue.state).toBe('not_stated')
      expect(afterRestart.revision).toBe(revisionBefore)

      const readiness = await readinessState(tenders2)
      expect(readiness.intakeBlocked).toBe(false)

      const result: JourneyResult = {
        journey: '5: review state authoritative and survives restart',
        status: 'PASS',
        detail: `closingDate=corrected, value=not_stated persisted across restart at revision ${revisionBefore}; intake block cleared`,
        evidence: {
          userDataDir,
          revisionBefore,
          closingDate: restored.closingDate,
          fieldStates: Object.fromEntries(
            Object.entries(restored.intakeVerification.fields ?? {}).map(([k, v]: any) => [
              k,
              v.state,
            ]),
          ),
        },
        screenshots,
      }
      await writeResult('tenders-intake-review-journey-5', result)
    } finally {
      if (run1)
        await closeAndSaveVideo(run1, 'tenders-intake-review-j5-run1').catch(() => undefined)
      if (run2)
        await closeAndSaveVideo(run2, 'tenders-intake-review-j5-run2').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
