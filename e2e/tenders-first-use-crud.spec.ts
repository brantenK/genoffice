/**
 * Phase 4 / Wave 2 lane C - built-Electron journey for WP-8 first-use and
 * company/customer CRUD.
 *
 * Covers, against the built shell:
 *   1. a fresh profile presents the explicit first-use choice ("Set up company"
 *      vs "Explore sample workspace") and never seeds records;
 *   2. company create -> edit -> archive -> restore persists across restart;
 *   3. customer create -> edit -> archive -> restore (including required-document
 *      definitions) persists across restart;
 *   4. contextual empty states / quick actions are present, and the destructive
 *      hard-delete path is explained in plain language instead of being rendered
 *      as a permanently-disabled button;
 *   5. a tender opens with Tab + Enter and Tab + Space alone (keyboard-only).
 *
 * Assertions read observable UI state and the on-disk `tenders-data.json`.
 * Scratch `userData` under `%LOCALAPPDATA%\Temp\opencode`; no app-source edits.
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

/** `%LOCALAPPDATA%\Temp\opencode` on Windows (os.tmpdir() is %TEMP%). */
const SCRATCH_ROOT = join(tmpdir(), 'opencode')

/** The shipped sample RFP, imported through the file input (no network fetch). */
const SAMPLE_RFP = resolve(SHELL_DIR, '..', 'tenders', 'public', 'demo', 'sample-rfp.pdf')

const COMPANY_ONE = 'E2E First Use Civils (Pty) Ltd'
const COMPANY_ONE_EDITED = 'E2E First Use Civils (Pty) Ltd (edited)'
const COMPANY_INDUSTRY = 'Water infrastructure'
const CUSTOMER_ONE = 'E2E Muni Buyer'
const CUSTOMER_ONE_EDITED = 'E2E Muni Buyer (edited)'
const CUSTOMER_REQUIRED_DOC = 'SARS Tax Clearance'
const CUSTOMER_REQUIRED_DOC_TWO = 'B-BBEE Affidavit'
const CUSTOMER_NOTES = 'E2E customer notes persisted across restart.'

// --- scratch + store helpers ---

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

async function storeSignature(userDataDir: string): Promise<string> {
  try {
    const s = await stat(storeFile(userDataDir))
    return `${s.size}:${Math.round(s.mtimeMs)}`
  } catch {
    return 'missing'
  }
}

/** Observable stability window (no raw sleep): the store settles before we read it. */
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

function activeWorkspace(store: any): any | undefined {
  return (store?.workspaces ?? []).find((ws: any) => ws.id === store?.activeCompanyId)
}

function findCustomer(store: any, name: string): any | undefined {
  for (const workspace of store?.workspaces ?? []) {
    for (const customer of workspace?.customers ?? []) {
      if (customer?.name === name) return customer
    }
  }
  return undefined
}

// --- shell + UI helpers ---

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

async function gotoPage(tenders: Page, label: string): Promise<void> {
  await tenders.locator('nav').getByRole('button', { name: label }).click()
}

async function createCompanyViaFirstUse(tenders: Page, name: string): Promise<void> {
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

async function shot(page: Page, name: string): Promise<string> {
  const target = screenshotPath(name)
  try {
    await page.screenshot({ path: target, timeout: 15_000 })
  } catch {
    // best-effort evidence
  }
  return target
}

/**
 * Tab forward from a neutral (blurred) focus point until the focused element is
 * inside a tender card. Returns false when the card is not reachable, so the
 * caller can fail with a readable message instead of a timeout.
 */
async function tabToTenderCard(tenders: Page, maxTabs = 40): Promise<number | null> {
  await tenders.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  for (let i = 1; i <= maxTabs; i += 1) {
    await tenders.keyboard.press('Tab')
    const inside = await tenders.evaluate(() =>
      Boolean(document.activeElement?.closest('[data-testid="tender-card"]')),
    )
    if (inside) return i
  }
  return null
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

// --- journeys ---

test.describe('Tenders first-use + company/customer CRUD (WP-8)', () => {
  test.describe.configure({ timeout: 600_000 })

  test('1: first-use choice, company create/edit/archive/restore survives restart', async () => {
    const screenshots: string[] = []
    let run1: LaunchedApp | undefined
    let run2: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-first-use-j1-run1',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)

      // (1) The first-use choice is presented, with both paths and honest copy.
      await expect(tenders.getByRole('heading', { name: 'No company workspaces yet' })).toBeVisible(
        {
          timeout: 20_000,
        },
      )
      await expect(tenders.getByRole('heading', { name: 'Set up company' })).toBeVisible()
      await expect(tenders.getByRole('button', { name: 'Create company workspace' })).toBeVisible()
      await expect(tenders.getByRole('heading', { name: 'Explore sample workspace' })).toBeVisible()
      await expect(tenders.getByRole('button', { name: 'Open sample workspace' })).toBeVisible()
      await expect(tenders.getByText(/local application store/)).toBeVisible()
      expect(await readStore(userDataDir), 'no store file before any choice').toBeNull()
      screenshots.push(await shot(tenders, 'firstuse-j1-choice'))

      // (2) Create the company with the full profile fields.
      await createCompanyViaFirstUse(tenders, COMPANY_ONE)
      const created = await pollStore(
        userDataDir,
        (s) => activeWorkspace(s)?.company?.tradingName === COMPANY_ONE,
      )
      expect(created, 'company committed to disk').toBeTruthy()
      expect(activeWorkspace(created).dataOrigin).toBe('user')

      // (4a) Contextual quick actions are present on the empty Overview.
      await gotoPage(tenders, 'Overview')
      await expect(tenders.getByRole('heading', { name: 'Quick actions' })).toBeVisible({
        timeout: 15_000,
      })
      for (const label of [
        'Add a customer',
        'Upload a document',
        'Shred a tender RFP',
        'Edit company profile',
      ]) {
        await expect(tenders.getByRole('button', { name: label })).toBeVisible()
      }
      await expect(tenders.getByText('Upload your first document')).toBeVisible()

      // (2) Edit the company profile.
      await gotoPage(tenders, 'Company Profile')
      await expect(tenders.getByRole('heading', { name: COMPANY_ONE })).toBeVisible({
        timeout: 15_000,
      })
      await tenders.getByRole('button', { name: 'Edit profile' }).click()
      const editDialog = tenders.getByRole('dialog', { name: 'Edit company profile' })
      await expect(editDialog).toBeVisible({ timeout: 15_000 })
      await editDialog.getByLabel('Trading name').fill(COMPANY_ONE_EDITED)
      await editDialog.getByLabel('Registered name').fill(COMPANY_ONE_EDITED)
      await editDialog.getByLabel('Industry / sector').fill(COMPANY_INDUSTRY)
      await editDialog.getByLabel('SARS tax / TCS PIN').fill('0123456789')
      await editDialog.getByRole('button', { name: 'Save changes' }).click()
      await expect(tenders.getByRole('heading', { name: COMPANY_ONE_EDITED })).toBeVisible({
        timeout: 15_000,
      })
      const edited = await pollStore(
        userDataDir,
        (s) =>
          activeWorkspace(s)?.company?.tradingName === COMPANY_ONE_EDITED &&
          activeWorkspace(s)?.company?.industry === COMPANY_INDUSTRY,
      )
      expect(edited, 'company edit committed to disk').toBeTruthy()

      // (2) Archive the workspace (soft archive, no destructive delete).
      await tenders.getByRole('button', { name: 'Archive this workspace' }).click()
      await expect(tenders.getByText(/^Archived/).first()).toBeVisible({
        timeout: 15_000,
      })
      await expect(tenders.getByRole('button', { name: 'Restore workspace' })).toBeVisible()

      // (4b) The destructive path is explained, not rendered as a dead control:
      // no permanently-disabled delete button, and the panel lists what the
      // workspace owns plus the archive/restore route that actually exists.
      await tenders.getByRole('button', { name: /^Delete this workspace/ }).click()
      await expect(tenders.getByText('Permanent deletion is not available yet')).toBeVisible()
      const deletePanel = tenders
        .locator('div')
        .filter({ hasText: 'Permanent deletion is not available yet' })
        .last()
      await expect(deletePanel.getByText(/tender/)).toBeVisible()
      await expect(deletePanel.getByText(/vault document/)).toBeVisible()
      await expect(deletePanel.getByText(/customer/)).toBeVisible()
      await expect(deletePanel.getByText(/project record/)).toBeVisible()
      await expect(
        tenders.getByRole('button', { name: 'Delete permanently' }),
        'a permanently-disabled delete control must not be rendered',
      ).toHaveCount(0)
      await expect(deletePanel.getByText(/no permanent workspace delete/i)).toBeVisible()
      await expect(
        deletePanel.getByRole('button', { name: /Archive this workspace|Restore workspace/ }),
      ).toBeVisible()
      screenshots.push(await shot(tenders, 'firstuse-j1-archive-and-guard'))
      await tenders.getByRole('button', { name: 'Keep this workspace' }).click()

      const archived = await pollStore(userDataDir, (s) =>
        Boolean(activeWorkspace(s)?.company?.archivedAt),
      )
      expect(archived, 'archive marker committed to disk').toBeTruthy()

      await closeAndSaveVideo(run1, 'tenders-first-use-j1-run1')
      run1 = undefined

      // (2) Restart: edit + archive state survive; restore works.
      run2 = await launchShell({
        userDataDir,
        videoDir: 'tenders-first-use-j1-run2',
      })
      const tenders2 = await openTendersFromNav(run2.app, run2.page)
      await dismissTendersOnboarding(tenders2)
      await gotoPage(tenders2, 'Company Profile')
      await expect(tenders2.getByRole('heading', { name: COMPANY_ONE_EDITED })).toBeVisible({
        timeout: 20_000,
      })
      await expect(tenders2.getByText('Archived', { exact: true }).first()).toBeVisible()
      await tenders2.getByRole('button', { name: 'Restore workspace' }).click()
      await expect(tenders2.getByRole('button', { name: 'Archive this workspace' })).toBeVisible({
        timeout: 15_000,
      })
      const restored = await pollStore(
        userDataDir,
        (s) =>
          activeWorkspace(s)?.company?.tradingName === COMPANY_ONE_EDITED &&
          !activeWorkspace(s)?.company?.archivedAt,
      )
      expect(restored, 'restore committed to disk').toBeTruthy()
      await expectStoreStable(userDataDir, await storeSignature(userDataDir))
      screenshots.push(await shot(tenders2, 'firstuse-j1-restart-restored'))

      const result: JourneyResult = {
        journey: '1: first-use + company create/edit/archive/restore across restart',
        status: 'PASS',
        detail: `${COMPANY_ONE} -> ${COMPANY_ONE_EDITED}; archived then restored; restart persisted`,
        evidence: {
          userDataDir,
          tradingName: activeWorkspace(restored).company.tradingName,
          industry: activeWorkspace(restored).company.industry,
          archivedAtAfterRestore: activeWorkspace(restored).company.archivedAt ?? null,
        },
        screenshots,
      }
      await writeResult('tenders-first-use-journey-1', result)
    } finally {
      if (run1) await closeAndSaveVideo(run1, 'tenders-first-use-j1-run1').catch(() => undefined)
      if (run2) await closeAndSaveVideo(run2, 'tenders-first-use-j1-run2').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('2: customer create/edit/archive/restore with required documents survives restart', async () => {
    const screenshots: string[] = []
    let run1: LaunchedApp | undefined
    let run2: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-first-use-j2-run1',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)
      await createCompanyViaFirstUse(tenders, COMPANY_ONE)

      // Contextual empty state + create with a required-document definition.
      await gotoPage(tenders, 'Customers')
      await expect(tenders.getByRole('heading', { name: 'No customers yet' })).toBeVisible({
        timeout: 15_000,
      })
      await tenders.getByRole('button', { name: 'Add your first customer' }).click()
      const createDialog = tenders.getByRole('dialog', { name: 'Add a customer' })
      await expect(createDialog).toBeVisible({ timeout: 15_000 })
      await createDialog.getByLabel('Customer name').fill(CUSTOMER_ONE)
      await createDialog.getByLabel('Industry / sector').fill('Local government')
      await createDialog.getByLabel('Name', { exact: true }).fill('Dineo Lethabo')
      await createDialog.getByLabel('E-mail').fill('scm@e2e-muni.example')
      await createDialog.getByRole('button', { name: 'Add document requirement' }).click()
      await createDialog.getByLabel('Document', { exact: true }).last().fill(CUSTOMER_REQUIRED_DOC)
      await createDialog.getByRole('button', { name: 'Add customer' }).click()
      // The landed UI opens the new customer's detail view on create.
      await expect(tenders.getByRole('heading', { name: CUSTOMER_ONE, level: 1 })).toBeVisible({
        timeout: 15_000,
      })
      await expect(tenders.getByText(/0\/1 ready/)).toBeVisible()
      await expect(tenders.getByText(CUSTOMER_REQUIRED_DOC)).toBeVisible()
      const created = await pollStore(userDataDir, (s) => Boolean(findCustomer(s, CUSTOMER_ONE)))
      const createdCustomer = findCustomer(created, CUSTOMER_ONE)
      expect(createdCustomer.requiredDocs).toHaveLength(1)
      expect(createdCustomer.requiredDocs[0].label).toBe(CUSTOMER_REQUIRED_DOC)
      screenshots.push(await shot(tenders, 'firstuse-j2-customer-created'))

      // Edit the customer + add a second required document.
      await expect(tenders.getByRole('button', { name: 'Edit customer' })).toBeVisible({
        timeout: 15_000,
      })
      await tenders.getByRole('button', { name: 'Edit customer' }).click()
      const editDialog = tenders.getByRole('dialog', { name: 'Edit customer' })
      await expect(editDialog).toBeVisible()
      await editDialog.getByLabel('Customer name').fill(CUSTOMER_ONE_EDITED)
      await editDialog
        .getByLabel('Anything worth remembering about this customer')
        .fill(CUSTOMER_NOTES)
      await editDialog.getByRole('button', { name: 'Add document requirement' }).click()
      await editDialog
        .getByLabel('Document', { exact: true })
        .last()
        .fill(CUSTOMER_REQUIRED_DOC_TWO)
      await editDialog.getByRole('button', { name: 'Save changes' }).click()
      await expect(tenders.getByRole('heading', { name: CUSTOMER_ONE_EDITED })).toBeVisible({
        timeout: 15_000,
      })
      await expect(tenders.getByText(/0\/2 ready/)).toBeVisible()
      await expect(tenders.getByText(CUSTOMER_REQUIRED_DOC_TWO)).toBeVisible()
      const edited = await pollStore(userDataDir, (s) =>
        Boolean(findCustomer(s, CUSTOMER_ONE_EDITED)),
      )
      const editedCustomer = findCustomer(edited, CUSTOMER_ONE_EDITED)
      expect(editedCustomer.requiredDocs).toHaveLength(2)
      expect(editedCustomer.notes).toBe(CUSTOMER_NOTES)

      // Archive (soft) with the destructive path disabled.
      await tenders.getByRole('button', { name: 'Archive', exact: true }).click()
      await expect(tenders.getByText(/^Archived/).first()).toBeVisible({
        timeout: 15_000,
      })
      await expect(tenders.getByRole('button', { name: 'Restore' })).toBeVisible()
      await tenders.getByRole('button', { name: /^Remove/ }).click()
      await expect(tenders.getByText('Removing a customer is not available yet')).toBeVisible()
      await expect(
        tenders.getByRole('button', { name: 'Delete permanently' }),
        'a permanently-disabled delete control must not be rendered',
      ).toHaveCount(0)
      await expect(tenders.getByText(/no permanent customer delete/i)).toBeVisible()
      await expect(tenders.getByText(/moved to Trash/)).toBeVisible()
      await expect(tenders.getByRole('button', { name: 'Restore customer' })).toBeVisible()
      screenshots.push(await shot(tenders, 'firstuse-j2-customer-archived-guard'))
      await tenders.getByRole('button', { name: 'Keep customer' }).click()
      const archived = await pollStore(userDataDir, (s) =>
        Boolean(findCustomer(s, CUSTOMER_ONE_EDITED)?.archivedAt),
      )
      expect(archived, 'customer archive marker committed').toBeTruthy()

      await closeAndSaveVideo(run1, 'tenders-first-use-j2-run1')
      run1 = undefined

      // Restart: archived customer + required docs survive; restore works.
      run2 = await launchShell({
        userDataDir,
        videoDir: 'tenders-first-use-j2-run2',
      })
      const tenders2 = await openTendersFromNav(run2.app, run2.page)
      await dismissTendersOnboarding(tenders2)
      await gotoPage(tenders2, 'Customers')
      await tenders2.getByRole('button', { name: /^Archived/ }).click()
      await tenders2.getByText(CUSTOMER_ONE_EDITED).first().click()
      await expect(tenders2.getByText(/^Archived/).first()).toBeVisible({
        timeout: 15_000,
      })
      await expect(tenders2.getByText(/0\/2 ready/)).toBeVisible()
      await expect(tenders2.getByText(CUSTOMER_NOTES)).toBeVisible()
      await tenders2.getByRole('button', { name: 'Restore' }).click()
      const restored = await pollStore(userDataDir, (s) => {
        const customer = findCustomer(s, CUSTOMER_ONE_EDITED)
        return Boolean(customer && !customer.archivedAt && customer.requiredDocs.length === 2)
      })
      expect(restored, 'restore + required docs committed').toBeTruthy()
      await expectStoreStable(userDataDir, await storeSignature(userDataDir))
      screenshots.push(await shot(tenders2, 'firstuse-j2-restart-restored'))

      const result: JourneyResult = {
        journey: '2: customer create/edit/archive/restore + required documents across restart',
        status: 'PASS',
        detail: `${CUSTOMER_ONE} -> ${CUSTOMER_ONE_EDITED}; 2 required documents; archived then restored`,
        evidence: {
          userDataDir,
          requiredDocs: findCustomer(restored, CUSTOMER_ONE_EDITED).requiredDocs.map(
            (doc: any) => doc.label,
          ),
          notes: findCustomer(restored, CUSTOMER_ONE_EDITED).notes,
        },
        screenshots,
      }
      await writeResult('tenders-first-use-journey-2', result)
    } finally {
      if (run1) await closeAndSaveVideo(run1, 'tenders-first-use-j2-run1').catch(() => undefined)
      if (run2) await closeAndSaveVideo(run2, 'tenders-first-use-j2-run2').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  /**
   * Keyboard-only journey: the tender list must be operable without a mouse.
   * The card is a real `<button>` (not an `onClick` on a list item), so Tab
   * reaches it and Enter/Space open the workspace exactly like a click.
   */
  test('3: a tender opens with Tab + Enter and Tab + Space alone', async () => {
    const screenshots: string[] = []
    let run1: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-first-use-j3',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)
      await createCompanyViaFirstUse(tenders, COMPANY_ONE)

      // Import the shipped sample RFP through the file input, so this journey
      // never depends on the demo asset being fetchable.
      await gotoPage(tenders, 'Tenders')
      await tenders.locator('input[type="file"][accept*="pdf"]').first().setInputFiles(SAMPLE_RFP)
      const matrix = tenders.getByRole('heading', { name: 'Compliance matrix' })
      await expect(matrix).toBeVisible({ timeout: 90_000 })
      const store = await pollStore(
        userDataDir,
        (s) => (activeWorkspace(s)?.tenders ?? []).length > 0,
      )
      const tender = activeWorkspace(store).tenders[0]
      expect(tender, 'the imported tender must be committed').toBeTruthy()

      // Back to the list view.
      await tenders.locator('main').getByRole('button', { name: 'Tenders' }).first().click()
      const listHeading = tenders.getByRole('heading', { name: 'Tenders', level: 1 })
      await expect(listHeading).toBeVisible({ timeout: 20_000 })

      // (a) The card carries real button semantics and a named control.
      const cards = tenders.locator('[data-testid="tender-card"]')
      await expect(cards).toHaveCount(1)
      await expect(
        cards.first().getByRole('button', { name: tender.title }),
        'the tender card must expose an open-tender button',
      ).toBeVisible()
      const cardsWithoutButton = await cards.evaluateAll(
        (nodes) => nodes.filter((node) => !node.querySelector('button')).length,
      )
      expect(cardsWithoutButton, 'every tender card must contain a real button').toBe(0)

      // (b) Tab reaches the card from a neutral focus point, and Enter opens it.
      const tabsToCard = await tabToTenderCard(tenders)
      expect(
        tabsToCard,
        `the tender card must be reachable with Tab alone (gave up after 40 tabs)`,
      ).not.toBeNull()
      await tenders.keyboard.press('Enter')
      await expect(matrix).toBeVisible({ timeout: 20_000 })
      await expect(tenders.locator('[data-testid="workspace-context-header"]')).toContainText(
        tender.title,
        { timeout: 20_000 },
      )
      screenshots.push(await shot(tenders, 'firstuse-j3-keyboard-enter'))

      // (c) The same card opens with Space.
      await tenders.locator('main').getByRole('button', { name: 'Tenders' }).first().click()
      await expect(listHeading).toBeVisible({ timeout: 20_000 })
      expect(await tabToTenderCard(tenders), 'the card must still be reachable with Tab').not.toBe(
        null,
      )
      await tenders.keyboard.press('Space')
      await expect(matrix).toBeVisible({ timeout: 20_000 })
      await expect(tenders.locator('[data-testid="workspace-context-header"]')).toContainText(
        tender.title,
        { timeout: 20_000 },
      )
      screenshots.push(await shot(tenders, 'firstuse-j3-keyboard-space'))

      const result: JourneyResult = {
        journey: '3: keyboard-only tender opening (Tab + Enter / Tab + Space)',
        status: 'PASS',
        detail: `card reachable after ${tabsToCard} tabs; Enter and Space both opened the workspace for ${tender.id}`,
        evidence: { userDataDir, tenderId: tender.id, tenderTitle: tender.title, tabsToCard },
        screenshots,
      }
      await writeResult('tenders-first-use-journey-3', result)
    } finally {
      if (run1) await closeAndSaveVideo(run1, 'tenders-first-use-j3').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  /**
   * Demo-import labelling: a tender shredded from the bundled sample RFP must
   * stay distinguishable from the user's own tenders, and the tag must be the
   * import (not the file name) — importing the very same PDF through the file
   * input must NOT be labelled.
   *
   * Depends on the demo asset being served from the renderer output, exactly as
   * `tenders-regression-smoke.spec.ts` already requires; the probe below reports
   * the URL and status so a missing asset cannot be misread as a labelling bug.
   */
  test('4: a demo import is labelled as demonstration data, a file-input import is not', async () => {
    const screenshots: string[] = []
    let run1: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-first-use-j4',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)
      await createCompanyViaFirstUse(tenders, COMPANY_ONE)
      await gotoPage(tenders, 'Tenders')

      const probe = await tenders.evaluate(async () => {
        const url = new URL('./demo/sample-rfp.pdf', document.baseURI).href
        try {
          const res = await fetch('./demo/sample-rfp.pdf')
          return { url, ok: res.ok, status: res.status }
        } catch (error) {
          return { url, ok: false, status: 0, error: String(error) }
        }
      })
      expect(
        probe.ok,
        `the demo RFP must be served from the renderer output: ${JSON.stringify(probe)}`,
      ).toBe(true)

      // (a) The demo loader's own import is tagged.
      await tenders.getByRole('button', { name: 'Load demo RFP' }).click()
      const matrix = tenders.getByRole('heading', { name: 'Compliance matrix' })
      await expect(matrix).toBeVisible({ timeout: 90_000 })
      await tenders.locator('main').getByRole('button', { name: 'Tenders' }).first().click()
      await expect(tenders.getByRole('heading', { name: 'Tenders', level: 1 })).toBeVisible({
        timeout: 20_000,
      })
      const cards = tenders.locator('[data-testid="tender-card"]')
      await expect(cards).toHaveCount(1)
      await expect(cards.first()).toHaveAttribute('data-demo-import', 'true')
      await expect(tenders.getByText('Demo import').first()).toBeVisible()
      await expect(
        tenders.getByText(/demonstration data, not a real tender/i).first(),
        'the list must say what the demo label means',
      ).toBeVisible()
      screenshots.push(await shot(tenders, 'firstuse-j4-demo-labelled'))

      // (b) Control: the same PDF through the file input is the user's own import.
      await tenders.locator('input[type="file"][accept*="pdf"]').first().setInputFiles(SAMPLE_RFP)
      await expect(matrix).toBeVisible({ timeout: 90_000 })
      await tenders.locator('main').getByRole('button', { name: 'Tenders' }).first().click()
      await expect(tenders.getByRole('heading', { name: 'Tenders', level: 1 })).toBeVisible({
        timeout: 20_000,
      })
      await expect(cards).toHaveCount(2)
      await expect(
        tenders.locator('[data-testid="tender-card"][data-demo-import="true"]'),
        'only the demo-button import may be labelled',
      ).toHaveCount(1)
      screenshots.push(await shot(tenders, 'firstuse-j4-control-unlabelled'))

      const result: JourneyResult = {
        journey: '4: demo import labelled, file-input import not labelled',
        status: 'PASS',
        detail: `demo asset ${probe.url} -> HTTP ${probe.status}; 1 of 2 tenders tagged data-demo-import`,
        evidence: { userDataDir, probe },
        screenshots,
      }
      await writeResult('tenders-first-use-journey-4', result)
    } finally {
      if (run1) await closeAndSaveVideo(run1, 'tenders-first-use-j4').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
