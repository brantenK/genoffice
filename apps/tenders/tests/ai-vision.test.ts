// The vision lane — reading the pages that have no text layer.
//
// The local rule engine cannot read a page whose text layer is unusable, and such
// a page blocks readiness until something does. This file pins what the optional
// vision pass may and may not do about it, with every model call injected:
//
//   * a page the parser flagged `needsOcr` becomes `ai-extracted` with
//     `AI_VISION_METHOD` ONLY when a reading of its image actually came back — and
//     everything lifted from that reading is a `suggestedBy: 'ai'` suggestion that
//     stays `unconfirmed`;
//   * a page whose reading failed, was refused, was cancelled, or was never
//     flagged `needsOcr` is NEVER marked, so it keeps blocking exactly as before;
//   * a model that cannot take an image is never asked to read one, and the pages
//     it could not have read are reported as still blocking rather than skipped
//     silently;
//   * the image really does reach the request, in the wire shape the provider
//     protocols map — the one thing a fake completion could hide.
//
// No network anywhere: the completions are doubles, and the bridge double exists
// only to show what a real request would carry.
import { describe, expect, it } from 'vitest'
import { AI_PROVIDERS, getProviderAdapter, type AiSettings } from '@genoffice/ai-provider/browser'
import {
  buildVisionReadPrompt,
  MIN_VISION_TRANSCRIPT_CHARS,
  parseVisionReadReply,
  VISION_UNREADABLE_MARKER,
  type AiCompletion,
} from '../src/shared/ai-extraction'
import type { AiStreamChunk, AiStreamRequest } from '../src/shared/ipc'
import { unprovenOcrPageCount, unreviewedOcrPages } from '../src/shared/readiness'
import {
  AI_VISION_METHOD,
  type IntakeVerification,
  type PageExtractionState,
} from '../src/shared/types'
import {
  adaptAiExtraction,
  AI_EXTRACTION_RULES,
  createVisionCompletion,
  markModelReadPages,
  mergeAiIntoReview,
  RUN_DEADLINE_REASON,
  runDeadlineWarning,
  runTenderAiPass,
  settingsSupportVision,
  VISION_CANCELLED_REASON,
  VISION_DEADLINE_REASON,
  type AiPageImage,
  type AiRunBudget,
  type AiVisionCompletion,
  type TenderAiPassVision,
} from '../src/renderer/src/ai/extract-with-ai'
import {
  DEFAULT_PAGE_IMAGE_MAX_EDGE,
  decodeDataUrl,
  PAGE_IMAGE_MIME,
  PageImageError,
  pageImageSize,
} from '../src/renderer/src/pdf/page-image'
import type { TendersAiBridge } from '../src/renderer/src/ai/transport'

const AT = '2026-09-01T00:00:00.000Z'

const PAGE_1_TEXT =
  'A valid SARS Tax Clearance must be submitted with the bid. Reference Number: ICT/2026/042'

/** A page's reading, long enough to count as content (see the threshold below). */
const PAGE_2_TRANSCRIPT = [
  'COIDA LETTER OF GOOD STANDING',
  'Bidders must submit a letter of good standing issued by the Compensation Fund.',
].join('\n')

function settingsWith(provider: string, config: Record<string, string>): AiSettings {
  return { provider, providers: { [provider]: config } } as unknown as AiSettings
}

/** The extraction reply for a chunk holding page 1. */
const PAGE_1_REPLY = JSON.stringify({
  metadata: [
    {
      field: 'referenceNumber',
      value: 'ICT/2026/042',
      pageNumber: 1,
      sourceClause: 'Reference Number: ICT/2026/042',
      confidence: 0.8,
    },
  ],
  requirements: [
    {
      ruleKey: 'tax_pin',
      title: 'Tax clearance',
      verbatimClause: 'A valid SARS Tax Clearance must be submitted with the bid.',
      pageNumber: 1,
      boundingBox: { top: 0.1, left: 0.1, width: 0.5, height: 0.05 },
      confidence: 0.7,
    },
  ],
})

/** The extraction reply for a chunk holding the model's reading of one page. */
function requirementReply(pageNumber: number): string {
  return JSON.stringify({
    requirements: [
      {
        ruleKey: 'coida',
        title: 'COIDA letter',
        verbatimClause:
          'Bidders must submit a letter of good standing issued by the Compensation Fund.',
        pageNumber,
        boundingBox: { top: 0.2, left: 0.1, width: 0.5, height: 0.05 },
        confidence: 0.6,
      },
    ],
  })
}

const PAGE_2_REPLY = requirementReply(2)

const PAGE_MARKER = /--- PAGE (\d+) ---/

/** A text-pass model double: one reply per chunk, chosen by the page it carries. */
function textCompletion(): AiCompletion & { calls: Array<{ system: string; user: string }> } {
  const calls: Array<{ system: string; user: string }> = []
  const completion: AiCompletion = async ({ system, user }) => {
    calls.push({ system, user })
    const page = PAGE_MARKER.exec(user)?.[1]
    return page === '2' ? PAGE_2_REPLY : PAGE_1_REPLY
  }
  return Object.assign(completion, { calls })
}

const ATTACHED_PAGE = /The attached image is page (\d+) of (\d+)\./

interface VisionDouble {
  completion: AiVisionCompletion
  calls: Array<{ pageNumber: number; images: readonly AiPageImage[]; system: string; user: string }>
}

/**
 * A vision model double: it answers per page, so one page's refusal or failure
 * cannot hide behind another's reading.
 */
function visionCompletion(
  reply: (pageNumber: number) => string,
  options: { onCall?: (pageNumber: number) => void } = {},
): VisionDouble {
  const calls: VisionDouble['calls'] = []
  const completion: AiVisionCompletion = async ({ system, user, images }) => {
    const pageNumber = Number(ATTACHED_PAGE.exec(user)?.[1] ?? 0)
    calls.push({ pageNumber, images, system, user })
    options.onCall?.(pageNumber)
    return reply(pageNumber)
  }
  return { completion, calls }
}

/** A page image double: what a real render would hand the model. */
function imageFor(pageNumber: number): AiPageImage {
  return { base64: `cGFnZS0${pageNumber}`, mime: PAGE_IMAGE_MIME }
}

function passPages(): Array<{ pageNumber: number; text: string; needsOcr: boolean }> {
  return [
    { pageNumber: 1, text: PAGE_1_TEXT, needsOcr: false },
    { pageNumber: 2, text: '', needsOcr: true },
    { pageNumber: 3, text: '', needsOcr: true },
  ]
}

async function runPass(vision?: TenderAiPassVision, signal?: AbortSignal) {
  return runTenderAiPass({
    completion: textCompletion(),
    pages: passPages(),
    numPages: 3,
    rules: AI_EXTRACTION_RULES,
    fileName: 'rfp.pdf',
    tenderTitle: 'Laptops',
    ...(vision ? { vision } : {}),
    ...(signal ? { signal } : {}),
  })
}

/** The review's page states, exactly as `deriveTenderReview` writes them. */
function reviewPages(): PageExtractionState[] {
  return [
    { pageNumber: 1, state: 'native', method: 'native-text', confidence: null, reviewedAt: null },
    { pageNumber: 2, state: 'ocr-required', method: null, confidence: null, reviewedAt: null },
    { pageNumber: 3, state: 'ocr-required', method: null, confidence: null, reviewedAt: null },
  ]
}

function reviewWith(pages: PageExtractionState[]): IntakeVerification {
  return {
    fields: {},
    requirements: {},
    pages,
    contactEmail: null,
    conflicts: [],
    createdAt: AT,
    updatedAt: AT,
  }
}

function tenderWith(intake: IntakeVerification) {
  return { ocrPages: 2, intakeVerification: intake }
}

// ── the image's cost bound ────────────────────────────────────────────────────

describe('page images', () => {
  it('caps a scanned page’s longest edge, so the request cannot carry a full-resolution scan', () => {
    // An A4 page scanned at 300 dpi: 2480×3508.
    expect(pageImageSize(2480, 3508)).toEqual({ width: 1060, height: 1500 })
    expect(DEFAULT_PAGE_IMAGE_MAX_EDGE).toBe(1500)
    expect(pageImageSize(2480, 3508, 1000)).toEqual({ width: 707, height: 1000 })
  })

  it('never upscales a page that is already inside the cap', () => {
    expect(pageImageSize(800, 600)).toEqual({ width: 800, height: 600 })
  })

  it('reports no size for a page that has none, rather than inventing one', () => {
    expect(pageImageSize(0, 500)).toEqual({ width: 0, height: 0 })
    expect(pageImageSize(Number.NaN, 500)).toEqual({ width: 0, height: 0 })
  })

  it('takes the image’s type from the encoder, so the declared mime always matches the bytes', () => {
    expect(decodeDataUrl('data:image/jpeg;base64,AAAA')).toEqual({
      mime: 'image/jpeg',
      base64: 'AAAA',
    })
    expect(() => decodeDataUrl('not-a-data-url')).toThrow(PageImageError)
  })
})

// ── the transcription prompt and its reply ────────────────────────────────────

describe('the vision read prompt and reply', () => {
  it('asks for a verbatim transcription of one page, with a way to refuse', () => {
    const prompt = buildVisionReadPrompt({ pageNumber: 7, numPages: 12, fileName: 'rfp.pdf' })
    expect(prompt.user).toContain('The attached image is page 7 of 12.')
    expect(prompt.user).toContain('Document: rfp.pdf')
    expect(prompt.system).toContain('Transcribe the page’s text EXACTLY')
    expect(prompt.system).toContain(VISION_UNREADABLE_MARKER)
    // A transcription request, not an extraction request: no rule catalogue here.
    expect(prompt.system).not.toContain('ruleKey')
  })

  it('reads a page’s text back, unwrapping a fence or an object wrapper', () => {
    const parsed = parseVisionReadReply(PAGE_2_TRANSCRIPT)
    expect(parsed).toEqual({ ok: true, text: PAGE_2_TRANSCRIPT })
    expect(parseVisionReadReply('```text\n' + PAGE_2_TRANSCRIPT + '\n```')).toEqual({
      ok: true,
      text: PAGE_2_TRANSCRIPT,
    })
    expect(parseVisionReadReply(JSON.stringify({ text: PAGE_2_TRANSCRIPT }))).toEqual({
      ok: true,
      text: PAGE_2_TRANSCRIPT,
    })
  })

  it('treats a refusal as a failure, never as the page’s text', () => {
    for (const refusal of ['UNREADABLE', 'unreadable.', '"UNREADABLE"', ' UNREADABLE ']) {
      const parsed = parseVisionReadReply(refusal)
      expect(parsed.ok, refusal).toBe(false)
    }
    // The rule is exact, so a page whose own text merely mentions the marker is
    // still read: the refusal cannot be widened into rejecting real pages.
    expect(parseVisionReadReply('The page says the word UNREADABLE in its footer.').ok).toBe(true)
    expect(
      parseVisionReadReply('This notice is unreadable in parts, and the rest follows below.').ok,
    ).toBe(true)
  })

  it('refuses an empty reply and a reading too short to be a page’s content', () => {
    expect(parseVisionReadReply('').ok).toBe(false)
    expect(parseVisionReadReply('   \n  ').ok).toBe(false)
    const short = parseVisionReadReply('Page 3')
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.error).toContain(String(MIN_VISION_TRANSCRIPT_CHARS))
    // ...and the threshold matches the parser's own: `needsOcr` is exactly this
    // many non-whitespace characters, so a reading below it has produced no more
    // usable text than the text layer it replaces.
    expect(MIN_VISION_TRANSCRIPT_CHARS).toBe(20)
    expect(parseVisionReadReply('x'.repeat(MIN_VISION_TRANSCRIPT_CHARS)).ok).toBe(true)
  })
})

// ── can this model read an image at all ───────────────────────────────────────

describe('the vision capability gate', () => {
  it('mirrors the provider catalogue, so the gate cannot drift from the suite’s own', () => {
    for (const provider of AI_PROVIDERS) {
      const expected = getProviderAdapter(provider.id).capabilities.vision
      expect(settingsSupportVision(settingsWith(provider.id, { model: '' })), provider.id).toBe(
        expected,
      )
    }
  })

  it('refuses a model the catalogue knows is text-only, and a provider it cannot resolve', () => {
    expect(settingsSupportVision(settingsWith('anthropic', { model: 'claude-opus-4-7' }))).toBe(
      true,
    )
    expect(settingsSupportVision(settingsWith('anthropic', { model: 'deepseek-v4-pro' }))).toBe(
      false,
    )
    expect(settingsSupportVision(settingsWith('glm', { model: 'glm-4-plus' }))).toBe(false)
    expect(settingsSupportVision(settingsWith('not-a-provider', { model: 'x' }))).toBe(false)
  })
})

// ── the image really reaches the request ──────────────────────────────────────

describe('the vision completion on the shared bridge', () => {
  it('puts the page image on the outgoing user message, in the wire shape', async () => {
    const requests: AiStreamRequest[] = []
    let handler: ((chunk: AiStreamChunk) => void) | null = null
    const bridge: TendersAiBridge = {
      getAiSettings: async () => settingsWith('anthropic', { apiKey: 'sk-test', model: 'claude' }),
      aiStream: (request) => {
        requests.push(request)
        queueMicrotask(() => {
          handler?.({ requestId: request.requestId, type: 'delta', text: 'read it' })
          handler?.({ requestId: request.requestId, type: 'done' })
        })
      },
      aiStreamCancel: () => {},
      onAiStream: (registered) => {
        handler = registered
        return () => {
          handler = null
        }
      },
    }

    const completion = createVisionCompletion({
      bridge,
      settings: settingsWith('anthropic', { apiKey: 'sk-test', model: 'claude' }),
      newRequestId: () => 'req-1',
    })
    const text = await completion({
      system: 'transcribe',
      user: 'The attached image is page 4 of 9.',
      images: [imageFor(4)],
    })

    expect(text).toBe('read it')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.requestId).toBe('req-1')
    expect(requests[0]!.system).toBe('transcribe')
    expect(requests[0]!.messages).toHaveLength(1)
    expect(requests[0]!.messages[0]).toMatchObject({
      role: 'user',
      text: 'The attached image is page 4 of 9.',
      images: [{ base64: imageFor(4).base64, mime: PAGE_IMAGE_MIME }],
    })
  })
})

// ── the pass ──────────────────────────────────────────────────────────────────

describe('the vision pass', () => {
  it('reads a flagged page, extracts from its reading, and leaves the refused page blocking', async () => {
    const vision = visionCompletion((pageNumber) =>
      pageNumber === 2 ? PAGE_2_TRANSCRIPT : VISION_UNREADABLE_MARKER,
    )
    const pass = await runPass({
      available: true,
      completion: vision.completion,
      renderPageImage: async (pageNumber) => imageFor(pageNumber),
    })

    // Only the pages the parser flagged are ever attempted.
    expect(pass.vision.scannedPages).toEqual([2, 3])
    expect(pass.vision.readPages).toEqual([2])
    expect(pass.vision.unread.map((page) => page.pageNumber)).toEqual([3])
    expect(vision.calls.map((call) => call.pageNumber)).toEqual([2, 3])
    // Each attempt carries that page's own image and the transcription prompt.
    expect(vision.calls[0]!.images).toEqual([imageFor(2)])
    expect(vision.calls[0]!.user).toContain('The attached image is page 2 of 3.')

    // Provenance: the model read page 2, so it is `ai-vision` with no chunk behind
    // it — never `native-text`, which would claim a text layer it does not have.
    expect(pass.merged.pagesRead).toEqual([
      { pageNumber: 1, method: 'native-text', chunkIndex: 0 },
      { pageNumber: 2, method: 'ai-vision', chunkIndex: null },
    ])
    expect(pass.merged.unreadPages).toEqual([3])
    expect(pass.vision.summary).toMatch(/read by the model/)
    expect(pass.vision.summary).toMatch(/still blocks readiness/)

    // The reading went through the same extraction path as a text page.
    const adaptation = adaptAiExtraction({
      merged: pass.merged,
      existingRuleKeys: [],
      existingTenders: [],
      tenderId: 'tender-1',
      visionSummary: pass.vision.summary,
    })
    expect(adaptation.requirements.map((requirement) => requirement.ruleKey)).toEqual([
      'tax_pin',
      'coida',
    ])
    for (const requirement of adaptation.requirements) {
      expect(requirement.suggestedBy).toBe('ai')
      expect(requirement).not.toHaveProperty('provenance')
    }
    expect(adaptation.candidates.referenceNumber?.[0]?.suggestedBy).toBe('ai')
    expect(adaptation.summary).toContain('read by the model')

    const pages = markModelReadPages(reviewPages(), {
      scannedPages: pass.vision.scannedPages,
      readPages: pass.vision.readPages,
    })
    expect(pages[0]).toEqual(reviewPages()[0])
    expect(pages[1]).toEqual({
      pageNumber: 2,
      state: 'ai-extracted',
      method: AI_VISION_METHOD,
      confidence: null,
      reviewedAt: null,
    })
    // Page 3's reading was refused, so it blocks exactly as it did before.
    expect(pages[2]).toEqual(reviewPages()[2])

    // ...and the readiness consequence, which is the point of the whole lane: the
    // model-read page stops blocking the PAGE gate while every value lifted from
    // it stays unconfirmed, and the refused page still blocks.
    const intake = mergeAiIntoReview(reviewWith(pages), adaptation, AT)
    expect(intake.fields.referenceNumber?.state).toBe('unconfirmed')
    expect(intake.fields.referenceNumber?.suggestedBy).toBe('ai')
    expect(Object.values(intake.requirements).map((entry) => entry.state)).toEqual([
      'unreviewed',
      'unreviewed',
    ])
    expect(unreviewedOcrPages(intake).map((page) => page.pageNumber)).toEqual([3])
    expect(unprovenOcrPageCount(tenderWith(intake))).toBe(1)
  })

  it('leaves a page blocking when its image cannot be rendered', async () => {
    const vision = visionCompletion(() => PAGE_2_TRANSCRIPT)
    const pass = await runPass({
      available: true,
      completion: vision.completion,
      renderPageImage: async (pageNumber) => {
        if (pageNumber === 2) throw new PageImageError('RENDER_FAILED', 'Page 2 broke.')
        return imageFor(pageNumber)
      },
    })
    expect(pass.vision.readPages).toEqual([3])
    const unread = pass.vision.unread.find((page) => page.pageNumber === 2)
    expect(unread?.reason).toMatch(/could not be rendered/)
    expect(pass.merged.unreadPages).toEqual([2])
    const pages = markModelReadPages(reviewPages(), {
      scannedPages: pass.vision.scannedPages,
      readPages: pass.vision.readPages,
    })
    expect(pages[1]).toEqual(reviewPages()[1])
  })

  it('leaves a page blocking when the model call fails', async () => {
    const vision = visionCompletion((pageNumber) => {
      if (pageNumber === 2) throw new Error('the provider refused the request')
      return PAGE_2_TRANSCRIPT
    })
    const pass = await runPass({
      available: true,
      completion: vision.completion,
      renderPageImage: async (pageNumber) => imageFor(pageNumber),
    })
    expect(pass.vision.readPages).toEqual([3])
    expect(pass.vision.unread[0]!.reason).toMatch(/refused the request/)
  })

  it('never marks a page the parser did not flag, even if a read claims it', async () => {
    // A model reading a page nobody asked about — or a caller handing over a
    // stray page number — must not touch it: readiness' OCR accounting is
    // count-based, so one page too many would weaken the gate.
    const pages = reviewPages()
    const marked = markModelReadPages(pages, { scannedPages: [3], readPages: [1, 2, 3] })
    expect(marked[0]).toEqual(pages[0])
    expect(marked[1]).toEqual(pages[1])
    expect(marked[2]?.state).toBe('ai-extracted')
  })

  it('never displaces a human’s own review of a page', async () => {
    const reviewed: PageExtractionState[] = [
      {
        pageNumber: 2,
        state: 'manually-reviewed',
        method: 'manual',
        confidence: 0.9,
        reviewedAt: AT,
      },
    ]
    expect(markModelReadPages(reviewed, { scannedPages: [2], readPages: [2] })).toEqual(reviewed)
  })

  it('refuses to read images for a text-only model, and says the pages still block', async () => {
    const vision = visionCompletion(() => PAGE_2_TRANSCRIPT)
    const pass = await runPass({
      available: false,
      reason: 'The model you configured cannot be used to read an image.',
    })

    // No vision request is made at all, and the reason names the pages it leaves
    // blocking instead of silently doing nothing.
    expect(vision.calls).toEqual([])
    expect(pass.vision.readPages).toEqual([])
    expect(pass.vision.skippedReason).toContain('cannot be used to read an image')
    expect(pass.vision.unread.map((page) => page.pageNumber)).toEqual([2, 3])
    expect(pass.vision.summary).toContain('cannot be used to read an image')
    expect(pass.vision.summary).toMatch(/they still block readiness/)
    expect(pass.merged.pagesRead).toEqual([{ pageNumber: 1, method: 'native-text', chunkIndex: 0 }])
    expect(pass.merged.unreadPages).toEqual([2, 3])

    const pages = markModelReadPages(reviewPages(), {
      scannedPages: pass.vision.scannedPages,
      readPages: pass.vision.readPages,
    })
    expect(pages).toEqual(reviewPages())
    expect(unprovenOcrPageCount(tenderWith(reviewWith(pages)))).toBe(2)
  })

  it('stops at a cancellation mid-vision, keeping the pages already read and touching no other', async () => {
    const controller = new AbortController()
    const vision = visionCompletion(() => PAGE_2_TRANSCRIPT, { onCall: () => controller.abort() })
    const pass = await runPass(
      {
        available: true,
        completion: vision.completion,
        renderPageImage: async (pageNumber) => imageFor(pageNumber),
      },
      controller.signal,
    )

    // Page 2's reading had already come back when the cancel landed, so it is
    // read; page 3 was never sent anywhere.
    expect(vision.calls.map((call) => call.pageNumber)).toEqual([2])
    expect(pass.vision.readPages).toEqual([2])
    expect(pass.vision.unread).toEqual([{ pageNumber: 3, reason: VISION_CANCELLED_REASON }])
    // The reading obtained page 2's content, so the merge records it as read even
    // though the extraction over it never ran — and page 3 stays unread.
    expect(pass.merged.pagesRead).toEqual([
      { pageNumber: 1, method: 'native-text', chunkIndex: 0 },
      { pageNumber: 2, method: 'ai-vision', chunkIndex: null },
    ])
    expect(pass.merged.unreadPages).toEqual([3])

    const pages = markModelReadPages(reviewPages(), {
      scannedPages: pass.vision.scannedPages,
      readPages: pass.vision.readPages,
    })
    expect(pages[1]?.state).toBe('ai-extracted')
    expect(pages[2]).toEqual(reviewPages()[2])
  })

  it('does nothing at all when no page needs a vision read', async () => {
    const vision = visionCompletion(() => PAGE_2_TRANSCRIPT)
    const pass = await runTenderAiPass({
      completion: textCompletion(),
      pages: [{ pageNumber: 1, text: PAGE_1_TEXT, needsOcr: false }],
      numPages: 1,
      rules: AI_EXTRACTION_RULES,
      vision: {
        available: true,
        completion: vision.completion,
        renderPageImage: async (pageNumber) => imageFor(pageNumber),
      },
    })
    expect(vision.calls).toEqual([])
    expect(pass.vision).toMatchObject({ scannedPages: [], readPages: [], summary: '' })
    expect(pass.merged.unreadPages).toEqual([])
  })

  it('never sends a flagged page as text — its image is read, or it stays unread', async () => {
    const completion = textCompletion()
    await runTenderAiPass({
      completion,
      pages: [
        { pageNumber: 1, text: PAGE_1_TEXT, needsOcr: false },
        // A scanned page whose invisible text layer holds a few characters: it is
        // flagged, so it must NOT also be sent as text.
        { pageNumber: 2, text: 'Page 2 of 9', needsOcr: true },
      ],
      numPages: 2,
      rules: AI_EXTRACTION_RULES,
    })
    expect(completion.calls).toHaveLength(1)
    expect(completion.calls[0]!.user).toContain('--- PAGE 1 ---')
    expect(completion.calls[0]!.user).not.toContain('--- PAGE 2 ---')
  })

  it('reads a document that is scanned end to end, and does not claim no request was made', async () => {
    const vision = visionCompletion((pageNumber) =>
      pageNumber === 3 ? VISION_UNREADABLE_MARKER : requirementReply(pageNumber),
    )
    const pass = await runTenderAiPass({
      completion: async () => requirementReply(1),
      pages: [
        { pageNumber: 1, text: '', needsOcr: true },
        { pageNumber: 2, text: '', needsOcr: true },
        { pageNumber: 3, text: '', needsOcr: true },
      ],
      numPages: 3,
      rules: AI_EXTRACTION_RULES,
      vision: {
        available: true,
        completion: vision.completion,
        renderPageImage: async (pageNumber) => imageFor(pageNumber),
      },
    })
    // The text pass had nothing to send, and the vision pass did — so the run
    // must not carry the chunker's "no AI extraction request was made".
    expect(pass.outcomes.length).toBeGreaterThan(0)
    expect(pass.merged.warnings).not.toContain(
      'No page text was available, so no AI extraction request was made.',
    )
    expect(pass.merged.pagesRead).toEqual([
      { pageNumber: 1, method: 'ai-vision', chunkIndex: null },
      { pageNumber: 2, method: 'ai-vision', chunkIndex: null },
    ])
    expect(pass.merged.unreadPages).toEqual([3])
    expect(pass.merged.requirements.map((requirement) => requirement.ruleKey)).toEqual(['coida'])
    expect(pass.merged.requirements[0]!.provenance).toBe('ai-suggested')
    expect(pass.merged.reviewState).toBe('unconfirmed')
  })
})

// ── the run's wall-clock budget ───────────────────────────────────────────────
//
// The Blocker this closes: nothing bounded `chunkCount × per-request latency`, so
// a long tender against a slow provider could run far past what a user will wait,
// with only a manual Cancel. These tests drive the budget with an injected clock,
// an injected timer and injected model calls, so nothing sleeps and nothing
// touches the network.
//
// What is asserted is the rule every other failure follows: a chunk that was
// stopped keeps its pages UNREAD (so they still block readiness), every other
// chunk's result is kept, and the run says in plain language that it stopped for
// time. A run the user cancelled is still reported as a cancellation.

interface ManualBudget {
  budget: AiRunBudget
  /** Move the clock forward, as a slow call would. */
  advance(milliseconds: number): void
  /** Every delay a timer was armed with, in the order they were armed. */
  armed(): number[]
  /** Timers still waiting, so a run can be shown to leave none behind. */
  pending(): number
}

/**
 * A scheduler a test drives.
 *
 * `fireOnArm` names the 1-based arming order of the timers that should fire as
 * soon as they are armed — which is exactly what a call that outlives its share
 * of the run looks like — and it is a NUMBER rather than a wait, so the deadline
 * is deterministic: no `setTimeout`, no sleeping, no flakiness.
 */
function manualBudget(options: {
  chunkBudgetMs: number
  runBudgetMs: number
  fireOnArm?: number[]
}): ManualBudget {
  const fireOnArm = new Set(options.fireOnArm ?? [])
  let current = 0
  let nextId = 1
  let armCount = 0
  let armed: number[] = []
  const delays: number[] = []
  return {
    budget: {
      chunkBudgetMs: options.chunkBudgetMs,
      runBudgetMs: options.runBudgetMs,
      now: () => current,
      setTimer: (callback, milliseconds) => {
        const id = nextId++
        armCount += 1
        delays.push(milliseconds)
        armed.push(id)
        if (fireOnArm.has(armCount)) queueMicrotask(callback)
        return id
      },
      clearTimer: (handle) => {
        armed = armed.filter((id) => id !== handle)
      },
    },
    advance(milliseconds) {
      current += milliseconds
    },
    armed: () => [...delays],
    pending: () => armed.length,
  }
}

/** A page carrying enough text that two of them become two chunks of their own. */
function longPage(pageNumber: number): { pageNumber: number; text: string; needsOcr: boolean } {
  return {
    pageNumber,
    text: `Requirement ${pageNumber} ${'the bidder must submit a valid tax clearance. '.repeat(280)}`,
    needsOcr: false,
  }
}

/** The page a text chunk carries, read off the prompt the chunker built. */
function chunkedPage(user: string): number {
  return Number(PAGE_MARKER.exec(user)?.[1] ?? 1)
}

describe('the run’s wall-clock budget', () => {
  it('bounds one call to its share of the run, and keeps every other chunk’s result', async () => {
    // Two chunks, and the FIRST call never answers. Without a per-call ceiling the
    // run would wait on it for as long as the provider kept the socket open.
    const clock = manualBudget({ chunkBudgetMs: 1_000, runBudgetMs: 60_000, fireOnArm: [1] })
    let calls = 0
    const completion: AiCompletion = async ({ user }) => {
      calls += 1
      if (calls === 1) return await new Promise<string>(() => {})
      return requirementReply(chunkedPage(user))
    }
    const pass = await runTenderAiPass({
      completion,
      pages: [longPage(1), longPage(2)],
      numPages: 2,
      rules: AI_EXTRACTION_RULES,
      budget: clock.budget,
    })

    expect(calls).toBe(2)
    // The first call was cut at exactly its own ceiling...
    expect(clock.armed()[0]).toBe(1_000)
    expect(pass.outcomes[0]!.error).toMatch(/outlived its share of the run’s time budget/)
    expect(pass.merged.unreadPages).toContain(1)
    // ...and the second chunk answered, so one slow call does not discard the run.
    expect(pass.merged.pagesRead.some((read) => read.pageNumber === 2)).toBe(true)
    expect(pass.merged.requirements.length).toBeGreaterThan(0)
    // No timer is left armed once the call has settled.
    expect(clock.pending()).toBe(0)
  })

  it('stops the whole run at its deadline and says so, with the pages it never reached', async () => {
    const clock = manualBudget({ chunkBudgetMs: 5_000, runBudgetMs: 2_500 })
    const completion: AiCompletion = async ({ user }) => {
      // The first chunk's reply alone overruns the whole run's budget.
      clock.advance(3_000)
      return requirementReply(chunkedPage(user))
    }
    const pass = await runTenderAiPass({
      completion,
      pages: [longPage(1), longPage(2)],
      numPages: 2,
      rules: AI_EXTRACTION_RULES,
      budget: clock.budget,
    })

    // Chunk 1 answered inside the budget; chunk 2's start is past the deadline, so
    // it is never sent at all.
    expect(pass.outcomes).toHaveLength(2)
    expect(pass.outcomes[0]!.error).toBeUndefined()
    expect(pass.outcomes[1]!.error).toBe(RUN_DEADLINE_REASON)
    expect(pass.merged.unreadPages).toEqual([2])
    // The page the run never reached still blocks readiness...
    expect(pass.merged.pagesRead).toEqual([{ pageNumber: 1, method: 'native-text', chunkIndex: 0 }])
    // ...and the run says why, in the copy a user reads.
    expect(pass.merged.warnings[0]).toBe(runDeadlineWarning(2_500))
    expect(pass.merged.warnings[0]).toMatch(/reached its 3 seconds time budget/)
    expect(pass.merged.warnings[0]).toMatch(/Everything it had read up to that point is kept/)
  })

  it('bounds the vision reads on the same clock, and leaves those pages blocking', async () => {
    const clock = manualBudget({ chunkBudgetMs: 5_000, runBudgetMs: 1_000 })
    const vision = visionCompletion((pageNumber) => requirementReply(pageNumber))
    const pass = await runTenderAiPass({
      completion: async () => {
        // The text chunk alone uses the entire run budget.
        clock.advance(1_000)
        return requirementReply(1)
      },
      pages: [
        { pageNumber: 1, text: 'A valid SARS Tax Clearance must be submitted.', needsOcr: false },
        { pageNumber: 2, text: '', needsOcr: true },
        { pageNumber: 3, text: '', needsOcr: true },
      ],
      numPages: 3,
      rules: AI_EXTRACTION_RULES,
      vision: {
        available: true,
        completion: vision.completion,
        renderPageImage: async (pageNumber) => imageFor(pageNumber),
      },
      budget: clock.budget,
    })

    expect(vision.calls, 'no page image is sent once the budget is spent').toHaveLength(0)
    expect(pass.vision.readPages).toEqual([])
    expect(pass.vision.unread.map((page) => page.reason)).toEqual([
      VISION_DEADLINE_REASON,
      VISION_DEADLINE_REASON,
    ])
    // The pages were never read, so they still block readiness.
    expect(pass.merged.unreadPages).toEqual([2, 3])
    expect(pass.merged.pagesRead).toEqual([{ pageNumber: 1, method: 'native-text', chunkIndex: 0 }])
  })

  it('reports a user’s cancellation as a cancellation, never as the budget', async () => {
    // The budget must not relabel a Cancel click. The signal is aborted before the
    // chunk is sent, which is the transport's own cancelled path.
    const clock = manualBudget({ chunkBudgetMs: 1_000, runBudgetMs: 60_000, fireOnArm: [1] })
    const controller = new AbortController()
    controller.abort()
    const pass = await runTenderAiPass({
      completion: async () => requirementReply(1),
      pages: [longPage(1), longPage(2)],
      numPages: 2,
      rules: AI_EXTRACTION_RULES,
      signal: controller.signal,
      budget: clock.budget,
    })

    expect(pass.outcomes.every((outcome) => /cancelled/.test(outcome.error ?? ''))).toBe(true)
    expect(pass.merged.warnings.join(' ')).not.toMatch(/time budget/)
    expect(pass.merged.unreadPages).toEqual([1, 2])
    expect(clock.armed(), 'nothing is armed for a run that never sends').toEqual([])
  })

  it('leaves a run that stays inside the budget exactly as it was', async () => {
    // The budget only ever changes what a SLOW run does: a run that comes nowhere
    // near either ceiling produces precisely what it produced before.
    const clock = manualBudget({ chunkBudgetMs: 300_000, runBudgetMs: 900_000 })
    const completion = textCompletion()
    const pass = await runTenderAiPass({
      completion,
      pages: passPages(),
      numPages: 3,
      rules: AI_EXTRACTION_RULES,
      budget: clock.budget,
    })
    // Pages 2 and 3 have no text layer and this run has no vision pass, so they
    // were never obtained — exactly as before the budget existed.
    expect(pass.outcomes).toHaveLength(1)
    expect(pass.merged.unreadPages).toEqual([2, 3])
    expect(pass.merged.warnings.join(' ')).not.toMatch(/time budget/)
    expect(clock.pending()).toBe(0)
  })
})
