/**
 * DOCX intake, end to end — the user-facing half of the Word-import feature.
 *
 * A .docx is a first-class import: chosen through the same file input as a PDF,
 * read by the same local pipeline, shredded into the same compliance matrix, and
 * persisted to the same store. Everything a surface decides differently for a
 * Word document is asserted here against the BUILT shell, not against a
 * component:
 *
 *   1. the import lands and the requirements matrix is populated from the
 *      .docx's own text (the four clauses below hit four known rules);
 *   2. the tender is persisted with the document's own page count and its
 *      requirements on disk — and still there after a restart;
 *   3. the source pane shows the clause TEXT, because a .docx has no rendered
 *      page to highlight a clause on, and the pane states the pagination note
 *      the intake module produced ("not printed page numbers");
 *   4. the PDF failure state is never reached: a Word document is not handed to
 *      pdfjs, which could only fail and would report a document that was read
 *      perfectly as "the tender PDF could not be opened";
 *   5. the review step keeps the same vocabulary — no page of a .docx was
 *      scanned, so none of its copy says so.
 *
 * The .docx fixture is built here, in-test, as a real (minimal) OOXML package:
 * a .docx is a zip of XML, so there is no binary fixture to commit and no
 * network anywhere in this spec. Scratch `userData` under
 * `%LOCALAPPDATA%\Temp\opencode`; no app-source edits.
 */
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import JSZip from 'jszip'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  launchShell,
  closeAndSaveVideo,
  waitForPageWithUrl,
  screenshotPath,
  type LaunchedApp,
} from './helpers'
import { readStore, pollStore, STORE_IMPORT_POLL_MS } from './tenders-timing'

/** `%LOCALAPPDATA%\Temp\opencode` on Windows (os.tmpdir() is %TEMP%). */
const SCRATCH_ROOT = join(tmpdir(), 'opencode')

const COMPANY_ONE = 'E2E DOCX Intake Civils (Pty) Ltd'
const DOCX_FILE_NAME = 'e2e-docx-rfp.docx'

/** The four clauses below are the ones the local rules recognise. */
const TAX_CLAUSE =
  'Bidders must submit a valid SARS Tax Clearance Certificate or TCS PIN confirming tax compliance at bid closing.'
const CSD_CLAUSE =
  'A valid Central Supplier Database (CSD) registration report must accompany the bid.'
const BEE_CLAUSE =
  'A certified copy of the B-BBEE certificate or a sworn affidavit must be included.'
const COIDA_CLAUSE =
  'A letter of good standing from the Compensation Commissioner (COIDA) is required.'

/** The rule keys those clauses must produce (`src/shared/rules.ts`). */
const EXPECTED_RULE_KEYS = ['tax_pin', 'csd', 'bbbee', 'coida']

/** The rule title the source pane must show for the tax clause. */
const TAX_RULE_TITLE = 'Valid SARS Tax Clearance / TCS PIN'

// ── the .docx fixture ────────────────────────────────────────────────────────

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

const DOC_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const P = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`

/**
 * A one-section Word document with a cover block and four requirement clauses.
 * It declares NO page break, so the app must present it as one continuous block
 * of text and must not print "1 page" for it.
 */
async function buildRfpDocx(): Promise<Buffer> {
  const zip = new JSZip()
  const contentTypes =
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  zip.file(
    '[Content_Types].xml',
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${contentTypes}</Types>`,
  )
  zip.file(
    '_rels/.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  )
  const body =
    P('REQUEST FOR PROPOSALS') +
    P('Zanostack Bulk Water Pipeline Upgrade Phase 2') +
    P('Reference Number: DWS/RFP-2026/0034') +
    P('Closing Date: 30 November 2026') +
    P('DEPARTMENT OF WATER AND SANITATION') +
    P('Proposals must be delivered to the bid box at 185 Francis Baai Drive, Pretoria') +
    P(TAX_CLAUSE) +
    P(CSD_CLAUSE) +
    P(BEE_CLAUSE) +
    P(COIDA_CLAUSE)
  zip.file(
    'word/document.xml',
    `${XML_DECL}<w:document ${DOC_NS}><w:body>${body}` +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
      '</w:body></w:document>',
  )
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// ── scratch + store helpers ──────────────────────────────────────────────────

async function scratchUserData(): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  return mkdtemp(join(SCRATCH_ROOT, 'genoffice-e2e-'))
}

function storeFile(userDataDir: string): string {
  return join(userDataDir, 'tenders', 'tenders-data.json')
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

function findTender(store: any, fileName: string): any | undefined {
  for (const workspace of store?.workspaces ?? []) {
    for (const tender of workspace?.tenders ?? []) {
      if (tender?.fileName === fileName) return tender
    }
  }
  return undefined
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

// ── journeys ─────────────────────────────────────────────────────────────────

test.describe('Tenders DOCX intake', () => {
  test.describe.configure({ timeout: 600_000 })

  test('1: a Word .docx imports through the file input, populates the matrix and persists', async () => {
    const screenshots: string[] = []
    let run1: LaunchedApp | undefined
    let run2: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      const docxPath = join(userDataDir, DOCX_FILE_NAME)
      await writeFile(docxPath, await buildRfpDocx())

      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-docx-intake-run1',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)
      await createCompanyViaFirstUse(tenders, COMPANY_ONE)

      // The Tenders list — which owns the dropzone and the file input — is only
      // mounted once the sidebar's Tenders item is chosen.
      await gotoPage(tenders, 'Tenders')
      await expect(tenders.getByRole('heading', { name: 'Tenders', level: 1 })).toBeVisible({
        timeout: 20_000,
      })

      // (1) The file input offers Word documents, and the import runs the same
      // path a PDF does.
      const importInput = tenders.locator('input[type="file"][accept*="docx"]')
      await expect(importInput, 'the intake file input must accept a Word .docx').toHaveCount(1)
      await importInput.setInputFiles(docxPath)

      const matrix = tenders.getByRole('heading', { name: 'Compliance matrix' })
      await expect(matrix).toBeVisible({ timeout: 90_000 })
      // The locate affordance is offered in the wording of the source this tender
      // actually is: a .docx has no pages to highlight, so its rows point at the
      // source pane, and the PDF wording must not appear for it.
      await expect(
        tenders.getByText(/\d+ requirements · click to locate in source pane/),
      ).toBeVisible({ timeout: 30_000 })
      await expect(tenders.getByText(/click to locate in PDF/)).toHaveCount(0)

      // (3) The source pane shows the clause TEXT: a .docx has no rendered page,
      // so there is no page highlight a clause could be located on.
      const sourcePane = tenders.locator('[data-testid="word-source-pane"]')
      await expect(sourcePane).toBeVisible({ timeout: 30_000 })
      await expect(sourcePane).toContainText(TAX_RULE_TITLE)
      await expect(sourcePane).toContainText('SARS Tax Clearance Certificate')
      await expect(
        sourcePane,
        'the pane must state how the page numbers were derived',
      ).toContainText('presented as one continuous block of text')

      // Locating a requirement in the matrix lands on its clause in the source
      // pane: a .docx has no page to highlight, so the jump must show the text.
      await tenders
        .locator('[data-testid="workspace-matrix-pane"]')
        .getByRole('button', { name: TAX_RULE_TITLE })
        .first()
        .click()
      await expect(
        sourcePane.locator('[data-active="true"]'),
        'the located requirement must be marked in the source pane',
      ).toContainText(TAX_RULE_TITLE)

      // (4) pdfjs was never asked to open a Word document.
      await expect(
        tenders.getByText('The tender PDF could not be opened'),
        'a .docx must not be reported as an unreadable PDF',
      ).toHaveCount(0)
      await expect(tenders.getByText('Opening PDF…')).toHaveCount(0)
      screenshots.push(await shot(tenders, 'docx-intake-matrix-and-source'))

      // (2) The requirements matrix was populated from the .docx's own text and
      // committed to disk.
      const committed = await pollStore(
        userDataDir,
        (s) => (findTender(s, DOCX_FILE_NAME)?.requirements?.length ?? 0) > 0,
      )
      const tender = findTender(committed, DOCX_FILE_NAME)
      expect(tender, 'the imported .docx tender must be persisted').toBeTruthy()
      const ruleKeys: string[] = (tender.requirements ?? []).map((r: any) => r.ruleKey)
      for (const key of EXPECTED_RULE_KEYS) {
        expect(ruleKeys, `the .docx text must produce the ${key} requirement`).toContain(key)
      }
      // The document declares no page break, so it is ONE page to this app — the
      // whole file — and the record keeps that count, not a fabricated one.
      expect(tender.numPages).toBe(1)
      expect(tender.ocrPages).toBe(0)
      const taxRequirement = (tender.requirements ?? []).find((r: any) => r.ruleKey === 'tax_pin')
      expect(taxRequirement.verbatimClause).toContain('SARS Tax Clearance Certificate')
      expect(taxRequirement.pageNumber).toBe(1)

      // (5) The review step keeps the Word vocabulary: no page was scanned.
      await tenders.getByRole('button', { name: 'Review extraction' }).click()
      const paginationNote = tenders.locator('[data-testid="docx-pagination-note"]')
      await expect(paginationNote).toBeVisible({ timeout: 20_000 })
      await expect(paginationNote).toContainText('not printed page numbers')
      const pageReview = tenders.locator('section[aria-label="Page review"]')
      await expect(pageReview).toBeVisible({ timeout: 20_000 })
      await expect(pageReview).toContainText('This .docx was read in full')
      await expect(
        pageReview,
        'a .docx page was never scanned, so the review step must not say it was',
      ).not.toContainText('scanned')
      screenshots.push(await shot(tenders, 'docx-intake-review-vocabulary'))
      await tenders.getByRole('button', { name: 'Back to matrix' }).click()

      await expectStoreStable(userDataDir, await storeSignature(userDataDir))
      await closeAndSaveVideo(run1, 'tenders-docx-intake-run1')
      run1 = undefined

      // (2) Restart: the Word tender is still there, with its matrix and its
      // source pane — the stored .docx is re-read, never mistaken for a PDF.
      // The active tender is persisted, so the app reopens inside its workspace.
      run2 = await launchShell({ userDataDir, videoDir: 'tenders-docx-intake-run2' })
      const tenders2 = await openTendersFromNav(run2.app, run2.page)
      await dismissTendersOnboarding(tenders2)
      await expect(tenders2.getByRole('heading', { name: tender.title, level: 1 })).toBeVisible({
        timeout: 30_000,
      })
      await expect(tenders2.getByRole('heading', { name: 'Compliance matrix' })).toBeVisible({
        timeout: 30_000,
      })
      const sourcePane2 = tenders2.locator('[data-testid="word-source-pane"]')
      await expect(sourcePane2).toBeVisible({ timeout: 30_000 })
      await expect(sourcePane2).toContainText(TAX_RULE_TITLE)
      await expect(
        tenders2.getByText('The tender PDF could not be opened'),
        'a stored .docx must not be re-opened as a PDF after a restart',
      ).toHaveCount(0)
      screenshots.push(await shot(tenders2, 'docx-intake-restart'))

      // Back to the list: the card states what the document is instead of
      // printing "1 page" for it.
      await tenders2.locator('main').getByRole('button', { name: 'Tenders' }).first().click()
      const card = tenders2.locator('[data-testid="tender-card"]').first()
      await expect(card).toBeVisible({ timeout: 20_000 })
      await expect(card).toContainText('1 continuous block of text (no page breaks declared)')
      // The matrix the card counts is the one on disk, so the count is derived
      // from the store rather than pinned to a number this spec guesses.
      await expect(card, 'the persisted matrix must be on the card').toContainText(
        `0/${tender.requirements.length} fulfilled`,
      )

      const afterRestart = await readStore(userDataDir)
      const persisted = findTender(afterRestart, DOCX_FILE_NAME)
      expect(persisted, 'the .docx tender must survive a restart').toBeTruthy()
      expect((persisted.requirements ?? []).length).toBe(tender.requirements.length)
    } finally {
      if (run1) await closeAndSaveVideo(run1, 'tenders-docx-intake-run1').catch(() => undefined)
      if (run2) await closeAndSaveVideo(run2, 'tenders-docx-intake-run2').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  /**
   * The other half of the same guard: a document intake cannot read is refused
   * with a typed reason instead of being shredded into an empty tender. A legacy
   * .doc (a CFB container) wearing the .docx extension is the case the intake
   * module names explicitly.
   */
  test('2: a file that is not a real .docx is refused with a reason, not shredded', async () => {
    let run1: LaunchedApp | undefined
    let userDataDir = ''
    try {
      userDataDir = await scratchUserData()
      // A CFB/OLE header: a password-protected or legacy Word file renamed.
      const notADocx = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x01])
      const fakePath = join(userDataDir, 'legacy-word.docx')
      await writeFile(fakePath, notADocx)

      run1 = await launchShell({
        userDataDir,
        onboardingSeen: true,
        videoDir: 'tenders-docx-intake-run3',
      })
      const tenders = await openTendersFromNav(run1.app, run1.page)
      await createCompanyViaFirstUse(tenders, COMPANY_ONE)
      await gotoPage(tenders, 'Tenders')

      await tenders.locator('input[type="file"][accept*="docx"]').setInputFiles(fakePath)
      const alert = tenders.getByRole('alert')
      await expect(alert).toBeVisible({ timeout: 30_000 })
      await expect(alert).toContainText(/password-protected or legacy Word file/i)
      // Nothing was imported: a refused file must not leave an empty tender.
      await expect(tenders.locator('[data-testid="tender-card"]')).toHaveCount(0)
      const store = await readStore(userDataDir)
      expect(
        (activeWorkspace(store)?.tenders ?? []).length,
        'no tender may be persisted from a refused file',
      ).toBe(0)
      await shot(tenders, 'docx-intake-refused')
    } finally {
      if (run1) await closeAndSaveVideo(run1, 'tenders-docx-intake-run3').catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
