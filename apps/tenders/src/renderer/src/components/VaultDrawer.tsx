// Company vault drawer: the company's documents with live health assessment
// (expiry, 90-day police stamp window) + how many tender requirements use each.
//
// Chrome only: every colour is a semantic token so the drawer follows the suite
// theme. Document data (titles, dates, metadata) is never re-authored here.
import { useMemo, useState } from 'react'
import { AlertTriangle, FileText, X } from 'lucide-react'
import { DOC_CATEGORY_LABEL, isDemoAssetUrl } from '../../shared/types'
import type { DocHealth, VaultDoc } from '../../shared/types'
import { assessDocHealth, healthSummary, POLICE_STAMP_WINDOW_DAYS } from '../gap'
import { openDemoAsset } from '../mock/vault'
import { selectActiveTender, useTendersStore } from '../store'
import { Drawer } from './Drawer'
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
  const company = useTendersStore((s) => s.company)
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
    <Drawer
      title="Company vault"
      subtitle={`${company.tradingName || 'This company'} · ${vault.length} document${
        vault.length === 1 ? '' : 's'
      }`}
      closeLabel="Close vault"
      width="sm"
      onClose={onClose}
      footer={
        <p className="text-[11px] text-[var(--text-tertiary)]">
          Certified stamps older than {POLICE_STAMP_WINDOW_DAYS} days are flagged stale
          (police-stamp rule).
        </p>
      }
    >
      {issues.length > 0 && (
        <div className="shrink-0 border-b border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-2.5">
          <p className="flex items-start gap-1.5 text-xs font-medium text-[var(--warn)]">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {issues.length} document{issues.length === 1 ? '' : 's'} need attention before
              submission.
            </span>
          </p>
        </div>
      )}

      {/* documents — keyboard-focusable scroll region (a document with no file
          on record has no focusable control of its own) */}
      <div
        role="group"
        aria-label="Company vault documents"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto scroll-thin p-3 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset focus-visible:outline-none"
      >
        {docs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--border)] px-4 py-6 text-center text-xs text-[var(--text-tertiary)]">
            No vault documents yet. Add them on the Documents page; Tenders checks expiry and the
            police-stamp window for you.
          </p>
        ) : (
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
        )}
      </div>
    </Drawer>
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
      try {
        const res = await window.tendersApi.openDocument({ storedPath: url })
        if (!res?.ok) {
          setOpenError(
            `Could not open this document: ${res?.error || 'the shell refused the request.'}`,
          )
        }
      } catch (err) {
        setOpenError(
          `Could not open this document: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } else {
      window.open(url, '_blank')
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[13px] leading-snug font-semibold text-[var(--text)]">
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
          <Button
            size="sm"
            variant="default"
            className="rounded-full"
            onClick={() => void openDocument()}
            title="Open this vault document"
          >
            <FileText size={11} aria-hidden="true" /> View PDF
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-tertiary)]">
            No file on record
          </span>
        )}
      </div>

      {openError && (
        <div
          role="alert"
          className="mt-2 flex items-start gap-1.5 rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-2 py-1.5 text-[11px] text-[var(--danger-text)]"
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 leading-relaxed">{openError}</span>
          <button
            type="button"
            onClick={() => setOpenError(null)}
            aria-label="Dismiss document error"
            className="shrink-0 cursor-pointer rounded p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}

      <p className="mt-2 text-xs text-[var(--text-secondary)]">{summary}</p>

      {Object.keys(doc.metadata).length > 0 && (
        <dl className="mt-1.5 grid grid-cols-1 gap-x-3 gap-y-0.5">
          {Object.entries(doc.metadata).map(([key, value]) => (
            <div key={key} className="flex items-baseline justify-between gap-2 text-[11px]">
              <dt className="shrink-0 text-[var(--text-tertiary)]">{key}</dt>
              <dd className="min-w-0 truncate text-[var(--text-secondary)]">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {(doc.issueDate || doc.expiryDate) && (
        <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">
          {doc.issueDate && <>Issued {doc.issueDate}</>}
          {doc.issueDate && doc.expiryDate && <> · </>}
          {doc.expiryDate && <>Expires {doc.expiryDate}</>}
        </p>
      )}
    </div>
  )
}
