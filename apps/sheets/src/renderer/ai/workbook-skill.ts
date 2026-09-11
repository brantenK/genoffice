import type { AgentSkill } from '@genoffice/agent-core'
import { t } from '../i18n/locale'
import { loadGuides } from './guides'
import basePrompt from './prompts/base.md?raw'
import { verifySheetsResponse } from './response-verify'
import { parseTaskPlan, type TaskPlan } from './task-plan'
import {
  WORKBOOK_TOOLS,
  buildWorkbookContext,
  executeWorkbookTool,
  type SheetsSkillDeps,
} from './tools'

/**
 * The workbook DSL as an AgentSkill: mirrors createDocsSkill's shape
 * (systemPrompt + tools + buildContext + executeTool) so it plugs into the
 * same packages/agent-core AgentLoop docx uses.
 *
 * Prompt layout: the always-loaded base prompt (prompts/base.md) stays small
 * — workflow, op catalog, cross-cutting discipline — while per-domain field
 * definitions and conventions live in prompts/guides/*.md, loaded on demand
 * via load_guide.
 */
export interface WorkbookSkillOptions {
  readonly onTaskPlan?: (plan: TaskPlan | null) => void
}

const UPDATE_TASK_PLAN_TOOL = {
  name: 'update_task_plan',
  description:
    'OPTIONAL checklist for requests with 3 or more distinct stages. Call it in the same turn as the first read or load_guide when possible, update it whenever statuses change, and batch the update with related tool calls. Skip it for simple or single-cell requests.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', minLength: 1, maxLength: 160 },
            activeForm: { type: 'string', minLength: 1, maxLength: 160 },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'activeForm', 'status'],
        },
      },
    },
    required: ['todos'],
  },
} as const

export function createWorkbookSkill(
  deps: SheetsSkillDeps,
  options: WorkbookSkillOptions = {},
): AgentSkill {
  const loadedGuides = new Set<string>()
  /**
   * Reload-once semantics: agent-core's squashStaleToolOutputs truncates tool
   * outputs older than the last two to ~1KB, so a guide loaded early in a long
   * run can vanish from the model's context mid-run. The FIRST repeat request
   * for a guide is refused (cheap dedupe against a model that merely forgot it
   * just read it); any further request returns the full content again — asking
   * twice is the signal the content is actually gone. buildContext (new run)
   * clears both sets.
   */
  const refusedGuides = new Set<string>()
  return {
    id: 'sheets',
    systemPrompt: basePrompt,
    tools: [UPDATE_TASK_PLAN_TOOL, ...WORKBOOK_TOOLS],
    buildContext: () => {
      loadedGuides.clear()
      refusedGuides.clear()
      options.onTaskPlan?.(null)
      return buildWorkbookContext(deps)
    },
    executeTool: (call) => {
      if (call.name === 'update_task_plan') {
        const parsed = parseTaskPlan(call.input)
        if (!parsed.ok) {
          return {
            output: parsed.error,
            isError: true,
            mutated: false,
            summary: t('aiToolUpdateTaskPlan'),
          }
        }
        options.onTaskPlan?.(parsed.plan)
        const completed = parsed.plan.todos.filter((item) => item.status === 'completed').length
        const inProgress = parsed.plan.todos.filter((item) => item.status === 'in_progress').length
        const pending = parsed.plan.todos.length - completed - inProgress
        return {
          output: `Task plan updated: ${completed} completed, ${inProgress} in progress, ${pending} pending.`,
          mutated: false,
          summary: t('aiToolUpdateTaskPlan'),
        }
      }
      if (call.name === 'load_guide') {
        const raw = call.input.guides
        if (!Array.isArray(raw) || raw.length === 0) {
          return {
            output: 'guides must be a non-empty array',
            isError: true,
            mutated: false,
            summary: t('aiToolLoadGuide'),
          }
        }
        const requested = raw.map(String)
        // serve = fresh guides plus guides already refused once (their content
        // was likely squashed out of context); skip = first repeat this run
        const serve = requested.filter((name) => !loadedGuides.has(name) || refusedGuides.has(name))
        const skip = requested.filter((name) => loadedGuides.has(name) && !refusedGuides.has(name))
        if (serve.length === 0) {
          for (const name of skip) refusedGuides.add(name)
          return {
            output: `Guides already in this run's context: ${skip.join(', ')}. Do not reload unless you can no longer see their content above — asking again returns it in full. Otherwise proceed to propose_operations.`,
            mutated: false,
            summary: t('aiToolLoadGuideOf', { names: skip.join(', ') }),
          }
        }
        const outcome = loadGuides(serve)
        if (!outcome.ok) {
          return {
            output: outcome.error,
            isError: true,
            mutated: false,
            summary: t('aiToolLoadGuide'),
          }
        }
        for (const name of skip) refusedGuides.add(name)
        for (const name of serve) loadedGuides.add(name)
        const already =
          skip.length > 0 ? `\n\n(Already loaded this run, not repeated: ${skip.join(', ')})` : ''
        return {
          output: outcome.content + already,
          mutated: false,
          summary: t('aiToolLoadGuideOf', { names: serve.join(', ') }),
        }
      }
      return executeWorkbookTool(call, deps)
    },
    verifyResponse: verifySheetsResponse,
  }
}
