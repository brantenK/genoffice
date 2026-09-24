/**
 * The "Find tenders" pane, end to end — the user-facing half of tender discovery.
 *
 * The engines and the IPC transport for discovery were already built and tested
 * on their own. What this journey proves is that a user can actually reach them,
 * and that the pane tells the truth while they do:
 *
 *   1. the pane lists real opportunities out of the saved list, with the buyer,
 *      the closing countdown, the category, the value and the province the
 *      SOURCE stated — and with a relevance score that explains which profile
 *      term matched where;
 *   2. the limits are on screen, verbatim from `describeCoverage()`: the feed is
 *      Treasury's public beta, municipalities and state-owned enterprises appear
 *      only when they volunteer data, and Treasury says the feed must not be used
 *      for critical decision making or legal purposes;
 *   3. a listing whose source stated no closing date is FLAGGED as such and is
 *      given no countdown — no invented deadline;
 *   4. the saved list works with no network connection and says when it was
 *      fetched and that it is stale;
 *   5. a saved list that cannot be read reports the failure with a retry, and
 *      never renders as an empty list that would look like "nothing matched";
 *   6. the filters are seeded from the company profile (province and relevance
 *      terms) and nothing is hidden silently — every filtered-out listing is
 *      listed with the reason;
 *   7. "Add to workspace" refuses a document link the app is not allowed to read,
 *      with the engine's own words, and creates no tender.
 *
 * No network, and no fake feed server: the discovery client validates every URL
 * against a fixed allow-list of Treasury hosts before it requests anything, so
 * the built shell cannot be pointed at a local server (see
 * `tenders-discovery-fixtures.ts` for the full reasoning). The saved list is the
 * offline half of the feature and it is a file, so the journey writes that file
 * into the scratch profile and drives the real pane over it.
 *
 * The one document action taken here is the refusal path: the fixture links a
 * document on a host outside the allow-list, so the download is refused BEFORE
 * any request and the pane's honest failure surface is exercised with nothing
 * fetched. The successful download + intake path is proven where it can be
 * observed deterministically: `tests/discovery-pane.test.ts` runs the real
 * intake over a real .docx, and `e2e/tenders-docx-intake.spec.ts` proves that
 * intake persists to the authoritative store.
 */
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  launchShell,
  closeAndSaveVideo,
  waitForPageWithUrl,
  screenshotPath,
  type LaunchedApp,
} from './helpers'
import { DISCOVERY_CACHE_MAX_AGE_MS, describeCoverage } from '../apps/tenders/src/shared/discovery'
import { formatRandAmount } from '../apps/tenders/src/shared/money'
import {
  allowListRefusalText,
  DAMAGED_CACHE_TEXT,
  DISCOVERY_COMPANY,
  DISCOVERY_COMPANY_ADDRESS,
  DISCOVERY_COMPANY_INDUSTRY,
  DISCOVERY_PROFILE_KEYWORDS,
  DISCOVERY_PROFILE_PROVINCE,
  LISTING_NO_DOCUMENTS,
  LISTING_OTHER_PROVINCE,
  LISTING_WITH_CLOSING,
  LISTING_WITH_CLOSING_VALUE,
  LISTING_WITHOUT_CLOSING,
  writeDamagedDiscoveryCache,
  writeDiscoveryCache,
} from './tenders-discovery-fixtures'

/** `%LOCALAPPDATA%\Temp\opencode` on Windows (os.tmpdir() is %TEMP%). */
const SCRATCH_ROOT = join(tmpdir(), 'opencode')

/** The freshness window, in the words the pane prints it with. */
const FRESHNESS_HOURS = Math.round(DISCOVERY_CACHE_MAX_AGE_MS / 3_600_000)

// ── scratch + store helpers ──────────────────────────────────────────────────

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

function activeWorkspace(store: any): any | undefined {
  return (store?.workspaces ?? []).find((ws: any) => ws.id === store?.activeCompanyId)
}

// ── shell + UI helpers ───────────────────────────────────────────────────────

async function openTendersFromNav(app: LaunchedApp['app'], shell: Page): Promise<Page> {
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

async function gotoPage(tenders: Page, label: string): Promise<void> {
  await tenders.locator('nav').getByRole('button', { name: label }).click()
}

/**
 * Create the company the discovery filter is seeded from. The industry and the
 * address are what `deriveDiscoveryFilter` turns into relevance terms and a
 * province, so both are filled here rather than left at their defaults.
 */
async function createCompanyViaFirstUse(tenders: Page): Promise<void> {
  await expect(tenders.getByRole('heading', { name: 'No company workspaces yet' })).toBeVisible({
    timeout: 20_000,
  })
  await tenders.getByRole('button', { name: 'Create company workspace' }).click()
  const dialog = tenders.getByRole('dialog', { name: 'Set up your company' })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await dialog.getByLabel('Trading name').fill(DISCOVERY_COMPANY)
  await dialog.getByLabel('Industry / sector').fill(DISCOVERY_COMPANY_INDUSTRY)
  await dialog.getByLabel('Physical / postal address').fill(DISCOVERY_COMPANY_ADDRESS)
  await dialog.getByRole('button', { name: 'Create workspace' }).click()
  await expect(tenders.getByText(DISCOVERY_COMPANY).first()).toBeVisible({ timeout: 15_000 })
  await dismissTendersOnboarding(tenders)
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

/** Open the pane and wait for its first read of the saved list to settle. */
async function openDiscoverPane(tenders: Page): Promise<void> {
  await gotoPage(tenders, 'Discover')
  await expect(tenders.getByRole('heading', { name: 'Find tenders', level: 1 })).toBeVisible({
    timeout: 20_000,
  })
  // The coverage statement is rendered in every state, so it is the one thing
  // that is always there to wait for.
  await expect(tenders.locator('[data-testid="discovery-coverage"]')).toBeVisible({
    timeout: 20_000,
  })
}

// ── journeys ─────────────────────────────────────────────────────────────────

test.describe('Tenders discovery pane', () => {
  test.describe.configure({ timeout: 600_000 })

  test('1: the saved list, its limits, its filters and a refused document download', async () => {
    const screenshots: string[] = []
    let run1: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      await writeDiscoveryCache(userDataDir)

      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-discovery-run1',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)
      await createCompanyViaFirstUse(tenders)
      await openDiscoverPane(tenders)

      // (2) The limits, verbatim from the statement the core owns — including
      // every limit, not a summary of them.
      const coverage = describeCoverage()
      const coverageBlock = tenders.locator('[data-testid="discovery-coverage"]')
      await expect(coverageBlock).toContainText(coverage.summary)
      for (const point of coverage.points) {
        await expect(coverageBlock, `the pane must show: ${point}`).toContainText(point)
      }
      for (const badge of coverage.badges) {
        await expect(coverageBlock).toContainText(badge)
      }
      screenshots.push(await shot(tenders, 'discovery-coverage-and-list'))

      // (4) The saved list works offline and says how old it is. The fixture
      // fetched it 20 hours ago, so the stale sentence is the honest one.
      const status = tenders.locator('[data-testid="discovery-status"]')
      await expect(status).toContainText('Saved ')
      await expect(status).toContainText(
        `older than the ${FRESHNESS_HOURS}-hour freshness window this app keeps`,
      )

      // (1) Three listings are shown. The fourth is in Gauteng, and the profile's
      // address put Western Cape in the province filter — so it is hidden, and
      // it must be listed as hidden rather than dropped silently.
      const rows = tenders.locator('[data-testid="discovery-row"]')
      await expect(rows).toHaveCount(3, { timeout: 20_000 })
      await expect(tenders.getByText('3 of 4 shown')).toBeVisible()

      const closingRow = rows.filter({ hasText: LISTING_WITH_CLOSING })
      await expect(closingRow).toHaveCount(1)
      await expect(closingRow).toContainText('City of Cape Town')
      await expect(closingRow.locator('[data-testid="discovery-row-closing"]')).toContainText(
        /closes in /,
      )
      await expect(closingRow).toContainText('Goods')
      await expect(closingRow).toContainText(formatRandAmount(LISTING_WITH_CLOSING_VALUE))
      await expect(closingRow).toContainText(DISCOVERY_PROFILE_PROVINCE)
      await expect(closingRow).toContainText('Closing as the source stated it')

      // (1) The relevance indicator explains itself: the score, the terms that
      // matched, and where each one matched.
      const relevance = closingRow.locator('[data-testid="discovery-row-relevance"]')
      await expect(relevance).toContainText('75% relevant')
      await expect(relevance).toContainText('3 of 4 company profile terms matched')
      await expect(closingRow).toContainText('“water” in the title')

      // (3) No closing date stated by the source: flagged, with no countdown.
      const noClosingRow = rows.filter({ hasText: LISTING_WITHOUT_CLOSING })
      const closingFlag = noClosingRow.locator('[data-testid="discovery-closing-unknown"]')
      await expect(closingFlag).toBeVisible()
      await expect(closingFlag).toContainText('No closing date stated by the source')
      await expect(
        noClosingRow.locator('[data-testid="discovery-row-closing"]'),
        'a listing with no stated closing date must not be given one',
      ).toHaveCount(0)
      await expect(noClosingRow).toContainText('The source stated no closing date for this tender.')

      // A listing the source links no document for cannot be added — and says so.
      const noDocsRow = rows.filter({ hasText: LISTING_NO_DOCUMENTS })
      await expect(noDocsRow.locator('[data-testid="discovery-row-documents"]')).toContainText(
        'links no document',
      )
      await expect(noDocsRow.locator('[data-testid="discovery-add"]')).toHaveCount(0)

      // (6) Nothing is hidden silently.
      const hidden = tenders.locator('[data-testid="discovery-hidden"]')
      await expect(hidden).toContainText('1 saved listing hidden by your filters')
      await hidden.locator('summary').click()
      await expect(hidden).toContainText(LISTING_OTHER_PROVINCE)
      await expect(hidden).toContainText('outside the provinces you chose')

      // (6) The filters were seeded from the company profile.
      const filters = tenders.locator('[data-testid="discovery-filters"]')
      await expect(tenders.locator('[data-testid="discovery-province"]')).toHaveValue(
        DISCOVERY_PROFILE_PROVINCE,
      )
      await expect(tenders.locator('[data-testid="discovery-keywords"]')).toHaveValue(
        DISCOVERY_PROFILE_KEYWORDS.join(', '),
      )
      await expect(filters).toContainText('came from your company profile')

      // ...and they narrow the list for real.
      await tenders.locator('[data-testid="discovery-category"]').selectOption('works')
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).toContainText(LISTING_NO_DOCUMENTS)
      await tenders.locator('[data-testid="discovery-reset-filters"]').click()
      await expect(rows).toHaveCount(3)

      // (7) A document link outside the allow-list is refused before anything is
      // requested, and the pane shows the engine's own reason.
      await closingRow.locator('[data-testid="discovery-add"]').click()
      const notice = tenders.locator('[data-testid="discovery-notice"]')
      await expect(notice).toContainText('That document could not be downloaded.', {
        timeout: 30_000,
      })
      await expect(notice).toContainText(allowListRefusalText())
      await expect(
        tenders.getByRole('heading', { name: 'Find tenders', level: 1 }),
        'a refused download must leave the user on the pane',
      ).toBeVisible()
      const store = await readStore(userDataDir)
      expect(
        (activeWorkspace(store)?.tenders ?? []).length,
        'a refused download must not create a tender',
      ).toBe(0)
      screenshots.push(await shot(tenders, 'discovery-refused-download'))
    } finally {
      if (run1) await closeAndSaveVideo(run1, 'tenders-discovery-run1').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('2: a saved list that cannot be read reports the failure, never an empty list', async () => {
    const screenshots: string[] = []
    let run1: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      await writeDamagedDiscoveryCache(userDataDir)

      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-discovery-run2',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)
      await createCompanyViaFirstUse(tenders)
      await openDiscoverPane(tenders)

      // The failure is reported in the engine's own words, with a retry — and
      // the pane does NOT show the empty state, which would read as "nothing
      // matched your filters".
      const error = tenders.locator('[data-testid="discovery-error"]')
      await expect(error).toBeVisible({ timeout: 20_000 })
      await expect(error).toContainText(DAMAGED_CACHE_TEXT)
      await expect(
        tenders.locator('[data-testid="discovery-empty"]'),
        'a failed read must not render as an empty list',
      ).toHaveCount(0)
      await expect(tenders.locator('[data-testid="discovery-row"]')).toHaveCount(0)

      // The limits stay on screen in the failure state too.
      await expect(tenders.locator('[data-testid="discovery-coverage"]')).toBeVisible()
      screenshots.push(await shot(tenders, 'discovery-read-failure'))

      // Retrying reports the same honest failure again: the list is still
      // unreadable, so the pane must not quietly turn it into an empty one.
      await tenders.locator('[data-testid="discovery-retry"]').click()
      await expect(error).toBeVisible({ timeout: 20_000 })
      await expect(error).toContainText(DAMAGED_CACHE_TEXT)
      await expect(tenders.locator('[data-testid="discovery-empty"]')).toHaveCount(0)
    } finally {
      if (run1) await closeAndSaveVideo(run1, 'tenders-discovery-run2').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
