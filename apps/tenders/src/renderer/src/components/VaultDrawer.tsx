// Company vault drawer: mock vault documents with live health assessment
// (expiry, 90-day police stamp window) + usage count per tender requirements.
import { useMemo } from 'react'
import { FileText, X } from 'lucide-react'
import { DOC_CATEGORY_LABEL } from '../../shared/types'
import type { DocHealth, VaultDoc } from '../../shared/types'
import { assessDocHealth, healthSummary, POLICE_STAMP_WINDOW_DAYS } from '../gap'
import { selectActiveTender, useTendersStore } from '../store'
import { Badge, Button } from './ui'

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

export function VaultDrawer({ onClose }: { onClose: () => void }) {
  const vault = useTendersStore((s) => s.vault)
  const tender = useTendersStore(selectActiveTender)

  // how many requirements link each vault doc (active tender)
  const usage = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of tender?.requirements ?? []) {
      if (r.linkedVaultDocId) map.set(r.linkedVaultDocId, (map.get(r.linkedVaultDocId) ?? 0) + 1)
    }
    return map
  }, [tender])

  const docs = useMemo(
    () =>
      vault
        .map((doc) => ({ doc, rep: assessDocHealth(doc) }))
        .sort(
          (a, b) =>
            HEALTH_ORDER[a.rep.health] - HEALTH_ORDER[b.rep.health] ||
            a.doc.title.localeCompare(b.doc.title),
        ),
    [vault],
  )

  const issues = docs.filter(
    (d) => d.rep.health === 'EXPIRED' || d.rep.health === 'STALE_CERTIFICATION',
  )

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-[380px] max-w-[90%] flex-col border-l border-slate-200 bg-white shadow-2xl">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Company vault</h2>
          <p className="text-[11px] text-slate-500">
            Thabo Engineering (Pty) Ltd · {vault.length} documents
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} title="Close vault">
          <X size={15} />
        </Button>
      </div>

      {issues.length > 0 && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5">
          <p className="text-xs font-medium text-amber-800">
            ⚠ {issues.length} document{issues.length === 1 ? '' : 's'} need attention before
            submission.
          </p>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin p-3">
        <ul className="space-y-2">
          {docs.map(({ doc, rep }) => (
            <li key={doc.id}>
              <VaultDocCard
                doc={doc}
                health={rep.health}
                summary={healthSummary(doc, rep)}
                usedBy={usage.get(doc.id) ?? 0}
              />
            </li>
          ))}
        </ul>
      </div>

      <div className="shrink-0 border-t border-slate-200 px-4 py-2">
        <p className="text-[11px] text-slate-400">
          Certified stamps older than {POLICE_STAMP_WINDOW_DAYS} days are flagged stale
          (police-stamp rule).
        </p>
      </div>
    </aside>
  )
}

const HEALTH_ORDER: Record<DocHealth, number> = {
  EXPIRED: 0,
  STALE_CERTIFICATION: 1,
  NO_EXPIRY_INFO: 2,
  VALID: 3,
}

function VaultDocCard({
  doc,
  health,
  summary,
  usedBy,
}: {
  doc: VaultDoc
  health: DocHealth
  summary: string
  usedBy: number
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-slate-800">
          {doc.title}
        </p>
        <Badge tone={HEALTH_TONE[health]}>{HEALTH_LABEL[health]}</Badge>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Badge tone="slate">{DOC_CATEGORY_LABEL[doc.category]}</Badge>
        {usedBy > 0 && (
          <Badge tone="indigo">
            Linked to {usedBy} requirement{usedBy === 1 ? '' : 's'}
          </Badge>
        )}
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
                  console.warn('tenders: failed to open vault document via shell', res?.error)
                }
              } else {
                window.open(url, '_blank')
              }
            }}
            className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
          >
            <FileText size={11} /> View PDF
          </button>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[11px] text-slate-400">
            No file on record
          </span>
        )}
      </div>

      <p className="mt-2 text-xs text-slate-500">{summary}</p>

      <dl className="mt-1.5 grid grid-cols-1 gap-x-3 gap-y-0.5">
        {Object.entries(doc.metadata).map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-2 text-[11px]">
            <dt className="text-slate-400">{k}</dt>
            <dd className="truncate text-slate-600">{v}</dd>
          </div>
        ))}
      </dl>

      {(doc.issueDate || doc.expiryDate) && (
        <p className="mt-1.5 text-[11px] text-slate-400">
          {doc.issueDate && <>Issued {doc.issueDate}</>}
          {doc.issueDate && doc.expiryDate && <> · </>}
          {doc.expiryDate && <>Expires {doc.expiryDate}</>}
        </p>
      )}
    </div>
  )
}
