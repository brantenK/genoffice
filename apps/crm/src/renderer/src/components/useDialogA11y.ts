import { useEffect, type RefObject } from 'react'

export function useDialogA11y(
  ref: RefObject<HTMLElement | null>,
  onEscape: () => void,
  initialFocus?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const root = ref.current
    const focusables = () =>
      root
        ? Array.from(
            root.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
            ),
          )
        : []
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onEscape()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault()
        items[items.length - 1].focus()
      } else if (!event.shiftKey && document.activeElement === items[items.length - 1]) {
        event.preventDefault()
        items[0].focus()
      }
    }
    root?.addEventListener('keydown', onKey)
    if (root && !root.contains(document.activeElement)) {
      ;(initialFocus?.current || focusables()[0] || root).focus()
    }
    return () => {
      root?.removeEventListener('keydown', onKey)
      opener?.focus()
    }
  }, [ref, onEscape])
}
