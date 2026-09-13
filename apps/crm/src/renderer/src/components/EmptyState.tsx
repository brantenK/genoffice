import React from 'react'

export function EmptyState({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string
  message: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="crm-empty-state" role="status">
      <div className="crm-empty-mark" aria-hidden="true">
        —
      </div>
      <h3>{title}</h3>
      <p>{message}</p>
      {actionLabel && onAction && (
        <button type="button" className="crm-btn" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}
