import type { AgentActivity, AgentPhase, AgentPhaseKind } from '@genoffice/agent-core'
import type { StringKey } from '../i18n/locale'

export type WorkbookPhase = 'applying' | 'verifying'
export type RunPhase = AgentPhaseKind | WorkbookPhase

export interface RunStatus {
  readonly phase: RunPhase
  readonly turnStartedAt: number
  readonly lastWireAt?: number | undefined
  readonly lastSemanticAt?: number | undefined
  readonly toolName?: string | undefined
}

export type RunStatusWarning = 'connection-active-no-output' | 'no-provider-activity'

export interface RunStatusView {
  readonly labelKey: StringKey
  readonly elapsedSec: number
  readonly lastActivitySec: number
  readonly warning: RunStatusWarning | null
}

const PHASE_LABEL_KEYS: Record<RunPhase, StringKey> = {
  requesting: 'aiRunRequesting',
  thinking: 'aiRunThinking',
  responding: 'aiRunResponding',
  'tool-input': 'aiRunToolInput',
  'tool-running': 'aiRunToolRunning',
  applying: 'aiRunApplying',
  verifying: 'aiRunVerifying',
}

const WARNING_AFTER_MS = 30_000
const RECENT_WIRE_MS = 10_000

function elapsedSeconds(now: number, since: number): number {
  return Math.max(0, Math.floor((now - since) / 1_000))
}

export function startRun(now: number): RunStatus {
  return { phase: 'requesting', turnStartedAt: now }
}

export function applyPhase(status: RunStatus, phase: AgentPhase, now: number): RunStatus {
  if (phase.kind === 'requesting') return startRun(now)
  return {
    ...status,
    phase: phase.kind,
    ...(phase.toolName ? { toolName: phase.toolName } : { toolName: undefined }),
  }
}

export function applyActivity(status: RunStatus, activity: AgentActivity): RunStatus {
  if (activity.kind === 'wire') return { ...status, lastWireAt: activity.at }
  return { ...status, lastSemanticAt: activity.at }
}

export function applyWorkbookPhase(status: RunStatus, phase: WorkbookPhase): RunStatus {
  return { ...status, phase, toolName: undefined }
}

export function finishRun(): undefined {
  return undefined
}

export function runStatusView(status: RunStatus, now: number): RunStatusView {
  const activityAt = Math.max(
    status.turnStartedAt,
    status.lastSemanticAt ?? status.turnStartedAt,
    status.lastWireAt ?? status.turnStartedAt,
  )
  const semanticAt = status.lastSemanticAt ?? status.turnStartedAt
  const semanticStale = now - semanticAt >= WARNING_AFTER_MS
  const waitingOnProvider =
    status.phase === 'requesting' ||
    status.phase === 'thinking' ||
    status.phase === 'responding' ||
    status.phase === 'tool-input'
  let warning: RunStatusWarning | null = null
  if (semanticStale && waitingOnProvider) {
    warning =
      status.lastWireAt !== undefined && now - status.lastWireAt <= RECENT_WIRE_MS
        ? 'connection-active-no-output'
        : 'no-provider-activity'
  }

  return {
    labelKey: PHASE_LABEL_KEYS[status.phase],
    elapsedSec: elapsedSeconds(now, status.turnStartedAt),
    lastActivitySec: elapsedSeconds(now, activityAt),
    warning,
  }
}
