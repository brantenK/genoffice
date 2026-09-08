/**
 * Host-owned AI run phases derived from tools that already ran.
 * No extra LLM tool: the copilot stepper ticks as get_workbook_context /
 * read_range / propose_operations complete.
 */

export type AgentPhase = 'inspect' | 'read' | 'write' | 'verify' | 'done'

export interface AgentProgress {
  readonly phase: AgentPhase
  readonly pct: number
  readonly labelKey:
    | 'aiPhaseInspect'
    | 'aiPhaseRead'
    | 'aiPhaseWrite'
    | 'aiPhaseVerify'
    | 'aiPhaseDone'
}

const INSPECT_TOOLS = new Set(['get_workbook_context', 'load_guide'])
const READ_TOOLS = new Set([
  'read_range',
  'read_cells',
  'read_formats',
  'read_sheet_features',
  'find_cells',
  'aggregate_range',
  'trace_precedents',
  'trace_dependents',
])
// select_range is pure navigation (mutated: false) — it never advances the
// write phase; merge_attached_workbooks genuinely mutates the workbook.
const WRITE_TOOLS = new Set([
  'propose_operations',
  'create_document',
  'merge_attached_workbooks',
])

export interface ProgressToolChip {
  readonly name?: string | undefined
  readonly running?: boolean | undefined
}

function toolName(tool: ProgressToolChip): string {
  return tool.name ?? ''
}

function anyNamed(tools: readonly ProgressToolChip[], names: ReadonlySet<string>): boolean {
  return tools.some((tool) => names.has(toolName(tool)))
}

function anyRunning(tools: readonly ProgressToolChip[], names: ReadonlySet<string>): boolean {
  return tools.some((tool) => tool.running && names.has(toolName(tool)))
}

export function agentProgressFromTools(
  tools: readonly ProgressToolChip[],
  streaming: boolean,
): AgentProgress {
  if (!streaming && tools.length === 0) {
    return { phase: 'done', pct: 100, labelKey: 'aiPhaseDone' }
  }
  const writing = anyNamed(tools, WRITE_TOOLS)
  const writeRunning = anyRunning(tools, WRITE_TOOLS)
  const reading = anyNamed(tools, READ_TOOLS)
  const readRunning = anyRunning(tools, READ_TOOLS)
  const inspecting = anyNamed(tools, INSPECT_TOOLS)
  const inspectRunning = anyRunning(tools, INSPECT_TOOLS)

  if (writeRunning) return { phase: 'write', pct: 70, labelKey: 'aiPhaseWrite' }
  if (writing && streaming) return { phase: 'verify', pct: 88, labelKey: 'aiPhaseVerify' }
  if (writing && !streaming) return { phase: 'done', pct: 100, labelKey: 'aiPhaseDone' }
  if (readRunning) return { phase: 'read', pct: 45, labelKey: 'aiPhaseRead' }
  if (reading) return { phase: 'read', pct: 55, labelKey: 'aiPhaseRead' }
  if (inspectRunning) return { phase: 'inspect', pct: 18, labelKey: 'aiPhaseInspect' }
  if (inspecting) return { phase: 'inspect', pct: 28, labelKey: 'aiPhaseInspect' }
  if (!streaming) return { phase: 'done', pct: 100, labelKey: 'aiPhaseDone' }
  return { phase: 'inspect', pct: 8, labelKey: 'aiPhaseInspect' }
}
