/**
 * One Univer setValues per sheet for a bag of cell writes.
 *
 * AI plans expand set_range into per-cell ChangePlan entries; writing those
 * through getRange(address).setFormula/setValues used to fire one command
 * (journal + formula engine + canvas) per cell. The mutation payload is a
 * sparse IObjectMatrixPrimitiveType — absolute row/col keys — so one facade
 * setValues covers the whole batch.
 *
 * A cleared cell is an explicit empty ICellData (v/f/si/p null), not a bare
 * null: the facade's setValues union only accepts ICellData matrices, and a
 * null entry would delete the cell outright.
 */
import { CellValueType, type ICellData } from '@univerjs/core'
import { parseAddress } from '../domain/cell-address'
import type { CellChange, CellState } from '../domain/workbook.types'
import { isNumericIdentifierText } from './cell-warning'

export type SparseCellRow = Record<number, ICellData>
export type SparseCellMatrix = Record<number, SparseCellRow>

export interface SparseRangeTarget {
  getRange(
    startRow: number,
    startColumn: number,
    rowCount: number,
    columnCount: number,
  ): { setValues(value: SparseCellMatrix): void }
}

/** Leading-zero digit strings (zip/account codes) must stay text. */
function looksLikePlainNumber(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || isNumericIdentifierText(trimmed)) return false
  if (/^0\d/.test(trimmed)) return false
  return /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)
}

/** ICellData for one planned after-state. Always clears f/si/p on value writes
 *  so a formula or rich-text target does not keep rendering over the new value. */
export function cellDataFromAfter(after: CellState): ICellData {
  if (after.formula) return { f: after.formula, p: null }
  if (after.value === null) return { v: null, f: null, si: null, p: null }
  if (typeof after.value === 'number') {
    return { v: after.value, t: CellValueType.NUMBER, f: null, si: null, p: null }
  }
  if (typeof after.value === 'boolean') {
    return { v: after.value, t: CellValueType.BOOLEAN, f: null, si: null, p: null }
  }
  const text = after.value
  if (looksLikePlainNumber(text)) {
    const numeric = Number(text)
    if (Number.isFinite(numeric)) {
      return { v: numeric, t: CellValueType.NUMBER, f: null, si: null, p: null }
    }
  }
  return { v: text, t: CellValueType.STRING, f: null, si: null, p: null }
}

export function cellChangesToSparse(
  cellChanges: readonly CellChange[],
): Map<string, SparseCellMatrix> {
  const bySheet = new Map<string, SparseCellMatrix>()
  for (const change of cellChanges) {
    const { row, column } = parseAddress(change.address)
    let matrix = bySheet.get(change.sheetId)
    if (!matrix) {
      matrix = {}
      bySheet.set(change.sheetId, matrix)
    }
    const rowCells = (matrix[row] ??= {})
    rowCells[column] = cellDataFromAfter(change.after)
  }
  return bySheet
}

export function boundsOfSparse(matrix: SparseCellMatrix): {
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
} | null {
  let startRow = Infinity
  let endRow = -Infinity
  let startColumn = Infinity
  let endColumn = -Infinity
  for (const [rowText, columns] of Object.entries(matrix)) {
    const row = Number(rowText)
    for (const columnText of Object.keys(columns)) {
      const column = Number(columnText)
      if (row < startRow) startRow = row
      if (row > endRow) endRow = row
      if (column < startColumn) startColumn = column
      if (column > endColumn) endColumn = column
    }
  }
  if (!Number.isFinite(startRow)) return null
  return { startRow, startColumn, endRow, endColumn }
}

/** Returns true when at least one cell was written. */
export function applySparseCellValues(
  worksheet: SparseRangeTarget,
  matrix: SparseCellMatrix,
): boolean {
  const bounds = boundsOfSparse(matrix)
  if (!bounds) return false
  worksheet
    .getRange(
      bounds.startRow,
      bounds.startColumn,
      bounds.endRow - bounds.startRow + 1,
      bounds.endColumn - bounds.startColumn + 1,
    )
    .setValues(matrix)
  return true
}

/** One setValues command per sheet. Returns the number of sheets written. */
export function applyCellChangesBatched(
  sheetById: (sheetId: string) => SparseRangeTarget,
  cellChanges: readonly CellChange[],
): number {
  if (cellChanges.length === 0) return 0
  let sheets = 0
  for (const [sheetId, matrix] of cellChangesToSparse(cellChanges)) {
    if (applySparseCellValues(sheetById(sheetId), matrix)) sheets += 1
  }
  return sheets
}
