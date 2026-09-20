// Confirmation dialog primitive (Phase 5 / WP-13).
//
// A small Dialog for a yes/no decision, so destructive or irreversible actions
// run through the same semantics (labelled heading, aria-modal, Escape, focus
// trap + restoration) as every other overlay. `tone="danger"` marks destructive
// confirmations; the caller still decides what the confirm button does.
import type { ReactNode } from 'react'
import { AlertTriangle, ShieldQuestion } from 'lucide-react'
import { Dialog } from './Dialog'
import { Button } from './ui'

export interface ConfirmDialogProps {
  title: string
  /** Body copy; keep it plain and specific about the consequence. */
  message?: ReactNode
  children?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  /** Disable confirm (e.g. destructive paths that are deferred). */
  confirmDisabled?: boolean
  onConfirm: () => void
  onClose: () => void
  closeLabel?: string
}

export function ConfirmDialog({
  title,
  message,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  confirmDisabled = false,
  onConfirm,
  onClose,
  closeLabel,
}: ConfirmDialogProps) {
  return (
    <Dialog
      title={title}
      size="sm"
      onClose={onClose}
      closeLabel={closeLabel}
      icon={
        tone === 'danger' ? (
          <AlertTriangle size={16} className="text-[var(--danger)]" aria-hidden="true" />
        ) : (
          <ShieldQuestion size={16} className="text-[var(--accent)]" aria-hidden="true" />
        )
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-2 px-5 py-4 text-[13px] leading-relaxed text-[var(--text-secondary)]">
        {message}
        {children}
      </div>
    </Dialog>
  )
}
