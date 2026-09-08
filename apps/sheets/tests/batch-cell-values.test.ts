import { describe, expect, it } from 'vitest'
import { CellValueType } from '@univerjs/core'
import {
  applyCellChangesBatched,
  applySparseCellValues,
  cellChangesToSparse,
  cellDataFromAfter,
} from '../src/renderer/batch-cell-values'
import type { CellChange } from '../src/domain/workbook.types'

function change(
  address: string,
  after: CellChange['after'],
  sheetId = 's1',
): CellChange {
  return { sheetId, address, before: { value: null }, after }
}

describe('cellDataFromAfter', () => {
  it('writes formulas as { f } and clears rich text', () => {
    expect(cellDataFromAfter({ value: null, formula: '=A1+1' })).toEqual({ f: '=A1+1', p: null })
  })

  it('clears a cell with null value and formula/style leftovers', () => {
    expect(cellDataFromAfter({ value: null })).toEqual({ v: null, f: null, si: null, p: null })
  })

  it('keeps numbers and booleans typed', () => {
    expect(cellDataFromAfter({ value: 42 })).toMatchObject({
      v: 42,
      t: CellValueType.NUMBER,
      f: null,
    })
    expect(cellDataFromAfter({ value: true })).toMatchObject({
      v: true,
      t: CellValueType.BOOLEAN,
    })
  })

  it('coerces plain numeric strings but keeps identifiers and leading zeros as text', () => {
    expect(cellDataFromAfter({ value: '12.5' })).toMatchObject({
      v: 12.5,
      t: CellValueType.NUMBER,
    })
    expect(cellDataFromAfter({ value: '00123' })).toMatchObject({
      v: '00123',
      t: CellValueType.STRING,
    })
    expect(cellDataFromAfter({ value: '1234567' })).toMatchObject({
      v: '1234567',
      t: CellValueType.STRING,
    })
  })
})

describe('applyCellChangesBatched', () => {
  it('issues one setValues per sheet with absolute sparse keys', () => {
    const writes: Array<{ sheet: string; matrix: unknown; range: number[] }> = []
    const sheetById = (sheetId: string) => ({
      getRange: (r: number, c: number, rows: number, cols: number) => ({
        setValues: (value: unknown) => {
          writes.push({ sheet: sheetId, matrix: value, range: [r, c, rows, cols] })
        },
      }),
    })
    const sheets = applyCellChangesBatched(sheetById, [
      change('A1', { value: 1 }),
      change('C2', { value: 'x' }),
      change('B1', { value: null, formula: '=A1' }, 's2'),
    ])
    expect(sheets).toBe(2)
    expect(writes).toHaveLength(2)
    const s1 = writes.find((write) => write.sheet === 's1')
    expect(s1?.range).toEqual([0, 0, 2, 3])
    expect(s1?.matrix).toMatchObject({
      0: { 0: { v: 1, t: CellValueType.NUMBER } },
      1: { 2: { v: 'x', t: CellValueType.STRING } },
    })
    const s2 = writes.find((write) => write.sheet === 's2')
    expect(s2?.matrix).toMatchObject({ 0: { 1: { f: '=A1' } } })
  })

  it('is a no-op for an empty plan', () => {
    expect(applyCellChangesBatched(() => ({ getRange: () => ({ setValues: () => {} }) }), [])).toBe(0)
  })
})

describe('applySparseCellValues', () => {
  it('skips an empty matrix', () => {
    let called = 0
    applySparseCellValues(
      { getRange: () => ({ setValues: () => { called += 1 } }) },
      {},
    )
    expect(called).toBe(0)
  })
})

describe('cellChangesToSparse', () => {
  it('groups by sheet id', () => {
    const map = cellChangesToSparse([
      change('A1', { value: 1 }),
      change('A1', { value: 2 }, 'other'),
    ])
    expect([...map.keys()]).toEqual(['s1', 'other'])
  })
})
