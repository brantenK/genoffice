/**
 * Phase 4 pre-E2E fix — the readiness drawer must not jump an illegal status
 * transition. `readinessTransitionPath` is the exact routing the drawer uses;
 * these tests prove every emitted path is legal and that the old direct jump
 * (IN_PROGRESS → READY_FOR_SUBMISSION) is not part of the graph.
 */
import { describe, expect, it } from 'vitest'
import { readinessTransitionPath } from '../src/renderer/src/components/ReadinessDrawer'
import { TENDER_TRANSITIONS } from '../src/shared/lifecycle'
import type { TenderStatus } from '../src/shared/types'

describe('readiness drawer lifecycle routing', () => {
  it('the direct jump the drawer used to make is not a legal transition', () => {
    expect(TENDER_TRANSITIONS.IN_PROGRESS).not.toContain('READY_FOR_SUBMISSION')
  })

  it('routes IN_PROGRESS → READY_FOR_SUBMISSION through assemble + pack', () => {
    expect(readinessTransitionPath('IN_PROGRESS', 'READY_FOR_SUBMISSION')).toEqual([
      'READY_TO_ASSEMBLE',
      'PACK_GENERATED',
      'READY_FOR_SUBMISSION',
    ])
  })

  it('routes the "back to in progress" regression through pack + assemble', () => {
    expect(readinessTransitionPath('READY_FOR_SUBMISSION', 'IN_PROGRESS')).toEqual([
      'PACK_GENERATED',
      'READY_TO_ASSEMBLE',
      'IN_PROGRESS',
    ])
  })

  it('is a no-op for the same status and null for unreachable terminal states', () => {
    expect(readinessTransitionPath('IN_PROGRESS', 'IN_PROGRESS')).toEqual([])
    expect(readinessTransitionPath('WON', 'READY_FOR_SUBMISSION')).toBeNull()
    expect(readinessTransitionPath('ARCHIVED', 'IN_PROGRESS')).toBeNull()
  })

  it('only ever emits paths whose every step is a legal, non-repeating transition', () => {
    const statuses = Object.keys(TENDER_TRANSITIONS) as TenderStatus[]
    for (const from of statuses) {
      for (const to of statuses) {
        const path = readinessTransitionPath(from, to)
        if (path === null) continue
        let current = from
        for (const step of path) {
          expect(TENDER_TRANSITIONS[current], `${current} -> ${step}`).toContain(step)
          current = step
        }
        expect(current, `${from} -> ${to}`).toBe(to)
        expect(new Set([from, ...path]).size, `${from} -> ${to} shortest`).toBe(path.length + 1)
      }
    }
  })
})
