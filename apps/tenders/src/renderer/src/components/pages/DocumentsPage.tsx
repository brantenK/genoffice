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
  XCircle,
} from 'lucide-react'
import type { DocCategory, DocHealth, VaultDoc } from '../../../shared/types'
import type { DocumentReconciliation } from '../../../../shared/tenders-persistence'
import { DOC_CATEGORY_LABEL, isDemoAssetUrl } from '../../../shared/types'
import { openDemoAsset } from '../../mock/vault'
import { assessDocHealth, healthSummary, POLICE_STAMP_WINDOW_DAYS } from '../../gap'
import { newVaultDocId, useTendersStore } from '../../store'
import { Badge, Button, FormField, FormSelect, FORM_CHECKBOX_CLASS, Spinner } from '../ui'
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

  /** A workspace-relative managed file path (not a blob/http/demo URL). */
  const managedPath = (url: string | null): string | null => {
    if (!url) return null
    if (url.startsWith('blob:') || url.startsWith('http') || isDemoAssetUrl(url)) return null
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
    setFormOpen(true)
  }

  const openEdit = (d: VaultDoc) => {
    setEditDoc(d)
    setError(null)
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

  /**
   * Persist the form. Failures are RETURNED rather than parked in page state:
   * the page-level alert sat behind the modal's own scrim, so a refused upload
   * looked like nothing happening. The modal shows the reason inline and only
   * closes on success.
   */
  const handleSubmit = async (
    data: VaultFormData,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    setError(null)
    setNotice(null)
    const api = typeof window === 'undefined' ? undefined : window.tendersApi
    // Only a managed relative path is accepted by replaceDocument/deleteDocument.
    const previousPath = editDoc ? managedPath(editDoc.fileUrl) : null

    let savedPath: string | null = null
    if (data.file) {
      let buffer: ArrayBuffer
      try {
        buffer = await data.file.arrayBuffer()
      } catch (err) {
        return {
          ok: false,
          error: `Could not read the chosen file: ${err instanceof Error ? err.message : String(err)}`,
        }
      }

      if (editDoc && previousPath) {
        // Replacing a stored PDF goes through the managed replace path: main
        // commits the new file first and only then moves the previous one to
        // Trash, so the old file is never orphaned on disk.
        if (!api?.replaceDocument) {
          return {
            ok: false,
            error: 'Replacing a stored PDF is unavailable in this build; nothing was changed.',
          }
        }
        try {
          const res = await api.replaceDocument({
            storedPath: previousPath,
            fileName: data.file.name,
            buffer,
          })
          if (!res?.ok || !res.storedPath) {
            return {
              ok: false,
              error: res?.error || 'Could not replace the stored PDF. Nothing was changed.',
            }
          }
          savedPath = res.storedPath
          if (res.warning || res.previousTrashed === false) {
            setNotice(
              `The new PDF was saved, but the previous file could not be moved to Trash${
                res.warning ? `: ${res.warning}` : '.'
              }`,
            )
          }
        } catch (err) {
          return {
            ok: false,
            error: `Could not replace the stored PDF: ${
              err instanceof Error ? err.message : String(err)
            }`,
          }
        }
      } else {
        // Never present a session blob as durable: without the managed-file
        // bridge the upload cannot be persisted, so fail closed and say so.
        if (!api?.saveDocument) {
          return {
            ok: false,
            error: 'Saving documents to disk is unavailable in this build. Nothing was added.',
          }
        }
        try {
          const saveRes = await api.saveDocument({
            fileName: data.file.name,
            buffer,
            category: 'vault',
          })
          if (!saveRes?.ok || !saveRes.storedPath) {
            return {
              ok: false,
              error: saveRes?.error || 'Could not save the document to disk. Nothing was added.',
            }
          }
          savedPath = saveRes.storedPath
        } catch (err) {
          console.warn('tenders: failed to persist vault document via IPC', err)
          return {
            ok: false,
            error:
              err instanceof Error
                ? `Could not save the document to disk: ${err.message}`
                : 'Could not save the document to disk. Nothing was added.',
          }
        }
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
    return { ok: true }
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
              Missing: {reconcile.missing.map((entry) => entry.fileName).join(', ')}. Re-attaching a
              PDF stores a fresh copy under a new name — the missing record stays listed until that
              original file itself is back on disk.
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
          police-stamp rule). Uploaded PDFs are saved on this machine — re-attaching a PDF to a
          document stores a fresh copy of the file; it does not recreate the document's dates, notes
          or requirement links.
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
              records afterwards. Undo restores the file only — the vault entry, its dates, notes
              and requirement links are not restored.
            </p>
          </Dialog>
        </div>
      )}

      {trashOpen && (
        <TrashDrawer
          onClose={() => setTrashOpen(false)}
          onRestored={(storedPath) =>
            setNotice(
              `Restored a managed file to ${storedPath}. Only the file is back — re-attach it to a document and re-link any requirements.`,
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
  // A user-triggered open failure is shown here, not just console.warn'd.
  const [openError, setOpenError] = useState<string | null>(null)

  const openDocument = async (): Promise<void> => {
    const url = doc.fileUrl
    if (!url) return
    setOpenError(null)
    if (isDemoAssetUrl(url)) {
      // A bundled demonstration asset is read-only and lives outside the managed
      // store, so it is opened by its own helper rather than by path.
      try {
        await openDemoAsset(url)
      } catch (err) {
        setOpenError(
          `Could not open this document: ${err instanceof Error ? err.message : String(err)}.`,
        )
      }
      return
    }
    if (
      typeof window !== 'undefined' &&
      window.tendersApi?.openDocument &&
      !url.startsWith('blob:') &&
      !url.startsWith('http')
    ) {
      const res = await window.tendersApi.openDocument({ storedPath: url })
      if (!res?.ok) {
        setOpenError(
          `Could not open this document: ${res?.error || 'the shell refused the request.'}`,
        )
      }
      return
    }
    window.open(url, '_blank')
  }

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
            onClick={() => void openDocument()}
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

      {openError && (
        <div
          role="alert"
          data-testid="open-document-error"
          className="mt-3 flex items-start gap-1.5 rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-[12px] text-[var(--danger-text)]"
        >
          <XCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 leading-relaxed">{openError}</span>
        </div>
      )}
    </div>
  )
}

/** Stable no-op: keeps Escape/backdrop inert while a save is in flight. */
const NOOP = () => undefined

function VaultDocFormModal({
  editDoc,
  onClose,
  onSubmit,
}: {
  /** null = create (upload) mode; doc = edit / re-attach mode */
  editDoc: VaultDoc | null
  onClose: () => void
  /** Resolves with the failure reason so the form can show it inline. */
  onSubmit: (data: VaultFormData) => Promise<{ ok: true } | { ok: false; error: string }>
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
  // A save is in flight: submit is disabled so a double-click cannot store the
  // same PDF twice.
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const pickFile = (f: File | null) => {
    if (f && f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      setError('Please choose a PDF file.')
      return
    }
    setError('')
    setFile(f)
  }

  const submit = async () => {
    if (saving) return
    if (!title.trim()) {
      setError('Give the document a title.')
      return
    }
    if (!editDoc && !file) {
      setError('Choose the PDF file to store in the vault.')
      return
    }
    setError('')
    setSaving(true)
    try {
      const result = await onSubmit({
        title: title.trim(),
        category,
        issueDate: issueDate || null,
        expiryDate: expiryDate || null,
        isCertified,
        certifiedDate: isCertified ? certifiedDate || null : null,
        note: note.trim(),
        file,
      })
      // On success the parent closes (unmounts) this modal; `saving` stays set
      // so the controls remain inert for the frames before it goes away.
      if (!result.ok) {
        setError(result.error)
        setSaving(false)
      }
    } catch (err) {
      setError(`Could not save the document: ${err instanceof Error ? err.message : String(err)}`)
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={editDoc ? 'Edit document' : 'Add company document'}
      subtitle={
        editDoc
          ? undefined
          : 'Store your CIPC registration, SARS tax clearance, B-BBEE certificate, COIDA letter of good standing, VAT registration or any other company document in the vault — it then feeds tender gap analysis automatically.'
      }
      icon={<Paperclip size={16} aria-hidden="true" />}
      size="md"
      // Escape/backdrop/close must not dismiss a save that is already running:
      // the failure reason is only visible inside this form.
      onClose={saving ? NOOP : onClose}
      bodyClassName="overflow-y-auto"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="vault-doc-submit"
            disabled={saving}
            onClick={() => void submit()}
          >
            {saving ? (
              <>
                <Spinner /> Saving…
              </>
            ) : editDoc ? (
              'Save changes'
            ) : (
              'Add to vault'
            )}
          </Button>
        </>
      }
    >
      <div className="px-5 py-4">
        {/* file picker */}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          aria-label="Choose a PDF file"
          className="hidden"
          onChange={(e) => {
            pickFile(e.target.files?.[0] ?? null)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="mb-3 flex w-full cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-[var(--border)] px-3 py-2.5 text-left text-sm text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-dark)]"
        >
          <Paperclip size={15} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            {file ? file.name : editDoc?.fileUrl ? 'Replace PDF (optional)' : 'Choose PDF…'}
          </span>
          {file && <Badge tone="green">Ready</Badge>}
        </button>

        <FormField
          label="Title"
          value={title}
          onChange={setTitle}
          placeholder="e.g. SARS Tax Clearance Certificate"
          className="mb-3"
          autoFocus
        />

        <FormSelect
          label="Category"
          value={category}
          onChange={(value) => setCategory(value as DocCategory)}
          options={ALL_CATS.map((c) => ({ value: c, label: DOC_CATEGORY_LABEL[c] }))}
          className="mb-3"
        />

        <div className="mb-3 grid grid-cols-2 gap-3">
          <FormField label="Issue date" type="date" value={issueDate} onChange={setIssueDate} />
          <FormField label="Expiry date" type="date" value={expiryDate} onChange={setExpiryDate} />
        </div>

        <div className="mb-3 flex items-center gap-2">
          <input
            id="vault-doc-is-certified"
            type="checkbox"
            checked={isCertified}
            onChange={(e) => setIsCertified(e.target.checked)}
            className={FORM_CHECKBOX_CLASS}
          />
          <label
            htmlFor="vault-doc-is-certified"
            className="cursor-pointer text-sm text-[var(--text-secondary)]"
          >
            Certified (SA police stamp / commissioner of oaths)
          </label>
        </div>
        {isCertified && (
          <FormField
            label="Certified on"
            type="date"
            value={certifiedDate}
            onChange={setCertifiedDate}
            hint={`Stamps older than ${POLICE_STAMP_WINDOW_DAYS} days are flagged as stale.`}
            className="mb-3"
          />
        )}

        <FormField
          label="Note (optional)"
          value={note}
          onChange={setNote}
          placeholder="e.g. Pin valid until submission date"
        />

        {/* Save failures render here, inside the dialog: the page-level alert sat
            behind the modal's own scrim, so a refused upload looked like nothing
            happening. */}
        {error && (
          <p
            role="alert"
            data-testid="documents-save-error"
            className="mt-3 flex items-start gap-1.5 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-xs font-medium text-[var(--danger-text)]"
          >
            <XCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{error}</span>
          </p>
        )}
      </div>
    </Dialog>
  )
}
