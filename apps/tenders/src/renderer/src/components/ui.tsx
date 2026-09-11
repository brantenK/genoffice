// Small shared UI primitives (shadcn-style, Tailwind-only).
import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { FulfillmentStatus, RiskLevel } from '../../shared/types'

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  className,
  disabled,
  title
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  className?: string
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm',
        variant === 'primary' && 'bg-indigo-600 text-white hover:bg-indigo-700',
        variant === 'default' && 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
        variant === 'ghost' && 'text-slate-600 hover:bg-slate-100',
        variant === 'danger' && 'border border-red-200 bg-white text-red-600 hover:bg-red-50',
        className
      )}
    >
      {children}
    </button>
  )
}

export function Badge({
  children,
  tone = 'slate',
  className
}: {
  children: ReactNode
  tone?: 'slate' | 'green' | 'amber' | 'red' | 'indigo' | 'sky' | 'violet'
  className?: string
}) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-600 border-slate-200',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    sky: 'bg-sky-50 text-sky-700 border-sky-200',
    violet: 'bg-violet-50 text-violet-700 border-violet-200'
  }
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

export const RISK_TONE: Record<RiskLevel, 'red' | 'sky' | 'slate'> = {
  CRITICAL_DISQUALIFIER: 'red',
  POINT_SCORED: 'sky',
  INFORMATIONAL: 'slate'
}

export const RISK_LABEL: Record<RiskLevel, string> = {
  CRITICAL_DISQUALIFIER: 'Disqualifier',
  POINT_SCORED: 'Points',
  INFORMATIONAL: 'Info'
}

export const STATUS_TONE: Record<FulfillmentStatus, 'green' | 'amber' | 'red' | 'slate'> = {
  FULFILLED: 'green',
  ACTION_REQUIRED: 'amber',
  OUTSTANDING: 'red',
  NOT_APPLICABLE: 'slate'
}

export const STATUS_LABEL: Record<FulfillmentStatus, string> = {
  FULFILLED: 'Fulfilled',
  ACTION_REQUIRED: 'Action required',
  OUTSTANDING: 'Outstanding',
  NOT_APPLICABLE: 'N/A'
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        'inline-block size-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600',
        className
      )}
    />
  )
}
