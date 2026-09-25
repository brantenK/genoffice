/**
 * `ExtractionReview` rendered for real: the provenance marker, and the Word
 * document's own vocabulary.
 *
 * Replaces the source guards in `tests/renderer-display-locale.test.ts` that read
 * `ExtractionReview.tsx` / `RequirementList.tsx` as comment-stripped text:
 *
 *   * "renders the marker as visible chip text, never as a hover-only affordance"
 *     — `{AI_SUGGESTION_LABEL}` appearing in the file said nothing about whether a
 *     user sees it (or sees it on the right value);
 *   * "renders it behind the provenance predicate, so a parser value is never
 *     labelled" — a source regex cannot run the predicate at all;
 *   * "marks every place an origin is shown: field, candidate, suggestion and
 *     requirement" — four literal JSX strings, satisfiable by a comment-free
 *     component that renders none of them.
 *
 * What replaces them is the rendered tree: the marker's presence, its absence for
 * a parser value, and the four sites it has to appear at. The negative cases are
 * the point — a `parser`/unmarked value is the shape every stored tender had
 * before provenance existed, and it must render no marker at all.
 *
 * The .docx note is here for the same reason: `wordDocumentPaginationNote` was
 * asserted as a function (which is real behaviour) while the claim "the note is
 * shown to the user" rested on a source regex.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type {
  FieldReview,
  IntakeVerification,
  RequirementRecord,
  TenderRecord,
} from '../../src/shared/types'
import { docxPaginationNote } from '../../src/renderer/src/intake/docx'
import {
  AI_SUGGESTION_TITLE,
  ExtractionReview,
  pageStatusExplanation,
} from '../../src/renderer/src/components/ExtractionReview'
import { mount, unmountAll, type RenderResult } from '../helpers/render'

afterEach(() => {
  unmountAll()
})

const AI_LABEL = 'AI-suggested'
const AI_TITLE = AI_SUGGESTION_TITLE

function requirement(overrides: Partial<RequirementRecord> = {}): RequirementRecord {
  return {
    id: 'req-1',
    ruleKey: 'bbbee-certificate',
    title: 'Provide a valid B-BBEE certificate',
    category: 'GENERAL_RETURNABLE',
    isMandatory: true,
    verbatimClause: 'Bidders must provide a valid B-BBEE certificate.',
    pageNumber: 4,
    boundingBox: { top: 0.2, left: 0, width: 1, height: 0.05 },
    riskLevel: 'POINT_SCORED',
    order: 0,
    confidence: 0.4,
    status: 'OUTSTANDING',
    linkedVaultDocId: null,
    reason: null,
    suggestedVaultDocIds: [],
    ...overrides,
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
    submissionAddress: 'procurement@example.test',
    signatureChecks: {},
    status: 'IN_PROGRESS',
    createdAt: '2026-08-01',
    fileName: 'office-computers-rfp.pdf',
    fileUrl: 'documents/office-computers-rfp.pdf',
    numPages: 12,
    ocrPages: 0,
    requirements: [],
    ...overrides,
  }
}

function review(overrides: Partial<IntakeVerification> = {}): IntakeVerification {
  return {
    fields: {},
    requirements: {},
    pages: [
      { pageNumber: 1, state: 'native', method: 'native-text', confidence: null, reviewedAt: null },
    ],
    contactEmail: null,
    conflicts: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

function fieldReview(overrides: Partial<FieldReview> = {}): FieldReview {
  return {
    extractedValue: 'Supply and Delivery of Office Computers',
    sourcePage: 1,
    sourceClause: 'Supply and Delivery of Office Computers',
    confidence: 0.9,
    candidates: [],
    state: 'unconfirmed',
    reviewedAt: null,
    ...overrides,
  }
}

function renderReview(
  tenderOverrides: Partial<TenderRecord> = {},
  reviewOverrides: Partial<IntakeVerification> = {},
): RenderResult {
  return mount(
    <ExtractionReview
      tender={tender(tenderOverrides)}
      review={review(reviewOverrides)}
      pdfReady
      onBack={() => {}}
      onOpenRequirement={() => {}}
    />,
  )
}

describe("a model's suggestion is marked where the user reads it", () => {
  it('renders a visible AI-suggested marker on a field a model produced', () => {
    const view = renderReview({}, { fields: { title: fieldReview({ suggestedBy: 'ai' }) } })
    const card = view.getByText('Tender title').closest('fieldset')
    expect(card, 'the field card renders').not.toBeNull()
    // Visible text, not a tooltip: this is what the user reads on the field.
    expect(card!.textContent).toContain(AI_LABEL)
    // …and the tooltip explains the label rather than carrying it.
    const marker = view.getByText(AI_LABEL)
    expect(marker.getAttribute('title'), 'the chip explains itself on hover').toBe(AI_TITLE)
  })

  it('renders nothing for the local parser’s own read', () => {
    // `suggestedBy: 'parser'` and an unmarked field are the same claim: the rule
    // engine read it. A marker here would attribute the value to a model.
    for (const suggestedBy of ['parser', undefined] as const) {
      const view = renderReview({}, { fields: { title: fieldReview({ suggestedBy }) } })
      expect(view.text(), `no marker for suggestedBy=${String(suggestedBy)}`).not.toContain(
        AI_LABEL,
      )
      unmountAll()
    }
  })

  it('marks each competing candidate by its own provenance, not the field’s', () => {
    const view = renderReview(
      {},
      {
        fields: {
          closingDate: fieldReview({
            extractedValue: '2026-12-18',
            suggestedBy: 'ai',
            candidates: [
              { value: '2026-12-18', sourcePage: 2, sourceClause: 'closing', score: 1 },
              {
                value: '2026-12-21',
                sourcePage: 7,
                sourceClause: 'extension',
                score: 0.7,
                suggestedBy: 'ai',
              },
            ],
          }),
        },
      },
    )
    // One candidate set mixing a rule-engine read with a model suggestion: the
    // parser candidate must stay unmarked while the model's carries the marker.
    const legend = view.getByText('2 competing values — choose the one that stands')
    const list = legend.closest('fieldset')
    expect(list, 'the competing list is a fieldset').not.toBeNull()
    const marked = Array.from(list!.querySelectorAll(`[title]`)).filter(
      (el) => el.getAttribute('title') === AI_TITLE,
    )
    expect(marked.length, 'the model candidate carries exactly one chip').toBe(1)
    const rows = Array.from(list!.querySelectorAll('li'))
    const modelRow = rows.find((li) => li.contains(marked[0]))
    expect(modelRow, 'the chip sits on the model candidate’s row').toBeDefined()
    expect(modelRow!.textContent).toContain('2026-12-21')
    expect(
      rows.find((li) => li.textContent?.includes('2026-12-18'))?.textContent,
      'the parser candidate carries none',
    ).not.toContain(AI_LABEL)
  })

  it('marks a single suggestion offered beside the field', () => {
    const view = renderReview(
      {},
      {
        fields: {
          issuingBody: fieldReview({
            extractedValue: null,
            candidates: [
              {
                value: 'Department of Public Works',
                sourcePage: 3,
                sourceClause: 'issued by …',
                score: 0.9,
                suggestedBy: 'ai',
              },
            ],
          }),
        },
      },
    )
    const row = view.getByText(/Found in the document:/)
    const suggestion = row.closest('div')
    expect(suggestion!.textContent).toContain('Department of Public Works')
    expect(suggestion!.textContent).toContain(AI_LABEL)
  })

  it('marks a requirement a model suggested, in the review step', () => {
    const view = renderReview(
      { requirements: [requirement({ suggestedBy: 'ai' })] },
      {
        requirements: {
          'req-1': {
            state: 'unreviewed',
            originalTitle: null,
            originalCategory: null,
            correctedAt: null,
          },
        },
      },
    )
    const row = view.getByText('Provide a valid B-BBEE certificate')
    expect(row.closest('li')!.textContent).toContain(AI_LABEL)
  })

  it('leaves a parser-read requirement unmarked', () => {
    const view = renderReview(
      { requirements: [requirement()] },
      {
        requirements: {
          'req-1': {
            state: 'unreviewed',
            originalTitle: null,
            originalCategory: null,
            correctedAt: null,
          },
        },
      },
    )
    expect(view.text()).not.toContain(AI_LABEL)
  })
})

describe('a Word document is described in its own vocabulary', () => {
  it('states the pagination note the module produced, and states none for a PDF', () => {
    const docx = renderReview({ fileName: 'rfp.docx', numPages: 3 })
    expect(docx.getByTestId('docx-pagination-note').textContent).toBe(
      docxPaginationNote({ pagination: 'declared', numPages: 3 }),
    )
    expect(docx.text()).toContain('page breaks this .docx declares')

    const flowing = renderReview({ fileName: 'rfp.docx', numPages: 1 })
    expect(flowing.getByTestId('docx-pagination-note').textContent).toContain(
      'not printed page numbers',
    )
    unmountAll()

    // A PDF has real pages: the note would be a claim about a mechanism it does
    // not have.
    const pdf = renderReview({ fileName: 'rfp.pdf', numPages: 3 })
    expect(pdf.queryByTestId('docx-pagination-note')).toBeNull()
  })

  it('never calls a .docx page scanned, and explains it in the vocabulary of a Word file', () => {
    const view = renderReview(
      {
        fileName: 'rfp.docx',
        numPages: 3,
        ocrPages: 1,
      },
      {
        pages: [
          {
            pageNumber: 1,
            state: 'native',
            method: 'native-text',
            confidence: null,
            reviewedAt: null,
          },
          {
            pageNumber: 2,
            state: 'ocr-required',
            method: null,
            confidence: null,
            reviewedAt: null,
          },
        ],
      },
    )
    const text = view.text()
    expect(text, 'nothing scanned a Word page').not.toMatch(/\bscanned\b/i)
    expect(text, 'the page row explains a picture-only Word page in its own words').toContain(
      'This page holds no text — its content is a picture or a drawing.',
    )
    expect(text, 'the section names the document for what it is').toContain('is a Word .docx')
    // The status CHIP must carry the same vocabulary as the explanation beside
    // it. It used to reuse the PDF label "No text layer" for this page — a text
    // layer being the one thing a .docx page cannot have — which is the defect
    // this asserts against: the Word label, and no text layer anywhere in the
    // rendered tree of a .docx.
    expect(text, 'a .docx page has no text layer to name').not.toMatch(/text layer/i)
    const wordChip = view.getByText('Picture-only')
    expect(
      wordChip.getAttribute('title'),
      'the chip is explained in the same vocabulary as its label',
    ).toBe(pageStatusExplanation('ocr-required', true))
    // The resolved page in the same fixture is a `native` one: expanding the
    // readable list shows its chip saying the page carries text — a .docx has no
    // layer for it to name.
    view.click(view.getByRole('button', { name: /^Show 1 readable page/ }))
    expect(view.getByText('Has text').getAttribute('title')).toBe(
      pageStatusExplanation('native', true),
    )
  })

  it('still says scanned and text layer for a PDF, where both are real', () => {
    const view = renderReview(
      { fileName: 'rfp.pdf', ocrPages: 1 },
      {
        pages: [
          {
            pageNumber: 2,
            state: 'ocr-required',
            method: null,
            confidence: null,
            reviewedAt: null,
          },
        ],
      },
    )
    const text = view.text()
    expect(text).toMatch(/\bscanned\b/i)
    expect(text).toContain('text layer')
    // The PDF label is unchanged: the word-aware table must not have leaked into
    // the PDF branch.
    expect(view.getByText('No text layer').getAttribute('title')).toBe(
      pageStatusExplanation('ocr-required'),
    )
    expect(text).not.toContain('Picture-only')
  })
})
