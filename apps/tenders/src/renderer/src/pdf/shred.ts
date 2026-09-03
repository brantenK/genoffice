// Deterministic heuristic "tender shredder": scans extracted lines against the
// shared rule catalogue and produces the compliance matrix requirements with
// exact source clauses + bounding boxes. Also lifts tender metadata from page 1.
import {
  DISQUALIFIER_LANGUAGE,
  MANDATORY_LANGUAGE,
  TENDER_RULES
} from '../../shared/rules'
import type {
  ExtractedRequirement,
  PageExtraction,
  SubmissionMethod
} from '../../shared/types'
import { buildClauses, type Clause } from './clauses'

export interface TenderMeta {
  title: string
  referenceNumber: string | null
  issuingBody: string | null
  closingDate: string | null
  submissionMethod: SubmissionMethod | null
  submissionAddress: string | null
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
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
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
      0.55 +
        Math.min(best.score / 6, 0.25) +
        corroboration +
        (allPages.size > 1 ? 0.1 : 0),
      1
    )

    const extraPages = [...allPages].filter((p) => p !== best.clause.pageNumber).sort((a, b) => a - b)
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
      boundingBox: best.clause.box,
      riskLevel: rule.riskLevel,
      order: rule.order,
      additionalClauses: additional.length > 0 ? additional : undefined,
      confidence: Math.round(confidence * 100) / 100,
      notes: notes.length > 0 ? notes.join(' · ') : undefined
    })
  }

  return requirements
}

const TITLE_HEADING =
  /(request for (proposals?|tender|quotation)s?|invitation to (bid|tender)|tender document|\brfp\b|reit)/i
const REF_RE =
  /(?:reference\s*(?:number|no\.?)?|ref(?:erence)?\s*(?:no\.?|number)?|tender\s*no\.?|bid\s*number)\s*[:\-]\s*([A-Za-z0-9][\w/.-]{2,})/i
const CLOSING_RE = /closing\s*date\s*[:\-]?\s*(.+)/i
const ISSUING_HINT = /(department|ministry|municipal|authority|agency|council|commission|university|eskom|transnet)/i

// ── submission logistics heuristics ─────────────────────────────────────────
const SUBMIT_HINT = /(deposit\w*|deliver\w*|submit\w*|hand\w*\s*in|lodg\w*|sent|transmitt\w*|upload\w*)/i
const BID_BOX_RE = /bid\s*box|tender\s*box|bid\s*receptacle|foyer|reception|registry|counter/i
const PORTAL_RE = /portal|e-?tender\w*|online|electronically|website|e-submission|system/i
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/
const ADDRESS_TAIL_RE =
  /(?:bid\s*box|foyer|building|street|road|avenue|boulevard|drive|office|pretoria|johannesburg|cape town|durban|polokwane|bloemfontein|nelspruit|kimberley|mafikeng|rustenburg|pietermaritzburg)/i

// ── letterhead / issuer heuristics ───────────────────────────────────────────
const CONTACT_PERSON_RE = /contact\s*person\s*[:\-]?\s*(.+)/i
const PHONE_RE = /(?:tel(?:ephone)?|phone)\s*[:\-]?\s*(\(?\d[\d ()-]{5,}\d)/i
const ADDRESS_HINT_RE =
  /(?:\b\d{1,4}\s+(?:[A-Z][a-z]+\s)+(?:street|road|avenue|boulevard|drive)\b|building|private bag\s*\w*|p\.?o\.?\s*box)/i

function isMostlyUpper(s: string): boolean {
  const letters = s.replace(/[^A-Za-z]/g, '')
  if (letters.length < 4) return false
  const upper = letters.replace(/[^A-Z]/g, '').length
  return upper / letters.length > 0.6
}

/** Pick the strongest submission-logistics clause across the whole document.
 *  Scored over reconstructed sentences so wrapped addresses survive intact. */
export function extractSubmissionLogistics(ex: PageExtraction): {
  submissionMethod: SubmissionMethod | null
  submissionAddress: string | null
} {
  let best: { score: number; text: string } | null = null

  for (const clause of buildClauses(ex)) {
    const text = clause.text
    if (text.length < 20 || text.length > 600) continue
    if (!SUBMIT_HINT.test(text)) continue

    const email = EMAIL_RE.test(text)
    const bidBox = BID_BOX_RE.test(text)
    const portal = PORTAL_RE.test(text)

    let method: SubmissionMethod | null = null
    if (email) method = 'EMAIL'
    else if (bidBox) method = 'PHYSICAL'
    else if (portal) method = 'ELECTRONIC'
    if (!method) continue

    let score = 1
    if (ADDRESS_TAIL_RE.test(text)) score += 2
    if (/no\s+later\s+than|closing|before/i.test(text)) score += 1
    if (/[.!?]$/.test(text.trim())) score += 1
    score += Math.min(text.length / 240, 1)

    if (!best || score > best.score) best = { score, text }
  }

  if (!best) return { submissionMethod: null, submissionAddress: null }
  let address = best.text.replace(/\s{2,}/g, ' ').trim()
  // trim leading "Proposals must be ..." boilerplate when a recognizable
  // drop-off point exists later in the sentence
  const dropMatch = address.match(/(?:in|at|to|into)\s+(?:the\s+)?((?:bid|tender)\s*box.*)$/i)
  if (dropMatch) address = dropMatch[1].replace(/\s+/g, ' ').trim()
  return { submissionMethod: methodOfLine(best.text), submissionAddress: address }
}

function methodOfLine(text: string): SubmissionMethod {
  if (EMAIL_RE.test(text)) return 'EMAIL'
  if (BID_BOX_RE.test(text)) return 'PHYSICAL'
  return 'ELECTRONIC'
}

/** Analyze the cover letterhead: who is the issuer, where, how to reach them. */
export function extractIssuerInfo(ex: PageExtraction, meta: {
  referenceNumber: string | null
  issuingBody: string | null
}): IssuerInfo | null {
  const first = ex.pages[0]
  if (!first) return null
  const lines = first.lines.map((l) => l.text)

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
    refStyle
  }
}

/** Lift tender title / ref / issuer / closing date from page 1 lines. */
export function extractTenderMeta(ex: PageExtraction, fallbackTitle: string): TenderMeta {
  const first = ex.pages[0]
  const lines = first ? first.lines.map((l) => l.text) : []

  let title = fallbackTitle
  let referenceNumber: string | null = null
  let issuingBody: string | null = null
  let closingDate: string | null = null

  const headingIdx = lines.findIndex((l) => TITLE_HEADING.test(l))
  if (headingIdx >= 0) {
    // subtitle: first following line that is not a ref/date/contact line
    for (let i = headingIdx + 1; i < Math.min(lines.length, headingIdx + 6); i++) {
      const l = lines[i]
      if (REF_RE.test(l) || CLOSING_RE.test(l) || /contact person/i.test(l)) continue
      if (l.length >= 12 && !isMostlyUpper(l)) {
        title = l
        break
      }
      if (l.length >= 12) {
        title = l
        break
      }
    }
    // issuing body: mostly-uppercase lines above the heading
    const upperLines: string[] = []
    for (let i = 0; i < headingIdx; i++) {
      if (isMostlyUpper(lines[i])) upperLines.push(lines[i])
    }
    issuingBody = upperLines.find((l) => ISSUING_HINT.test(l)) ?? upperLines[upperLines.length - 1] ?? null
  }

  for (const l of lines) {
    if (!referenceNumber) {
      const m = l.match(REF_RE)
      if (m) referenceNumber = m[1].replace(/[.,;]$/, '')
    }
    if (!closingDate) {
      const m = l.match(CLOSING_RE)
      if (m) closingDate = m[1].replace(/\s{2,}/g, ' ').trim()
    }
  }

  const logistics = extractSubmissionLogistics(ex)

  return {
    title: title.trim() || fallbackTitle,
    referenceNumber,
    issuingBody,
    closingDate,
    submissionMethod: logistics.submissionMethod,
    submissionAddress: logistics.submissionAddress
  }
}
