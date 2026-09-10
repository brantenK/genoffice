import { describe, expect, it } from 'vitest'

import { parseTaskPlan } from '../src/renderer/ai/task-plan'

describe('parseTaskPlan', () => {
  it('trims every field and returns an immutable snapshot', () => {
    const result = parseTaskPlan({
      todos: [
        { content: ' Inspect totals ', activeForm: ' Inspecting totals ', status: 'in_progress' },
        { content: ' Fix formulas ', activeForm: ' Fixing formulas ', status: 'pending' },
      ],
    })

    expect(result).toEqual({
      ok: true,
      plan: {
        todos: [
          { content: 'Inspect totals', activeForm: 'Inspecting totals', status: 'in_progress' },
          { content: 'Fix formulas', activeForm: 'Fixing formulas', status: 'pending' },
        ],
      },
    })
    if (!result.ok) throw new Error(result.error)
    expect(Object.isFrozen(result.plan)).toBe(true)
    expect(Object.isFrozen(result.plan.todos)).toBe(true)
    expect(Object.isFrozen(result.plan.todos[0])).toBe(true)
  })

  it.each([
    [{ todos: [] }, 'at least 1'],
    [
      {
        todos: Array.from({ length: 13 }, (_, index) => ({
          content: `Task ${index}`,
          activeForm: `Doing task ${index}`,
          status: 'pending',
        })),
      },
      'at most 12',
    ],
    [{ todos: [{ content: '   ', activeForm: 'Doing it', status: 'pending' }] }, 'content'],
    [
      {
        todos: [{ content: 'x'.repeat(161), activeForm: 'Doing it', status: 'pending' }],
      },
      '160',
    ],
    [{ todos: [{ content: 'Do it', activeForm: '   ', status: 'pending' }] }, 'activeForm'],
    [{ todos: [{ content: 'Do it', activeForm: 'Doing it', status: 'blocked' }] }, 'status'],
  ])('rejects malformed plans with a useful error: %s', (input, message) => {
    const result = parseTaskPlan(input)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected invalid plan')
    expect(result.error).toContain(message)
  })

  it('rejects more than one in-progress item', () => {
    const result = parseTaskPlan({
      todos: [
        { content: 'Inspect', activeForm: 'Inspecting', status: 'in_progress' },
        { content: 'Fix', activeForm: 'Fixing', status: 'in_progress' },
      ],
    })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error('expected invalid plan')
    expect(result.error).toContain('at most one')
  })

  it('rejects duplicate content case-insensitively after trimming', () => {
    const result = parseTaskPlan({
      todos: [
        { content: 'Review totals', activeForm: 'Reviewing totals', status: 'completed' },
        { content: ' review TOTALS ', activeForm: 'Checking totals', status: 'pending' },
      ],
    })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error('expected invalid plan')
    expect(result.error).toContain('duplicate')
  })
})
