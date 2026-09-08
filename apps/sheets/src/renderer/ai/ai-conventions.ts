/**
 * Light persistent memory for the sheets agent: a short user-conventions note
 * injected into workbook context. Not a skill-learning loop — cap is small so
 * it cannot bloat the prompt.
 */
export const AI_CONVENTIONS_KEY = 'sheets-ai-conventions'
export const AI_CONVENTIONS_MAX = 2048

export function readAiConventions(): string {
  try {
    const raw = localStorage.getItem(AI_CONVENTIONS_KEY)
    if (!raw) return ''
    return raw.trim().slice(0, AI_CONVENTIONS_MAX)
  } catch {
    return ''
  }
}

export function writeAiConventions(text: string): void {
  try {
    const next = text.trim().slice(0, AI_CONVENTIONS_MAX)
    if (!next) localStorage.removeItem(AI_CONVENTIONS_KEY)
    else localStorage.setItem(AI_CONVENTIONS_KEY, next)
  } catch {
    // private-mode / disabled storage
  }
}
