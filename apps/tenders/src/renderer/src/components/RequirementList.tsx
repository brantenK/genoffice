// Checklist pane: grouped compliance matrix rows. Clicking a row focuses the
// PDF viewer on the exact clause (list -> PDF); active state comes from the
// store so PDF-box clicks highlight the row back (PDF -> list).
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Link2, MapPin } from 'lucide-react'
import {
  CATEGORY_ORDER,
  REQUIREMENT_CATEGORY_LABEL
} from '../../shared/types'
import type { RequirementRecord, TenderRecord } from '../../shared/types'
import { useTendersStore } from '../store'
import { Badge, Button, RISK_LABEL, RISK_TONE, STATUS_LABEL, STATUS_TONE } from './ui'

export function RequirementList({ tender }: { tender: TenderRecord }) {
  const vault = useTendersStore((s) => s.vault)
  const focusRequirement = useTendersStore((s) => s.focusRequirement)
  const activeRequirementId = useTendersStore((s) => s.activeRequirementId)
  const updateRequirement = useTendersStore((s) => s.updateRequirement)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const groups = useMemo(() => {
    return CATEGORY_ORDER.map((cat) => ({
      category: cat,
      items: tender.requirements
        .filter((r) => r.category === cat)
        .sort((a, b) => a.order - b.order)
    })).filter((g) => g.items.length > 0)
  }, [tender.requirements])

  const toggle = (cat: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <h2 className="text-sm font-semibold text-slate-900">Compliance matrix</h2>
        <span className="text-xs text-slate-400">
          {tender.requirements.length} requirements · click to locate in PDF
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin bg-slate-50">
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.category)
          return (
            <section key={g.category}>
              <button
                type="button"
                onClick={() => toggle(g.category)}
                className="flex w-full items-center gap-2 border-b border-slate-200 bg-slate-100/80 px-4 py-2 text-left"
              >
                {isCollapsed ? <ChevronRight size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  {REQUIREMENT_CATEGORY_LABEL[g.category]}
                </span>
                <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500">
                  {g.items.length}
                </span>
              </button>
              {!isCollapsed && (
                <ul>
                  {g.items.map((r) => (
                    <li key={r.id} className={activeRowClass(r.id === activeRequirementId)}>
                      <RequirementRow
                        tenderId={tender.id}
                        req={r}
                        vault={vault}
                        onLocate={() => focusRequirement(r.id)}
                        onLink={(vaultDocId) =>
                          updateRequirement(tender.id, r.id, { linkedVaultDocId: vaultDocId })
                        }
                        onStatus={(status) => updateRequirement(tender.id, r.id, { status })}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function activeRowClass(active: boolean): string {
  return active ? 'bg-indigo-50/70 ring-1 ring-inset ring-indigo-300' : ''
}

function confidenceTone(confidence: number): 'green' | 'sky' | 'amber' {
  if (confidence >= 0.8) return 'green'
  if (confidence >= 0.6) return 'sky'
  return 'amber'
}

function RequirementRow({
  tenderId,
  req,
  vault,
  onLocate,
  onLink,
  onStatus
}: {
  tenderId: string
  req: RequirementRecord
  vault: { id: string; title: string }[]
  onLocate: () => void
  onLink: (vaultDocId: string | null) => void
  onStatus: (status: RequirementRecord['status']) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const linked = vault.find((v) => v.id === req.linkedVaultDocId) ?? null
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  tenderId

  return (
    <div className="border-b border-slate-100 px-4 py-3">
      {/* header row */}
      <div className="flex items-start gap-2">
        <span
          className={`mt-1.5 size-2 shrink-0 rounded-full ${
            req.status === 'FULFILLED'
              ? 'bg-emerald-500'
              : req.status === 'ACTION_REQUIRED'
                ? 'bg-amber-500'
                : req.status === 'OUTSTANDING'
                  ? 'bg-red-400'
                  : 'bg-slate-300'
          }`}
        />
        <button type="button" onClick={onLocate} className="min-w-0 flex-1 cursor-pointer text-left">
          <p className="text-[13px] font-semibold leading-snug text-slate-800 hover:text-indigo-700">
            {req.title}
          </p>
        </button>
        <button
          type="button"
          title="Show clause details"
          onClick={() => setExpanded((e) => !e)}
          className="shrink-0 cursor-pointer rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <ChevronDown size={14} className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'} />
        </button>
      </div>

      {/* badges */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-4">
        <Badge tone={RISK_TONE[req.riskLevel]}>{RISK_LABEL[req.riskLevel]}</Badge>
        <Badge tone={STATUS_TONE[req.status]}>{STATUS_LABEL[req.status]}</Badge>
        <button
          type="button"
          onClick={onLocate}
          className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
        >
          <MapPin size={11} /> p.{req.pageNumber}
        </button>
        {req.isMandatory && <Badge tone="violet">Mandatory</Badge>}
        {typeof req.confidence === 'number' && (
          <Badge tone={confidenceTone(req.confidence)}>
            {Math.round(req.confidence * 100)}% match confidence
          </Badge>
        )}
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-white p-3">
          {/* verbatim clause */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Verbatim clause (p.{req.pageNumber})
            </p>
            <blockquote className="mt-1 border-l-2 border-amber-300 pl-2.5 text-xs leading-relaxed text-slate-600 italic">
              “{req.verbatimClause}”
            </blockquote>
          </div>

          {/* additional clauses corroborating the same rule (multi-hit shredder) */}
          {req.additionalClauses && req.additionalClauses.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Also found ({req.additionalClauses.length})
              </p>
              <ul className="mt-1 space-y-1.5">
                {req.additionalClauses.map((c, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <span className="mt-0.5 shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                      p.{c.pageNumber}
                    </span>
                    <blockquote className="border-l-2 border-slate-200 pl-2 text-xs leading-relaxed text-slate-500 italic">
                      “{c.text}”
                    </blockquote>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* reason */}
          {req.reason && (
            <p className="text-xs text-slate-500">
              <span className="font-semibold text-slate-600">Gap analysis:</span> {req.reason}
            </p>
          )}
          {req.notes && <p className="text-xs text-slate-400">{req.notes}</p>}

          {/* linked vault doc */}
          {linked && (
            <p className="inline-flex items-center gap-1.5 text-xs text-slate-600">
              <Link2 size={12} className="text-indigo-500" />
              Linked: <span className="font-medium">{linked.title}</span>
            </p>
          )}

          {/* controls */}
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              <FileText size={12} />
              <select
                value={req.linkedVaultDocId ?? ''}
                onChange={(e) => onLink(e.target.value || null)}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
              >
                <option value="">— no vault doc —</option>
                {vault.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title}
                  </option>
                ))}
              </select>
            </label>
            <select
              value={req.status}
              onChange={(e) => onStatus(e.target.value as RequirementRecord['status'])}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
            >
              <option value="OUTSTANDING">Outstanding</option>
              <option value="ACTION_REQUIRED">Action required</option>
              <option value="FULFILLED">Fulfilled</option>
              <option value="NOT_APPLICABLE">N/A</option>
            </select>
          </div>

          {req.suggestedVaultDocIds.length > 0 && (
            <p className="text-[11px] text-slate-400">
              Suggested vault docs: {req.suggestedVaultDocIds.length} candidate
              {req.suggestedVaultDocIds.length === 1 ? '' : 's'} — ranked by keywords +
              doc-category agreement; low-confidence matches are never auto-linked
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function GapSummaryBar({ tender }: { tender: TenderRecord }) {
  const total = tender.requirements.length
  const fulfilled = tender.requirements.filter((r) => r.status === 'FULFILLED').length
  const action = tender.requirements.filter((r) => r.status === 'ACTION_REQUIRED').length
  const outstanding = tender.requirements.filter((r) => r.status === 'OUTSTANDING').length
  return (
    <div className="flex items-center gap-2">
      <Badge tone="green">{fulfilled} fulfilled</Badge>
      <Badge tone="amber">{action} action</Badge>
      <Badge tone="red">{outstanding} outstanding</Badge>
      <Badge tone="slate">{total} total</Badge>
    </div>
  )
}

export function ZoomControls() {
  const zoom = useTendersStore((s) => s.zoom)
  const setZoom = useTendersStore((s) => s.setZoom)
  const currentPage = useTendersStore((s) => s.currentPage)
  return (
    <div className="flex items-center gap-1.5">
      <span className="rounded bg-white px-2 py-1 text-xs font-medium text-slate-500 ring-1 ring-slate-200">
        p.{currentPage}
      </span>
      <Button size="sm" variant="default" onClick={() => setZoom(zoom - 0.2)} title="Zoom out">
        −
      </Button>
      <span className="w-12 text-center text-xs text-slate-500">{Math.round(zoom * 100)}%</span>
      <Button size="sm" variant="default" onClick={() => setZoom(zoom + 0.2)} title="Zoom in">
        +
      </Button>
    </div>
  )
}
