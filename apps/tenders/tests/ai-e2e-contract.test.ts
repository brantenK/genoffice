// Contract test for the AI-extraction e2e fixtures.
//
// `e2e/tenders-ai-extraction.spec.ts` proves the whole path — preload bridge,
// shell `ai:*` handlers, provider layer, a real HTTP response — but it needs a
// built shell and a real Electron launch, so nothing in it runs in the normal
// unit lane. That leaves two of its assumptions unverified until the (slow, and
// here forbidden) e2e run: that the fake provider's reply is a reply the REAL
// core accepts, and that the fixture document really is the shape the journeys
// assume it is.
//
// This file pins both, against the real modules:
//
//  1. The fake reply passes `parseExtractionReply` and `validateSuggestions`
//     with the real `AI_EXTRACTION_RULES` catalogue and the real page count, so
//     a change to the JSON contract fails here in milliseconds instead of only
//     in the e2e. Every suggestion must also carry the core's own provenance and
//     the single review state a machine suggestion may have.
//  2. The fixture text produces exactly the local engine's own rules — `tax_pin`
//     and `coida` — and never `joint_venture`, so the model's requirement is
//     genuinely additive and "the local result survives alongside the model's"
//     has something concrete to check.
//  3. The fixture text yields no closing date, so the model's closing-date
//     suggestion is the only thing that can fill that review field — which is
//     what makes the e2e's "unconfirmed, suggestedBy: 'ai'" assertion about the
//     model rather than about the parser.
//  4. The whole chain the e2e asserts on disk — core → adapter → review merge —
//     produces `suggestedBy: 'ai'` on an `unconfirmed` field and on the added
//     requirement, and never a human decision.
//  5. The settings the fixture writes to disk ARE settings the app accepts: the
//     shell's own resolution (`resolveAiSettings` → `activeProvider`) keeps the
//     `custom` selection, and `aiExtractionAvailability` — the ONE decision the
//     toggle's guard and a run's own refusal both read — answers
//     `available: true` for exactly that object. This is the hypothesis the four
//     journeys rest on ("a model is configured, so the opt-in is offered"), and
//     it is pinned here in milliseconds rather than only in a slow e2e run.
//
// The fixtures are imported from `e2e/` deliberately: they are the SAME objects
// the spec serves and reads, so this test cannot drift from it.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AI_FAKE_KEY,
  AI_FAKE_MODEL,
  AI_FAKE_PROVIDER,
  AI_ONLY_RULE_KEY,
  AI_SETTINGS_FILE_NAME,
  AI_SUGGESTED_CLOSING_DATE,
  AI_SUGGESTED_REQUIREMENT_ID,
  AI_SUGGESTED_REQUIREMENT_TITLE,
  AI_SUGGESTION_MARKER,
  TENDER_FIXTURE_REF,
  aiReplyPayload,
  aiReplyText,
  aiSettingsFile,
  tenderFixtureLines,
  writeAiSettings,
  type AiSettingsFile,
} from '../../../e2e/tenders-ai-fixtures'
// The shell's own settings resolution, imported from source: `@genoffice/ai-provider`'s
// main entry also pulls the Node-backed Codex transport into a jsdom test, and
// `./browser` deliberately exports neither `resolveAiSettings` nor `activeProvider`.
// Importing the module that owns them is what makes this a check of the REAL
// resolution rather than a restatement of it.
import {
  activeProvider,
  defaultAiSettings,
  resolveAiSettings,
} from '../../../packages/ai-provider/src/providers'
import {
  aiExtractionAvailability,
  buildExtractionChunks,
  parseExtractionReply,
  runAiExtraction,
  validateSuggestions,
} from '../src/shared/ai-extraction'
import {
  adaptAiExtraction,
  AI_EXTRACTION_RULES,
  mergeAiIntoReview,
} from '../src/renderer/src/ai/extract-with-ai'
import {
  AI_SUGGESTION_LABEL,
  deriveTenderReview,
} from '../src/renderer/src/components/ExtractionReview'
import { extractTenderMeta, shredExtraction } from '../src/renderer/src/pdf/shred'
import { RULE_BY_KEY } from '../src/shared/rules'
import type { ExtractedPage, PageExtraction, PageLine } from '../src/shared/types'

const LINES = tenderFixtureLines(TENDER_FIXTURE_REF)

function makeLine(text: string, index: number): PageLine {
  return {
    pageNumber: 1,
    text,
    box: { top: 0.05 + index * 0.04, left: 0.1, width: 0.8, height: 0.025 },
  }
}

function fixtureDocument(): PageExtraction {
  const lines = LINES.map(makeLine)
  const page: ExtractedPage = {
    pageNumber: 1,
    width: 595,
    height: 842,
    text: lines.map((line) => line.text).join('\n'),
    lines,
    needsOcr: false,
  }
  return { numPages: 1, pages: [page], textPages: 1, ocrPages: 0 }
}

function fixtureChunking() {
  return buildExtractionChunks({
    pages: [{ pageNumber: 1, text: fixtureDocument().pages[0]!.text }],
    numPages: 1,
  })
}

describe('the AI-extraction e2e fixtures', () => {
  describe('the local engine reads the fixture document the way the journeys assume', () => {
    const requirements = shredExtraction(fixtureDocument())
    const ruleKeys = requirements.map((requirement) => requirement.ruleKey)

    it('finds exactly the two rules the journeys expect the parser to own', () => {
      expect(ruleKeys).toEqual(['tax_pin', 'coida'])
    })

    it('never finds the rule only the model reports, so its requirement is additive', () => {
      expect(ruleKeys).not.toContain(AI_ONLY_RULE_KEY)
    })

    it('produces only known catalogue keys, and never marks a parser value as AI', () => {
      for (const requirement of requirements) {
        expect(
          RULE_BY_KEY[requirement.ruleKey],
          `${requirement.ruleKey} is a catalogue key`,
        ).toBeTruthy()
        expect(requirement.suggestedBy, 'a parser requirement carries no AI marker').toBeUndefined()
      }
    })

    it('reads the reference and title the fixture plants, so both stay parser-owned', () => {
      const meta = extractTenderMeta(fixtureDocument(), 'ai-e2e')
      expect(meta.referenceNumber).toBe(TENDER_FIXTURE_REF)
      expect(meta.title.length).toBeGreaterThan(0)
    })

    it('reads no submission method or destination, so those gates stay open', () => {
      const meta = extractTenderMeta(fixtureDocument(), 'ai-e2e')
      expect(meta.submissionMethod).toBeNull()
      expect(meta.submissionAddress).toBeNull()
    })

    it('reads no closing date, so only the model can fill that field', () => {
      const meta = extractTenderMeta(fixtureDocument(), 'ai-e2e')
      expect(meta.closingDate).toBeNull()
      expect(meta.candidates?.closingDate ?? []).toEqual([])
    })
  })

  describe('the fake provider reply is a reply the real core accepts', () => {
    const parsed = parseExtractionReply(aiReplyText(), { chunk: fixtureChunking().chunks[0] })

    it('parses as the strict JSON object the prompt asks for', () => {
      expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true)
    })

    it('validates against the real catalogue with no rejection', () => {
      if (!parsed.ok) throw new Error(parsed.error)
      const validation = validateSuggestions(parsed.reply, {
        rules: AI_EXTRACTION_RULES,
        numPages: 1,
      })
      expect(validation.rejections).toEqual([])
      expect(validation.metadata).toHaveLength(1)
      expect(validation.requirements).toHaveLength(1)

      const metadata = validation.metadata[0]!
      expect(metadata.field).toBe('closingDate')
      expect(metadata.value).toBe(AI_SUGGESTED_CLOSING_DATE)
      expect(metadata.provenance, 'a model value is marked as such').toBe('ai-suggested')

      const requirement = validation.requirements[0]!
      expect(requirement.ruleKey).toBe(AI_ONLY_RULE_KEY)
      expect(requirement.id).toBe(AI_SUGGESTED_REQUIREMENT_ID)
      expect(requirement.title).toBe(AI_SUGGESTED_REQUIREMENT_TITLE)
      expect(requirement.provenance, 'a model value is marked as such').toBe('ai-suggested')
      // The catalogue is authoritative where it has an opinion, which is what
      // stops the reply's own values from deciding a requirement's weight.
      expect(requirement.category).toBe(RULE_BY_KEY[AI_ONLY_RULE_KEY]!.category)
      expect(requirement.riskLevel).toBe(RULE_BY_KEY[AI_ONLY_RULE_KEY]!.riskLevel)
    })

    it('survives the whole pipeline as a marked, unconfirmed suggestion', async () => {
      const run = await runAiExtraction({
        completion: async () => aiReplyText(),
        chunking: fixtureChunking(),
        context: { rules: AI_EXTRACTION_RULES, numPages: 1 },
        fileName: 'ai-e2e.pdf',
      })
      expect(run.merged.provenance).toBe('ai-suggested')
      expect(run.merged.reviewState, 'a machine suggestion may never be a decision').toBe(
        'unconfirmed',
      )
      expect(run.merged.metadata.map((item) => item.value)).toEqual([AI_SUGGESTED_CLOSING_DATE])
      expect(run.merged.requirements.map((item) => item.ruleKey)).toEqual([AI_ONLY_RULE_KEY])
      expect(run.merged.unreadPages, 'the one page was read').toEqual([])
    })
  })

  describe('the chain the e2e asserts on disk', () => {
    it('marks the added requirement and the filled field as AI-suggested, and decides nothing', async () => {
      const extraction = fixtureDocument()
      const run = await runAiExtraction({
        completion: async () => aiReplyText(),
        chunking: fixtureChunking(),
        context: { rules: AI_EXTRACTION_RULES, numPages: 1 },
        fileName: 'ai-e2e.pdf',
      })
      const localRequirements = shredExtraction(extraction)
      const adaptation = adaptAiExtraction({
        merged: run.merged,
        existingRuleKeys: localRequirements.map((requirement) => requirement.ruleKey),
      })

      expect(adaptation.requirements.map((requirement) => requirement.ruleKey)).toEqual([
        AI_ONLY_RULE_KEY,
      ])
      expect(adaptation.requirements[0]!.suggestedBy).toBe('ai')
      expect(adaptation.candidates.closingDate?.[0]).toMatchObject({
        value: AI_SUGGESTED_CLOSING_DATE,
        suggestedBy: 'ai',
      })

      const review = deriveTenderReview({
        meta: extractTenderMeta(extraction, 'ai-e2e'),
        extraction,
        requirements: localRequirements.map((requirement) => ({
          ...requirement,
          status: 'OUTSTANDING' as const,
          linkedVaultDocId: null,
          reason: null,
          suggestedVaultDocIds: [],
        })),
        estimatedValue: null,
      })
      const merged = mergeAiIntoReview(review, adaptation)

      const closing = merged.fields.closingDate
      expect(closing?.state, 'nothing a model produces may be a human decision').toBe('unconfirmed')
      expect(closing?.suggestedBy, 'the filled field is marked as a model suggestion').toBe('ai')
      expect(closing?.extractedValue).toBe(AI_SUGGESTED_CLOSING_DATE)
      expect(
        (closing?.candidates ?? []).some(
          (candidate) =>
            candidate.suggestedBy === 'ai' && candidate.value === AI_SUGGESTED_CLOSING_DATE,
        ),
      ).toBe(true)

      // No field of the review may be decided, and the model's requirement must
      // be registered unreviewed rather than verified.
      for (const [field, detail] of Object.entries(merged.fields)) {
        expect(detail?.state, `${field} must stay undecided`).toBe('unconfirmed')
      }
      expect(merged.requirements[AI_SUGGESTED_REQUIREMENT_ID]?.state).toBe('unreviewed')

      // The parser's own fields keep their own (absent = parser) provenance, so
      // a model is never credited with a value the rule engine read.
      expect(merged.fields.referenceNumber?.extractedValue).toBe(TENDER_FIXTURE_REF)
      expect(merged.fields.referenceNumber?.suggestedBy).toBeUndefined()
    })
  })

  describe('the settings the journeys write are settings the app accepts', () => {
    /** A stand-in for the fake provider's origin: any URL does, nothing connects. */
    const ORIGIN = 'http://127.0.0.1:1'
    /** Exactly what the shell does when a renderer asks for its AI settings. */
    const asShellReadsThem = (stored: AiSettingsFile) =>
      resolveAiSettings(stored as Parameters<typeof resolveAiSettings>[0], defaultAiSettings())
    /** The fixture's own provider entry, for the negative controls below. */
    const customConfig = (settings: AiSettingsFile) =>
      settings.providers[AI_FAKE_PROVIDER] as { apiKey: string; model: string; baseUrl?: string }

    it('keeps the configured provider through the shell\u2019s own resolution', () => {
      const resolved = asShellReadsThem(aiSettingsFile(ORIGIN))
      expect(resolved.provider).toBe(AI_FAKE_PROVIDER)
      expect(activeProvider(resolved), 'a usable selection is not swapped for the fallback').toBe(
        AI_FAKE_PROVIDER,
      )
      expect(resolved.providers[AI_FAKE_PROVIDER as 'custom']).toMatchObject({
        apiKey: AI_FAKE_KEY,
        model: AI_FAKE_MODEL,
        baseUrl: `${ORIGIN}/v1`,
      })
    })

    it('answers available for the resolved settings, so the opt-in can be offered', () => {
      const availability = aiExtractionAvailability({
        settings: asShellReadsThem(aiSettingsFile(ORIGIN)),
      })
      expect(availability.available, availability.available ? '' : availability.message).toBe(true)
      if (!availability.available) return
      expect(availability.provider).toBe(AI_FAKE_PROVIDER)
      expect(availability.model).toBe(AI_FAKE_MODEL)
    })

    it('answers available for the raw stored object, and needs no api key for custom', () => {
      // The stored file alone is enough — the shell's merge is not what makes it
      // usable. `custom`'s credential is the base URL and its key stays optional,
      // so an anonymous OpenAI-compatible endpoint is offered too; that is the
      // corrected credential rule the journeys rely on.
      expect(aiExtractionAvailability({ settings: aiSettingsFile(ORIGIN) }).available).toBe(true)
      const keyless = aiSettingsFile(ORIGIN)
      customConfig(keyless).apiKey = ''
      expect(aiExtractionAvailability({ settings: keyless }).available).toBe(true)
    })

    it('would refuse the same settings with no base URL, so the check has teeth', () => {
      const noBaseUrl = aiSettingsFile(ORIGIN)
      delete customConfig(noBaseUrl).baseUrl
      const resolved = asShellReadsThem(noBaseUrl)
      expect(
        activeProvider(resolved),
        'a custom provider with no base URL is not a usable selection',
      ).not.toBe(AI_FAKE_PROVIDER)
      const availability = aiExtractionAvailability({ settings: resolved })
      expect(availability.available).toBe(false)
      if (availability.available) return
      // The selection falls back to `anthropic`, which carries no key in the
      // defaults either — so the refusal lands in the credential bucket. The
      // point is that the fixture's own settings are what make it available.
      expect(availability.reason).toBe('no-api-key')
    })

    it('would refuse the same settings with no model, so the check has teeth', () => {
      const noModel = aiSettingsFile(ORIGIN)
      customConfig(noModel).model = ''
      const resolved = asShellReadsThem(noModel)
      expect(activeProvider(resolved), 'a model id is required').not.toBe(AI_FAKE_PROVIDER)
      expect(aiExtractionAvailability({ settings: resolved }).available).toBe(false)
    })

    it('writes that object to <userData>/ai-settings.json, where the shell reads it', async () => {
      // The one link the spec itself proves at runtime is the file's LOCATION;
      // this pins its name and contents against the shell's `SETTINGS_PATH()`.
      const dir = await mkdtemp(join(tmpdir(), 'tenders-ai-contract-'))
      try {
        const path = await writeAiSettings(dir, ORIGIN)
        expect(path).toBe(join(dir, AI_SETTINGS_FILE_NAME))
        expect(AI_SETTINGS_FILE_NAME).toBe('ai-settings.json')
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(aiSettingsFile(ORIGIN))
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  it('serves the reply it advertises', () => {
    const payload = aiReplyPayload()
    expect(aiReplyText()).toBe(JSON.stringify(payload))
    expect(payload.metadata).toHaveLength(1)
    expect(payload.requirements).toHaveLength(1)
  })

  it('pins the marker the spec asserts against the label the UI actually renders', () => {
    // The spec asserts the marker as a literal (it carries no runtime dependency
    // on renderer code); this is what keeps that literal honest, so renaming the
    // label fails here instead of only in the e2e run.
    expect(AI_SUGGESTION_LABEL).toBe(AI_SUGGESTION_MARKER)
  })
})
