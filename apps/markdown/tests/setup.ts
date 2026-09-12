import { loadLocale } from '../src/renderer/i18n/locale'

// Domain modules translate through the module-level `t`, which renders the key
// verbatim until the active locale chunk has loaded (the app awaits this at
// boot). Tests assert on real copy, so load zh once per test file first.
await loadLocale('zh')
