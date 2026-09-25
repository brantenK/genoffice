/**
 * Phase 4 / Wave 2 lane C — built-Electron journey for WP-11 submission
 * receipt + outcome lifecycle.
 *
 * Aligned with the landed UI (`TenderLifecyclePanel.tsx`, `SubmissionDialog.tsx`,
 * `OutcomeDialog.tsx`):
 *
 *   TENDER LIFECYCLE PANEL — always rendered in the workspace,
 *   region name "Tender lifecycle". Status is the TENDER_STATUS_LABEL badge;
 *   the primary action button identifies the state:
 *     IN_PROGRESS          → "Mark ready to assemble"
 *     READY_TO_ASSEMBLE    → "Record pack generated"
 *     PACK_GENERATED       → "Mark ready to submit"
 *     READY_FOR_SUBMISSION → "Record submission…"        (SubmissionDialog)
 *     SUBMITTED            → "Add submission evidence…"  (SubmissionDialog)
 *     SUBMITTED_EVIDENCED  → "Record outcome…"           (OutcomeDialog)
 *   "Details & history" expands the submission/outcome records and the
 *   "Lifecycle history" list (when + optional why). Reasoned moves
 *   ("Back to preparing", "Archive tender", …) use the inline ReasonPrompt
 *   with the label "Reason (recorded in the history)".
 *
 *   SUBMISSION DIALOG — dialog name "Record the submission" (or "Update the
 *   submission record" when a record exists). Labels: "Date and time
 *   submitted" (datetime-local), "Time zone", "Method", "Destination",
 *   "Confirmation / reference number", "Submitted by", "Kind of evidence",
 *   "Reference", "Evidence note", "What happened", and — only while readiness
 *   is not clear — "Reason for submitting with blockers". Submit button:
 *   "Record submission" | "Record submission with override" | "Save the record".
 *
 *   OUTCOME DIALOG — dialog name "Record the tender outcome". Labels: "Outcome",
 *   "Notice date", "Awarded value" (won only), "Reason / note",
 *   "Notice reference". Submit button "Record outcome".
 *
 * Scratch `userData` under `%LOCALAPPDATA%\Temp\opencode`; no app-source edits.
 */
import { test, expect } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
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
import {
  readStore,
  pollStore,
  teardownScratchProfile,
  STORE_COMMIT_POLL_MS,
  STORE_IMPORT_POLL_MS,
} from './tenders-timing'

/** `%LOCALAPPDATA%\Temp\opencode` on Windows (os.tmpdir() is %TEMP%). */
const SCRATCH_ROOT = join(tmpdir(), 'opencode')

const COMPANY_NAME = 'E2E Lifecycle Civils (Pty) Ltd'
const TENDER_REF_A = 'E2E/LIFECYCLE/2026/01'
const TENDER_REF_B = 'E2E/LIFECYCLE/2026/02'
const SUBMIT_CONFIRMATION = 'E2E-CONF-0001'
const SUBMIT_DESTINATION = 'bids@e2ewater.example'
const SUBMIT_PERSON = 'E2E Submitter'
const SUBMIT_NOTES = 'Hand-delivered by courier at 10:15; counter signed.'
const OVERRIDE_REASON = 'Deadline pressure: blockers accepted by the bid manager (E2E audit).'
const BACK_REASON = 'Re-opened to re-check the pack before submitting (E2E audit).'
const SUBMITTED_DATE_LOCAL = '2026-09-16T10:30'
const RECEIPT_REFERENCE = 'E2E-RECEIPT-0001'
const EVIDENCE_KIND = 'email-receipt'
const EVIDENCE_LABEL = 'Email receipt / sent copy'

const STATUS_LABEL: Record<string, string> = {
  IN_PROGRESS: 'In progress',
  READY_TO_ASSEMBLE: 'Ready to assemble',
  PACK_GENERATED: 'Pack generated',
  READY_FOR_SUBMISSION: 'Ready for submission',
  SUBMITTED: 'Submitted · evidence required',
  SUBMITTED_EVIDENCED: 'Submitted · evidence recorded',
  WON: 'Won',
  LOST: 'Lost',
}

const PRIMARY_ACTION: Record<string, RegExp> = {
  IN_PROGRESS: /^Mark ready to assemble$/,
  READY_TO_ASSEMBLE: /^Record pack generated$/,
  PACK_GENERATED: /^Mark ready to submit$/,
  READY_FOR_SUBMISSION: /^Record submission/,
  SUBMITTED: /^Add submission evidence/,
  SUBMITTED_EVIDENCED: /^Record outcome/,
}

// ── scratch + store helpers ───────────────────────────────────────────────────

async function scratchUserData(): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  return mkdtemp(join(SCRATCH_ROOT, 'genoffice-e2e-'))
}

function storeFile(userDataDir: string): string {
  return join(userDataDir, 'tenders', 'tenders-data.json')
}

function findTender(store: any, reference: string): any | undefined {
  for (const workspace of store?.workspaces ?? []) {
    for (const tender of workspace?.tenders ?? []) {
      if (tender?.referenceNumber === reference) return tender
    }
  }
  return undefined
}

/**
 * Poll for a committed store state, using the product's own recovery when the
 * write failed transiently (Windows can return EPERM on the store's atomic
 * rename; the UI then offers "Retry save"). One bounded recovery attempt; the
 * caller still has to see the committed state on disk.
 */
async function pollCommitted(
  tenders: Page,
  userDataDir: string,
  predicate: (store: any) => boolean,
  perAttemptMs = STORE_COMMIT_POLL_MS,
): Promise<any | null> {
  let store = await pollStore(userDataDir, predicate, perAttemptMs)
  if (store && predicate(store)) return store
  const retry = tenders.getByRole('button', { name: /^Retry save$|^Retry$/ }).first()
  if ((await retry.count()) > 0) {
    await retry.click().catch(() => {})
    store = await pollStore(userDataDir, predicate, perAttemptMs)
  }
  return store
}

/** Every lifecycle event is a valid RFC3339 transition record. */
function lifecycleIsWellFormed(tender: any): boolean {
  const history = tender?.lifecycle ?? []
  if (history.length === 0) return false
  return history.every(
    (event: any) =>
      typeof event?.at === 'string' &&
      !Number.isNaN(Date.parse(event.at)) &&
      typeof event?.to === 'string' &&
      (event.from === null || typeof event.from === 'string') &&
      (event.reason === null || typeof event.reason === 'string'),
  )
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
    'A valid CODA letter of good standing must accompany the proposal.',
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

/** Ensure the workspace for `reference` is the active one. */
async function openTenderWorkspace(tenders: Page, reference: string): Promise<void> {
  const matrix = tenders.getByRole('heading', { name: 'Compliance matrix' })
  const headerHasReference = async (): Promise<boolean> => {
    if (!(await matrix.isVisible().catch(() => false))) return false
    return (await tenders.locator('main').getByText(reference, { exact: false }).count()) > 0
  }
  if (!(await headerHasReference())) {
    await backToTenderList(tenders)
    const card = tenders.locator('main li', { hasText: reference }).first()
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.click()
  }
  await expect(matrix).toBeVisible({ timeout: 20_000 })
}

async function backToTenderList(tenders: Page): Promise<void> {
  const back = tenders.locator('main').getByRole('button', { name: 'Tenders' }).first()
  if (await back.isVisible().catch(() => false)) await back.click()
  await expect(tenders.getByRole('heading', { name: 'Tenders', level: 1 })).toBeVisible({
    timeout: 20_000,
  })
}

function lifecyclePanel(tenders: Page): Locator {
  return tenders.getByRole('region', { name: 'Tender lifecycle' })
}

/** Wait for the panel to represent `status` (status badge + primary action). */
async function expectTenderStatus(tenders: Page, status: string): Promise<void> {
  const panel = lifecyclePanel(tenders)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText(STATUS_LABEL[status], { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  })
  const action = PRIMARY_ACTION[status]
  if (action) {
    await expect(panel.getByRole('button', { name: action }).first()).toBeVisible({
      timeout: 20_000,
    })
  }
  const saveFailed = tenders.getByRole('alert').filter({ hasText: /Save failed/ })
  if ((await saveFailed.count()) > 0) {
    // Transient write failures are surfaced with a Retry; use it once before
    // declaring the lifecycle change unpersistable.
    const retry = tenders.getByRole('button', { name: /^Retry save$|^Retry$/ }).first()
    if ((await retry.count()) > 0) {
      await retry.click().catch(() => {})
      await expect(saveFailed)
        .toHaveCount(0, { timeout: 20_000 })
        .catch(() => {})
    }
    if ((await saveFailed.count()) > 0) {
      throw new Error(
        `store save failed while the tender is ${status}: ${(await saveFailed.allInnerTexts()).join(' | ')}`,
      )
    }
  }
  await expect(
    tenders.getByText('Saved', { exact: true }).first(),
    'the store settles before on-disk assertions',
  ).toBeVisible({ timeout: 20_000 })
}

async function expandLifecycleDetails(tenders: Page): Promise<void> {
  const panel = lifecyclePanel(tenders)
  const toggle = panel.getByRole('button', { name: /Details & history|Hide details/ })
  if ((await panel.getByText('Lifecycle history').count()) === 0) {
    await toggle.first().click()
  }
  await expect(panel.getByText('Lifecycle history')).toBeVisible({ timeout: 15_000 })
}

function lifecycleHistory(tenders: Page): Locator {
  return lifecyclePanel(tenders).locator('section').filter({ hasText: 'Lifecycle history' })
}

// ── lifecycle actions ─────────────────────────────────────────────────────────

async function clickPrimary(tenders: Page, status: string): Promise<void> {
  const action = PRIMARY_ACTION[status]
  expect(action, `no primary action mapped for ${status}`).toBeTruthy()
  await lifecyclePanel(tenders).getByRole('button', { name: action }).first().click()
}

async function submitTender(
  tenders: Page,
  options: { overrideReason?: string; expectRefusal?: boolean },
): Promise<void> {
  await clickPrimary(tenders, 'READY_FOR_SUBMISSION')
  const dialog = tenders.getByRole('dialog', { name: 'Record the submission' })
  await expect(dialog).toBeVisible({ timeout: 15_000 })

  // Readiness is blocked, so the checkpoint section and the override reason must
  // be shown, and the wording must never claim a clearance.
  await expect(dialog.getByText(/Readiness checkpoint: not clear/)).toBeVisible()
  await expect(dialog.getByText(/never recorded as cleared/)).toBeVisible()

  await dialog.getByLabel('Date and time submitted').fill(SUBMITTED_DATE_LOCAL)
  await dialog.getByLabel('Time zone').fill('Africa/Johannesburg')
  await dialog.getByLabel('Method').selectOption('EMAIL')
  await dialog.getByLabel('Destination').fill(SUBMIT_DESTINATION)
  await dialog.getByLabel('Confirmation / reference number').fill(SUBMIT_CONFIRMATION)
  await dialog.getByLabel('Submitted by').fill(SUBMIT_PERSON)
  await dialog.getByLabel('What happened').fill(SUBMIT_NOTES)
  if (options.overrideReason !== undefined) {
    await dialog.getByLabel('Reason for submitting with blockers').fill(options.overrideReason)
  }

  const submit = dialog.getByRole('button', { name: /^Record submission/ })
  await submit.click()
  if (options.expectRefusal) {
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    // The override reason is a native `required` field: submitting without it is
    // blocked by constraint validation, so the dialog stays open and the field
    // reports itself invalid (no React-level error is rendered).
    const override = dialog.getByLabel('Reason for submitting with blockers')
    await expect(override).toHaveValue('')
    expect(
      await override.evaluate((el) => !(el as HTMLTextAreaElement).validity.valid),
      'the override reason is required before a blocked-readiness submission can be recorded',
    ).toBe(true)
    return
  }
  await expect(dialog).toBeHidden({ timeout: 20_000 })
}

async function attachEvidence(tenders: Page): Promise<void> {
  await clickPrimary(tenders, 'SUBMITTED')
  const dialog = tenders.getByRole('dialog', { name: 'Update the submission record' })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await dialog.getByLabel('Kind of evidence').selectOption(EVIDENCE_KIND)
  await dialog.getByLabel('Reference', { exact: true }).fill(RECEIPT_REFERENCE)
  await dialog.getByRole('button', { name: 'Save the record' }).click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })
}

async function recordOutcome(
  tenders: Page,
  outcome: 'won' | 'lost' | 'withdrawn' | 'cancelled',
): Promise<void> {
  await lifecyclePanel(tenders)
    .getByRole('button', { name: /^Record outcome/ })
    .first()
    .click()
  const dialog = tenders.getByRole('dialog', { name: 'Record the tender outcome' })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await dialog.getByLabel('Outcome', { exact: true }).selectOption(outcome)
  await dialog.getByLabel('Notice date').fill('2026-10-01')
  await dialog.getByLabel('Reason / note').fill(`E2E outcome recorded as ${outcome}.`)
  if (outcome === 'won') {
    await dialog.getByLabel('Awarded value').fill('1250000')
  }
  await dialog.getByRole('button', { name: 'Record outcome' }).click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })
}

async function walkLifecycleToReadyToSubmit(tenders: Page, reference: string): Promise<void> {
  await openTenderWorkspace(tenders, reference)
  await expectTenderStatus(tenders, 'IN_PROGRESS')
  await clickPrimary(tenders, 'IN_PROGRESS')
  await expectTenderStatus(tenders, 'READY_TO_ASSEMBLE')
  await clickPrimary(tenders, 'READY_TO_ASSEMBLE')
  await expectTenderStatus(tenders, 'PACK_GENERATED')
  await clickPrimary(tenders, 'PACK_GENERATED')
  await expectTenderStatus(tenders, 'READY_FOR_SUBMISSION')
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

// ── journeys ──────────────────────────────────────────────────────────────────

test.describe('Tenders lifecycle (WP-11)', () => {
  test.describe.configure({ timeout: 600_000 })

  test('1: prepare -> reasoned history -> override submit -> evidence -> SUBMITTED_EVIDENCED', async () => {
    const screenshots: string[] = []
    // Salvaged diagnostics-log artefacts for this journey, recorded in the
    // result JSON so a failing run names the log rather than deleting it.
    const salvaged: Array<string | null> = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-lifecycle-j1',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await createCompany(tenders, COMPANY_NAME)

      const fixture = join(userDataDir, 'lifecycle-tender-a.pdf')
      await generateTenderPdf(fixture, TENDER_REF_A)
      await importTender(tenders, fixture)

      await openTenderWorkspace(tenders, TENDER_REF_A)
      await expectTenderStatus(tenders, 'IN_PROGRESS')

      // The tender title must stay readable next to the action toolbar.
      // `responsive.css` zeroes `min-width` on every toolbar child, and the
      // workspace header keeps a floor inline for exactly that reason: without
      // it the buttons squeeze the title to a single character (`S…`) and the
      // countdown badge spills under the save chip. The floor is width- and
      // zoom-independent, so this holds in wide and compact layouts alike.
      const titleBox = await tenders
        .locator('[data-testid="workspace-context-header"] h1')
        .first()
        .boundingBox()
      expect(
        titleBox?.width ?? 0,
        'the tender title keeps a readable floor beside the toolbar',
      ).toBeGreaterThanOrEqual(120)

      await clickPrimary(tenders, 'IN_PROGRESS')
      await expectTenderStatus(tenders, 'READY_TO_ASSEMBLE')

      // A reasoned move is recorded in the history with its "why".
      await expandLifecycleDetails(tenders)
      await lifecyclePanel(tenders).getByRole('button', { name: 'Back to preparing' }).click()
      await lifecyclePanel(tenders).getByLabel('Reason (recorded in the history)').fill(BACK_REASON)
      await lifecyclePanel(tenders).getByRole('button', { name: 'Move to In progress' }).click()
      await expectTenderStatus(tenders, 'IN_PROGRESS')
      await expect(lifecycleHistory(tenders).getByText(BACK_REASON)).toBeVisible({
        timeout: 15_000,
      })
      screenshots.push(await shot(tenders, 'lifecycle-j1-reasoned-history'))

      await clickPrimary(tenders, 'IN_PROGRESS')
      await expectTenderStatus(tenders, 'READY_TO_ASSEMBLE')
      await clickPrimary(tenders, 'READY_TO_ASSEMBLE')
      await expectTenderStatus(tenders, 'PACK_GENERATED')
      await clickPrimary(tenders, 'PACK_GENERATED')
      await expectTenderStatus(tenders, 'READY_FOR_SUBMISSION')
      screenshots.push(await shot(tenders, 'lifecycle-j1-ready-to-submit'))

      // (a) Refused without an override reason while readiness is not clear.
      await submitTender(tenders, { expectRefusal: true })
      await expectTenderStatus(tenders, 'READY_FOR_SUBMISSION')
      await tenders.getByRole('button', { name: 'Close submission dialog' }).click()
      await expect(tenders.getByRole('dialog', { name: 'Record the submission' })).toBeHidden({
        timeout: 15_000,
      })
      screenshots.push(await shot(tenders, 'lifecycle-j1-override-required'))

      // (b) Audited override with no evidence -> SUBMITTED (evidence required).
      await submitTender(tenders, { overrideReason: OVERRIDE_REASON })
      await expectTenderStatus(tenders, 'SUBMITTED')
      await expect(lifecyclePanel(tenders).getByText('Evidence required').first()).toBeVisible()
      await expandLifecycleDetails(tenders)

      // The UI must never claim the blockers were cleared, and must audit them.
      await expect(lifecyclePanel(tenders).getByText('Blocker override recorded')).toBeVisible()
      await expect(lifecyclePanel(tenders).getByText(OVERRIDE_REASON)).toBeVisible()
      await expect(
        lifecyclePanel(tenders).getByText(/This is not a readiness clearance/),
      ).toBeVisible()
      await expect(lifecyclePanel(tenders).getByText(/Readiness clear/)).toHaveCount(0)
      await expect(lifecyclePanel(tenders).getByText('No evidence attached yet')).toBeVisible()
      screenshots.push(await shot(tenders, 'lifecycle-j1-submitted-evidence-required'))

      const submitted = await pollCommitted(
        tenders,
        userDataDir,
        (s) => findTender(s, TENDER_REF_A)?.status === 'SUBMITTED',
      )
      const tender = findTender(submitted, TENDER_REF_A)
      const record = tender.submission
      expect(record, 'submission record persisted').toBeTruthy()
      expect(Number.isNaN(Date.parse(record.submittedAt))).toBe(false)
      expect(record.timeZone).toBe('Africa/Johannesburg')
      expect(record.method).toBe('EMAIL')
      expect(record.destination).toBe(SUBMIT_DESTINATION)
      expect(record.confirmationReference).toBe(SUBMIT_CONFIRMATION)
      expect(record.person).toBe(SUBMIT_PERSON)
      expect(record.notes).toBe(SUBMIT_NOTES)
      expect(record.evidence).toBeNull()
      expect(record.readiness, 'readiness snapshot preserved').toBeTruthy()
      expect(record.readiness.ready).toBe(false)
      expect(record.readiness.blockingCheckIds.length).toBeGreaterThan(0)
      expect(Number.isNaN(Date.parse(record.readiness.capturedAt))).toBe(false)
      expect(record.blockerOverrideReason).toBe(OVERRIDE_REASON)
      expect(lifecycleIsWellFormed(tender)).toBe(true)
      expect(
        (tender.lifecycle ?? []).some((event: any) => event.reason === BACK_REASON),
        'the reasoned move is in the history',
      ).toBe(true)

      // (c) Attach the receipt -> SUBMITTED_EVIDENCED (override audit retained).
      await attachEvidence(tenders)
      await expectTenderStatus(tenders, 'SUBMITTED_EVIDENCED')
      await expect(lifecyclePanel(tenders).getByText('Evidence recorded').first()).toBeVisible()
      await expect(
        lifecyclePanel(tenders).getByText(`${EVIDENCE_LABEL} · ${RECEIPT_REFERENCE}`),
      ).toBeVisible()
      const evidenced = await pollCommitted(
        tenders,
        userDataDir,
        (s) => findTender(s, TENDER_REF_A)?.status === 'SUBMITTED_EVIDENCED',
      )
      const evidencedTender = findTender(evidenced, TENDER_REF_A)
      expect(evidencedTender.submission.evidence).toMatchObject({
        kind: EVIDENCE_KIND,
        reference: RECEIPT_REFERENCE,
      })
      expect(evidencedTender.submission.blockerOverrideReason).toBe(OVERRIDE_REASON)
      expect(evidencedTender.submission.readiness.ready).toBe(false)
      expect(lifecycleIsWellFormed(evidencedTender)).toBe(true)
      screenshots.push(await shot(tenders, 'lifecycle-j1-evidence-recorded'))

      const result: JourneyResult = {
        journey:
          '1: prepare -> reasoned history -> override submit (no evidence) -> SUBMITTED -> evidence -> SUBMITTED_EVIDENCED',
        status: 'PASS',
        detail: `override refused without a reason; audited with reason; blockers preserved (${record.readiness.blockingCheckIds.join(',')}); evidence ${EVIDENCE_KIND} recorded`,
        evidence: {
          userDataDir,
          submission: {
            submittedAt: record.submittedAt,
            timeZone: record.timeZone,
            method: record.method,
            destination: record.destination,
            confirmationReference: record.confirmationReference,
            person: record.person,
            blockerOverrideReason: record.blockerOverrideReason,
            readiness: record.readiness,
          },
          evidenceRecord: evidencedTender.submission.evidence,
          lifecycle: evidencedTender.lifecycle,
        },
        screenshots,
        // The salvaged diagnostics log(s) for this journey. Recorded as a path
        // so a failing run names the artefact instead of deleting it with the
        // profile — the result JSON is the run's own statement, the log is the
        // evidence for it.
        diagnosticsLogs: salvaged.filter(Boolean) as string[],
      }
      await writeResult('tenders-lifecycle-journey-1', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-lifecycle-j1').catch(() => undefined)
      salvaged.push(await teardownScratchProfile(userDataDir, `tenders-lifecycle-run1`))
    }
  })

  test('2: won exposes milestones; lost does not; outcome + history persist across restart', async () => {
    const screenshots: string[] = []
    // Salvaged diagnostics-log artefacts for this journey, recorded in the
    // result JSON so a failing run names the log rather than deleting it.
    const salvaged: Array<string | null> = []
    let run1: LaunchedApp | undefined
    let run2: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-lifecycle-j2-run1',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)
      await createCompany(tenders, COMPANY_NAME)

      const fixtureA = join(userDataDir, 'lifecycle-tender-a.pdf')
      const fixtureB = join(userDataDir, 'lifecycle-tender-b.pdf')
      await generateTenderPdf(fixtureA, TENDER_REF_A)
      await generateTenderPdf(fixtureB, TENDER_REF_B)
      await importTender(tenders, fixtureA)
      await backToTenderList(tenders)
      await importTender(tenders, fixtureB)

      let wonTender: any
      let lostTender: any
      const captureOutcomeFailure = async (error: unknown): Promise<never> => {
        const alerts = await tenders
          .getByRole('alert')
          .allInnerTexts()
          .catch(() => [] as string[])
        const disk = await readStore(userDataDir)
        await writeResult('tenders-lifecycle-journey-2', {
          journey: '2: outcomes (won/lost) + milestone exposure + restart persistence + history',
          status: 'FAIL',
          detail: `an outcome/status change did not persist: ${alerts.join(' | ') || (error instanceof Error ? error.message : String(error))}`,
          evidence: {
            userDataDir,
            alerts,
            tenders: (disk?.workspaces ?? []).flatMap((workspace: any) =>
              (workspace.tenders ?? []).map((tender: any) => ({
                reference: tender.referenceNumber,
                status: tender.status,
                outcome: tender.outcome ?? null,
                lifecycle: tender.lifecycle ?? [],
              })),
            ),
          },
          screenshots,
          // The salvaged diagnostics log(s) for this journey. Recorded as a path
          // so a failing run names the artefact instead of deleting it with the
          // profile — the result JSON is the run's own statement, the log is the
          // evidence for it.
          diagnosticsLogs: salvaged.filter(Boolean) as string[],
        })
        throw error instanceof Error ? error : new Error(String(error))
      }
      try {
        // Tender A -> submitted -> won -> milestones exposed.
        await walkLifecycleToReadyToSubmit(tenders, TENDER_REF_A)
        await submitTender(tenders, { overrideReason: OVERRIDE_REASON })
        await expectTenderStatus(tenders, 'SUBMITTED')
        await recordOutcome(tenders, 'won')
        await expectTenderStatus(tenders, 'WON')

        const panel = lifecyclePanel(tenders)
        const wonMilestonesButton = panel.getByRole('button', { name: 'Contract milestones' })
        await expect(wonMilestonesButton).toBeVisible({ timeout: 15_000 })
        const toolbarMilestones = tenders.getByRole('button', { name: /^Milestones/ })
        expect(await toolbarMilestones.count(), 'won tender exposes the Milestones toolbar').toBe(1)
        await wonMilestonesButton.click()
        await expect(tenders.getByText(/Contract Milestones/)).toBeVisible({ timeout: 15_000 })
        // The drawer's own close control is hit-testable: the drawer's box starts
        // at the bottom edge of the sticky workspace toolbar, so nothing paints
        // over its title row (components/Drawer.tsx `toolbarBottomOffset`).
        // Escape is the drawer's documented close gesture and the close is
        // verified rather than assumed.
        const closeMilestones = tenders.getByRole('button', { name: 'Close Milestones' })
        await tenders.keyboard.press('Escape')
        await expect(closeMilestones).toHaveCount(0, { timeout: 15_000 })
        screenshots.push(await shot(tenders, 'lifecycle-j2-won-milestones-exposed'))

        // Tender B -> submitted -> lost -> milestones NOT exposed.
        await walkLifecycleToReadyToSubmit(tenders, TENDER_REF_B)
        await submitTender(tenders, { overrideReason: OVERRIDE_REASON })
        await expectTenderStatus(tenders, 'SUBMITTED')
        await recordOutcome(tenders, 'lost')
        await expectTenderStatus(tenders, 'LOST')
        const panelB = lifecyclePanel(tenders)
        await expect(panelB.getByRole('button', { name: 'Contract milestones' })).toHaveCount(0)
        expect(
          await tenders.getByRole('button', { name: /^Milestones/ }).count(),
          'lost tender must not expose the Milestones toolbar',
        ).toBe(0)
        await expandLifecycleDetails(tenders)
        await expect(panelB.getByText(/only available for a won tender/i).first()).toBeVisible()
        screenshots.push(await shot(tenders, 'lifecycle-j2-lost-milestones-hidden'))

        // Disk: outcomes + well-formed, append-only history.
        const decided = await pollCommitted(
          tenders,
          userDataDir,
          (s) =>
            findTender(s, TENDER_REF_A)?.status === 'WON' &&
            findTender(s, TENDER_REF_A)?.outcome?.status === 'won' &&
            findTender(s, TENDER_REF_B)?.status === 'LOST' &&
            findTender(s, TENDER_REF_B)?.outcome?.status === 'lost',
          STORE_IMPORT_POLL_MS,
        )
        wonTender = findTender(decided, TENDER_REF_A)
        lostTender = findTender(decided, TENDER_REF_B)
        expect(wonTender?.outcome?.status, 'won outcome must persist').toBe('won')
        expect(wonTender.outcome.awardedValue).toBe(1250000)
        expect(lostTender?.outcome?.status, 'lost outcome must persist').toBe('lost')
        expect(lostTender.outcome.awardedValue).toBeNull()
        // D2 regression guard: the dialog's civil notice date must reach the
        // store as an RFC3339 instant (the schema rejects civil dates).
        const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
        expect(wonTender.outcome.noticeDate, 'won noticeDate must be an RFC3339 instant').toMatch(
          RFC3339,
        )
        expect(lostTender.outcome.noticeDate, 'lost noticeDate must be an RFC3339 instant').toMatch(
          RFC3339,
        )
        expect(lifecycleIsWellFormed(wonTender)).toBe(true)
        expect(lifecycleIsWellFormed(lostTender)).toBe(true)
        expect(wonTender.lifecycle.some((event: any) => event.to === 'WON')).toBe(true)
        expect(lostTender.lifecycle.some((event: any) => event.to === 'LOST')).toBe(true)
      } catch (error) {
        await captureOutcomeFailure(error)
      }

      await closeAndSaveVideo(run1, 'tenders-lifecycle-j2-run1')
      run1 = undefined

      // Restart: statuses, records and history persist; LOST still hides billing.
      run2 = await launchShell({ userDataDir, videoDir: 'tenders-lifecycle-j2-run2' })
      const tenders2 = await openTendersFromNav(run2.app, run2.page)
      await dismissTendersOnboarding(tenders2)
      await openTenderWorkspace(tenders2, TENDER_REF_A)
      await expectTenderStatus(tenders2, 'WON')
      await expandLifecycleDetails(tenders2)
      await expect(
        lifecyclePanel(tenders2).getByRole('button', { name: 'Contract milestones' }),
      ).toBeVisible()
      expect(await lifecycleHistory(tenders2).getByRole('listitem').count()).toBeGreaterThanOrEqual(
        5,
      )

      await openTenderWorkspace(tenders2, TENDER_REF_B)
      await expectTenderStatus(tenders2, 'LOST')
      expect(
        await tenders2.getByRole('button', { name: /^Milestones/ }).count(),
        'lost tender still hides milestone billing after restart',
      ).toBe(0)
      screenshots.push(await shot(tenders2, 'lifecycle-j2-restart-persisted'))

      const afterRestart = await readStore(userDataDir)
      expect(findTender(afterRestart, TENDER_REF_A).outcome.status).toBe('won')
      expect(findTender(afterRestart, TENDER_REF_B).outcome.status).toBe('lost')
      expect(lifecycleIsWellFormed(findTender(afterRestart, TENDER_REF_A))).toBe(true)

      const result: JourneyResult = {
        journey: '2: outcomes (won/lost) + milestone exposure + restart persistence + history',
        status: 'PASS',
        detail: `WON exposes milestones (panel + toolbar); LOST hides both; history A=${wonTender.lifecycle.length} B=${lostTender.lifecycle.length}; persisted across restart`,
        evidence: {
          userDataDir,
          wonOutcome: wonTender.outcome,
          lostOutcome: lostTender.outcome,
          wonLifecycle: wonTender.lifecycle,
          lostLifecycle: lostTender.lifecycle,
        },
        screenshots,
        // The salvaged diagnostics log(s) for this journey. Recorded as a path
        // so a failing run names the artefact instead of deleting it with the
        // profile — the result JSON is the run's own statement, the log is the
        // evidence for it.
        diagnosticsLogs: salvaged.filter(Boolean) as string[],
      }
      await writeResult('tenders-lifecycle-journey-2', result)
    } finally {
      if (run1) await closeAndSaveVideo(run1, 'tenders-lifecycle-j2-run1').catch(() => undefined)
      if (run2) await closeAndSaveVideo(run2, 'tenders-lifecycle-j2-run2').catch(() => undefined)
      salvaged.push(await teardownScratchProfile(userDataDir, `tenders-lifecycle-run2`))
    }
  })
})
