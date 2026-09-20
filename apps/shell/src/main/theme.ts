// Suite theme resolution (Phase 5 — system-mode propagation).
//
// The shell main process owns `nativeTheme` and is the single place that turns a
// user preference (`light | dark | system`) into the effective theme a renderer
// must apply. Electron 43 does not reliably flip `prefers-color-scheme` in any
// renderer after `nativeTheme.themeSource` changes (even the shell window stays
// `false`), so renderers must NOT resolve "system" themselves. The shell
// publishes the resolved `light | dark` value over the suite theme channels
// (`app:get-theme` + `app:theme-changed`), and `nativeTheme.on('updated')`
// republishes it when the OS appearance changes while the preference is
// `system`.
import type { UiTheme } from '../shared/home-api'

export type ResolvedTheme = 'light' | 'dark'

/** Turn a persisted preference into the concrete theme a renderer applies. */
export function resolveEffectiveTheme(
  preference: UiTheme,
  shouldUseDarkColors: boolean,
): ResolvedTheme {
  if (preference === 'light') return 'light'
  if (preference === 'dark') return 'dark'
  return shouldUseDarkColors ? 'dark' : 'light'
}

/** The subset of `electron.nativeTheme` this module depends on (test-injectable). */
export interface NativeThemeLike {
  shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
  removeListener(event: 'updated', listener: () => void): unknown
}

export interface ThemeBroadcastController {
  /** Effective theme for the current preference + OS state (computed on demand). */
  current(): ResolvedTheme
  /** Publish the effective theme, but only when it changed since the last send. */
  broadcast(): void
  /** Stop listening for OS appearance changes. */
  dispose(): void
}

/**
 * Wires `nativeTheme.on('updated')` to a deduplicated broadcast so OS appearance
 * changes propagate live while `system` is selected. The resolved value is read
 * lazily from `getPreference()` + `nativeTheme.shouldUseDarkColors`, which is
 * also what a freshly opened window gets from `app:get-theme`.
 */
export function createThemeBroadcastController(options: {
  nativeTheme: NativeThemeLike
  getPreference: () => UiTheme
  send: (theme: ResolvedTheme) => void
}): ThemeBroadcastController {
  let last: ResolvedTheme | null = null

  const current = (): ResolvedTheme =>
    resolveEffectiveTheme(options.getPreference(), options.nativeTheme.shouldUseDarkColors)

  const broadcast = (): void => {
    const resolved = current()
    if (resolved === last) return
    last = resolved
    options.send(resolved)
  }

  const onUpdated = (): void => broadcast()
  options.nativeTheme.on('updated', onUpdated)

  return {
    current,
    broadcast,
    dispose: () => options.nativeTheme.removeListener('updated', onUpdated),
  }
}
