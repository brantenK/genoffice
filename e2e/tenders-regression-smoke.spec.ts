/**
 * Phase 2 regression smoke for the Tenders renderer — post-cutover semantics.
 *
 * Task 2B cut the renderer over to the authoritative on-disk v2 store and
 * intentionally removed demo seeding: a fresh profile is now an EMPTY workspace
 * (`FirstUsePage`), not the old demo company/tender. This spec drives the same
 * real product flows through the new semantics against the built shell:
 *
 *   1. open Tenders from the shell Business Apps nav
 *   2. fresh profile renders FirstUsePage (no demo data, no store file)
 *   3. create a company workspace through the UI
 *   4. click the real "Load demo RFP" control -> requirements appear AND persist
 *      to the authoritative v2 store (the regression the cutover journey caught).
 *      The control fetches the demo asset from the renderer's own output, so this
 *      is also what proves the demo assets actually ship in the build — driving
 *      the file input from the repo fixture hid that.
 *   5. change a requirement status -> persists across restart
 *   6. upload + save a vault document -> persists across restart
 *   7. export the compliance matrix (Sheets) and generate Draft Docs
 *   8. CRM sync -> deal created and the tender back-linked
 *   9. restart the SAME scratch profile -> requirement status + vault doc
 *      persisted, readiness still BLOCKED, proposal still conservative
 *  10. zero Unauthorized / INVALID_REQUEST / origin-mismatch errors
 *
 * It never patches application source. Every privileged handler call is made
 * through real UI; the renderer URL and registered WebContents are recorded so
 * a trust failure is diagnosable.
 */
import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import {
  launchShell,
  closeAndSaveVideo,
  waitForPageWithUrl,
  screenshotPath,
  ARTIFACTS_DIR,
  SHELL_DIR,
  type LaunchedApp,
} from './helpers'
import {
  readStore,
  pollStore,
  salvageTendersDiagnosticsLog,
  teardownScratchProfile,
  STORE_IMPORT_POLL_MS,
} from './tenders-timing'

const TENDERS_DEMO_DIR = resolve(SHELL_DIR, '..', 'tenders', 'public', 'demo')
const VAULT_PDF = join(TENDERS_DEMO_DIR, 'vault', 'tax-clearance.pdf')

/** `%LOCALAPPDATA%\Temp\opencode` on Windows (os.tmpdir() is %TEMP%). */
const SCRATCH_ROOT = join(tmpdir(), 'opencode')

const TRUST_ERROR_RE =
  /unauthoriz|invalid_request|not a registered tenders|sender is not a registered/i
const VAULT_DOC_TITLE = 'E2E Smoke Vault Doc'
const COMPANY_NAME = 'E2E Smoke Civils (Pty) Ltd'
const COMPANY_NAME_PLACEHOLDER = 'e.g. Lephalale Civils (Pty) Ltd'

type FlowStatus = 'PASS' | 'FAIL' | 'SKIPPED'
interface FlowResult {
  name: string
  status: FlowStatus
  detail?: string
  error?: string
}

const flows: FlowResult[] = []
const screenshots: string[] = []
const consoleLog: string[] = []

function record(name: string, status: FlowStatus, detail?: string, error?: string): void {
  flows.push({ name, status, ...(detail ? { detail } : {}), ...(error ? { error } : {}) })
}

async function step(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await fn()
    record(name, 'PASS', detail || undefined)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record(name, 'FAIL', undefined, message)
    return false
  }
}

function watchPage(page: Page, tag: string): void {
  page.on('console', (msg) => consoleLog.push(`[${tag}:${msg.type()}] ${msg.text()}`))
  page.on('pageerror', (err) => consoleLog.push(`[${tag}:pageerror] ${err.message}`))
}

function watchApp(app: ElectronApplication, tag: string): void {
  const proc = app.process()
  proc.stdout?.on('data', (chunk) => consoleLog.push(`[${tag}:stdout] ${String(chunk)}`))
  proc.stderr?.on('data', (chunk) => consoleLog.push(`[${tag}:stderr] ${String(chunk)}`))
}

async function shot(page: Page, name: string): Promise<void> {
  const target = screenshotPath(name)
  try {
    await page.screenshot({ path: target, timeout: 15_000 })
    screenshots.push(target)
  } catch {
    // screenshots are best-effort evidence, never a reason to fail a flow
  }
}

// ── scratch profile + on-disk store helpers ───────────────────────────────────

async function scratchUserData(): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  return mkdtemp(join(SCRATCH_ROOT, 'genoffice-e2e-'))
}

function storeFile(userDataDir: string): string {
  return join(userDataDir, 'tenders', 'tenders-data.json')
}

function allTenders(store: any): any[] {
  const out: any[] = []
  for (const workspace of store?.workspaces ?? []) {
    for (const tender of workspace?.tenders ?? []) out.push(tender)
  }
  return out
}

function workspaceNames(store: any): string[] {
  return (store?.workspaces ?? []).map((ws: any) => ws?.name ?? ws?.company?.tradingName ?? '')
}

function findRequirement(store: any, predicate: (r: any) => boolean): any | undefined {
  for (const tender of allTenders(store)) {
    for (const requirement of tender?.requirements ?? []) {
      if (predicate(requirement)) return requirement
    }
  }
  return undefined
}

function findShreddedTender(store: any): any | undefined {
  return allTenders(store).find(
    (tender) => typeof tender?.fileName === 'string' && /sample-rfp\.pdf$/i.test(tender.fileName),
  )
}

function findVaultDoc(store: any, title: string): any | undefined {
  for (const workspace of store?.workspaces ?? []) {
    for (const doc of workspace?.vault ?? []) {
      if (doc?.title === title) return doc
    }
  }
  return undefined
}

async function readCrmDeals(userDataDir: string): Promise<any[]> {
  try {
    const raw = JSON.parse(await readFile(join(userDataDir, 'crm', 'deals.json'), 'utf8'))
    return Array.isArray(raw) ? raw : Array.isArray(raw?.deals) ? raw.deals : []
  } catch {
    return []
  }
}

async function latestGeneratedMarkdown(
  userDataDir: string,
): Promise<{ path: string; content: string } | null> {
  const dir = join(userDataDir, 'tenders', 'generated')
  const entries = await readdir(dir).catch(() => [] as string[])
  const markdown = entries.filter((name) => name.endsWith('.md'))
  if (markdown.length === 0) return null
  const withTimes = await Promise.all(
    markdown.map(async (name) => ({
      name,
      mtime: (await stat(join(dir, name)).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
    })),
  )
  withTimes.sort((a, b) => b.mtime - a.mtime)
  const path = join(dir, withTimes[0].name)
  return { path, content: await readFile(path, 'utf8') }
}

async function listMatrixCsvs(): Promise<string[]> {
  const entries = await readdir(tmpdir()).catch(() => [] as string[])
  return entries
    .filter((name) => name.includes('_Compliance_Matrix_'))
    .map((name) => join(tmpdir(), name))
}

/**
 * The app's own diagnostics log, as lines.
 *
 * Read straight from the scratch profile, which is where the app writes it — the
 * salvaged copy in `e2e/artifacts/diagnostics/` is made at teardown, so asserting
 * against the live file is what proves the IPC bridge actually reached the sink
 * rather than that a later step could have written something.
 */
async function readDiagnosticsLog(userDataDir: string): Promise<string[]> {
  try {
    const raw = await readFile(join(userDataDir, 'tenders', 'tenders-diagnostics.log'), 'utf8')
    return raw.split('\n').filter((line) => line.trim().length > 0)
  } catch {
    return []
  }
}

// ── UI navigation helpers ─────────────────────────────────────────────────────

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
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function activateShellTab(shell: Page, title: string): Promise<void> {
  const tab = shell.locator(`.tab-item[title="${title}"]`)
  await expect(tab).toBeVisible({ timeout: 15_000 })
  await tab.click()
}

async function gotoInternalTendersPage(tenders: Page): Promise<void> {
  const navTenders = tenders.locator('nav').getByRole('button', { name: 'Tenders' })
  await expect(navTenders).toBeVisible({ timeout: 15_000 })
  await navTenders.click()
  await expect(tenders.getByRole('heading', { name: 'Tenders', level: 1 })).toBeVisible({
    timeout: 15_000,
  })
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

/** Ensure the tender workspace (compliance matrix) for `title` is open. */
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

/**
 * The tender under test is genuinely blocked (the readiness drawer shows
 * blocking checks and "Mark ready to submit" is disabled). Because the preload
 * projection forwards `id`, main can build the canonical readiness report, so
 * the proposal is now *bound* to it: instead of the old "not independently
 * verified" fallback it must carry the canonical failure and its enumerated
 * blocking checks. Both are fail-closed; the assertions below are strictly
 * stronger than the fallback wording they replace — a proposal for a blocked
 * tender can never claim to be ready.
 */
function assertConservativeProposal(content: string): void {
  // Status, in both places the generator states it, is a hard DRAFT — not
  // "DRAFT" with a hedge, and never the ready wording.
  expect(content).toMatch(/\*\*Proposal Status:\*\* \*\*DRAFT — SUBMISSION BLOCKED\*\*/)
  expect(content).toMatch(/\*\*Audit Gate Status\*\*: \*\*DRAFT — SUBMISSION BLOCKED\*\*/)
  // The document names the canonical readiness failure and its remedy.
  expect(content).toMatch(
    /\*\*Readiness Verification:\*\* Canonical readiness report failed; resolve its blocking checks before submission\./,
  )
  expect(content).not.toMatch(/READY FOR SUBMISSION/)
  expect(content).not.toMatch(/CLEARED/)
  expect(content).not.toMatch(/Confirmed Total Bid Valuation/)
  expect(content).toMatch(/Pricing:\*\* Not provided or unconfirmed/)
  // The canonical blocking checks must be enumerated, not merely summarised:
  // a blocked proposal always accounts for at least one blocker.
  const totalBlockers = /\*\*Total Blockers:\*\* (\d+)/.exec(content)
  expect(totalBlockers, 'the proposal must report a blocker count').not.toBeNull()
  expect(
    Number(totalBlockers![1]),
    'a blocked proposal must enumerate at least one blocker',
  ).toBeGreaterThan(0)
  expect(content).toMatch(/\*\*Condition ID:\*\*/)
  expect(content).toMatch(/\*\*Blockers:\*\*/)
}

// ── test ──────────────────────────────────────────────────────────────────────

test.describe('Tenders regression smoke (post-cutover)', () => {
  test.describe.configure({ timeout: 600_000 })

  test('fresh-profile cutover flows, persistence and hardened IPC', async () => {
    const startedAt = new Date().toISOString()
    const userDataDir = await scratchUserData()
    const resultPath = join(
      ARTIFACTS_DIR,
      `tenders-regression-smoke-${startedAt.replace(/[:.]/g, '-')}.json`,
    )
    const diagnostics: Record<string, unknown> = {
      spec: 'e2e/tenders-regression-smoke.spec.ts',
      command: 'npm run test:e2e -- e2e/tenders-regression-smoke.spec.ts',
      userDataDir,
      startedAt,
    }
    const videos: string[] = []
    let tendersPage: Page | undefined
    let shreddedTenderId: string | undefined
    let tenderTitle: string | undefined
    let changedRequirement: { id: string; title: string; from: string; to: string } | undefined
    let vaultDocStoredPath: string | undefined
    let exportedCsvPath: string | undefined
    let generatedProposalPath: string | undefined
    let crmDealId: string | undefined
    let proposalContent: string | undefined
    let diagnosticsLogPath: string | null = null

    let run1: LaunchedApp | undefined
    let run2: LaunchedApp | undefined

    try {
      // ── Phase A: open Tenders from the shell Business Apps nav ───────────────
      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-regression-smoke',
      })
      watchApp(run1.app, 'run1')
      watchPage(run1.page, 'run1:shell')

      const opened = await step('open-tenders-from-shell-nav', async () => {
        tendersPage = await openTendersFromNav(run1!.app, run1!.page)
        watchPage(tendersPage, 'run1:tenders')
        diagnostics.rendererHref = await tendersPage.evaluate(() => window.location.href)
        const appPath = (await run1!.app.evaluate(({ app }) => app.getAppPath())) as string
        const expected = resolve(appPath, '..', 'tenders', 'out', 'renderer', 'index.html')
        diagnostics.expectedRendererFileUrl = pathToFileURL(expected).href
        diagnostics.webContentsAtOpen = await run1!.app
          .evaluate(({ webContents }) =>
            webContents.getAllWebContents().map((wc) => ({
              id: wc.id,
              type: wc.getType(),
              url: wc.getURL(),
            })),
          )
          .catch(() => [])
        await dismissTendersOnboarding(tendersPage)
        return `tenders href = ${String(diagnostics.rendererHref)}`
      })
      if (!opened || !tendersPage) {
        throw new Error('Tenders renderer never opened — see diagnostics')
      }

      // ── Phase B1: fresh profile is an empty workspace (no demo seeding) ─────
      await step('fresh-profile-empty-workspace', async () => {
        await expect(
          tendersPage!.getByRole('heading', { name: 'No company workspaces yet' }),
        ).toBeVisible({ timeout: 20_000 })
        await expect(tendersPage!.getByText('Thabo Engineering')).toHaveCount(0)
        await expect(tendersPage!.getByText('RFP-WTR-2026-04')).toHaveCount(0)
        expect(await readStore(userDataDir), 'not-found must not write a store file').toBeNull()
        await shot(tendersPage!, 'tenders-fresh-empty-workspace')
        return 'FirstUsePage rendered; no demo data seeded; no store file yet'
      })

      // Gated read-only probe: both the v2 load and the legacy read channel are
      // authorized (no INVALID_REQUEST / trust error).
      await step('auth-probe-read-only-handlers', async () => {
        const probe = await tendersPage!.evaluate(async () => {
          const api = (window as any).tendersApi
          const result: Record<string, unknown> = {}
          try {
            const legacy = await api.getStoredData()
            result.getStoredData =
              typeof legacy === 'string'
                ? { ok: true, bytes: legacy.length }
                : { ok: legacy === null ? 'empty' : false, raw: legacy }
          } catch (error) {
            result.getStoredData = { threw: String(error) }
          }
          try {
            const v2 = await api.loadStoreV2()
            result.loadStoreV2 = v2
          } catch (error) {
            result.loadStoreV2 = { threw: String(error) }
          }
          return result
        })
        diagnostics.authProbe = probe
        const serialized = JSON.stringify(probe)
        expect(serialized).not.toMatch(TRUST_ERROR_RE)
        const v2 = probe.loadStoreV2 as { ok?: boolean; status?: string } | undefined
        expect(v2?.ok, 'loadStoreV2 should be authorized (not INVALID_REQUEST)').toBe(true)
        return `loadStoreV2 status=${v2?.status}; no trust errors`
      })

      // ── Phase B2: create a company workspace through the UI ─────────────────
      await step('create-company-workspace', async () => {
        await createCompany(tendersPage!, COMPANY_NAME)
        const store = await pollStore(
          userDataDir,
          (s) => s.schemaVersion === 2 && s.workspaces?.length === 1,
        )
        expect(Array.isArray(store?.workspaces)).toBe(true)
        expect(workspaceNames(store)).toContain(COMPANY_NAME)
        return `${COMPANY_NAME} committed at revision ${store?.revision}`
      })

      // Once committed, the legacy read channel must expose the authoritative
      // document (shared trust predicate as every other gated handler).
      await step('auth-probe-legacy-read-after-commit', async () => {
        const probe = await tendersPage!.evaluate(async () => {
          const api = (window as any).tendersApi
          const legacy = await api.getStoredData()
          return {
            isString: typeof legacy === 'string',
            bytes: typeof legacy === 'string' ? legacy.length : 0,
            raw: typeof legacy === 'string' ? null : legacy,
          }
        })
        diagnostics.legacyReadProbe = probe
        expect(JSON.stringify(probe)).not.toMatch(TRUST_ERROR_RE)
        expect(probe.isString, 'getStoredData should return the committed store').toBe(true)
        expect(probe.bytes, 'committed store should be non-empty').toBeGreaterThan(0)
        return `getStoredData returned ${probe.bytes} bytes`
      })

      // ── Phase B3: shred the sample RFP -> requirements persist ──────────────
      // Driven through the real "Load demo RFP" control, which fetches the asset
      // from the renderer's own output directory. Feeding the repo fixture
      // straight into the file input (the previous shape of this flow) bypassed
      // the fetch entirely, which is why the suite stayed green while the button
      // was dead in every build: the demo assets never reached out/renderer.
      await step('load-demo-rfp-button-creates-requirements', async () => {
        await gotoInternalTendersPage(tendersPage!)
        // Probe the exact first URL the button's loader tries, and accept it on
        // the same terms the loader does (`response.ok`). Asserting this before
        // clicking means a build that dropped the demo assets reports the URL and
        // status instead of an opaque "compliance matrix never appeared".
        const demoAsset = await tendersPage!.evaluate(async () => {
          const url = new URL('./demo/sample-rfp.pdf', document.baseURI).href
          try {
            const res = await fetch('./demo/sample-rfp.pdf')
            const bytes = res.ok ? (await res.blob()).size : 0
            return { url, ok: res.ok, status: res.status, bytes }
          } catch (error) {
            return { url, ok: false, status: 0, bytes: 0, error: String(error) }
          }
        })
        diagnostics.demoAsset = demoAsset
        expect(
          demoAsset.ok,
          `the demo RFP must be served from the renderer output: ${JSON.stringify(demoAsset)}`,
        ).toBe(true)
        expect(demoAsset.bytes).toBeGreaterThan(1000)

        const loadDemo = tendersPage!.getByRole('button', { name: 'Load demo RFP' })
        await expect(loadDemo).toBeVisible({ timeout: 15_000 })
        await loadDemo.click()
        await expect(tendersPage!.getByRole('heading', { name: 'Compliance matrix' })).toBeVisible({
          timeout: 90_000,
        })
        // The locate affordance is offered, in the wording of the source this
        // tender actually is: the demo RFP is a PDF, so rows say "in PDF" and the
        // Word wording ("in source pane", for an imported .docx) must not appear.
        await expect(
          tendersPage!.getByText(/\d+ requirements · click to locate in PDF/),
        ).toBeVisible()
        await expect(tendersPage!.getByText(/click to locate in source pane/)).toHaveCount(0)
        const expandCount = await tendersPage!
          .locator('button[title="Show clause details"]')
          .count()
        expect(expandCount).toBeGreaterThan(0)
        // Persistence is the regression the cutover journey caught: the shredded
        // tender must reach the authoritative v2 store, not just the UI.
        const store = await pollStore(
          userDataDir,
          (s) => Boolean(findShreddedTender(s)),
          STORE_IMPORT_POLL_MS,
        )
        const tender = findShreddedTender(store)
        expect(tender, 'shredded tender persisted to the authoritative v2 store').toBeTruthy()
        expect(tender.requirements.length).toBeGreaterThan(0)
        shreddedTenderId = tender.id
        tenderTitle = tender.title
        expect(String(tender.fileUrl)).toMatch(/^documents\//)
        await shot(tendersPage!, 'tenders-shredded-workspace')
        return `${expandCount} requirement rows; tender ${tender.id}; persisted with ${tender.requirements.length} requirements`
      })

      // ── Phase B4: change a requirement status -> persists ───────────────────
      await step('change-requirement-status', async () => {
        const expand = tendersPage!.locator('button[title="Show clause details"]').first()
        await expect(expand).toBeVisible()
        await expand.click()
        const statusSelect = tendersPage!.locator('select:has(option[value="FULFILLED"])').first()
        await expect(statusSelect).toBeVisible()
        const from = await statusSelect.inputValue()
        const to = from === 'FULFILLED' ? 'ACTION_REQUIRED' : 'FULFILLED'
        await statusSelect.selectOption(to)
        await expect(statusSelect).toHaveValue(to)

        const store = await pollStore(userDataDir, (s) =>
          Boolean(findRequirement(s, (r) => r.status === to)),
        )
        const requirement = findRequirement(store, (r) => r.status === to)
        expect(requirement, 'requirement status change must persist to disk').toBeTruthy()
        changedRequirement = {
          id: requirement.id,
          title: requirement.title,
          from,
          to,
        }
        await shot(tendersPage!, 'tenders-requirement-status-changed')
        return `${changedRequirement.title}: ${from} → ${to} (persisted as ${requirement.id})`
      })

      // ── Phase B5: upload + save a vault document -> persists ────────────────
      await step('upload-save-vault-document', async () => {
        await tendersPage!.locator('nav').getByRole('button', { name: 'Documents' }).click()
        await expect(tendersPage!.getByRole('heading', { name: 'Documents' })).toBeVisible({
          timeout: 15_000,
        })
        await tendersPage!.getByRole('button', { name: 'Upload document' }).click()
        await expect(
          tendersPage!.getByRole('heading', { name: 'Add company document' }),
        ).toBeVisible()
        await tendersPage!
          .getByPlaceholder('e.g. SARS Tax Clearance Certificate')
          .fill(VAULT_DOC_TITLE)
        await tendersPage!
          .locator('input[type="file"][accept="application/pdf"]')
          .last()
          .setInputFiles(VAULT_PDF)
        await tendersPage!.getByRole('button', { name: 'Add to vault' }).click()
        await expect(tendersPage!.getByText(VAULT_DOC_TITLE).first()).toBeVisible({
          timeout: 15_000,
        })

        const store = await pollStore(userDataDir, (s) => Boolean(findVaultDoc(s, VAULT_DOC_TITLE)))
        const doc = findVaultDoc(store, VAULT_DOC_TITLE)
        expect(doc, 'vault doc persisted through the authoritative v2 store').toBeTruthy()
        vaultDocStoredPath = doc.fileUrl
        expect(String(doc.fileUrl)).toMatch(/^vault\//)
        const onDisk = await stat(join(userDataDir, 'tenders', doc.fileUrl)).catch(() => null)
        expect(onDisk?.isFile(), 'vault file written to disk').toBeTruthy()
        await shot(tendersPage!, 'tenders-vault-document-uploaded')
        return `${VAULT_DOC_TITLE} → ${doc.fileUrl}`
      })

      // ── Phase B6: export the compliance matrix (Sheets) ─────────────────────
      await step('export-compliance-matrix', async () => {
        const before = await listMatrixCsvs()
        await ensureTenderWorkspace(tendersPage!, tenderTitle!)
        await tendersPage!.getByRole('button', { name: 'Sheets' }).click()
        const sheets = await waitForPageWithUrl(run1!.app, 'sheets', 30_000)
        watchPage(sheets, 'run1:sheets')
        await expect(sheets.locator('body')).toBeVisible({ timeout: 20_000 })
        await shot(sheets, 'tenders-compliance-matrix-sheets')
        let fresh: string | undefined
        for (let attempt = 0; attempt < 40 && !fresh; attempt++) {
          const after = await listMatrixCsvs()
          fresh = after.find((path) => !before.includes(path))
          if (!fresh) await new Promise((resolve) => setTimeout(resolve, 250))
        }
        expect(fresh, 'a fresh compliance matrix CSV was written').toBeTruthy()
        exportedCsvPath = fresh
        return `opened Sheets view; csv=${fresh}`
      })

      // ── Phase B7: generate Draft Docs (proposal markdown) ───────────────────
      await step('generate-draft-docs', async () => {
        await activateShellTab(run1!.page, 'Zanostack Tenders')
        const before = await latestGeneratedMarkdown(userDataDir)
        await tendersPage!.getByRole('button', { name: 'Draft Docs' }).click()
        const markdown = await waitForPageWithUrl(run1!.app, 'markdown', 30_000)
        watchPage(markdown, 'run1:markdown')
        await expect(markdown.locator('body')).toBeVisible({ timeout: 20_000 })
        await shot(markdown, 'tenders-draft-docs-markdown')
        const generated = await latestGeneratedMarkdown(userDataDir)
        expect(generated, 'generated proposal markdown written to disk').not.toBeNull()
        if (before) expect(generated!.path).not.toBe(before.path)
        generatedProposalPath = generated!.path
        proposalContent = generated!.content
        assertConservativeProposal(proposalContent)
        return `generated ${generatedProposalPath}; conservative draft verified`
      })

      // ── Phase B8: CRM sync ──────────────────────────────────────────────────
      await step('crm-sync-deal-created', async () => {
        await activateShellTab(run1!.page, 'Zanostack Tenders')
        await tendersPage!.getByRole('button', { name: 'CRM', exact: true }).click()
        const crm = await waitForPageWithUrl(run1!.app, 'crm', 30_000)
        watchPage(crm, 'run1:crm')
        await expect(crm.locator('body')).toBeVisible({ timeout: 20_000 })
        await shot(crm, 'tenders-crm-sync')
        await expect
          .poll(
            async () =>
              (await readCrmDeals(userDataDir)).some((d) => d?.tenderId === shreddedTenderId),
            {
              timeout: 20_000,
              message: 'CRM deal should be persisted in deals.json',
            },
          )
          .toBe(true)
        const deal = (await readCrmDeals(userDataDir)).find(
          (d) => d?.tenderId === shreddedTenderId,
        )!
        crmDealId = deal.id
        diagnostics.crmDeal = { id: deal.id, tenderId: deal.tenderId }
        return `CRM deal ${deal.id} persisted for tender ${shreddedTenderId}`
      })

      // The handler writes the CRM deal first and only then back-links the
      // tender through the authoritative store. With the v2 schema fixed this
      // back-link now commits; assert it rather than diagnosing its absence.
      await step('crm-tender-backlink', async () => {
        const store = await pollStore(userDataDir, (s) =>
          Boolean(findShreddedTender(s)?.linkedCrmDealId),
        )
        const backlink = findShreddedTender(store)?.linkedCrmDealId ?? null
        diagnostics.crmTenderBacklink = { linkedCrmDealId: backlink }
        expect(backlink, 'tender back-linked to CRM deal (linkedCrmDealId persisted)').toBeTruthy()
        return `linkedCrmDealId=${backlink}`
      })

      // ── Phase C: restart the same scratch profile ───────────────────────────
      videos.push((await closeAndSaveVideo(run1, 'tenders-regression-smoke-run1')) ?? '')
      run1 = undefined

      // ── Phase D: relaunch against the SAME userData dir ─────────────────────
      run2 = await launchShell({ userDataDir, videoDir: 'tenders-regression-smoke-restart' })
      watchApp(run2.app, 'run2')
      watchPage(run2.page, 'run2:shell')

      const reopened = await step('restart-open-tenders', async () => {
        const tenders2 = await openTendersFromNav(run2!.app, run2!.page)
        watchPage(tenders2, 'run2:tenders')
        await dismissTendersOnboarding(tenders2)
        return 'tenders renderer reloaded from the same scratch profile'
      })
      const tenders2 = reopened ? await waitForPageWithUrl(run2.app, 'tenders') : undefined

      await step('restart-persistence-requirement-and-vault', async () => {
        expect(tenders2, 'tenders renderer must exist after restart').toBeTruthy()
        expect(changedRequirement, 'run 1 requirement change must be known').toBeTruthy()
        // disk first: proves the commit survived the restart
        const store = await readStore(userDataDir)
        const tender = findShreddedTender(store)
        expect(tender, 'shredded tender present after restart').toBeTruthy()
        const persisted = (tender.requirements as any[]).find(
          (r) => r.id === changedRequirement!.id,
        )
        expect(persisted?.status, 'requirement status persisted on disk').toBe(
          changedRequirement!.to,
        )
        const doc = findVaultDoc(store, VAULT_DOC_TITLE)
        expect(doc, 'uploaded vault document persisted on disk').toBeTruthy()
        expect(doc.fileUrl).toBe(vaultDocStoredPath)

        // UI: open the shredded tender and confirm the row shows the new status
        await ensureTenderWorkspace(tenders2!, tenderTitle!)
        const row = tenders2!.locator('li', { hasText: changedRequirement!.title }).first()
        await expect(row).toBeVisible({ timeout: 15_000 })
        const expand = row.locator('button[title="Show clause details"]')
        if ((await expand.count()) > 0) await expand.first().click()
        const statusSelect = row.locator('select:has(option[value="FULFILLED"])').first()
        await expect(statusSelect).toHaveValue(changedRequirement!.to)

        // UI: vault document still listed
        await tenders2!.locator('nav').getByRole('button', { name: 'Documents' }).click()
        await expect(tenders2!.getByRole('heading', { name: 'Documents' })).toBeVisible({
          timeout: 15_000,
        })
        await expect(tenders2!.getByText(VAULT_DOC_TITLE).first()).toBeVisible({ timeout: 15_000 })
        await shot(tenders2!, 'tenders-restart-persistence')
        return `requirement ${changedRequirement!.id}=${changedRequirement!.to}; vault doc ${doc.fileUrl}`
      })

      await step('restart-crm-deal-persisted', async () => {
        const deals = await readCrmDeals(userDataDir)
        const deal = deals.find((d) => d?.tenderId === shreddedTenderId)
        expect(deal, 'CRM deal survives restart').toBeTruthy()
        return `CRM deal ${deal.id} still present after restart`
      })

      await step('restart-readiness-still-blocked', async () => {
        expect(tenders2, 'tenders renderer must exist after restart').toBeTruthy()
        await ensureTenderWorkspace(tenders2!, tenderTitle!)
        await tenders2!.getByRole('button', { name: 'Bid readiness' }).click()
        await expect(tenders2!.getByRole('heading', { name: 'Bid readiness' })).toBeVisible({
          timeout: 15_000,
        })
        await expect(tenders2!.getByText(/blocking check/).first()).toBeVisible()
        await expect(tenders2!.getByRole('button', { name: 'Mark ready to submit' })).toBeDisabled()
        await expect(tenders2!.getByText(/All blocking checks pass/)).toHaveCount(0)
        await shot(tenders2!, 'tenders-restart-readiness-blocked')
        return 'readiness drawer shows blocking checks and the ready action is disabled'
      })

      await step('restart-proposal-still-conservative', async () => {
        const generated = await latestGeneratedMarkdown(userDataDir)
        expect(generated, 'generated proposal still present after restart').not.toBeNull()
        proposalContent = generated!.content
        assertConservativeProposal(proposalContent)
        return `proposal ${generated!.path} still carries DRAFT — SUBMISSION BLOCKED + the canonical readiness failure and its blockers`
      })

      // ── Phase E: the error boundary, in the BUILT app ───────────────────────
      // `renderer/src/components/ErrorBoundary.tsx` exists to stop a render throw
      // becoming a blank window, and until this flow it was proven only in jsdom
      // (`tests/components/error-boundary.test.tsx`). jsdom proves the component's
      // logic; it cannot prove the boundary is MOUNTED in the shipped bundle, that
      // the fallback's own test ids survive the production build, or that the
      // chrome around the failed region stays usable — which is the whole claim.
      //
      // HOW A THROW IS FORCED, AND WHAT THAT DOES AND DOES NOT PROVE. The app has
      // no test hook and no product route that makes a page throw on demand, and
      // shipping one to make this test easier would put a crash switch in the
      // shipped app. Instead the throw is injected into React's OWN dispatch path,
      // on the fiber of the REAL boundary instance the build mounted, by walking
      // the live fiber tree from the `#root` container. What that proves: the
      // boundary this build ships catches a render throw in a real child, renders
      // the fallback with the real copy and test ids, keeps the shell's navigation
      // alive, reports the failure to the diagnostics log through the real
      // bridge, and does not claim anything was confirmed. What it does not prove:
      // that a specific product component throws — that is the jsdom suite's job,
      // where the real `Workspace` is mounted through the same boundary.
      const boundary = await step('error-boundary-fallback-in-built-app', async () => {
        expect(tenders2, 'tenders renderer must exist after restart').toBeTruthy()
        const before = await readDiagnosticsLog(userDataDir)

        const injected = await tenders2!.evaluate(() => {
          // Walk from the React root container and collect EVERY class component
          // holding `getDerivedStateFromError` — the real mounted boundary
          // instances, not test doubles. The build mounts two: one in `main.tsx`
          // around `<App />` and one in `App.tsx` around the page area. Which one
          // is used matters, so the choice is named below rather than left to walk
          // order.
          const container = document.getElementById('root')
          const rootKey = container
            ? Object.keys(container).find((key) => key.startsWith('__reactContainer'))
            : undefined
          let node: any = rootKey && container ? (container as any)[rootKey] : null
          if (node && node.stateNode && !node.type) node = node.return ?? node.child

          const found: any[] = []
          let guard = 0
          const walk = (fiber: any): void => {
            while (fiber && guard < 50_000) {
              guard++
              const type = fiber.type
              if (
                type &&
                typeof type === 'function' &&
                typeof type.getDerivedStateFromError === 'function' &&
                fiber.stateNode
              ) {
                found.push(fiber)
              }
              if (fiber.child) walk(fiber.child)
              fiber = fiber.sibling
            }
          }
          walk(node)
          if (found.length === 0) return { found: false as const, count: 0, regions: [] }

          // The INNER boundary is the one whose claim this flow exists to check:
          // `App.tsx` wraps only the page area, so a throw there must leave the
          // sidebar and its navigation usable. The outer `main.tsx` boundary
          // deliberately covers the whole window — including the nav — so
          // asserting "the nav survives" against IT would be the wrong claim.
          // Depth is the fiber's own distance from the root; the larger depth is
          // the inner boundary.
          const depthOf = (fiber: any): number => {
            let d = 0
            let f = fiber
            while (f && f.return) {
              d++
              f = f.return
            }
            return d
          }
          const target = found.reduce((a, b) => (depthOf(a) >= depthOf(b) ? a : b))
          const instance = target.stateNode
          const region = instance.props?.region ?? 'this window'

          // React's own path: the boundary receives the error through
          // `getDerivedStateFromError` and then renders the fallback. Dispatching
          // a real throw through this pair is what the boundary is built for, and
          // it exercises the shipped component's own methods, not a copy.
          const thrown = new TypeError('e2e: forced render failure')
          instance.setState(instance.constructor.getDerivedStateFromError(thrown))
          instance.componentDidCatch(thrown, { componentStack: '\n  at E2EBoundaryProbe' })
          return {
            found: true as const,
            count: found.length,
            regions: found.map((f) => f.stateNode?.props?.region ?? 'this window'),
            region,
          }
        })
        diagnostics.errorBoundaryInjection = injected
        expect(
          injected.found,
          'the built renderer must mount a class error boundary reachable from the React root',
        ).toBe(true)
        expect(
          injected.count,
          'the build mounts TWO boundaries (root + page area) — finding only one means the ' +
            'per-page boundary was removed, which is the mounting this flow exists to check',
        ).toBeGreaterThan(1)
        // The id is asserted, not inferred: a flow that accidentally used the root
        // boundary would take the navigation with it and could not make this claim.
        expect(injected.region, 'the page boundary names the page it covers').not.toBe(
          'this window',
        )

        const fallback = tenders2!.getByTestId('error-boundary-fallback')
        await expect(fallback).toBeVisible({ timeout: 15_000 })
        // The copy is the app's own, and it is the honest version of it: the
        // window is still running, nothing was confirmed, and it names the log.
        await expect(fallback).toHaveAttribute('role', 'alert')
        await expect(fallback).toContainText('stopped working')
        await expect(fallback).toContainText('Nothing was confirmed on your behalf')
        await expect(fallback).toContainText('tenders-diagnostics.log')
        // The fallback must never be read as a readiness result.
        await expect(fallback).not.toContainText(/READY FOR SUBMISSION/)
        await expect(fallback).not.toContainText(/All blocking checks pass/)

        // The rest of the window still works: this is the property a blank screen
        // destroys, and the reason the boundary is mounted per-page rather than
        // only at the root.
        await expect(tenders2!.locator('nav').getByRole('button', { name: 'Tenders' })).toBeVisible(
          {
            timeout: 15_000,
          },
        )

        // The failure reached the app's own log, through the real IPC bridge, as
        // an error CODE — a render error's message can embed tender text.
        const after = await readDiagnosticsLog(userDataDir)
        const added = after.slice(before.length)
        expect(
          added.length,
          `the boundary must add to the diagnostics log; added: ${JSON.stringify(added)}`,
        ).toBeGreaterThan(0)
        expect(
          added.join('\n'),
          `the log entry must carry the render-error code; added: ${JSON.stringify(added)}`,
        ).toMatch(/render-error/)
        expect(
          added.join('\n'),
          `the log entry must carry the code for this failure; added: ${JSON.stringify(added)}`,
        ).toMatch(/tenders-react-render/)
        expect(
          JSON.stringify(added),
          'the log must carry the code, never the thrown message',
        ).not.toContain('forced render failure')

        // And "Try this view again" is a real remount, not a re-render: the real
        // page comes back and the fallback goes away. The heading asserted is
        // whatever the page actually restores — this spec has an active tender
        // open at this point, so the workspace's own heading is the evidence, and
        // pinning "Tenders" here would encode this flow's incidental page state
        // rather than the remount.
        await tenders2!.getByTestId('error-boundary-retry').click()
        await expect(fallback).toHaveCount(0, { timeout: 20_000 })
        await expect(tenders2!.locator('nav').getByRole('button', { name: 'Tenders' })).toBeVisible(
          { timeout: 20_000 },
        )
        await expect(tenders2!.locator('main').locator('h1').first()).toBeVisible({
          timeout: 20_000,
        })
        await expect(tenders2!.getByText('stopped working')).toHaveCount(0)
        await shot(tenders2!, 'tenders-error-boundary-fallback')
        return `forced a child render throw; fallback shown for region "${injected.region}", navigation stayed usable, the log gained the code, and retry remounted the page`
      })

      await step('restart-after-boundary-recovery', async () => {
        expect(boundary, 'the boundary flow must have succeeded').toBe(true)
        return 'the boundary flow completed without leaving the window in a failed state'
      })
    } catch (error) {
      // ── SALVAGE AT THE THROW POINT ─────────────────────────────────────────
      // The `finally` below salvages too, but this is the earlier of the two
      // salvage points and the only one that survives a failure in the teardown
      // itself (a hung `closeAndSaveVideo`, a worker killed mid-`finally`). The
      // result JSON the run writes is a *different* statement: it says what the
      // spec observed. This copies the evidence, so a reader can check the
      // observation against the log rather than trusting it.
      if (!diagnosticsLogPath)
        diagnosticsLogPath = await salvageTendersDiagnosticsLog(
          userDataDir,
          'tenders-regression-smoke',
        )
      record('aborted', 'FAIL', undefined, error instanceof Error ? error.message : String(error))
    } finally {
      if (run1) {
        const video = await closeAndSaveVideo(run1, 'tenders-regression-smoke-run1').catch(
          () => undefined,
        )
        if (video) videos.push(video)
      }
      if (run2) {
        const video = await closeAndSaveVideo(run2, 'tenders-regression-smoke-restart').catch(
          () => undefined,
        )
        if (video) videos.push(video)
      }
      // BEFORE the profile goes: the log lives inside it, and a failing flow
      // reaches this block with the result JSON still unwritten (see the
      // shared helper's own note). This is the second salvage point — the
      // `catch` above is the first — and it covers the path the brief named:
      // a failing run must still yield the log, not `null`.
      diagnosticsLogPath =
        (await teardownScratchProfile(userDataDir, 'tenders-regression-smoke')) ??
        diagnosticsLogPath
    }

    // ── Diagnostics + result JSON ────────────────────────────────────────────
    diagnostics.registeredWebContents = await run1?.app
      ?.evaluate(({ webContents }) =>
        webContents.getAllWebContents().map((wc) => ({
          id: wc.id,
          type: wc.getType(),
          url: wc.getURL(),
        })),
      )
      .catch(() => [])
    diagnostics.tendersWebContents = ((diagnostics.registeredWebContents as any[]) ?? []).filter(
      (wc) => String(wc.url).includes('tenders'),
    )

    const unauthorizedEvents: string[] = []
    for (const entry of consoleLog) {
      if (TRUST_ERROR_RE.test(entry)) unauthorizedEvents.push(entry)
    }
    diagnostics.unauthorizedEvents = unauthorizedEvents
    // The TOP-LEVEL field first: the previous wave set this one before the
    // `finally` had run, so a failing run recorded `null` here while the
    // `artifacts` entry below recorded a real path — the same statement
    // contradicting itself in one document. Both are now written from
    // `diagnosticsLogPath` after the last salvage point.
    diagnostics.diagnosticsLogArtifact = diagnosticsLogPath
    diagnostics.diagnosticsLogInsideProfile = join(
      userDataDir,
      'tenders',
      'tenders-diagnostics.log',
    )
    diagnostics.forbiddenStatuses = {
      'READY FOR SUBMISSION': proposalContent ? /READY FOR SUBMISSION/.test(proposalContent) : null,
      'Confirmed Total Bid Valuation': proposalContent
        ? /Confirmed Total Bid Valuation/.test(proposalContent)
        : null,
    }
    diagnostics.proposalPath = generatedProposalPath
    diagnostics.exportedCsvPath = exportedCsvPath
    diagnostics.crmDealId = crmDealId
    diagnostics.consoleTail = consoleLog.slice(-200)

    const failedFlows = flows.filter((flow) => flow.status === 'FAIL')
    const result = {
      task: '2A/2B',
      title: 'Post-cutover Tenders regression smoke (fresh-profile flows + persistence)',
      status: failedFlows.length === 0 ? 'PASS' : 'FAIL',
      startedAt,
      finishedAt: new Date().toISOString(),
      spec: 'e2e/tenders-regression-smoke.spec.ts',
      command: 'npm run test:e2e -- e2e/tenders-regression-smoke.spec.ts',
      userDataDir,
      flows,
      failedFlows: failedFlows.map((flow) => flow.name),
      artifacts: {
        screenshots,
        videos,
        diagnosticsLog: diagnosticsLogPath,
        resultJson: resultPath,
      },
      unauthorizedOrInvalidRequest: unauthorizedEvents,
      diagnostics,
    }
    await mkdir(ARTIFACTS_DIR, { recursive: true })
    await writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8')

    expect(
      failedFlows,
      `Failed flows: ${failedFlows.map((flow) => `${flow.name} (${flow.error ?? ''})`).join(' | ')}`,
    ).toEqual([])
    expect(unauthorizedEvents, 'no Unauthorized/INVALID_REQUEST/trust errors surfaced').toEqual([])
  })
})
