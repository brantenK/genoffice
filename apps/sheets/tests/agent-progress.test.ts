import { describe, expect, it } from 'vitest'
import { agentProgressFromTools } from '../src/renderer/ai/agent-progress'

describe('agentProgressFromTools', () => {
  it('starts in inspect while thinking with no tools', () => {
    expect(agentProgressFromTools([], true)).toMatchObject({
      phase: 'inspect',
      labelKey: 'aiPhaseInspect',
    })
  })

  it('ticks inspect → read → write → verify from tools that already ran', () => {
    expect(
      agentProgressFromTools([{ name: 'get_workbook_context' }], true),
    ).toMatchObject({ phase: 'inspect' })
    expect(
      agentProgressFromTools(
        [{ name: 'get_workbook_context' }, { name: 'read_range', running: true }],
        true,
      ),
    ).toMatchObject({ phase: 'read', labelKey: 'aiPhaseRead' })
    expect(
      agentProgressFromTools(
        [{ name: 'read_range' }, { name: 'propose_operations', running: true }],
        true,
      ),
    ).toMatchObject({ phase: 'write', pct: 70 })
    expect(
      agentProgressFromTools([{ name: 'read_range' }, { name: 'propose_operations' }], true),
    ).toMatchObject({ phase: 'verify', labelKey: 'aiPhaseVerify' })
  })

  it('is done when the run is no longer streaming', () => {
    expect(
      agentProgressFromTools([{ name: 'propose_operations' }], false),
    ).toMatchObject({ phase: 'done', pct: 100 })
  })

  it('treats select_range as navigation, never as the write phase', () => {
    expect(
      agentProgressFromTools(
        [{ name: 'read_range' }, { name: 'select_range', running: true }],
        true,
      ),
    ).toMatchObject({ phase: 'read', labelKey: 'aiPhaseRead' })
    expect(agentProgressFromTools([{ name: 'select_range', running: true }], true).phase).toBe(
      'inspect',
    )
  })

  it('counts merge_attached_workbooks as a write', () => {
    expect(
      agentProgressFromTools([{ name: 'merge_attached_workbooks', running: true }], true),
    ).toMatchObject({ phase: 'write', pct: 70, labelKey: 'aiPhaseWrite' })
    expect(
      agentProgressFromTools(
        [{ name: 'read_range' }, { name: 'merge_attached_workbooks' }],
        true,
      ),
    ).toMatchObject({ phase: 'verify', labelKey: 'aiPhaseVerify' })
  })
})
