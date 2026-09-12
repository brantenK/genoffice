import { z } from 'zod'

export const taskStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

const trimmedTaskText = (field: 'content' | 'activeForm') =>
  z
    .string({ error: `${field} must be a string` })
    .trim()
    .min(1, `${field} must be between 1 and 160 characters`)
    .max(160, `${field} must be between 1 and 160 characters`)

export const taskPlanItemSchema = z.object({
  content: trimmedTaskText('content'),
  activeForm: trimmedTaskText('activeForm'),
  status: taskStatusSchema,
})

export const taskPlanSchema = z
  .object({
    todos: z
      .array(taskPlanItemSchema, { error: 'todos must be an array' })
      .min(1, 'todos must contain at least 1 item')
      .max(12, 'todos must contain at most 12 items'),
  })
  .superRefine(({ todos }, context) => {
    if (todos.filter((item) => item.status === 'in_progress').length > 1) {
      context.addIssue({
        code: 'custom',
        path: ['todos'],
        message: 'todos may contain at most one in_progress item',
      })
    }

    const seen = new Set<string>()
    for (const [index, item] of todos.entries()) {
      const key = item.content.toLocaleLowerCase()
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['todos', index, 'content'],
          message: `duplicate todo content: ${item.content}`,
        })
      }
      seen.add(key)
    }
  })

export type TaskPlanItem = Readonly<z.infer<typeof taskPlanItemSchema>>
export interface TaskPlan {
  readonly todos: readonly TaskPlanItem[]
}

export type ParseTaskPlanResult =
  { readonly ok: true; readonly plan: TaskPlan } | { readonly ok: false; readonly error: string }

function freezeTaskPlan(plan: z.infer<typeof taskPlanSchema>): TaskPlan {
  const todos = plan.todos.map((item) => Object.freeze({ ...item }))
  return Object.freeze({ todos: Object.freeze(todos) })
}

export function parseTaskPlan(input: unknown): ParseTaskPlanResult {
  const parsed = taskPlanSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`)
        .join('; '),
    }
  }
  return { ok: true, plan: freezeTaskPlan(parsed.data) }
}
