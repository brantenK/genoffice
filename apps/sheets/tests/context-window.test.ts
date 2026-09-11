import { describe, expect, it, vi } from 'vitest'

import {
  buildWorkbookContext,
  CONTEXT_WINDOW_MAX_COLS,
  CONTEXT_WINDOW_MAX_ROWS,
  contextWindowBounds,
  executeWorkbookTool,
  type ActiveSheetInfo,
  type SheetsSkillDeps,
} from '../src/renderer/ai/tools'
import type { CellScalar, ChangePlan } from '../src/domain/workbook.types'

function call(name: string, input: Record<string, unknown>) {
  return { id: 'call-1', name, input }
}

/** The context window only needs these two deps. */
function windowDeps(
  info: ActiveSheetInfo,
  cells: Record<string, { value: CellScalar; formula?: string }> = {},
): { deps: SheetsSkillDeps; readCells: ReturnType<typeof vi.fn> } {
  const readCells = vi.fn().mockReturnValue(cells)
  return {
    deps: { getActiveSheetInfo: () => info, readCells } as unknown as SheetsSkillDeps,
    readCells,
  }
}

const LAZY: ActiveSheetInfo = {
  mode: 'lazy',
  sheetId: 'sheet-1',
  sheetName: 'Data',
  knownAddresses: [],
  // file extent known, but on a streamed workbook nothing outside the
  // viewport is backed by real data
  sheets: [{ id: 'sheet-1', name: 'Data', rows: 9000, columns: 40 }],
}

describe('contextWindowBounds: lazy materialization gating', () => {
  it('returns null for the extent fallback when nothing is loaded', () => {
    expect(contextWindowBounds(LAZY)).toBeNull()
  })

  it('emits no window section (and reads nothing) for that workbook', () => {
    const { deps, readCells } = windowDeps(LAZY, { A1: { value: 'Name' } })
    const text = buildWorkbookContext(deps)
    expect(text).not.toContain('Compact data window')
    expect(readCells).not.toHaveBeenCalled()
  })

  it('emits the window once the workbook is fully preloaded', () => {
    const info = { ...LAZY, preloaded: true }
    expect(contextWindowBounds(info)).toEqual({
      startRow: 0,
      startColumn: 0,
      endRow: CONTEXT_WINDOW_MAX_ROWS - 1,
      endColumn: CONTEXT_WINDOW_MAX_COLS - 1,
    })
    const { deps } = windowDeps(info, { A1: { value: 'Name' } })
    const text = buildWorkbookContext(deps)
    expect(text).toContain('Compact data window A1:P40')
    expect(text).toContain('Name')
  })

  it('emits the window for a selection inside the loaded viewport', () => {
    const info: ActiveSheetInfo = {
      ...LAZY,
      loadedRange: 'A5000:F5040',
      selection: 'A5001:C5005',
      selectionFrozen: true,
    }
    expect(contextWindowBounds(info)).toEqual({
      startRow: 5000,
      startColumn: 0,
      endRow: 5004,
      endColumn: 2,
    })
    const { deps } = windowDeps(info, { A5001: { value: 7 } })
    expect(buildWorkbookContext(deps)).toContain('Compact data window A5001:C5005')
  })

  it('omits the window for a selection outside the loaded viewport', () => {
    const info: ActiveSheetInfo = {
      ...LAZY,
      loadedRange: 'A5000:F5040',
      selection: 'A6000:C6005',
    }
    expect(contextWindowBounds(info)).toBeNull()
    const { deps, readCells } = windowDeps(info)
    expect(buildWorkbookContext(deps)).not.toContain('Compact data window')
    expect(readCells).not.toHaveBeenCalled()
  })

  it('falls back to the loaded viewport itself when there is no selection', () => {
    const info: ActiveSheetInfo = { ...LAZY, loadedRange: 'A5000:F5040' }
    expect(buildWorkbookContext(windowDeps(info).deps)).toContain('Compact data window A5000:F5039')
  })
})

describe('contextWindowBounds: demo mode', () => {
  const DEMO: ActiveSheetInfo = {
    mode: 'demo',
    sheetId: 'sheet-1',
    sheetName: 'Sheet1',
    knownAddresses: [],
    sheets: [{ id: 'sheet-1', name: 'Sheet1', rows: 100, columns: 5 }],
  }

  it('emits the window from the data extent without any loadedRange', () => {
    expect(contextWindowBounds(DEMO)).toEqual({
      startRow: 0,
      startColumn: 0,
      endRow: 39,
      endColumn: 4,
    })
    const { deps } = windowDeps(DEMO, { A1: { value: 'Name' } })
    expect(buildWorkbookContext(deps)).toContain('Compact data window A1:E40')
  })
})

describe('contextWindowBounds: cross-sheet selections', () => {
  const INFO: ActiveSheetInfo = {
    mode: 'demo',
    sheetId: 'sheet-1',
    sheetName: 'Summary',
    knownAddresses: [],
    sheets: [
      { id: 'sheet-1', name: 'Summary' },
      { id: 'sheet-2', name: 'Data' },
    ],
  }

  it('skips the window when the selection belongs to another sheet', () => {
    const info = { ...INFO, selection: 'Data!B2:D5', selectionFrozen: true }
    expect(contextWindowBounds(info)).toBeNull()
    const { deps, readCells } = windowDeps(info)
    const text = buildWorkbookContext(deps)
    expect(text).not.toContain('Compact data window')
    expect(readCells).not.toHaveBeenCalled()
    // the prose selection line still reports the frozen scope
    expect(text).toContain('User selection: Data!B2:D5')
  })

  it('skips the window when the qualifier matches no sheet', () => {
    const info = { ...INFO, selection: 'Ghost!B2:D5' }
    expect(contextWindowBounds(info)).toBeNull()
    expect(buildWorkbookContext(windowDeps(info).deps)).not.toContain('Compact data window')
  })

  it('keeps the window for a qualifier naming the active sheet', () => {
    const info = { ...INFO, selection: 'Summary!B2:D5' }
    expect(contextWindowBounds(info)).toEqual({
      startRow: 1,
      startColumn: 1,
      endRow: 4,
      endColumn: 3,
    })
    const { deps } = windowDeps(info, { B2: { value: 'total' } })
    const text = buildWorkbookContext(deps)
    expect(text).toContain('Compact data window B2:D5')
    expect(text).toContain('total')
  })
})

describe('context window cell truncation', () => {
  const INFO: ActiveSheetInfo = {
    mode: 'demo',
    sheetId: 'sheet-1',
    sheetName: 'Sheet1',
    knownAddresses: [],
    sheets: [{ id: 'sheet-1', name: 'Sheet1', rows: 10, columns: 5 }],
  }
  const LONG = 'x'.repeat(300)

  it('caps a cell at 120 characters plus the ellipsis', () => {
    const { deps } = windowDeps({ ...INFO, selection: 'B2' }, { B2: { value: LONG } })
    const text = buildWorkbookContext(deps)
    expect(text).toContain(`${'x'.repeat(120)}…`)
    expect(text).not.toContain('x'.repeat(121))
  })

  it('keeps short cells verbatim', () => {
    const { deps } = windowDeps({ ...INFO, selection: 'B2' }, { B2: { value: 'short note' } })
    expect(buildWorkbookContext(deps)).toContain('short note')
  })

  it('leaves read_range output untruncated', () => {
    const { deps } = windowDeps({ ...INFO, selection: 'B2' }, { B2: { value: LONG } })
    const result = executeWorkbookTool(call('read_range', { range: 'B2' }), deps)
    if (result instanceof Promise) throw new Error('expected sync tool execution')
    expect(result.output).toContain(LONG)
  })
})

describe('propose_operations read-back error detection', () => {
  const INFO: ActiveSheetInfo = {
    mode: 'demo',
    sheetId: 'sheet-1',
    sheetName: 'Sheet1',
    knownAddresses: [],
    sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
  }

  function formulaPlan(): ChangePlan {
    return {
      transactionId: 'agent-1',
      baseRevision: 0,
      cellChanges: [
        {
          sheetId: 'sheet-1',
          address: 'C1',
          before: { value: null },
          after: { value: null, formula: '=A1/A2' },
        },
        {
          sheetId: 'sheet-1',
          address: 'C2',
          before: { value: null },
          after: { value: null, formula: '=C1*2' },
        },
      ],
      sheetRenames: [],
      structuralChanges: [],
      formatChanges: [],
      warnings: [],
    }
  }

  function proposeDeps(cells: Record<string, { value: CellScalar; formula?: string }>) {
    return {
      getActiveSheetInfo: () => INFO,
      readCells: vi.fn().mockReturnValue(cells),
      proposeOperations: vi.fn().mockReturnValue({ ok: true, plan: formulaPlan() }),
    } as unknown as SheetsSkillDeps
  }

  it('flags read-back values that are (after trim) whole error literals', async () => {
    const result = await executeWorkbookTool(
      call('propose_operations', {
        operations: [
          { op: 'set_formula', sheetId: 'sheet-1', address: 'C1', formula: '=A1/A2' },
          { op: 'set_formula', sheetId: 'sheet-1', address: 'C2', formula: '=C1*2' },
        ],
        summary: 'Compute',
      }),
      proposeDeps({
        C1: { value: '#N/A', formula: '=A1/A2' },
        C2: { value: '#SPILL! ', formula: '=C1*2' },
      }),
    )
    expect(result.output).toContain('errors:')
    expect(result.output).toContain('- C1 = #N/A')
    expect(result.output).toContain('- C2 = #SPILL!')
  })

  it('does not flag a text value that merely contains an error literal', async () => {
    const result = await executeWorkbookTool(
      call('propose_operations', {
        operations: [{ op: 'set_formula', sheetId: 'sheet-1', address: 'C1', formula: '=A1/A2' }],
        summary: 'Compute',
      }),
      proposeDeps({ C1: { value: 'Survey answer: #N/A (skipped)', formula: '=A1/A2' } }),
    )
    expect(result.output).toContain('Formula results: C1 = Survey answer: #N/A (skipped)')
    expect(result.output).not.toContain('errors:')
  })
})
