import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Activity, CrmAuditEntry, Deal, DealStage } from '../../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import {
  CalendarIcon,
  CheckSquareIcon,
  ClockIcon,
  EditIcon,
  FileTextIcon,
  MailIcon,
  PhoneIcon,
  TrashIcon,
  XIcon,
} from './Icons'
import { useDialogA11y } from './useDialogA11y'

const STAGES: { key: DealStage; label: string; color: string }[] = [
  { key: 'lead', label: 'Lead', color: '#64748b' },
  { key: 'qualified', label: 'Qualified', color: '#0284c7' },
  { key: 'proposal', label: 'Proposal', color: '#d97706' },
  { key: 'negotiation', label: 'Negotiation', color: '#7c3aed' },
  { key: 'won', label: 'Closed Won', color: '#059669' },
  { key: 'lost', label: 'Closed Lost', color: '#dc2626' },
]

const ACTIVITY_TYPES: Activity['type'][] = ['note', 'call', 'meeting', 'email', 'task']

function formatDate(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatDateTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
}

function formatAge(value?: string, suffix = '') {
  if (!value) return '—'
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return '—'
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000))
  return `${days}d${suffix}`
}

function ActivityIcon({ type }: { type: Activity['type'] }) {
  if (type === 'call') return <PhoneIcon size={14} />
  if (type === 'email') return <MailIcon size={14} />
  if (type === 'meeting') return <CalendarIcon size={14} />
  if (type === 'task') return <CheckSquareIcon size={14} />
  return <FileTextIcon size={14} />
}

export function DealDetail({
  deal,
  onClose,
  onEditDeal,
  onDeleteDeal,
  onGenerateProposal,
}: {
  deal: Deal
  onClose: () => void
  onEditDeal: (deal: Deal) => void
  onDeleteDeal: (id: string) => void
  onGenerateProposal: (dealId: string) => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstInvalidRef = useRef<HTMLInputElement>(null)
  const [activities, setActivities] = useState<Activity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<Activity['type']>('note')
  const [dueDate, setDueDate] = useState('')
  const [titleError, setTitleError] = useState<string | null>(null)
  const [deleteActivity, setDeleteActivity] = useState<Activity | null>(null)
  const [editingActivityId, setEditingActivityId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editDueDate, setEditDueDate] = useState('')
  const [editTitleError, setEditTitleError] = useState<string | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [discardDraftOpen, setDiscardDraftOpen] = useState(false)
  const [discardTarget, setDiscardTarget] = useState<'drawer' | 'edit' | null>(null)
  const [auditEntries, setAuditEntries] = useState<CrmAuditEntry[]>([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)
  const stage = useMemo(
    () => STAGES.find((item) => item.key === deal.stage) || STAGES[0],
    [deal.stage],
  )
  const apiAvailable = Boolean(window.crmApi)

  const refreshAudit = useCallback(async () => {
    if (!window.crmApi) return
    setAuditLoading(true)
    setAuditError(null)
    try {
      const entries = await window.crmApi.listAudit({ dealId: deal.id, limit: 20 })
      setAuditEntries([...entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)))
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : 'Could not load history')
    } finally {
      setAuditLoading(false)
    }
  }, [deal.id])

  const refreshActivities = useCallback(async () => {
    if (!window.crmApi) {
      setActivities([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const items = await window.crmApi.listActivities({ dealId: deal.id })
      setActivities([...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load activity')
    } finally {
      setLoading(false)
    }
  }, [deal.id])

  useEffect(() => {
    void refreshActivities()
  }, [refreshActivities])

  useEffect(() => {
    if (apiAvailable) void refreshAudit()
  }, [activities, apiAvailable, refreshAudit])

  const addDraftDirty = Boolean(title || description || dueDate || type !== 'note')
  const editingActivity = editingActivityId
    ? activities.find((activity) => activity.id === editingActivityId)
    : undefined
  const editDraftDirty = Boolean(
    editingActivity &&
    (editTitle !== editingActivity.title ||
      editDescription !== editingActivity.description ||
      editDueDate !== (editingActivity.dueDate || '')),
  )
  const hasActivityDraft = addDraftDirty || editDraftDirty
  const close = useCallback(() => {
    if (hasActivityDraft) {
      setDiscardTarget('drawer')
      setDiscardDraftOpen(true)
      return
    }
    onClose()
  }, [hasActivityDraft, onClose])
  useDialogA11y(dialogRef, close)

  const startEdit = (activity: Activity) => {
    setEditingActivityId(activity.id)
    setEditTitle(activity.title)
    setEditDescription(activity.description)
    setEditDueDate(activity.dueDate || '')
    setEditTitleError(null)
  }

  const finishEdit = () => {
    setEditingActivityId(null)
    setEditTitleError(null)
  }

  const cancelEdit = () => {
    if (editDraftDirty) {
      setDiscardTarget('edit')
      setDiscardDraftOpen(true)
      return
    }
    finishEdit()
  }

  const submitEdit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editingActivityId) return
    if (!editTitle.trim()) {
      setEditTitleError('Enter an activity title')
      return
    }
    if (!window.crmApi) return
    setEditSaving(true)
    setEditTitleError(null)
    try {
      await window.crmApi.updateActivity(editingActivityId, {
        title: editTitle.trim(),
        description: editDescription.trim(),
        dueDate: editDueDate || undefined,
      })
      finishEdit()
      await refreshActivities()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update activity')
    } finally {
      setEditSaving(false)
    }
  }

  const submitActivity = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!title.trim()) {
      setTitleError('Enter an activity title')
      requestAnimationFrame(() => firstInvalidRef.current?.focus())
      return
    }
    if (!window.crmApi) return
    setSaving(true)
    setTitleError(null)
    try {
      await window.crmApi.addActivity({
        dealId: deal.id,
        type,
        title: title.trim(),
        description: description.trim(),
        ...(dueDate ? { dueDate } : {}),
      })
      setTitle('')
      setDescription('')
      setDueDate('')
      setType('note')
      await refreshActivities()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save activity')
    } finally {
      setSaving(false)
    }
  }

  const toggleActivity = async (id: string) => {
    if (!window.crmApi) return
    try {
      await window.crmApi.toggleActivity(id)
      await refreshActivities()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update activity')
    }
  }

  const removeActivity = async () => {
    if (!deleteActivity || !window.crmApi) return
    try {
      await window.crmApi.deleteActivity(deleteActivity.id)
      setDeleteActivity(null)
      await refreshActivities()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete activity')
      setDeleteActivity(null)
    }
  }

  const discardActivityDraft = () => {
    setTitle('')
    setDescription('')
    setDueDate('')
    setType('note')
    finishEdit()
    setDiscardDraftOpen(false)
    const target = discardTarget
    setDiscardTarget(null)
    if (target === 'drawer') onClose()
  }

  return (
    <>
      <div className="crm-detail-backdrop" onClick={close}>
        <aside
          ref={dialogRef}
          className="crm-detail-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="crm-deal-detail-title"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="crm-detail-header">
            <div className="crm-detail-heading">
              <div className="crm-detail-eyebrow">Opportunity</div>
              <h2 id="crm-deal-detail-title">{deal.name}</h2>
              <div className="crm-detail-company">{deal.companyName || 'No company'}</div>
            </div>
            <button
              type="button"
              className="crm-modal-close-btn"
              aria-label="Close dialog"
              onClick={close}
            >
              <XIcon size={16} />
            </button>
          </header>
          <div className="crm-detail-actions">
            <span
              className="crm-detail-stage"
              style={{ '--stage-color': stage.color } as React.CSSProperties}
            >
              {stage.label}
            </span>
            <div className="crm-detail-action-group">
              <button
                type="button"
                className="crm-btn"
                onClick={() => {
                  onClose()
                  onEditDeal(deal)
                }}
              >
                <EditIcon size={13} /> Edit
              </button>
              <button
                type="button"
                className="crm-btn"
                onClick={() => {
                  onGenerateProposal(deal.id)
                  void refreshAudit()
                }}
              >
                <FileTextIcon size={13} /> Create Proposal
              </button>
              <button
                type="button"
                className="crm-btn crm-detail-danger-btn"
                onClick={() => {
                  onClose()
                  onDeleteDeal(deal.id)
                }}
              >
                <TrashIcon size={13} /> Delete
              </button>
            </div>
          </div>
          <div className="crm-detail-body">
            <section className="crm-detail-summary" aria-label="Opportunity summary">
              <div>
                <span>Amount</span>
                <strong>${(deal.amount || 0).toLocaleString()}</strong>
              </div>
              <div>
                <span>Stage</span>
                <strong>{stage.label}</strong>
              </div>
              <div>
                <span>Expected close</span>
                <strong>{formatDate(deal.expectedCloseDate)}</strong>
              </div>
              <div>
                <span>Contact</span>
                <strong>{deal.contactName || '—'}</strong>
              </div>
              <div>
                <span>Owner</span>
                <strong>{deal.owner || '—'}</strong>
              </div>
              <div>
                <span>Next step</span>
                <strong>{deal.nextStep || '—'}</strong>
              </div>
              <div>
                <span>Age</span>
                <strong>{formatAge(deal.createdAt)}</strong>
              </div>
              <div>
                <span>Last activity</span>
                <strong>{formatAge(activities[0]?.createdAt, ' ago')}</strong>
              </div>
              <div>
                <span>Created</span>
                <strong>{formatDate(deal.createdAt)}</strong>
              </div>
              <div>
                <span>Updated</span>
                <strong>{formatDate(deal.updatedAt)}</strong>
              </div>
            </section>
            {deal.notes && (
              <section className="crm-detail-notes">
                <h3>Notes</h3>
                <p>{deal.notes}</p>
              </section>
            )}
            <section className="crm-detail-activity">
              <div className="crm-detail-section-heading">
                <div>
                  <h3>Activity</h3>
                  <span>
                    {activities.length} {activities.length === 1 ? 'item' : 'items'}
                  </span>
                </div>
              </div>
              {!apiAvailable && (
                <p className="crm-detail-hint">Activity is unavailable in preview mode.</p>
              )}
              {loading ? (
                <div className="crm-detail-state">Loading activity…</div>
              ) : error ? (
                <div className="crm-detail-state crm-detail-error">
                  <p>{error}</p>
                  <button
                    type="button"
                    className="crm-btn"
                    onClick={() => void refreshActivities()}
                  >
                    Retry
                  </button>
                </div>
              ) : activities.length === 0 ? (
                <div className="crm-detail-state">
                  No activity yet — log a call, meeting, email, or task.
                </div>
              ) : (
                <div className="crm-activity-list">
                  {activities.map((activity) => (
                    <article
                      className={`crm-activity-item ${activity.completed ? 'completed' : ''}`}
                      key={activity.id}
                    >
                      <div className="crm-activity-icon">
                        <ActivityIcon type={activity.type} />
                      </div>
                      <div className="crm-activity-content">
                        {editingActivityId === activity.id ? (
                          <form
                            className="crm-activity-edit-form"
                            onSubmit={(event) => void submitEdit(event)}
                          >
                            <div className="crm-activity-topline">
                              <div>
                                <span className="crm-activity-type">{activity.type}</span>
                                <span className="crm-activity-edit-label">Editing activity</span>
                              </div>
                              <button
                                type="button"
                                className="crm-icon-action-btn"
                                aria-label="Cancel editing"
                                onClick={cancelEdit}
                                disabled={editSaving}
                              >
                                <XIcon size={13} />
                              </button>
                            </div>
                            <div className="crm-form-group">
                              <label
                                className="crm-form-label"
                                htmlFor={`crm-edit-activity-title-${activity.id}`}
                              >
                                Title
                              </label>
                              <input
                                id={`crm-edit-activity-title-${activity.id}`}
                                className="crm-form-input"
                                value={editTitle}
                                onChange={(event) => {
                                  setEditTitle(event.target.value)
                                  if (editTitleError) setEditTitleError(null)
                                }}
                                disabled={editSaving}
                                autoFocus
                                aria-invalid={editTitleError ? true : undefined}
                                aria-describedby={
                                  editTitleError
                                    ? `crm-edit-activity-title-error-${activity.id}`
                                    : undefined
                                }
                              />
                              {editTitleError && (
                                <div
                                  id={`crm-edit-activity-title-error-${activity.id}`}
                                  className="crm-field-error"
                                >
                                  {editTitleError}
                                </div>
                              )}
                            </div>
                            <div className="crm-form-group">
                              <label
                                className="crm-form-label"
                                htmlFor={`crm-edit-activity-description-${activity.id}`}
                              >
                                Description <span>(optional)</span>
                              </label>
                              <textarea
                                id={`crm-edit-activity-description-${activity.id}`}
                                className="crm-form-textarea"
                                value={editDescription}
                                onChange={(event) => setEditDescription(event.target.value)}
                                disabled={editSaving}
                                rows={3}
                              />
                            </div>
                            <div className="crm-form-group">
                              <label
                                className="crm-form-label"
                                htmlFor={`crm-edit-activity-due-${activity.id}`}
                              >
                                Due date <span>(optional)</span>
                              </label>
                              <input
                                id={`crm-edit-activity-due-${activity.id}`}
                                type="date"
                                className="crm-form-input"
                                value={editDueDate}
                                onChange={(event) => setEditDueDate(event.target.value)}
                                disabled={editSaving}
                              />
                            </div>
                            <div className="crm-activity-edit-actions">
                              <button
                                type="button"
                                className="crm-btn"
                                onClick={cancelEdit}
                                disabled={editSaving}
                              >
                                Cancel
                              </button>
                              <button
                                type="submit"
                                className="crm-btn crm-btn-primary"
                                disabled={editSaving}
                              >
                                {editSaving ? 'Saving…' : 'Save'}
                              </button>
                            </div>
                          </form>
                        ) : (
                          <>
                            <div className="crm-activity-topline">
                              <div>
                                <span className="crm-activity-type">{activity.type}</span>
                                <h4>{activity.title}</h4>
                              </div>
                              <div className="crm-activity-item-actions">
                                <button
                                  type="button"
                                  className="crm-icon-action-btn"
                                  aria-label={`Edit ${activity.title}`}
                                  onClick={() => startEdit(activity)}
                                >
                                  <EditIcon size={13} />
                                </button>
                                <button
                                  type="button"
                                  className="crm-icon-action-btn delete"
                                  aria-label={`Delete ${activity.title}`}
                                  onClick={() => setDeleteActivity(activity)}
                                >
                                  <TrashIcon size={13} />
                                </button>
                              </div>
                            </div>
                            {activity.description && <p>{activity.description}</p>}
                            <div className="crm-activity-meta">
                              <span>
                                <ClockIcon size={12} /> {formatDate(activity.createdAt)}
                              </span>
                              {activity.dueDate && (
                                <span>
                                  <CalendarIcon size={12} /> Due {formatDate(activity.dueDate)}
                                </span>
                              )}
                              <label className="crm-activity-complete">
                                <input
                                  type="checkbox"
                                  checked={Boolean(activity.completed)}
                                  onChange={() => void toggleActivity(activity.id)}
                                />{' '}
                                <span>{activity.completed ? 'Completed' : 'Mark complete'}</span>
                              </label>
                            </div>
                          </>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
            {apiAvailable && (
              <section className="crm-detail-history" aria-labelledby="crm-deal-history-title">
                <div className="crm-detail-section-heading">
                  <div>
                    <h3 id="crm-deal-history-title">History</h3>
                    <span>Audit trail</span>
                  </div>
                </div>
                {auditLoading ? (
                  <div className="crm-detail-state">Loading history…</div>
                ) : auditError ? (
                  <div className="crm-detail-state crm-detail-error">
                    <p>{auditError}</p>
                    <button type="button" className="crm-btn" onClick={() => void refreshAudit()}>
                      Retry
                    </button>
                  </div>
                ) : auditEntries.length === 0 ? (
                  <div className="crm-detail-state">No history yet.</div>
                ) : (
                  <div className="crm-history-list">
                    {auditEntries.map((entry) => (
                      <article className="crm-history-item" key={entry.id}>
                        <div className="crm-history-action">{entry.action.replace('-', ' ')}</div>
                        <div className="crm-history-content">
                          <p>{entry.summary}</p>
                          <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}
            <section className="crm-detail-add-activity">
              <h3>Log activity</h3>
              <form onSubmit={(event) => void submitActivity(event)}>
                <div className="crm-form-row">
                  <div className="crm-form-group">
                    <label className="crm-form-label" htmlFor="crm-activity-type">
                      Type
                    </label>
                    <select
                      id="crm-activity-type"
                      className="crm-form-select"
                      value={type}
                      onChange={(event) => setType(event.target.value as Activity['type'])}
                      disabled={!apiAvailable || saving}
                    >
                      {ACTIVITY_TYPES.map((item) => (
                        <option key={item} value={item}>
                          {item[0].toUpperCase() + item.slice(1)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="crm-form-group">
                    <label className="crm-form-label" htmlFor="crm-activity-due">
                      Due date <span>(optional)</span>
                    </label>
                    <input
                      id="crm-activity-due"
                      type="date"
                      className="crm-form-input"
                      value={dueDate}
                      onChange={(event) => setDueDate(event.target.value)}
                      disabled={!apiAvailable || saving}
                    />
                  </div>
                </div>
                <div className="crm-form-group">
                  <label className="crm-form-label" htmlFor="crm-activity-title">
                    Title
                  </label>
                  <input
                    id="crm-activity-title"
                    ref={firstInvalidRef}
                    className="crm-form-input"
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value)
                      if (titleError) setTitleError(null)
                    }}
                    disabled={!apiAvailable || saving}
                    aria-invalid={titleError ? true : undefined}
                    aria-describedby={titleError ? 'crm-activity-title-error' : undefined}
                    placeholder="e.g. Follow up on security review"
                  />
                  {titleError && (
                    <div id="crm-activity-title-error" className="crm-field-error">
                      {titleError}
                    </div>
                  )}
                </div>
                <div className="crm-form-group">
                  <label className="crm-form-label" htmlFor="crm-activity-description">
                    Description <span>(optional)</span>
                  </label>
                  <textarea
                    id="crm-activity-description"
                    className="crm-form-textarea"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    disabled={!apiAvailable || saving}
                    placeholder="Add useful context for the next person."
                    rows={3}
                  />
                </div>
                <button
                  type="submit"
                  className="crm-btn crm-btn-primary"
                  disabled={!apiAvailable || saving}
                >
                  {saving ? 'Saving activity…' : 'Log activity'}
                </button>
              </form>
            </section>
          </div>
        </aside>
      </div>
      {deleteActivity && (
        <ConfirmDialog
          title="Delete activity?"
          message="This activity will be permanently removed."
          confirmLabel="Delete"
          onCancel={() => setDeleteActivity(null)}
          onConfirm={() => void removeActivity()}
        />
      )}
      {discardDraftOpen && (
        <ConfirmDialog
          title="Discard activity draft?"
          message="Your unsaved activity will be lost."
          confirmLabel="Discard"
          onCancel={() => {
            setDiscardDraftOpen(false)
            setDiscardTarget(null)
          }}
          onConfirm={discardActivityDraft}
        />
      )}
    </>
  )
}
