// Expiry runway + calendar export: a chronological renewal timeline of the
// company vault (documents + tenders with deadlines), plus one-click .ics
// download generated entirely client-side via a Blob.
import type { TenderRecord, VaultDoc } from '../shared/types'
import { assessDocHealth, daysBetween, type DocHealthReport } from './gap'
import { parseClosingDate } from './deadline'

export interface RunwayItem {
  id: string
  /** what needs action, e.g. "COIDA letter of good standing" */
  title: string
  /** ISO date of the event */
  date: string
  /** days from today (negative = overdue) */
  daysAway: number
  /** "VAULT_EXPIRY" | "STALE_STAMP" | "TENDER_CLOSING" | "TENDER_SUBMIT_BY" */
  kind: RunwayKind
  /** optional explanatory note */
  note: string
}

export type RunwayKind = 'VAULT_EXPIRY' | 'STALE_STAMP' | 'TENDER_CLOSING' | 'TENDER_SUBMIT_BY'

export const RUNWAY_KIND_LABEL: Record<RunwayKind, string> = {
  VAULT_EXPIRY: 'Document expires',
  STALE_STAMP: 'Police stamp window ends',
  TENDER_CLOSING: 'Tender closes',
  TENDER_SUBMIT_BY: 'Submit tender by'
}

/** Build the chronological renewal timeline (earliest first). */
export function buildRunway(
  vault: VaultDoc[],
  tenders: TenderRecord[],
  now: Date = new Date()
): RunwayItem[] {
  const items: RunwayItem[] = []

  for (const doc of vault) {
    const rep: DocHealthReport = assessDocHealth(doc, now)

    if (doc.expiryDate) {
      const days = daysBetween(new Date(doc.expiryDate), now)
      items.push({
        id: `exp-${doc.id}`,
        title: doc.title,
        date: doc.expiryDate,
        daysAway: days,
        kind: 'VAULT_EXPIRY',
        note:
          days < 0
            ? `Expired ${Math.abs(days)} day(s) ago — renew immediately`
            : `Expires in ${days} day(s)`
      })
    }

    if (rep.stampDaysLeft !== null) {
      const stampEnd = new Date(doc.certifiedDate!)
      stampEnd.setDate(stampEnd.getDate() + 90)
      const days = daysBetween(stampEnd, now)
      items.push({
        id: `stamp-${doc.id}`,
        title: doc.title,
        date: stampEnd.toISOString(),
        daysAway: days,
        kind: 'STALE_STAMP',
        note:
          days < 0
            ? `Stamp ${Math.abs(days)} day(s) past the 90-day window — re-certify`
            : `Re-certify within ${days} day(s)`
      })
    }
  }

  for (const t of tenders) {
    const closing = parseClosingDate(t.closingDate)
    if (!closing) continue
    const days = daysBetween(closing, now)
    if (days >= -30) {
      items.push({
        id: `close-${t.id}`,
        title: t.title,
        date: closing.toISOString(),
        daysAway: days,
        kind: 'TENDER_CLOSING',
        note: t.referenceNumber ? `Ref ${t.referenceNumber}` : 'Closing date'
      })
      const submitBy = new Date(closing.getTime() - 24 * 3_600_000)
      items.push({
        id: `submit-${t.id}`,
        title: t.title,
        date: submitBy.toISOString(),
        daysAway: daysBetween(submitBy, now),
        kind: 'TENDER_SUBMIT_BY',
        note: 'Target: submit 24h before closing'
      })
    }
  }

  return items.sort((a, b) => a.date.localeCompare(b.date))
}

// ── .ics generation ──────────────────────────────────────────────────────────

function icsEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

function icsStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00Z`
  )
}

/** Fold long lines at 75 octets per RFC 5545. */
function fold(line: string): string {
  if (line.length <= 74) return line
  const parts: string[] = [line.slice(0, 74)]
  let rest = line.slice(74)
  while (rest.length > 73) {
    parts.push(` ${rest.slice(0, 73)}`)
    rest = rest.slice(73)
  }
  if (rest) parts.push(` ${rest}`)
  return parts.join('\r\n')
}

function vevent(uid: string, start: Date, title: string, description: string): string[] {
  const end = new Date(start.getTime() + 30 * 60_000) // 30-min reminder slot
  return [
    'BEGIN:VEVENT',
    `UID:${uid}@tendeguard`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    fold(`SUMMARY:${icsEscape(title)}`),
    fold(`DESCRIPTION:${icsEscape(description)}`),
    'BEGIN:VALARM',
    'TRIGGER:-P7D',
    'ACTION:DISPLAY',
    fold(`DESCRIPTION:${icsEscape(title)}`),
    'END:VALARM',
    'END:VEVENT'
  ]
}

/** Render a full iCalendar file body for the given runway items. */
export function buildIcs(items: RunwayItem[], onlyUpcoming = true, now: Date = new Date()): string {
  const selected = onlyUpcoming
    ? items.filter((i) => i.daysAway >= -1)
    : items

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Zanostack Tenders//Expiry Runway//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape('Zanostack Tenders — renewal runway')}`
  ]

  for (const item of selected) {
    const start = new Date(item.date)
    lines.push(
      ...vevent(
        item.id,
        start,
        `${RUNWAY_KIND_LABEL[item.kind]} — ${item.title}`,
        `${item.note}. Added by Zanostack Tenders.`
      )
    )
  }

  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

/** Trigger a client-side .ics download. */
export function downloadIcs(items: RunwayItem[], fileName = 'tendeguard-renewal-runway.ics'): void {
  const body = buildIcs(items)
  const blob = new Blob([body], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // give the download a beat before revoking the object URL
  setTimeout(() => URL.revokeObjectURL(url), 5_000)
}
