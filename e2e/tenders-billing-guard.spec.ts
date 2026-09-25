/**
 * Phase 4 post-remediation — focused billing-guard check (Wave 3 follow-up).
 *
 * The inline "Bill Milestone in Zano Books" button (Workspace milestones
 * section) and the MilestonesDrawer share one billing handler
 * (`runMilestoneBilling`). This spec covers the parts the other suites do not:
 *
 *   1. a NON-won tender exposes no billing affordance at all (no inline
 *      milestones section, no inline bill button, no Milestones toolbar);
 *   2. a won tender exposes the inline affordance and an attempt is never
 *      silent — it surfaces either a success banner or a visible error (with
 *      "Retry billing" when the error is retryable), and the on-disk milestone
 *      status matches whatever the UI claimed;
 *   3. the real IPC handlers reject billing for a non-won tender and for a
 *      demo-workspace tender with TYPED errors and no side effect (no Books
 *      write, no tender mutation), and CRM sync from the demo workspace is
 *      rejected before any write.
 *
 * Fixture: a hand-seeded, schema-valid v2 `tenders-data.json` (data seeding via
 * the authoritative store path — no application source changes). The document
 * carries a user workspace with one non-won + one won tender (both with a
 * REACHED milestone) and a demo workspace with a won tender.
 *
 * Scratch `userData` under `%LOCALAPPDATA%\Temp\opencode`; cleaned in `finally`.
 */
import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
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

const LOADED_AT = '2026-09-01T08:00:00.000Z'
const OWNER_NAME = 'E2E Billing Owner Civils (Pty) Ltd'
const REF_NONWON = 'E2E/BILL/2026/01'
const REF_WON = 'E2E/BILL/2026/02'
const REF_DEMO = 'E2E/BILL/2026/03'
const TENDER_NONWON = 't-bill-nonwon'
const TENDER_WON = 't-bill-won'
const TENDER_DEMO = 't-bill-demo'
const MS_NONWON = 'ms-nonwon-1'
const MS_WON = 'ms-won-1'
const MS_DEMO = 'ms-demo-1'

// ── seeded store fixture ──────────────────────────────────────────────────────

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
    description: 'E2E billing fixture company.',
    address: '1 Test Road, Test City',
    phone: '+27 10 000 0000',
    email: 'billing@example.test',
    website: 'https://example.test',
    directors: [],
    projects: [],
  }
}

function reachedMilestone(id: string, amount: number): Record<string, unknown> {
  return {
    id,
    name: `E2E Milestone ${id}`,
    amount,
    status: 'REACHED',
    dueDate: '2026-10-01',
  }
}

function seededTender(
  id: string,
  reference: string,
  status: string,
  milestoneId: string,
  amount: number,
): Record<string, unknown> {
  return {
    id,
    title: `E2E Billing Tender ${reference}`,
    referenceNumber: reference,
    issuingBody: 'E2E Water Authority',
    closingDate: null,
    submissionMethod: null,
    submissionAddress: null,
    signatureChecks: {},
    status,
    createdAt: LOADED_AT,
    fileName: 'e2e-billing.pdf',
    fileUrl: '',
    numPages: 1,
    ocrPages: 0,
    requirements: [],
    milestones: [reachedMilestone(milestoneId, amount)],
  }
}

function seededDocument(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    revision: 1,
    updatedAt: LOADED_AT,
    activeCompanyId: 'co-bill-owner',
    workspaces: [
      {
        id: 'co-bill-owner',
        name: OWNER_NAME,
        dataOrigin: 'user',
        company: companyProfile(OWNER_NAME),
        customers: [],
        vault: [],
        tenders: [
          seededTender(TENDER_NONWON, REF_NONWON, 'IN_PROGRESS', MS_NONWON, 1000),
          seededTender(TENDER_WON, REF_WON, 'WON', MS_WON, 2500),
        ],
      },
      {
        id: 'co-bill-demo',
        name: 'Sample workspace',
        dataOrigin: 'demo',
        company: companyProfile('E2E Sample Workspace Co'),
        customers: [],
        vault: [],
        tenders: [seededTender(TENDER_DEMO, REF_DEMO, 'WON', MS_DEMO, 500)],
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

async function fileSignature(path: string): Promise<string> {
  try {
    const s = await stat(path)
    return `${s.size}:${Math.round(s.mtimeMs)}`
  } catch {
    return 'missing'
  }
}

/** Observable stability window (no raw sleep) — "no side effect" evidence. */
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

// ── UI helpers ────────────────────────────────────────────────────────────────

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
 * Open the named tender's workspace deterministically. The helper can be called
 * from any page (the app's default page is `overview`, and the conflict journey
 * calls it from another tender's workspace), so it first moves the module to its
 * Tenders page through the sidebar nav, then either accepts the already-open
 * workspace for that reference or opens the tender's card from the list.
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

// ── tests ─────────────────────────────────────────────────────────────────────

test.describe('Tenders billing guards (Phase 4 follow-up)', () => {
  test.describe.configure({ timeout: 600_000 })

  test('1: a non-won tender exposes no billing affordance; a won tender exposes the inline path', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      await writeSeededStore(userDataDir)
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-billing-j1',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)

      // Non-won tender: no inline milestones section, no bill button, no toolbar.
      await openTender(tenders, REF_NONWON)
      await expect(tenders.getByText('Contract Delivery Milestones')).toHaveCount(0)
      await expect(
        tenders.getByRole('button', { name: 'Bill Milestone in Zano Books' }),
      ).toHaveCount(0)
      expect(
        await tenders.getByRole('button', { name: /^Milestones/ }).count(),
        'non-won tender must not expose the Milestones toolbar',
      ).toBe(0)
      screenshots.push(await shot(tenders, 'billing-j1-nonwon-no-affordance'))

      // Won tender: the inline path is present.
      await openTender(tenders, REF_WON)
      await expect(tenders.getByText('Contract Delivery Milestones')).toBeVisible({
        timeout: 20_000,
      })
      await expect(
        tenders.getByRole('button', { name: 'Bill Milestone in Zano Books' }),
      ).toBeVisible()
      expect(
        await tenders.getByRole('button', { name: /^Milestones/ }).count(),
        'won tender must expose the Milestones toolbar',
      ).toBe(1)
      screenshots.push(await shot(tenders, 'billing-j1-won-exposes-affordance'))

      const result: JourneyResult = {
        journey: '1: billing affordance gated on won',
        status: 'PASS',
        detail: `${REF_NONWON} hides all billing affordances; ${REF_WON} exposes the inline bill button + toolbar`,
        evidence: { userDataDir },
        screenshots,
      }
      await writeResult('tenders-billing-journey-1', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-billing-j1').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('2: an inline billing attempt is never silent and the disk matches the claim', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      await writeSeededStore(userDataDir)
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-billing-j2',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)
      await openTender(tenders, REF_WON)

      const billButton = tenders.getByRole('button', { name: 'Bill Milestone in Zano Books' })
      await expect(billButton).toBeVisible({ timeout: 20_000 })
      await billButton.click()

      // A banner must appear: either success or a visible error. Never silence.
      const banner = tenders
        .getByRole('alert')
        .filter({ hasText: /Zano Books|invoice|milestone|billing|configured|unavailable/i })
        .first()
      await expect(banner).toBeVisible({ timeout: 30_000 })
      const bannerText = (await banner.innerText()).replace(/\s+/g, ' ').trim()
      const claimedSuccess = /successfully created|reconciled to existing/i.test(bannerText)
      const retryBilling = tenders.getByRole('button', { name: 'Retry billing' })
      const retryPresent = (await retryBilling.count()) > 0

      // The on-disk milestone must match whatever the UI claimed.
      let milestone: any
      if (claimedSuccess) {
        const committed = await pollStore(
          userDataDir,
          (s) => findTender(s, REF_WON)?.milestones?.[0]?.status === 'BILLED',
          STORE_IMPORT_POLL_MS,
        )
        milestone = findTender(committed, REF_WON)?.milestones?.[0]
        expect(milestone?.status, 'a success banner requires a BILLED milestone on disk').toBe(
          'BILLED',
        )
      } else {
        // A rejected attempt must not mutate the document at all.
        await expectFileStable(storeFile(userDataDir))
        const current = await readStore(userDataDir)
        milestone = findTender(current, REF_WON)?.milestones?.[0]
        expect(milestone?.status, 'a failed attempt must not mark the milestone BILLED').toBe(
          'REACHED',
        )
      }
      screenshots.push(await shot(tenders, 'billing-j2-feedback'))

      // Retry (when offered) must also surface a banner — still never silent.
      if (retryPresent) {
        await retryBilling.first().click()
        await expect(banner).toBeVisible({ timeout: 30_000 })
        const retryText = (await banner.innerText()).replace(/\s+/g, ' ').trim()
        expect(retryText.length, 'the retry banner must carry a message').toBeGreaterThan(0)
        const retrySuccess = /successfully created|reconciled to existing/i.test(retryText)
        if (retrySuccess) {
          const committed = await pollStore(
            userDataDir,
            (s) => findTender(s, REF_WON)?.milestones?.[0]?.status === 'BILLED',
            STORE_IMPORT_POLL_MS,
          )
          expect(findTender(committed, REF_WON)?.milestones?.[0]?.status).toBe('BILLED')
        } else {
          await expectFileStable(storeFile(userDataDir))
          const current = await readStore(userDataDir)
          expect(findTender(current, REF_WON)?.milestones?.[0]?.status).toBe('REACHED')
        }
      }

      // The banner is dismissible.
      const dismiss = tenders.getByRole('button', { name: 'Dismiss billing message' })
      if ((await dismiss.count()) > 0) {
        await dismiss.first().click()
        await expect(banner).toBeHidden({ timeout: 10_000 })
      }

      const result: JourneyResult = {
        journey: '2: inline billing never silent + disk matches the claim',
        status: 'PASS',
        detail: `banner="${bannerText}"; retryOffered=${retryPresent}; milestone=${milestone.status}`,
        evidence: {
          userDataDir,
          bannerText,
          claimedSuccess,
          retryPresent,
          milestoneOnDisk: milestone,
        },
        screenshots,
      }
      await writeResult('tenders-billing-journey-2', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-billing-j2').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('3: main rejects non-won and demo billing with typed errors and no side effect', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      await writeSeededStore(userDataDir)
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-billing-j3',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)

      const booksPath = join(userDataDir, 'books', 'books-data.json')
      const dealsPath = join(userDataDir, 'crm', 'deals.json')
      const booksBefore = await fileSignature(booksPath)
      const dealsBefore = await fileSignature(dealsPath)
      expect(booksBefore, 'no Books data before the guarded calls').toBe('missing')
      expect(dealsBefore, 'no CRM data before the guarded calls').toBe('missing')

      // Every call goes through the REAL gated IPC handlers.
      const probe = await tenders.evaluate(async () => {
        const api = (window as any).tendersApi
        const result: Record<string, unknown> = {}
        try {
          result.nonWon = await api.billMilestoneInBooks('t-bill-nonwon', 'ms-nonwon-1')
        } catch (error) {
          result.nonWon = { threw: String(error) }
        }
        try {
          result.demo = await api.billMilestoneInBooks('t-bill-demo', 'ms-demo-1')
        } catch (error) {
          result.demo = { threw: String(error) }
        }
        try {
          result.demoCrm = await api.syncWithCrm({ tenderId: 't-bill-demo' })
        } catch (error) {
          result.demoCrm = { threw: String(error) }
        }
        return result
      })

      const nonWon = probe.nonWon as { ok?: boolean; error?: string }
      const demo = probe.demo as { ok?: boolean; error?: string }
      const demoCrm = probe.demoCrm as { ok?: boolean; error?: string }
      expect(nonWon?.ok, 'non-won billing must be rejected').toBe(false)
      expect(String(nonWon?.error), 'typed won-only error').toMatch(
        /only allowed for a won tender/i,
      )
      expect(demo?.ok, 'demo-workspace billing must be rejected').toBe(false)
      expect(String(demo?.error), 'typed demo-isolation error').toMatch(/demo workspace/i)
      expect(demoCrm?.ok ?? false, 'demo-workspace CRM sync must be rejected').toBe(false)
      expect(String(demoCrm?.error), 'typed demo-isolation error').toMatch(/demo workspace/i)

      // No side effects: no Books/CRM writes and no tender mutation on disk.
      await expectFileStable(booksPath)
      await expectFileStable(dealsPath)
      const store = await readStore(userDataDir)
      expect(
        findTender(store, REF_NONWON)?.milestones?.[0]?.status,
        'non-won milestone untouched',
      ).toBe('REACHED')
      expect(findTender(store, REF_DEMO)?.milestones?.[0]?.status, 'demo milestone untouched').toBe(
        'REACHED',
      )
      expect(await fileSignature(booksPath), 'no Books file was created').toBe(booksBefore)
      expect(await fileSignature(dealsPath), 'no CRM file was created').toBe(dealsBefore)
      screenshots.push(await shot(tenders, 'billing-j3-typed-guards'))

      const result: JourneyResult = {
        journey: '3: main-side won-only + demo-isolation typed rejects, no side effects',
        status: 'PASS',
        detail: `nonWon="${nonWon.error}"; demo="${demo.error}"; demoCrm="${demoCrm.error}"; no Books/CRM writes`,
        evidence: { userDataDir, probe },
        screenshots,
      }
      await writeResult('tenders-billing-journey-3', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-billing-j3').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
