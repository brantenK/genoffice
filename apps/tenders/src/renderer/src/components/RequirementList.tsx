// Checklist pane: grouped compliance matrix rows. Clicking a row focuses the
// PDF viewer on the exact clause (list -> PDF); active state comes from the
// store so PDF-box clicks highlight the row back (PDF -> list).
//
// WP-6 adds the requirement half of the extraction review here: add, edit,
// remove and reclassify a requirement, verify a weak parser hit, and keep the
// originally extracted title after a correction. The row affordances the
// built-Electron specs rely on (`button[title="Show clause details"]`, the
// status `select` carrying a FULFILLED option, and `li` rows keyed by title)
// are deliberately unchanged.
import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  Link2,
  MapPin,
  Pencil,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import {
  CATEGORY_ORDER,
  REQUIREMENT_CATEGORY_LABEL,
  type RequirementCategory,
  type RequirementRecord,
  type RiskLevel,
  type TenderRecord,
} from '../../shared/types'
import { useTendersStore } from '../store'
import { REVIEW_CONFIDENCE_THRESHOLD } from './ExtractionReview'
import { Badge, Button, RISK_LABEL, RISK_TONE, STATUS_LABEL, STATUS_TONE } from './ui'

const RISK_ORDER: RiskLevel[] = ['CRITICAL_DISQUALIFIER', 'POINT_SCORED', 'INFORMATIONAL']

const CONTROL_CLASS =
  'rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] outline-none transition-colors hover:border-[var(--border-hover)] focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)]'

export function RequirementList({ tender }: { tender: TenderRecord }) {
  const vault = useTendersStore((s) => s.vault)
  const focusRequirement = useTendersStore((s) => s.focusRequirement)
  const activeRequirementId = useTendersStore((s) => s.activeRequirementId)
  const updateRequirement = useTendersStore((s) => s.updateRequirement)
  const addRequirement = useTendersStore((s) => s.addRequirement)
  const removeRequirement = useTendersStore((s) => s.removeRequirement)
  const updateRequirementReview = useTendersStore((s) => s.updateRequirementReview)
  const review = useTendersStore((s) => s.tenderReviews[tender.id])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)

  const groups = useMemo(() => {
    return CATEGORY_ORDER.map((cat) => ({
      category: cat,
      items: tender.requirements
        .filter((r) => r.category === cat)
        .sort((a, b) => a.order - b.order),
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

  const lowConfidenceCount = tender.requirements.filter(
    (r) =>
      typeof r.confidence === 'number' &&
      r.confidence < REVIEW_CONFIDENCE_THRESHOLD &&
      review?.requirements?.[r.id]?.state !== 'verified',
  ).length

  const nextOrder = tender.requirements.reduce((max, r) => Math.max(max, r.order), 0) + 10

  const handleAdd = (draft: NewRequirementDraft) => {
    const title = draft.title.trim()
    if (!title || tender.numPages < 1) return
    const requirement: RequirementRecord = {
      id: `req-manual-${Date.now()}`,
      ruleKey: 'manual',
      title,
      category: draft.category,
      isMandatory: draft.isMandatory,
      verbatimClause:
        draft.clause.trim() || 'Added during extraction review — no source clause was quoted.',
      pageNumber: Math.min(Math.max(1, draft.pageNumber), tender.numPages),
      boundingBox: { top: 0, left: 0, width: 0, height: 0 },
      riskLevel: draft.riskLevel,
      order: nextOrder,
      status: 'OUTSTANDING',
      linkedVaultDocId: null,
      reason: null,
      suggestedVaultDocIds: [],
    }
    addRequirement(tender.id, requirement)
    // A requirement the user typed themselves is already reviewed.
    updateRequirementReview(tender.id, requirement.id, { state: 'verified' })
    setAdding(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Sticky pane context header: matrix identity + live gap summary. */}
      <div
        data-testid="matrix-context-header"
        className="matrix-context-header flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2.5"
      >
        <h2 className="text-sm font-semibold text-[var(--text)]">Compliance matrix</h2>
        <GapSummaryBar tender={tender} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {lowConfidenceCount > 0 && (
            <Badge tone="amber">
              <AlertTriangle size={11} /> {lowConfidenceCount} to verify
            </Badge>
          )}
          <span className="text-xs text-[var(--text-tertiary)]">
            {tender.requirements.length} requirements · click to locate in PDF
          </span>
          <Button
            size="sm"
            variant="default"
            onClick={() => setAdding((value) => !value)}
            title="Add a requirement the parser missed"
          >
            {adding ? <X size={13} /> : <FilePlus2 size={13} />} Add requirement
          </Button>
        </div>
      </div>

      {adding && (
        <NewRequirementForm
          numPages={tender.numPages}
          defaultPage={1}
          onCancel={() => setAdding(false)}
          onSubmit={handleAdd}
        />
      )}

      {/* The scrollport owns the sticky group headers. At 200% text zoom a
          header can grow taller than the whole scrollport, which would leave
          no room for rows; `--matrix-group-header-max` caps it and the rows
          below stay reachable. */}
      <div className="matrix-scroll min-h-0 flex-1 overflow-y-auto scroll-thin bg-[var(--surface-subtle)]">
        {groups.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-[var(--text-tertiary)]">
            No requirements in the matrix yet. Add one above if the document demands it.
          </p>
        )}
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.category)
          return (
            <section key={g.category}>
              {/* Sticky group header keeps the current stage visible. */}
              <button
                type="button"
                onClick={() => toggle(g.category)}
                className="matrix-group-header sticky top-0 z-10 flex w-full items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-subtle)] px-4 py-2 text-left"
              >
                {isCollapsed ? (
                  <ChevronRight size={14} className="text-[var(--text-tertiary)]" />
                ) : (
                  <ChevronDown size={14} className="text-[var(--text-tertiary)]" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                  {REQUIREMENT_CATEGORY_LABEL[g.category]}
                </span>
                <span className="ml-auto rounded-full bg-[var(--surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-tertiary)]">
                  {g.items.length}
                </span>
              </button>
              {!isCollapsed && (
                <ul>
                  {g.items.map((r) => {
                    const active = r.id === activeRequirementId
                    return (
                      // Selection is exposed to AT via aria-current, not colour
                      // alone; the E2E can target `li[aria-current="true"]`.
                      <li
                        key={r.id}
                        aria-current={active ? 'true' : undefined}
                        className={activeRowClass(active)}
                      >
                        <RequirementRow
                          tenderId={tender.id}
                          req={r}
                          vault={vault}
                          reviewState={review?.requirements?.[r.id]}
                          maxOrder={nextOrder - 10}
                          onLocate={() => focusRequirement(r.id)}
                          onLink={(vaultDocId) =>
                            updateRequirement(tender.id, r.id, { linkedVaultDocId: vaultDocId })
                          }
                          onStatus={(status) => updateRequirement(tender.id, r.id, { status })}
                          onUpdate={(patch) => updateRequirement(tender.id, r.id, patch)}
                          onReviewPatch={(patch) => updateRequirementReview(tender.id, r.id, patch)}
                          onRemove={() => removeRequirement(tender.id, r.id)}
                        />
                      </li>
                    )
                  })}
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
  if (confidence >= REVIEW_CONFIDENCE_THRESHOLD) return 'sky'
  return 'amber'
}

interface NewRequirementDraft {
  title: string
  category: RequirementCategory
  riskLevel: RiskLevel
  isMandatory: boolean
  clause: string
  pageNumber: number
}

function NewRequirementForm({
  numPages,
  defaultPage,
  onCancel,
  onSubmit,
}: {
  numPages: number
  defaultPage: number
  onCancel: () => void
  onSubmit: (draft: NewRequirementDraft) => void
}) {
  const [draft, setDraft] = useState<NewRequirementDraft>({
    title: '',
    category: 'MANDATORY_STAGE_1',
    riskLevel: 'CRITICAL_DISQUALIFIER',
    isMandatory: true,
    clause: '',
    pageNumber: defaultPage,
  })

  const canSubmit = draft.title.trim().length > 0 && numPages > 0

  return (
    <form
      className="shrink-0 space-y-2 border-b border-[var(--border)] bg-[var(--surface-subtle)] px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit) onSubmit(draft)
      }}
    >
      <p className="text-[11px] font-semibold text-[var(--text)]">
        Add a requirement the parser missed
      </p>
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-[var(--text-secondary)]">
          Title
        </span>
        <input
          autoFocus
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          placeholder="e.g. Signed pricing schedule (Annexure B)"
          className={`w-full ${CONTROL_CLASS}`}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <label className="min-w-[180px] flex-1">
          <span className="mb-1 block text-[11px] font-medium text-[var(--text-secondary)]">
            Stage / category
          </span>
          <select
            value={draft.category}
            onChange={(event) =>
              setDraft({ ...draft, category: event.target.value as RequirementCategory })
            }
            className={`w-full ${CONTROL_CLASS}`}
          >
            {CATEGORY_ORDER.map((category) => (
              <option key={category} value={category}>
                {REQUIREMENT_CATEGORY_LABEL[category]}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-[140px] flex-1">
          <span className="mb-1 block text-[11px] font-medium text-[var(--text-secondary)]">
            Risk
          </span>
          <select
            value={draft.riskLevel}
            onChange={(event) => setDraft({ ...draft, riskLevel: event.target.value as RiskLevel })}
            className={`w-full ${CONTROL_CLASS}`}
          >
            {RISK_ORDER.map((risk) => (
              <option key={risk} value={risk}>
                {RISK_LABEL[risk]}
              </option>
            ))}
          </select>
        </label>
        <label className="w-[110px]">
          <span className="mb-1 block text-[11px] font-medium text-[var(--text-secondary)]">
            Source page
          </span>
          <input
            type="number"
            min={1}
            max={Math.max(1, numPages)}
            value={draft.pageNumber}
            onChange={(event) =>
              setDraft({ ...draft, pageNumber: Number(event.target.value) || 1 })
            }
            className={`w-full ${CONTROL_CLASS}`}
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-[var(--text-secondary)]">
          Quoted wording (optional)
        </span>
        <textarea
          rows={2}
          value={draft.clause}
          onChange={(event) => setDraft({ ...draft, clause: event.target.value })}
          placeholder="Paste the clause so the audit trail keeps the exact wording."
          className={`w-full resize-y ${CONTROL_CLASS}`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={draft.isMandatory}
            onChange={(event) => setDraft({ ...draft, isMandatory: event.target.checked })}
            className="size-3.5 cursor-pointer accent-[var(--accent)]"
          />
          Mandatory returnable
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => canSubmit && onSubmit(draft)}>
            <Check size={13} /> Add requirement
          </Button>
        </div>
      </div>
      {numPages < 1 && (
        <p className="text-[11px] font-medium text-[var(--danger)]">
          This tender has no pages, so a requirement cannot be anchored to one.
        </p>
      )}
    </form>
  )
}

function RequirementRow({
  tenderId,
  req,
  vault,
  reviewState,
  maxOrder,
  onLocate,
  onLink,
  onStatus,
  onUpdate,
  onReviewPatch,
  onRemove,
}: {
  tenderId: string
  req: RequirementRecord
  vault: { id: string; title: string }[]
  reviewState:
    | {
        state: 'unreviewed' | 'verified'
        originalTitle: string | null
        originalCategory: RequirementCategory | null
      }
    | undefined
  maxOrder: number
  onLocate: () => void
  onLink: (vaultDocId: string | null) => void
  onStatus: (status: RequirementRecord['status']) => void
  onUpdate: (patch: Partial<RequirementRecord>) => void
  onReviewPatch: (patch: {
    originalTitle?: string | null
    originalCategory?: RequirementCategory | null
    state?: 'unreviewed' | 'verified'
    correctedAt?: string | null
  }) => void
  onRemove: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(req.title)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const linked = vault.find((v) => v.id === req.linkedVaultDocId) ?? null
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  tenderId

  const lowConfidence =
    typeof req.confidence === 'number' && req.confidence < REVIEW_CONFIDENCE_THRESHOLD
  const verified = reviewState?.state === 'verified'
  const originalTitle =
    reviewState?.originalTitle && reviewState.originalTitle !== req.title
      ? reviewState.originalTitle
      : null
  const originalCategory =
    reviewState?.originalCategory && reviewState.originalCategory !== req.category
      ? reviewState.originalCategory
      : null

  const saveTitle = () => {
    const next = titleDraft.trim()
    if (!next) return
    if (next !== req.title) {
      onReviewPatch({
        originalTitle: reviewState?.originalTitle ?? req.title,
        correctedAt: new Date().toISOString(),
      })
      onUpdate({ title: next })
    }
    setEditingTitle(false)
  }

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
        <button
          type="button"
          onClick={onLocate}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <p className="text-[13px] font-semibold leading-snug text-[var(--text)] hover:text-[var(--accent-dark)]">
            {req.title}
          </p>
        </button>
        <button
          type="button"
          title="Show clause details"
          onClick={() => setExpanded((e) => !e)}
          className="shrink-0 cursor-pointer rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--hover)] hover:text-[var(--text-secondary)]"
        >
          <ChevronDown
            size={14}
            className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'}
          />
        </button>
      </div>

      {/* badges */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-4">
        <Badge tone={RISK_TONE[req.riskLevel]}>{RISK_LABEL[req.riskLevel]}</Badge>
        <Badge tone={STATUS_TONE[req.status]}>{STATUS_LABEL[req.status]}</Badge>
        <button
          type="button"
          onClick={onLocate}
          className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent-dark)]"
        >
          <MapPin size={11} /> p.{req.pageNumber}
        </button>
        {req.isMandatory && <Badge tone="violet">Mandatory</Badge>}
        {typeof req.confidence === 'number' && (
          <Badge tone={confidenceTone(req.confidence)}>
            {Math.round(req.confidence * 100)}% match confidence
          </Badge>
        )}
        {lowConfidence && !verified && (
          <button
            type="button"
            onClick={() => onReviewPatch({ state: 'verified' })}
            className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-[var(--warn-border)] bg-[var(--warn-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--warn)] hover:brightness-105"
            title="Confirm this requirement really belongs to the tender"
          >
            <AlertTriangle size={11} /> Verify
          </button>
        )}
        {verified && (
          <Badge tone="green">
            <BadgeCheck size={11} /> Verified
          </Badge>
        )}
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
          {/* verbatim clause */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
              Verbatim clause (p.{req.pageNumber})
            </p>
            <blockquote className="mt-1 border-l-2 border-[var(--warn-border)] pl-2.5 text-xs leading-relaxed text-[var(--text-secondary)] italic">
              “{req.verbatimClause}”
            </blockquote>
          </div>

          {/* additional clauses corroborating the same rule (multi-hit shredder) */}
          {req.additionalClauses && req.additionalClauses.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                Also found ({req.additionalClauses.length})
              </p>
              <ul className="mt-1 space-y-1.5">
                {req.additionalClauses.map((c, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <span className="mt-0.5 shrink-0 rounded bg-[var(--surface-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
                      p.{c.pageNumber}
                    </span>
                    <blockquote className="border-l-2 border-[var(--border)] pl-2 text-xs leading-relaxed text-[var(--text-secondary)] italic">
                      “{c.text}”
                    </blockquote>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* reason */}
          {req.reason && (
            <p className="text-xs text-[var(--text-secondary)]">
              <span className="font-semibold text-[var(--text)]">Gap analysis:</span> {req.reason}
            </p>
          )}
          {req.notes && <p className="text-xs text-[var(--text-tertiary)]">{req.notes}</p>}

          {/* linked vault doc */}
          {linked && (
            <p className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
              <Link2 size={12} className="text-[var(--accent)]" aria-hidden="true" />
              Linked: <span className="font-medium">{linked.title}</span>
            </p>
          )}

          {/* controls */}
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
              <FileText size={12} />
              <select
                value={req.linkedVaultDocId ?? ''}
                onChange={(e) => onLink(e.target.value || null)}
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)]"
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
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)]"
            >
              <option value="OUTSTANDING">Outstanding</option>
              <option value="ACTION_REQUIRED">Action required</option>
              <option value="FULFILLED">Fulfilled</option>
              <option value="NOT_APPLICABLE">N/A</option>
            </select>
          </div>

          {/* ── extraction-review controls ─────────────────────────────────── */}
          <div className="space-y-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] p-2.5">
            <p className="text-[11px] font-semibold text-[var(--text)]">Review this requirement</p>

            {/* title edit */}
            {editingTitle ? (
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-[160px] flex-1">
                  <span className="mb-1 block text-[11px] font-medium text-[var(--text-secondary)]">
                    Requirement title
                  </span>
                  <input
                    value={titleDraft}
                    autoFocus
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        saveTitle()
                      }
                      if (event.key === 'Escape') {
                        setTitleDraft(req.title)
                        setEditingTitle(false)
                      }
                    }}
                    className={`w-full ${CONTROL_CLASS}`}
                  />
                </label>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={saveTitle}
                  title="Save the corrected title"
                >
                  <Check size={12} /> Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setTitleDraft(req.title)
                    setEditingTitle(false)
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => {
                    setTitleDraft(req.title)
                    setEditingTitle(true)
                  }}
                  title="Correct the requirement title"
                >
                  <Pencil size={12} /> Edit title
                </Button>
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                  Stage
                  <select
                    value={req.category}
                    onChange={(event) => {
                      const category = event.target.value as RequirementCategory
                      onReviewPatch({
                        originalCategory: reviewState?.originalCategory ?? req.category,
                        correctedAt: new Date().toISOString(),
                      })
                      onUpdate({ category })
                    }}
                    className={CONTROL_CLASS}
                    title="Reclassify this requirement"
                  >
                    {CATEGORY_ORDER.map((category) => (
                      <option key={category} value={category}>
                        {REQUIREMENT_CATEGORY_LABEL[category]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                  Risk
                  <select
                    value={req.riskLevel}
                    onChange={(event) => onUpdate({ riskLevel: event.target.value as RiskLevel })}
                    className={CONTROL_CLASS}
                  >
                    {RISK_ORDER.map((risk) => (
                      <option key={risk} value={risk}>
                        {RISK_LABEL[risk]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={req.isMandatory}
                    onChange={(event) => onUpdate({ isMandatory: event.target.checked })}
                    className="size-3.5 cursor-pointer accent-[var(--accent)]"
                  />
                  Mandatory
                </label>
              </div>
            )}

            {/* provenance of a correction */}
            {originalTitle && (
              <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--text-secondary)]">
                <span className="font-medium">Original extracted title:</span>{' '}
                <span className="italic">{originalTitle}</span>
                <button
                  type="button"
                  onClick={() => {
                    setTitleDraft(originalTitle)
                    onUpdate({ title: originalTitle })
                    onReviewPatch({ originalTitle: null })
                  }}
                  className="ml-2 inline-flex cursor-pointer items-center gap-1 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 font-medium hover:border-[var(--accent)] hover:text-[var(--accent-dark)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
                >
                  <Undo2 size={10} /> Restore
                </button>
              </p>
            )}
            {originalCategory && (
              <p className="text-[11px] text-[var(--text-tertiary)]">
                Originally classified as {REQUIREMENT_CATEGORY_LABEL[originalCategory]}.
              </p>
            )}
            {typeof req.confidence === 'number' && (
              <p className="text-[11px] text-[var(--text-tertiary)]">
                Parser confidence {Math.round(req.confidence * 100)}% · source p.{req.pageNumber}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={verified ? 'default' : 'primary'}
                onClick={() => onReviewPatch({ state: verified ? 'unreviewed' : 'verified' })}
                title={
                  verified
                    ? 'Reopen this requirement for review'
                    : 'Confirm this requirement belongs to the tender'
                }
              >
                <BadgeCheck size={12} /> {verified ? 'Verified' : 'Mark verified'}
              </Button>
              {confirmRemove ? (
                <>
                  <Button size="sm" variant="danger" onClick={onRemove}>
                    <Trash2 size={12} /> Confirm remove
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                    Keep
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setConfirmRemove(true)}
                  title="Remove a requirement the parser invented"
                >
                  <Trash2 size={12} /> Remove
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onUpdate({ order: maxOrder + 10 })}
                title="Move this requirement to the end of its stage"
              >
                Move to end
              </Button>
            </div>
          </div>

          {req.suggestedVaultDocIds.length > 0 && (
            <p className="text-[11px] text-[var(--text-tertiary)]">
              Suggested vault docs: {req.suggestedVaultDocIds.length} candidate
              {req.suggestedVaultDocIds.length === 1 ? '' : 's'} — ranked by keywords + doc-category
              agreement; low-confidence matches are never auto-linked
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
      <span className="rounded bg-[var(--surface)] px-2 py-1 text-xs font-medium text-[var(--text-secondary)] ring-1 ring-[var(--border)]">
        p.{currentPage}
      </span>
      <Button size="sm" variant="default" onClick={() => setZoom(zoom - 0.2)} title="Zoom out">
        −
      </Button>
      <span className="w-12 text-center text-xs text-[var(--text-secondary)]">
        {Math.round(zoom * 100)}%
      </span>
      <Button size="sm" variant="default" onClick={() => setZoom(zoom + 0.2)} title="Zoom in">
        +
      </Button>
    </div>
  )
}
