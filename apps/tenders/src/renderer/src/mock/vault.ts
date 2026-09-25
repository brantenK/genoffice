// Mock company vault — "Thabo Engineering (Pty) Ltd".
// Dates are fixed ISO values (deterministic demo); the app computes health
// against the real current date at runtime.
//
// The DATA (`MOCK_VAULT`) now lives in `shared/demo-seed.ts`, so `main` can read
// it without importing the renderer. The two helpers below are the renderer's
// own and stay here: they touch `fetch`, `URL.createObjectURL` and `window.open`,
// which a Node main process must never reach.
//
// `fileUrl` keeps the ABSOLUTE `/demo/vault/…` form on purpose. These bytes are
// part of the frozen historical demo domain that v1→v2 demo recognition compares
// in full (`HISTORICAL_DEMO_CANONICAL_BASE64` in shared/tenders-schema.ts, and
// the digest locked in tests/store-migrations.test.ts): editing one of them makes
// an existing on-disk v1 demo file classify as `user`, i.e. demo data silently
// promoted to user data. The value is therefore never used as a URL directly —
// `openDemoAsset` resolves it to the document-relative `./demo/vault/…` form,
// which is what `publicDir` ships next to `index.html` and what actually loads.

export { MOCK_VAULT } from '../../../shared/demo-seed'

/**
 * The fetchable, document-relative form of a demo asset reference.
 *
 * The stored demo domain keeps the absolute `/demo/…` form (see the note above);
 * under `file://` that resolves against the DRIVE ROOT (`file:///C:/demo/…`) and
 * can never load. `publicDir` copies `apps/tenders/public/**` into
 * `out/renderer/**`, so the asset is a sibling of `index.html` and `./demo/…`
 * resolves correctly in a packaged build and in the dev server.
 */
export function demoAssetRelativeUrl(url: string): string {
  return url.startsWith('/demo/') ? `.${url}` : url
}

/**
 * Open a bundled demonstration asset.
 *
 * A demo PDF cannot be opened by URL: `applyTendersNavigationPolicy` denies
 * every navigation that is not the trusted renderer document or a `blob:` URL
 * (`window.open` of the asset itself returns `null`), and the managed
 * `openDocument` IPC refuses a bundle path because `resolveSafeTendersPath`
 * confines it to `<userData>/tenders/{documents,vault}`. Reading the asset and
 * opening the resulting in-memory `blob:` URL is the one route the policy
 * allows, and the renderer is the only party that can read the bundle.
 *
 * Throws with a plain-language reason when the asset cannot be read or the
 * window is blocked, so the caller can show it instead of failing silently.
 */
export async function openDemoAsset(url: string): Promise<void> {
  let objectUrl: string
  try {
    const response = await fetch(demoAssetRelativeUrl(url))
    if (!response.ok) throw new Error(`the bundled file answered HTTP ${response.status}`)
    objectUrl = URL.createObjectURL(await response.blob())
  } catch (err) {
    throw new Error(
      `the bundled demonstration file could not be read (${
        err instanceof Error ? err.message : String(err)
      })`,
    )
  }
  if (!window.open(objectUrl, '_blank')) {
    URL.revokeObjectURL(objectUrl)
    throw new Error('the window was blocked before the demonstration file could be shown')
  }
  // The new window owns the document now; release the object URL once it has had
  // time to read it.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
}
