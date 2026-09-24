import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const testDir = join(tmpdir(), `tenders-proposal-truth-${randomUUID().slice(0, 8)}`)

const { ipcHandlers, openedPaths } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
  openedPaths: [] as string[],
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testDir,
    isReady: () => true,
  },
  ipcMain: {
    handle: (channel: string, listener: (...args: any[]) => any) => {
      ipcHandlers.set(channel, listener)
    },
  },
  shell: {
    openPath: vi.fn(async (path: string) => {
      openedPaths.push(path)
      return ''
    }),
  },
  WebContentsView: class MockWebContentsView {
    webContents = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
    }
  },
}))

import { generateProposalMarkdown, type ProposalInput } from '../src/main/proposal-generator'
import {
  configureTendersRuntime,
  registerTendersIpc,
  registerTendersWebContents,
  unregisterTendersWebContents,
} from '../src/main/tenders-main'
import { TENDERS_CHANNELS } from '../src/shared/ipc'
import { parseMoney } from '../src/shared/money'
import type { ReadinessReport } from '../src/shared/readiness'

type ProposalRequirement = {
  id: string
  title: string
  isMandatory: boolean
  status: 'FULFILLED' | 'ACTION_REQUIRED' | 'OUTSTANDING' | 'NOT_APPLICABLE'
  linkedVaultDocId: string | null
  healthStatus?: string
  ruleKey?: string
}

const generatedPaths: string[] = []
const SYSTEM_TIME = new Date('2026-09-13T10:30:00Z')
/** Trusted renderer origin the privileged handlers must see. */
const TRUSTED_RENDERER_URL = 'http://localhost:5179/'
const authorizedSender = {
  isDestroyed: () => false,
  getURL: () => TRUSTED_RENDERER_URL,
  send: vi.fn(),
  once: vi.fn(),
}

// Proposed validation limits for the implementation lane. Inputs beyond these
// bounds are deliberately treated as invalid rather than truncated silently.
const ASSUMED_MAX_TITLE_CHARS = 500
const ASSUMED_MAX_REQUIREMENTS = 500
const ASSUMED_MAX_UNKNOWN_PROPERTY_CHARS = 1_024
const ASSUMED_MAX_SIGNATURE_KEY_CHARS = 100
const ASSUMED_MAX_AGGREGATE_STRING_CHARS = 64 * 1_024
const ASSUMED_MAX_SERIALIZED_PAYLOAD_BYTES = 256 * 1_024

function requirement(
  id: string,
  title: string,
  status: ProposalRequirement['status'],
  overrides: Partial<ProposalRequirement> = {},
): ProposalRequirement {
  return {
    id,
    title,
    isMandatory: true,
    status,
    linkedVaultDocId: null,
    ...overrides,
  }
}

function tender(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tender-office-computers',
    title: 'Supply and Delivery of Office Computers',
    referenceNumber: 'ICT/2026/041',
    issuingBody: 'Provincial Administration Office',
    closingDate: '2026-12-18',
    requirements: [],
    milestones: [],
    ...overrides,
  }
}

function apparentlyReadyTender(overrides: Record<string, unknown> = {}) {
  return tender({
    estimatedValue: 115_000,
    pricingConfirmed: true,
    requirements: [
      requirement('req-tax', 'Valid SARS Tax Clearance / TCS PIN', 'FULFILLED', {
        linkedVaultDocId: 'vault-tax',
        healthStatus: 'VALID',
      }),
    ],
    milestones: [
      {
        id: 'milestone-delivery',
        name: 'Delivery and acceptance of office computers',
        amount: 115_000,
        dueDate: '2026-11-30',
      },
    ],
    ...overrides,
  })
}

async function generateProposal(input: Record<string, unknown>): Promise<string> {
  const result = await invokeProposal(input)
  expect(result.ok).toBe(true)
  expect(result.path).toEqual(expect.any(String))
  expect(existsSync(result.path!)).toBe(true)
  return readFileSync(result.path!, 'utf8')
}

async function invokeProposal(
  input: unknown,
  sender: unknown = authorizedSender,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const handler = ipcHandlers.get(TENDERS_CHANNELS.draftProposalDoc)
  expect(handler, 'the real draftProposalDoc IPC handler must be registered').toBeDefined()
  const result = await handler!({ sender }, input)
  if (typeof result?.path === 'string') generatedPaths.push(result.path)
  return result
}

function readinessReport(ready: boolean): ReadinessReport {
  const failed = ready ? 0 : 1
  return {
    checks: ready
      ? []
      : [
          {
            id: 'requirements',
            label: 'Canonical readiness gate',
            detail: 'Canonical company/vault audit did not pass.',
            passed: false,
            blocking: true,
          },
        ],
    ready,
    passedCount: 0,
    failedCount: failed,
    blockingFailedCount: failed,
    score: ready ? 100 : 0,
    nextBestAction: ready
      ? null
      : { label: 'Canonical readiness gate', detail: 'Resolve canonical blockers.' },
  }
}

type TrustedProposalOptions = {
  readinessReport: ReadinessReport
}

// Intended API seam: renderer-controlled ProposalInput is argument one; only a
// separately constructed main-process context may carry canonical readiness.
const generateWithTrustedContext = generateProposalMarkdown as unknown as (
  input: ProposalInput,
  options: TrustedProposalOptions,
) => string

function unescapedPipeCount(line: string): number {
  let count = 0
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '|') continue
    let slashes = 0
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) slashes += 1
    if (slashes % 2 === 0) count += 1
  }
  return count
}

function filesUnderAppData(): string[] {
  if (!existsSync(testDir)) return []
  return readdirSync(testDir, { recursive: true }).map(String).sort()
}

function summaryMetric(content: string, label: RegExp): number | null {
  const line = content.split('\n').find((candidate) => label.test(candidate))
  const value = line?.match(/:\*{0,2}\s*(\d+)\b/)?.[1]
  return value === undefined ? null : Number(value)
}

function reconciledConditionTotal(content: string): number | null {
  const conditions = content.match(/\*\*Total Conditions:?\*\*:?\s*(\d+)\b/i)?.[1]
  if (conditions !== undefined) return Number(conditions)
  const blockers = content.match(/\*\*Total Blockers:?\*\*:?\s*(\d+)\b/i)?.[1]
  return blockers === undefined ? null : Number(blockers)
}

describe('proposal generation tells the truth about submission readiness and supplied data', () => {
  beforeAll(() => {
    mkdirSync(testDir, { recursive: true })
    configureTendersRuntime({
      preloadPath: '',
      rendererUrl: TRUSTED_RENDERER_URL,
      rendererFile: '',
      openGeneratedPath: (path) => {
        openedPaths.push(path)
        return true
      },
    })
    registerTendersIpc()
    registerTendersWebContents(authorizedSender as any)
  })

  beforeEach(() => {
    openedPaths.length = 0
    vi.useFakeTimers()
    vi.setSystemTime(SYSTEM_TIME)
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const path of generatedPaths.splice(0)) {
      rmSync(path, { force: true })
    }
  })

  afterAll(() => {
    unregisterTendersWebContents(authorizedSender as any)
    rmSync(testDir, { recursive: true, force: true })
  })

  it('keeps renderer-object IPC at independently-unverified draft even when readiness fields are forged', async () => {
    const content = await generateProposal(
      apparentlyReadyTender({
        readinessReport: readinessReport(true),
        ready: true,
        healthStatus: 'VALID',
        signatureChecks: { declaration: true },
      }),
    )

    expect(content).toContain(
      '**Proposal Status:** **DRAFT — READINESS NOT INDEPENDENTLY VERIFIED**',
    )
    expect(content).not.toMatch(/\b(?:READY|CLEARED) FOR SUBMISSION\b/i)
  })

  it('lets only a separate trusted canonical report clear the pure proposal helper', () => {
    const rendererPayloadOnly = generateProposalMarkdown(apparentlyReadyTender())
    const trustedReady = generateWithTrustedContext(apparentlyReadyTender(), {
      readinessReport: readinessReport(true),
    })

    expect.soft(rendererPayloadOnly).not.toMatch(/\b(?:READY|CLEARED) FOR SUBMISSION\b/i)
    expect(trustedReady).toMatch(/\bREADY FOR SUBMISSION\b/i)
  })

  it('lets a canonical false report override an apparently ready proposal payload', () => {
    const content = generateWithTrustedContext(apparentlyReadyTender(), {
      readinessReport: readinessReport(false),
    })

    expect(content).not.toMatch(/\b(?:READY|CLEARED) FOR SUBMISSION\b/i)
  })

  it('names failed canonical blocking checks and reconciles them into a nonzero blocker total', () => {
    const canonicalReport: ReadinessReport = {
      checks: [
        {
          id: 'company-details',
          label: 'Canonical company identity mismatch',
          detail: 'The canonical company profile does not match the tender.',
          passed: false,
          blocking: true,
        },
        {
          id: 'docs-at-closing',
          label: 'Canonical vault document expires before closing',
          detail: 'A canonical linked document will not be valid at closing.',
          passed: false,
          blocking: true,
        },
      ],
      ready: false,
      passedCount: 0,
      failedCount: 2,
      blockingFailedCount: 2,
      score: 0,
      nextBestAction: {
        label: 'Correct canonical company and vault evidence',
        detail: 'Resolve both canonical blocking checks.',
      },
    }
    const content = generateWithTrustedContext(apparentlyReadyTender(), {
      readinessReport: canonicalReport,
    })
    const reconciledTotal = reconciledConditionTotal(content)

    expect(content).toContain('Canonical company identity mismatch')
    expect(content).toContain('Canonical vault document expires before closing')
    expect(reconciledTotal).not.toBeNull()
    expect(reconciledTotal).toBe(2)
    expect(content).not.toMatch(/\*\*Total (?:Blockers|Conditions):\*\*\s*0\b/i)
  })

  it.each([
    {
      label: 'deadline',
      input: apparentlyReadyTender({ closingDate: '2026-09-01' }),
      canonicalCheck: {
        id: 'deadline',
        label: 'Canonical closing deadline has passed',
        detail: 'The canonical tender deadline is no longer open.',
      },
    },
    {
      label: 'required evidence',
      input: apparentlyReadyTender({
        requirements: [
          requirement('req-tax-evidence', 'Tax evidence required at closing', 'FULFILLED', {
            linkedVaultDocId: null,
            healthStatus: 'NO_ATTACHMENT',
            ruleKey: 'tax_pin',
          }),
        ],
      }),
      canonicalCheck: {
        id: 'docs-at-closing',
        label: 'Canonical tax evidence missing at closing',
        detail: 'The canonical vault has no linked tax evidence for closing.',
      },
    },
  ])(
    'reconciles local and canonical $label findings into one condition',
    ({ input, canonicalCheck }) => {
      const report: ReadinessReport = {
        checks: [
          {
            ...canonicalCheck,
            passed: false,
            blocking: true,
          },
        ],
        ready: false,
        passedCount: 0,
        failedCount: 1,
        blockingFailedCount: 1,
        score: 0,
        nextBestAction: {
          label: canonicalCheck.label,
          detail: canonicalCheck.detail,
        },
      }
      const content = generateWithTrustedContext(input, { readinessReport: report })
      const total = reconciledConditionTotal(content)
      const structuredIds = [
        ...content.matchAll(/(?:condition(?:\s+id)?|id)\s*[:=]\s*[`*]*([a-z][a-z0-9-]*)/gi),
      ].map((match) => match[1].toLowerCase())
      const matchingStructuredIds = new Set(structuredIds.filter((id) => id === canonicalCheck.id))

      expect(content).toContain(canonicalCheck.label)
      expect
        .soft(
          total === 1 || matchingStructuredIds.size === 1,
          `the local and canonical ${canonicalCheck.id} findings must share one reconciled condition`,
        )
        .toBe(true)
      expect.soft(content).not.toMatch(/\*\*Total Conditions:?\*\*(?!:?\s*\d)/i)
      if (/\*\*Total Conditions:?\*\*:?\s*\d/i.test(content)) {
        expect(total).toBe(1)
      }
    },
  )

  it('marks a proposal as draft/not ready and names a mandatory OUTSTANDING blocker', async () => {
    const blockerTitle = 'Signed bidder declaration form'
    const content = await generateProposal(
      tender({
        requirements: [requirement('req-declaration', blockerTitle, 'OUTSTANDING')],
      }),
    )

    expect(content).not.toMatch(/cleared for submission/i)
    expect(content).toMatch(/\b(?:not ready|not cleared|draft|blocked|conditional)\b/i)
    expect(content).toContain(blockerTitle)
  })

  it('reports the real blocker count when several requirements are OUTSTANDING', async () => {
    const content = await generateProposal(
      tender({
        requirements: [
          requirement('req-1', 'Signed bidder declaration form', 'OUTSTANDING'),
          requirement('req-2', 'Proof of tax compliance', 'OUTSTANDING'),
          requirement('req-3', 'CSD registration report', 'OUTSTANDING'),
          requirement('req-4', 'Company registration certificate', 'FULFILLED', {
            linkedVaultDocId: 'vault-cipc',
            healthStatus: 'VALID',
          }),
        ],
      }),
    )

    expect(content).toMatch(/(?:outstanding|blockers?|action required)[^:\n]*:\*{0,2}\s*3\b/i)
  })

  it('counts status, health, and signature defects on one requirement as one unique blocker', () => {
    const blockerTitle = 'Signed declaration with current evidence'
    const content = generateWithTrustedContext(
      apparentlyReadyTender({
        requirements: [
          requirement('req-declaration', blockerTitle, 'OUTSTANDING', {
            linkedVaultDocId: 'vault-expired',
            healthStatus: 'EXPIRED',
            ruleKey: 'declaration',
          }),
        ],
        signatureChecks: { declaration: false },
      }),
      { readinessReport: readinessReport(false) },
    )
    const blockerLine = content.split('\n').find((line) => line.startsWith('**Blockers:**')) ?? ''

    expect(content).toMatch(/\*\*Total Blockers:\*\*\s*1\b/)
    expect(blockerLine.match(new RegExp(blockerTitle, 'g')) ?? []).toHaveLength(1)
  })

  it('uses one clearly declared status-count population and reconciles optional outstanding rows', () => {
    const content = generateWithTrustedContext(
      apparentlyReadyTender({
        requirements: [
          requirement('req-mandatory', 'Mandatory tax certificate', 'FULFILLED', {
            linkedVaultDocId: 'vault-tax',
            healthStatus: 'VALID',
          }),
          requirement('req-optional', 'Optional product brochure', 'OUTSTANDING', {
            isMandatory: false,
          }),
        ],
      }),
      { readinessReport: readinessReport(true) },
    )
    const summary = content.slice(
      content.indexOf('## 4. Compliance Checklist'),
      content.indexOf('| Item | Requirement / Returnable'),
    )
    const total = summaryMetric(summary, /\*\*Total Evaluated Criteria\*\*/i)
    const fulfilled = summaryMetric(summary, /\*\*Fully Fulfilled Returnables\*\*/i)
    const outstanding = summaryMetric(summary, /\*\*Outstanding\*\*/i)
    const actionRequired = summaryMetric(summary, /\*\*Action Required\*\*/i)
    const allRowsReconcile =
      total === 2 && fulfilled === 1 && outstanding === 1 && actionRequired === 0
    const mandatoryPopulationSize = summaryMetric(
      summary,
      /\*\*(?:Mandatory (?:Criteria|Requirements)|Status Population Size)\*\*/i,
    )
    const mandatoryOnlyReconciles =
      /(?:status|count) population[^\n]*mandatory/i.test(summary) &&
      mandatoryPopulationSize === 1 &&
      fulfilled === 1 &&
      outstanding === 0 &&
      actionRequired === 0

    expect(content.split('\n').some((line) => line.includes('Mandatory tax certificate'))).toBe(
      true,
    )
    expect(content.split('\n').some((line) => line.includes('Optional product brochure'))).toBe(
      true,
    )
    expect(
      allRowsReconcile || mandatoryOnlyReconciles,
      `status summary must consistently count all rows or explicitly count only mandatory rows:\n${summary}`,
    ).toBe(true)
  })

  it.each([
    {
      label: 'confirmed milestone sum differs from valuation',
      milestones: [
        { name: 'Delivery', amount: 100_000, dueDate: '2026-11-30' },
        { name: 'Acceptance', amount: 10_000, dueDate: '2026-12-01' },
      ],
    },
    {
      label: 'confirmed milestone has a zero amount',
      milestones: [{ name: 'Delivery', amount: 0, dueDate: '2026-11-30' }],
    },
    {
      label: 'confirmed milestone has a non-numeric amount',
      milestones: [{ name: 'Delivery', amount: 'not-an-amount', dueDate: '2026-11-30' }],
    },
  ])('does not clear when $label', ({ milestones }) => {
    const content = generateWithTrustedContext(apparentlyReadyTender({ milestones }), {
      readinessReport: readinessReport(true),
    })
    const isReady = /\b(?:READY|CLEARED) FOR SUBMISSION\b/i.test(content)
    const namesPricingMismatch =
      /(?:milestone|pricing)[^\n]*(?:mismatch|invalid|does not equal)/i.test(content)

    expect(isReady && !namesPricingMismatch).toBe(false)
  })

  it('renders document date and money deterministically with en-ZA formatting', () => {
    const content = generateWithTrustedContext(apparentlyReadyTender(), {
      readinessReport: readinessReport(true),
    })
    const expectedMoney = `R ${new Intl.NumberFormat('en-ZA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(115_000)}`

    expect(content).toContain('**Document Date:** 13 September 2026')
    expect(content).toContain(`**Confirmed Total Bid Valuation:** ${expectedMoney}`)
    expect(content).toContain(`**${expectedMoney}**`)
  })

  it('prints a confirmed valuation the shared rand parser reads back exactly', () => {
    // The confirmed total is the number the extraction-review step persisted
    // through `shared/money`. Printing it in a form that parser cannot read
    // back would let the document and the record drift apart.
    const valuation = 1_200_000
    const content = generateWithTrustedContext(
      apparentlyReadyTender({
        estimatedValue: valuation,
        milestones: [{ name: 'Delivery', amount: valuation, dueDate: '2026-11-30' }],
      }),
      { readinessReport: readinessReport(true) },
    )
    const valuationLine =
      content.split('\n').find((line) => line.includes('Confirmed Total Bid Valuation')) ?? ''
    const printed = valuationLine
      .slice(valuationLine.indexOf(':**') + 3, valuationLine.indexOf(' (amount supplied'))
      .trim()
    const scheduleTotal = content.match(/\| \*\*TOTAL\*\* \| \| \*\*(.+?)\*\* \|/)?.[1] ?? ''

    expect(printed).not.toBe('')
    expect(parseMoney(printed)).toBe(valuation)
    expect(parseMoney(scheduleTotal)).toBe(valuation)
    // The 100x mis-read the audit found would print "R 120 000 000,00" here.
    expect(parseMoney(printed)).not.toBe(120_000_000)
  })

  it('uses Not supplied for a missing reference instead of fabricating a plausible identifier', () => {
    const content = generateProposalMarkdown(
      tender({ referenceNumber: undefined, estimatedValue: undefined }),
    )

    expect(content).toContain('**Tender Reference:** Not supplied')
    expect(content).not.toContain('RFP-BID-2026')
  })

  it('does not invent engineering or site-work methodology for an office-computer tender', async () => {
    const content = await generateProposal(tender())
    const fabricatedClaimPatterns = [
      /engineering and contracting division possesses/i,
      /lead project managers and safety officers/i,
      /Occupational Health\s*&\s*Safety\s*\(OHS\)/i,
      /civil, mechanical, and instrumentation works/i,
      /SABS and ISO 9001 standards/i,
      /pressure testing.*telemetry verification/i,
      /commissioning, calibration\s*&\s*handover/i,
    ]

    expect(fabricatedClaimPatterns.filter((pattern) => pattern.test(content))).toEqual([])
  })

  it.each([
    { label: 'missing', estimatedValue: undefined },
    { label: 'zero', estimatedValue: 0 },
  ])(
    'states that pricing requires confirmation when valuation is $label',
    async ({ estimatedValue }) => {
      const content = await generateProposal(
        tender({
          estimatedValue,
          pricingConfirmed: false,
        }),
      )

      expect(content).not.toMatch(/\*\*Total Bid Valuation:\*\*\s*R\s*0(?:[.,]00)?\b/i)
      expect(content).not.toMatch(/\|[^\n]*\|\s*R\s*0(?:[.,]00)?\s*\|/i)
      expect(content).toMatch(
        /pric(?:e|ing|ed)[^\n]*(?:not provided|not supplied|unconfirmed|requires? confirmation|to be confirmed)/i,
      )
    },
  )

  it.each([
    {
      label: 'a malformed nested requirement',
      input: apparentlyReadyTender({ requirements: [{}] }),
    },
    {
      label: 'a malformed nested milestone',
      input: apparentlyReadyTender({
        milestones: [{ name: { nested: 'not a string' }, amount: 115_000 }],
      }),
    },
    {
      label: `a title longer than the assumed ${ASSUMED_MAX_TITLE_CHARS}-character limit`,
      input: apparentlyReadyTender({ title: 'T'.repeat(ASSUMED_MAX_TITLE_CHARS + 1) }),
    },
    {
      label: `more than the assumed ${ASSUMED_MAX_REQUIREMENTS}-requirement limit`,
      input: apparentlyReadyTender({
        requirements: Array.from({ length: ASSUMED_MAX_REQUIREMENTS + 1 }, (_, index) =>
          requirement(`req-${index}`, `Requirement ${index}`, 'FULFILLED', {
            linkedVaultDocId: `vault-${index}`,
            healthStatus: 'VALID',
          }),
        ),
      }),
    },
  ])('rejects $label without creating or opening a file', async ({ input }) => {
    const openedBefore = openedPaths.length
    const filesBefore = filesUnderAppData()
    const result = await invokeProposal(input)

    expect.soft(result.ok).toBe(false)
    expect.soft(result.path).toBeUndefined()
    expect.soft(openedPaths).toHaveLength(openedBefore)
    expect(filesUnderAppData()).toEqual(filesBefore)
  })

  it.each([
    {
      label: `an oversized unknown top-level property (assumed ${ASSUMED_MAX_UNKNOWN_PROPERTY_CHARS}-character cap)`,
      input: apparentlyReadyTender({
        rendererState: 'X'.repeat(ASSUMED_MAX_UNKNOWN_PROPERTY_CHARS + 1),
      }),
    },
    {
      label: 'an oversized unknown nested requirement property',
      input: apparentlyReadyTender({
        requirements: [
          {
            ...requirement('req-extra', 'Known requirement fields', 'FULFILLED', {
              linkedVaultDocId: 'vault-extra',
              healthStatus: 'VALID',
            }),
            rendererDiagnostics: 'X'.repeat(ASSUMED_MAX_UNKNOWN_PROPERTY_CHARS + 1),
          },
        ],
      }),
    },
    {
      label: 'an oversized unknown nested milestone property',
      input: apparentlyReadyTender({
        milestones: [
          {
            name: 'Delivery',
            amount: 115_000,
            dueDate: '2026-11-30',
            rendererMetadata: 'X'.repeat(ASSUMED_MAX_UNKNOWN_PROPERTY_CHARS + 1),
          },
        ],
      }),
    },
    {
      label: `a signature key longer than the assumed ${ASSUMED_MAX_SIGNATURE_KEY_CHARS}-character cap`,
      input: apparentlyReadyTender({
        signatureChecks: { ['S'.repeat(ASSUMED_MAX_SIGNATURE_KEY_CHARS + 1)]: true },
      }),
    },
    {
      label: `aggregate known-field strings above the assumed ${ASSUMED_MAX_AGGREGATE_STRING_CHARS}-character cap`,
      input: apparentlyReadyTender({
        requirements: Array.from({ length: 180 }, (_, index) =>
          requirement(`req-aggregate-${index}`, `${index}-`.padEnd(400, 'A'), 'FULFILLED', {
            linkedVaultDocId: `vault-${index}`,
            healthStatus: 'VALID',
          }),
        ),
        milestones: [],
      }),
    },
    {
      label: `a serialized payload above the assumed ${ASSUMED_MAX_SERIALIZED_PAYLOAD_BYTES}-byte cap`,
      input: apparentlyReadyTender({
        requirements: Array.from({ length: 400 }, (_, index) => ({
          ...requirement(`req-payload-${index}`, `Requirement ${index}`, 'FULFILLED', {
            linkedVaultDocId: `vault-${index}`,
            healthStatus: 'VALID',
          }),
          notes: 'N'.repeat(700),
        })),
        milestones: [],
      }),
    },
  ])('rejects $label before proposal file/open side effects', async ({ input }) => {
    const openedBefore = openedPaths.length
    const filesBefore = filesUnderAppData()
    const result = await invokeProposal(input)

    expect.soft(result.ok).toBe(false)
    expect.soft(result.path).toBeUndefined()
    expect.soft(openedPaths).toHaveLength(openedBefore)
    expect(filesUnderAppData()).toEqual(filesBefore)
  })

  it('rejects an unregistered sender before proposal file or open side effects', async () => {
    const unauthorizedSender = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
    }
    const filesBefore = filesUnderAppData()
    const result = await invokeProposal(apparentlyReadyTender(), unauthorizedSender)

    expect.soft(result.ok).toBe(false)
    expect.soft(result.path).toBeUndefined()
    expect.soft(openedPaths).toHaveLength(0)
    expect(filesUnderAppData()).toEqual(filesBefore)
  })

  it('writes opaque, non-overwriting names only beneath the app-owned Tenders generated/cache area', async () => {
    const first = await invokeProposal(
      apparentlyReadyTender({ title: 'Confidential Acquisition Alpha', issuingBody: 'Issuer One' }),
    )
    const second = await invokeProposal(
      apparentlyReadyTender({ title: 'Confidential Acquisition Alpha', issuingBody: 'Issuer Two' }),
    )
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)

    const appOwnedRoots = [join(testDir, 'tenders', 'generated'), join(testDir, 'tenders', 'cache')]
    for (const path of [first.path!, second.path!]) {
      const isInsideAppOwnedRoot = appOwnedRoots.some((root) => {
        const child = relative(root, path)
        return child !== '' && child !== '..' && !child.startsWith(`..${sep}`)
      })
      const fileName = basename(path)
      expect
        .soft(isInsideAppOwnedRoot, `${path} must be in a Tenders-owned output directory`)
        .toBe(true)
      expect.soft(fileName.toLowerCase()).not.toContain('confidential')
      expect
        .soft(fileName)
        .toMatch(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.md$/i)
    }
    expect.soft(first.path).not.toBe(second.path)
    expect.soft(existsSync(first.path!)).toBe(true)
    expect.soft(existsSync(second.path!)).toBe(true)
    expect(readFileSync(first.path!, 'utf8')).toContain('Issuer One')
    expect(readFileSync(second.path!, 'utf8')).toContain('Issuer Two')
  })

  it('flattens Unicode controls and keeps hostile linked-document text inside one matrix cell', () => {
    const content = generateProposalMarkdown(
      apparentlyReadyTender({
        title: 'Safe\u202eTitle\u2028Injected',
        referenceNumber: undefined,
        requirements: [
          requirement('req-hostile', 'Signed returnable', 'FULFILLED', {
            linkedVaultDocId: 'vault`|forged\u2028row',
            healthStatus: 'VALID\u202e',
          }),
        ],
      }),
    )
    const matrixRow = content.split('\n').find((line) => line.includes('Signed returnable'))

    expect(content).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u2028\u2029]/u)
    expect(content).toContain('**Project Title:** SafeTitle Injected')
    expect(content).toContain('**Tender Reference:** Not supplied')
    expect(matrixRow).toBeDefined()
    expect(matrixRow).not.toContain('`')
    expect(unescapedPipeCount(matrixRow!)).toBe(7)
  })

  it('strips Arabic letter mark and soft hyphen visual controls from all rendered text', () => {
    const content = generateProposalMarkdown(
      apparentlyReadyTender({
        title: 'Safe\u061cTitle\u00adHidden',
        requirements: [
          requirement('req-controls', 'Signed\u061c return\u00adable', 'FULFILLED', {
            linkedVaultDocId: 'vault\u061c-control\u00ad-id',
            healthStatus: 'VAL\u061cID\u00ad',
          }),
        ],
      }),
    )

    expect(content).not.toMatch(/[\u061c\u00ad]/u)
    expect(content).toContain('**Project Title:** SafeTitleHidden')
    expect(content).toContain('Signed returnable')
    expect(content).toContain('vault-control-id')
    expect(content).toContain('VALID')
  })

  it('strips representative Unicode format controls while preserving normal Unicode letters', () => {
    const content = generateProposalMarkdown(
      apparentlyReadyTender({
        title: 'IsiXhosa uxwebhu\u180e — العربية\ufff9',
        issuingBody: 'München\ufffa 中文\ufffb',
        requirements: [
          requirement('req-unicode-format', 'Résumé\u{e0001} – isiXhosa', 'FULFILLED', {
            linkedVaultDocId: 'vault\u180e-中文\u{e0001}',
            healthStatus: 'VAL\ufff9\ufffa\ufffbID',
          }),
        ],
      }),
    )

    expect.soft(content).not.toMatch(/\p{Cf}/u)
    expect(content).toContain('**Project Title:** IsiXhosa uxwebhu — العربية')
    expect(content).toContain('**Issuing Authority:** München 中文')
    expect(content).toContain('Résumé – isiXhosa')
    expect(content).toContain('vault-中文')
    expect(content).toContain('VALID')
  })

  it('keeps pipe-bearing requirement status and health status inside their matrix cells', () => {
    const content = generateWithTrustedContext(
      apparentlyReadyTender({
        requirements: [
          {
            id: 'req-status-pipe',
            title: 'Status delimiter attack',
            isMandatory: true,
            status: 'FULFILLED|OUTSTANDING',
            linkedVaultDocId: 'vault-status',
            healthStatus: 'VALID|EXPIRED',
          },
        ],
      }),
      { readinessReport: readinessReport(true) },
    )
    const matrixRow = content
      .split('\n')
      .find((line) => line.startsWith('|') && line.includes('Status delimiter attack'))

    expect(matrixRow).toBeDefined()
    expect(unescapedPipeCount(matrixRow!)).toBe(7)
  })
})
