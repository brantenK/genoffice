import { describe, expect, it } from 'vitest'
import {
  applyActivity,
  applyPhase,
  applyWorkbookPhase,
  finishRun,
  runStatusView,
  startRun,
} from '../src/renderer/ai/agent-run-status'

describe('agent run status', () => {
  it('starts each model turn in requesting and resets the turn clock', () => {
    const started = startRun(1_000)
    expect(started).toEqual({ phase: 'requesting', turnStartedAt: 1_000 })

    const nextTurn = applyPhase(
      {
        ...started,
        phase: 'tool-running',
        toolName: 'read_range',
        lastWireAt: 2_000,
        lastSemanticAt: 3_000,
      },
      { kind: 'requesting' },
      4_000,
    )
    expect(nextTurn).toEqual({ phase: 'requesting', turnStartedAt: 4_000 })
  })

  it('tracks phase and current tool without inventing activity', () => {
    const initial = { ...startRun(1_000), lastSemanticAt: 1_500 }
    expect(applyPhase(initial, { kind: 'thinking' }, 2_000)).toEqual({
      phase: 'thinking',
      turnStartedAt: 1_000,
      lastSemanticAt: 1_500,
    })
    expect(applyPhase(initial, { kind: 'tool-running', toolName: 'read_range' }, 2_000)).toEqual({
      phase: 'tool-running',
      turnStartedAt: 1_000,
      lastSemanticAt: 1_500,
      toolName: 'read_range',
    })
  })

  it('updates wire and semantic clocks only from their matching activity events', () => {
    const started = startRun(1_000)
    const wired = applyActivity(started, { kind: 'wire', at: 2_000 })
    expect(wired).toEqual({ phase: 'requesting', turnStartedAt: 1_000, lastWireAt: 2_000 })

    const semantic = applyActivity(wired, { kind: 'reasoning', at: 3_000 })
    expect(semantic).toEqual({
      phase: 'requesting',
      turnStartedAt: 1_000,
      lastWireAt: 2_000,
      lastSemanticAt: 3_000,
    })
    expect(applyActivity(semantic, { kind: 'text', at: 4_000 }).lastSemanticAt).toBe(4_000)
    expect(applyActivity(semantic, { kind: 'tool-input', at: 5_000 }).lastSemanticAt).toBe(5_000)
  })

  it('derives elapsed and last-activity seconds without mutating status', () => {
    const status = {
      phase: 'responding' as const,
      turnStartedAt: 1_000,
      lastSemanticAt: 5_100,
      lastWireAt: 5_200,
    }
    expect(runStatusView(status, 8_900)).toEqual({
      labelKey: 'aiRunResponding',
      elapsedSec: 7,
      lastActivitySec: 3,
      warning: null,
    })
    expect(status.lastSemanticAt).toBe(5_100)
  })

  it('reports the most recent event as last activity even when it is wire traffic', () => {
    const status = {
      phase: 'thinking' as const,
      turnStartedAt: 0,
      lastSemanticAt: 5_000,
      lastWireAt: 9_000,
    }
    expect(runStatusView(status, 10_000).lastActivitySec).toBe(1)
  })

  it('warns when the connection is active but semantic output is stale', () => {
    const status = {
      phase: 'thinking' as const,
      turnStartedAt: 0,
      lastSemanticAt: 1_000,
      lastWireAt: 34_000,
    }
    expect(runStatusView(status, 35_000).warning).toBe('connection-active-no-output')
  })

  it('warns when both provider wire traffic and semantic output are stale', () => {
    const status = {
      phase: 'requesting' as const,
      turnStartedAt: 0,
      lastSemanticAt: 1_000,
      lastWireAt: 2_000,
    }
    expect(runStatusView(status, 35_000).warning).toBe('no-provider-activity')
  })

  it('does not mislabel a long local tool or workbook apply as provider inactivity', () => {
    expect(
      runStatusView({ phase: 'tool-running', turnStartedAt: 0, toolName: 'read_range' }, 35_000)
        .warning,
    ).toBeNull()
    expect(runStatusView({ phase: 'applying', turnStartedAt: 0 }, 35_000).warning).toBeNull()
    expect(runStatusView({ phase: 'verifying', turnStartedAt: 0 }, 35_000).warning).toBeNull()
  })

  it('uses turn start as the activity baseline until an event arrives', () => {
    const status = startRun(10_000)
    expect(runStatusView(status, 39_999)).toMatchObject({ lastActivitySec: 29, warning: null })
    expect(runStatusView(status, 40_001)).toMatchObject({
      lastActivitySec: 30,
      warning: 'no-provider-activity',
    })
  })

  it('reports applying and verifying only from explicit workbook callbacks', () => {
    const started = startRun(1_000)
    expect(applyWorkbookPhase(started, 'applying')).toMatchObject({
      phase: 'applying',
    })
    expect(
      runStatusView(applyWorkbookPhase(started, 'verifying'), 2_000).labelKey,
    ).toBe('aiRunVerifying')
  })

  it('maps every provider phase to an honest label and finish clears the status', () => {
    const cases = [
      ['requesting', 'aiRunRequesting'],
      ['thinking', 'aiRunThinking'],
      ['responding', 'aiRunResponding'],
      ['tool-input', 'aiRunToolInput'],
      ['tool-running', 'aiRunToolRunning'],
    ] as const
    for (const [phase, labelKey] of cases) {
      expect(runStatusView({ phase, turnStartedAt: 0 }, 1).labelKey).toBe(labelKey)
    }
    expect(finishRun()).toBeUndefined()
  })
})
