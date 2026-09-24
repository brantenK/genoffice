// Closing-date parsing + live countdown helpers.
// RFP closing dates arrive as raw extracted text like
// "30 November 2026 at 11:00", "2026-11-30", "30/11/2026 11:00" — this
// module turns that into a real Date, a live "closes in 3d 4h" label,
// and the recommended target submission time (24h before closing).
//
// The parser itself is NOT here: there is exactly one closing-date parser, the
// shared `parseClosingDate` in `shared/readiness.ts`, re-exported below so the
// badge, the readiness gate, the runway and the store can never disagree about
// what a closing-date string means. The closing-instant FORMATTER is not here
// either — `formatClosing` below delegates to the shared `formatClosingInstant`
// in that same module, so the badge and the reminder copy cannot drift apart.
import { useEffect, useState } from 'react'
import { formatClosingInstant, formatDeadlineDelta, parseClosingDate } from '../../shared/readiness'

export { parseClosingDate }

/** Recommended lead time: submit a full day before closing. */
export const SUBMIT_EARLY_HOURS = 24

export type DeadlineUrgency = 'closed' | 'urgent' | 'soon' | 'comfortable'

export interface DeadlineStatus {
  date: Date | null
  urgency: DeadlineUrgency
  /** e.g. "3d 4h" or "2h 15m" or "Closed 5d ago" */
  countdownLabel: string
  /** "Mon, 30 Nov 2026, 11:00" — the closing time as written in the RFP */
  formatted: string
  /** target submission time (24h before closing), if date known */
  submitBy: Date | null
  /** `submitBy` as display text; always render this, never a local-time format */
  submitByLabel: string | null
  /** true when now is inside the final 24h window */
  insideSubmitWindow: boolean
}

/** Human "3d 4h" / "4h 15m" / "12m" style delta (shared with readiness). */
export function formatDelta(ms: number): string {
  return formatDeadlineDelta(ms)
}

/**
 * Civil closing values are anchored to SAST by `parseClosingDate`, so civil text
 * is rendered in `Africa/Johannesburg`: that shows the closing time exactly as
 * the RFP states it, on every machine, and keeps the countdown and the readiness
 * gate describing the same instant. An RFC 3339 value with an explicit offset is
 * a real instant instead, so it is rendered on the reader's own clock. Both the
 * rendering and the timezone decision are the shared `formatClosingInstant`, so
 * this module carries no second copy of either.
 */
function formatClosing(date: Date, raw: string | null | undefined): string {
  return formatClosingInstant(date, raw)
}

export function deadlineStatus(
  raw: string | null | undefined,
  now: Date = new Date(),
): DeadlineStatus {
  const date = parseClosingDate(raw)
  if (!date) {
    return {
      date: null,
      urgency: 'comfortable',
      countdownLabel: '',
      formatted: raw?.trim() ?? '',
      submitBy: null,
      submitByLabel: null,
      insideSubmitWindow: false,
    }
  }

  const diff = date.getTime() - now.getTime()
  const formatted = formatClosing(date, raw)

  if (diff <= 0) {
    return {
      date,
      urgency: 'closed',
      countdownLabel: `Closed ${formatDelta(diff)} ago`,
      formatted,
      submitBy: null,
      submitByLabel: null,
      insideSubmitWindow: false,
    }
  }

  const submitBy = new Date(date.getTime() - SUBMIT_EARLY_HOURS * 3_600_000)
  const insideSubmitWindow = now >= submitBy
  // Inside the final 24h is the urgent state; the rest of the closing week is
  // "soon". Testing the window first is what makes both reachable — testing
  // "less than 7 days" first swallowed every "soon" case.
  const urgency: DeadlineUrgency = insideSubmitWindow
    ? 'urgent'
    : diff < 7 * 86_400_000
      ? 'soon'
      : 'comfortable'

  return {
    date,
    urgency,
    countdownLabel: `closes in ${formatDelta(diff)}`,
    formatted,
    submitBy,
    submitByLabel: formatClosing(submitBy, raw),
    insideSubmitWindow,
  }
}

/** Ticking clock hook — re-renders the caller every `intervalMs` (default 60s). */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/** Tailwind classes for the urgency badge. */
export function urgencyClasses(u: DeadlineUrgency): string {
  switch (u) {
    case 'closed':
      return 'bg-slate-200 text-slate-600'
    case 'urgent':
      return 'bg-red-100 text-red-700 ring-1 ring-red-200'
    case 'soon':
      return 'bg-amber-100 text-amber-800 ring-1 ring-amber-200'
    default:
      return 'bg-emerald-100 text-emerald-700'
  }
}
