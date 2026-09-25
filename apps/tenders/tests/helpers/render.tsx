/**
 * Minimal renderer-component harness — no test-library dependency.
 *
 * WHY THIS EXISTS: several honesty claims in this app live in JSX (a chip that
 * must be visible text, an alert that must be announced, a sentence that must be
 * rendered verbatim). Without a way to render a component those claims could only
 * be asserted against comment-stripped source, which is a broken substitute: a
 * refactor that preserves behaviour can fail a source guard, and a behaviour
 * change that keeps the old wording can pass one. This harness renders the real
 * component in jsdom and lets the test ask what the user would actually see.
 *
 * WHAT IT IS NOT: it is not a test library. It uses only `react-dom/client` and
 * `act` (already dependencies of this app), and it deliberately implements a
 * small, documented subset:
 *
 *   * `mount` / `unmountAll` — render into a detached `<div>`; `act` flushes the
 *     effects and updates so queries never race React.
 *   * `getByText` / `queryByText` — whitespace-collapsed text matching, returning
 *     the DEEPEST element that carries the text (the node the user reads).
 *   * `getByRole` / `queryByRole` / `getAllByRole` — implicit and explicit ARIA
 *     roles, plus an accessible-name filter. `accessibleName` is a documented
 *     approximation of accname (see below), good enough to ask "does the user
 *     hear this?" without pulling in a spec-complete implementation.
 *   * `getByTestId` — `data-testid` lookup for surfaces that ship one.
 *   * `click` — a real bubbling click inside `act`, so handlers run.
 *   * `text()` — the whole container's rendered text, collapsed, for the "is this
 *     sentence actually on screen?" assertions.
 *
 * ACCESSIBLE NAME (approximation): `aria-labelledby` (referenced text joined),
 * then `aria-label`, then the element's own rendered text, then `title`. That
 * order is the accname order for the roles used here and it is deliberately
 * *content-aware*: a marker that lives only in a `title` still has a name, so a
 * test that wants "this is visible text, not a tooltip" must assert on `text()`,
 * not on the name. Several tests here do exactly that.
 *
 * The environment flag below is what makes `act` work outside a test library:
 * React refuses to batch updates synchronously without it.
 */
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

export interface RoleQuery {
  /** Matched against the accessible name (string = substring, RegExp = test). */
  name?: string | RegExp
}

export interface RenderResult {
  /** The detached host element holding the rendered tree. */
  readonly container: HTMLElement
  /** The whole rendered text, whitespace-collapsed. */
  text(): string
  /** True when the rendered text contains `matcher` (string = substring). */
  hasText(matcher: string | RegExp): boolean
  /** Deepest element whose own rendered text matches; throws when absent. */
  getByText(matcher: string | RegExp): HTMLElement
  /** As `getByText`, but `null` instead of throwing. */
  queryByText(matcher: string | RegExp): HTMLElement | null
  getAllByText(matcher: string | RegExp): HTMLElement[]
  getByRole(role: string, options?: RoleQuery): HTMLElement
  queryByRole(role: string, options?: RoleQuery): HTMLElement | null
  getAllByRole(role: string, options?: RoleQuery): HTMLElement[]
  getByTestId(id: string): HTMLElement
  queryByTestId(id: string): HTMLElement | null
  /** The accessible name this harness would give `element` (see the note above). */
  nameOf(element: Element): string
  /** A real, bubbling click inside `act`. */
  click(element: Element): void
  unmount(): void
}

const liveRoots = new Set<{ root: Root; container: HTMLElement }>()

function collapse(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function matches(text: string, matcher: string | RegExp): boolean {
  return typeof matcher === 'string' ? text.includes(matcher) : matcher.test(text)
}

/** Implicit ARIA roles for the element vocabulary this app renders. */
function implicitRole(element: Element): string | null {
  const tag = element.tagName.toLowerCase()
  switch (tag) {
    case 'button':
      return 'button'
    case 'a':
      return element.hasAttribute('href') ? 'link' : null
    case 'select':
      return 'combobox'
    case 'option':
      return 'option'
    case 'textarea':
      return 'textbox'
    case 'ul':
    case 'ol':
      return 'list'
    case 'li':
      return 'listitem'
    case 'progress':
      return 'progressbar'
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading'
    case 'label':
      return null
    case 'input': {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase()
      if (type === 'radio') return 'radio'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
      if (type === 'hidden') return null
      return 'textbox'
    }
    default:
      return null
  }
}

export function roleOf(element: Element): string | null {
  return element.getAttribute('role')?.trim() || implicitRole(element)
}

/**
 * See the header: `aria-labelledby` → `aria-label` → rendered text → `title`.
 * Deliberately content-aware, and documented so a test can tell which channel a
 * name came from by asserting on `text()` as well.
 */
export function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => collapse((element.ownerDocument ?? document).getElementById(id)?.textContent))
      .filter(Boolean)
    if (parts.length > 0) return parts.join(' ')
  }
  const label = element.getAttribute('aria-label')
  if (label && collapse(label)) return collapse(label)
  const content = collapse(element.textContent)
  if (content) return content
  return collapse(element.getAttribute('title'))
}

/** Every element in the subtree (including the root) satisfying `test`. */
function findAll(element: Element, test: (el: Element) => boolean): Element[] {
  const out: Element[] = []
  if (test(element)) out.push(element)
  for (const child of element.children) out.push(...findAll(child, test))
  return out
}

/**
 * The deepest element whose rendered text matches: the node the user actually
 * reads, rather than a wrapper that merely contains it.
 */
function textMatches(scope: HTMLElement, matcher: string | RegExp): HTMLElement[] {
  return findAll(
    scope,
    (el) =>
      el !== scope &&
      matches(collapse(el.textContent), matcher) &&
      !Array.from(el.children).some((child) => matches(collapse(child.textContent), matcher)),
  ) as HTMLElement[]
}

function describe(node: Element | null): string {
  if (!node) return '(none)'
  return `${node.tagName.toLowerCase()} role=${roleOf(node) ?? '-'} name="${accessibleName(node)}"`
}

export function mount(ui: ReactElement): RenderResult {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const entry = { root, container }
  liveRoots.add(entry)
  act(() => {
    root.render(ui)
  })

  const rendered = (): string => collapse(container.textContent)

  const roleMatches = (role: string, options?: RoleQuery): HTMLElement[] =>
    findAll(container, (el) => el !== container && roleOf(el) === role).filter((el) =>
      options?.name ? matches(accessibleName(el), options.name) : true,
    ) as HTMLElement[]

  return {
    container,
    text: rendered,
    hasText: (matcher) => matches(rendered(), matcher),
    getAllByText: (matcher) => textMatches(container, matcher),
    getByText(matcher) {
      const found = textMatches(container, matcher)
      if (found.length === 0) throw new Error(`No element renders text ${String(matcher)}`)
      return found[0]
    },
    queryByText(matcher) {
      return textMatches(container, matcher)[0] ?? null
    },
    getAllByRole: (role, options) => roleMatches(role, options),
    getByRole(role, options) {
      const found = roleMatches(role, options)
      if (found.length === 0) {
        const present = findAll(container, (el) => el !== container)
          .map(describe)
          .slice(0, 40)
          .join(' | ')
        throw new Error(
          `No element with role "${role}"${options?.name ? ` named ${String(options.name)}` : ''}. Present: ${present}`,
        )
      }
      return found[0]
    },
    queryByRole(role, options) {
      return roleMatches(role, options)[0] ?? null
    },
    getByTestId(id) {
      const found = container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
      if (!found) throw new Error(`No element with data-testid="${id}"`)
      return found
    },
    queryByTestId: (id) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`),
    nameOf: accessibleName,
    click(element) {
      act(() => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
    },
    unmount() {
      liveRoots.delete(entry)
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/** Unmount everything `mount` created — call from `afterEach`. */
export function unmountAll(): void {
  for (const entry of [...liveRoots]) {
    liveRoots.delete(entry)
    act(() => {
      entry.root.unmount()
    })
    entry.container.remove()
  }
}
