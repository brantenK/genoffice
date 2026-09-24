/**
 * Fixtures for the "Find tenders" pane journey
 * (`tenders-discovery.spec.ts`).
 *
 * The pane reads a feed that this test must not touch. Two facts decide the
 * shape of this module:
 *
 *  * **The live feed cannot be faked from here.** The discovery client validates
 *    every URL against a fixed allow-list of National Treasury hosts
 *    (`DISCOVERY_ALLOWED_HOSTS`) before it requests anything, and the only seam
 *    that can replace its network (`setTendersEngineOverrides`) is main-process
 *    code the built shell never calls. So a local fake OCDS server would never
 *    be reached, and pointing the journey at the real feed would make it depend
 *    on the public internet — which these specs must never do.
 *  * **The cache is the offline half of the feature, and it is a file.** Main
 *    reads the last successful fetch from
 *    `<userData>/tenders/discovery/discovery-cache.json` (see
 *    `discoveryCacheDir`), which is exactly the path this module writes. A cache
 *    written before launch is what a user has after a successful fetch with no
 *    network afterwards, so the journey drives the real pane over real stored
 *    records with zero requests.
 *
 * The records themselves are built by the app's OWN core: raw OCDS releases go
 * through `parseOcdsPage`, and the envelope through `createDiscoveryCache`. So
 * the fixture cannot drift from the shape the client writes, and the journey
 * asserts against the same `describeCoverage()` statement the app shows.
 *
 * The one document link that is not on a Treasury host is deliberate, and it is
 * the only document action the journey can take without leaving the machine: the
 * download is refused by the allow-list BEFORE any request, which is precisely
 * the honest failure the pane has to surface. Every other listing links nothing
 * (or links on etenders.gov.za and is never downloaded).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DISCOVERY_CACHE_FILE_NAME,
  discoveryCacheDir,
} from '../apps/tenders/src/main/discovery-client'
import {
  createDiscoveryCache,
  DISCOVERY_ALLOWED_HOSTS,
  parseOcdsPage,
  type DiscoveryCacheEnvelope,
  type DiscoveryWindow,
} from '../apps/tenders/src/shared/discovery'

// ── the company the journey creates ──────────────────────────────────────────

/** Trading name the first-use dialog is filled with. */
export const DISCOVERY_COMPANY = 'E2E Discovery Water Works (Pty) Ltd'

/**
 * What the profile states. The address decides the province filter and the
 * industry decides the relevance terms (`deriveDiscoveryFilter`), so both are
 * asserted in the journey as the pane's seeded state.
 */
export const DISCOVERY_COMPANY_INDUSTRY = 'Bulk water pipeline construction'
export const DISCOVERY_COMPANY_ADDRESS = 'Cape Town'

/** The province those two imply, and the terms they imply (sorted by the core). */
export const DISCOVERY_PROFILE_PROVINCE = 'Western Cape'
export const DISCOVERY_PROFILE_KEYWORDS = ['bulk', 'construction', 'pipeline', 'water'] as const

// ── listings ─────────────────────────────────────────────────────────────────

/** A document link on a Treasury host: what the feed really links. */
export const TREASURY_DOCUMENT_URL = `https://${DISCOVERY_ALLOWED_HOSTS[2]}/Documents/e2e-discovery-rfp.pdf`

/**
 * A document link on a host the app is not allowed to read. Clicking "Add to
 * workspace" on it exercises the allow-list refusal with nothing fetched.
 */
export const OFF_ALLOWLIST_DOCUMENT_URL = 'https://not-a-treasury-host.test/e2e-discovery-rfp.pdf'

/** Titles the journey locates rows by. */
export const LISTING_WITH_CLOSING = 'Bulk water pipeline rehabilitation, Cape Town'
export const LISTING_WITHOUT_CLOSING = 'Supply and delivery of water metering equipment'
export const LISTING_NO_DOCUMENTS = 'Construction of a new reservoir, Stellenbosch'
export const LISTING_OTHER_PROVINCE = 'Supply of office furniture to the City of Tshwane'

/** The value the first listing states, printed by the pane as rand. */
export const LISTING_WITH_CLOSING_VALUE = 850_000

/**
 * A civil closing date `days` from now, in the form the feed uses and the app's
 * own parser reads (`30 November 2026 at 11:00`). Relative to the run so the
 * journey does not start failing the moment a fixed date passes.
 */
export function closingTextInDays(days: number): string {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ]
  // SAST is UTC+2 all year, so shifting the instant and reading UTC parts gives
  // the civil date the closing text means.
  const sast = new Date(Date.now() + days * 86_400_000 + 2 * 3_600_000)
  return `${sast.getUTCDate()} ${months[sast.getUTCMonth()]} ${sast.getUTCFullYear()} at 11:00`
}

/** Days from now the first listing closes; comfortably outside the 7-day band. */
export const LISTING_WITH_CLOSING_IN_DAYS = 45
/** Days from now the third listing closes. */
export const LISTING_NO_DOCUMENTS_IN_DAYS = 70

/** The publication window the saved list records. */
export function savedWindow(): DiscoveryWindow {
  const civil = (instant: Date): string => instant.toISOString().slice(0, 10)
  return { from: civil(new Date(Date.now() - 7 * 86_400_000)), to: civil(new Date()) }
}

interface ReleaseSpec {
  ocid: string
  title: string
  description: string
  buyer: string
  reference: string
  category: string
  /** Absent means the source stated no closing date at all. */
  closing?: string
  amount?: number
  documents?: { url: string; title: string }[]
}

/** One raw OCDS release, in the shape the live API answers with. */
function ocdsRelease(spec: ReleaseSpec): Record<string, unknown> {
  return {
    ocid: spec.ocid,
    id: `${spec.ocid}-01`,
    date: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    tag: ['tender'],
    buyer: { name: spec.buyer },
    tender: {
      id: spec.reference,
      title: spec.title,
      description: spec.description,
      status: 'active',
      mainProcurementCategory: spec.category,
      ...(spec.closing ? { tenderPeriod: { endDate: spec.closing } } : {}),
      ...(spec.amount ? { value: { amount: spec.amount, currency: 'ZAR' } } : {}),
      documents: (spec.documents ?? []).map((document) => ({
        url: document.url,
        title: document.title,
        format: 'application/pdf',
        documentType: 'tenderNotice',
      })),
    },
  }
}

/**
 * The four releases the saved list carries. One closes and states a value, one
 * states no closing date at all, one links no document, and one sits in another
 * province — so the journey can assert the countdown, the honest flag, the
 * "nothing to add" case and the province filter with one cache.
 */
export function discoveryReleases(): Record<string, unknown>[] {
  return [
    ocdsRelease({
      ocid: 'ocds-e2e-0001',
      title: LISTING_WITH_CLOSING,
      description: 'Rehabilitation of the existing bulk water pipeline network.',
      buyer: 'City of Cape Town',
      reference: 'E2E/WC/2026/0001',
      category: 'goods',
      closing: closingTextInDays(LISTING_WITH_CLOSING_IN_DAYS),
      amount: LISTING_WITH_CLOSING_VALUE,
      documents: [{ url: OFF_ALLOWLIST_DOCUMENT_URL, title: 'e2e-discovery-rfp.pdf' }],
    }),
    ocdsRelease({
      ocid: 'ocds-e2e-0002',
      title: LISTING_WITHOUT_CLOSING,
      description: 'Metering equipment for municipal distribution networks.',
      buyer: 'Western Cape Department of Transport and Public Works',
      reference: 'E2E/WC/2026/0002',
      category: 'goods',
      documents: [{ url: TREASURY_DOCUMENT_URL, title: 'e2e-discovery-rfp.pdf' }],
    }),
    ocdsRelease({
      ocid: 'ocds-e2e-0003',
      title: LISTING_NO_DOCUMENTS,
      description: 'Construction of a raw water balancing reservoir.',
      buyer: 'Stellenbosch Municipality',
      reference: 'E2E/WC/2026/0003',
      category: 'works',
      closing: closingTextInDays(LISTING_NO_DOCUMENTS_IN_DAYS),
    }),
    ocdsRelease({
      ocid: 'ocds-e2e-0004',
      title: LISTING_OTHER_PROVINCE,
      description: 'Office furniture for municipal offices.',
      buyer: 'City of Tshwane',
      reference: 'E2E/GP/2026/0004',
      category: 'goods',
      closing: closingTextInDays(LISTING_NO_DOCUMENTS_IN_DAYS),
    }),
  ]
}

/**
 * The saved-list envelope, built by the app's own core from those releases, so
 * the journey reads records the parser itself produced.
 */
export function discoveryCacheEnvelope(
  overrides: Partial<DiscoveryCacheEnvelope> = {},
): DiscoveryCacheEnvelope {
  const parsed = parseOcdsPage({ releases: discoveryReleases() })
  if (parsed.opportunities.length !== 4) {
    throw new Error(
      `the discovery fixture must parse into four listings, got ${parsed.opportunities.length}`,
    )
  }
  return createDiscoveryCache({
    // Older than the freshness window, so the pane's stale copy is exercised:
    // "the saved list is old" is the state a real user is most likely to be in.
    fetchedAt: new Date(Date.now() - 20 * 3_600_000).toISOString(),
    window: savedWindow(),
    source: 'ocds-api',
    complete: true,
    opportunities: parsed.opportunities,
    warnings: [],
    ...overrides,
  })
}

// ── writing the cache ────────────────────────────────────────────────────────

/** The exact file main reads the saved list from. */
export function discoveryCacheFile(userDataDir: string): string {
  return join(discoveryCacheDir(userDataDir), DISCOVERY_CACHE_FILE_NAME)
}

/** Write a saved list where the app will read it (before launch). */
export async function writeDiscoveryCache(
  userDataDir: string,
  envelope: unknown = discoveryCacheEnvelope(),
): Promise<string> {
  const path = discoveryCacheFile(userDataDir)
  await mkdir(discoveryCacheDir(userDataDir), { recursive: true })
  await writeFile(path, JSON.stringify(envelope), 'utf8')
  return path
}

/**
 * Write a saved list the app cannot read. `readCache` answers `CACHE_READ` for a
 * file that is not JSON (and for one whose version or window is unusable), which
 * is the honest failure the pane has to show instead of an empty list.
 */
export async function writeDamagedDiscoveryCache(userDataDir: string): Promise<string> {
  const path = discoveryCacheFile(userDataDir)
  await mkdir(discoveryCacheDir(userDataDir), { recursive: true })
  await writeFile(path, '{"version":1,"fetchedAt":"2026-09-24T06:00:00.000Z","win', 'utf8')
  return path
}

/** The message main answers a non-Treasury document link with (no request made). */
export function allowListRefusalText(): string {
  return `Only tender documents on ${DISCOVERY_ALLOWED_HOSTS.join(', ')} can be downloaded`
}

/** The message main answers a damaged cache file with. */
export const DAMAGED_CACHE_TEXT = 'The saved tender list is damaged and could not be read.'
