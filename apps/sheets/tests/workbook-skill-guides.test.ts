/** load_guide reload-once semantics of the workbook skill (post-squash recovery). */
import { describe, expect, it } from 'vitest'
import { createWorkbookSkill } from '../src/renderer/ai/workbook-skill'

/**
 * The load_guide path never touches deps; buildContext (exercised by the
 * reset test) only needs getActiveSheetInfo.
 */
function createSkill(): ReturnType<typeof createWorkbookSkill> {
  return createWorkbookSkill({
    getActiveSheetInfo: () => ({
      mode: 'none',
      sheetId: '',
      sheetName: '',
      knownAddresses: [],
      sheets: [],
    }),
  } as unknown as Parameters<typeof createWorkbookSkill>[0])
}

/** load_guide executes synchronously */
function loadGuide(skill: ReturnType<typeof createWorkbookSkill>, guides: unknown) {
  const result = skill.executeTool({ id: 'call-1', name: 'load_guide', input: { guides } })
  if (result instanceof Promise) throw new Error('expected sync tool execution')
  return result
}

describe('createWorkbookSkill: load_guide reload-once semantics', () => {
  it('serves the full guide content on first load', () => {
    const result = loadGuide(createSkill(), ['writing'])
    expect(result.isError).toBeFalsy()
    expect(result.mutated).toBe(false)
    expect(result.output).toContain('set_range')
  })

  it('refuses the first repeat without re-sending the content', () => {
    const skill = createSkill()
    loadGuide(skill, ['writing'])
    const result = loadGuide(skill, ['writing'])
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("already in this run's context")
    expect(result.output).toContain('writing')
    expect(result.output).not.toContain('set_range')
  })

  it('returns the full content again on the second repeat (squashed-out guide)', () => {
    const skill = createSkill()
    loadGuide(skill, ['writing'])
    loadGuide(skill, ['writing'])
    const result = loadGuide(skill, ['writing'])
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('set_range')
  })

  it('keeps serving content on repeats after one reload was handed back', () => {
    const skill = createSkill()
    loadGuide(skill, ['writing'])
    loadGuide(skill, ['writing'])
    loadGuide(skill, ['writing'])
    const result = loadGuide(skill, ['writing'])
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('set_range')
  })

  it('serves fresh guides and notes the skipped one in a mixed call', () => {
    const skill = createSkill()
    loadGuide(skill, ['writing'])
    const result = loadGuide(skill, ['writing', 'charts'])
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('add_chart')
    expect(result.output).toContain('Already loaded this run, not repeated: writing')
    // writing-guide content withheld ('clear_cell' appears only in that guide)
    expect(result.output).not.toContain('clear_cell')
  })

  it('buildContext resets the per-run guide memory', () => {
    const skill = createSkill()
    loadGuide(skill, ['writing'])
    expect(loadGuide(skill, ['writing']).output).toContain("already in this run's context")
    skill.buildContext?.()
    const result = loadGuide(skill, ['writing'])
    expect(result.output).toContain('set_range')
    expect(result.output).not.toContain("already in this run's context")
  })

  it('rejects a non-array or empty guides input', () => {
    expect(loadGuide(createSkill(), 'writing').isError).toBe(true)
    const empty = loadGuide(createSkill(), [])
    expect(empty.isError).toBe(true)
    expect(empty.output).toBe('guides must be a non-empty array')
  })

  it('rejects unknown guide names, listing the valid ones', () => {
    const result = loadGuide(createSkill(), ['no-such-guide'])
    expect(result.isError).toBe(true)
    expect(result.output).toContain('writing')
  })
})
