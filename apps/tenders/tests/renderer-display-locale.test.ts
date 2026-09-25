/**
 * Renderer display guards: rand amounts, submit-by labels, runway days, the
 * single `<main>` landmark, the AI-provenance marker and the availability
 * decision.
 *
 * Six review findings, five of them invisible on an en-ZA machine:
 *   * `Workspace.tsx` and `MilestonesDrawer.tsx` printed amounts with
 *     `Number(x).toLocaleString(undefined, …)`, so a de-DE machine rendered
 *     `850.000,50` in a rand-denominated product;
 *   * `Workspace.tsx` and `TenderList.tsx` rendered `dl.submitBy` — a real UTC
 *     instant — on the reader's own clock, so the tooltip disagreed with the
 *     SAST-pinned `dl.formatted` beside it;
 *   * `OverviewPage.tsx` rendered a runway day with no `timeZone`, so a
 *     date-only closing (anchored at 23:59 SAST) showed a day late east of SAST;
 *   * `App.tsx`, `Workspace.tsx` and `TenderList.tsx` each rendered a `<main>`,
 *     so the document carried nested main landmarks;
 *   * a value's ORIGIN was invisible: `suggestedBy: 'ai'` was written and read by
 *     the extraction pipeline but rendered nowhere, so a model's suggestion
 *     looked exactly like the local rule engine's own read — the one thing this
 *     feature must never do (see `shared/types.ts#ValueProvenance`);
 *   * the renderer asked "can AI extraction run?" twice, with two vocabularies:
 *     `ai/transport.ts` re-implemented the credential rule and its own reasons
 *     while `shared/ai-extraction.ts` exports the documented single answer,
 *     `aiExtractionAvailability`.
 *
 * Two later findings live here too, because both are about a value the renderer
 * held and then threw away:
 *   * the failure CLASS was one of them. The shell's `ai:stream` handler marks an
 *     error chunk `'timeout' | 'credits' | 'network' | 'overloaded'` — the four a
 *     BYOK user must tell apart — and the transport dropped `chunk.errorCode` at
 *     its last hop, so a wrong key, an empty account, a rate limit and a dead
 *     connection all arrived as one sentence (see the error-class section below,
 *     which drives the real stream);
 *   * machine provenance rode on a `title`. A screen reader has no hover, so
 *     "AI-suggested" existed for sighted users and not for them. The guards below
 *     pin the accessible name and the field description; the executed proof is
 *     the accessibility tree in `e2e/tenders-a11y-theme.spec.ts` (journey 9).
 *
 * HOW THE JSX CLAIMS ARE CHECKED: a rendered-component harness now exists
 * (`tests/helpers/render.tsx`, `react-dom/client` + `act`, no test library), so
 * the claims that are behaviour of a rendered tree are asserted by rendering the
 * real components — see `tests/components/extraction-review.test.tsx` (the
 * provenance marker at every site it is shown, and that a parser value carries
 * none) and `tests/components/requirement-list.test.tsx` (a requirement's number
 * named after whoever produced it). Those files replace the source guards that
 * used to stand in for them here; the guards below are the ones that remain the
 * only way to check a STATIC property (one label defined once and imported by the
 * other surface, the marker's accessible-name derivation, no `toLocaleString` on
 * a money surface, one `<main>`, every date pinned to SAST), plus the
 * real-function tests (the provenance predicate, the availability decision, the
 * transport's watchdogs and failure classes) that never needed a tree.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiSettings } from '@genoffice/ai-provider/browser'
import { formatRandAmount, parseMoney, safeMoneyLocale } from '../src/shared/money'
import type { AiStreamChunk } from '../src/shared/ipc'
import { valueProvenance } from '../src/shared/types'
import { aiExtractionAvailability } from '../src/shared/ai-extraction'
import {
  AI_EXTRACTION_AUTH_FAILURE_MESSAGE,
  AI_EXTRACTION_ERROR_CLASS_MESSAGES,
  aiAvailabilityFor,
  aiExtractionErrorMessage,
  aiExtractionTimeoutMessage,
  createTendersCompletion,
  modelIsConfigured,
  readAiReadiness,
  type TendersAiBridge,
} from '../src/renderer/src/ai/transport'

/** en-ZA groups with a no-break space (`850 000`), which is what the app prints. */
const NBSP = '\u00a0'

/** Locate `apps/tenders/src/renderer/src` from the workspace or the repo root. */
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

/**
 * Source with comments removed and everything else — code, JSX, string literals
 * — intact. The checks match against this rather than the raw file, because a
 * raw-source regex is satisfied by a comment that merely mentions the pattern
 * (or broken by one that documents its removal).
 */
function codeText(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

function readSurface(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8')
}

/** Every renderer `.tsx` file, as a path relative to the renderer `src`. */
function walkTsx(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsx(path))
    else if (entry.name.endsWith('.tsx')) out.push(relative(SRC, path).replace(/\\/g, '/'))
  }
  return out
}

const MONEY_SURFACES = [
  'components/Workspace.tsx',
  'components/MilestonesDrawer.tsx',
  'components/TenderList.tsx',
  'components/pages/OverviewPage.tsx',
]

describe('rand amounts in the renderer follow the one rand formatter', () => {
  it('prints a fractional amount and a millions amount exactly', () => {
    expect(formatRandAmount(850_000.5)).toBe(`R 850${NBSP}000,50`)
    expect(formatRandAmount(1_250_000)).toBe(`R 1${NBSP}250${NBSP}000,00`)
    expect(parseMoney(formatRandAmount(850_000.5))).toBe(850_000.5)
    expect(parseMoney(formatRandAmount(1_250_000))).toBe(1_250_000)
  })

  it('does not follow the machine locale, unlike toLocaleString(undefined, …)', () => {
    // The defect in one line: `Intl` resolves `undefined` to the machine's own
    // convention, so the old call rendered the amount in whatever locale the
    // reader's machine happened to have.
    const machine = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    expect(machine.resolvedOptions().locale.length, 'the machine locale resolves').toBeGreaterThan(
      0,
    )
    // A machine whose convention is not the rand one must still get the rand
    // form; the default is pinned to en-ZA, never to the ambient locale.
    expect(safeMoneyLocale(undefined)).toBe('en-ZA')
    expect(formatRandAmount(850_000.5)).toBe(formatRandAmount(850_000.5, 'en-ZA'))
    expect(formatRandAmount(1_250_000)).toBe(`R 1${NBSP}250${NBSP}000,00`)
    const deDe = new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(850_000.5)
    expect(
      deDe,
      'a de-DE machine groups with dots, which is why the machine locale must not reach money',
    ).not.toBe(`850${NBSP}000,50`)
  })

  it('the surfaces that print money call the formatter, never toLocaleString', () => {
    for (const surface of MONEY_SURFACES) {
      const code = codeText(readSurface(surface))
      expect(
        code,
        `${surface} must not print money in the machine locale (toLocaleString(undefined, …))`,
      ).not.toContain('toLocaleString(')
    }
    for (const surface of ['components/Workspace.tsx', 'components/MilestonesDrawer.tsx']) {
      const code = codeText(readSurface(surface))
      expect(code, `${surface} must import the shared rand formatter`).toContain(
        "from '../../../shared/money'",
      )
      expect(code, `${surface} must print amounts with formatRandAmount`).toMatch(
        /formatRandAmount\(/,
      )
    }
    // The check is not vacuous: the shipped pre-fix call is caught by it.
    const shipped = 'R {Number(m.amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}'
    expect(codeText(shipped)).toContain('toLocaleString(')
  })
})

describe('submit-by labels and runway days are pinned to the South African clock', () => {
  it('renders the submit-by label, never the raw instant', () => {
    for (const surface of ['components/Workspace.tsx', 'components/TenderList.tsx']) {
      const code = codeText(readSurface(surface))
      expect(
        code,
        `${surface} must not render dl.submitBy on the reader's clock (it is 2 h off SAST)`,
      ).not.toMatch(/submitBy\.toLocale/)
      expect(code, `${surface} must render dl.submitByLabel`).toContain('dl.submitByLabel')
    }
  })

  it('renders the runway day in Africa/Johannesburg', () => {
    const code = codeText(readSurface('components/pages/OverviewPage.tsx'))
    expect(code, 'the runway day must be pinned to SAST').toMatch(
      /toLocaleDateString\('en-ZA', \{[^}]*timeZone: 'Africa\/Johannesburg'/,
    )
    // And no other date in the file may be left unpinned.
    const dateCalls = code.match(/toLocaleDateString\(/g) ?? []
    const pinned = code.match(/timeZone: 'Africa\/Johannesburg'/g) ?? []
    expect(pinned.length, 'every toLocaleDateString in the runway is pinned').toBe(dateCalls.length)
  })
})

describe('the document carries exactly one <main> landmark', () => {
  it('renders <main> only in the app shell, and the drawer anchors on the workspace root', () => {
    const offenders = walkTsx(SRC).filter((file) => codeText(readSurface(file)).includes('<main'))
    expect(
      offenders,
      'nested <main> landmarks: the shell owns the only one, every other region is a labelled <section>',
    ).toEqual(['components/App.tsx'])

    const workspace = codeText(readSurface('components/Workspace.tsx'))
    expect(workspace, 'the workspace region is a labelled section').toMatch(
      /aria-label="Tender workspace"/,
    )
    expect(workspace, 'the workspace root carries its own marker').toContain('data-workspace-root')
    expect(workspace, 'the workspace region is no longer a <main>').not.toContain('<main')

    const drawer = codeText(readSurface('components/Drawer.tsx'))
    expect(drawer, 'the drawer resolves its containing block by marker').toContain(
      'data-workspace-root',
    )
    expect(
      drawer,
      'the drawer must not resolve its containing block by tag name: a `main` lookup would pass the workspace and measure from the shell',
    ).not.toMatch(/closest(?:<[^>]*>)?\('main'\)/)
  })
})

// ── where a value came from ───────────────────────────────────────────────────

/**
 * The predicate every marker hangs off, tested directly: "absent means the
 * parser" is the whole reason an unmarked value may be shown without a label,
 * so it is asserted rather than assumed.
 */
describe('value provenance', () => {
  it('defaults to the local parser, and only ever answers ai for an explicit ai', () => {
    expect(valueProvenance(undefined)).toBe('parser')
    expect(valueProvenance(null)).toBe('parser')
    expect(valueProvenance({})).toBe('parser')
    expect(valueProvenance({ suggestedBy: 'parser' })).toBe('parser')
    expect(valueProvenance({ suggestedBy: 'ai' })).toBe('ai')
  })
})

/**
 * What is left of the marker guards here: the part no render can check.
 *
 * WHERE the marker is rendered, WHICH values it appears on, and what a model's
 * number is called are all behaviour of the rendered tree, so they are asserted
 * by rendering the real components (see this file's header):
 *   * `tests/components/extraction-review.test.tsx` — the marker as visible text
 *     on a model-produced field, nothing at all for a parser value, the
 *     provenance predicate applied per candidate (a mixed candidate set keeps the
 *     parser's read unmarked), the single suggestion beside the field, and the
 *     requirement row;
 *   * `tests/components/requirement-list.test.tsx` — a requirement's number named
 *     after whoever produced it, at both the badge and the expanded row, for a
 *     model-suggested and for a parser-read requirement, including that the
 *     model's number is never printed as "Parser confidence".
 *
 * What remains here is the one claim a render cannot make: that there is a single
 * label and a single vocabulary, defined once and imported rather than re-spelled
 * — a rendering test would pass just as happily against two identical strings.
 */
describe('one label, one vocabulary, shared by the surfaces that show it', () => {
  const review = codeText(readSurface('components/ExtractionReview.tsx'))
  const list = codeText(readSurface('components/RequirementList.tsx'))

  it('defines the label once, in the review component', () => {
    expect(review.match(/'AI-suggested'/g) ?? [], 'the label is defined once').toHaveLength(1)
  })

  it('imports it into the requirement row instead of re-spelling it', () => {
    expect(list, 'the requirement row must not invent a second label').not.toContain(
      "'AI-suggested'",
    )
    expect(list, 'it imports the one label').toMatch(
      /import \{[^}]*AI_SUGGESTION_LABEL[^}]*\} from '\.\/ExtractionReview'/,
    )
    expect(list, 'and the one explanation').toMatch(
      /import \{[^}]*AI_SUGGESTION_TITLE[^}]*\} from '\.\/ExtractionReview'/,
    )
    // The row's marker now carries the name too (its accessible name, not only
    // the tooltip): a render can show that the name is right, but only this can
    // show it is the ONE name rather than an identical string spelled again here.
    expect(list, 'and the one accessible name').toMatch(
      /import \{[^}]*AI_SUGGESTION_ACCESSIBLE_NAME[^}]*\} from '\.\/ExtractionReview'/,
    )
  })
})

/**
 * Machine provenance must be in the ACCESSIBLE NAME, not only in the tooltip.
 *
 * A source guard, and marked as one: the executed proof is the rendered
 * accessibility tree in `e2e/tenders-a11y-theme.spec.ts` (journey 9), which opens
 * the real review panel on a model-suggested field and reads the marker's
 * accessible name plus the control's accessible description out of Chromium.
 * What is checked here is the part a render cannot show: that the marker's name
 * is derived from the one label and the one caveat, and that no surface re-spells
 * them.
 */
describe('machine provenance is part of the accessible name, not only the tooltip', () => {
  const review = codeText(readSurface('components/ExtractionReview.tsx'))
  const workspace = codeText(readSurface('components/Workspace.tsx'))

  it('names the marker from the label and the caveat, and describes the field', () => {
    expect(
      review,
      'the marker’s name must be built from the label, so the two cannot drift',
    ).toMatch(
      /AI_SUGGESTION_ACCESSIBLE_NAME = `\$\{AI_SUGGESTION_LABEL\}\. \$\{AI_SUGGESTION_TITLE\}`/,
    )
    expect(review, 'the chip must carry that name into the accessibility tree').toMatch(
      /ariaLabel=\{AI_SUGGESTION_ACCESSIBLE_NAME\}/,
    )
    expect(
      review,
      'a bare span has no accessible name, so the chip needs a role that can carry one',
    ).toMatch(/'aria-label': ariaLabel/)
    expect(
      review,
      'the field control must describe the provenance (its aria-describedby paragraph)',
    ).toMatch(
      /\{aiSuggested && <span className="sr-only">\{AI_SUGGESTION_FIELD_DESCRIPTION\}<\/span>\}/,
    )
    const description =
      /AI_SUGGESTION_FIELD_DESCRIPTION =\s*\n?\s*'([^']+)'/.exec(review)?.[1] ?? ''
    expect(description, 'the description must say who produced the value').toMatch(/model/)
    expect(description, 'and must never call the suggestion a fact').toContain(
      'not a verified fact',
    )
  })

  it('the workspace’s own marker is named too', () => {
    expect(workspace, 'the workspace marker must not be tooltip-only').toMatch(
      /role="note"[\s\S]{0,120}aria-label=\{AI_SUGGESTION_ACCESSIBLE_NAME\}/,
    )
  })

  it('the guards are not vacuous: the pre-fix shape is caught', () => {
    // What the chip shipped: the caveat in a tooltip, and no name at all.
    expect('<Chip tone="accent" title={AI_SUGGESTION_TITLE}>').not.toMatch(
      /ariaLabel=\{AI_SUGGESTION_ACCESSIBLE_NAME\}/,
    )
    expect('<span title={AI_SUGGESTION_TITLE}>').not.toMatch(
      /role="note"[\s\S]{0,120}aria-label=\{AI_SUGGESTION_ACCESSIBLE_NAME\}/,
    )
  })
})

// ── one availability decision ─────────────────────────────────────────────────

function settingsWith(provider: string, config: Record<string, string>): AiSettings {
  return { provider, providers: { [provider]: config } } as unknown as AiSettings
}

const SETTINGS = settingsWith('anthropic', { apiKey: 'sk-test', model: 'claude-test' })

/** A bridge double: no Electron, no network, no timers of its own. */
function bridgeDouble(settings: AiSettings = SETTINGS): {
  bridge: TendersAiBridge
  emit: (chunk: AiStreamChunk) => void
  cancels: string[]
  listeners: () => number
} {
  const handlers = new Set<(chunk: AiStreamChunk) => void>()
  const cancels: string[] = []
  return {
    bridge: {
      getAiSettings: async () => settings,
      aiStream: () => undefined,
      aiStreamCancel: (requestId) => {
        cancels.push(requestId)
      },
      onAiStream: (handler) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    },
    emit: (chunk) => {
      for (const handler of [...handlers]) handler(chunk)
    },
    cancels,
    listeners: () => handlers.size,
  }
}

describe('the renderer asks the shared core whether AI extraction can run', () => {
  const transport = codeText(readSurface('ai/transport.ts'))

  it('delegates the decision, and restates neither the credential rule nor the reasons', () => {
    expect(transport, 'the shared helper is the decision point').toMatch(
      /aiExtractionAvailability\(/,
    )
    expect(transport, 'and it is imported from the shared core').toMatch(
      /from '\.\.\/\.\.\/\.\.\/shared\/ai-extraction'/,
    )
    expect(
      transport,
      'the api-key rule belongs to the shared core: a second copy here is the drift this removed',
    ).not.toContain('apiKey')
    expect(transport, 'the reason vocabulary belongs to the shared core').not.toMatch(
      /'no-api-key'|'no-model'|'no-provider-configured'/,
    )
    expect(transport, "the helper's own reason is passed through").toMatch(
      /reason: availability\.reason/,
    )
    // The credential rule has no override either: a caller able to add to the
    // keyless or base-URL set could make one settings object answer two ways.
    expect(transport, 'no provider-set override is constructed here').not.toMatch(
      /keylessProviders|baseUrlProviders|AI_KEYLESS_PROVIDERS/,
    )
    expect(
      transport,
      "the helper's own message is what the user is shown, not a hint restated here",
    ).toMatch(/message: availability\.message/)
  })

  it('the delegation guards are not vacuous: the pre-fix gate and a second vocabulary are caught', () => {
    // The credential rule this file used to carry itself…
    expect('if (config.apiKey?.trim()) return true').toContain('apiKey')
    // …and a second copy of the shared reason vocabulary.
    expect("if (reason === 'no-api-key') return unavailable()").toMatch(
      /'no-api-key'|'no-model'|'no-provider-configured'/,
    )
    // …and the override list it used to build for the helper.
    expect('aiExtractionAvailability({ settings, keylessProviders })').toMatch(
      /keylessProviders|baseUrlProviders|AI_KEYLESS_PROVIDERS/,
    )
    // …and the generic hint it used to show in place of the helper's message:
    // the pass-through guard above is satisfied only by the helper's own message.
    expect('message: AI_MODEL_SETTINGS_HINT').not.toMatch(/message: availability\.message/)
  })

  it('reports the shared reason, and only offers the pass when a model is usable', async () => {
    const cases: Array<{ settings: AiSettings; reason: string | null; names: RegExp }> = [
      { settings: SETTINGS, reason: null, names: /./ },
      {
        settings: settingsWith('anthropic', { apiKey: '', model: 'claude-test' }),
        reason: 'no-api-key',
        names: /No API key is set for the AI provider "anthropic".*Settings/,
      },
      {
        settings: settingsWith('anthropic', { apiKey: 'sk-test', model: '   ' }),
        reason: 'no-model',
        names: /The AI provider "anthropic" has no model selected.*Settings/,
      },
      {
        settings: settingsWith('', {}),
        reason: 'no-provider-configured',
        names: /No AI provider is configured yet/,
      },
    ]
    for (const entry of cases) {
      const readiness = await readAiReadiness(bridgeDouble(entry.settings).bridge)
      expect(readiness.ready, `ready for ${JSON.stringify(entry.settings)}`).toBe(
        entry.reason === null,
      )
      if (readiness.ready) {
        expect(readiness.availability).toMatchObject({
          available: true,
          provider: 'anthropic',
          model: 'claude-test',
        })
      } else {
        expect(readiness.reason).toBe(entry.reason)
        expect(readiness.code).toBe('model-not-configured')
        // The message shown is the shared helper's own for that reason: it names
        // the provider and what is actually missing, instead of one generic
        // "configure a model" hint that would be wrong for a missing key.
        const helper = aiExtractionAvailability({ settings: entry.settings })
        expect(helper.available).toBe(false)
        expect(readiness.message).toBe(helper.available ? '' : helper.message)
        expect(readiness.message, 'the message names what is missing').toMatch(entry.names)
        expect(readiness.message, 'and points at the offline engine that already ran').toMatch(
          /offline rule engine|rule engine reads the document offline/,
        )
        expect(readiness.message, 'while claiming nothing about AI is verified').not.toMatch(
          /verified|accurate|confirmed by/i,
        )
      }
      // The boolean shortcut and the readiness answer are the same decision.
      expect(modelIsConfigured(entry.settings)).toBe(readiness.ready)
      expect(aiAvailabilityFor(entry.settings).available).toBe(readiness.ready)
    }
  })

  it('answers "can this model read a scanned page?" from the suite’s own catalogue', () => {
    const vision = (model: string): boolean | null => {
      const answer = aiAvailabilityFor(settingsWith('anthropic', { apiKey: 'k', model }))
      return answer.available ? answer.visionCapable : null
    }
    expect(vision('claude-opus-4-7')).toBe(true)
    // A text-only family: usable for every page with a text layer, so this is
    // reported rather than treated as unavailability.
    expect(vision('deep-seek-v4-flash')).toBe(false)
    expect(
      aiAvailabilityFor(settingsWith('anthropic', { apiKey: 'k', model: 'x' })).available,
    ).toBe(true)
  })

  it('still refuses without a bridge, and never throws on unreadable settings', async () => {
    const missing = await readAiReadiness(null)
    expect(missing.ready).toBe(false)
    if (!missing.ready) {
      expect(missing.code).toBe('bridge-unavailable')
      expect(missing.reason, 'not an availability answer at all').toBeUndefined()
    }
    const broken = await readAiReadiness({
      ...bridgeDouble().bridge,
      getAiSettings: async () => {
        throw new Error('disk error')
      },
    })
    expect(broken.ready).toBe(false)
    if (!broken.ready) {
      expect(broken.code).toBe('settings-unavailable')
      expect(broken.message).toMatch(/disk error/)
    }
  })
})

// ── a dead stream must not hang ───────────────────────────────────────────────

describe('a model stream that dies is cancelled, not left hanging', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels and reports a stream that goes silent', async () => {
    vi.useFakeTimers()
    const harness = bridgeDouble()
    const completion = createTendersCompletion({
      bridge: harness.bridge,
      settings: SETTINGS,
      newRequestId: () => 'req-silent',
      silenceTimeoutMs: 1_000,
      absoluteTimeoutMs: 600_000,
    })
    const promise = completion({ system: 's', user: 'u' })
    // The rejection is claimed before the timer can fire, so the test never
    // leaves an unhandled rejection behind while it advances the clock.
    const outcome = expect(promise).rejects.toThrow(aiExtractionTimeoutMessage('silence', 1_000))
    harness.emit({ requestId: 'req-silent', type: 'delta', text: '{"a":' })
    await vi.advanceTimersByTimeAsync(999)
    expect(harness.cancels, 'still inside the silence window').toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    await outcome
    expect(harness.cancels, 'the dead request is cancelled in main').toEqual(['req-silent'])
    expect(harness.listeners(), 'and its listener is released').toBe(0)
    expect(vi.getTimerCount(), 'no watchdog is left armed').toBe(0)
  })

  it('every chunk re-arms the silence window', async () => {
    vi.useFakeTimers()
    const harness = bridgeDouble()
    const completion = createTendersCompletion({
      bridge: harness.bridge,
      settings: SETTINGS,
      newRequestId: () => 'req-alive',
      silenceTimeoutMs: 1_000,
      absoluteTimeoutMs: 600_000,
    })
    const promise = completion({ system: 's', user: 'u' })
    // Three chunks, each inside the window but never 1 000 ms apart.
    for (let index = 0; index < 3; index += 1) {
      harness.emit({ requestId: 'req-alive', type: 'delta', text: 'x' })
      await vi.advanceTimersByTimeAsync(900)
    }
    harness.emit({ requestId: 'req-alive', type: 'done' })
    await expect(promise).resolves.toBe('xxx')
    expect(harness.cancels).toEqual([])
  })

  it('caps a stream that keeps talking but never finishes', async () => {
    vi.useFakeTimers()
    const harness = bridgeDouble()
    const completion = createTendersCompletion({
      bridge: harness.bridge,
      settings: SETTINGS,
      newRequestId: () => 'req-long',
      // Far longer than the cap, so only the absolute bound can end this call.
      silenceTimeoutMs: 600_000,
      absoluteTimeoutMs: 3_000,
    })
    const promise = completion({ system: 's', user: 'u' })
    const outcome = expect(promise).rejects.toThrow(aiExtractionTimeoutMessage('absolute', 3_000))
    for (let index = 0; index < 3; index += 1) {
      harness.emit({ requestId: 'req-long', type: 'ping' })
      await vi.advanceTimersByTimeAsync(1_000)
    }
    await outcome
    expect(harness.cancels).toEqual(['req-long'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves a call that finishes in time completely alone', async () => {
    vi.useFakeTimers()
    const harness = bridgeDouble()
    const completion = createTendersCompletion({
      bridge: harness.bridge,
      settings: SETTINGS,
      newRequestId: () => 'req-ok',
      silenceTimeoutMs: 1_000,
      absoluteTimeoutMs: 2_000,
    })
    const promise = completion({ system: 's', user: 'u' })
    harness.emit({ requestId: 'req-ok', type: 'delta', text: '{"a":1}' })
    harness.emit({ requestId: 'req-ok', type: 'done' })
    await expect(promise).resolves.toBe('{"a":1}')
    expect(harness.cancels).toEqual([])
    expect(vi.getTimerCount(), 'both watchdogs are cleared on settle').toBe(0)
    // …and nothing fires later: a settled call is not cancelled by a stale timer.
    await vi.advanceTimersByTimeAsync(600_000)
    expect(harness.cancels).toEqual([])
  })

  it('the watchdog message names what happened and claims no result', () => {
    for (const kind of ['silence', 'absolute'] as const) {
      const message = aiExtractionTimeoutMessage(kind, 240_000)
      expect(message).toMatch(/4 minutes/)
      expect(message).toMatch(/cancelled/)
      expect(message, 'nothing was read from that reply').toMatch(/Nothing was read/)
      expect(message, 'and the offline result is unaffected').toMatch(/local rule engine/)
      expect(message, 'the model is never called verified or accurate').not.toMatch(
        /verified|accurate|confirmed by/i,
      )
    }
  })
})

// ── one failure class per failure ─────────────────────────────────────────────
//
// The shell's `ai:stream` handler classifies an error chunk as
// `'timeout' | 'credits' | 'network' | 'overloaded'` (`chunk.errorCode`), which
// is exactly the set a BYOK user has to tell apart. The transport used to use
// only `chunk.error`, so those four arrived as one indistinguishable sentence —
// the class was thrown away at the last hop before the user.

describe('a BYOK failure is reported by class, not as one sentence', () => {
  const CLASSES = ['timeout', 'credits', 'network', 'overloaded'] as const

  it('leads with the class and keeps the provider’s own words after it', () => {
    for (const code of CLASSES) {
      const message = aiExtractionErrorMessage(code, 'HTTP 402: credit balance is too low')
      expect(message, `the message must name the ${code} class`).toContain(
        AI_EXTRACTION_ERROR_CLASS_MESSAGES[code],
      )
      expect(
        message,
        'the provider’s own text must survive, so support can still see it',
      ).toContain('HTTP 402: credit balance is too low')
      expect(message, 'and nothing is invented about the extraction').not.toMatch(
        /verified|accurate|confirmed by/i,
      )
    }
    // The whole defect in one assertion: four failures, four different sentences.
    const messages = CLASSES.map((code) => aiExtractionErrorMessage(code, 'same provider text'))
    expect(new Set(messages).size, 'each class must read differently').toBe(CLASSES.length)
  })

  it('passes an unclassified reason through untouched, except a 401', () => {
    expect(
      aiExtractionErrorMessage(undefined, 'The model returned something odd.'),
      'an unknown reason is the provider’s text, unedited',
    ).toBe('The model returned something odd.')
    for (const raw of [
      'HTTP 401: {"error":{"type":"authentication_error"}}',
      'Claude HTTP 401: invalid x-api-key',
      'Gemini HTTP 401: API key not valid. Please pass a valid API key.',
    ]) {
      const message = aiExtractionErrorMessage(undefined, raw)
      expect(message, `a 401 must be actionable (${raw})`).toContain(
        AI_EXTRACTION_AUTH_FAILURE_MESSAGE,
      )
      expect(message, 'and must still quote what the provider said').toContain(raw)
    }
    // A classified failure is never rewritten as an auth failure.
    expect(aiExtractionErrorMessage('overloaded', 'HTTP 401 lookalike')).toContain(
      AI_EXTRACTION_ERROR_CLASS_MESSAGES.overloaded,
    )
  })

  it('the class reaches the caller through the stream, not only the pure helper', async () => {
    const harness = bridgeDouble()
    const completion = createTendersCompletion({
      bridge: harness.bridge,
      settings: SETTINGS,
      newRequestId: () => 'req-402',
      silenceTimeoutMs: 600_000,
      absoluteTimeoutMs: 600_000,
    })
    const promise = completion({ system: 's', user: 'u' })
    const outcome = expect(promise).rejects.toThrow(
      /no credit left.*\(HTTP 402: credit balance is too low\)/s,
    )
    harness.emit({
      requestId: 'req-402',
      type: 'error',
      error: 'HTTP 402: credit balance is too low',
      errorCode: 'credits',
    })
    await outcome
    expect(harness.listeners(), 'the failed call releases its listener').toBe(0)

    // …and the same stream without a class keeps today's behaviour exactly.
    const plain = bridgeDouble()
    const plainCompletion = createTendersCompletion({
      bridge: plain.bridge,
      settings: SETTINGS,
      newRequestId: () => 'req-plain',
      silenceTimeoutMs: 600_000,
      absoluteTimeoutMs: 600_000,
    })
    const plainPromise = plainCompletion({ system: 's', user: 'u' })
    const plainOutcome = expect(plainPromise).rejects.toThrow(
      'The model sent a reply this run could not use.',
    )
    plain.emit({
      requestId: 'req-plain',
      type: 'error',
      error: 'The model sent a reply this run could not use.',
    })
    await plainOutcome
  })
})
