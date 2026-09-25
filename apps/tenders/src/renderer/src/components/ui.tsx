// Small shared UI primitives (tokens-only chrome) plus the Tenders theme bridge.
//
// Every colour here is a semantic token from packages/ui/src/tokens.css (or the
// app-scoped accent/warn/info tokens), so chrome follows the suite light/dark
// theme. Document content (PDF page canvases, editor paper) never uses these.
import clsx from 'clsx'
import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { FulfillmentStatus, RiskLevel } from '../../shared/types'

// ── suite theme (data-theme on <html>) ─────────────────────────────────────────
// The suite switches themes by setting `data-theme` on the document element and
// broadcasting `app:theme-changed`. The shell owns that state; the renderer
// reads it through the preload bridge (`tendersApi.getTheme` /
// `onThemeChanged`) — the app's renderer entry is owned by another lane, so this
// primitives module, imported at boot, installs the bridge instead. It is
// defensive: with no bridge the app simply follows the OS
// `prefers-color-scheme` fallback defined in tokens.css.

export type UiTheme = 'light' | 'dark' | 'system'

interface ThemeBridge {
  getTheme?: () => Promise<UiTheme>
  onThemeChanged?: (handler: (theme: UiTheme) => void) => () => void
}

/** Mirror a suite theme choice onto `<html data-theme>` ('system' clears it). */
export function applyTendersTheme(theme: UiTheme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

/** Subscribe to the suite theme bridge; returns an unsubscribe function. */
export function installTendersTheme(): () => void {
  if (typeof window === 'undefined') return () => {}
  const bridgeHost = window as unknown as {
    tendersApi?: ThemeBridge
    desktop?: ThemeBridge
  }
  // Pick the first host that actually carries the bridge: `tendersApi` is the
  // app's own IPC surface and may not implement it in every build.
  const bridge = [bridgeHost.tendersApi, bridgeHost.desktop].find(
    (candidate) => candidate?.getTheme || candidate?.onThemeChanged,
  )
  if (!bridge) return () => {}
  void bridge
    .getTheme?.()
    .then(applyTendersTheme)
    .catch(() => {})
  const off = bridge.onThemeChanged?.(applyTendersTheme)
  return () => off?.()
}

// Installed once at module load, i.e. before the first React render.
installTendersTheme()

// ── primitives ────────────────────────────────────────────────────────────────

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger'

const BUTTON_BASE =
  'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-50'

// min-h-6 = 24px: every button meets the minimum pointer target size.
const BUTTON_SIZES: Record<'sm' | 'md', string> = {
  sm: 'min-h-6 px-2.5 py-1.5 text-xs',
  md: 'min-h-6 px-3.5 py-2 text-sm',
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'border border-transparent bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-dark)]',
  default:
    'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--hover)]',
  ghost: 'border border-transparent text-[var(--text-secondary)] hover:bg-[var(--hover)]',
  danger:
    'border border-[var(--danger-border)] bg-[var(--surface)] text-[var(--danger-text)] hover:bg-[var(--danger-bg)]',
}

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'className' | 'disabled' | 'onClick' | 'title' | 'type'
> {
  children: ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  className?: string
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  className,
  disabled,
  title,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(BUTTON_BASE, BUTTON_SIZES[size], BUTTON_VARIANTS[variant], className)}
      {...rest}
    >
      {children}
    </button>
  )
}

/**
 * Icon-only control. `label` becomes the accessible name (aria-label + title) so
 * the control is never nameless, and the target is at least 24x24 CSS px.
 */
export function IconButton({
  label,
  children,
  onClick,
  variant = 'ghost',
  size = 'sm',
  className,
  ...rest
}: Omit<ButtonProps, 'title' | 'children'> & { label: string; children: ReactNode }) {
  return (
    <Button
      aria-label={label}
      title={label}
      onClick={onClick}
      variant={variant}
      size={size}
      className={clsx('justify-center', size === 'sm' ? 'min-w-6' : 'min-w-8', className)}
      {...rest}
    >
      {children}
    </Button>
  )
}

export type BadgeTone = 'slate' | 'green' | 'amber' | 'red' | 'indigo' | 'sky' | 'violet'

// Semantic tone map. The legacy tone names are kept as aliases so callers across
// the app keep working, but each one now resolves to a token pair that is legible
// in both themes. Green text uses the darker brand green because --success on
// --success-bg is only 4.06:1 at the 11px badge size.
const BADGE_TONES: Record<BadgeTone, string> = {
  slate: 'border-[var(--border)] bg-[var(--surface-subtle)] text-[var(--text-secondary)]',
  green:
    'border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--color-brand-secondary)]',
  amber: 'border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn)]',
  red: 'border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)]',
  indigo: 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-dark)]',
  violet: 'border-[var(--accent)] bg-[var(--surface)] text-[var(--accent-dark)]',
  sky: 'border-[var(--info-border)] bg-[var(--info-bg)] text-[var(--info)]',
}

export function Badge({
  children,
  tone = 'slate',
  className,
}: {
  children: ReactNode
  tone?: BadgeTone
  className?: string
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        BADGE_TONES[tone] ?? BADGE_TONES.slate,
        className,
      )}
    >
      {children}
    </span>
  )
}

export const RISK_TONE: Record<RiskLevel, BadgeTone> = {
  CRITICAL_DISQUALIFIER: 'red',
  POINT_SCORED: 'sky',
  INFORMATIONAL: 'slate',
}

export const RISK_LABEL: Record<RiskLevel, string> = {
  CRITICAL_DISQUALIFIER: 'Disqualifier',
  POINT_SCORED: 'Points',
  INFORMATIONAL: 'Info',
}

export const STATUS_TONE: Record<FulfillmentStatus, BadgeTone> = {
  FULFILLED: 'green',
  ACTION_REQUIRED: 'amber',
  OUTSTANDING: 'red',
  NOT_APPLICABLE: 'slate',
}

export const STATUS_LABEL: Record<FulfillmentStatus, string> = {
  FULFILLED: 'Fulfilled',
  ACTION_REQUIRED: 'Action required',
  OUTSTANDING: 'Outstanding',
  NOT_APPLICABLE: 'N/A',
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        'inline-block size-4 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-[var(--accent)]',
        className,
      )}
      aria-hidden="true"
    />
  )
}

// ── form fields (shared by the overlay forms) ─────────────────────────────────

export const FORM_CONTROL_CLASS =
  'w-full min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] hover:border-[var(--border-hover)] focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)]'

export const FORM_LABEL_CLASS = 'mb-1 block text-[11px] font-medium text-[var(--text-secondary)]'

/**
 * A 24x24 checkbox: `size-6` is `calc(var(--spacing) * 6)` = 24px on both axes,
 * the minimum pointer target the a11y lane enforces.
 *
 * It is a SIZE class rather than a smaller box grown by padding or a transparent
 * border, because on a native checkbox neither of those grows anything. Measured
 * in the built app (the certified-document checkbox in `DocumentsPage`, read with
 * `getBoundingClientRect()` and `getComputedStyle()`):
 *
 *   * `size-4 p-1` — computed `padding` is `0px`, so the box measures 16x16;
 *   * `size-4 box-content border-4 border-transparent` — `box-sizing:
 *     content-box` does apply, but computed `border-width` is `0px` and
 *     `border-style` is `none`, so the box still measures 15.98x15.98. This was
 *     the class's own claim of "a 24x24 pointer target", and the a11y lane
 *     reported the control at 16x16 — the defect this replaces;
 *   * `size-6` — measures 23.93x23.93, i.e. the same 24px box this app renders as
 *     16px for a 16px target (the device-pixel scale reports 15.98 for 16).
 *
 * The drop is specific to the native control, not to the author's styles: the
 * same inline `padding: 4px; border: 4px solid` on a text input is honoured
 * (`4px 4px` computed, `border-style: solid`), and on a checkbox comes back as
 * `0px` / `none`. So the size class has to be the whole fix: it sets the rendered
 * box directly, with nothing left for `box-sizing` to reinterpret.
 *
 * Shared by the overlay forms that tick a row: the certified-document checkbox in
 * `DocumentsPage`, the signature checklist in `ReadinessDrawer` and the "Ready"
 * flag on a required document in `CustomerFormDialog`.
 */
export const FORM_CHECKBOX_CLASS =
  'size-6 cursor-pointer rounded accent-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none'

export interface FormFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  required?: boolean
  error?: string | null
  hint?: string
  type?: string
  textarea?: boolean
  rows?: number
  className?: string
  autoFocus?: boolean
}

export function FormField({
  label,
  value,
  onChange,
  placeholder,
  required,
  error,
  hint,
  type = 'text',
  textarea,
  rows = 3,
  className,
  autoFocus,
}: FormFieldProps) {
  const id = useId()
  const describedBy = `${id}-help`
  const described = error || hint ? describedBy : undefined
  return (
    <div className={className}>
      <label htmlFor={id} className={FORM_LABEL_CLASS}>
        {label}
        {required && (
          <span className="text-[var(--danger-text)]" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {textarea ? (
        <textarea
          id={id}
          rows={rows}
          value={value}
          placeholder={placeholder}
          required={required}
          data-autofocus={autoFocus ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          onChange={(event) => onChange(event.target.value)}
          className={clsx('resize-y', FORM_CONTROL_CLASS)}
        />
      ) : (
        <input
          id={id}
          type={type}
          value={value}
          placeholder={placeholder}
          required={required}
          autoFocus={autoFocus}
          data-autofocus={autoFocus ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          onChange={(event) => onChange(event.target.value)}
          className={FORM_CONTROL_CLASS}
        />
      )}
      {(error || hint) && (
        <p
          id={describedBy}
          role={error ? 'alert' : undefined}
          className={clsx(
            'mt-1 text-[11px]',
            error ? 'font-medium text-[var(--danger-text)]' : 'text-[var(--text-tertiary)]',
          )}
        >
          {error || hint}
        </p>
      )}
    </div>
  )
}

export function FormSelect({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  className?: string
}) {
  const id = useId()
  return (
    <div className={className}>
      <label htmlFor={id} className={FORM_LABEL_CLASS}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={FORM_CONTROL_CLASS}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}
