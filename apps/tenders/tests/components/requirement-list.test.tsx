/**
 * `RequirementList` rendered for real: who produced a requirement, in the row's
 * own vocabulary.
 *
 * Replaces the source guard in `tests/renderer-display-locale.test.ts` that read
 * `RequirementList.tsx` as comment-stripped text ("names a requirement's number
 * after whoever produced it", plus the row's badge assertion beside it). A
 * source regex could see `{aiSuggested ? 'Model' : 'Parser'} confidence` in the
 * file; it could not tell which branch a user sees on which row.
 *
 * The defect being pinned: the row printed "Parser confidence N%" unconditionally,
 * so a requirement the model supplied was attributed to the offline rule engine —
 * a false attribution about the one thing this feature must never get wrong.
 * The test drives both provenances through the same component and asserts the
 * whole rendered row, including that the correct attribution is never absent.
 *
 * The store is the REAL one (this component reads its actions and the review
 * slice); the fixture sets only the slice this file asserts on.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { RequirementRecord, TenderRecord } from '../../src/shared/types'
import {
  AI_SUGGESTION_ACCESSIBLE_NAME,
  AI_SUGGESTION_TITLE,
} from '../../src/renderer/src/components/ExtractionReview'
import { RequirementList } from '../../src/renderer/src/components/RequirementList'
import { useTendersStore } from '../../src/renderer/src/store'
import { mount, unmountAll, type RenderResult } from '../helpers/render'

afterEach(() => {
  unmountAll()
  useTendersStore.setState({ tenderReviews: {}, activeRequirementId: null })
})

const AI_LABEL = 'AI-suggested'

function requirement(overrides: Partial<RequirementRecord> = {}): RequirementRecord {
  return {
    id: 'req-1',
    ruleKey: 'bbbee-certificate',
    title: 'Provide a B-BBEE certificate',
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

function renderRow(requirementOverrides: Partial<RequirementRecord>): RenderResult {
  const row = requirement(requirementOverrides)
  return mount(<RequirementList tender={tender({ requirements: [row] })} />)
}

function rowOf(view: RenderResult, title: string, requirementId: string): HTMLElement {
  const element = view.container.querySelector(`[data-requirement-id="${requirementId}"]`)
  if (element instanceof HTMLElement) return element
  const node = view.getByText(title).closest('li')
  if (!(node instanceof HTMLElement)) throw new Error('the requirement row did not render')
  return node
}

describe("a requirement's number is named after whoever produced it", () => {
  it('marks a model-suggested requirement with visible badge text and names the number the model’s', () => {
    const view = renderRow({ suggestedBy: 'ai' })
    const row = rowOf(view, 'Provide a B-BBEE certificate', 'req-1')
    // Visible text in the row's badge strip — not a title-only affordance.
    expect(row.textContent).toContain(AI_LABEL)
    expect(row.textContent).toContain('40% model confidence')
    // The false attribution this replaced: the rule engine never produced it.
    expect(row.textContent, 'the model’s number is never credited to the parser').not.toMatch(
      /\bParser confidence\b/,
    )
    expect(row.textContent).not.toContain('match confidence')

    view.click(view.getAllByRole('button', { name: 'Show clause details' })[0])
    const expanded = rowOf(view, 'Provide a B-BBEE certificate', 'req-1')
    expect(expanded.textContent).toContain('Model confidence 40%')
    expect(expanded.textContent, 'and the expanded row says it too').not.toMatch(
      /\bParser confidence\b/,
    )
  })

  it('keeps the parser’s own vocabulary for a requirement the rule engine read', () => {
    for (const suggestedBy of ['parser', undefined] as const) {
      const view = renderRow({ suggestedBy })
      const row = rowOf(view, 'Provide a B-BBEE certificate', 'req-1')
      expect(
        row.textContent,
        `no model marker for suggestedBy=${String(suggestedBy)}`,
      ).not.toContain(AI_LABEL)
      expect(row.textContent).toContain('40% match confidence')

      view.click(view.getAllByRole('button', { name: 'Show clause details' })[0])
      expect(rowOf(view, 'Provide a B-BBEE certificate', 'req-1').textContent).toContain(
        'Parser confidence 40%',
      )
      unmountAll()
    }
  })

  it('names the marker for a screen reader, not only in a tooltip', () => {
    const view = renderRow({ suggestedBy: 'ai' })
    // The pre-fix shape was a bare `<span title=…>` around the badge: the
    // provenance was visible and hoverable, and had NO accessible name — the
    // opposite of the point of the marker. A role that can carry a name is what
    // makes it reachable, and the name is asserted through the harness's
    // accessible-name computation rather than through a source read.
    const marker = view.getByRole('note')
    expect(view.nameOf(marker), 'the marker’s accessible name is the provenance').toContain(
      AI_LABEL,
    )
    expect(view.nameOf(marker)).toBe(AI_SUGGESTION_ACCESSIBLE_NAME)
    expect(
      marker.getAttribute('aria-label'),
      'the name is derived from the shared label and caveat, never re-spelled here',
    ).toBe(AI_SUGGESTION_ACCESSIBLE_NAME)
    expect(marker.getAttribute('title'), 'and the tooltip still explains it on hover').toBe(
      AI_SUGGESTION_TITLE,
    )
    // …and the marker is not the only thing a screen reader gets: the row's own
    // count of its provenance is inside the named marker's text too.
    expect(marker.textContent).toContain(AI_LABEL)
  })

  it('renders no named marker for a requirement the rule engine read', () => {
    for (const suggestedBy of ['parser', undefined] as const) {
      const view = renderRow({ suggestedBy })
      expect(
        view.queryByRole('note'),
        `a ${String(suggestedBy)} value must carry no provenance marker`,
      ).toBeNull()
      unmountAll()
    }
  })

  it('keeps the provenance marker after a human verifies the requirement', () => {
    // Verification is a human decision about the requirement, not a claim about
    // who produced it: the marker must survive it, and `verified` must not turn
    // the model's number into the parser's.
    useTendersStore.setState({
      tenderReviews: {
        'tender-1': {
          fields: {},
          requirements: {
            'req-1': {
              state: 'verified',
              originalTitle: null,
              originalCategory: null,
              correctedAt: null,
            },
          },
          pages: [],
          contactEmail: null,
          conflicts: [],
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      },
    })
    const view = renderRow({ suggestedBy: 'ai' })
    const row = rowOf(view, 'Provide a B-BBEE certificate', 'req-1')
    expect(row.textContent).toContain('Verified')
    expect(row.textContent).toContain(AI_LABEL)
    expect(row.textContent).toContain('40% model confidence')
  })
})
