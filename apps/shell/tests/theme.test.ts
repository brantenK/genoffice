/**
 * Suite theme resolution + OS-change propagation (Phase 5 — system mode).
 *
 * The shell main process resolves `system` to `light | dark` because Electron 43
 * does not flip `prefers-color-scheme` in any renderer after
 * `nativeTheme.themeSource` changes. These tests cover the pure resolver and the
 * `nativeTheme.on('updated')` republish controller that backs `app:get-theme`
 * and `app:theme-changed`.
 */
import { describe, expect, it } from 'vitest'
import {
  createThemeBroadcastController,
  resolveEffectiveTheme,
  type NativeThemeLike,
  type ResolvedTheme,
} from '../src/main/theme'

class FakeNativeTheme implements NativeThemeLike {
  shouldUseDarkColors = false
  private readonly listeners = new Set<() => void>()

  on(event: 'updated', listener: () => void): this {
    if (event === 'updated') this.listeners.add(listener)
    return this
  }

  removeListener(event: 'updated', listener: () => void): this {
    if (event === 'updated') this.listeners.delete(listener)
    return this
  }

  /** Simulate an OS appearance change (fires `updated` like Electron). */
  flipTo(dark: boolean): void {
    this.shouldUseDarkColors = dark
    for (const listener of [...this.listeners]) listener()
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

describe('resolveEffectiveTheme', () => {
  it('light and dark preferences are explicit and ignore the OS', () => {
    expect(resolveEffectiveTheme('light', true)).toBe('light')
    expect(resolveEffectiveTheme('light', false)).toBe('light')
    expect(resolveEffectiveTheme('dark', true)).toBe('dark')
    expect(resolveEffectiveTheme('dark', false)).toBe('dark')
  })

  it('system follows the OS appearance', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('dark')
    expect(resolveEffectiveTheme('system', false)).toBe('light')
  })
})

describe('theme broadcast controller', () => {
  function makeController(preference: () => 'light' | 'dark' | 'system') {
    const nativeTheme = new FakeNativeTheme()
    const sent: ResolvedTheme[] = []
    const controller = createThemeBroadcastController({
      nativeTheme,
      getPreference: preference,
      send: (theme) => sent.push(theme),
    })
    return { nativeTheme, sent, controller }
  }

  it('publishes the resolved theme only when it changes', () => {
    const { nativeTheme, sent, controller } = makeController(() => 'system')
    nativeTheme.shouldUseDarkColors = false

    controller.broadcast()
    controller.broadcast() // unchanged -> deduplicated
    expect(sent).toEqual(['light'])

    nativeTheme.shouldUseDarkColors = true
    controller.broadcast()
    expect(sent).toEqual(['light', 'dark'])
  })

  it('propagates OS appearance flips live while the preference is system', () => {
    const { nativeTheme, sent, controller } = makeController(() => 'system')
    nativeTheme.shouldUseDarkColors = false
    controller.broadcast()
    expect(sent).toEqual(['light'])

    nativeTheme.flipTo(true)
    expect(sent).toEqual(['light', 'dark'])

    // A repeated event with no actual change must not spam renderers.
    nativeTheme.flipTo(true)
    expect(sent).toEqual(['light', 'dark'])

    nativeTheme.flipTo(false)
    expect(sent).toEqual(['light', 'dark', 'light'])
  })

  it('ignores OS flips when an explicit preference is set', () => {
    const { nativeTheme, sent, controller } = makeController(() => 'dark')
    controller.broadcast()
    expect(sent).toEqual(['dark'])

    nativeTheme.flipTo(false)
    nativeTheme.flipTo(true)
    expect(sent).toEqual(['dark'])
    expect(controller.current()).toBe('dark')
  })

  it('a freshly opened window resolves on demand (no prior broadcast needed)', () => {
    const nativeTheme = new FakeNativeTheme()
    nativeTheme.shouldUseDarkColors = true
    const sent: ResolvedTheme[] = []
    const controller = createThemeBroadcastController({
      nativeTheme,
      getPreference: () => 'system',
      send: (theme) => sent.push(theme),
    })
    // Models `app:get-theme` for a new window: the value is computed live, so
    // no earlier broadcast (which may have happened before the window existed)
    // is required for system mode to be correct.
    expect(controller.current()).toBe('dark')
    expect(sent).toEqual([])
  })

  it('a persisted preference survives a relaunch and still resolves', () => {
    let saved: 'light' | 'dark' | 'system' = 'dark'
    const first = makeController(() => saved)
    first.nativeTheme.shouldUseDarkColors = false
    first.controller.broadcast()
    expect(first.sent).toEqual(['dark'])

    // Relaunch: a new controller reads the persisted preference.
    const second = makeController(() => saved)
    second.nativeTheme.flipTo(true)
    expect(second.sent).toEqual(['dark']) // explicit preference wins over the OS
    expect(second.controller.current()).toBe('dark')

    // Switching back to system follows the OS again.
    saved = 'system'
    second.controller.broadcast()
    second.nativeTheme.flipTo(false)
    expect(second.sent).toEqual(['dark', 'light'])
  })

  it('dispose detaches the nativeTheme listener', () => {
    const { nativeTheme, sent, controller } = makeController(() => 'system')
    expect(nativeTheme.listenerCount).toBe(1)
    controller.dispose()
    expect(nativeTheme.listenerCount).toBe(0)

    nativeTheme.flipTo(true)
    expect(sent).toEqual([])
  })
})
