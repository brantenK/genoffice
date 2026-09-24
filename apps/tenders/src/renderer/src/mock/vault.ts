// Mock company vault — "Thabo Engineering (Pty) Ltd".
// Dates are fixed ISO values (deterministic demo); the app computes health
// against the real current date at runtime.
//
// `fileUrl` keeps the ABSOLUTE `/demo/vault/…` form on purpose. These bytes are
// part of the frozen historical demo domain that v1→v2 demo recognition compares
// in full (`HISTORICAL_DEMO_CANONICAL_BASE64` in shared/tenders-schema.ts, and
// the digest locked in tests/store-migrations.test.ts): editing one of them makes
// an existing on-disk v1 demo file classify as `user`, i.e. demo data silently
// promoted to user data. The value is therefore never used as a URL directly —
// `openDemoAsset` resolves it to the document-relative `./demo/vault/…` form,
// which is what `publicDir` ships next to `index.html` and what actually loads.
import { type VaultDoc } from '../../shared/types'

export const MOCK_VAULT: VaultDoc[] = [
  {
    id: 'vd-tax',
    title: 'SARS Tax Clearance Certificate (TCS PIN)',
    category: 'COMPLIANCE',
    fileUrl: '/demo/vault/tax-clearance.pdf',
    issueDate: '2026-07-12',
    expiryDate: '2027-07-12',
    isCertified: false,
    certifiedDate: null,
    metadata: { 'TCS PIN': 'CITX-2026-884-0192', Status: 'Active — compliant' },
  },
  {
    id: 'vd-coida',
    title: 'COIDA Letter of Good Standing',
    category: 'COMPLIANCE',
    fileUrl: '/demo/vault/coida-good-standing.pdf',
    issueDate: '2025-07-05',
    expiryDate: '2026-07-04',
    isCertified: false,
    certifiedDate: null,
    metadata: { 'Compensation Fund ref': 'CF-771902', Status: 'EXPIRED' },
  },
  {
    id: 'vd-bbbee',
    title: 'B-BBEE Sworn Affidavit (EME)',
    category: 'COMPLIANCE',
    fileUrl: '/demo/vault/bbbee-affidavit.pdf',
    issueDate: '2026-04-10',
    expiryDate: '2027-04-09',
    isCertified: true,
    certifiedDate: '2026-04-10',
    metadata: { Level: 'Level 1 (EME)', 'Black ownership': '100%' },
  },
  {
    id: 'vd-cipc',
    title: 'CIPC Certificate of Incorporation',
    category: 'GOVERNANCE',
    fileUrl: '/demo/vault/cipc-registration.pdf',
    issueDate: '2014-03-20',
    expiryDate: null,
    isCertified: false,
    certifiedDate: null,
    metadata: { 'Registration number': 'CK2014/1234567/07', Status: 'In business' },
  },
  {
    id: 'vd-directors',
    title: 'Certified ID Copies — Directors',
    category: 'COMPLIANCE',
    fileUrl: '/demo/vault/director-ids.pdf',
    issueDate: null,
    expiryDate: null,
    isCertified: true,
    certifiedDate: '2026-08-18',
    metadata: {
      Directors: 'T. Mokoena, L. Naidoo, S. Sithole',
      'Certified by': 'SA Police Services',
    },
  },
  {
    id: 'vd-sbd',
    title: 'Completed SBD 4 Returnable Form',
    category: 'GOVERNANCE',
    fileUrl: null,
    issueDate: null,
    expiryDate: null,
    isCertified: false,
    certifiedDate: null,
    metadata: { Status: 'Signed, on file' },
  },
  {
    id: 'vd-csd',
    title: 'CSD Registration Report',
    category: 'COMPLIANCE',
    fileUrl: null,
    issueDate: '2026-01-15',
    expiryDate: null,
    isCertified: false,
    certifiedDate: null,
    metadata: { 'Supplier number': 'MAZE-4451902', Status: 'Active' },
  },
]

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
