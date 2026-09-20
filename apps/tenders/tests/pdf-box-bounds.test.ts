import { describe, expect, it } from 'vitest'
import type { BoundingBox } from '../src/shared/types'
import { clampNormalizedBox, unionBoxes } from '../src/renderer/src/pdf/extract'

/**
 * The v2 persistence schema strictly rejects boxes where `left + width > 1` or
 * `top + height > 1` (see `parseBoundingBox` in `src/shared/tenders-schema.ts`).
 * The PDF extractor can emit such boxes by tiny IEEE-754 amounts (e.g. a real
 * RFP produced `right = 1.009205882`), which blocks `saveStoreV2` /
 * `syncWithCrm`. `clampNormalizedBox` is the single item-box source of truth;
 * every box it returns must satisfy the schema predicate exactly.
 */

/** The exact predicate `parseBoundingBox` enforces on the high edges. */
function expectWithinUnitSquare(box: BoundingBox): void {
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.top).toBeGreaterThanOrEqual(0)
  expect(box.left).toBeLessThanOrEqual(1)
  expect(box.top).toBeLessThanOrEqual(1)
  expect(box.width).toBeGreaterThanOrEqual(0)
  expect(box.height).toBeGreaterThanOrEqual(0)
  // Schema contract: these comparisons must hold exactly, no `1 + 1e-12`.
  expect(box.left + box.width).toBeLessThanOrEqual(1)
  expect(box.top + box.height).toBeLessThanOrEqual(1)
}

describe('clampNormalizedBox', () => {
  it('clamps a horizontal overflow to left + width <= 1 and keeps the same left', () => {
    // Mirrors the real violation: right edge at 1.009205882.
    const overflow: BoundingBox = { top: 0.1, left: 0.609205882, width: 0.4, height: 0.2 }
    expect(overflow.left + overflow.width).toBeGreaterThan(1)

    const clamped = clampNormalizedBox(overflow)

    expectWithinUnitSquare(clamped)
    expect(clamped.left).toBe(overflow.left)
    expect(clamped.top).toBe(overflow.top)
    expect(clamped.height).toBe(overflow.height)
    expect(clamped.width).toBeLessThanOrEqual(1 - overflow.left)
    // A box at the page edge should still highlight, not be dropped.
    expect(clamped.width).toBeGreaterThan(0)
  })

  it('clamps a vertical overflow to top + height <= 1 and keeps the same top', () => {
    const overflow: BoundingBox = { top: 0.85, left: 0.2, width: 0.3, height: 0.24 }
    expect(overflow.top + overflow.height).toBeGreaterThan(1)

    const clamped = clampNormalizedBox(overflow)

    expectWithinUnitSquare(clamped)
    expect(clamped.top).toBe(overflow.top)
    expect(clamped.left).toBe(overflow.left)
    expect(clamped.width).toBe(overflow.width)
    expect(clamped.height).toBeLessThanOrEqual(1 - overflow.top)
    expect(clamped.height).toBeGreaterThan(0)
  })

  it('clamps both axes at once when both overflow', () => {
    const overflow: BoundingBox = { top: 0.95, left: 0.95, width: 0.2, height: 0.2 }
    const clamped = clampNormalizedBox(overflow)

    expectWithinUnitSquare(clamped)
    expect(clamped.left).toBe(overflow.left)
    expect(clamped.top).toBe(overflow.top)
  })

  it('leaves an already-valid box unchanged', () => {
    const valid: BoundingBox = { top: 0.125, left: 0.25, width: 0.5, height: 0.375 }
    expect(clampNormalizedBox(valid)).toEqual(valid)
  })

  it('preserves values exactly on the boundary', () => {
    const onBoundary: BoundingBox = { top: 0.25, left: 0.25, width: 0.75, height: 0.75 }
    const fullPage: BoundingBox = { top: 0, left: 0, width: 1, height: 1 }

    expect(clampNormalizedBox(onBoundary)).toEqual(onBoundary)
    expect(clampNormalizedBox(fullPage)).toEqual(fullPage)
  })

  it('clamps negative offsets and extents to zero', () => {
    const clamped = clampNormalizedBox({ top: -0.05, left: -0.1, width: -0.2, height: -0.3 })

    expectWithinUnitSquare(clamped)
    expect(clamped).toEqual({ top: 0, left: 0, width: 0, height: 0 })
  })

  it('coerces non-finite coordinates (NaN / ±Infinity) to finite in-range values', () => {
    const cases: BoundingBox[] = [
      { top: Number.NaN, left: Number.NaN, width: Number.NaN, height: Number.NaN },
      {
        top: Number.POSITIVE_INFINITY,
        left: Number.POSITIVE_INFINITY,
        width: Number.POSITIVE_INFINITY,
        height: Number.POSITIVE_INFINITY,
      },
      {
        top: Number.NEGATIVE_INFINITY,
        left: Number.NEGATIVE_INFINITY,
        width: Number.NEGATIVE_INFINITY,
        height: Number.NEGATIVE_INFINITY,
      },
      { top: 0.2, left: 0.2, width: Number.POSITIVE_INFINITY, height: Number.NaN },
      { top: Number.NaN, left: 0.5, width: 0.5, height: 0.5 },
      { top: 0.5, left: Number.NEGATIVE_INFINITY, width: 0.5, height: Number.POSITIVE_INFINITY },
    ]

    for (const box of cases) {
      const clamped = clampNormalizedBox(box)
      expect(Number.isFinite(clamped.left)).toBe(true)
      expect(Number.isFinite(clamped.top)).toBe(true)
      expect(Number.isFinite(clamped.width)).toBe(true)
      expect(Number.isFinite(clamped.height)).toBe(true)
      expectWithinUnitSquare(clamped)
    }
  })

  it('guarantees the schema predicate across a sweep of adversarial boxes', () => {
    for (let i = 0; i <= 100; i += 1) {
      const value = i / 100
      for (const width of [0, 0.000001, 0.5, 1.2, 2]) {
        expectWithinUnitSquare(
          clampNormalizedBox({ top: value, left: value, width, height: width }),
        )
      }
    }
  })
})

describe('unionBoxes over clamped boxes', () => {
  it('keeps the union within [0,1] on both axes', () => {
    const raw: BoundingBox[] = [
      { top: 0.1, left: 0.61, width: 0.4, height: 0.2 },
      { top: 0.86, left: 0.05, width: 0.2, height: 0.24 },
      { top: 0.2, left: 0.1, width: 0.3, height: 0.3 },
    ]
    const union = unionBoxes(raw.map(clampNormalizedBox))

    expectWithinUnitSquare(union)
  })

  it('returns a finite union when inputs contain non-finite values', () => {
    const union = unionBoxes([
      { top: Number.NaN, left: 0.1, width: 0.2, height: 0.2 },
      { top: Number.POSITIVE_INFINITY, left: Number.NaN, width: 0.3, height: 0.1 },
      { top: 0.5, left: 0.5, width: Number.NEGATIVE_INFINITY, height: 0.2 },
    ])

    expect(Number.isFinite(union.left)).toBe(true)
    expect(Number.isFinite(union.top)).toBe(true)
    expect(Number.isFinite(union.width)).toBe(true)
    expect(Number.isFinite(union.height)).toBe(true)
    expectWithinUnitSquare(union)
  })
})
