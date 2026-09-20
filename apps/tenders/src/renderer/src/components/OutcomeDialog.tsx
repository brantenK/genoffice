// Outcome dialog — Phase 4, WP-11.
//
// Records what the issuer decided: won, lost, withdrawn or cancelled, with the
// notice date, the reason, the awarded value (won) and a reference to the notice
// or award letter. Recording a win is what enables contract milestones; the other
// outcomes never expose billing.
import { useState } from 'react'
import { AlertTriangle, Gavel } from 'lucide-react'
import {
  TENDER_OUTCOME_LABEL,
  type TenderOutcomeStatus,
  type TenderRecord,
} from '../../shared/types'
import { useTendersStore } from '../store'
import { Dialog } from './Dialog'
import { Button, FormField, FormSelect } from './ui'

type OutcomeChoice = Exclude<TenderOutcomeStatus, 'pending'>

const OUTCOME_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '— choose the outcome —' },
  { value: 'won', label: TENDER_OUTCOME_LABEL.won },
  { value: 'lost', label: TENDER_OUTCOME_LABEL.lost },
  { value: 'withdrawn', label: TENDER_OUTCOME_LABEL.withdrawn },
  { value: 'cancelled', label: TENDER_OUTCOME_LABEL.cancelled },
]

const OUTCOME_EXPLANATION: Record<OutcomeChoice, string> = {
  won: 'The bid was awarded. Contract milestones become available for this tender.',
  lost: 'The bid was not awarded. No milestone billing is exposed.',
  withdrawn: 'You withdrew the bid before a decision. No milestone billing is exposed.',
  cancelled: 'The issuer cancelled the tender. No milestone billing is exposed.',
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function todayInput(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Convert a `<input type="date">` civil date (`YYYY-MM-DD`) to the RFC3339
 * instant the persisted `TenderOutcomeRecord.noticeDate` requires. Returns null
 * for an empty or impossible date (e.g. 2026-02-30) so the caller can fail
 * closed instead of sending a value the schema rejects.
 */
export function civilDateToRfc3339(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  if (!raw) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const parsed = new Date(`${raw}T00:00:00.000Z`)
  if (isNaN(parsed.getTime())) return null
  // Round-trip guards against calendar rollover (2026-02-30 -> 2026-03-02).
  return parsed.toISOString().slice(0, 10) === raw ? parsed.toISOString() : null
}

function parseMoney(raw: string): number | null {
  const digits = raw.replace(/[^\d.]/g, '')
  if (!digits) return null
  const value = Number(digits)
  return Number.isFinite(value) && value >= 0 ? value : null
}

export interface OutcomeDialogProps {
  tender: TenderRecord
  onClose: () => void
}

export function OutcomeDialog({ tender, onClose }: OutcomeDialogProps) {
  const recordOutcome = useTendersStore((s) => s.recordOutcome)
  const existing = tender.outcome ?? null
  const [status, setStatus] = useState<string>(
    existing && existing.status !== 'pending' ? existing.status : '',
  )
  const [noticeDate, setNoticeDate] = useState(existing?.noticeDate?.slice(0, 10) ?? todayInput())
  const [reason, setReason] = useState(existing?.reason ?? '')
  const [awardedValue, setAwardedValue] = useState(
    existing?.awardedValue != null ? String(existing.awardedValue) : '',
  )
  const [evidenceReference, setEvidenceReference] = useState(existing?.evidenceReference ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const chosen = (status || null) as OutcomeChoice | null

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (!chosen) nextErrors.status = 'Choose what the issuer decided.'
    // The persisted field is an RFC3339 instant; the input is a civil date.
    const noticeDateInstant = civilDateToRfc3339(noticeDate)
    if (noticeDate.trim() && noticeDateInstant === null) {
      nextErrors.noticeDate = 'Enter a real calendar date (YYYY-MM-DD).'
    }
    if (chosen === 'won' && awardedValue.trim() && parseMoney(awardedValue) === null) {
      nextErrors.awardedValue = 'Enter the awarded value as a number, or leave it blank.'
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0 || !chosen) return

    const result = recordOutcome(tender.id, {
      status: chosen,
      noticeDate: noticeDateInstant,
      reason: reason.trim() || null,
      awardedValue: chosen === 'won' ? parseMoney(awardedValue) : null,
      evidenceReference: evidenceReference.trim() || null,
    })

    if (!result.ok) {
      setErrors({ form: result.error ?? 'The outcome could not be recorded.' })
      return
    }
    onClose()
  }

  return (
    <Dialog
      title="Record the tender outcome"
      subtitle="What the issuer decided, with the notice you received. This moves the tender out of the submission phase."
      icon={<Gavel size={16} className="text-[var(--accent)]" aria-hidden="true" />}
      closeLabel="Close outcome dialog"
      onClose={onClose}
      size="md"
      bodyClassName="min-h-0"
    >
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto scroll-thin px-5 py-4">
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-[var(--text)]">Decision</legend>
            <FormSelect
              label="Outcome"
              value={status}
              onChange={setStatus}
              options={OUTCOME_OPTIONS}
            />
            {errors.status && (
              <p role="alert" className="text-[11px] font-medium text-[var(--danger-text)]">
                {errors.status}
              </p>
            )}
            {chosen && (
              <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                {OUTCOME_EXPLANATION[chosen]}
              </p>
            )}
            <FormField
              label="Notice date"
              type="date"
              value={noticeDate}
              onChange={setNoticeDate}
              error={errors.noticeDate ?? null}
              hint="The date on the award or regret letter, if the issuer stated one."
            />
            {chosen === 'won' && (
              <FormField
                label="Awarded value"
                value={awardedValue}
                onChange={setAwardedValue}
                placeholder="e.g. 4 250 000"
                error={errors.awardedValue ?? null}
                hint="Leave blank if the issuer has not stated the value yet."
              />
            )}
            <FormField
              label="Reason / note"
              textarea
              rows={3}
              value={reason}
              onChange={setReason}
              placeholder="e.g. Scored 82/100 — highest technical and price score."
            />
            <FormField
              label="Notice reference"
              value={evidenceReference}
              onChange={setEvidenceReference}
              placeholder="e.g. award letter reference or email subject"
            />
          </fieldset>

          {chosen && chosen !== 'won' && (
            <p className="flex items-start gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
              <AlertTriangle
                size={13}
                className="mt-0.5 shrink-0 text-[var(--warn)]"
                aria-hidden="true"
              />
              Contract milestones and Books billing stay hidden for this tender.
            </p>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
          {errors.form && (
            <p role="alert" className="mr-auto text-[11px] font-medium text-[var(--danger-text)]">
              {errors.form}
            </p>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Record outcome
          </Button>
        </footer>
      </form>
    </Dialog>
  )
}
