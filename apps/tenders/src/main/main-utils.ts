// Two predicates every main module opens with.
//
// `isRecord` is re-exported from `readiness-snapshot.ts`, where it is declared,
// so a caller that already imports that module does not grow a second import.
export { isRecord } from './readiness-snapshot'

/** A message from an unknown `throw`, or the caller's fallback. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
