// Documents: company vault as a proper document manager.
// Grid view with category filters, health badges, metadata, and a real
// upload flow. Uploaded PDFs live in-browser as blob: object URLs — on
// reload the store drops the dead blob reference (fileUrl: null) and the
// UI offers a re-attach flow. Static /demo/* mock paths survive reload.
import { useMemo, useRef, useState } from 'react'
import {
  Calendar,
  CheckCircle2,
  ExternalLink,
  FileText,
  Filter,
  Paperclip,
  Pencil,
  ShieldAlert,
  Trash2,
  Upload,
  X,
  XCircle
} from 'lucide-react'
import type { DocCategory, DocHealth, VaultDoc } from '../../../shared/types'
import { DOC_CATEGORY_LABEL } from '../../../shared/types'
import { assessDocHealth, healthSummary, POLICE_STAMP_WINDOW_DAYS } from '../../gap'
import { newVaultDocId, useTendersStore } from '../../store'
import { Badge } from '../ui'

const HEALTH_TONE: Record<DocHealth, 'green' | 'red' | 'amber' | 'slate'> = {
  VALID: 'green',
  EXPIRED: 'red',
  STALE_CERTIFICATION: 'amber',
  NO_EXPIRY_INFO: 'slate'
}

const HEALTH_LABEL: Record<DocHealth, string> = {
  VALID: 'Valid',
  EXPIRED: 'Expired',
  STALE_CERTIFICATION: 'Stale stamp',
  NO_EXPIRY_INFO: 'No expiry info'
}

const CAT_ICON: Record<DocCategory, React.ReactNode> = {
  COMPLIANCE: <ShieldAlert size={16} className="text-indigo-500" />,
  FINANCIAL: <CheckCircle2 size={16} className="text-emerald-500" />,
  TECHNICAL: <FileText size={16} className="text-sky-500" />,
  GOVERNANCE: <FileText size={16} className="text-violet-500" />,
  CV: <FileText size={16} className="text-amber-500" />,
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

  const openCreate = () => {
    setEditDoc(null)
    setFormOpen(true)
  }

  const openEdit = (d: VaultDoc) => {
    setEditDoc(d)
    setFormOpen(true)
  }

  const handleDelete = (d: VaultDoc) => {
    if (!window.confirm(`Delete "${d.title}" from the vault? This cannot be undone.`)) return
    if (d.fileUrl?.startsWith('blob:')) URL.revokeObjectURL(d.fileUrl)
    removeVaultDoc(d.id)
    setSelected(null)
  }

  const handleSubmit = (data: VaultFormData) => {
    if (editDoc) {
      // ── edit / re-attach an existing document ───────────────────────────
      const metadata: Record<string, string> = { ...editDoc.metadata }
      if (data.note) metadata['Note'] = data.note
      else delete metadata['Note']
      if (data.file) metadata['File name'] = data.file.name
      if (editDoc.fileUrl?.startsWith('blob:')) URL.revokeObjectURL(editDoc.fileUrl)
      const updated: VaultDoc = {
        ...editDoc,
        title: data.title,
        category: data.category,
        issueDate: data.issueDate,
        expiryDate: data.expiryDate,
        isCertified: data.isCertified,
        certifiedDate: data.certifiedDate,
        fileUrl: data.file ? URL.createObjectURL(data.file) : editDoc.fileUrl,
        metadata
      }
      updateVaultDoc(editDoc.id, updated)
      setSelected(updated)
    } else {
      // ── brand new uploaded document ────────────────────────────────────
      const metadata: Record<string, string> = {}
      if (data.file) metadata['File name'] = data.file.name
      if (data.note) metadata['Note'] = data.note
      addVaultDoc({
        id: newVaultDocId(),
        title: data.title,
        category: data.category,
        fileUrl: data.file ? URL.createObjectURL(data.file) : null,
        issueDate: data.issueDate,
        expiryDate: data.expiryDate,
        isCertified: data.isCertified,
        certifiedDate: data.certifiedDate,
        metadata
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
          const order: Record<DocHealth, number> = { EXPIRED: 0, STALE_CERTIFICATION: 1, NO_EXPIRY_INFO: 2, VALID: 3 }
          return order[a.rep.health] - order[b.rep.health]
        }),
    [vault, catFilter, healthFilter]
  )

  const allReports = useMemo(() => vault.map((d) => ({ doc: d, rep: assessDocHealth(d) })), [vault])
  const expiredCount = allReports.filter((r) => r.rep.health === 'EXPIRED').length
  const staleCount   = allReports.filter((r) => r.rep.health === 'STALE_CERTIFICATION').length

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      {/* header */}
      <div className="border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Documents</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              Company compliance vault — {vault.length} documents on record
              {(expiredCount > 0 || staleCount > 0) && (
                <span className="ml-2 inline-flex items-center gap-1 text-amber-600">
                  <XCircle size={13} /> {expiredCount + staleCount} need{' '}
                  {expiredCount + staleCount === 1 ? 's' : ''} attention
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm hover:bg-slate-50"
          >
            <Upload size={15} /> Upload document
          </button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        {/* filters */}
        <div className="mb-5 flex flex-wrap items-center gap-2" data-tour="tour-doc-filters">
          <Filter size={14} className="shrink-0 text-slate-400" />
          <span className="text-xs text-slate-500">Category:</span>
          {(['ALL', ...ALL_CATS] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCatFilter(c)}
              className={`cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                catFilter === c
                  ? 'bg-indigo-600 text-white'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {c === 'ALL' ? 'All categories' : DOC_CATEGORY_LABEL[c]}
            </button>
          ))}
          <span className="ml-3 text-xs text-slate-500">Health:</span>
          {(['ALL', 'VALID', 'EXPIRED', 'STALE_CERTIFICATION', 'NO_EXPIRY_INFO'] as const).map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setHealthFilter(h)}
              className={`cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                healthFilter === h
                  ? 'bg-slate-800 text-white'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {h === 'ALL' ? 'All health' : HEALTH_LABEL[h]}
            </button>
          ))}
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
              onClick={() => setSelected((s) => s?.id === doc.id ? null : doc)}
            />
          ))}

          {/* upload slot */}
          <button
            type="button"
            data-tour="tour-doc-upload"
            onClick={openCreate}
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 bg-white py-8 text-slate-400 transition-colors hover:border-indigo-300 hover:text-indigo-500"
          >
            <Upload size={20} />
            <span className="text-sm font-medium">Upload new document</span>
          </button>
        </div>

        {docs.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-400">
            No documents match the selected filters.
          </p>
        )}

        {/* detail panel */}
        {selected && (
          <DocDetailPanel
            doc={selected}
            onClose={() => setSelected(null)}
            onEdit={() => openEdit(selected)}
            onDelete={() => handleDelete(selected)}
          />
        )}

        <p className="mt-6 text-center text-[11px] text-slate-400">
          Certified stamps older than {POLICE_STAMP_WINDOW_DAYS} days are flagged as stale (SA police-stamp rule).
          Uploaded PDFs are kept in this browser session — use "Re-attach PDF" after a reload.
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
    </div>
  )
}

function DocCard({
  doc, health, summary, daysUntilExpiry, active, onClick
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
      className={`group flex w-full cursor-pointer flex-col gap-3 rounded-xl border bg-white p-5 text-left shadow-sm transition-all hover:shadow-md ${
        active ? 'border-indigo-400 ring-2 ring-indigo-200' : 'border-slate-200'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="mt-0.5 shrink-0">{CAT_ICON[doc.category]}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-slate-800 group-hover:text-indigo-700">
            {doc.title}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">{DOC_CATEGORY_LABEL[doc.category]}</p>
        </div>
        <Badge tone={HEALTH_TONE[health]}>{HEALTH_LABEL[health]}</Badge>
      </div>

      <p className="text-[12px] text-slate-500">{summary}</p>

      <div className="flex items-center justify-between text-[11px] text-slate-400">
        <div className="flex items-center gap-1">
          <Calendar size={11} />
          {doc.expiryDate ? <>Expires {doc.expiryDate}</> : doc.issueDate ? <>Issued {doc.issueDate}</> : 'No date on file'}
        </div>
        {doc.fileUrl ? (
          <span className="inline-flex items-center gap-1 text-indigo-500">
            <ExternalLink size={11} /> View PDF
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-slate-300">
            <Paperclip size={11} /> Re-attach PDF
          </span>
        )}
      </div>

      {daysUntilExpiry !== null && daysUntilExpiry > 0 && daysUntilExpiry < 60 && (
        <div className="rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
          Renew within {daysUntilExpiry} days
        </div>
      )}
    </button>
  )
}

function DocDetailPanel({
  doc, onClose, onEdit, onDelete
}: {
  doc: VaultDoc
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const rep = useMemo(() => assessDocHealth(doc), [doc])
  return (
    <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-slate-900">{doc.title}</h2>
          <p className="text-sm text-slate-500">{DOC_CATEGORY_LABEL[doc.category]}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={HEALTH_TONE[rep.health]}>{HEALTH_LABEL[rep.health]}</Badge>
          <button type="button" onClick={onClose} className="cursor-pointer text-slate-400 hover:text-slate-700">×</button>
        </div>
      </div>

      <p className="mb-4 text-sm text-slate-600">{healthSummary(doc, rep)}</p>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {Object.entries(doc.metadata).map(([k, v]) => (
          <div key={k}>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{k}</dt>
            <dd className="text-slate-800">{v}</dd>
          </div>
        ))}
        {doc.issueDate && (
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Issued</dt>
            <dd className="text-slate-800">{doc.issueDate}</dd>
          </div>
        )}
        {doc.expiryDate && (
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Expires</dt>
            <dd className="text-slate-800">{doc.expiryDate}</dd>
          </div>
        )}
        {doc.certifiedDate && (
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Certified</dt>
            <dd className="text-slate-800">{doc.certifiedDate}</dd>
          </div>
        )}
      </dl>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {doc.fileUrl ? (
          <a
            href={doc.fileUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
          >
            <ExternalLink size={14} /> Open PDF
          </a>
        ) : (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-100"
          >
            <Paperclip size={14} /> Re-attach PDF
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          <Pencil size={14} /> Edit details
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
        >
          <Trash2 size={14} /> Delete
        </button>
      </div>
    </div>
  )
}

function VaultDocFormModal({
  editDoc, onClose, onSubmit
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
      file
    })
  }

  const inputCls =
    'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100'
  const labelCls = 'mb-1 block text-xs font-medium text-slate-600'

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between gap-4">
          <h2 className="text-base font-bold text-slate-900">
            {editDoc ? 'Edit document' : 'Add company document'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer text-slate-400 hover:text-slate-700"
          >
            <X size={16} />
          </button>
        </div>
        {!editDoc && (
          <p className="mb-4 text-xs leading-relaxed text-slate-500">
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
          className="mb-4 flex w-full cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-slate-200 px-3 py-2.5 text-left text-sm text-slate-500 transition-colors hover:border-indigo-300 hover:text-indigo-600"
        >
          <Paperclip size={15} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {file
              ? file.name
              : editDoc?.fileUrl
                ? 'Replace PDF (optional)'
                : 'Choose PDF…'}
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
            <option key={c} value={c}>{DOC_CATEGORY_LABEL[c]}</option>
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
            className="h-4 w-4 cursor-pointer accent-indigo-600"
          />
          <label htmlFor="is-certified" className="cursor-pointer text-sm text-slate-700">
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
            <p className="mt-1 text-[11px] text-slate-400">
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

        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700"
          >
            {editDoc ? 'Save changes' : 'Add to vault'}
          </button>
        </div>
      </div>
    </div>
  )
}
