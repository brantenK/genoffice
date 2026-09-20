// Documents: company vault as a proper document manager.
// Grid view with category filters, health badges, metadata, and a real
// upload flow. Uploaded PDFs are persisted to managed files on disk (main owns
// the move to `.trash/`); a failed save never falls back to a session blob URL.
// Deleting is a recoverable soft-delete, and a Check-files action reconciles
// metadata against disk on demand.
import { useMemo, useRef, useState } from 'react'
import {
  Calendar,
  CheckCircle2,
  ExternalLink,
  FileText,
  Filter,
  Paperclip,
  Pencil,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react'
import type { DocCategory, DocHealth, VaultDoc } from '../../../shared/types'
import type { DocumentReconciliation } from '../../../../shared/tenders-persistence'
import { DOC_CATEGORY_LABEL } from '../../../shared/types'
import { assessDocHealth, healthSummary, POLICE_STAMP_WINDOW_DAYS } from '../../gap'
import { newVaultDocId, useTendersStore } from '../../store'
import { Badge, Button } from '../ui'
import { Dialog } from '../Dialog'
import { TrashDrawer } from '../TrashDrawer'

const HEALTH_TONE: Record<DocHealth, 'green' | 'red' | 'amber' | 'slate'> = {
  VALID: 'green',
  EXPIRED: 'red',
  STALE_CERTIFICATION: 'amber',
  NO_EXPIRY_INFO: 'slate',
}

const HEALTH_LABEL: Record<DocHealth, string> = {
  VALID: 'Valid',
  EXPIRED: 'Expired',
  STALE_CERTIFICATION: 'Stale stamp',
  NO_EXPIRY_INFO: 'No expiry info',
}

// Category glyphs sit on the card surface. They are decorative (the category
// name is always shown as text beside them), so they only need 3:1; the 700
// palette steps clear that in both themes and stay distinguishable.
const CAT_ICON: Record<DocCategory, React.ReactNode> = {
  COMPLIANCE: <ShieldAlert size={16} className="text-[var(--accent-dark)]" aria-hidden="true" />,
  FINANCIAL: <CheckCircle2 size={16} className="text-[var(--success)]" aria-hidden="true" />,
  TECHNICAL: <FileText size={16} className="text-[var(--info)]" aria-hidden="true" />,
  GOVERNANCE: <FileText size={16} className="text-[var(--accent-dark)]" aria-hidden="true" />,
  CV: <FileText size={16} className="text-[var(--warn)]" aria-hidden="true" />,
}

const ALL_CATS: DocCategory[] = ['COMPLIANCE', 'FINANCIAL', 'GOVERNANCE', 'TECHNICAL', 'CV']

/** Data captured by the upload / edit form. */
interface VaultFormData {
  title: string
  category: DocCategory
  issueDate: string | null
  expiryDate: string | null
  isCertified: boolean
  certifiedDate: string | null
  note: string
  file: File | null
}

export function DocumentsPage() {
  const vault = useTendersStore((s) => s.vault)
  const addVaultDoc = useTendersStore((s) => s.addVaultDoc)
  const updateVaultDoc = useTendersStore((s) => s.updateVaultDoc)
  const removeVaultDoc = useTendersStore((s) => s.removeVaultDoc)

  const [catFilter, setCatFilter] = useState<DocCategory | 'ALL'>('ALL')
  const [healthFilter, setHealthFilter] = useState<DocHealth | 'ALL'>('ALL')
  const [selected, setSelected] = useState<VaultDoc | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editDoc, setEditDoc] = useState<VaultDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState<string | null>(null)
  const [reconcile, setReconcile] = useState<DocumentReconciliation | null>(null)
  const [reconcileBusy, setReconcileBusy] = useState(false)
  // Soft-delete confirmation is an in-app dialog (native window.confirm is not
  // accepted by the durability E2E spec). Escape/backdrop/Cancel are no-ops.
  const [pendingDelete, setPendingDelete] = useState<VaultDoc | null>(null)
  // Save failures get their own alert so the E2E spec can target them precisely
  // (documents-save-error) without catching unrelated delete/reconcile errors.
  const [saveError, setSaveError] = useState<string | null>(null)

  /** A workspace-relative managed file path (not a blob/http/demo URL). */
  const managedPath = (url: string | null): string | null => {
    if (!url) return null
    if (url.startsWith('blob:') || url.startsWith('http') || url.startsWith('/demo')) return null
    return url
  }

  const runReconcile = async () => {
    setError(null)
    setNotice(null)
    if (!window.tendersApi?.reconcileDocuments) {
      setError('Document reconciliation is unavailable in this build.')
      return
    }
    setReconcileBusy(true)
    try {
      const res = await window.tendersApi.reconcileDocuments()
      if (!res?.ok || !res.reconciliation) {
        setError(res?.error || 'Could not reconcile documents.')
        return
      }
      setReconcile(res.reconciliation)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setReconcileBusy(false)
    }
  }

  const openCreate = () => {
    setEditDoc(null)
    setError(null)
    setSaveError(null)
    setFormOpen(true)
  }

  const openEdit = (d: VaultDoc) => {
    setEditDoc(d)
    setError(null)
    setSaveError(null)
    setFormOpen(true)
  }

  // Opening the confirmation is inert; nothing is removed until the user
  // confirms inside the in-app dialog.
  const requestDelete = (d: VaultDoc) => {
    setError(null)
    setNotice(null)
    setPendingDelete(d)
  }

  const cancelDelete = () => setPendingDelete(null)

  const confirmDelete = () => {
    const d = pendingDelete
    setPendingDelete(null)
    if (d) void performDelete(d)
  }

  const performDelete = async (d: VaultDoc) => {
    setError(null)
    setNotice(null)
    const storedPath = managedPath(d.fileUrl)

    if (storedPath) {
      if (!window.tendersApi?.deleteDocument) {
        setError('Document deletion is unavailable in this build; nothing was removed.')
        return
      }
      setDeleteBusy(d.id)
      try {
        const res = await window.tendersApi.deleteDocument({ storedPath })
        if (!res?.ok) {
          // Fail closed: the metadata is kept when the managed file could not be
          // handled, so a file is never orphaned silently.
          setError(res?.error || 'Could not move the file to Trash; nothing was removed.')
          return
        }
        const notes: string[] = [...(res.warnings ?? [])]
        if (res.links && res.links.length > 0) {
          notes.push(
            `Referenced by ${res.links.length} record(s): ${res.links
              .map((link) => `${link.kind} “${link.label}”`)
              .join(', ')}.`,
          )
        }
        if (res.trashId) notes.push('The file was moved to Trash (recoverable).')
        if (notes.length > 0) setNotice(notes.join(' '))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return
      } finally {
        setDeleteBusy(null)
      }
    }

    if (d.fileUrl?.startsWith('blob:')) URL.revokeObjectURL(d.fileUrl)
    removeVaultDoc(d.id)
    setSelected(null)
  }

  const handleSubmit = async (data: VaultFormData) => {
    setError(null)
    setSaveError(null)
    let savedPath: string | null = null
    if (data.file && typeof window !== 'undefined' && !window.tendersApi?.saveDocument) {
      // Never present a session blob as durable: without the managed-file bridge
      // the upload cannot be persisted, so fail closed and say so.
      setSaveError('Saving documents to disk is unavailable in this build. Nothing was added.')
      return
    }
    if (data.file && typeof window !== 'undefined' && window.tendersApi?.saveDocument) {
      try {
        const buffer = await data.file.arrayBuffer()
        const saveRes = await window.tendersApi.saveDocument({
          fileName: data.file.name,
          buffer,
          category: 'vault',
        })
        if (saveRes?.ok && saveRes.storedPath) {
          savedPath = saveRes.storedPath
        } else {
          // Fail closed and surface the reason: never silently fall back to a
          // session blob URL that would disappear on restart.
          setSaveError(saveRes?.error || 'Could not save the document to disk. Nothing was added.')
          return
        }
      } catch (err) {
        console.warn('tenders: failed to persist vault document via IPC', err)
        setSaveError(
          err instanceof Error
            ? `Could not save the document to disk: ${err.message}`
            : 'Could not save the document to disk. Nothing was added.',
        )
        return
      }
    }

    if (editDoc) {
      // ── edit / re-attach an existing document ───────────────────────────
      const metadata: Record<string, string> = { ...editDoc.metadata }
      if (data.note) metadata['Note'] = data.note
      else delete metadata['Note']
      if (data.file) metadata['File name'] = data.file.name
      if (editDoc.fileUrl?.startsWith('blob:')) URL.revokeObjectURL(editDoc.fileUrl)
      const fileUrl = data.file ? savedPath : editDoc.fileUrl
      const updated: VaultDoc = {
        ...editDoc,
        title: data.title,
        category: data.category,
        issueDate: data.issueDate,
        expiryDate: data.expiryDate,
        isCertified: data.isCertified,
        certifiedDate: data.certifiedDate,
        fileUrl,
        metadata,
      }
      updateVaultDoc(editDoc.id, updated)
      setSelected(updated)
    } else {
      // ── brand new uploaded document ────────────────────────────────────
      const metadata: Record<string, string> = {}
      if (data.file) metadata['File name'] = data.file.name
      if (data.note) metadata['Note'] = data.note
      const fileUrl = data.file ? savedPath : null
      addVaultDoc({
        id: newVaultDocId(),
        title: data.title,
        category: data.category,
        fileUrl,
        issueDate: data.issueDate,
        expiryDate: data.expiryDate,
        isCertified: data.isCertified,
        certifiedDate: data.certifiedDate,
        metadata,
      })
    }
    setFormOpen(false)
    setEditDoc(null)
  }

  const docs = useMemo(
    () =>
      vault
        .map((d) => ({ doc: d, rep: assessDocHealth(d) }))
        .filter((r) => catFilter === 'ALL' || r.doc.category === catFilter)
        .filter((r) => healthFilter === 'ALL' || r.rep.health === healthFilter)
        .sort((a, b) => {
          // expired first, then stale, then no-expiry, then valid
          const order: Record<DocHealth, number> = {
            EXPIRED: 0,
            STALE_CERTIFICATION: 1,
            NO_EXPIRY_INFO: 2,
            VALID: 3,
          }
          return order[a.rep.health] - order[b.rep.health]
        }),
    [vault, catFilter, healthFilter],
  )

  const allReports = useMemo(() => vault.map((d) => ({ doc: d, rep: assessDocHealth(d) })), [vault])
  const expiredCount = allReports.filter((r) => r.rep.health === 'EXPIRED').length
  const staleCount = allReports.filter((r) => r.rep.health === 'STALE_CERTIFICATION').length

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      {/* header */}
      <div className="border-b border-[var(--border)] bg-[var(--surface)] px-8 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-[var(--text)]">Documents</h1>
            <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
              Company compliance vault — {vault.length} documents on record
              {(expiredCount > 0 || staleCount > 0) && (
                <span className="ml-2 inline-flex items-center gap-1 text-[var(--warn)]">
                  <XCircle size={13} aria-hidden="true" /> {expiredCount + staleCount} need{' '}
                  {expiredCount + staleCount === 1 ? 's' : ''} attention
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="documents-check-files"
              onClick={() => void runReconcile()}
              disabled={reconcileBusy}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium text-[var(--text-secondary)] shadow-sm transition-colors hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw size={15} aria-hidden="true" /> Check files
            </button>
            <span data-testid="documents-open-trash" className="inline-flex">
              <button
                type="button"
                data-testid="documents-trash-button"
                onClick={() => setTrashOpen(true)}
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium text-[var(--text-secondary)] shadow-sm transition-colors hover:bg-[var(--hover)]"
              >
                <Trash2 size={15} aria-hidden="true" /> Trash
              </button>
            </span>
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] shadow-sm transition-colors hover:bg-[var(--hover)]"
            >
              <Upload size={15} /> Upload document
            </button>
          </div>
        </div>
      </div>

      {saveError && (
        <div
          role="alert"
          data-testid="documents-save-error"
          className="mx-8 mt-4 flex items-start gap-2 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger-text)]"
        >
          <XCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{saveError}</span>
          <button
            type="button"
            onClick={() => setSaveError(null)}
            className="shrink-0 cursor-pointer text-xs font-semibold text-[var(--danger-text)] hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mx-8 mt-4 flex items-start gap-2 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger-text)]"
        >
          <XCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 cursor-pointer text-xs font-semibold text-[var(--danger-text)] hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {notice && (
        <div
          role="status"
          data-testid="documents-notice"
          className="mx-8 mt-4 flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] px-4 py-3 text-sm text-[var(--text-secondary)]"
        >
          <ShieldAlert
            size={15}
            className="mt-0.5 shrink-0 text-[var(--warn)]"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="shrink-0 cursor-pointer text-xs font-semibold text-[var(--text-secondary)] hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {reconcile && (
        <div
          role="status"
          data-testid="documents-reconcile"
          className="mx-8 mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] px-4 py-3 text-sm text-[var(--text-secondary)]"
        >
          <p className="font-semibold text-[var(--text)]">Document check</p>
          <p className="mt-1 text-[12px]">
            {reconcile.activeCount} tracked file(s) · {reconcile.missing.length} missing ·{' '}
            {reconcile.orphaned.length} orphaned on disk · {reconcile.trashed.length} in Trash.
          </p>
          {reconcile.missing.length > 0 && (
            <p className="mt-1 text-[12px] text-[var(--warn)]">
              Missing: {reconcile.missing.map((entry) => entry.fileName).join(', ')}. Re-attach the
              file to restore it.
            </p>
          )}
          {reconcile.orphaned.length > 0 && (
            <p className="mt-1 text-[12px]">
              {reconcile.orphaned.length} file(s) on disk have no metadata record; nothing was
              deleted automatically.
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void runReconcile()}
              className="cursor-pointer text-[12px] font-semibold text-[var(--accent-dark)] hover:underline"
            >
              Re-check
            </button>
            <button
              type="button"
              onClick={() => setTrashOpen(true)}
              className="cursor-pointer text-[12px] font-semibold text-[var(--accent-dark)] hover:underline"
            >
              Review Trash
            </button>
            <button
              type="button"
              onClick={() => setReconcile(null)}
              className="cursor-pointer text-[12px] text-[var(--text-tertiary)] hover:underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        {/* filters */}
        <div className="mb-5 flex flex-wrap items-center gap-2" data-tour="tour-doc-filters">
          <Filter size={14} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
          <span className="text-xs text-[var(--text-secondary)]">Category:</span>
          {(['ALL', ...ALL_CATS] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCatFilter(c)}
              className={`cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                catFilter === c
                  ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                  : 'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--hover)]'
              }`}
            >
              {c === 'ALL' ? 'All categories' : DOC_CATEGORY_LABEL[c]}
            </button>
          ))}
          <span className="ml-3 text-xs text-[var(--text-secondary)]">Health:</span>
          {(['ALL', 'VALID', 'EXPIRED', 'STALE_CERTIFICATION', 'NO_EXPIRY_INFO'] as const).map(
            (h) => (
              <button
                key={h}
                type="button"
                onClick={() => setHealthFilter(h)}
                className={`cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  healthFilter === h
                    ? 'bg-[var(--text)] text-[var(--surface)]'
                    : 'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--hover)]'
                }`}
              >
                {h === 'ALL' ? 'All health' : HEALTH_LABEL[h]}
              </button>
            ),
          )}
        </div>

        {/* document grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {docs.map(({ doc, rep }) => (
            <DocCard
              key={doc.id}
              doc={doc}
              health={rep.health}
              summary={healthSummary(doc, rep)}
              daysUntilExpiry={rep.daysUntilExpiry}
              active={selected?.id === doc.id}
              onClick={() => setSelected((s) => (s?.id === doc.id ? null : doc))}
            />
          ))}

          {/* upload slot */}
          <button
            type="button"
            data-tour="tour-doc-upload"
            onClick={openCreate}
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[var(--border)] bg-[var(--surface)] py-8 text-[var(--text-tertiary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-dark)]"
          >
            <Upload size={20} aria-hidden="true" />
            <span className="text-sm font-medium">Upload new document</span>
          </button>
        </div>

        {docs.length === 0 && (
          <p className="py-10 text-center text-sm text-[var(--text-secondary)]">
            No documents match the selected filters.
          </p>
        )}

        {/* detail panel */}
        {selected && (
          <DocDetailPanel
            doc={selected}
            deleting={deleteBusy === selected.id}
            onClose={() => setSelected(null)}
            onEdit={() => openEdit(selected)}
            onDelete={() => requestDelete(selected)}
          />
        )}

        <p className="mt-6 text-center text-[11px] text-[var(--text-tertiary)]">
          Certified stamps older than {POLICE_STAMP_WINDOW_DAYS} days are flagged as stale (SA
          police-stamp rule). Uploaded PDFs are saved on this machine — if the file link ever goes
          missing, "Re-attach PDF" restores it.
        </p>
      </div>

      {/* upload / edit modal */}
      {formOpen && (
        <VaultDocFormModal
          editDoc={editDoc}
          onClose={() => {
            setFormOpen(false)
            setEditDoc(null)
          }}
          onSubmit={handleSubmit}
        />
      )}

      {/* soft-delete confirmation (in-app: native window.confirm is not
          accepted by the durability E2E spec) */}
      {pendingDelete && (
        <div data-testid="delete-document-dialog" className="fixed inset-0 z-[75]">
          <Dialog
            title="Move file to Trash?"
            subtitle={`“${pendingDelete.title}” will be removed from the vault.`}
            icon={<Trash2 size={16} aria-hidden="true" />}
            size="md"
            onClose={cancelDelete}
            footer={
              <>
                {/* Destructive action: Cancel takes initial focus so a stray
                    Enter/Space does not delete. Escape and backdrop also cancel. */}
                <Button variant="ghost" data-autofocus onClick={cancelDelete}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  data-testid="delete-document-confirm"
                  onClick={confirmDelete}
                >
                  Move to Trash
                </Button>
              </>
            }
          >
            <p className="px-5 py-4 text-sm leading-relaxed text-[var(--text-secondary)]">
              The file is moved to Trash and can be restored. This deletes the vault entry for “
              {pendingDelete.title}” and, if the document is referenced, lists the referencing
              records afterwards.
            </p>
          </Dialog>
        </div>
      )}

      {trashOpen && (
        <TrashDrawer
          onClose={() => setTrashOpen(false)}
          onRestored={(storedPath) =>
            setNotice(
              `Restored a managed file to ${storedPath}. Re-attach it to a document if needed.`,
            )
          }
        />
      )}
    </div>
  )
}

function DocCard({
  doc,
  health,
  summary,
  daysUntilExpiry,
  active,
  onClick,
}: {
  doc: VaultDoc
  health: DocHealth
  summary: string
  daysUntilExpiry: number | null
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full cursor-pointer flex-col gap-3 rounded-xl border bg-[var(--surface)] p-5 text-left shadow-sm transition-all hover:shadow-md ${
        active
          ? 'border-[var(--accent)] ring-2 ring-[var(--accent-soft)]'
          : 'border-[var(--border)]'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="mt-0.5 shrink-0">{CAT_ICON[doc.category]}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-[var(--text)] group-hover:text-[var(--accent-dark)]">
            {doc.title}
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
            {DOC_CATEGORY_LABEL[doc.category]}
          </p>
        </div>
        <Badge tone={HEALTH_TONE[health]}>{HEALTH_LABEL[health]}</Badge>
      </div>

      <p className="text-[12px] text-[var(--text-secondary)]">{summary}</p>

      <div className="flex items-center justify-between text-[11px] text-[var(--text-tertiary)]">
        <div className="flex items-center gap-1">
          <Calendar size={11} aria-hidden="true" />
          {doc.expiryDate ? (
            <>Expires {doc.expiryDate}</>
          ) : doc.issueDate ? (
            <>Issued {doc.issueDate}</>
          ) : (
            'No date on file'
          )}
        </div>
        {doc.fileUrl ? (
          <span className="inline-flex items-center gap-1 text-[var(--accent-dark)]">
            <ExternalLink size={11} aria-hidden="true" /> View PDF
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[var(--text-tertiary)]">
            <Paperclip size={11} aria-hidden="true" /> Re-attach PDF
          </span>
        )}
      </div>

      {daysUntilExpiry !== null && daysUntilExpiry > 0 && daysUntilExpiry < 60 && (
        <div className="rounded-md border border-[var(--warn-border)] bg-[var(--warn-bg)] px-2.5 py-1.5 text-[11px] text-[var(--warn)]">
          Renew within {daysUntilExpiry} days
        </div>
      )}
    </button>
  )
}

function DocDetailPanel({
  doc,
  deleting = false,
  onClose,
  onEdit,
  onDelete,
}: {
  doc: VaultDoc
  deleting?: boolean
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const rep = useMemo(() => assessDocHealth(doc), [doc])
  return (
    <div className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-[var(--text)]">{doc.title}</h2>
          <p className="text-sm text-[var(--text-secondary)]">{DOC_CATEGORY_LABEL[doc.category]}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={HEALTH_TONE[rep.health]}>{HEALTH_LABEL[rep.health]}</Badge>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close document details"
            className="cursor-pointer text-[var(--text-tertiary)] hover:text-[var(--text)]"
          >
            ×
          </button>
        </div>
      </div>

      <p className="mb-4 text-sm text-[var(--text-secondary)]">{healthSummary(doc, rep)}</p>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {Object.entries(doc.metadata).map(([k, v]) => (
          <div key={k}>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
              {k}
            </dt>
            <dd className="text-[var(--text)]">{v}</dd>
          </div>
        ))}
        {doc.issueDate && (
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
              Issued
            </dt>
            <dd className="text-[var(--text)]">{doc.issueDate}</dd>
          </div>
        )}
        {doc.expiryDate && (
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
              Expires
            </dt>
            <dd className="text-[var(--text)]">{doc.expiryDate}</dd>
          </div>
        )}
        {doc.certifiedDate && (
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
              Certified
            </dt>
            <dd className="text-[var(--text)]">{doc.certifiedDate}</dd>
          </div>
        )}
      </dl>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {doc.fileUrl ? (
          <button
            type="button"
            onClick={async () => {
              const url = doc.fileUrl
              if (!url) return
              if (
                typeof window !== 'undefined' &&
                window.tendersApi?.openDocument &&
                !url.startsWith('blob:') &&
                !url.startsWith('http') &&
                !url.startsWith('/demo')
              ) {
                const res = await window.tendersApi.openDocument({ storedPath: url })
                if (!res?.ok) {
                  console.warn('tenders: failed to open document via shell', res?.error)
                }
              } else {
                window.open(url, '_blank')
              }
            }}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] px-4 py-2 text-sm font-medium text-[var(--accent-dark)] hover:bg-[var(--hover)]"
          >
            <ExternalLink size={14} aria-hidden="true" /> Open PDF
          </button>
        ) : (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-2 text-sm font-medium text-[var(--warn)] hover:bg-[var(--hover)]"
          >
            <Paperclip size={14} aria-hidden="true" /> Re-attach PDF
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--hover)]"
        >
          <Pencil size={14} aria-hidden="true" /> Edit details
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          title="Moves the file to Trash (recoverable)"
          className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--danger-border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--danger)] hover:bg-[var(--danger-bg)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Trash2 size={14} aria-hidden="true" /> Delete
        </button>
      </div>
    </div>
  )
}

function VaultDocFormModal({
  editDoc,
  onClose,
  onSubmit,
}: {
  /** null = create (upload) mode; doc = edit / re-attach mode */
  editDoc: VaultDoc | null
  onClose: () => void
  onSubmit: (data: VaultFormData) => void
}) {
  const [title, setTitle] = useState(editDoc?.title ?? '')
  const [category, setCategory] = useState<DocCategory>(editDoc?.category ?? 'COMPLIANCE')
  const [issueDate, setIssueDate] = useState(editDoc?.issueDate ?? '')
  const [expiryDate, setExpiryDate] = useState(editDoc?.expiryDate ?? '')
  const [isCertified, setIsCertified] = useState(editDoc?.isCertified ?? false)
  const [certifiedDate, setCertifiedDate] = useState(editDoc?.certifiedDate ?? '')
  const [note, setNote] = useState(editDoc?.metadata['Note'] ?? '')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const pickFile = (f: File | null) => {
    if (f && f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      setError('Please choose a PDF file.')
      return
    }
    setError('')
    setFile(f)
  }

  const submit = () => {
    if (!title.trim()) {
      setError('Give the document a title.')
      return
    }
    if (!editDoc && !file) {
      setError('Choose the PDF file to store in the vault.')
      return
    }
    setError('')
    onSubmit({
      title: title.trim(),
      category,
      issueDate: issueDate || null,
      expiryDate: expiryDate || null,
      isCertified,
      certifiedDate: isCertified ? certifiedDate || null : null,
      note: note.trim(),
      file,
    })
  }

  const inputCls =
    'w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]'
  const labelCls = 'mb-1 block text-xs font-medium text-[var(--text-secondary)]'

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-bg-overlay)] p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-[var(--surface)] p-6 shadow-[var(--shadow-modal-strong)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between gap-4">
          <h2 className="text-base font-bold text-[var(--text)]">
            {editDoc ? 'Edit document' : 'Add company document'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close document form"
            className="cursor-pointer text-[var(--text-tertiary)] hover:text-[var(--text)]"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {!editDoc && (
          <p className="mb-4 text-xs leading-relaxed text-[var(--text-secondary)]">
            Store your CIPC registration, SARS tax clearance, B-BBEE certificate, COIDA letter of
            good standing, VAT registration or any other company document in the vault — it then
            feeds tender gap analysis automatically.
          </p>
        )}

        {/* file picker */}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            pickFile(e.target.files?.[0] ?? null)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="mb-4 flex w-full cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-[var(--border)] px-3 py-2.5 text-left text-sm text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-dark)]"
        >
          <Paperclip size={15} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            {file ? file.name : editDoc?.fileUrl ? 'Replace PDF (optional)' : 'Choose PDF…'}
          </span>
          {file && <Badge tone="green">Ready</Badge>}
        </button>

        {/* title */}
        <label className={labelCls}>Title</label>
        <input
          className={`${inputCls} mb-3`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. SARS Tax Clearance Certificate"
        />

        {/* category */}
        <label className={labelCls}>Category</label>
        <select
          className={`${inputCls} mb-3 cursor-pointer`}
          value={category}
          onChange={(e) => setCategory(e.target.value as DocCategory)}
        >
          {ALL_CATS.map((c) => (
            <option key={c} value={c}>
              {DOC_CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>

        {/* dates */}
        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Issue date</label>
            <input
              type="date"
              className={inputCls}
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls}>Expiry date</label>
            <input
              type="date"
              className={inputCls}
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
            />
          </div>
        </div>

        {/* certification */}
        <div className="mb-3 flex items-center gap-2">
          <input
            id="is-certified"
            type="checkbox"
            checked={isCertified}
            onChange={(e) => setIsCertified(e.target.checked)}
            className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
          />
          <label
            htmlFor="is-certified"
            className="cursor-pointer text-sm text-[var(--text-secondary)]"
          >
            Certified (SA police stamp / commissioner of oaths)
          </label>
        </div>
        {isCertified && (
          <div className="mb-3">
            <label className={labelCls}>Certified on</label>
            <input
              type="date"
              className={inputCls}
              value={certifiedDate}
              onChange={(e) => setCertifiedDate(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
              Stamps older than {POLICE_STAMP_WINDOW_DAYS} days are flagged as stale.
            </p>
          </div>
        )}

        {/* note */}
        <label className={labelCls}>Note (optional)</label>
        <input
          className={inputCls}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Pin valid until submission date"
        />

        {error && (
          <p role="alert" className="mt-3 text-xs font-medium text-[var(--danger)]">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--hover)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="cursor-pointer rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] shadow-sm hover:bg-[var(--accent-dark)]"
          >
            {editDoc ? 'Save changes' : 'Add to vault'}
          </button>
        </div>
      </div>
    </div>
  )
}
