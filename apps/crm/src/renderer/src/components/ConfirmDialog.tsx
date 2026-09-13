import React, { useCallback, useRef } from 'react'
import { XIcon } from './Icons'
import { useDialogA11y } from './useDialogA11y'

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  busy,
  onCancel,
  onConfirm,
}: {
  title: string
  message: string
  confirmLabel?: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const handleEscape = useCallback(() => {
    if (!busy) onCancel()
  }, [busy, onCancel])
  useDialogA11y(dialogRef, handleEscape, cancelRef)
  return (
    <div className="crm-modal-backdrop" onClick={() => !busy && onCancel()}>
      <div
        ref={dialogRef}
        className="crm-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="crm-confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="crm-modal-header">
          <h3 id="crm-confirm-title" className="crm-modal-title">
            {title}
          </h3>
          <button
            type="button"
            className="crm-modal-close-btn"
            aria-label="Close confirmation"
            onClick={onCancel}
            disabled={busy}
          >
            <XIcon size={14} />
          </button>
        </div>
        <div className="crm-confirm-body">
          <p>{message}</p>
        </div>
        <div className="crm-modal-footer">
          <button
            ref={cancelRef}
            type="button"
            className="crm-btn"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="crm-btn crm-btn-danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
