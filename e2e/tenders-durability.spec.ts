/**
 * Phase 5 lane G3 — managed-document durability + store recovery (WP-9 / WP-2
 * remainder), built-Electron verification.
 *
 * Authored ahead of the renderer wiring: every durable outcome is asserted
 * through the landed main-process contract (IPC bridge + on-disk state), and
 * UI surfaces are located by role/name until the wiring lane publishes its
 * `data-testid`s. WRITE-ONLY LANE: no build/run was performed when authoring.
 *
 * Landed main contract this spec drives (apps/tenders/src/main):
 *  - Soft delete (`tenders:delete-document`): moves the file to
 *    `<userData>/tenders/.trash/<id>__<name>` — never a hard unlink — and
 *    returns `links` (tenders/customers/vault records referencing the file),
 *    `warnings` and a `trashId` undo handle.
 *  - `tenders:list-document-trash` / `tenders:restore-document`: trash entries
 *    (`deletedFrom`, `trashedPath`, `id`) restore across a restart; restore
 *    re-activates the record and may relocate the file on collision.
 *  - `tenders:replace-document`: commits the replacement first, then trashes
 *    the previous file (`previousTrashed: true`); a failed commit leaves the
 *    previous file active (no dangling reference window).
 *  - `tenders:reconcile-documents`: reports `missing` (active records whose file
 *    vanished), `orphaned` (files without metadata), `trashed`, `activeCount`;
 *    nothing is auto-deleted.
 *  - Recovery: a corrupt/invalid `tenders-data.json` with recoverable copies
 *    makes `tenders:load-store-v2` return `ok:false`,
 *    `error.code === 'RECOVERY_REQUIRED'` and `recoveryCandidates` — it never
 *    substitutes an empty/demo/backup document. `tenders:restore-recovery-candidate`
 *    is explicit, quarantines the corrupt primary to
 *    `backups/primary-corrupt-<ts>.json` and commits the candidate.
 *
 * Bridge contract (preload `window.tendersApi`; the wiring lane must bind):
 *   loadStoreV2, saveDocument, deleteDocument, listDocumentTrash,
 *   restoreDocument, replaceDocument, reconcileDocuments, cleanupDocumentTrash,
 *   listRecoveryCandidates, restoreRecoveryCandidate.
 * `requireBridge()` fails loudly (never skips) when a method is missing.
 *
 * UI contract (landed by the wiring lane; testids asserted directly):
 *  - Documents page: `getByRole('heading', { name: 'Documents' })`,
 *    button 'Upload document', DocCard buttons (accessible name has the title),
 *    detail-panel button 'Delete'; `documents-save-error` (role=alert) for a
 *    failed save.
 *  - Delete confirmation: `delete-document-dialog` (role=dialog) with a
 *    recoverable/trash copy; confirm via `delete-document-confirm`. The
 *    referencing records are listed AFTER the move in `documents-notice`
 *    (the dialog copy states it lists them "afterwards").
 *  - Trash: `documents-trash-button` → `documents-trash-panel`; entries
 *    `trash-entry-<id>` with `trash-restore-<id>` (restore is immediate).
 *  - Recovery (corrupt store with candidates): `recovery-surface` heading
 *    /unable to load|recover/i, candidate rows `recovery-candidate-<n>`; the
 *    first-use chooser must NOT appear. This spec restores via the bridge (the
 *    explicit `recovery-restore-<n>` UI path is covered by the wiring lane's
 *    own verification).
 *  - Save failure: page-level `role=alert` on the Documents page.
 *
 * Fixtures: scratch `userData` under the opencode temp root with a seeded,
 * schema-valid v2 store plus real PDFs (pdf-lib). Scratch is cleaned in
 * `finally`; artifacts (JSON + screenshots) land under e2e/artifacts.
 */
import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
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

const COMPANY_NAME = 'E2E Durability Civils (Pty) Ltd'
const RESTORED_COMPANY = 'E2E Durability Restored (Pty) Ltd'
const TENDER_REF = 'E2E/DUR/2026/01'
const TENDER_ID = 't-dur'
const VAULT_DOC_ID = 'vd-dur'
const VAULT_TITLE = 'E2E Durability Vault Cert'
const CUSTOMER_NAME = 'E2E Durability Client'

/** Seed-only relative paths (files exist on disk but are untracked). */
const SEEDED_RFP_PATH = 'documents/e2e-durability-rfp.pdf'
const SEEDED_VAULT_PATH = 'vault/e2e-durability.pdf'

const MANAGED_INDEX_FILE = 'managed-documents.json'
const TRASH_DIR = '.trash'

// ── bridge types (subset of apps/tenders/src/shared/ipc.ts) ──────────────────

interface ManagedRecord {
  id: string
  category: 'rfp' | 'vault'
  relativePath: string
  fileName: string
  size: number
  hash: string
  state: 'active' | 'trashed' | 'missing'
  trashedAt: string | null
  trashedPath: string | null
  replacedBy: string | null
}

interface TrashEntry {
  id: string
  recordId: string
  fileName: string
  category: 'rfp' | 'vault'
  size: number
  hash: string
  trashedAt: string
  deletedFrom: string
  trashedPath: string
}

interface FileLink {
  kind: 'tender' | 'customer' | 'vault'
  id: string
  label: string
}

interface Reconciliation {
  missing: Array<{ id: string; relativePath: string; fileName: string; lastSeenAt: string }>
  orphaned: string[]
  trashed: TrashEntry[]
  activeCount: number
}

interface RecoveryCandidate {
  id: string
  path: string
  source: string
  revision?: number
  valid: boolean
  sizeBytes?: number
}

// ── seeded fixture ────────────────────────────────────────────────────────────

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
    description: 'E2E durability fixture company.',
    address: '1 Test Road, Test City',
    phone: '+27 10 000 0000',
    email: 'durability@example.test',
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
    verbatimClause: `E2E durability clause for ${title}.`,
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

function tenderFixture(sharedRfp = false): Record<string, unknown> {
  return {
    id: TENDER_ID,
    title: `E2E Durability Tender ${TENDER_REF}`,
    referenceNumber: TENDER_REF,
    issuingBody: 'E2E Water Authority',
    closingDate: null,
    submissionMethod: null,
    submissionAddress: null,
    signatureChecks: {},
    status: 'IN_PROGRESS',
    createdAt: LOADED_AT,
    fileName: 'e2e-durability-rfp.pdf',
    fileUrl: SEEDED_RFP_PATH,
    // When another tender shares the same managed RFP path, removal must warn
    // about that reference before the soft-delete (the tender-delete journey).
    ...(sharedRfp
      ? {
          linkedCrmDealId: 'deal-e2e-1',
          milestones: [
            {
              id: 'ms-dur-1',
              name: 'E2E milestone',
              amount: 1000,
              status: 'REACHED',
              dueDate: '2026-10-01',
            },
          ],
        }
      : {}),
    numPages: 2,
    ocrPages: 0,
    requirements: [
      requirementFixture('req-dur-1', `E2E durability requirement one (${TENDER_REF})`, 1),
      requirementFixture('req-dur-2', `E2E durability requirement two (${TENDER_REF})`, 2),
    ],
  }
}

/** A second tender that shares the seeded RFP path (link-warning seed). */
function linkedTenderFixture(): Record<string, unknown> {
  return {
    id: 't-dur-linked',
    title: 'E2E Durability Linked Tender',
    referenceNumber: 'E2E/DUR/2026/99',
    issuingBody: 'E2E Water Authority',
    closingDate: null,
    submissionMethod: null,
    submissionAddress: null,
    signatureChecks: {},
    status: 'IN_PROGRESS',
    createdAt: LOADED_AT,
    fileName: 'e2e-durability-rfp.pdf',
    fileUrl: SEEDED_RFP_PATH,
    numPages: 2,
    ocrPages: 0,
    requirements: [requirementFixture('req-dur-9', 'E2E durability linked requirement', 1)],
  }
}

function customerFixture(): Record<string, unknown> {
  return {
    id: 'cust-dur',
    name: CUSTOMER_NAME,
    contactName: 'E2E Contact',
    contactEmail: 'client@example.test',
    contactPhone: '+27 11 000 0000',
    industry: 'Municipal water',
    status: 'ACTIVE',
    since: '2024-02-01',
    notes: 'E2E durability fixture customer.',
    requiredDocs: [
      {
        docCategory: 'COMPLIANCE',
        label: 'B-BBEE certificate',
        fulfilled: true,
        linkedVaultDocId: VAULT_DOC_ID,
      },
    ],
  }
}

/** Schema-valid v2 document (mirrors the shapes accepted by the store schema). */
function seededDocument(
  options: { revision?: number; companyName?: string; linkedRfp?: boolean } = {},
): Record<string, unknown> {
  const companyName = options.companyName ?? COMPANY_NAME
  return {
    schemaVersion: 2,
    revision: options.revision ?? 1,
    updatedAt: LOADED_AT,
    activeCompanyId: 'co-dur',
    workspaces: [
      {
        id: 'co-dur',
        name: companyName,
        dataOrigin: 'user',
        company: companyProfile(companyName),
        customers: [customerFixture()],
        vault: [
          {
            id: VAULT_DOC_ID,
            title: VAULT_TITLE,
            category: 'COMPLIANCE',
            fileUrl: SEEDED_VAULT_PATH,
            issueDate: null,
            expiryDate: null,
            isCertified: false,
            certifiedDate: null,
            metadata: {},
          },
        ],
        tenders: options.linkedRfp
          ? [tenderFixture(true), linkedTenderFixture()]
          : [tenderFixture()],
      },
    ],
    issuerTemplates: [],
  }
}

async function generatePdf(targetPath: string, label: string, pages = 2): Promise<void> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index <= pages; index += 1) {
    const page = doc.addPage([595, 842])
    page.drawText(`${label} — PAGE ${index}`, { x: 60, y: 780, size: 13, font })
  }
  await writeFile(targetPath, Buffer.from(await doc.save()))
}

/** Seed a valid v2 store + the two untracked PDFs the links reference. */
async function writeSeededStore(
  userDataDir: string,
  options: { revision?: number; companyName?: string; linkedRfp?: boolean } = {},
): Promise<void> {
  const base = join(userDataDir, 'tenders')
  await mkdir(join(base, 'documents'), { recursive: true })
  await mkdir(join(base, 'vault'), { recursive: true })
  await generatePdf(join(base, SEEDED_RFP_PATH), 'E2E DURABILITY RFP')
  await generatePdf(join(base, SEEDED_VAULT_PATH), 'E2E DURABILITY VAULT')
  await writeFile(
    join(base, 'tenders-data.json'),
    JSON.stringify(seededDocument(options), null, 2),
    'utf8',
  )
}

// ── scratch + harness helpers ─────────────────────────────────────────────────

async function scratchUserData(): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  return mkdtemp(join(SCRATCH_ROOT, 'genoffice-e2e-'))
}

function tendersBaseDir(userDataDir: string): string {
  return join(userDataDir, 'tenders')
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readManagedIndex(userDataDir: string): Promise<{ records: ManagedRecord[] } | null> {
  const path = join(tendersBaseDir(userDataDir), MANAGED_INDEX_FILE)
  if (!existsSync(path)) return null
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { records?: ManagedRecord[] }
  return { records: Array.isArray(parsed.records) ? parsed.records : [] }
}

async function listDirSafe(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort()
  } catch {
    return []
  }
}

function trashDirFor(userDataDir: string): string {
  return join(tendersBaseDir(userDataDir), TRASH_DIR)
}

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

async function gotoDocuments(tenders: Page): Promise<void> {
  await tenders.locator('nav').getByRole('button', { name: 'Documents' }).click()
  await expect(tenders.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({
    timeout: 20_000,
  })
}

/**
 * The durability bridge must be bound by the preload wiring. Poll briefly so a
 * slow renderer boot never masquerades as a missing contract, then fail loudly
 * with the exact list of missing methods (never skip).
 */
async function requireBridge(tenders: Page, methods: string[]): Promise<void> {
  await expect
    .poll(
      () =>
        tenders.evaluate((names) => {
          const api = (window as unknown as { tendersApi?: Record<string, unknown> }).tendersApi
          return names.filter((name) => typeof api?.[name] !== 'function')
        }, methods),
      {
        timeout: 20_000,
        message: `tendersApi durability contract missing — the preload wiring lane must bind: ${methods.join(', ')}`,
      },
    )
    .toEqual([])
}

async function listTrash(tenders: Page): Promise<TrashEntry[]> {
  return tenders.evaluate(async () => {
    const api = (window as unknown as { tendersApi: any }).tendersApi
    const res = await api.listDocumentTrash()
    if (!res?.ok) throw new Error(`listDocumentTrash failed: ${res?.error ?? 'unknown'}`)
    return (res.entries ?? []) as unknown[]
  })
}

async function reconcile(tenders: Page): Promise<Reconciliation> {
  return tenders.evaluate(async () => {
    const api = (window as unknown as { tendersApi: any }).tendersApi
    const res = await api.reconcileDocuments()
    if (!res?.ok) throw new Error(`reconcileDocuments failed: ${res?.error ?? 'unknown'}`)
    return res.reconciliation
  })
}

async function saveBridgeDocument(
  tenders: Page,
  input: { fileName: string; bytes: Buffer; category: 'rfp' | 'vault' },
): Promise<{
  ok: boolean
  id?: string
  storedPath?: string
  record?: ManagedRecord
  error?: string
}> {
  return tenders.evaluate(
    async ({ fileName, numbers, category }) => {
      const api = (window as unknown as { tendersApi: any }).tendersApi
      return api.saveDocument({
        fileName,
        buffer: new Uint8Array(numbers),
        category,
      })
    },
    { fileName: input.fileName, numbers: Array.from(input.bytes), category: input.category },
  )
}

async function deleteBridgeDocument(
  tenders: Page,
  storedPath: string,
): Promise<{
  ok: boolean
  error?: string
  links?: FileLink[]
  warnings?: string[]
  trashId?: string
}> {
  return tenders.evaluate(async (path) => {
    const api = (window as unknown as { tendersApi: any }).tendersApi
    return api.deleteDocument({ storedPath: path })
  }, storedPath)
}

async function readBridgeDocument(
  tenders: Page,
  storedPath: string,
): Promise<{ ok: boolean; byteLength?: number; error?: string }> {
  return tenders.evaluate(async (path) => {
    const api = (window as unknown as { tendersApi: any }).tendersApi
    const res = await api.readDocument({ storedPath: path })
    return res?.ok
      ? { ok: true, byteLength: (res.buffer as ArrayBuffer)?.byteLength ?? 0 }
      : { ok: false, error: res?.error }
  }, storedPath)
}

/** Force the `tenders:save-document` handler to fail (deterministic failure). */
async function forceSaveDocumentFailure(app: ElectronApplication, message: string): Promise<void> {
  await app.evaluate(({ ipcMain }, forced) => {
    ipcMain.removeHandler('tenders:save-document')
    ipcMain.handle('tenders:save-document', async () => ({ ok: false, error: forced }))
  }, message)
}

/** Force the `tenders:delete-document` handler to fail (deterministic failure). */
async function forceDeleteDocumentFailure(
  app: ElectronApplication,
  message: string,
): Promise<void> {
  await app.evaluate(({ ipcMain }, forced) => {
    ipcMain.removeHandler('tenders:delete-document')
    ipcMain.handle('tenders:delete-document', async () => ({ ok: false, error: forced }))
  }, message)
}

async function gotoPage(tenders: Page, label: string): Promise<void> {
  await tenders.locator('nav').getByRole('button', { name: label }).click()
}

/** Open the Tenders page and read the workspace document back from disk. */
async function readStoreDocument(userDataDir: string): Promise<{
  revision?: number
  workspaces?: Array<{ tenders?: Array<{ id: string; title: string }> }>
}> {
  return JSON.parse(await readFile(join(tendersBaseDir(userDataDir), 'tenders-data.json'), 'utf8'))
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

/** Boot the seeded durability profile and land on the Documents page. */
async function bootDocuments(
  videoDir: string,
  seedOptions: { revision?: number; companyName?: string; linkedRfp?: boolean } = {},
): Promise<{ run: LaunchedApp; tenders: Page; userDataDir: string }> {
  const userDataDir = await scratchUserData()
  await writeSeededStore(userDataDir, seedOptions)
  const run = await launchShell({ userDataDir, onboardingSeen: true, videoDir })
  const tenders = await openTendersFromNav(run.app, run.page)
  await dismissTendersOnboarding(tenders)
  return { run, tenders, userDataDir }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test.describe('Tenders durability (Phase 5 / WP-9 + WP-2 remainder)', () => {
  test.describe.configure({ timeout: 300_000 })

  test('1: soft-delete moves the file to .trash and the trash UI restores it after a restart', async () => {
    const screenshots: string[] = []
    let run1: LaunchedApp | undefined
    let run2: LaunchedApp | undefined
    let userDataDir = ''
    try {
      const uploadSource = join(tmpdir(), `e2e-dur-upload-${Date.now()}.pdf`)
      await generatePdf(uploadSource, 'E2E DURABILITY UPLOAD', 1)
      const uploadBytes = await readFile(uploadSource)

      const booted = await bootDocuments('tenders-durability-j1-run1')
      run1 = booted.run
      userDataDir = booted.userDataDir
      const tenders = booted.tenders
      await requireBridge(tenders, ['saveDocument', 'listDocumentTrash', 'restoreDocument'])
      await gotoDocuments(tenders)

      // Upload through the real UI so the managed record is created by the app.
      await tenders.getByRole('button', { name: 'Upload document' }).click()
      const uploadHeading = tenders.getByRole('heading', { name: 'Add company document' })
      await expect(uploadHeading).toBeVisible({ timeout: 15_000 })
      await tenders.locator('input[type="file"][accept*="pdf"]').first().setInputFiles(uploadSource)
      await tenders
        .getByPlaceholder(/SARS Tax Clearance Certificate/i)
        .fill('E2E Durability Upload Cert')
      await tenders.getByRole('button', { name: 'Add to vault' }).click()
      await expect(
        tenders.getByRole('button', { name: /E2E Durability Upload Cert/ }).first(),
      ).toBeVisible({ timeout: 20_000 })
      screenshots.push(await shot(tenders, 'durability-j1-uploaded'))

      const indexAfterUpload = await readManagedIndex(userDataDir)
      const uploadFileName = basename(uploadSource)
      const uploaded = indexAfterUpload?.records.find(
        (record) => record.fileName === uploadFileName && record.state === 'active',
      )
      expect(uploaded, 'the upload must create a managed-document record').toBeTruthy()
      const originalPath = uploaded!.relativePath
      expect(existsSync(join(tendersBaseDir(userDataDir), originalPath))).toBe(true)

      // Delete through the UI contract: confirm surface must say it is recoverable.
      await tenders
        .getByRole('button', { name: /E2E Durability Upload Cert/ })
        .first()
        .click()
      await tenders.getByRole('button', { name: /^Delete$/ }).click()
      const deleteDialog = tenders.locator('[data-testid="delete-document-dialog"]')
      await expect(deleteDialog, 'the delete confirmation must be an in-app dialog').toBeVisible({
        timeout: 10_000,
      })
      await expect(deleteDialog.getByRole('dialog')).toBeVisible()
      await expect(deleteDialog).toContainText(/trash|recover/i)
      await deleteDialog.locator('[data-testid="delete-document-confirm"]').click()

      // On-disk truth: moved to .trash (never unlinked), original path gone.
      await expect
        .poll(async () => existsSync(join(tendersBaseDir(userDataDir), originalPath)), {
          timeout: 15_000,
          message: 'the original file must leave its active path on soft-delete',
        })
        .toBe(false)
      const trashFiles = await listDirSafe(trashDirFor(userDataDir))
      expect(
        trashFiles.some((name) => name.includes(uploaded!.id)),
        `the .trash dir must hold the soft-deleted file (got: ${JSON.stringify(trashFiles)})`,
      ).toBe(true)
      const trashAfterDelete = await listTrash(tenders)
      const deletedEntry = trashAfterDelete.find((entry) => entry.deletedFrom === originalPath)
      expect(deletedEntry, 'listDocumentTrash must expose the soft-deleted file').toBeTruthy()
      expect(existsSync(join(tendersBaseDir(userDataDir), deletedEntry!.trashedPath))).toBe(true)

      // Trash UI contract (data-testid contract delivered by the wiring lane).
      await tenders.locator('[data-testid="documents-trash-button"]').click()
      const trashPanel = tenders.locator('[data-testid="documents-trash-panel"]')
      await expect(trashPanel).toBeVisible({ timeout: 10_000 })
      await expect(trashPanel).toContainText(uploaded!.fileName)
      screenshots.push(await shot(tenders, 'durability-j1-trash-ui'))

      // Restart the same profile, then restore through the trash UI.
      await closeAndSaveVideo(run1, 'tenders-durability-j1-run1')
      run1 = undefined
      run2 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-durability-j1-run2',
      })
      const tenders2 = await openTendersFromNav(run2.app, run2.page)
      await dismissTendersOnboarding(tenders2)
      await requireBridge(tenders2, ['listDocumentTrash', 'restoreDocument'])
      const trashAfterRestart = await listTrash(tenders2)
      expect(
        trashAfterRestart.some((entry) => entry.deletedFrom === originalPath),
        'the trash entry must survive a restart',
      ).toBe(true)

      const entryAfterRestart = trashAfterRestart.find(
        (entry) => entry.deletedFrom === originalPath,
      )!
      await gotoDocuments(tenders2)
      await tenders2.locator('[data-testid="documents-trash-button"]').click()
      const panel2 = tenders2.locator('[data-testid="documents-trash-panel"]')
      await expect(panel2).toBeVisible({ timeout: 10_000 })
      await expect(panel2).toContainText(uploaded!.fileName)
      await expect(
        panel2.locator(`[data-testid="trash-entry-${entryAfterRestart.id}"]`),
      ).toBeVisible()
      await panel2.locator(`[data-testid="trash-restore-${entryAfterRestart.id}"]`).click()

      // Restored: entry gone from trash, file back on disk, readable.
      await expect
        .poll(async () => (await listTrash(tenders2)).some((e) => e.deletedFrom === originalPath), {
          timeout: 15_000,
          message: 'the restored entry must leave the trash list',
        })
        .toBe(false)
      await expect
        .poll(
          async () => {
            const index = await readManagedIndex(userDataDir)
            const record = index?.records.find((candidate) => candidate.id === uploaded!.id)
            return (
              record?.state === 'active' &&
              existsSync(join(tendersBaseDir(userDataDir), record.relativePath))
            )
          },
          { timeout: 15_000, message: 'the restored record must be active with its file on disk' },
        )
        .toBe(true)
      const restoredIndex = await readManagedIndex(userDataDir)
      const restoredRecord = restoredIndex!.records.find(
        (candidate) => candidate.id === uploaded!.id,
      )!
      const readable = await readBridgeDocument(tenders2, restoredRecord.relativePath)
      expect(readable.ok, `the restored file must be readable (${readable.error ?? ''})`).toBe(true)
      expect(readable.byteLength, 'the restored file must carry its original bytes').toBe(
        restoredRecord.size,
      )
      const postRestoreReconcile = await reconcile(tenders2)
      expect(
        postRestoreReconcile.missing.some(
          (entry) => entry.relativePath === restoredRecord.relativePath,
        ),
      ).toBe(false)
      expect(await shot(tenders2, 'durability-j1-restored')).toBeTruthy()

      const result: JourneyResult = {
        journey: '1: soft-delete -> .trash -> trash UI -> restart -> restore',
        status: 'PASS',
        detail: `uploaded ${originalPath}; trashed to ${deletedEntry!.trashedPath}; restored to ${restoredRecord.relativePath} (readable, reconcile-clean)`,
        evidence: {
          userDataDir,
          originalPath,
          trashedPath: deletedEntry!.trashedPath,
          restoredPath: restoredRecord.relativePath,
          recordId: uploaded!.id,
          trashAfterDelete,
        },
        screenshots,
      }
      await writeResult('tenders-durability-journey-1', result)
    } finally {
      if (run1) await closeAndSaveVideo(run1, 'tenders-durability-j1-run1').catch(() => undefined)
      if (run2) await closeAndSaveVideo(run2, 'tenders-durability-j1-run2').catch(() => undefined)
      if (userDataDir)
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('2: link-aware delete warns with referencing records and the recoverable copy', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      const booted = await bootDocuments('tenders-durability-j2')
      run = booted.run
      userDataDir = booted.userDataDir
      const tenders = booted.tenders
      await requireBridge(tenders, ['deleteDocument', 'listDocumentTrash', 'reconcileDocuments'])
      await gotoDocuments(tenders)

      // The vault document is referenced by the customer (requiredDocs link)
      // and by the vault itself; deleting it must surface those references.
      await tenders
        .getByRole('button', { name: new RegExp(VAULT_TITLE) })
        .first()
        .click()
      await tenders.getByRole('button', { name: /^Delete$/ }).click()
      const deleteDialog = tenders.locator('[data-testid="delete-document-dialog"]')
      await expect(deleteDialog, 'the delete confirmation must be an in-app dialog').toBeVisible({
        timeout: 10_000,
      })
      await expect(deleteDialog.getByRole('dialog')).toBeVisible()
      await expect(deleteDialog, 'the copy must say the file is recoverable').toContainText(
        /trash|recover/i,
      )
      screenshots.push(await shot(tenders, 'durability-j2-link-warning'))
      await deleteDialog.locator('[data-testid="delete-document-confirm"]').click()

      // The landed contract lists the referencing records in the post-move
      // notice (the dialog copy states it does so "afterwards").
      const notice = tenders.locator('[data-testid="documents-notice"]')
      await expect(notice, 'the referencing records must be listed after the move').toBeVisible({
        timeout: 15_000,
      })
      await expect(notice).toContainText(/referenced by/i)
      await expect(notice, 'the notice must name the referencing customer').toContainText(
        CUSTOMER_NAME,
      )
      await expect(notice, 'the notice must say the file is recoverable').toContainText(/trash/i)

      await expect
        .poll(
          async () => {
            const index = await readManagedIndex(userDataDir)
            const record = index?.records.find(
              (candidate) => candidate.relativePath === SEEDED_VAULT_PATH,
            )
            return record?.state
          },
          { timeout: 15_000, message: 'the vault file must be soft-deleted' },
        )
        .toBe('trashed')
      const vaultTrash = (await listTrash(tenders)).filter(
        (entry) => entry.deletedFrom === SEEDED_VAULT_PATH,
      )
      expect(vaultTrash.length, 'the vault file must be in the trash').toBe(1)

      // Tender-linked variant through the bridge: links + warnings + undo handle.
      const tenderDelete = await deleteBridgeDocument(tenders, SEEDED_RFP_PATH)
      expect(tenderDelete.ok, tenderDelete.error ?? '').toBe(true)
      expect(
        tenderDelete.links?.some((link) => link.kind === 'tender' && link.id === TENDER_ID),
        `the tender reference must be reported (${JSON.stringify(tenderDelete.links)})`,
      ).toBe(true)
      expect(
        tenderDelete.warnings?.some((warning) => /trash|restore/i.test(warning)),
        `the warning must state the file is recoverable (${JSON.stringify(tenderDelete.warnings)})`,
      ).toBe(true)
      expect(tenderDelete.trashId, 'a trashId undo handle must be returned').toBeTruthy()
      expect(existsSync(join(tendersBaseDir(userDataDir), SEEDED_RFP_PATH))).toBe(false)
      expect(
        (await listTrash(tenders)).some((entry) => entry.deletedFrom === SEEDED_RFP_PATH),
        'the tender file must be in the trash',
      ).toBe(true)
      const post = await reconcile(tenders)
      expect(post.missing.some((entry) => entry.relativePath === SEEDED_RFP_PATH)).toBe(false)

      const result: JourneyResult = {
        journey: '2: link-aware delete (customer + tender references, recoverable copy)',
        status: 'PASS',
        detail: `vault delete surfaced the ${CUSTOMER_NAME} reference; bridge delete of ${SEEDED_RFP_PATH} returned tender link + trash warning + trashId`,
        evidence: {
          userDataDir,
          vaultTrash: vaultTrash[0],
          tenderDelete: {
            links: tenderDelete.links,
            warnings: tenderDelete.warnings,
            trashId: tenderDelete.trashId,
          },
        },
        screenshots,
      }
      await writeResult('tenders-durability-journey-2', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-durability-j2').catch(() => undefined)
      if (userDataDir)
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('3: replacement trashes the previous file only after the new commit succeeds', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      const booted = await bootDocuments('tenders-durability-j3')
      run = booted.run
      userDataDir = booted.userDataDir
      const tenders = booted.tenders
      await requireBridge(tenders, [
        'saveDocument',
        'replaceDocument',
        'listDocumentTrash',
        'reconcileDocuments',
        'readDocument',
      ])

      const v1Bytes = await (async () => {
        const source = join(tmpdir(), `e2e-dur-replace-v1-${Date.now()}.pdf`)
        await generatePdf(source, 'E2E REPLACE V1', 1)
        return readFile(source)
      })()
      const v2Bytes = await (async () => {
        const source = join(tmpdir(), `e2e-dur-replace-v2-${Date.now()}.pdf`)
        await generatePdf(source, 'E2E REPLACE V2 — CONTENT CHANGED', 2)
        return readFile(source)
      })()

      const created = await saveBridgeDocument(tenders, {
        fileName: 'e2e-replace.pdf',
        bytes: v1Bytes,
        category: 'rfp',
      })
      expect(created.ok, created.error ?? '').toBe(true)
      const recordA = created.record!
      expect(recordA.hash).toBe(sha256Hex(v1Bytes))
      expect(existsSync(join(tendersBaseDir(userDataDir), recordA.relativePath))).toBe(true)
      const trashBefore = await listTrash(tenders)

      // Forced commit failure: the previous file must stay active (no trash, no loss).
      const failedReplace = await tenders.evaluate(
        async ({ storedPath, fileName }) => {
          const api = (window as unknown as { tendersApi: any }).tendersApi
          return api.replaceDocument({
            storedPath,
            fileName,
            // intentionally not a buffer: the main process must reject it
            buffer: { forced: 'not-a-buffer' } as never,
          })
        },
        { storedPath: recordA.relativePath, fileName: 'e2e-replace.pdf' },
      )
      expect(failedReplace.ok, 'an invalid buffer must fail the replacement').toBe(false)
      const indexAfterFailure = await readManagedIndex(userDataDir)
      const recordAAfterFailure = indexAfterFailure!.records.find(
        (candidate) => candidate.id === recordA.id,
      )!
      expect(recordAAfterFailure.state).toBe('active')
      expect(existsSync(join(tendersBaseDir(userDataDir), recordA.relativePath))).toBe(true)
      expect((await listTrash(tenders)).length).toBe(trashBefore.length)

      // Real replacement: new commit first, then the previous file to trash.
      const replaced = await tenders.evaluate(
        async ({ storedPath, fileName, numbers }) => {
          const api = (window as unknown as { tendersApi: any }).tendersApi
          return api.replaceDocument({
            storedPath,
            fileName,
            buffer: new Uint8Array(numbers),
          })
        },
        {
          storedPath: recordA.relativePath,
          fileName: 'e2e-replace.pdf',
          numbers: Array.from(v2Bytes),
        },
      )
      expect(replaced.ok, replaced.error ?? '').toBe(true)
      expect(replaced.previousTrashed).toBe(true)
      const recordB = replaced.record as ManagedRecord
      expect(recordB.hash).toBe(sha256Hex(v2Bytes))
      expect(recordB.relativePath).not.toBe(recordA.relativePath)
      expect(existsSync(join(tendersBaseDir(userDataDir), recordB.relativePath))).toBe(true)
      const onDisk = await readFile(join(tendersBaseDir(userDataDir), recordB.relativePath))
      expect(sha256Hex(onDisk)).toBe(recordB.hash)
      const readable = await readBridgeDocument(tenders, recordB.relativePath)
      expect(readable.ok, `the replacement must be readable (${readable.error ?? ''})`).toBe(true)

      // Previous file: gone from its active path, present in trash, never missing.
      expect(existsSync(join(tendersBaseDir(userDataDir), recordA.relativePath))).toBe(false)
      const trashAfter = await listTrash(tenders)
      expect(
        trashAfter.some((entry) => entry.deletedFrom === recordA.relativePath),
        'the previous file must be trashed after the commit',
      ).toBe(true)
      const indexAfter = await readManagedIndex(userDataDir)
      const recordAOld = indexAfter!.records.find((candidate) => candidate.id === recordA.id)!
      expect(recordAOld.state).toBe('trashed')
      expect(recordAOld.replacedBy).toBe(recordB.id)
      const post = await reconcile(tenders)
      expect(
        post.missing.some((entry) => entry.relativePath === recordA.relativePath),
        'the replaced file must never be reported missing (it is trashed, not lost)',
      ).toBe(false)
      screenshots.push(await shot(tenders, 'durability-j3-replaced'))

      const result: JourneyResult = {
        journey: '3: replace commits first, then trashes the previous file',
        status: 'PASS',
        detail: `failed commit kept ${recordA.relativePath} active; committed replace -> ${recordB.relativePath} (hash ${recordB.hash.slice(0, 12)}…), previous trashed (replacedBy=${recordB.id})`,
        evidence: {
          userDataDir,
          recordA: { id: recordA.id, relativePath: recordA.relativePath, hash: recordA.hash },
          recordB: { id: recordB.id, relativePath: recordB.relativePath, hash: recordB.hash },
          failedReplaceError: failedReplace.error,
          reconcile: post,
        },
        screenshots,
      }
      await writeResult('tenders-durability-journey-3', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-durability-j3').catch(() => undefined)
      if (userDataDir)
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('4: recovery is never automatic — candidates are listed, restore is explicit, no substitution', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let runB: LaunchedApp | undefined
    let userDataDir = ''
    let userDataDirB = ''
    try {
      // ── Part A: corrupt primary + a valid backup candidate ──────────────────
      // Both files are in place BEFORE the first hydration so the app boots
      // straight into the recovery surface.
      userDataDir = await scratchUserData()
      await writeSeededStore(userDataDir, { revision: 1, companyName: COMPANY_NAME })
      const base = tendersBaseDir(userDataDir)
      await mkdir(join(base, 'backups'), { recursive: true })
      await writeFile(
        join(base, 'backups', 'tenders-data.3.json'),
        JSON.stringify(seededDocument({ revision: 3, companyName: RESTORED_COMPANY }), null, 2),
        'utf8',
      )
      await writeFile(
        join(base, 'tenders-data.json'),
        '{"schemaVersion":2,"revision":1,"workspaces":[',
        'utf8',
      )
      run = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-durability-j4',
      })
      const tenders = await openTendersFromNav(run.app, run.page)
      await dismissTendersOnboarding(tenders)

      // The load must refuse: RECOVERY_REQUIRED + candidates, never data.
      const load = await tenders.evaluate(async () => {
        const api = (window as unknown as { tendersApi: any }).tendersApi
        return api.loadStoreV2()
      })
      expect(load.ok, 'a corrupt store with candidates must not load').toBe(false)
      expect(load.error?.code).toBe('RECOVERY_REQUIRED')
      expect(load.data, 'load must never substitute a document').toBeUndefined()
      const candidates = (load.recoveryCandidates ?? []) as RecoveryCandidate[]
      const backup = candidates.find((candidate) => candidate.id === 'backups/tenders-data.3.json')
      expect(
        backup,
        `the backup candidate must be listed (${JSON.stringify(candidates)})`,
      ).toBeTruthy()
      expect(backup!.valid).toBe(true)
      expect(backup!.revision).toBe(3)

      // UI: recovery surface up with the validated candidates listed,
      // first-use/empty/demo NOT substituted.
      await expect(
        tenders.locator('[data-testid="recovery-surface"]'),
        'the recovery surface must be visible instead of an empty store',
      ).toBeVisible({ timeout: 20_000 })
      await expect(
        tenders.getByRole('heading', { level: 1, name: /unable to load|recover/i }),
        'the recovery surface must announce recovery',
      ).toBeVisible()
      const candidateRows = tenders.locator('[data-testid^="recovery-candidate-"]')
      await expect(candidateRows.first(), 'the candidates must be listed in the UI').toBeVisible({
        timeout: 15_000,
      })
      const backupRow = candidateRows.filter({ hasText: 'backups/tenders-data.3.json' })
      await expect(backupRow.first(), 'the backup candidate must be listed in the UI').toBeVisible()
      await expect(
        tenders.getByRole('heading', { name: 'No company workspaces yet' }),
        'an empty/first-use store must never be substituted',
      ).toHaveCount(0)
      await expect(
        tenders.getByRole('button', { name: /Explore sample workspace/i }),
        'the demo workspace must never be substituted',
      ).toHaveCount(0)
      screenshots.push(await shot(tenders, 'durability-j4-recovery-surface'))

      // Explicit restore (bridge — the UI click swaps in with the testids).
      const listed = await tenders.evaluate(async () => {
        const api = (window as unknown as { tendersApi: any }).tendersApi
        return api.listRecoveryCandidates()
      })
      expect(listed.ok, listed.error ?? '').toBe(true)
      const chosen = (listed.candidates as RecoveryCandidate[]).find(
        (candidate) => candidate.id === 'backups/tenders-data.3.json' && candidate.valid,
      )
      expect(chosen).toBeTruthy()
      const restored = await tenders.evaluate(async (id) => {
        const api = (window as unknown as { tendersApi: any }).tendersApi
        return api.restoreRecoveryCandidate({ id })
      }, chosen!.id)
      expect(restored.ok, JSON.stringify(restored.error)).toBe(true)
      // The candidate content must be what was restored, and the recovery
      // commit re-bases the revision (expectedRevision 0 -> 1).
      const restoredDoc = restored.data as {
        revision?: number
        workspaces?: Array<{ name?: string }>
      }
      expect(restoredDoc.workspaces?.[0]?.name, 'the candidate content must be restored').toBe(
        RESTORED_COMPANY,
      )
      expect(restoredDoc.revision, 'recovery commits as a fresh revision').toBe(1)

      // The corrupt primary was quarantined, never overwritten silently.
      const backupFiles = await listDirSafe(join(base, 'backups'))
      const quarantined = backupFiles.filter((name) => name.startsWith('primary-corrupt-'))
      expect(
        quarantined.length > 0,
        `the corrupt primary must be quarantined (got ${JSON.stringify(backupFiles)})`,
      ).toBe(true)
      expect(
        await readFile(join(base, 'backups', quarantined[0]), 'utf8'),
        'the quarantine must hold the original corrupt bytes',
      ).toBe('{"schemaVersion":2,"revision":1,"workspaces":[')
      const primary = JSON.parse(await readFile(join(base, 'tenders-data.json'), 'utf8')) as {
        revision?: number
      }
      expect(primary.revision).toBe(1)

      // The app now loads the restored revision (no restart needed).
      await tenders.reload()
      await expect
        .poll(() => tenders.evaluate(() => Boolean(document.querySelector('nav'))), {
          timeout: 30_000,
          message: 'the Tenders renderer must come back after reload',
        })
        .toBe(true)
      await dismissTendersOnboarding(tenders)
      await expect(tenders.getByText(RESTORED_COMPANY).first()).toBeVisible({ timeout: 30_000 })
      const reloaded = await tenders.evaluate(async () => {
        const api = (window as unknown as { tendersApi: any }).tendersApi
        return api.loadStoreV2()
      })
      expect(reloaded.ok, JSON.stringify(reloaded.error)).toBe(true)
      expect((reloaded.data as { revision?: number })?.revision).toBe(1)
      screenshots.push(await shot(tenders, 'durability-j4-restored'))
      await closeAndSaveVideo(run, 'tenders-durability-j4')
      run = undefined

      // ── Part B: corrupt primary with NO candidates still errors ─────────────
      userDataDirB = await scratchUserData()
      await writeSeededStore(userDataDirB)
      await rm(join(tendersBaseDir(userDataDirB), 'backups'), {
        recursive: true,
        force: true,
      }).catch(() => undefined)
      await writeFile(
        join(tendersBaseDir(userDataDirB), 'tenders-data.json'),
        '{"schemaVersion":2,"revision":1,"workspaces":[',
        'utf8',
      )
      runB = await launchShell({
        userDataDir: userDataDirB,
        onboardingSeen: true,
        videoDir: 'tenders-durability-j4b',
      })
      const tendersB = await openTendersFromNav(runB.app, runB.page)
      const loadB = await tendersB.evaluate(async () => {
        const api = (window as unknown as { tendersApi: any }).tendersApi
        return api.loadStoreV2()
      })
      expect(loadB.ok, 'a corrupt store without candidates must not load').toBe(false)
      expect(loadB.error?.code).not.toBe('RECOVERY_REQUIRED')
      expect(loadB.recoveryCandidates, 'no candidates may be invented').toBeUndefined()
      await expect(
        tendersB.getByRole('heading', { name: /unable to load|recover/i }),
        'the error surface must be shown',
      ).toBeVisible({ timeout: 20_000 })
      await expect(
        tendersB.getByRole('heading', { name: 'No company workspaces yet' }),
        'an empty/first-use store must never be substituted',
      ).toHaveCount(0)
      screenshots.push(await shot(tendersB, 'durability-j4-no-candidates'))

      const result: JourneyResult = {
        journey:
          '4: RECOVERY_REQUIRED with candidates; explicit restore; no-candidates still errors',
        status: 'PASS',
        detail: `load refused (RECOVERY_REQUIRED, ${candidates.length} candidate(s), backup revision 3 valid); explicit restore quarantined the corrupt primary and committed the candidate content (revision 1); no-candidate corrupt store errored with code ${loadB.error?.code}`,
        evidence: {
          userDataDir,
          userDataDirB,
          candidates,
          quarantineFiles: backupFiles.filter((name) => name.startsWith('primary-corrupt-')),
          restoredRevision: (restored.data as { revision?: number })?.revision,
          noCandidatesError: { code: loadB.error?.code, message: loadB.error?.message },
        },
        screenshots,
      }
      await writeResult('tenders-durability-journey-4', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-durability-j4').catch(() => undefined)
      if (runB) await closeAndSaveVideo(runB, 'tenders-durability-j4b').catch(() => undefined)
      if (userDataDir)
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
      if (userDataDirB)
        await rm(userDataDirB, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('5: reconciliation reports missing and orphaned files without deleting anything', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      const booted = await bootDocuments('tenders-durability-j5')
      run = booted.run
      userDataDir = booted.userDataDir
      const tenders = booted.tenders
      await requireBridge(tenders, ['saveDocument', 'reconcileDocuments', 'listDocumentTrash'])
      const base = tendersBaseDir(userDataDir)

      // Tracked file A (via the bridge) + a dedicated untracked orphan.
      const trackedBytes = await (async () => {
        const source = join(tmpdir(), `e2e-dur-reconcile-${Date.now()}.pdf`)
        await generatePdf(source, 'E2E RECONCILE TRACKED', 1)
        return readFile(source)
      })()
      const created = await saveBridgeDocument(tenders, {
        fileName: 'e2e-reconcile.pdf',
        bytes: trackedBytes,
        category: 'rfp',
      })
      expect(created.ok, created.error ?? '').toBe(true)
      const trackedPath = created.record!.relativePath
      const orphanPath = 'documents/e2e-durability-orphan.pdf'
      await generatePdf(join(base, orphanPath), 'E2E DURABILITY ORPHAN', 1)

      const first = await reconcile(tenders)
      expect(
        first.orphaned,
        `the untracked drop must be reported orphaned (got ${JSON.stringify(first.orphaned)})`,
      ).toContain(orphanPath)
      expect(
        first.orphaned,
        'the seeded untracked files must also be reported (never auto-adopted silently)',
      ).toContain(SEEDED_RFP_PATH)
      expect(
        existsSync(join(base, orphanPath)),
        'reconciliation must never auto-delete an orphaned file',
      ).toBe(true)
      expect((await listTrash(tenders)).some((entry) => entry.deletedFrom === orphanPath)).toBe(
        false,
      )
      screenshots.push(await shot(tenders, 'durability-j5-orphans'))

      // Delete the tracked file behind the app's back → reported missing once.
      await rm(join(base, trackedPath), { force: true })
      const second = await reconcile(tenders)
      expect(
        second.missing.some((entry) => entry.relativePath === trackedPath),
        `the vanished tracked file must be reported missing (got ${JSON.stringify(second.missing)})`,
      ).toBe(true)
      const index = await readManagedIndex(userDataDir)
      const trackedRecord = index!.records.find((candidate) => candidate.id === created.record!.id)!
      expect(trackedRecord.state, 'the record must be marked missing, not deleted').toBe('missing')
      expect((await listTrash(tenders)).some((entry) => entry.deletedFrom === trackedPath)).toBe(
        false,
      )
      const third = await reconcile(tenders)
      expect(
        third.missing.some((entry) => entry.relativePath === trackedPath),
        'an already-missing record is not re-reported (state persisted in the index)',
      ).toBe(false)
      expect(third.activeCount).toBeGreaterThanOrEqual(0)
      screenshots.push(await shot(tenders, 'durability-j5-missing'))

      const result: JourneyResult = {
        journey: '5: reconcile reports orphaned + missing, deletes nothing',
        status: 'PASS',
        detail: `orphaned includes ${orphanPath} (file kept on disk); ${trackedPath} reported missing once and marked missing in the index; nothing auto-deleted or auto-trashed`,
        evidence: {
          userDataDir,
          trackedPath,
          orphanPath,
          firstReconcile: { orphaned: first.orphaned, activeCount: first.activeCount },
          secondReconcile: second,
          thirdReconcile: { missing: third.missing, activeCount: third.activeCount },
        },
        screenshots,
      }
      await writeResult('tenders-durability-journey-5', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-durability-j5').catch(() => undefined)
      if (userDataDir)
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('6: a failed saveDocument surfaces an alert and never presents a session blob as durable', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      const booted = await bootDocuments('tenders-durability-j6')
      run = booted.run
      userDataDir = booted.userDataDir
      const tenders = booted.tenders
      await requireBridge(tenders, ['saveDocument', 'listDocumentTrash'])

      const uploadSource = join(tmpdir(), `e2e-dur-forced-${Date.now()}.pdf`)
      await generatePdf(uploadSource, 'E2E DURABILITY FORCED FAILURE', 1)
      const vaultBefore = await listDirSafe(join(tendersBaseDir(userDataDir), 'vault'))
      const trashBefore = await listTrash(tenders)

      await forceSaveDocumentFailure(run.app, 'E2E forced save failure')

      await gotoDocuments(tenders)
      await tenders.getByRole('button', { name: 'Upload document' }).click()
      await expect(tenders.getByRole('heading', { name: 'Add company document' })).toBeVisible({
        timeout: 15_000,
      })
      await tenders.locator('input[type="file"][accept*="pdf"]').first().setInputFiles(uploadSource)
      await tenders
        .getByPlaceholder(/SARS Tax Clearance Certificate/i)
        .fill('E2E Durability Failed Upload')
      await tenders.getByRole('button', { name: 'Add to vault' }).click()

      const alert = tenders.getByRole('alert').filter({ hasText: 'E2E forced save failure' })
      await expect(alert, 'the save failure must surface as an alert').toBeVisible({
        timeout: 15_000,
      })
      await expect(
        tenders.getByRole('button', { name: /E2E Durability Failed Upload/ }),
        'nothing may be added as a stored document',
      ).toHaveCount(0)
      expect(
        await tenders.locator('[href^="blob:"], [src^="blob:"]').count(),
        'no blob URL may be presented as a durable stored file',
      ).toBe(0)
      expect(
        await listDirSafe(join(tendersBaseDir(userDataDir), 'vault')),
        'the failed save must not write to disk',
      ).toEqual(vaultBefore)
      expect((await listTrash(tenders)).length, 'no trash entry for a failed save').toBe(
        trashBefore.length,
      )
      screenshots.push(await shot(tenders, 'durability-j6-forced-failure'))

      const result: JourneyResult = {
        journey: '6: forced saveDocument failure → alert, no blob fallback, no durable write',
        status: 'PASS',
        detail:
          'the alert carried the main-process error; the document list gained nothing; no blob: URL was presented; the vault dir is byte-identical',
        evidence: { userDataDir, vaultBefore, trashCount: trashBefore.length },
        screenshots,
      }
      await writeResult('tenders-durability-journey-6', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-durability-j6').catch(() => undefined)
      if (userDataDir)
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('7: removing a tender warns about references then soft-deletes its RFP to .trash', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      const booted = await bootDocuments('tenders-durability-j7', { linkedRfp: true })
      run = booted.run
      userDataDir = booted.userDataDir
      const tenders = booted.tenders
      await requireBridge(tenders, ['deleteDocument', 'listDocumentTrash'])
      const base = tendersBaseDir(userDataDir)

      await gotoPage(tenders, 'Tenders')
      const removeButton = tenders
        .locator('main li', { hasText: TENDER_REF })
        .getByRole('button', { name: 'Remove tender' })
        .first()
      await expect(removeButton).toBeVisible({ timeout: 20_000 })

      // (c) pre-delete link warning lists the other referencing records.
      await removeButton.click()
      const dialog = tenders.locator('[data-testid="delete-tender-dialog"]')
      await expect(dialog, 'the removal confirmation must be an in-app dialog').toBeVisible({
        timeout: 10_000,
      })
      await expect(dialog).toContainText(/trash|recover/i)
      const links = tenders.locator('[data-testid="delete-tender-links"]')
      await expect(
        links,
        'the shared-RFP reference must be warned about before deletion',
      ).toBeVisible()
      await expect(links).toContainText(/E2E Durability Linked Tender|deal-e2e-1|milestone/i)
      screenshots.push(await shot(tenders, 'durability-j7-link-warning'))

      // (a) success: the RFP reaches .trash first, then the record leaves.
      await dialog.locator('[data-testid="delete-tender-confirm"]').click()
      const notice = tenders.locator('[data-testid="delete-tender-notice"]')
      await expect(notice, 'the success notice must say the RFP is recoverable').toBeVisible({
        timeout: 15_000,
      })
      await expect(notice).toContainText(/trash/i)
      await expect(notice).toContainText(/recover/i)
      // Capture the notice text while the Tenders page is still mounted (the
      // notice unmounts when the test navigates to the trash drawer).
      const noticeText = (await notice.textContent()) ?? ''
      await expect(tenders.locator('[data-testid="delete-tender-error"]')).toHaveCount(0)

      // The record removal persists through the renderer save pipeline
      // (debounced), so poll the store instead of a single read.
      await expect
        .poll(
          async () => {
            const doc = await readStoreDocument(userDataDir)
            return doc.workspaces?.[0]?.tenders?.some((tender) => tender.id === TENDER_ID) ?? true
          },
          { timeout: 15_000, message: 'the removed tender must leave tenders-data.json' },
        )
        .toBe(false)
      const afterSuccess = await readStoreDocument(userDataDir)
      expect(
        afterSuccess.workspaces?.[0]?.tenders?.some((tender) => tender.id === 't-dur-linked'),
        'the other referencing tender must remain',
      ).toBe(true)
      expect(
        existsSync(join(base, SEEDED_RFP_PATH)),
        'the RFP must no longer sit in the active documents dir',
      ).toBe(false)
      const trashFiles = await listDirSafe(trashDirFor(userDataDir))
      expect(
        trashFiles.length,
        `the RFP must be present under .trash (got ${JSON.stringify(trashFiles)})`,
      ).toBeGreaterThan(0)
      const trashEntries = (await listTrash(tenders)).filter(
        (entry) => entry.deletedFrom === SEEDED_RFP_PATH,
      )
      expect(trashEntries.length, 'the soft-deleted RFP must have a trash entry').toBe(1)
      expect(existsSync(join(base, trashEntries[0].trashedPath))).toBe(true)

      // The trash drawer surfaces the entry (restore handle).
      await gotoPage(tenders, 'Documents')
      await tenders.locator('[data-testid="documents-trash-button"]').click()
      const panel = tenders.locator('[data-testid="documents-trash-panel"]')
      await expect(panel).toBeVisible({ timeout: 10_000 })
      await expect(panel.locator(`[data-testid="trash-entry-${trashEntries[0].id}"]`)).toBeVisible()
      screenshots.push(await shot(tenders, 'durability-j7-trash-drawer'))

      const result: JourneyResult = {
        journey: '7: tender removal — link warning + soft-delete to .trash',
        status: 'PASS',
        detail: `pre-delete warning listed the shared reference; success moved ${SEEDED_RFP_PATH} to ${trashEntries[0].trashedPath}, removed the record, and the trash drawer shows the entry`,
        evidence: {
          userDataDir,
          trashedPath: trashEntries[0].trashedPath,
          trashId: trashEntries[0].id,
          noticeText,
        },
        screenshots,
      }
      await writeResult('tenders-durability-journey-7', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-durability-j7').catch(() => undefined)
      if (userDataDir)
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('8: tender removal is fail-closed — a failed RFP soft-delete keeps the record', async () => {
    const screenshots: string[] = []
    let run: LaunchedApp | undefined
    let userDataDir = ''
    try {
      const booted = await bootDocuments('tenders-durability-j8')
      run = booted.run
      userDataDir = booted.userDataDir
      const tenders = booted.tenders
      await requireBridge(tenders, ['deleteDocument', 'listDocumentTrash'])
      const base = tendersBaseDir(userDataDir)

      // Force the managed soft-delete to fail before the removal is attempted.
      await forceDeleteDocumentFailure(run.app, 'E2E forced delete failure')

      await gotoPage(tenders, 'Tenders')
      const removeButton = tenders
        .locator('main li', { hasText: TENDER_REF })
        .getByRole('button', { name: 'Remove tender' })
        .first()
      await expect(removeButton).toBeVisible({ timeout: 20_000 })
      await removeButton.click()
      const dialog = tenders.locator('[data-testid="delete-tender-dialog"]')
      await expect(dialog, 'the removal confirmation must be an in-app dialog').toBeVisible({
        timeout: 10_000,
      })
      await dialog.locator('[data-testid="delete-tender-confirm"]').click()

      const errorBar = tenders.locator('[data-testid="delete-tender-error"]')
      await expect(errorBar, 'the failure must surface as an alert').toBeVisible({
        timeout: 15_000,
      })
      await expect(errorBar).toContainText('E2E forced delete failure')
      await expect(tenders.locator('[data-testid="delete-tender-notice"]')).toHaveCount(0)
      screenshots.push(await shot(tenders, 'durability-j8-fail-closed'))

      // The record and its RFP survive; nothing reached the trash.
      const afterFailure = await readStoreDocument(userDataDir)
      expect(
        afterFailure.workspaces?.[0]?.tenders?.some((tender) => tender.id === TENDER_ID),
        'a failed soft-delete must keep the tender record',
      ).toBe(true)
      expect(existsSync(join(base, SEEDED_RFP_PATH))).toBe(true)
      expect(
        (await listTrash(tenders)).filter((entry) => entry.deletedFrom === SEEDED_RFP_PATH).length,
        'a failed soft-delete must not create a trash entry',
      ).toBe(0)

      const result: JourneyResult = {
        journey: '8: tender removal fail-closed on a managed soft-delete failure',
        status: 'PASS',
        detail: `forced delete-document failure kept ${TENDER_ID} in tenders-data.json and ${SEEDED_RFP_PATH} on disk; delete-tender-error showed the main-process message; no trash entry was created`,
        evidence: {
          userDataDir,
          errorText: await errorBar.textContent(),
        },
        screenshots,
      }
      await writeResult('tenders-durability-journey-8', result)
    } finally {
      if (run) await closeAndSaveVideo(run, 'tenders-durability-j8').catch(() => undefined)
      if (userDataDir)
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
