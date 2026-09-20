// Submission dialog — Phase 4, WP-11.
//
// Records proof of submission: when it was handed over (with the time zone it was
// reported in), how, to whom, the confirmation reference, any receipt/evidence
// attachment, who submitted it and free notes — plus the readiness checkpoint
// that stood at that moment.
//
// The app never submits anything itself. This dialog only records what the human
// did. If readiness is not clear, submitting requires an explicit reason and the
// blockers are frozen into the record unchanged — the dialog never calls that
// "cleared".
import { useState } from 'react'
import { AlertTriangle, CheckCircle2, FileUp, Send, ShieldAlert } from 'lucide-react'
import type { ReadinessReport } from '../readiness'
import {
  SUBMISSION_METHOD_LABEL,
  type SubmissionMethod,
  type TenderRecord,
} from '../../shared/types'
import {
  readinessSnapshotFromReport,
  type SubmissionEvidenceState,
} from '../../../shared/lifecycle'
import { useTendersStore } from '../store'
import { Dialog } from './Dialog'
import { Button, FormField, FormSelect } from './ui'

export const EVIDENCE_KINDS: { value: string; label: string }[] = [
  { value: '', label: 'No evidence recorded yet' },
  { value: 'email-receipt', label: 'Email receipt / sent copy' },
  { value: 'portal-confirmation', label: 'Portal confirmation' },
  { value: 'courier-slip', label: 'Courier / delivery slip' },
  { value: 'submission-receipt', label: 'Issuer submission receipt' },
  { value: 'other', label: 'Other reference' },
]

export const EVIDENCE_LABEL: Record<string, string> = Object.fromEntries(
  EVIDENCE_KINDS.filter((kind) => kind.value).map((kind) => [kind.value, kind.label]),
)

const METHOD_OPTIONS: { value: string; label: string }[] = [
  { value: 'EMAIL', label: SUBMISSION_METHOD_LABEL.EMAIL },
  { value: 'PHYSICAL', label: SUBMISSION_METHOD_LABEL.PHYSICAL },
  { value: 'ELECTRONIC', label: SUBMISSION_METHOD_LABEL.ELECTRONIC },
]

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** `datetime-local` wants local wall-clock, not UTC. */
export function toLocalDateTimeInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function parseMoney(raw: string): number | null {
  const digits = raw.replace(/[^\d.]/g, '')
  if (!digits) return null
  const value = Number(digits)
  return Number.isFinite(value) && value >= 0 ? value : null
}

export interface SubmissionDialogProps {
  tender: TenderRecord
  /** Readiness computed from the tender's current state; captured with the record. */
  readiness: ReadinessReport
  onClose: () => void
}

export function SubmissionDialog({ tender, readiness, onClose }: SubmissionDialogProps) {
  const recordSubmission = useTendersStore((s) => s.recordSubmission)
  const existing = tender.submission ?? null

  // Re-opening an existing record (e.g. to attach the receipt afterwards) starts
  // from what was already recorded; nothing is silently rewritten.
  const [submittedAtLocal, setSubmittedAtLocal] = useState(() =>
    existing
      ? toLocalDateTimeInput(new Date(existing.submittedAt))
      : toLocalDateTimeInput(new Date()),
  )
  const [timeZone, setTimeZone] = useState(existing?.timeZone ?? browserTimeZone())
  const [method, setMethod] = useState<SubmissionMethod>(
    existing?.method ?? tender.submissionMethod ?? 'EMAIL',
  )
  const [destination, setDestination] = useState(
    existing?.destination ?? tender.submissionAddress ?? '',
  )
  const [confirmationReference, setConfirmationReference] = useState(
    existing?.confirmationReference ?? '',
  )
  const [evidenceKind, setEvidenceKind] = useState(existing?.evidence?.kind ?? '')
  const [evidenceReference, setEvidenceReference] = useState(existing?.evidence?.reference ?? '')
  const [evidenceNote, setEvidenceNote] = useState(existing?.evidence?.note ?? '')
  const [person, setPerson] = useState(existing?.person ?? '')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [overrideReason, setOverrideReason] = useState(existing?.blockerOverrideReason ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const blockingChecks = readiness.checks.filter((check) => check.blocking && !check.passed)
  const readinessClear = readiness.ready
  const needsOverride = !readinessClear && !existing

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    const parsed = new Date(submittedAtLocal)
    if (!submittedAtLocal || isNaN(parsed.getTime())) {
      nextErrors.submittedAt = 'Enter the date and time the bid was handed over.'
    }
    if (!method) nextErrors.method = 'Choose how the bid was submitted.'
    if (needsOverride && !overrideReason.trim()) {
      nextErrors.overrideReason =
        'A reason is required: explain why this bid is being submitted before readiness is clear. The blockers are kept on the record.'
    }
    if (evidenceKind && evidenceKind === 'other' && !evidenceReference.trim()) {
      nextErrors.evidenceReference = 'Add the reference this evidence points to.'
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    const capturedAt = new Date().toISOString()
    const result = recordSubmission(tender.id, {
      submittedAt: parsed.toISOString(),
      timeZone: timeZone.trim() || null,
      method,
      destination: destination.trim() || null,
      confirmationReference: confirmationReference.trim() || null,
      evidence: evidenceKind
        ? {
            kind: evidenceKind,
            reference: evidenceReference.trim() || null,
            note: evidenceNote.trim() || null,
          }
        : null,
      person: person.trim() || null,
      notes: notes.trim() || null,
      readiness: readinessSnapshotFromReport(readiness, capturedAt),
      readinessIsCurrent: true,
      blockerOverrideReason: overrideReason.trim() || null,
    })

    if (!result.ok) {
      setErrors({ form: result.error ?? 'The submission could not be recorded.' })
      return
    }
    onClose()
  }

  return (
    <Dialog
      title={existing ? 'Update the submission record' : 'Record the submission'}
      subtitle="Tenders does not submit anything for you. Record what happened — the date and time, how it was handed over, and the proof you kept."
      icon={<Send size={16} className="text-[var(--accent)]" aria-hidden="true" />}
      closeLabel="Close submission dialog"
      onClose={onClose}
      size="lg"
      bodyClassName="min-h-0"
    >
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto scroll-thin px-5 py-4">
          {/* readiness checkpoint */}
          <section
            className={`rounded-lg border p-3 ${
              readinessClear
                ? 'border-[var(--success-border)] bg-[var(--success-bg)]'
                : 'border-[var(--warn-border)] bg-[var(--warn-bg)]'
            }`}
            aria-live="polite"
          >
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text)]">
              {readinessClear ? (
                <CheckCircle2 size={14} className="text-[var(--success)]" aria-hidden="true" />
              ) : (
                <AlertTriangle size={14} className="text-[var(--warn)]" aria-hidden="true" />
              )}
              Readiness checkpoint: {readinessClear ? 'clear' : 'not clear'} · {readiness.score}%
            </p>
            {readinessClear ? (
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                This checkpoint is saved with the submission so the state of the bid is auditable
                later.
              </p>
            ) : (
              <>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {blockingChecks.length} blocking check
                  {blockingChecks.length === 1 ? '' : 's'} still failing. Submitting anyway needs a
                  reason, and these blockers are saved with the record unchanged — they are never
                  recorded as cleared.
                </p>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[11px] text-[var(--text-secondary)]">
                  {blockingChecks.slice(0, 5).map((check) => (
                    <li key={check.id}>{check.label}</li>
                  ))}
                  {blockingChecks.length > 5 && <li>and {blockingChecks.length - 5} more…</li>}
                </ul>
              </>
            )}
          </section>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-[var(--text)]">Handover</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label="Date and time submitted"
                type="datetime-local"
                required
                autoFocus
                value={submittedAtLocal}
                onChange={setSubmittedAtLocal}
                error={errors.submittedAt ?? null}
              />
              <FormField
                label="Time zone"
                value={timeZone}
                onChange={setTimeZone}
                placeholder="e.g. Africa/Johannesburg"
                hint="Detected from this machine — change it if the issuer reported a different zone."
              />
              <FormSelect
                label="Method"
                value={method}
                onChange={(value) => setMethod(value as SubmissionMethod)}
                options={METHOD_OPTIONS}
              />
              <FormField
                label="Destination"
                value={destination}
                onChange={setDestination}
                placeholder="e.g. tenders@example.gov.za or the bid box address"
              />
              <FormField
                label="Confirmation / reference number"
                value={confirmationReference}
                onChange={setConfirmationReference}
                placeholder="e.g. portal reference or email subject"
              />
              <FormField
                label="Submitted by"
                value={person}
                onChange={setPerson}
                placeholder="Who handed the bid over"
              />
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-[var(--text)]">Receipt / evidence</legend>
            <p className="text-[11px] leading-relaxed text-[var(--text-tertiary)]">
              Keep the proof with the bid: a sent-mail copy, a portal confirmation, or a receipt
              from the issuer. Without evidence the tender stays “submitted · evidence required”.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormSelect
                label="Kind of evidence"
                value={evidenceKind}
                onChange={setEvidenceKind}
                options={EVIDENCE_KINDS}
              />
              <FormField
                label="Reference"
                value={evidenceReference}
                onChange={setEvidenceReference}
                placeholder="e.g. email subject line or portal ticket"
                error={errors.evidenceReference ?? null}
              />
            </div>
            <FormField
              label="Evidence note"
              textarea
              rows={2}
              value={evidenceNote}
              onChange={setEvidenceNote}
              placeholder="Anything the reference alone does not explain."
            />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-[var(--text)]">Notes</legend>
            <FormField
              label="What happened"
              textarea
              rows={3}
              value={notes}
              onChange={setNotes}
              placeholder="e.g. Hand-delivered at 10:40 and stamped by reception; courier copy filed."
            />
          </fieldset>

          {needsOverride && (
            <section className="space-y-2 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3">
              <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text)]">
                <ShieldAlert size={14} className="text-[var(--danger)]" aria-hidden="true" />
                Submitting before readiness is clear
              </p>
              <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                This is recorded as an override with your reason and the blocker snapshot. It is not
                a readiness clearance.
              </p>
              <FormField
                label="Reason for submitting with blockers"
                textarea
                rows={2}
                required
                value={overrideReason}
                onChange={setOverrideReason}
                error={errors.overrideReason ?? null}
                placeholder="e.g. Issuer extended the deadline verbally; pack completed and couriered 09:30."
              />
            </section>
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
            <FileUp size={14} aria-hidden="true" />
            {existing
              ? 'Save the record'
              : needsOverride
                ? 'Record submission with override'
                : 'Record submission'}
          </Button>
        </footer>
      </form>
    </Dialog>
  )
}

/** Compact evidence chip reused by the lifecycle panel and tender cards. */
export function submissionEvidenceLabel(state: SubmissionEvidenceState): string {
  switch (state) {
    case 'recorded':
      return 'Evidence recorded'
    case 'required':
      return 'Evidence required'
    default:
      return 'Not submitted'
  }
}
