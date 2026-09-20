// Deterministic heuristic "tender shredder": scans extracted lines against the
// shared rule catalogue and produces the compliance matrix requirements with
// exact source clauses + bounding boxes. Also lifts tender metadata, scoring
// candidates across the WHOLE document and surfacing competing values so the
// review UI can ask the user instead of silently guessing.
import { DISQUALIFIER_LANGUAGE, MANDATORY_LANGUAGE, TENDER_RULES } from '../../shared/rules'
import { parseClosingDate as parseStrictClosingDate } from '../readiness'
import type { ExtractedRequirement, PageExtraction, SubmissionMethod } from '../../shared/types'
import { buildClauses, normalizePdfText, type Clause } from './clauses'

/** One candidate value with its provenance (in-memory; not persisted yet). */
export interface ValueCandidate {
  value: string
  pageNumber: number
  /** reading-order index across the whole document (deterministic) */
  firstIndex: number
}

/** A scored issuing-authority candidate. */
export interface IssuerCandidate {
  value: string
  score: number
  pageNumber: number
  firstIndex: number
}

/** A scored submission-logistics candidate. */
export interface SubmissionCandidate {
  submissionMethod: SubmissionMethod
  submissionAddress: string
  score: number
  pageNumber: number
  firstIndex: number
}

/**
 * Competing values for readiness-relevant fields. These are derived
 * (in-memory) only: persisting them is a later schema/type task. The UI can use
 * them to surface a conflict and let the user choose.
 */
export interface TenderMetaCandidates {
  referenceNumber: string[]
  issuingBody: string[]
  closingDate: string[]
  submissionMethod: SubmissionMethod[]
  submissionAddress: string[]
}

export interface TenderMeta {
  title: string
  referenceNumber: string | null
  issuingBody: string | null
  closingDate: string | null
  submissionMethod: SubmissionMethod | null
  submissionAddress: string | null
  /** every distinct candidate seen for each competing field (capped) */
  candidates: TenderMetaCandidates
  /** human-readable conflict notes when more than one candidate competes */
  conflicts: string[]
}

/** Letterhead analysis — identity of the issuing authority, for templates. */
export interface IssuerInfo {
  /** normalized (uppercase, trimmed) issuing-body name — template key */
  name: string
  displayName: string
  address: string | null
  contact: string | null
  /** description of the reference-number style, e.g. "DWS/RFP-2026/0034" */
  refStyle: string | null
}

/** max distinct clauses captured per rule */
const MAX_HITS_PER_RULE = 3

interface RuleHit {
  score: number
  clause: Clause
  pages: Set<number>
}

function clauseScore(text: string): number {
  // Sentence-level scoring: mandatory language, disqualifier language and
  // corroboration (clause length) — longer reconstructed sentences carry
  // more context, so they outrank bare mentions.
  return (
    (MANDATORY_LANGUAGE.test(text) ? 3 : 0) +
    (DISQUALIFIER_LANGUAGE.test(text) ? 2 : 0) +
    Math.min(text.length / 240, 1)
  )
}

/** near-duplicate clauses (same rule restated on cover + body) are merged */
function similarText(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const wa = norm(a).split(' ')
  const wb = norm(b).split(' ')
  if (wa.length === 0 || wb.length === 0) return false
  const setB = new Set(wb)
  const shared = wa.filter((w) => w.length > 3 && setB.has(w)).length
  return shared / Math.min(wa.length, wb.length) > 0.7
}

/** One requirement per rule — strongest clause wins, other distinct clauses
 *  are kept as corroborating hits; scored over reconstructed sentences. */
export function shredExtraction(ex: PageExtraction): ExtractedRequirement[] {
  const clauses = buildClauses(ex)
  const hits = new Map<string, RuleHit[]>()

  for (const clause of clauses) {
    const text = clause.text
    if (text.length < 8) continue
    for (const rule of TENDER_RULES) {
      if (rule.negative?.some((n) => n.test(text))) continue
      if (!rule.patterns.some((p) => p.test(text))) continue

      const score = clauseScore(text)
      const list = hits.get(rule.key) ?? []
      const entry = list.find((h) => h.clause.pageNumber === clause.pageNumber)
      if (entry) {
        entry.pages.add(clause.pageNumber)
        if (score > entry.score + 0.01) {
          entry.score = score
          entry.clause = clause
        }
      } else {
        list.push({ score, clause, pages: new Set([clause.pageNumber]) })
      }
      hits.set(rule.key, list)
    }
  }

  const requirements: ExtractedRequirement[] = []
  for (const rule of TENDER_RULES) {
    const list = hits.get(rule.key)
    if (!list || list.length === 0) continue

    list.sort((a, b) => b.score - a.score)
    const best = list[0]

    // corroborating clauses: distinct, not near-duplicates of the best
    const additional = list
      .slice(1)
      .filter((h) => !similarText(h.clause.text, best.clause.text))
      .slice(0, MAX_HITS_PER_RULE - 1)
      .map((h) => ({ text: h.clause.text, pageNumber: h.clause.pageNumber }))

    // confidence: hit strength + corroboration across clauses + mandatory language
    const allPages = new Set<number>()
    for (const h of list) for (const p of h.pages) allPages.add(p)
    const corroboration = Math.min((list.length - 1) * 0.1, 0.2)
    const confidence = Math.min(
      0.55 + Math.min(best.score / 6, 0.25) + corroboration + (allPages.size > 1 ? 0.1 : 0),
      1,
    )

    const extraPages = [...allPages]
      .filter((p) => p !== best.clause.pageNumber)
      .sort((a, b) => a - b)
    const notes: string[] = []
    if (rule.notes) notes.push(rule.notes)
    if (extraPages.length > 0) notes.push(`Also referenced on p. ${extraPages.join(', p. ')}`)

    requirements.push({
      id: `req-${rule.key}`,
      ruleKey: rule.key,
      title: rule.title,
      category: rule.category,
      isMandatory:
        rule.category === 'MANDATORY_STAGE_1' ||
        rule.riskLevel === 'CRITICAL_DISQUALIFIER' ||
        MANDATORY_LANGUAGE.test(best.clause.text),
      verbatimClause: best.clause.text,
      pageNumber: best.clause.pageNumber,
      // Fresh box per requirement: sharing one object would build a DAG that
      // bloats the persisted document and breaks identity expectations.
      boundingBox: { ...best.clause.box },
      riskLevel: rule.riskLevel,
      order: rule.order,
      // Omit empty optionals entirely — emitting `undefined` own-properties
      // makes structured-clone payloads fail JSON-style optional validation.
      ...(additional.length > 0 ? { additionalClauses: additional } : {}),
      confidence: Math.round(confidence * 100) / 100,
      ...(notes.length > 0 ? { notes: notes.join(' · ') } : {}),
    })
  }

  return requirements
}

const TITLE_HEADING =
  /(request for (proposals?|tender|quotation)s?|invitation to (bid|tender)|tender document|\brfp\b|reit)/i
const REF_RE =
  /(?:reference\s*(?:number|no\.?)?|ref(?:erence)?\s*(?:no\.?|number)?|tender\s*no\.?|bid\s*number)\s*[:#-]\s*([A-Za-z0-9][\w/.-]{2,})/i
const CLOSING_RE = /closing\s*date\s*[:-]?\s*(.+)/i

/**
 * Amendment/extension phrasings that introduce a COMPETING closing date, e.g.
 * "the closing date is amended to <date>", "date extended to <date>", and
 * "Amended Closing Date: <date>". These must surface as a second candidate so
 * the review UI can ask the user instead of silently keeping the cover date.
 */
const AMENDED_CLOSING_TO_RE =
  /\bclosing\s*(?:date|time)\b[^.]{0,60}?\b(?:amended|extended|revised|postponed|changed|brought\s+forward)\b[^.]{0,20}?\bto\b\s*[:\-]?\s*([^.]{4,80})/i
const AMENDED_CLOSING_LABEL_RE =
  /\b(?:amended|revised|extended|new|updated)\s+closing\s*(?:date|time)\s*[:\-]?\s*([^.]{4,80})/i
const DATE_EXTENDED_TO_RE =
  /\b(?:closing\s+)?date\b[^.]{0,40}?\b(?:extended|amended|postponed|revised)\b[^.]{0,15}?\bto\b\s*[:\-]?\s*([^.]{4,80})/i
const CLOSING_AMENDMENT_PATTERNS = [
  AMENDED_CLOSING_TO_RE,
  AMENDED_CLOSING_LABEL_RE,
  DATE_EXTENDED_TO_RE,
]

/** Recognised fixed-offset timezone abbreviations on an otherwise civil time. */
const TRAILING_TZ_RE = /\s+(SAST|CAT|EAT|WAT|UTC|GMT)\.?$/i

/** Corporate suffixes that, like government suffixes, mark a real authority. */
const CORPORATE_SUFFIX_RE =
  /\b(limited|ltd|pty|proprietary|inc|incorporated|corporation|corp|holdings|soc|cc)\b/i

/** Government / public-entity suffixes that mark an issuing authority. */
const GOVERNMENT_SUFFIX_RE =
  /\b(department|ministry|municipal\w*|metropolitan|metro|city\s+of|\bcity\b|province|provincial|national|government|council|authority|agency|board|entity|parastatal|eskom|transnet|university|college|school|commission|administration|republic)\b/i
const GOVERNMENT_SUFFIX_COUNT_RE = new RegExp(GOVERNMENT_SUFFIX_RE.source, 'gi')
/** Explicit label adjacency, e.g. "Issued by: …" / "Employer: …". */
const ISSUER_LABEL_RE =
  /\b(issued\s+by|issuing\s+authority|issuer|employer|contracting\s+authority|procuring\s+entity|client|principal)\b/i
const ISSUER_LABEL_STRIP_RE =
  /^.*?\b(?:issued\s+by|issuing\s+authority|issuer|employer|contracting\s+authority|procuring\s+entity|client|principal)\b\s*[:\-]?\s*/i
/** Minimum score before an issuer candidate is treated as an authority. */
const ISSUER_MIN_SCORE = 4

// ── submission logistics heuristics ─────────────────────────────────────────
const SUBMIT_HINT =
  /(deposit\w*|deliver\w*|submit\w*|hand\w*\s*in|lodg\w*|sent|transmitt\w*|upload\w*)/i
const BID_BOX_RE = /bid\s*box|tender\s*box|bid\s*receptacle|foyer|reception|registry|counter/i
const PORTAL_RE = /portal|e-?tender\w*|online|electronically|website|e-submission|system/i
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/
const ADDRESS_TAIL_RE =
  /(?:bid\s*box|foyer|building|street|road|avenue|boulevard|drive|office|pretoria|johannesburg|cape town|durban|polokwane|bloemfontein|nelspruit|kimberley|mafikeng|rustenburg|pietermaritzburg)/i

// ── letterhead / issuer heuristics ───────────────────────────────────────────
const CONTACT_PERSON_RE = /contact\s*person\s*[:-]?\s*(.+)/i
const PHONE_RE = /(?:tel(?:ephone)?|phone)\s*[:-]?\s*(\(?\d[\d ()-]{5,}\d)/i
const ADDRESS_HINT_RE =
  /(?:\b\d{1,4}\s+(?:[A-Z][a-z]+\s)+(?:street|road|avenue|boulevard|drive)\b|building|private bag\s*\w*|p\.?o\.?\s*box)/i

function isMostlyUpper(s: string): boolean {
  const letters = s.replace(/[^A-Za-z]/g, '')
  if (letters.length < 4) return false
  const upper = s.replace(/[^A-Z]/g, '').length
  return upper / letters.length > 0.6
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function stripIssuerLabel(text: string): string {
  return text.replace(ISSUER_LABEL_STRIP_RE, '').trim()
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

interface IssuerAccumulator {
  value: string
  labelled: boolean
  pageNumber: number
  firstIndex: number
  top: number
  pages: Set<number>
}

function issuerScore(acc: {
  value: string
  labelled: boolean
  pageNumber: number
  top: number
  pages: number
}): number {
  let score = 0
  if (isMostlyUpper(acc.value)) score += 2
  if (GOVERNMENT_SUFFIX_RE.test(acc.value)) score += 3
  const suffixHits = (acc.value.match(GOVERNMENT_SUFFIX_COUNT_RE) ?? []).length
  score += Math.min(Math.max(0, suffixHits - 1), 2)
  if (acc.labelled) score += 2
  if (acc.pageNumber === 1 && acc.top <= 0.3) score += 2
  else if (acc.top <= 0.2) score += 1
  if (acc.value.length >= 8 && acc.value.length <= 90) score += 1
  // repeated references across pages corroborate a real authority
  score += Math.min(Math.max(0, acc.pages - 1) * 0.5, 2)
  return score
}

/**
 * Score issuing-authority candidates across the whole document: letterhead
 * position, government suffixes, explicit labels, and repeated references.
 * It never invents a value — only lines that already look like an authority
 * qualify, and everything else stays unknown.
 */
export function extractIssuerCandidates(ex: PageExtraction): IssuerCandidate[] {
  const acc = new Map<string, IssuerAccumulator>()
  let index = 0

  for (const page of ex.pages) {
    for (const raw of page.lines) {
      index += 1
      const text = normalizePdfText(raw.text)
      if (text.length < 4 || text.length > 120) continue
      if (TITLE_HEADING.test(text)) continue
      if (REF_RE.test(text) || CLOSING_RE.test(text) || CONTACT_PERSON_RE.test(text)) continue
      if (EMAIL_RE.test(text) || PHONE_RE.test(text)) continue
      if (/\d/.test(text)) continue
      if (
        /\b(must|shall|bidders?|tenderers?|submit|proposals?|quotation|requirement|evaluation)\b/i.test(
          text,
        )
      )
        continue
      const labelled = ISSUER_LABEL_RE.test(text)
      if (!isMostlyUpper(text) && !GOVERNMENT_SUFFIX_RE.test(text) && !labelled) continue
      const value = stripIssuerLabel(text)
      if (value.length < 4 || value.length > 120) continue
      const key = value.toLowerCase()
      const existing = acc.get(key)
      if (existing) {
        existing.pages.add(page.pageNumber)
        if (page.pageNumber === 1 && existing.pageNumber !== 1) {
          existing.pageNumber = 1
          existing.firstIndex = index
        }
      } else {
        acc.set(key, {
          value,
          labelled,
          pageNumber: page.pageNumber,
          firstIndex: index,
          top: raw.box.top,
          pages: new Set([page.pageNumber]),
        })
      }
    }
  }

  const out: IssuerCandidate[] = []
  for (const entry of acc.values()) {
    out.push({
      value: entry.value,
      score: issuerScore({
        value: entry.value,
        labelled: entry.labelled,
        pageNumber: entry.pageNumber,
        top: entry.top,
        pages: entry.pages.size,
      }),
      pageNumber: entry.pageNumber,
      firstIndex: entry.firstIndex,
    })
  }
  out.sort(
    (a, b) =>
      b.score - a.score || a.firstIndex - b.firstIndex || compareCodeUnits(a.value, b.value),
  )
  return out
}

/** Corporate OR government OR explicit-label evidence that a line is an authority. */
function isStrongAuthority(value: string): boolean {
  return (
    GOVERNMENT_SUFFIX_RE.test(value) ||
    CORPORATE_SUFFIX_RE.test(value) ||
    ISSUER_LABEL_RE.test(value)
  )
}

/**
 * Expose only authorities that genuinely compete with the best candidate: the
 * best itself plus secondaries that carry independent authority evidence AND
 * sit within one score point. A subordinate letterhead line (e.g. "SUPPLY
 * CHAIN MANAGEMENT") is kept out of the conflict set; `extractIssuerCandidates`
 * still exposes the full ranked list.
 */
function selectCompetingIssuers(ranked: IssuerCandidate[]): IssuerCandidate[] {
  if (ranked.length <= 1) return ranked
  const best = ranked[0]
  return ranked.filter(
    (candidate, index) =>
      index === 0 || (isStrongAuthority(candidate.value) && best.score - candidate.score <= 1),
  )
}

/** Pick the strongest submission-logistics clause across the whole document.
 *  Scored over reconstructed sentences so wrapped addresses survive intact. */
export function extractSubmissionLogistics(ex: PageExtraction): {
  submissionMethod: SubmissionMethod | null
  submissionAddress: string | null
} {
  const best = extractSubmissionCandidates(ex)[0]
  return best
    ? { submissionMethod: best.submissionMethod, submissionAddress: best.submissionAddress }
    : { submissionMethod: null, submissionAddress: null }
}

function submissionAddressFrom(text: string): string {
  let address = text.replace(/\s{2,}/g, ' ').trim()
  // trim leading "Proposals must be ..." boilerplate when a recognizable
  // drop-off point exists later in the sentence
  const dropMatch = address.match(/(?:in|at|to|into)\s+(?:the\s+)?((?:bid|tender)\s*box.*)$/i)
  if (dropMatch) address = dropMatch[1].replace(/\s+/g, ' ').trim()
  return address
}

/** Every competing submission-logistics candidate, best-scoring first. */
export function extractSubmissionCandidates(ex: PageExtraction): SubmissionCandidate[] {
  const out: SubmissionCandidate[] = []
  let index = 0

  for (const clause of buildClauses(ex)) {
    index += 1
    const text = clause.text
    if (text.length < 20 || text.length > 600) continue
    if (!SUBMIT_HINT.test(text)) continue

    let submissionMethod: SubmissionMethod | null = null
    if (EMAIL_RE.test(text)) submissionMethod = 'EMAIL'
    else if (BID_BOX_RE.test(text)) submissionMethod = 'PHYSICAL'
    else if (PORTAL_RE.test(text)) submissionMethod = 'ELECTRONIC'
    if (!submissionMethod) continue

    let score = 1
    if (ADDRESS_TAIL_RE.test(text)) score += 2
    if (/no\s+later\s+than|closing|before/i.test(text)) score += 1
    if (/[.!?]$/.test(text.trim())) score += 1
    score += Math.min(text.length / 240, 1)

    out.push({
      submissionMethod,
      submissionAddress: submissionAddressFrom(text),
      score,
      pageNumber: clause.pageNumber,
      firstIndex: index,
    })
  }

  out.sort((a, b) => b.score - a.score || a.firstIndex - b.firstIndex)
  return out
}

/** Analyze the cover letterhead: who is the issuer, where, how to reach them. */
export function extractIssuerInfo(
  ex: PageExtraction,
  meta: {
    referenceNumber: string | null
    issuingBody: string | null
  },
): IssuerInfo | null {
  const first = ex.pages[0]
  if (!first) return null
  const lines = first.lines.map((l) => normalizePdfText(l.text))

  const displayName = meta.issuingBody
  if (!displayName) return null

  let address: string | null = null
  let contact: string | null = null

  for (const l of lines) {
    if (!address && ADDRESS_HINT_RE.test(l) && l.length >= 12) {
      address = l.replace(/\s{2,}/g, ' ').trim()
    }
    if (!contact) {
      const cp = l.match(CONTACT_PERSON_RE)
      if (cp) {
        let c = cp[1].replace(/\s{2,}/g, ' ').trim()
        const phone = l.match(PHONE_RE)
        if (phone) c = `${c} · ${phone[1].trim()}`
        const email = l.match(EMAIL_RE)
        if (email) c = `${c} · ${email[0]}`
        contact = c
      } else if (CONTACT_PERSON_RE.test(l)) {
        contact = l.replace(/\s{2,}/g, ' ').trim()
      }
    }
    // contact info may be split across lines — a bare phone line near the top
    if (!contact && PHONE_RE.test(l) && /enquir|quer|contact/i.test(l)) {
      contact = l.replace(/\s{2,}/g, ' ').trim()
    }
  }

  const refStyle = meta.referenceNumber
    ? `Reference number in the style "${meta.referenceNumber}"`
    : null

  return {
    name: displayName.toUpperCase().trim(),
    displayName,
    address,
    contact,
    refStyle,
  }
}

/** Distinct reference numbers across the whole document, in reading order. */
export function extractReferenceCandidates(ex: PageExtraction): ValueCandidate[] {
  const seen = new Set<string>()
  const out: ValueCandidate[] = []
  let index = 0
  for (const page of ex.pages) {
    for (const raw of page.lines) {
      index += 1
      const text = normalizePdfText(raw.text)
      const m = text.match(REF_RE)
      if (!m) continue
      const value = m[1].replace(/[.,;)\]]+$/, '')
      if (value.length < 3) continue
      const key = value.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ value, pageNumber: page.pageNumber, firstIndex: index })
    }
  }
  out.sort((a, b) => a.firstIndex - b.firstIndex)
  return out
}

/**
 * Closing-date candidates across the whole document. Each candidate must pass
 * the SHARED strict parser, so nothing that could brick `saveStoreV2` is
 * surfaced as a value (the strict gate for `closingDate` is preserved).
 * Cover dates and amendment/extension dates both appear as candidates so a
 * conflicting deadline is surfaced rather than silently resolved.
 */
export function extractClosingDateCandidates(ex: PageExtraction): ValueCandidate[] {
  const seen = new Set<string>()
  const out: ValueCandidate[] = []
  let index = 0
  for (const page of ex.pages) {
    for (const raw of page.lines) {
      index += 1
      const text = normalizePdfText(raw.text)
      const rawCandidates: string[] = []
      const closingMatch = text.match(CLOSING_RE)
      if (closingMatch) rawCandidates.push(closingMatch[1])
      if (/closing|submission|amend|extend|postpon|revis/i.test(text)) {
        for (const pattern of CLOSING_AMENDMENT_PATTERNS) {
          const match = text.match(pattern)
          if (match) rawCandidates.push(match[1])
        }
      }

      for (const rawCandidate of rawCandidates) {
        const candidate = normalizeClosingCandidate(rawCandidate)
        if (!candidate || !parseStrictClosingDate(candidate)) continue
        const key = candidate.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ value: candidate, pageNumber: page.pageNumber, firstIndex: index })
      }
    }
  }
  out.sort((a, b) => a.firstIndex - b.firstIndex)
  return out
}

function normalizeClosingCandidate(raw: string): string {
  // Drop a sentence-terminating punctuation run, then a recognised trailing
  // timezone abbreviation. The shared parser represents a civil date/time as
  // the instant, so "…at 11:00 SAST" must not block an otherwise supported
  // date (the abbreviation cannot be represented by the strict grammar).
  return raw
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[.;,]+$/, '')
    .trim()
    .replace(TRAILING_TZ_RE, '')
    .trim()
}

/** Lift tender metadata, scoring candidates across the whole document. */
export function extractTenderMeta(ex: PageExtraction, fallbackTitle: string): TenderMeta {
  const references = extractReferenceCandidates(ex)
  const dates = extractClosingDateCandidates(ex)
  const issuers = selectCompetingIssuers(
    extractIssuerCandidates(ex).filter((c) => c.score >= ISSUER_MIN_SCORE),
  )
  const submissions = extractSubmissionCandidates(ex)

  // Title: first page with a title heading; the first qualifying subtitle wins.
  let title = fallbackTitle
  const headingPage = ex.pages.find((page) =>
    page.lines.some((l) => TITLE_HEADING.test(normalizePdfText(l.text))),
  )
  if (headingPage) {
    const lines = headingPage.lines.map((l) => normalizePdfText(l.text))
    const headingIdx = lines.findIndex((l) => TITLE_HEADING.test(l))
    if (headingIdx >= 0) {
      for (let i = headingIdx + 1; i < Math.min(lines.length, headingIdx + 6); i++) {
        const l = lines[i]
        if (REF_RE.test(l) || CLOSING_RE.test(l) || /contact person/i.test(l)) continue
        if (l.length >= 12) {
          title = l
          break
        }
      }
    }
  }

  const referenceValues = references.map((c) => c.value)
  const dateValues = dates.map((c) => c.value)
  const issuerValues = issuers.map((c) => c.value)
  const methodCandidates = uniqueStrings(
    submissions.map((s) => s.submissionMethod),
  ) as SubmissionMethod[]
  const addressCandidates = uniqueStrings(submissions.map((s) => s.submissionAddress))

  // Never silently discard a competing candidate: expose it and say so.
  const conflicts: string[] = []
  if (referenceValues.length > 1)
    conflicts.push(`Multiple reference numbers found: ${referenceValues.slice(0, 4).join(' | ')}`)
  if (dateValues.length > 1)
    conflicts.push(`Multiple closing dates found: ${dateValues.slice(0, 4).join(' | ')}`)
  if (methodCandidates.length > 1)
    conflicts.push(`Multiple submission methods found: ${methodCandidates.join(' | ')}`)
  if (addressCandidates.length > 1)
    conflicts.push(
      `Multiple submission destinations found: ${addressCandidates.slice(0, 3).join(' | ')}`,
    )
  if (issuers.length > 1 && issuers[0].score - issuers[1].score <= 1)
    conflicts.push(`Multiple issuing authorities found: ${issuerValues.slice(0, 3).join(' | ')}`)

  return {
    title: title.trim() || fallbackTitle,
    referenceNumber: referenceValues[0] ?? null,
    issuingBody: issuerValues[0] ?? null,
    closingDate: dateValues[0] ?? null,
    submissionMethod: methodCandidates[0] ?? null,
    submissionAddress: addressCandidates[0] ?? null,
    candidates: {
      referenceNumber: referenceValues.slice(0, 5),
      issuingBody: issuerValues.slice(0, 5),
      closingDate: dateValues.slice(0, 5),
      submissionMethod: methodCandidates.slice(0, 5),
      submissionAddress: addressCandidates.slice(0, 5),
    },
    conflicts,
  }
}
