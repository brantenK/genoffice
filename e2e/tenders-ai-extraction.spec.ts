/**
 * Wave C — the AI-extraction path, proven end to end against the built shell.
 *
 * The extraction CORE (`apps/tenders/src/shared/ai-extraction.ts`) is already
 * unit-tested with an injected fake completion, which proves the pipeline but
 * says nothing about the four layers a real run actually crosses: the renderer
 * transport (`renderer/src/ai/transport.ts`), the preload bridge
 * (`window.tendersApi.aiStream` / `onAiStream`), the shell's own `ai:*` handlers
 * (`registerAiIpc()` in `apps/docs/src/main/docs-main.ts`, registered once for
 * the whole suite), and the provider layer
 * (`@genoffice/ai-provider` → `streamOpenAiCompatible`). This spec crosses all
 * four with a REAL HTTP response, and never touches the public internet:
 *
 *   `e2e/tenders-ai-fixtures.ts` starts a `127.0.0.1` server on an ephemeral
 *   port speaking the OpenAI-compatible chat-completions SSE wire format, and an
 *   `ai-settings.json` in the scratch profile selects the catalogue's `custom`
 *   provider (`needsBaseUrl` — the one `AI_BASE_URL_PROVIDERS` names) pointed at
 *   it. Nothing is patched: the app reads that settings file through its own
 *   handler, exactly as it would for a real BYOK provider.
 *
 * What is asserted, and why each one would catch a regression:
 *
 *  1. AI OFF (the default) — the import behaves exactly as it does today and the
 *     fake server receives ZERO requests. This is the offline-default guarantee,
 *     and it is the most important assertion in this file: a fully configured
 *     model is present and offered, so "no request" is a real result and not an
 *     artefact of nothing being configured.
 *  2. AI ON — the server receives a well-formed request; the model's suggestion
 *     is written with `suggestedBy: 'ai'`, appears in the UI wearing the
 *     "AI-suggested" marker, stays `unconfirmed`, and the tender is still NOT
 *     ready; the local engine's own requirements are still there alongside it.
 *  3. A failing provider (HTTP 500) and a malformed reply both degrade to the
 *     local extraction: nothing is added, nothing is relabelled, nothing becomes
 *     ready, and the tender stays usable.
 *  4. A run interrupted while still in flight leaves a usable tender: the local
 *     result was already committed and the model's answer never lands.
 *
 * The AI pass's own feedback IS reachable from the workspace: `AiPassPanel`
 * (`TenderList.tsx`) renders the `ai-extraction-progress` row with its "Cancel AI
 * extraction" button, and the `intake-notice` summary that carries the refusal
 * reasons, and the workspace mounts it (`Workspace.tsx:971`, scoped to the tender
 * on screen). That mount is what closes the gap this header used to record: the
 * import handler commits the local result and immediately calls
 * `setActiveTender(record.id)` (TenderList.tsx:1093), and `TendersPage` renders
 * `Workspace` *instead of* `TenderList`, so a panel rendered only by the list
 * would be unmounted before the run could report anything. Progress, the summary,
 * the refusal reasons and mid-run cancellation are therefore all on screen after
 * a normal import.
 *
 * Journey 4 still stops the run the hard way — quitting mid-flight and restarting
 * — rather than clicking that button, because a process exit is a stronger
 * interruption than a click and the outcome it asserts is read from the
 * authoritative document, so the journey stays valid independently of how the run
 * is stopped.
 *
 * Navigation: every journey creates its workspace first, and creating one leaves
 * the app on the **Overview** page. The sidebar's own "Tenders" item is what
 * mounts `TenderList`, where the import dropzone — and with it the optional-AI
 * opt-in — actually live, so `openTenderList()` is called before anything on that
 * view is asserted. `openTenderWorkspace()` covers the other direction: a restart
 * restores the tender that was open, so it accepts either a restored workspace or
 * a list that still needs its card clicked.
 *
 * Isolation: every journey uses a scratch `userData` under
 * `%LOCALAPPDATA%\Temp\opencode`, closes only the Electron processes it launched
 * through the shared harness, closes its fake provider in a `finally`, and
 * removes its scratch dir when done. No application source is modified.
 *
 * Build first: `npm run build -w @genoffice/tenders && npm run build -w @genoffice/shell`.
 * Run: `npx playwright test e2e/tenders-ai-extraction.spec.ts`.
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
import {
  AI_FAKE_KEY,
  AI_FAKE_MODEL,
  AI_ONLY_RULE_KEY,
  AI_SOURCE_CLAUSE,
  AI_SUGGESTED_CLOSING_DATE,
  AI_SUGGESTED_REQUIREMENT_ID,
  AI_SUGGESTED_REQUIREMENT_TITLE,
  AI_SUGGESTION_MARKER,
  HUMAN_DECIDED_FIELD_STATES,
  TENDER_FIXTURE_REF,
  TENDER_FIXTURE_REF_TWO,
  aiMarkedPaths,
  findTenderByReference,
  generateTenderPdf,
  pollStore,
  readStore,
  startFakeProvider,
  tenderFixtureLines,
  writeAiSettings,
  type FakeProvider,
} from './tenders-ai-fixtures'
import { STORE_COMMIT_POLL_MS, STORE_IMPORT_POLL_MS } from './tenders-timing'

/** `%LOCALAPPDATA%\Temp\opencode` on Windows (os.tmpdir() is %TEMP%). */
const SCRATCH_ROOT = join(tmpdir(), 'opencode')

const COMPANY_NAME = 'E2E AI Extraction Civils (Pty) Ltd'
const COMPANY_NAME_PLACEHOLDER = 'e.g. Lephalale Civils (Pty) Ltd'

/** The fixture's lines and references come from the shared fixture module. */
const TENDER_REF = TENDER_FIXTURE_REF
const TENDER_REF_TWO = TENDER_FIXTURE_REF_TWO
const tenderLines = tenderFixtureLines

/**
 * Rule keys the local engine must read from the fixture text. `joint_venture`
 * (the key only the model suggests) is deliberately absent from the fixture, so
 * the model's requirement is genuinely additive.
 */
const PARSER_RULE_KEYS = ['tax_pin', 'coida'] as const

/** UI label of the review field the model suggests a value for. */
const CLOSING_FIELD_LABEL = 'Closing date & time'

/** Its key in `IntakeVerification.fields`. */
const CLOSING_FIELD_KEY = 'closingDate'

/** A requirement the local engine (not a model) produced, for the negative check. */
const PARSER_REQUIREMENT_TITLE = 'Valid SARS Tax Clearance / TCS PIN'

// ── scratch profile ───────────────────────────────────────────────────────────

async function scratchUserData(): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  return mkdtemp(join(SCRATCH_ROOT, 'genoffice-e2e-'))
}

// ── shell navigation + shared UI helpers (same shape as the other Tenders specs) ─

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

/**
 * Land on the Tenders page inside the workspace — where the import dropzone, and
 * with it the optional-AI opt-in, actually live.
 *
 * Creating a company (and starting a profile that already has one) leaves the app
 * on the **Overview** page: the sidebar's own "Tenders" item is what mounts
 * `TenderList`. Asserting the dropzone's controls before that is asserting on a
 * view that is not on screen. This is the same sequence
 * `tenders-regression-smoke.spec.ts` uses (`gotoInternalTendersPage`) before it
 * imports an RFP.
 */
async function openTenderList(tenders: Page): Promise<void> {
  await tenders.locator('nav').getByRole('button', { name: 'Tenders' }).click()
  await expect(tenders.getByRole('heading', { name: 'Tenders', level: 1 })).toBeVisible({
    timeout: 20_000,
  })
}

/** Leave the workspace and return to the tender list; a no-op when already there. */
async function backToTenderList(tenders: Page): Promise<void> {
  const header = tenders.locator('[data-testid="workspace-context-header"]')
  if (await header.isVisible().catch(() => false)) {
    // The workspace toolbar's own "Tenders" button leaves the tender as well as
    // the page, which the sidebar item alone does not.
    await header.getByRole('button', { name: 'Tenders' }).click()
  }
  await openTenderList(tenders)
}

/**
 * Show the workspace of `reference`, whether or not it came back with the app.
 *
 * A restart restores the tender that was open — the page and the active tender
 * are session state the store persists — so the sidebar's "Tenders" item lands
 * on the workspace, not on the list, and the card only has to be clicked when
 * the app did come back on the list. Same shape as
 * `tenders-regression-smoke.spec.ts`'s `ensureTenderWorkspace`, and the reason
 * this journey does not simply reuse `openTenderList` here.
 */
async function openTenderWorkspace(tenders: Page, reference: string): Promise<void> {
  await tenders.locator('nav').getByRole('button', { name: 'Tenders' }).click()
  const matrix = tenders.getByRole('heading', { name: 'Compliance matrix' })
  if (!(await matrix.isVisible().catch(() => false))) {
    const card = tenders.locator('main li', { hasText: reference }).first()
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.click()
  }
  await expect(matrix).toBeVisible({ timeout: 20_000 })
}

/** Import a PDF from the dropzone and wait for the compliance matrix. */
async function importTender(tenders: Page, fixturePath: string): Promise<void> {
  await backToTenderList(tenders)
  await tenders.locator('input[type="file"][accept*="pdf"]').first().setInputFiles(fixturePath)
  await expect(tenders.getByRole('heading', { name: 'Compliance matrix' })).toBeVisible({
    timeout: 90_000,
  })
}

/** The optional-AI opt-in, present only when a model is actually configured. */
function aiToggle(tenders: Page) {
  return tenders.getByTestId('ai-extraction-toggle')
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

function fieldGroup(tenders: Page, label: string) {
  return tenders.getByRole('group', { name: label, exact: true })
}

interface ReadinessState {
  ready: boolean
  buttonPresent: boolean
  buttonDisabled: boolean
  intakeBlocked: boolean
  intakeDetail: string
}

/** Open the Bid-readiness drawer, read its state, and close it again. */
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
  const intakeDetail = intakeBlocked ? await intakeFail.first().innerText() : ''
  const close = tenders.getByRole('button', { name: 'Close readiness' })
  if (await close.count()) {
    await tenders.keyboard.press('Escape')
    await expect(close).toHaveCount(0, { timeout: 15_000 })
  }
  return { ready, buttonPresent, buttonDisabled, intakeBlocked, intakeDetail }
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
 * Assert the fake provider received nothing, and keep asserting it for a window
 * long enough for a stray AI pass to have started and reached the network.
 *
 * A single `toBe(0)` would only prove "not yet"; the window is what makes the
 * offline guarantee meaningful. The window opens after the local result is
 * already committed, which is the moment `handleFile` would have started the AI
 * pass.
 */
async function expectNoRequests(provider: FakeProvider, windowMs = 6_000): Promise<void> {
  const deadline = Date.now() + windowMs
  while (Date.now() < deadline) {
    expect(
      provider.requestCount(),
      `the fake model provider was contacted ${provider.requestCount()} time(s) while AI extraction was OFF (paths: ${provider.requests
        .map((request) => request.path)
        .join(', ')})`,
    ).toBe(0)
    await new Promise((r) => setTimeout(r, 250))
  }
}

// ── shared assertions on the authoritative document ───────────────────────────

interface TenderShape {
  parserRuleKeys: string[]
  aiRuleKeys: string[]
  fieldStates: Record<string, string>
  requirementReviewStates: string[]
  aiMarked: { path: string; ruleKey?: string; value?: string }[]
}

/** Everything the journeys assert about one tender, read from the v2 document. */
function tenderShape(tender: any): TenderShape {
  const requirements: any[] = tender?.requirements ?? []
  const fields = tender?.intakeVerification?.fields ?? {}
  return {
    parserRuleKeys: requirements
      .filter((requirement) => requirement.suggestedBy !== 'ai')
      .map((requirement) => requirement.ruleKey as string),
    aiRuleKeys: requirements
      .filter((requirement) => requirement.suggestedBy === 'ai')
      .map((requirement) => requirement.ruleKey as string),
    fieldStates: Object.fromEntries(
      Object.entries(fields).map(([key, value]: [string, any]) => [key, value?.state]),
    ),
    requirementReviewStates: Object.values(tender?.intakeVerification?.requirements ?? {}).map(
      (entry: any) => entry?.state,
    ),
    aiMarked: aiMarkedPaths(tender),
  }
}

/**
 * The local engine's own requirements must be present in every journey,
 * whatever the model did or failed to do.
 *
 * Deliberately an `arrayContaining`, not an exact equality: the fixture's text
 * is chosen so the two keys below fire and `joint_venture` cannot, but the
 * shredder's clause grouping is a heuristic, so pinning the *exact* set here
 * would make this spec fail for a reason that has nothing to do with the AI
 * path. Exactness where it is meaningful is asserted instead by comparing the
 * parser's set across the two imports of journey 3.
 */
function expectParserRequirements(shape: TenderShape, context: string): void {
  expect(
    shape.parserRuleKeys,
    `${context}: the local rule engine\u2019s own requirements must still be present`,
  ).toEqual(expect.arrayContaining([...PARSER_RULE_KEYS]))
}

test.describe('Tenders AI extraction over the real stack (wave C)', () => {
  test.describe.configure({ timeout: 600_000 })

  /**
   * The offline-default guarantee. A fully usable model is configured and
   * offered, AI extraction is OFF, and the provider is never contacted: the app
   * behaves exactly as it does today.
   */
  test('1: with AI extraction OFF, a configured model is never contacted and nothing changes', async () => {
    const userDataDir = await scratchUserData()
    const screenshots: string[] = []
    const videos: string[] = []
    const provider = await startFakeProvider()
    let run: LaunchedApp | undefined
    try {
      await writeAiSettings(userDataDir, provider.origin)
      const fixture = join(userDataDir, 'ai-off.pdf')
      await generateTenderPdf(fixture, tenderLines(TENDER_REF))

      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-ai-extraction-j1',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)
      await createCompany(tenders, COMPANY_NAME)
      // Creating the workspace lands on Overview; the opt-in lives on the
      // Tenders page.
      await openTenderList(tenders)

      // The model IS configured, so the opt-in is offered — which is what makes
      // "zero requests" below a real result rather than an absent config.
      await expect(aiToggle(tenders)).toBeVisible({ timeout: 20_000 })
      await expect(aiToggle(tenders), 'AI extraction defaults to OFF').not.toBeChecked()
      expect(provider.requestCount(), 'reading settings must not contact the provider').toBe(0)

      await importTender(tenders, fixture)
      const committed = await pollStore(
        userDataDir,
        (s) => Boolean(findTenderByReference(s, TENDER_REF)),
        STORE_IMPORT_POLL_MS,
      )
      const tender = findTenderByReference(committed, TENDER_REF)
      expect(tender, 'the locally shredded tender must be committed').toBeTruthy()

      // The offline guarantee, held open for a window: no request, ever.
      await expectNoRequests(provider)

      const shape = tenderShape(tender)
      expectParserRequirements(shape, 'AI OFF')
      expect(shape.aiRuleKeys, 'AI is off, so nothing may be attributed to a model').toEqual([])
      expect(shape.aiMarked, 'no AI provenance may exist anywhere in the document').toEqual([])
      expect(
        shape.fieldStates[CLOSING_FIELD_KEY],
        'the closing date stays the parser\u2019s own (absent) value',
      ).toBe('unconfirmed')
      expect(
        Object.values(shape.fieldStates).some((state) =>
          (HUMAN_DECIDED_FIELD_STATES as readonly string[]).includes(state),
        ),
        'nothing may be decided without a human',
      ).toBe(false)
      // ...and nothing anywhere in the view may wear the model-provenance marker.
      await expect(
        tenders.getByText(AI_SUGGESTION_MARKER, { exact: true }),
        'no value may be presented as a model suggestion while AI extraction is OFF',
      ).toHaveCount(0)
      screenshots.push(await shot(tenders, 'ai-j1-local-only-matrix'))

      // Readiness is blocked, exactly as it is without this feature.
      const readiness = await readinessState(tenders)
      expect(readiness.ready).toBe(false)
      expect(readiness.intakeBlocked).toBe(true)
      expect(readiness.buttonDisabled).toBe(true)

      // The preference is still OFF after the import, so the next import is
      // offline too.
      await backToTenderList(tenders)
      await expect(aiToggle(tenders)).toBeVisible({ timeout: 20_000 })
      await expect(aiToggle(tenders)).not.toBeChecked()
      await expectNoRequests(provider, 2_000)
      screenshots.push(await shot(tenders, 'ai-j1-offline-default'))

      await writeResult('tenders-ai-extraction-journey-1', {
        journey: 'AI extraction OFF: configured model never contacted, local result unchanged',
        status: 'PASS',
        detail: `provider requests = ${provider.requestCount()}; parser requirements = ${shape.parserRuleKeys.join(', ')}; readiness blocked`,
        evidence: {
          userDataDir,
          providerOrigin: provider.origin,
          providerRequests: provider.requestCount(),
          parserRuleKeys: shape.parserRuleKeys,
          fieldStates: shape.fieldStates,
          readiness,
        },
        screenshots,
        videos: videos.filter(Boolean),
      })
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-ai-extraction-j1').catch(() => undefined)
      await provider.close().catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  /**
   * The feature itself, across every real layer: the request the provider layer
   * actually puts on the wire, the suggestion the review step records, its
   * provenance, and the invariant that none of it can make a tender ready.
   */
  test('2: with AI extraction ON, a model suggestion lands marked, unconfirmed and not ready', async () => {
    const userDataDir = await scratchUserData()
    const screenshots: string[] = []
    const videos: string[] = []
    const provider = await startFakeProvider({ mode: 'sse-ok' })
    let run: LaunchedApp | undefined
    try {
      await writeAiSettings(userDataDir, provider.origin)
      const fixture = join(userDataDir, 'ai-on.pdf')
      await generateTenderPdf(fixture, tenderLines(TENDER_REF))

      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-ai-extraction-j2',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)
      await createCompany(tenders, COMPANY_NAME)
      await openTenderList(tenders)

      await expect(aiToggle(tenders)).toBeVisible({ timeout: 20_000 })
      await aiToggle(tenders).check()
      await expect(aiToggle(tenders)).toBeChecked()

      await importTender(tenders, fixture)

      // The request must reach the fake provider, in the provider layer's own
      // OpenAI-compatible shape.
      await expect
        .poll(() => provider.requestCount(), {
          timeout: 60_000,
          message: 'the model provider was never asked to read the document',
        })
        .toBeGreaterThan(0)
      const request = provider.requests[0]!
      expect(request.method).toBe('POST')
      expect(request.path, 'custom provider base URL + the protocol\u2019s own path').toBe(
        '/v1/chat/completions',
      )
      expect(request.authorization, 'the configured BYOK key is sent as a bearer token').toBe(
        `Bearer ${AI_FAKE_KEY}`,
      )
      expect(request.body?.model).toBe(AI_FAKE_MODEL)
      expect(request.body?.stream, 'the transport streams').toBe(true)
      const system = String(request.body?.messages?.[0]?.content ?? '')
      const user = String(request.body?.messages?.[1]?.content ?? '')
      expect(request.body?.messages?.[0]?.role).toBe('system')
      expect(system, 'the strict-JSON contract the reply parser depends on').toContain(
        'Reply with ONE strict JSON object',
      )
      expect(system, 'the known rule catalogue is handed to the model').toContain(
        'Known rule catalogue',
      )
      expect(system, 'catalogue keys are offered so the model maps onto known rules').toContain(
        AI_ONLY_RULE_KEY,
      )
      expect(user, 'the page text is what is actually sent').toContain('--- PAGE 1 ---')
      expect(user).toContain(TENDER_REF)

      // The suggestion is recorded in the authoritative document, marked with
      // its provenance and still undecided.
      const committed = await pollStore(
        userDataDir,
        (s) => {
          const tender = findTenderByReference(s, TENDER_REF)
          return (tender?.requirements ?? []).some(
            (requirement: any) => requirement.ruleKey === AI_ONLY_RULE_KEY,
          )
        },
        STORE_IMPORT_POLL_MS,
      )
      const tender = findTenderByReference(committed, TENDER_REF)
      expect(tender, 'the tender must be committed').toBeTruthy()
      const shape = tenderShape(tender)

      expectParserRequirements(shape, 'AI ON')
      expect(shape.aiRuleKeys, 'the model-only rule is recorded as a model suggestion').toEqual([
        AI_ONLY_RULE_KEY,
      ])

      const aiRequirement = (tender.requirements as any[]).find(
        (requirement) => requirement.ruleKey === AI_ONLY_RULE_KEY,
      )
      expect(aiRequirement.id, 'a model requirement with no id gets the synthesised one').toBe(
        AI_SUGGESTED_REQUIREMENT_ID,
      )
      expect(aiRequirement.title).toBe(AI_SUGGESTED_REQUIREMENT_TITLE)
      expect(aiRequirement.verbatimClause).toBe(AI_SOURCE_CLAUSE)
      expect(aiRequirement.suggestedBy).toBe('ai')
      expect(
        tender.intakeVerification?.requirements?.[aiRequirement.id]?.state,
        'a model suggestion is registered unreviewed, never verified',
      ).toBe('unreviewed')

      const closing = tender.intakeVerification.fields.closingDate
      expect(closing, 'the model-suggested closing date must be recorded').toBeTruthy()
      expect(closing.state, 'nothing a model produces may be a human decision').toBe('unconfirmed')
      expect(closing.suggestedBy, 'the filled field is marked as a model suggestion').toBe('ai')
      expect(closing.extractedValue).toBe(AI_SUGGESTED_CLOSING_DATE)
      expect(
        (closing.candidates ?? []).some(
          (candidate: any) =>
            candidate.value === AI_SUGGESTED_CLOSING_DATE && candidate.suggestedBy === 'ai',
        ),
        'the suggestion is also offered as a marked candidate',
      ).toBe(true)

      // No false readiness, through the real stack.
      expect(
        Object.values(shape.fieldStates).some((state) =>
          (HUMAN_DECIDED_FIELD_STATES as readonly string[]).includes(state),
        ),
        'no field may be decided by the model',
      ).toBe(false)
      expect(
        shape.requirementReviewStates.every((state) => state === 'unreviewed'),
        'no requirement may be verified by the model',
      ).toBe(true)
      expect(
        shape.aiMarked.some((marked) => marked.path.includes('intakeVerification.fields')),
        'the field-level provenance marker must be present in the document',
      ).toBe(true)

      // Reachable UI facts: the added requirement is a real matrix row, and the
      // review OFFERS the model's value without adopting it. The tender's own
      // closing date is still empty — a suggestion is something to decide, not
      // something the model gets to write into the tender.
      await expect(tenders.getByText(AI_SUGGESTED_REQUIREMENT_TITLE).first()).toBeVisible({
        timeout: 20_000,
      })
      // The marker the UI wave adds: the matrix row for the model's requirement
      // wears it, and a row the local engine produced does not.
      const aiRow = tenders.locator('main li', { hasText: AI_SUGGESTED_REQUIREMENT_TITLE }).first()
      await expect(
        aiRow.getByText(AI_SUGGESTION_MARKER, { exact: true }),
        'a model-produced requirement must be marked as a model suggestion',
      ).toBeVisible()
      const parserRow = tenders.locator('main li', { hasText: PARSER_REQUIREMENT_TITLE }).first()
      await expect(parserRow).toBeVisible()
      await expect(
        parserRow.getByText(AI_SUGGESTION_MARKER, { exact: true }),
        'a parser-produced requirement must never wear the model marker',
      ).toHaveCount(0)

      await openReview(tenders)
      const group = fieldGroup(tenders, CLOSING_FIELD_LABEL)
      await expect(group).toBeVisible()
      expect(
        tender.closingDate,
        'a model suggestion must never become the tender\u2019s own value on its own',
      ).toBeNull()
      await expect(group.getByRole('textbox')).toHaveValue('')
      // Scoped to the "Found in the document" suggestion row rather than the whole
      // field: the same value legitimately appears twice in this group — once as
      // that suggestion, and once as the field's own (unconfirmed, AI-marked)
      // extracted value — so an unscoped lookup is ambiguous by construction. The
      // row-scoped locator is the stronger claim: this is the row that OFFERS the
      // model's value, with the control that adopts it.
      const suggestionRow = group.locator('div', { hasText: 'Found in the document:' }).first()
      await expect(
        suggestionRow.getByText(AI_SUGGESTED_CLOSING_DATE, { exact: true }),
        'the model\u2019s value is offered in the review',
      ).toBeVisible()
      await expect(group.getByRole('button', { name: 'Use this value' })).toBeVisible()
      // The field and its suggestion both carry the marker (the field header chip
      // and the suggestion row's own), which is the point: a model value is
      // never presented as the local parser's read.
      await expect(
        group.getByText(AI_SUGGESTION_MARKER, { exact: true }).first(),
        'the model-suggested field must be marked as AI-suggested in the review',
      ).toBeVisible()
      await expect(
        group.getByText('Confirmed', { exact: true }),
        'a model suggestion must never render as confirmed',
      ).toHaveCount(0)
      await expect(
        group.getByText(/^(Not confirmed|Needs review)$/),
        'the field is still undecided in the UI',
      ).toBeVisible()
      screenshots.push(await shot(tenders, 'ai-j2-review-offers-model-value'))

      // No false readiness, through the real stack and before any human action.
      const readiness = await readinessState(tenders)
      expect(readiness.ready, 'a model suggestion must not make the bid ready').toBe(false)
      expect(readiness.intakeBlocked).toBe(true)
      expect(readiness.buttonDisabled).toBe(true)
      screenshots.push(await shot(tenders, 'ai-j2-readiness-still-blocked'))

      // Only a HUMAN action decides: choosing the model's suggested value is
      // what writes it to the tender and moves the field to `confirmed`. The
      // model's own pass could never do either.
      await openReview(tenders)
      const useValue = fieldGroup(tenders, CLOSING_FIELD_LABEL).getByRole('button', {
        name: 'Use this value',
      })
      await expect(useValue).toBeVisible()
      await useValue.click()
      const decided = await pollStore(
        userDataDir,
        (s) => findTenderByReference(s, TENDER_REF)?.closingDate === AI_SUGGESTED_CLOSING_DATE,
        STORE_COMMIT_POLL_MS,
      )
      const decidedTender = findTenderByReference(decided, TENDER_REF)
      expect(
        decidedTender.closingDate,
        'a human choice is what writes the model\u2019s value onto the tender',
      ).toBe(AI_SUGGESTED_CLOSING_DATE)
      expect(
        decidedTender.intakeVerification.fields.closingDate.state,
        'the human decision is what marks the field confirmed',
      ).toBe('confirmed')
      expect(
        decidedTender.intakeVerification.fields.closingDate.suggestedBy,
        'confirming never erases who produced the value',
      ).toBe('ai')
      expect(
        tenderShape(decidedTender).aiMarked.length,
        'the AI provenance marker survives the human confirmation',
      ).toBeGreaterThan(0)
      screenshots.push(await shot(tenders, 'ai-j2-human-confirms-suggestion'))

      await writeResult('tenders-ai-extraction-journey-2', {
        journey:
          'AI extraction ON: suggestion recorded and marked, unconfirmed and not ready, and only a human action confirms it',
        status: 'PASS',
        detail: `provider requests = ${provider.requestCount()}; AI rule keys = ${shape.aiRuleKeys.join(', ')}; closing date ${closing.state}/${closing.suggestedBy} with readiness blocked; after the human chose the suggested value: closingDate=${decidedTender.closingDate}, state=${decidedTender.intakeVerification.fields.closingDate.state}, suggestedBy=${decidedTender.intakeVerification.fields.closingDate.suggestedBy}`,
        evidence: {
          userDataDir,
          providerOrigin: provider.origin,
          providerRequests: provider.requestCount(),
          requestPath: request.path,
          requestModel: request.body?.model,
          parserRuleKeys: shape.parserRuleKeys,
          aiRuleKeys: shape.aiRuleKeys,
          closingField: closing,
          fieldStates: shape.fieldStates,
          aiMarkedPaths: shape.aiMarked.map((marked) => marked.path),
          readiness,
          afterHumanConfirmation: {
            closingDate: decidedTender.closingDate,
            state: decidedTender.intakeVerification.fields.closingDate.state,
            suggestedBy: decidedTender.intakeVerification.fields.closingDate.suggestedBy,
            aiMarkedPaths: tenderShape(decidedTender).aiMarked.map((marked) => marked.path),
          },
        },
        screenshots,
        videos: videos.filter(Boolean),
      })
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-ai-extraction-j2').catch(() => undefined)
      await provider.close().catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  /**
   * A provider that is down (HTTP 500) and a provider that answers with prose
   * instead of the JSON it was asked for must both degrade to the local
   * extraction: nothing added, nothing relabelled, nothing ready, tender usable.
   */
  test('3: a failing or malformed model reply degrades to the local extraction', async () => {
    const userDataDir = await scratchUserData()
    const screenshots: string[] = []
    const videos: string[] = []
    const provider = await startFakeProvider({ mode: 'http-500' })
    let run: LaunchedApp | undefined
    try {
      await writeAiSettings(userDataDir, provider.origin)
      const fixtureOne = join(userDataDir, 'ai-fail-500.pdf')
      const fixtureTwo = join(userDataDir, 'ai-fail-malformed.pdf')
      await generateTenderPdf(fixtureOne, tenderLines(TENDER_REF))
      await generateTenderPdf(fixtureTwo, tenderLines(TENDER_REF_TWO))

      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-ai-extraction-j3',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)
      await createCompany(tenders, COMPANY_NAME)
      await openTenderList(tenders)

      await expect(aiToggle(tenders)).toBeVisible({ timeout: 20_000 })
      await aiToggle(tenders).check()

      // ── (a) the provider answers 500 ───────────────────────────────────────
      await importTender(tenders, fixtureOne)
      await expect.poll(() => provider.requestCount(), { timeout: 60_000 }).toBeGreaterThan(0)
      const afterFiveHundred = await pollStore(
        userDataDir,
        (s) => Boolean(findTenderByReference(s, TENDER_REF)),
        STORE_IMPORT_POLL_MS,
      )
      const failedTender = findTenderByReference(afterFiveHundred, TENDER_REF)
      expect(failedTender, 'a failed model call must not lose the tender').toBeTruthy()
      const failedShape = tenderShape(failedTender)
      expectParserRequirements(failedShape, 'HTTP 500')
      expect(failedShape.aiRuleKeys, 'a failed call adds no requirement').toEqual([])
      expect(failedShape.aiMarked, 'a failed call writes no AI provenance anywhere').toEqual([])
      expect(
        failedTender.intakeVerification.fields.closingDate.state,
        'a failed call leaves the review untouched',
      ).toBe('unconfirmed')
      expect(failedTender.intakeVerification.fields.closingDate.extractedValue).toBeNull()
      expect(failedTender.intakeVerification.fields.closingDate.suggestedBy).toBeUndefined()
      // Usable: the matrix is on screen with the parser's own rows.
      await expect(tenders.getByRole('heading', { name: 'Compliance matrix' })).toBeVisible()
      screenshots.push(await shot(tenders, 'ai-j3-http-500-local-intact'))

      const blockedAfterFailure = await readinessState(tenders)
      expect(blockedAfterFailure.ready).toBe(false)
      expect(blockedAfterFailure.intakeBlocked).toBe(true)
      expect(blockedAfterFailure.buttonDisabled).toBe(true)

      // ── (b) the provider answers 200 with prose, not JSON ──────────────────
      provider.setMode('malformed')
      const requestsBefore = provider.requestCount()
      await importTender(tenders, fixtureTwo)
      await expect
        .poll(() => provider.requestCount(), { timeout: 60_000 })
        .toBeGreaterThan(requestsBefore)
      const afterMalformed = await pollStore(
        userDataDir,
        (s) => Boolean(findTenderByReference(s, TENDER_REF_TWO)),
        STORE_IMPORT_POLL_MS,
      )
      const malformedTender = findTenderByReference(afterMalformed, TENDER_REF_TWO)
      expect(malformedTender, 'an unreadable reply must not lose the tender').toBeTruthy()
      const malformedShape = tenderShape(malformedTender)
      expectParserRequirements(malformedShape, 'malformed reply')
      expect(
        malformedShape.parserRuleKeys.sort(),
        'a failed or unreadable model call leaves the local extraction exactly as it was',
      ).toEqual(failedShape.parserRuleKeys.sort())
      expect(malformedShape.aiRuleKeys, 'an unreadable reply adds no requirement').toEqual([])
      expect(malformedShape.aiMarked, 'an unreadable reply writes no AI provenance').toEqual([])
      expect(malformedTender.intakeVerification.fields.closingDate.state).toBe('unconfirmed')
      expect(malformedTender.intakeVerification.fields.closingDate.extractedValue).toBeNull()
      expect(malformedTender.intakeVerification.fields.referenceNumber.extractedValue).toBe(
        TENDER_REF_TWO,
      )
      await expect(tenders.getByRole('heading', { name: 'Compliance matrix' })).toBeVisible()
      screenshots.push(await shot(tenders, 'ai-j3-malformed-local-intact'))

      const blockedAfterMalformed = await readinessState(tenders)
      expect(blockedAfterMalformed.ready).toBe(false)
      expect(blockedAfterMalformed.intakeBlocked).toBe(true)
      expect(blockedAfterMalformed.buttonDisabled).toBe(true)

      await writeResult('tenders-ai-extraction-journey-3', {
        journey: 'HTTP 500 and a malformed reply both degrade to the local extraction',
        status: 'PASS',
        detail: `provider requests = ${provider.requestCount()}; both tenders kept the parser\u2019s own requirements (${PARSER_RULE_KEYS.join(
          ' + ',
        )} among them), no AI provenance, readiness blocked`,
        evidence: {
          userDataDir,
          providerOrigin: provider.origin,
          providerRequests: provider.requestCount(),
          fiveHundred: {
            reference: TENDER_REF,
            parserRuleKeys: failedShape.parserRuleKeys,
            aiMarked: failedShape.aiMarked,
            closingField: failedTender.intakeVerification.fields.closingDate,
            readiness: blockedAfterFailure,
          },
          malformed: {
            reference: TENDER_REF_TWO,
            parserRuleKeys: malformedShape.parserRuleKeys,
            aiMarked: malformedShape.aiMarked,
            closingField: malformedTender.intakeVerification.fields.closingDate,
            readiness: blockedAfterMalformed,
          },
        },
        screenshots,
        videos: videos.filter(Boolean),
      })
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-ai-extraction-j3').catch(() => undefined)
      await provider.close().catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  /**
   * A model that never answers must not delay, block or corrupt anything, and an
   * interruption mid-run must leave a tender the user can keep working with.
   *
   * The fake provider holds the response open, so the run is genuinely in flight
   * for the whole journey; the app is then quit mid-flight and restarted. The
   * workspace does put "Cancel AI extraction" on screen here (see the file
   * header), but this journey stops the run the hard way on purpose: a process
   * exit is a stronger interruption than a click, and what it proves about the
   * tender is read from the authoritative document either way.
   */
  test('4: a run interrupted mid-flight leaves a usable tender and writes nothing', async () => {
    const userDataDir = await scratchUserData()
    const screenshots: string[] = []
    const videos: string[] = []
    const provider = await startFakeProvider({ mode: 'hold', holdMs: 120_000 })
    let run1: LaunchedApp | undefined
    let run2: LaunchedApp | undefined
    try {
      await writeAiSettings(userDataDir, provider.origin)
      const fixture = join(userDataDir, 'ai-hold.pdf')
      await generateTenderPdf(fixture, tenderLines(TENDER_REF))

      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-ai-extraction-j4-run1',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)
      await dismissTendersOnboarding(tenders)
      await createCompany(tenders, COMPANY_NAME)
      await openTenderList(tenders)
      await expect(aiToggle(tenders)).toBeVisible({ timeout: 20_000 })
      await aiToggle(tenders).check()

      const importStartedAt = Date.now()
      await importTender(tenders, fixture)

      // The run really is in flight: the provider has the request and is holding
      // the reply open, so it cannot possibly have answered yet.
      await expect.poll(() => provider.requestCount(), { timeout: 60_000 }).toBeGreaterThan(0)
      const committed = await pollStore(
        userDataDir,
        (s) => Boolean(findTenderByReference(s, TENDER_REF)),
        STORE_IMPORT_POLL_MS,
      )
      const tender = findTenderByReference(committed, TENDER_REF)
      expect(
        tender,
        'the local result must be committed while the model is still working',
      ).toBeTruthy()
      const inFlightShape = tenderShape(tender)
      expectParserRequirements(inFlightShape, 'in flight')
      expect(inFlightShape.aiMarked, 'an unfinished run has written nothing').toEqual([])
      const commitMs = Date.now() - importStartedAt
      screenshots.push(await shot(tenders, 'ai-j4-in-flight-local-committed'))

      // Usable while the run is in flight: the matrix is there and the review opens.
      await expect(tenders.getByRole('heading', { name: 'Compliance matrix' })).toBeVisible()
      await openReview(tenders)
      await expect(fieldGroup(tenders, CLOSING_FIELD_LABEL)).toBeVisible()
      await expect(
        fieldGroup(tenders, CLOSING_FIELD_LABEL).getByRole('textbox'),
        'nothing the model has not finished saying may reach the review',
      ).toHaveValue('')

      // Interrupt mid-flight: quit, then come back to the same profile.
      videos.push((await closeAndSaveVideo(run1, 'tenders-ai-extraction-j4-run1')) ?? '')
      run1 = undefined

      const afterInterrupt = await readStore(userDataDir)
      const interrupted = findTenderByReference(afterInterrupt, TENDER_REF)
      expect(interrupted, 'the tender survives the interrupted run').toBeTruthy()
      expect(tenderShape(interrupted).aiMarked).toEqual([])

      run2 = await launchShell({
        userDataDir,
        videoDir: 'tenders-ai-extraction-j4-run2',
      })
      const tenders2 = await openTendersFromNav(run2.app, run2.page)
      await dismissTendersOnboarding(tenders2)
      await openTenderWorkspace(tenders2, TENDER_REF)
      const restored = await readStore(userDataDir)
      const restoredTender = findTenderByReference(restored, TENDER_REF)
      const restoredShape = tenderShape(restoredTender)
      expectParserRequirements(restoredShape, 'after the interruption')
      expect(restoredShape.aiMarked, 'the interrupted run left no AI provenance').toEqual([])
      await openReview(tenders2)
      await expect(fieldGroup(tenders2, CLOSING_FIELD_LABEL)).toBeVisible()
      screenshots.push(await shot(tenders2, 'ai-j4-after-interrupt'))

      const readiness = await readinessState(tenders2)
      expect(readiness.ready).toBe(false)
      expect(readiness.intakeBlocked).toBe(true)

      await writeResult('tenders-ai-extraction-journey-4', {
        journey: 'an AI run interrupted mid-flight leaves a usable tender',
        status: 'PASS',
        detail: `local result committed ${commitMs} ms after import while the provider held the reply open; provider requests = ${provider.requestCount()}; tender intact after interruption with no AI provenance`,
        evidence: {
          userDataDir,
          providerOrigin: provider.origin,
          providerRequests: provider.requestCount(),
          commitMs,
          parserRuleKeys: restoredShape.parserRuleKeys,
          aiMarked: restoredShape.aiMarked,
          readiness,
        },
        screenshots,
        videos: videos.filter(Boolean),
      })
    } finally {
      if (run1)
        await closeAndSaveVideo(run1, 'tenders-ai-extraction-j4-run1').catch(() => undefined)
      if (run2)
        await closeAndSaveVideo(run2, 'tenders-ai-extraction-j4-run2').catch(() => undefined)
      await provider.close().catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
