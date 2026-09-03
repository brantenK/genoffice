// Bid-readiness drawer: the pre-submission gate for the active tender.
// Renders the readiness checks (requirements resolved, linked docs valid AT
// the closing date, signature checklist, company-details consistency,
// deadline), a per-signature-item checkbox list, and the
// "Mark ready to submit" action that flips the tender to READY_FOR_SUBMISSION.
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  PenLine,
  ShieldCheck,
  X,
  XCircle
} from 'lucide-react'
import { useNow } from '../deadline'
import { assessReadiness, labelForRule, signatureRuleKeys } from '../readiness'
import { selectActiveTender, useTendersStore } from '../store'
import { TENDER_STATUS_LABEL } from '../../shared/types'
import { Badge, Button } from './ui'

export function ReadinessDrawer({ onClose }: { onClose: () => void }) {
  const tender = useTendersStore(selectActiveTender)
  const vault = useTendersStore((s) => s.vault)
  const company = useTendersStore((s) => s.company)
  const updateTender = useTendersStore((s) => s.updateTender)
  const setSignatureCheck = useTendersStore((s) => s.setSignatureCheck)
  const now = useNow(60_000)

  if (!tender) return null

  const report = assessReadiness(tender, vault, company, now)
  const sigKeys = signatureRuleKeys(tender)
  const isReady = tender.status === 'READY_FOR_SUBMISSION'

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-[400px] max-w-[90%] flex-col border-l border-slate-200 bg-white shadow-2xl">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Bid readiness</h2>
          <p className="text-[11px] text-slate-500">Pre-submission checklist</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} title="Close readiness">
          <X size={15} />
        </Button>
      </div>

      {/* summary banner */}
      <div
        className={`shrink-0 border-b px-4 py-3 ${
          report.ready
            ? 'border-emerald-200 bg-emerald-50'
            : 'border-amber-200 bg-amber-50'
        }`}
      >
        <div className="flex items-center gap-3">
          {/* weighted score ring */}
          <div
            className={`flex size-14 shrink-0 items-center justify-center rounded-full border-4 ${
              report.score >= 80
                ? 'border-emerald-500'
                : report.score >= 50
                  ? 'border-amber-500'
                  : 'border-red-400'
            }`}
            title="Weighted readiness score"
          >
            <span className="text-sm font-bold text-slate-800">{report.score}%</span>
          </div>
          <div className="min-w-0">
            <p
              className={`text-xs font-medium ${report.ready ? 'text-emerald-800' : 'text-amber-800'}`}
            >
              {report.ready
                ? '✓ All blocking checks pass — this tender can be marked ready to submit.'
                : `${report.blockingFailedCount} blocking check${report.blockingFailedCount === 1 ? '' : 's'} still failing.`}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {report.score}% ready · {report.passedCount}/{report.checks.length} checks passed
            </p>
          </div>
        </div>
        {/* highest-leverage fix: the failing check worth the most score points */}
        {!report.ready && report.nextBestAction && (
          <p className="mt-2 rounded-md bg-white/70 px-2 py-1.5 text-[11px] leading-snug text-slate-600">
            <span className="font-semibold text-slate-700">Biggest gain:</span>{' '}
            {report.nextBestAction.label} — {report.nextBestAction.detail}
          </p>
        )}
      </div>

      {/* checks */}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin p-3">
        <ul className="space-y-2">
          {report.checks.map((check) => (
            <li
              key={check.id}
              className={`rounded-lg border p-3 ${
                check.passed
                  ? 'border-emerald-200 bg-emerald-50/50'
                  : check.blocking
                    ? 'border-red-200 bg-red-50/50'
                    : 'border-amber-200 bg-amber-50/50'
              }`}
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0">
                  {check.passed ? (
                    <CheckCircle2 size={15} className="text-emerald-600" />
                  ) : check.blocking ? (
                    <XCircle size={15} className="text-red-500" />
                  ) : (
                    <AlertTriangle size={15} className="text-amber-500" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-slate-800">
                    {check.label}
                    {!check.blocking && <Badge tone="slate">Advisory</Badge>}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-600">{check.detail}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>

        {/* signature checklist */}
        {sigKeys.length > 0 && (
          <div className="mt-4 rounded-lg border border-slate-200 p-3">
            <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-800">
              <PenLine size={13} className="text-indigo-500" /> Signature checklist
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Tick each item once the signed/initialled originals are in the bid pack.
            </p>
            <ul className="mt-2 space-y-1.5">
              {sigKeys.map((key) => (
                <li key={key}>
                  <label className="flex cursor-pointer items-center gap-2 text-[13px] text-slate-700">
                    <input
                      type="checkbox"
                      checked={tender.signatureChecks[key] ?? false}
                      onChange={(e) => setSignatureCheck(tender.id, key, e.target.checked)}
                      className="size-4 cursor-pointer accent-indigo-600"
                    />
                    {labelForRule(key)}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* footer action */}
      <div className="shrink-0 border-t border-slate-200 px-4 py-3">
        {isReady ? (
          <div className="flex items-center justify-between gap-2">
            <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-emerald-700">
              <ShieldCheck size={15} /> {TENDER_STATUS_LABEL.READY_FOR_SUBMISSION}
            </p>
            <Button
              size="sm"
              variant="default"
              title="Move the tender back to in-progress"
              onClick={() => updateTender(tender.id, { status: 'IN_PROGRESS' })}
            >
              Back to in progress
            </Button>
          </div>
        ) : (
          <Button
            className="w-full justify-center"
            variant="primary"
            disabled={!report.ready}
            onClick={() => updateTender(tender.id, { status: 'READY_FOR_SUBMISSION' })}
            title={
              report.ready
                ? 'Mark this tender as ready for submission'
                : 'Resolve every blocking check first'
            }
          >
            <ClipboardCheck size={14} /> Mark ready to submit
          </Button>
        )}
        <p className="mt-1.5 text-[10px] text-slate-400">
          Documents are re-checked as they will stand on the closing date, not today.
        </p>
      </div>
    </aside>
  )
}
