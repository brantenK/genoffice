/**
 * `SaveStatus` rendered for real.
 *
 * Replaces the source guard that stood in for this component in
 * `tests/diagnostics.test.ts` ("SaveStatus cannot render `Saved` for the no-bridge
 * kind (source guard)"), which read `components/SaveStatus.tsx` as text and
 * asserted against its label map. That guard could not tell a rendered pill from
 * an unreachable constant: it passed for any file containing the right strings,
 * and would have failed on a rename that changed nothing a user sees. Every claim
 * below is a property of the tree the component produces.
 *
 * The claims are the ones a support engineer would have to answer for:
 *   * "Saved" is printed only for `saved` — never for a build with no write path
 *     (`no-bridge`), whose label is the honest "Cannot save";
 *   * an alert state is announced as an alert and keeps its own name;
 *   * the size advisory never becomes an alert, and never replaces a status;
 *   * the retry / reload actions exist, are buttons, and run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SaveStatusKind } from '../../src/renderer/src/components/SaveStatus'
import { SaveStatus } from '../../src/renderer/src/components/SaveStatus'
import { mount, unmountAll, type RenderResult } from '../helpers/render'

afterEach(() => {
  unmountAll()
})

const render = (props: Parameters<typeof SaveStatus>[0]): RenderResult =>
  mount(<SaveStatus {...props} />)

describe('SaveStatus prints the truth about the state it is handed', () => {
  it('prints "Saved" for the saved state, and only for the saved state', () => {
    const saved = render({ status: 'saved' })
    expect(saved.text()).toContain('Saved')
    expect(saved.queryByRole('status'), 'a settled save is a status, not an alert').not.toBeNull()
    expect(saved.queryByRole('alert')).toBeNull()

    // The state a build without a preload bridge is in: nothing can ever be
    // written, so "Saved" would be a lie. The label says the fact instead.
    const noBridge = render({ status: 'no-bridge' })
    expect(noBridge.text()).toContain('Cannot save')
    expect(noBridge.text()).not.toContain('Saved')
    expect(noBridge.queryByRole('alert'), 'a save that never happened is an alert').not.toBeNull()
  })

  it('prints a label for every state the store can set', () => {
    // An unhandled kind would render `undefined` into the pill; naming each one
    // also pins that `no-bridge` never borrows another state's label.
    const labels: Record<SaveStatusKind, string> = {
      loading: 'Loading…',
      saving: 'Saving…',
      saved: 'Saved',
      error: 'Save failed',
      conflict: 'Conflict',
      'no-bridge': 'Cannot save',
    }
    for (const [status, label] of Object.entries(labels) as Array<[SaveStatusKind, string]>) {
      const view = render({ status, message: 'detail here', onRetry: () => {}, onReload: () => {} })
      expect(view.text(), `${status} must print its own label`).toContain(label)
      expect(view.text(), `${status} must not render an unhandled label`).not.toContain('undefined')
    }
  })

  it('announces a failure as an alert carrying the reason, never as a quiet status', () => {
    const view = render({
      status: 'error',
      message: 'the store file is unreadable',
      onRetry: () => {},
    })
    const alert = view.getByRole('alert')
    expect(view.nameOf(alert)).toContain('Save failed')
    expect(view.text()).toContain('the store file is unreadable')
    expect(view.queryByRole('status'), 'an alert is not a status').toBeNull()
  })

  it('renders Retry as a real button that runs, and keeps the button role', () => {
    const onRetry = vi.fn()
    const view = render({ status: 'error', message: 'disk full', onRetry })
    const retry = view.getByRole('button', { name: 'Retry' })
    view.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('renders Reload from disk for a conflict, and runs it', () => {
    const onReload = vi.fn()
    const view = render({ status: 'conflict', message: 'revision 4 is on disk', onReload })
    view.click(view.getByRole('button', { name: 'Reload from disk' }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('never invents an action the state cannot take', () => {
    // No callback, no control: a Retry button with nothing behind it would be a
    // dead end the user could click forever.
    const view = render({ status: 'error', message: 'disk full' })
    expect(view.queryByRole('button')).toBeNull()
  })
})

describe('the size advisory is a heads-up, never an alert and never a status', () => {
  it('shows the advisory beside a settled save without becoming an alert', () => {
    const view = render({ status: 'saved', warning: 'the document is close to the save ceiling' })
    expect(view.text()).toContain('Saved')
    expect(view.text()).toContain('the document is close to the save ceiling')
    expect(view.queryByRole('alert'), 'a filling document is not a failure').toBeNull()
    expect(view.queryByRole('status')).not.toBeNull()
  })

  it('drops the advisory while a save is in flight, so the status is never replaced', () => {
    const view = render({ status: 'saving', warning: 'the document is close to the save ceiling' })
    expect(view.text()).toContain('Saving…')
    expect(view.text()).not.toContain('the document is close to the save ceiling')
  })

  it('treats a plain message on a settled status as an advisory, not as an alert', () => {
    // A call site with one string must not silently lose it, and must not turn
    // it into an alert either.
    const view = render({ status: 'saved', message: 'large document' })
    expect(view.text()).toContain('large document')
    expect(view.queryByRole('alert')).toBeNull()
  })
})

describe('the compact rail says the same thing in the space it has', () => {
  it('keeps the state in the accessible name beside the action that recovers it', () => {
    const onRetry = vi.fn()
    const view = render({ status: 'error', message: 'disk full', compact: true, onRetry })
    const button = view.getByRole('button', { name: /Save failed/ })
    const name = view.nameOf(button)
    // The state and the action are both in the name the rail control announces.
    expect(name).toContain('disk full')
    expect(name).toContain('Retry')
    // `alert` on the control would replace the button role, and the user would no
    // longer be told this is the control that recovers the save.
    expect(view.getByRole('alert')).not.toBe(button)
    view.click(button)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('announces the no-write-path state without ever reaching a success label', () => {
    const view = render({ status: 'no-bridge', message: 'no bridge', compact: true })
    expect(view.nameOf(view.getByRole('alert'))).toContain('Cannot save')
    expect(view.text()).not.toContain('Saved')
  })

  it('announces a settled state through its own name, with no alert in a healthy build', () => {
    const view = render({ status: 'saved', compact: true })
    expect(view.nameOf(view.getByRole('status'))).toBe('Saved')
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.text()).not.toContain('Cannot save')
  })
})
