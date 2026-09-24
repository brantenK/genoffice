// Making the optional AI pass visible — wave D.
//
// Two defects are covered here, both found by the agents that built the feature:
//
//   1. THE PASS WAS INVISIBLE. `handleFile` commits the local result, calls
//      `setActiveTender(record.id)` and only THEN starts the pass — and activating
//      a tender swaps `TenderList` for `Workspace` (see `TendersPage`). The
//      progress row, the findings and the cancel control were therefore unmounted
//      before the run began: the user turned AI on, imported, landed in the
//      workspace and could never see whether it ran, what it found, whether it
//      failed, or stop it. The run's state now lives in a module-level store that
//      both views read through `AiPassPanel`, and these tests pin its transitions,
//      its honesty, and the fact that none of it is persisted.
//
//   2. A CANCELLED RUN APPLIES NOTHING. `finishAiPass` refuses a finish from a run
//      that was cancelled or superseded, and `runAiPass` gates every write on that
//      answer, so a stopped run cannot leave a partial result in the tender. The
//      local engine's own result is never touched either way.
//
// The progress copy is checked here too, because it is copy a user reads: the
// scanned-page honesty guard (`tests/ocr-honesty-copy.test.ts`) polices every
// renderer file for a claim that scanned pages are read without naming AI, and a
// phase label is exactly the kind of surface it exists to police. That guard is
// the load-bearing one; the shape it uses is re-pinned below with a RED case, so
// this file's assertion cannot pass by being vacuous.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adaptAiExtraction } from '../src/renderer/src/ai/extract-with-ai'
import {
  AI_SUGGESTION_REVIEW_STATE,
  type ExtractionRejection,
  type MergedExtraction,
} from '../src/shared/ai-extraction'
import { useTendersStore } from '../src/renderer/src/store'
import {
  aiPassDetails,
  aiPassMessage,
  aiRunLabel,
  cancelAiPass,
  dismissAiPass,
  failAiPass,
  finishAiPass,
  getAiPassState,
  reportAiPassChars,
  reportAiPassProgress,
  startAiPass,
  subscribeAiPass,
  type AiPassOutcome,
} from '../src/renderer/src/components/TenderList'

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

/** Source with comments removed, so a guard cannot be satisfied by prose. */
function codeText(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

/**
 * The scanned-page claim shape the honesty guard polices
 * (`tests/ocr-honesty-copy.test.ts`, `CLAIM_SHAPES`): a reader verb within 40
 * characters of "scanned". Re-stated here because the guard keeps its table
 * private, and re-pinned with a RED case below so this copy of it cannot drift
 * into matching nothing.
 */
const SCANNED_CLAIM_SHAPE = /\b(?:reads?|extracts?)\b[^.]{0,40}\bscanned\b/i

function outcome(overrides: Partial<AiPassOutcome> = {}): AiPassOutcome {
  return {
    summary: 'AI extraction read 3 of 4 pages and suggested 1 metadata value for review.',
    rejections: [],
    warnings: [],
    unreadPages: [],
    readPages: [],
    visionSkippedReason: null,
    visionUnread: [],
    duplicateReference: null,
    ...overrides,
  }
}

function rejection(reason: string, index: number): ExtractionRejection {
  return { kind: 'metadata', path: `metadata[${index}].value`, code: 'MALFORMED_ITEM', reason }
}

function merged(overrides: Partial<MergedExtraction> = {}): MergedExtraction {
  return {
    numPages: 4,
    metadata: [],
    requirements: [],
    pagesRead: [],
    unreadPages: [],
    rejections: [],
    warnings: [],
    provenance: 'ai-suggested',
    reviewState: AI_SUGGESTION_REVIEW_STATE,
    ...overrides,
  }
}

beforeEach(() => {
  // The store is module-level and outlives a test; start every one from "nothing
  // to report", which is also the state the app boots in.
  dismissAiPass()
})

afterEach(() => {
  dismissAiPass()
  vi.restoreAllMocks()
})

describe('the AI pass state store', () => {
  it('is visible from the moment the run starts, and reports each step', () => {
    const runId = startAiPass({ tenderId: 't-1', tenderTitle: 'ICT/2026/041' })

    expect(getAiPassState()).toMatchObject({
      runId,
      tenderId: 't-1',
      status: 'running',
      outcome: null,
      failure: null,
    })
    expect(getAiPassState()?.progress).toEqual({
      phase: 'text',
      index: 0,
      total: 1,
      pageNumbers: [],
      chars: 0,
    })

    reportAiPassProgress(runId, { phase: 'vision-read', index: 1, total: 3, pageNumbers: [4, 5] })
    expect(getAiPassState()?.progress).toEqual({
      phase: 'vision-read',
      index: 1,
      total: 3,
      pageNumbers: [4, 5],
      chars: 0,
    })

    reportAiPassChars(runId, 812)
    expect(getAiPassState()?.progress?.chars).toBe(812)

    expect(finishAiPass(runId, outcome())).toBe(true)
    expect(getAiPassState()).toMatchObject({ status: 'done', progress: null })
    expect(getAiPassState()?.outcome?.summary).toMatch(/read 3 of 4 pages/)
  })

  it('refuses a finish from a cancelled run, so nothing from it can be applied', () => {
    const abort = vi.fn()
    const runId = startAiPass({ tenderId: 't-1', tenderTitle: 'ICT/2026/041', cancel: abort })

    expect(cancelAiPass()).toBe(true)
    expect(abort, 'cancelling stops the work, not just the report').toHaveBeenCalledTimes(1)
    expect(getAiPassState()?.status).toBe('cancelled')

    // The gate the caller writes through: false means "do not touch the tender".
    expect(finishAiPass(runId, outcome())).toBe(false)
    expect(getAiPassState()?.outcome, 'a cancelled run records no findings').toBeNull()
    expect(aiPassDetails(getAiPassState()!)).toEqual([])
    expect(aiPassMessage(getAiPassState()!)).toMatch(/nothing from that run was applied/i)
    expect(aiPassMessage(getAiPassState()!)).toMatch(/local extraction is unchanged/i)
  })

  it('a cancelled run cannot be relabelled a failure, and vice versa', () => {
    const cancelled = startAiPass({ tenderId: 't-1', tenderTitle: 'A' })
    cancelAiPass()
    // The run's own error path runs on abort; it must not overwrite the reason.
    expect(failAiPass(cancelled, 'AbortError')).toBe(false)
    expect(getAiPassState()?.status).toBe('cancelled')
    expect(getAiPassState()?.failure).toBeNull()

    const failed = startAiPass({ tenderId: 't-1', tenderTitle: 'A' })
    expect(failAiPass(failed, 'HTTP 500 from the provider')).toBe(true)
    expect(getAiPassState()?.status).toBe('failed')
    expect(getAiPassState()?.failure).toBe('HTTP 500 from the provider')
    expect(cancelAiPass(), 'a finished run is not cancellable').toBe(false)
  })

  it('a superseded run cannot touch the run that replaced it', () => {
    const firstAbort = vi.fn()
    const first = startAiPass({ tenderId: 't-1', tenderTitle: 'A', cancel: firstAbort })
    const second = startAiPass({ tenderId: 't-2', tenderTitle: 'B' })

    expect(second).toBeGreaterThan(first)
    expect(getAiPassState()?.tenderId).toBe('t-2')
    // A second import supersedes the first: the older run reports nothing.
    expect(finishAiPass(first, outcome())).toBe(false)
    expect(failAiPass(first, 'stale')).toBe(false)
    expect(cancelAiPass(first), 'the older run cannot cancel its successor').toBe(false)
    expect(firstAbort, 'and cannot abort the newer run’s work').not.toHaveBeenCalled()
    expect(getAiPassState()).toMatchObject({ runId: second, status: 'running' })

    reportAiPassProgress(first, { phase: 'text', index: 9, total: 9, pageNumbers: [9] })
    expect(getAiPassState()?.progress?.index, 'a stale step is ignored').toBe(0)
  })

  it('tells every subscriber about every change, and stops when unsubscribed', () => {
    const seen: Array<string | null> = []
    const unsubscribe = subscribeAiPass(() => {
      seen.push(getAiPassState()?.status ?? null)
    })
    const runId = startAiPass({ tenderId: 't-1', tenderTitle: 'A' })
    finishAiPass(runId, outcome())
    unsubscribe()
    dismissAiPass()

    expect(seen).toEqual(['running', 'done'])
  })

  it('a run in flight is not dismissable; a stopped one is', () => {
    const runId = startAiPass({ tenderId: 't-1', tenderTitle: 'A' })
    dismissAiPass()
    expect(getAiPassState(), 'the cancel control cannot be dismissed mid-run').not.toBeNull()

    finishAiPass(runId, outcome())
    dismissAiPass()
    expect(getAiPassState()).toBeNull()
  })
})

describe('what a finished run reports', () => {
  it('counts the refusals and lists their reasons, capped and summed', () => {
    const reasons = [
      'metadata[0].value is empty',
      'metadata[1].value is empty',
      'requirements[0].ruleKey is not in the catalogue',
      'requirements[1].boundingBox is outside the page',
      'requirements[2].title is too long',
    ]
    // The real adapter decides the sentence and the counts, so this pins the copy
    // a user reads to the code that produces it.
    const adaptation = adaptAiExtraction({
      merged: merged({ rejections: reasons.map(rejection) }),
    })
    const runId = startAiPass({ tenderId: 't-1', tenderTitle: 'A' })
    finishAiPass(runId, {
      ...outcome(),
      summary: adaptation.summary,
      rejections: adaptation.rejections,
    })

    const state = getAiPassState()!
    expect(adaptation.rejections).toHaveLength(5)
    expect(adaptation.summary, 'the count is in the summary').toMatch(
      /5 suggestions? .{0,12}refused/i,
    )
    const details = aiPassDetails(state)
    for (const reason of reasons.slice(0, 3)) expect(details).toContain(reason)
    expect(details).toContain('…and 2 more.')
    expect(details.some((line) => line.includes(reasons[4]!))).toBe(false)
  })

  it('renders the warnings, the duplicate reference and the pages no reader obtained', () => {
    const runId = startAiPass({ tenderId: 't-1', tenderTitle: 'A' })
    finishAiPass(
      runId,
      outcome({
        warnings: ['2 pages were truncated before the model saw them.'],
        duplicateReference:
          'Reference ICT/2026/041 already belongs to tender “Office furniture”, so it was not written to this tender — confirm the right reference there, or remove the earlier import.',
        unreadPages: [4, 5],
        readPages: [4],
        visionSkippedReason: 'The model you configured cannot be used to read an image.',
        visionUnread: [
          { pageNumber: 5, reason: 'the page image could not be rendered' },
          { pageNumber: 6, reason: 'the run was cancelled before this page’s turn' },
        ],
      }),
    )

    const details = aiPassDetails(getAiPassState()!)
    expect(details).toContain('2 pages were truncated before the model saw them.')
    expect(details.some((line) => line.startsWith('Reference ICT/2026/041 already belongs'))).toBe(
      true,
    )
    expect(details).toContain('Page 5 was not read: the page image could not be rendered')
    expect(details).toContain('Page 6 was not read: the run was cancelled before this page’s turn')
    // The pages that keep blocking readiness are named as blockers, not as work
    // that was done.
    expect(details).toContain(
      'pages 4–5 — no reader obtained the text, so they still block readiness.',
    )
  })

  it('a refusal to start is reported as the reason it did not run', () => {
    const runId = startAiPass({ tenderId: 't-1', tenderTitle: 'A' })
    failAiPass(
      runId,
      'AI extraction is unavailable in this build. It is optional — the local rule engine needs nothing but this machine.',
      'unavailable',
    )
    expect(getAiPassState()?.status).toBe('unavailable')
    expect(aiPassMessage(getAiPassState()!)).toMatch(/^AI extraction is unavailable in this build/)
    expect(aiPassDetails(getAiPassState()!)).toEqual([])

    const failed = startAiPass({ tenderId: 't-1', tenderTitle: 'A' })
    failAiPass(failed, 'HTTP 500 from the provider')
    expect(aiPassMessage(getAiPassState()!)).toBe(
      'AI extraction failed: HTTP 500 from the provider. The local extraction is unaffected.',
    )
  })
})

describe('the run’s state is UI state, and never the document', () => {
  /** The persisted slice, exactly as the store computes it. */
  function persistedKeys(): string[] {
    const options = (
      useTendersStore as unknown as {
        persist: { getOptions(): { partialize?: (s: unknown) => Record<string, unknown> } }
      }
    ).persist.getOptions()
    expect(typeof options.partialize, 'the store no longer declares what it persists').toBe(
      'function',
    )
    return Object.keys(options.partialize!(useTendersStore.getState())).sort()
  }

  /** Every key and value in localStorage, for a before/after comparison. */
  function localStorageSnapshot(): string {
    const entries: string[] = []
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (key) entries.push(`${key}=${window.localStorage.getItem(key) ?? ''}`)
    }
    return entries.sort().join('\n')
  }

  it('adds no persisted key, and changes nothing the store already persists', () => {
    const before = persistedKeys()
    const localStorageBefore = localStorageSnapshot()

    const runId = startAiPass({ tenderId: 't-1', tenderTitle: 'A' })
    reportAiPassProgress(runId, { phase: 'vision-extract', index: 2, total: 3, pageNumbers: [7] })
    finishAiPass(runId, outcome({ warnings: ['a truncated page'] }))

    expect(persistedKeys()).toEqual(before)
    expect(
      persistedKeys().filter((key) => /ai|run|pass|notice/i.test(key)),
      'the AI pass must not be a persisted key',
    ).toEqual([])
    expect(localStorageSnapshot(), 'a run writes nothing to localStorage').toBe(localStorageBefore)
  })

  it('the persisted slice is what it always was: UI preferences only', () => {
    // Re-pinned here because the assertion above is only meaningful while this
    // set is small and known: an AI-pass key added to `partialize` would have to
    // be added here too, deliberately.
    expect(persistedKeys()).toEqual([
      'activeRequirementId',
      'activeTenderId',
      'currentPage',
      'onboardingDone',
      'page',
      'view',
      'zoom',
    ])
  })
})

describe('the progress copy names the model, and claims no reader for scanned pages', () => {
  it('the vision step says whose reading it is', () => {
    const label = aiRunLabel({ phase: 'vision-read', index: 0, total: 3, pageNumbers: [4] })
    expect(label, 'a phase label is copy a user reads').toMatch(/model/i)
    expect(label).toMatch(/page 4/)
    expect(label).not.toMatch(SCANNED_CLAIM_SHAPE)
    expect(
      aiRunLabel({ phase: 'vision-extract', index: 0, total: 2, pageNumbers: [4, 5] }),
    ).toMatch(/model/i)
  })

  it('the claim shape this test rejects still catches the claim it exists for', () => {
    // RED, against the copy the guard was written for: a phase label that says a
    // scanned page is read, with no model named as the reader.
    expect('reads scanned page 4 of 9').toMatch(SCANNED_CLAIM_SHAPE)
    expect('extract scanned page 4 of 9').toMatch(SCANNED_CLAIM_SHAPE)
    expect('the model reads scanned page 4 of 9').toMatch(SCANNED_CLAIM_SHAPE)
    // ...and the honest label above is not caught by it, so the assertion there
    // is not satisfied by a pattern that matches nothing.
    expect('the model reading a page image, 1 of 3 (page 4)').not.toMatch(SCANNED_CLAIM_SHAPE)
  })
})

describe('the feedback is rendered from wherever the user is', () => {
  const list = codeText('components/TenderList.tsx')
  const workspace = codeText('components/Workspace.tsx')
  const page = codeText('components/pages/TendersPage.tsx')

  it('the workspace mounts the pass panel, scoped to the tender on screen', () => {
    expect(workspace, 'the workspace must import the panel from its owner').toMatch(
      /import \{ AiPassPanel \} from '\.\/TenderList'/,
    )
    expect(workspace).toMatch(/<AiPassPanel tenderId=\{tender\.id\}/)
  })

  it('the panel carries the progress row, the findings and the cancel control', () => {
    const panel = list.slice(list.indexOf('export function AiPassPanel'))
    expect(panel.length, 'the panel is gone').toBeGreaterThan(0)
    expect(panel).toMatch(/data-testid="ai-extraction-progress"/)
    expect(panel).toMatch(/data-testid="intake-notice"/)
    expect(panel).toMatch(/Cancel AI extraction/)
    expect(panel, 'the cancel control is wired, not just drawn').toMatch(/onClick=\{cancelAiRun\}/)
    // Nothing to report renders nothing: no empty row, no stray spacing.
    expect(panel).toMatch(/if \(!state\) return null/)
  })

  it('the run’s state is no longer component-local, so unmounting cannot hide it', () => {
    expect(list, 'the pass state must not live in TenderList’s own state').not.toMatch(
      /setAiRun|useState<AiRunProgress/,
    )
    // ...it is started before the pass runs, so a refusal to start is visible too.
    const started = list.indexOf('const runId = startAiPass({')
    const ran = list.indexOf('await runTenderAiPass(')
    expect(started).toBeGreaterThan(-1)
    expect(ran).toBeGreaterThan(started)
    // ...and every write to the tender is gated on the store accepting the finish.
    const accepted = list.indexOf('const accepted = finishAiPass(runId, {')
    const write = list.indexOf('updateTender(args.tenderId, { requirements:')
    expect(accepted).toBeGreaterThan(-1)
    expect(list).toMatch(/if \(!accepted\) return/)
    expect(write, 'the write must come after the gate').toBeGreaterThan(accepted)
  })

  it('TendersPage still swaps the list for the workspace, which is why the store exists', () => {
    expect(page).toMatch(/view === 'workspace' \? <Workspace \/> : <TenderList \/>/)
  })

  it('the pass is only started when the user turned it on', () => {
    // With AI off the store is never written to, so the panel has nothing to
    // render and the app behaves exactly as it did before the feature existed.
    //
    // The gate now lives in the shared intake sequence (`intakeTenderFile`),
    // which both entry points run — the list's own import and the discovery
    // pane's "Add to workspace" — so the list hands its live toggle to the
    // option and the sequence starts the pass only when that option is set.
    expect(list).toMatch(/aiExtraction: aiEnabledRef\.current/)
    expect(list).toMatch(/if \(options\.aiExtraction\) \{\s*void runAiPass\(/)
    expect(getAiPassState()).toBeNull()
  })
})
