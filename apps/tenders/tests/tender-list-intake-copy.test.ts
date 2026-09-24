// Tender-list intake honesty — the audit's failing cases, locked in.
//
// Three defects are covered here as real unit tests, because all three are pure
// logic that the renderer previously got wrong:
//
//   1. The demo loader fell back to `/demo/sample-rfp.pdf` only when the first
//      `fetch` REJECTED. A missing asset answers with a non-OK response (404)
//      under `file://`, so the fallback never fired and the user saw a generic
//      "Demo RFP could not be loaded." `fetchDemoRfp` now falls back on a
//      non-OK response too, and reports which URL answered what.
//   2. The document store reports raw I/O errors (`EPERM: …`, absolute paths).
//      Those were interpolated straight into a `role="alert"`;
//      `persistFailureReason` turns them into plain language.
//   3. The bundled demo assets were addressed as `/demo/…`. Under `file://` that
//      resolves to the DRIVE ROOT (`file:///C:/demo/…`), so every demo vault PDF
//      was unreachable; and each call site decided "demo or managed?" with its own
//      `/demo` prefix test. The stored demo domain must keep those exact bytes
//      (they are the frozen snapshot v1→v2 demo recognition compares), so
//      `openDemoAsset` resolves them to the document-relative `./demo/…` form that
//      `publicDir` actually ships, and one shared `isDemoAssetUrl` answers the
//      "demo or managed?" question at every call site.
//
// The demo-import marker is also asserted to be PERSISTED
// (`TenderRecord.dataOrigin`) rather than a session-scoped renderer Set, so the
// "Demo import" badge and the list note survive a restart. The schema half of
// that is checked here too: `'demo'` validates, `'user'` is rejected.
//
// The copy assertions guard the single-PDF intake wording and the honesty of
// the tutorial's readiness weights and vault-linking instructions — the
// phrases the audit found to be wrong (a "RFP pack" that intake rejects, a
// read-only drawer described as a linking surface, four dimensions quoted for
// five weights, and browser wording in a desktop app).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEMO_TENDER_HINT,
  fetchDemoRfp,
  isDemoTender,
  persistFailureReason,
} from '../src/renderer/src/components/TenderList'
import { demoAssetRelativeUrl, MOCK_VAULT, openDemoAsset } from '../src/renderer/src/mock/vault'
import { TENDERS_SCHEMA_VERSION, validateTendersDataV2 } from '../src/shared/tenders-schema'
import { isDemoAssetUrl } from '../src/shared/types'
import type {
  CompanyProfile,
  TenderRecord,
  TendersDataV2,
  TendersWorkspaceV2,
} from '../src/shared/types'

/** Locate `apps/tenders/src/renderer/src` from either cwd (`-w` or repo root). */
function resolveRendererSrc(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const fromRepoRoot = join(dir, 'apps', 'tenders', 'src', 'renderer', 'src')
    if (existsSync(fromRepoRoot)) return fromRepoRoot
    const fromWorkspace = join(dir, 'src', 'renderer', 'src')
    if (existsSync(fromWorkspace)) return fromWorkspace
    dir = dirname(dir)
  }
  throw new Error('Could not locate apps/tenders/src/renderer/src from ' + process.cwd())
}

const SRC = resolveRendererSrc()

/** Reduce a source file to the copy a user could actually read. */
function copyText(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join(' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Source with comments removed and code intact. Structural guards ("this file
 * calls the shared predicate") match against this rather than the raw file: a
 * raw-source regex is satisfied by a comment that merely names the pattern, and
 * broken by a comment that documents the old one. `copyText` is not usable here
 * — collapsing JSX tags would also collapse the call sites themselves.
 */
function codeText(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

function response(ok: boolean, status: number): Response {
  return { ok, status } as Response
}

describe('demo RFP loader', () => {
  it('falls back to the second candidate when the first answers 404', async () => {
    const fetchImpl = vi
      .fn<(input: string) => Promise<Response>>()
      .mockResolvedValueOnce(response(false, 404))
      .mockResolvedValueOnce(response(true, 200))

    const result = await fetchDemoRfp(fetchImpl)

    expect(result.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0][0]).toBe('./demo/sample-rfp.pdf')
    expect(fetchImpl.mock.calls[1][0]).toBe('/demo/sample-rfp.pdf')
  })

  it('falls back when the first candidate rejects outright', async () => {
    const fetchImpl = vi
      .fn<(input: string) => Promise<Response>>()
      .mockRejectedValueOnce(new Error('Fetch API cannot load file:///demo/sample-rfp.pdf'))
      .mockResolvedValueOnce(response(true, 200))

    const result = await fetchDemoRfp(fetchImpl)

    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('tries every candidate before failing, and names what each one answered', async () => {
    const fetchImpl = vi
      .fn<(input: string) => Promise<Response>>()
      .mockResolvedValueOnce(response(false, 404))
      .mockRejectedValueOnce(new Error('Failed to fetch'))

    await expect(fetchDemoRfp(fetchImpl)).rejects.toThrow(
      /no demo asset: \.\/demo\/sample-rfp\.pdf → HTTP 404; \/demo\/sample-rfp\.pdf → Failed to fetch/,
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('demo import tagging', () => {
  it('labels a tender imported from the bundled sample RFP', () => {
    // The marker is the persisted per-tender flag, so it is still there after a
    // restart — a session Set could not be.
    expect(isDemoTender({})).toBe(false)
    expect(isDemoTender({ dataOrigin: undefined })).toBe(false)
    expect(isDemoTender({ dataOrigin: 'demo' })).toBe(true)
    expect(DEMO_TENDER_HINT).toMatch(/not a real tender/i)
  })

  it('keeps the marker on the record, not in a module-level session Set', () => {
    // Comment-stripped: a comment naming the old Set must not fail the guard,
    // and a comment naming the flag must not satisfy it.
    const code = codeText('components/TenderList.tsx')
    expect(code, 'the session-scoped tag must be gone').not.toMatch(/demoImportedTenderIds/)
    expect(code, 'the card must read the persisted flag').toMatch(/dataOrigin === 'demo'/)
    expect(code, 'the demo import must set the persisted flag').toMatch(/dataOrigin: 'demo'/)
  })
})

const AT = '2026-09-01T00:00:00.000Z'

function company(): CompanyProfile {
  return {
    name: 'Test Co',
    tradingName: 'Test Co',
    registrationNumber: 'REG-1',
    vatNumber: 'VAT-1',
    taxPin: 'TAX-1',
    bbbeeLevel: 'Level 2',
    bbbeeBlackOwnership: '51%',
    csdSupplierNumber: 'CSD-1',
    founded: '2019',
    employees: '25',
    industry: 'Construction',
    description: 'Synthetic company.',
    address: '1 Test Street',
    phone: '+27 10 000 0000',
    email: 'test@example.test',
    website: 'https://example.test',
    directors: [],
    projects: [],
  }
}

function documentV2(tenderRecord: TenderRecord): TendersDataV2 {
  const workspace: TendersWorkspaceV2 = {
    id: 'ws-1',
    name: 'Test Co',
    dataOrigin: 'user',
    company: company(),
    customers: [],
    vault: [],
    tenders: [tenderRecord],
  }
  return {
    schemaVersion: TENDERS_SCHEMA_VERSION,
    revision: 0,
    updatedAt: AT,
    activeCompanyId: 'ws-1',
    workspaces: [workspace],
    issuerTemplates: [],
  }
}

function tender(overrides: Partial<TenderRecord> = {}): TenderRecord {
  return {
    id: 'tender-1',
    title: 'Supply and Delivery of Office Computers',
    referenceNumber: 'ICT/2026/041',
    issuingBody: 'Provincial Administration Office',
    closingDate: '2026-12-18',
    submissionMethod: 'ELECTRONIC',
    submissionAddress: null,
    signatureChecks: {},
    status: 'IN_PROGRESS',
    createdAt: AT,
    fileName: 'rfp.pdf',
    fileUrl: 'documents/rfp.pdf',
    numPages: 4,
    ocrPages: 0,
    requirements: [],
    ...overrides,
  }
}

describe('per-tender dataOrigin', () => {
  it('accepts a persisted demo marker and returns it unchanged', () => {
    const result = validateTendersDataV2(documentV2(tender({ dataOrigin: 'demo' })))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.workspaces[0].tenders[0].dataOrigin).toBe('demo')
    }
  })

  it('validates a document without the field exactly as before', () => {
    const result = validateTendersDataV2(documentV2(tender()))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect('dataOrigin' in result.data.workspaces[0].tenders[0]).toBe(false)
    }
  })

  it('rejects any value that would claim user provenance', () => {
    for (const value of ['user', 'USER', 'imported', '', 1, null, {}]) {
      const result = validateTendersDataV2(
        documentV2(tender({ dataOrigin: value as unknown as 'demo' })),
      )
      expect(result.ok, `dataOrigin ${JSON.stringify(value)} must not validate`).toBe(false)
      if (!result.ok) {
        expect(result.issues.map((issue) => issue.path)).toContain(
          'workspaces.0.tenders.0.dataOrigin',
        )
      }
    }
  })
})

/**
 * The dimension name the tutorial copy uses for each scored readiness check id.
 * A scored check with no entry here fails the weight guard rather than being
 * skipped, so a new scored dimension cannot ship unquoted.
 */
const CHECK_DIMENSION_LABEL: Record<string, string> = {
  requirements: 'requirements',
  'docs-at-closing': 'closing date',
  deadline: 'deadline',
  signatures: 'signature checklist',
  'company-details': 'company details',
}

/**
 * The non-zero `CHECK_WEIGHTS` from `shared/readiness.ts`, parsed from source
 * because the module keeps the table private. Reading the weights from the
 * implementation is the point: a guard that hardcodes them can be kept green by
 * changing the copy and the guard together.
 */
function scoredCheckWeights(): Record<string, number> {
  const source = readFileSync(join(SRC, '..', '..', 'shared', 'readiness.ts'), 'utf8')
  const start = source.indexOf('const CHECK_WEIGHTS')
  if (start < 0) throw new Error('shared/readiness.ts no longer declares CHECK_WEIGHTS')
  const open = source.indexOf('{', start)
  const body = source.slice(open + 1, source.indexOf('}', open))
  const weights: Record<string, number> = {}
  for (const [, id, weight] of body.matchAll(/['"]?([a-z][a-z-]*)['"]?:\s*(\d+)/g)) {
    if (Number(weight) > 0) weights[id] = Number(weight)
  }
  if (Object.keys(weights).length === 0) {
    throw new Error('CHECK_WEIGHTS parsed empty — the guard would check nothing')
  }
  return weights
}

/** Every call site that has to decide "bundled demo asset, or managed file?". */
const DEMO_URL_CALL_SITES = [
  'components/TenderList.tsx',
  'components/VaultDrawer.tsx',
  'components/pages/DocumentsPage.tsx',
]

/**
 * The hand-rolled "is this a demo asset?" tests the shared predicate replaced:
 * `startsWith('/demo')` (also `'./demo'`), `includes('/demo…')`, `indexOf('/demo…')`.
 * Each of the three files carried at least one of them.
 */
const HAND_ROLLED_DEMO_URL_TEST =
  /startsWith\(\s*['"`]\.?\/demo|\.includes\(\s*['"`]\.?\/demo|indexOf\(\s*['"`]\.?\/demo/

describe('bundled demo asset URLs', () => {
  it('keeps the stored demo domain byte-frozen and reachable only via its resolved form', () => {
    const withFile = MOCK_VAULT.filter((doc) => doc.fileUrl !== null)
    expect(withFile.length).toBeGreaterThan(0)
    for (const doc of withFile) {
      // The stored value is part of the frozen historical demo snapshot that
      // v1→v2 demo recognition compares in full — editing it would reclassify an
      // existing on-disk v1 demo file as `user` data.
      expect(doc.fileUrl, `${doc.id} must keep the frozen demo shape`).toMatch(
        /^\/demo\/vault\/[a-z-]+\.pdf$/,
      )
      expect(isDemoAssetUrl(doc.fileUrl)).toBe(true)
      expect(demoAssetRelativeUrl(doc.fileUrl ?? '')).toMatch(/^\.\/demo\/vault\/[a-z-]+\.pdf$/)
    }
  })

  it('resolves next to the renderer document only after repair', () => {
    const base = 'file:///C:/app/out/renderer/index.html'
    const stored = MOCK_VAULT.find((doc) => doc.id === 'vd-tax')?.fileUrl ?? ''
    // The defect: the stored shape resolves to the drive root, which is why every
    // demo vault PDF was unreachable in every build.
    expect(new URL(stored, base).href).toBe('file:///C:/demo/vault/tax-clearance.pdf')
    // The fix: the repaired shape resolves to the asset publicDir ships.
    expect(new URL(demoAssetRelativeUrl(stored), base).href).toBe(
      'file:///C:/app/out/renderer/demo/vault/tax-clearance.pdf',
    )
  })

  it('recognises a demo asset and refuses to mistake one for a managed path', () => {
    expect(isDemoAssetUrl('./demo/vault/tax-clearance.pdf')).toBe(true)
    expect(isDemoAssetUrl('/demo/vault/tax-clearance.pdf')).toBe(true)
    expect(isDemoAssetUrl('documents/9f3.pdf')).toBe(false)
    expect(isDemoAssetUrl('vault/tax.pdf')).toBe(false)
    expect(isDemoAssetUrl('blob:file:///abc')).toBe(false)
    expect(isDemoAssetUrl(null)).toBe(false)
    expect(isDemoAssetUrl(undefined)).toBe(false)
  })

  it('repairs the legacy absolute shape before fetching it', () => {
    expect(demoAssetRelativeUrl('/demo/vault/coida-good-standing.pdf')).toBe(
      './demo/vault/coida-good-standing.pdf',
    )
    expect(demoAssetRelativeUrl('./demo/vault/coida-good-standing.pdf')).toBe(
      './demo/vault/coida-good-standing.pdf',
    )
  })

  it('answers "demo or managed?" in one place, not per call site', () => {
    for (const file of DEMO_URL_CALL_SITES) {
      // Comment-stripped, so neither assertion can be met (or broken) by prose:
      // a dead `import { isDemoAssetUrl }` leaves no call, and the import line
      // itself is the only mention a mention-shaped regex would accept.
      const code = codeText(file)
      expect(code, `${file} must call the shared isDemoAssetUrl predicate`).toMatch(
        /isDemoAssetUrl\s*\(/,
      )
      expect(code, `${file} must not hand-roll a /demo prefix check`).not.toMatch(
        HAND_ROLLED_DEMO_URL_TEST,
      )
    }
  })

  it('the "one shared predicate" guard rejects what it replaced', () => {
    // The exact pre-fix (HEAD) tests: each must be caught...
    expect("if (!url.startsWith('/demo')) return url").toMatch(HAND_ROLLED_DEMO_URL_TEST)
    expect("url.startsWith('/demo') ? 'demo' : 'managed'").toMatch(HAND_ROLLED_DEMO_URL_TEST)
    expect("if (url.includes('/demo/vault')) return null").toMatch(HAND_ROLLED_DEMO_URL_TEST)
    // ...while the shared call that replaced them is accepted.
    expect('if (isDemoAssetUrl(url)) return null').not.toMatch(HAND_ROLLED_DEMO_URL_TEST)
    // A mention without a call (a dead import) does not pass as a call site.
    expect("import { isDemoAssetUrl } from '../../shared/types'").not.toMatch(/isDemoAssetUrl\s*\(/)
    expect(DEMO_URL_CALL_SITES).toHaveLength(3)
  })
})

describe('opening a bundled demo asset', () => {
  const objectUrl = 'blob:file:///stub-demo-object-url'
  const originalCreateObjectURL = (URL as { createObjectURL?: unknown }).createObjectURL
  const originalRevokeObjectURL = (URL as { revokeObjectURL?: unknown }).revokeObjectURL
  const originalWindowOpen = window.open

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    Object.assign(URL, {
      createObjectURL: originalCreateObjectURL,
      revokeObjectURL: originalRevokeObjectURL,
    })
    Object.defineProperty(window, 'open', {
      configurable: true,
      writable: true,
      value: originalWindowOpen,
    })
  })

  /** jsdom implements neither `URL.createObjectURL` nor a real `window.open`. */
  function stubPlatform(open: (url: string) => unknown): void {
    Object.assign(URL, {
      createObjectURL: vi.fn(() => objectUrl),
      revokeObjectURL: vi.fn(),
    })
    Object.defineProperty(window, 'open', { configurable: true, writable: true, value: open })
  }

  it('reads the asset and opens a blob URL, the one route the view allows', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, blob: async () => ({}) }))
    vi.stubGlobal('fetch', fetchImpl)
    const open = vi.fn(() => ({}))
    stubPlatform(open)

    await openDemoAsset('/demo/vault/tax-clearance.pdf')

    // Fetched in the repaired, document-relative form…
    expect(fetchImpl).toHaveBeenCalledWith('./demo/vault/tax-clearance.pdf')
    // …and handed to the window as a blob: URL, never as the file: URL the
    // navigation policy denies.
    expect(open).toHaveBeenCalledWith(objectUrl, '_blank')
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(objectUrl)
  })

  it('reports a readable reason when the asset answers non-OK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 })),
    )
    stubPlatform(vi.fn(() => ({})))

    await expect(openDemoAsset('./demo/vault/tax-clearance.pdf')).rejects.toThrow(
      /bundled demonstration file could not be read \(the bundled file answered HTTP 404\)/,
    )
  })

  it('reports a blocked window instead of failing silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, blob: async () => ({}) })),
    )
    stubPlatform(vi.fn(() => null))

    await expect(openDemoAsset('./demo/vault/tax-clearance.pdf')).rejects.toThrow(
      /window was blocked/,
    )
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(objectUrl)
  })
})

describe('document-store failure wording', () => {
  it('never echoes a raw filesystem error', () => {
    const reason = persistFailureReason(
      "EPERM: operation not permitted, open 'C:\\Users\\x\\AppData\\tenders-data.json'",
    )
    expect(reason).not.toMatch(/EPERM|AppData|\\\\/)
    expect(reason).toMatch(/could not write it to this machine/)
  })

  it('passes through a store-authored size message', () => {
    expect(persistFailureReason('Document exceeds the upload limit.')).toMatch(/too large/)
    expect(persistFailureReason('Managed-document metadata limit reached.')).toMatch(/too large/)
  })

  it('describes an absent reason too', () => {
    expect(persistFailureReason(null)).toMatch(/could not write it to this machine/)
  })
})

describe('intake and tutorial copy honesty', () => {
  const OWNED = [
    'components/TenderList.tsx',
    'components/OnboardingModal.tsx',
    'components/GuidedTour.tsx',
    'components/pages/TutorialsPage.tsx',
  ]

  it.each(OWNED)('%s never says the work happens "in the browser"', (file) => {
    const text = copyText(file)
    expect(text).not.toMatch(/in your browser/i)
    expect(text).not.toMatch(/this browser/i)
    expect(text).not.toMatch(/client-side/i)
  })

  it('describes intake as the single-PDF flow it actually is', () => {
    const text = copyText('components/TenderList.tsx')
    expect(text).toMatch(/one PDF at a time/i)
    expect(text, 'intake accepts a single PDF, not a "pack"').not.toMatch(/RFP pack/i)
  })

  it('does not describe the read-only Company vault drawer as a linking surface', () => {
    for (const file of ['components/pages/TutorialsPage.tsx', 'components/OnboardingModal.tsx']) {
      const text = copyText(file)
      expect(
        /company vault[\s\S]{0,90}link or unlink/i.test(text),
        `${file} claims the Company vault drawer links/unlinks documents`,
      ).toBe(false)
      // Scoped to the drawer: `/read-only/i` anywhere in a 400-line file would
      // pass on an unrelated surface and say nothing about the vault drawer.
      expect(
        /(?:company vault|vault drawer)[\s\S]{0,140}read-only/i.test(text),
        `${file} should say the Company vault drawer itself is read-only`,
      ).toBe(true)
    }
  })

  it('lists every scored readiness dimension with the weight the score uses', () => {
    const text = copyText('components/pages/TutorialsPage.tsx')
    // The numbers come from the implementation, not from this file: hardcoding
    // them here would let a weight change land in `readiness.ts` and the copy
    // together and stay green, which is the drift the guard exists to catch.
    const weights = scoredCheckWeights()
    expect(Object.keys(weights).sort()).toEqual(Object.keys(CHECK_DIMENSION_LABEL).sort())
    for (const [id, weight] of Object.entries(weights)) {
      expect(text, `the tutorial must state the ${id} weight (${weight})`).toMatch(
        new RegExp(`${CHECK_DIMENSION_LABEL[id]}\\s+${weight}(?![0-9])`, 'i'),
      )
    }
    // ...and it must keep naming the dimensions, not just a bare list of numbers.
    expect(text).not.toMatch(/30 \/ 25 \/ 20 \/ 15 \/ 10/)
  })
})
