/**
 * Drawer placement guard — the drawer's close control must be hit-testable.
 *
 * The workspace toolbar is `position: sticky; z-index: 30`
 * (`src/renderer/src/styles/responsive.css`) because it owns the overflow menu,
 * whose popup has to paint above the pane headers. A drawer is a sibling subtree
 * of that bar, so it can never out-rank it; instead its box starts at the bar's
 * bottom edge. `toolbarBottomOffset` is that measured y.
 *
 * jsdom has no layout engine, so the geometry is stubbed here and the arithmetic
 * is what is under test (containing-block resolution, rounding, the clamp and
 * the no-toolbar fallback). The rendered end-to-end proof — opening each
 * Drawer-based aside and asserting `document.elementFromPoint` at the close
 * control's centre returns the close control — lives in
 * `e2e/tenders-a11y-theme.spec.ts` (test 6), because it needs a real layout
 * engine and a built renderer.
 */
import { describe, expect, it } from 'vitest'
import { toolbarBottomOffset } from '../src/renderer/src/components/Drawer'

/** jsdom returns zeroed rects, so every measurement below is explicit. */
function stubRect(element: Element, top: number, bottom: number): void {
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: top,
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      toJSON: () => ({}),
    }) as unknown as DOMRect
}

interface Fixture {
  main: HTMLElement
  toolbar: HTMLElement
  /** A positioned wrapper between the panel and `<main>` (the containing block). */
  block: HTMLElement
  panel: HTMLElement
}

function fixture(): Fixture {
  document.body.innerHTML = ''
  const main = document.createElement('main')
  const toolbar = document.createElement('div')
  toolbar.className = 'workspace-context-header'
  const split = document.createElement('div')
  const block = document.createElement('div')
  const panel = document.createElement('aside')
  block.appendChild(panel)
  split.appendChild(block)
  main.append(toolbar, split)
  document.body.appendChild(main)
  // jsdom cannot resolve `offsetParent`, so the positioned ancestor is stated.
  Object.defineProperty(panel, 'offsetParent', { value: block, configurable: true })
  return { main, toolbar, block, panel }
}

describe('drawer placement below the workspace toolbar', () => {
  it('starts the drawer at the toolbar bottom edge', () => {
    const { main, toolbar, panel } = fixture()
    stubRect(main, 0, 600)
    stubRect(toolbar, 0, 44)
    expect(toolbarBottomOffset(panel, toolbar)).toBe(44)
  })

  it('follows a toolbar that wraps and grows with text zoom', () => {
    const { main, toolbar, panel } = fixture()
    stubRect(main, 0, 600)
    // 200% text zoom wraps the toolbar onto two rows (measured 97px in the
    // responsive lane), and the offset must track it rather than a constant.
    stubRect(toolbar, 0, 97)
    expect(toolbarBottomOffset(panel, toolbar)).toBe(97)
  })

  it('measures from the drawer own containing block, not the workspace top', () => {
    const { toolbar, block, panel } = fixture()
    stubRect(toolbar, 0, 44)
    stubRect(block, 20, 600)
    expect(toolbarBottomOffset(panel, toolbar)).toBe(24)
  })

  it('rounds sub-pixel measurements to whole pixels', () => {
    const { main, toolbar, panel } = fixture()
    stubRect(main, 0, 600)
    stubRect(toolbar, 0, 44.6)
    expect(toolbarBottomOffset(panel, toolbar)).toBe(45)
    stubRect(toolbar, 0, 43.4)
    expect(toolbarBottomOffset(panel, toolbar)).toBe(43)
  })

  it('never returns a negative offset when the toolbar sits above the block', () => {
    const { main, toolbar, panel } = fixture()
    stubRect(main, 0, 600)
    stubRect(toolbar, -80, -20)
    expect(toolbarBottomOffset(panel, toolbar)).toBe(0)
  })

  it('falls back to the top of the workspace when there is no toolbar', () => {
    const { panel } = fixture()
    expect(toolbarBottomOffset(panel, null)).toBe(0)
  })

  it('falls back to the workspace <main> when the panel reports no offsetParent', () => {
    const { main, toolbar, panel } = fixture()
    Object.defineProperty(panel, 'offsetParent', { value: null, configurable: true })
    stubRect(main, 0, 600)
    stubRect(toolbar, 0, 44)
    expect(toolbarBottomOffset(panel, toolbar)).toBe(44)
  })

  it('falls back to the top when the panel has no containing block or workspace', () => {
    const panel = document.createElement('aside')
    const toolbar = document.createElement('div')
    stubRect(toolbar, 0, 44)
    // Detached: no offsetParent and no <main> ancestor.
    Object.defineProperty(panel, 'offsetParent', { value: null, configurable: true })
    expect(toolbarBottomOffset(panel, toolbar)).toBe(0)
  })
})
