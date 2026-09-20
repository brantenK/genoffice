/**
 * Phase 4 remediation — the live proposal path must derive the expected
 * readiness binding from main-resolved facts (requested tender id + loaded
 * document revision), not from a copy of the report's own binding. These tests
 * prove identity/revision drift is now genuinely caught.
 */
import { describe, expect, it } from 'vitest'
import { expectedReadinessBinding } from '../src/main/proposal-generator'
import type { ReadinessBinding } from '../src/shared/readiness'

function reportBinding(overrides: Partial<ReadinessBinding> = {}): ReadinessBinding {
  return {
    tenderId: 'tender-1',
    revision: 4,
    fingerprint: 'fp-abc',
    generatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('live readiness binding derivation', () => {
  it('accepts a report whose identity and revision match the resolved facts', () => {
    expect(
      expectedReadinessBinding({
        requestedTenderId: 'tender-1',
        loadedRevision: 4,
        canonicalTenderId: 'tender-1',
        reportBinding: reportBinding(),
      }),
    ).toEqual({ tenderId: 'tender-1', revision: 4, fingerprint: 'fp-abc', required: true })
  })

  it('rejects a report bound to a different tender id', () => {
    expect(
      expectedReadinessBinding({
        requestedTenderId: 'tender-1',
        loadedRevision: 4,
        canonicalTenderId: 'tender-1',
        reportBinding: reportBinding({ tenderId: 'tender-2' }),
      }),
    ).toBeUndefined()
  })

  it('rejects a report bound to a stale revision', () => {
    expect(
      expectedReadinessBinding({
        requestedTenderId: 'tender-1',
        loadedRevision: 5,
        canonicalTenderId: 'tender-1',
        reportBinding: reportBinding({ revision: 4 }),
      }),
    ).toBeUndefined()
  })

  it('rejects when the canonical tender id differs from the requested one', () => {
    expect(
      expectedReadinessBinding({
        requestedTenderId: 'tender-1',
        loadedRevision: 4,
        canonicalTenderId: 'tender-9',
        reportBinding: reportBinding(),
      }),
    ).toBeUndefined()
  })

  it('rejects a report that carries no binding at all', () => {
    expect(
      expectedReadinessBinding({
        requestedTenderId: 'tender-1',
        loadedRevision: 4,
        canonicalTenderId: 'tender-1',
        reportBinding: undefined,
      }),
    ).toBeUndefined()
  })
})
