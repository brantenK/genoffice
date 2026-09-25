/**
 * One source of truth for the Books version shown in the UI.
 *
 * The version is pinned to `apps/books/package.json` by
 * `tests/app-version.test.ts`, so bumping the manifest without this constant
 * (or the reverse) fails the suite instead of shipping a UI that lies.
 * A literal is used rather than importing the JSON: the module is bundled for
 * both the main process and the sandboxed renderer, and `resolveJsonModule`
 * is not guaranteed in either build's tsconfig.
 */
export const APP_VERSION = '0.1.0'

/** Alias kept for callers that prefer the explicit module-scoped name. */
export const BOOKS_VERSION = APP_VERSION

/** Display form for chrome and about surfaces, e.g. "Zano Books v0.1.0". */
export const BOOKS_VERSION_LABEL = `Zano Books v${APP_VERSION}`
