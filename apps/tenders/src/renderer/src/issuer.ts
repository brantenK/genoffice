// Fuzzy issuer recognition. The same issuing authority renders differently
// across RFPs: "Dept of Water and Sanitation" on one letterhead, "DEPARTMENT
// OF WATER AND SANITATION" on another, "DWS" in the reference-number prefix.
// Issuer templates are therefore matched on a set of normalized ALIASES
// (canonical name + abbreviation expansion + acronym + ref prefix) instead
// of a single exact string, so recurring buyers are recognized as one entity.
import type { IssuerTemplate } from './store'

/** Words that carry no identity — skipped when generating acronyms. */
const STOP_WORDS = new Set(['OF', 'THE', 'AND', 'FOR', 'A', 'ON', 'IN', 'TO'])

/** Common SA-government abbreviations, expanded to a canonical long form. */
const ABBREVIATIONS: Record<string, string> = {
  DEPT: 'DEPARTMENT',
  GOVT: 'GOVERNMENT',
  MUNI: 'MUNICIPALITY',
  METRO: 'METROPOLITAN',
  CORP: 'CORPORATION',
  UNIV: 'UNIVERSITY',
  DIR: 'DIRECTORATE',
  MIN: 'MINISTRY',
  PROV: 'PROVINCIAL',
  NAT: 'NATIONAL'
}

/** Canonical comparison form: uppercase, punctuation stripped, single-spaced. */
export function normalizeIssuerName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Extract the reference-number prefix used as an alias, e.g.
 *  `Reference number in the style "DWS/RFP-2026/0034"` → `DWS`. */
function refPrefix(refStyle: string | null | undefined): string | null {
  if (!refStyle) return null
  const quoted = refStyle.match(/"([^"]+)"/)
  const ref = (quoted?.[1] ?? refStyle).trim()
  const prefix = ref.split('/')[0]?.trim() ?? ''
  return /^[A-Z]{2,6}$/.test(prefix) ? prefix : null
}

/** All identity-carrying forms of an issuer name, for fuzzy matching. */
export function issuerAliases(name: string, refStyle?: string | null): string[] {
  const norm = normalizeIssuerName(name)
  // expand abbreviations so "DEPT OF X" and "DEPARTMENT OF X" share a canonical
  const canonical = norm
    .split(' ')
    .map((w) => ABBREVIATIONS[w] ?? w)
    .join(' ')

  const aliases = new Set<string>([canonical])
  if (norm !== canonical) aliases.add(norm)

  // acronym from significant-word initials:
  // DEPARTMENT OF WATER AND SANITATION → DOWAS
  const words = canonical.split(' ').filter((w) => w.length > 0 && !STOP_WORDS.has(w))
  if (words.length >= 2) {
    const acronym = words.map((w) => w[0]).join('')
    if (acronym.length >= 3) aliases.add(acronym)
  }

  // the reference-number prefix is the issuer's own shorthand for itself
  const prefix = refPrefix(refStyle)
  if (prefix) aliases.add(prefix)

  return [...aliases].filter(Boolean)
}

/** Find a stored template that plausibly represents the same issuer.
 *  Two templates are the same issuer when any of their alias sets intersect. */
export function findIssuerTemplate(
  templates: IssuerTemplate[],
  name: string,
  refStyle: string | null
): IssuerTemplate | undefined {
  const incoming = new Set(issuerAliases(name, refStyle))
  return templates.find((t) => {
    const existing = issuerAliases(t.name, t.refStyle)
    // short aliases (2-letter leftovers) are too collision-prone to match on
    const matchable = existing.filter((a) => a.length >= 3)
    return matchable.some((a) => incoming.has(a))
  })
}
