import { loadLocale } from '../src/renderer/i18n/locale'

// Domain modules translate through the module-level `t`, which renders the key
// verbatim until the active locale chunk has loaded (the app awaits this at
// boot). Tests assert on real copy — zh is the default, and several suites pin
// en — so both chunks load once per test file before anything runs.
await loadLocale('zh')
await loadLocale('en')
