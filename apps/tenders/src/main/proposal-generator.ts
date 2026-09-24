import {
  assessRequirementStatuses,
  isRequirementResolved,
  parseClosingDate,
  readinessBindingMatches,
  requiresDocumentEvidence,
  SIGNATURE_RULE_KEYS,
  type ReadinessBinding,
  type ReadinessReport,
} from '../shared/readiness'
import { formatRandAmount, safeMoneyLocale } from '../shared/money'

/**
 * Build the binding the proposal generator must verify, from facts the main
 * process resolved INDEPENDENTLY of the report itself: the requested tender id
 * and the loaded authoritative document revision. (Copying the report's own
 * binding, as the live path used to, made the identity/revision checks
 * tautological.) Returns `undefined` on any drift so the caller withholds the
 * report entirely — fail-closed, so no unverified report can clear a proposal.
 */
export function expectedReadinessBinding(input: {
  requestedTenderId: string
  loadedRevision: number
  canonicalTenderId: string
  reportBinding?: ReadinessBinding
}): (Partial<ReadinessBinding> & { required?: boolean }) | undefined {
  const { reportBinding } = input
  if (!reportBinding) return undefined
  const drift =
    input.canonicalTenderId !== input.requestedTenderId ||
    reportBinding.tenderId !== input.requestedTenderId ||
    reportBinding.revision !== input.loadedRevision
  if (drift) return undefined
  return {
    tenderId: input.requestedTenderId,
    revision: input.loadedRevision,
    fingerprint: reportBinding.fingerprint,
    required: true,
  }
}

export interface ProposalRequirementInput {
  id?: string
  title?: string
  verbatimClause?: string
  isMandatory?: boolean
  status?: string
  linkedVaultDocId?: string | null
  healthStatus?: string
  ruleKey?: string
  reason?: string | null
  notApplicableReason?: string | null
  notes?: string | null
}

export interface ProposalMilestoneInput {
  name?: string
  title?: string
  amount?: number
  dueDate?: string
}

export interface ProposalInput {
  title?: string
  referenceNumber?: string | null
  issuingBody?: string | null
  closingDate?: string | null
  estimatedValue?: number | null
  pricingConfirmed?: boolean
  requirements?: ProposalRequirementInput[]
  milestones?: ProposalMilestoneInput[]
  signatureChecks?: Record<string, boolean>
}

export interface ProposalGenerationOptions {
  /** A report created by the main process from canonical tender/company/vault data. */
  readinessReport?: ReadinessReport
  /**
   * Binding the report must carry before ready language is permitted. Main
   * always supplies this; the pure helper keeps its historical behaviour when
   * no binding is expected (an unbound report is treated as trusted).
   */
  expectedBinding?: Partial<ReadinessBinding> & { required?: boolean }
  now?: Date | string
  locale?: string
}

const C0_C1_CONTROLS = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const UNICODE_FORMAT_CONTROLS = /\p{Cf}/gu
const MARKDOWN_CONTROLS = /[\\`*_#[\]<>]/g

/** Normalize untrusted text without allowing it to create Markdown structure. */
function inline(value: unknown, fallback = ''): string {
  const text = String(value ?? fallback)
    .normalize('NFC')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(C0_C1_CONTROLS, '')
    .replace(UNICODE_FORMAT_CONTROLS, '')
    .trim()
  return text.replace(MARKDOWN_CONTROLS, '\\$&')
}

/** Table values never use code spans; pipes are escaped and backticks removed. */
function cell(value: unknown, fallback = ''): string {
  return inline(value, fallback).replace(/\\?`/g, '').replace(/\|/g, '\\|')
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function stableNow(value: Date | string | undefined): Date {
  const date = value instanceof Date ? value : value === undefined ? new Date() : new Date(value)
  return isNaN(date.getTime()) ? new Date() : date
}

interface RequirementBlocker {
  key: string
  label: string
  rootId: string
}

function requirementKey(requirement: ProposalRequirementInput, index: number): string {
  return requirement.id || requirement.title || requirement.verbatimClause || `requirement-${index}`
}

function buildRequirementBlockers(
  requirements: ProposalRequirementInput[],
  signatureChecks: Record<string, boolean> | undefined,
): RequirementBlocker[] {
  const blockers = new Map<string, RequirementBlocker>()
  const add = (requirement: ProposalRequirementInput, index: number, rootId: string): void => {
    const key = requirementKey(requirement, index)
    const existing = blockers.get(key)
    if (existing) {
      if (rootId === 'docs-at-closing' || rootId === 'signatures') existing.rootId = rootId
    } else {
      blockers.set(key, {
        key,
        label: inline(requirement.title || requirement.verbatimClause, 'Requirement'),
        rootId,
      })
    }
  }

  requirements.forEach((requirement, index) => {
    if (requirement.isMandatory === false) return
    if (!isRequirementResolved(requirement as any)) add(requirement, index, 'requirements')
    if (requirement.status === 'NOT_APPLICABLE' && isRequirementResolved(requirement as any)) return
    if (
      requirement.healthStatus === 'EXPIRED' ||
      requirement.healthStatus === 'STALE_CERTIFICATION' ||
      requirement.healthStatus === 'UNKNOWN' ||
      requirement.healthStatus === 'INVALID_DATE'
    ) {
      add(requirement, index, 'docs-at-closing')
    }
    if (
      requirement.ruleKey &&
      SIGNATURE_RULE_KEYS.includes(requirement.ruleKey) &&
      signatureChecks?.[requirement.ruleKey] !== true
    ) {
      add(requirement, index, 'signatures')
    }
    if (
      requirement.ruleKey &&
      requiresDocumentEvidence(requirement.ruleKey) &&
      !requirement.linkedVaultDocId
    ) {
      add(requirement, index, 'docs-at-closing')
    }
  })
  return [...blockers.values()]
}

interface PricingAssessment {
  confirmed: boolean
  value: number | null
  scheduleRows: string[]
  issue: string | null
}

interface ProposalCondition {
  id: string
  labels: string[]
}

function assessPricing(
  estimatedValue: unknown,
  pricingConfirmed: unknown,
  milestones: ProposalMilestoneInput[],
  locale: string,
): PricingAssessment {
  const value = positiveNumber(estimatedValue)
  if (value === null || pricingConfirmed !== true) {
    return { confirmed: false, value, scheduleRows: [], issue: null }
  }

  let sumCents = 0
  const rows: string[] = []
  for (const milestone of milestones) {
    const amount = positiveNumber(milestone.amount)
    if (amount === null) {
      return {
        confirmed: true,
        value,
        scheduleRows: [],
        issue: 'Pricing schedule contains an invalid or non-positive milestone amount.',
      }
    }
    sumCents += Math.round(amount * 100)
    rows.push(
      `| ${cell(milestone.name || milestone.title, 'Contract milestone')} | ${cell(milestone.dueDate, 'TBD')} | ${formatRandAmount(amount, locale)} |`,
    )
  }

  if (milestones.length > 0 && Math.abs(sumCents - Math.round(value * 100)) > 1) {
    return {
      confirmed: true,
      value,
      scheduleRows: rows,
      issue: 'Pricing schedule total does not equal the confirmed estimated value.',
    }
  }
  return { confirmed: true, value, scheduleRows: rows, issue: null }
}

/**
 * Pure Markdown generation. Renderer-shaped payloads remain drafts until a
 * separately supplied main-process readiness report authorizes ready language.
 */
export function generateProposalMarkdown(
  input: ProposalInput | null | undefined,
  options: ProposalGenerationOptions = {},
): string {
  const tender = input ?? {}
  const locale = safeMoneyLocale(options.locale)
  const now = stableNow(options.now)
  const title = inline(tender.title, 'Tender Proposal')
  const ref = inline(tender.referenceNumber, 'Not supplied')
  const issuer = inline(tender.issuingBody, 'Not supplied')
  const closing = inline(tender.closingDate, 'TBD')
  const requirements = Array.isArray(tender.requirements) ? tender.requirements : []
  const milestones = Array.isArray(tender.milestones) ? tender.milestones : []
  const allStatusReport = assessRequirementStatuses(requirements as any, false)
  const requirementBlockers = buildRequirementBlockers(requirements, tender.signatureChecks)
  const pricing = assessPricing(tender.estimatedValue, tender.pricingConfirmed, milestones, locale)
  const closingDate = parseClosingDate(tender.closingDate)
  const localConditions: ProposalCondition[] = []
  const addLocalCondition = (id: string, label: string): void => {
    const existing = localConditions.find((condition) => condition.id === id)
    if (existing) {
      if (!existing.labels.includes(label)) existing.labels.push(label)
    } else {
      localConditions.push({ id, labels: [label] })
    }
  }
  for (const blocker of requirementBlockers) addLocalCondition(blocker.rootId, blocker.label)
  if (requirements.length === 0) addLocalCondition('requirements', 'Compliance matrix is empty')
  if (!closingDate || closingDate.getTime() <= now.getTime())
    addLocalCondition('deadline', 'Closing date confirmation')
  if (!pricing.confirmed) addLocalCondition('pricing', 'Pricing confirmation')
  if (pricing.issue) addLocalCondition('pricing', pricing.issue)

  const rawReport = options.readinessReport
  // A report is only trusted when its canonical binding matches what the caller
  // expected. A mismatched or missing (when required) binding can never clear a
  // proposal, so a report for the wrong/stale tender cannot emit ready language.
  const independentlyVerified = readinessBindingMatches(rawReport, options.expectedBinding)
  const trustedReport = independentlyVerified ? rawReport : undefined
  const conditions = [...localConditions]
  if (trustedReport) {
    for (const check of trustedReport.checks.filter(
      (candidate) => candidate.blocking && !candidate.passed,
    )) {
      if (check.id === 'requirements' && requirementBlockers.length > 0) continue
      const id =
        check.id === 'docs-at-closing' &&
        requirementBlockers.some((blocker) => blocker.rootId === 'docs-at-closing')
          ? 'docs-at-closing'
          : check.id
      const existing = conditions.find((condition) => condition.id === id)
      const label = inline(check.label, 'Canonical readiness check')
      if (existing) {
        if (!existing.labels.includes(label)) existing.labels.push(label)
      } else {
        conditions.push({ id, labels: [label] })
      }
    }
  }
  const internallyClear = conditions.length === 0
  const ready = independentlyVerified && rawReport?.ready === true && internallyClear
  const status = !independentlyVerified
    ? 'DRAFT — READINESS NOT INDEPENDENTLY VERIFIED'
    : ready
      ? 'READY FOR SUBMISSION'
      : 'DRAFT — SUBMISSION BLOCKED'
  const dateStr = now.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const pricingSection =
    pricing.confirmed && pricing.value !== null
      ? `**Confirmed Total Bid Valuation:** ${formatRandAmount(pricing.value, locale)} (amount supplied; tax treatment not specified)`
      : '**Pricing:** Not provided or unconfirmed — pricing requires confirmation before submission.'
  const scheduleSection =
    pricing.confirmed && pricing.value !== null
      ? [
          '| Milestone | Due Date | Amount (as supplied) |',
          '| :--- | :--- | ---: |',
          ...pricing.scheduleRows,
          `| **TOTAL** | | **${formatRandAmount(pricing.value, locale)}** |`,
        ].join('\n')
      : milestones.length > 0
        ? `Milestone descriptions supplied (amounts not shown until pricing is confirmed): ${milestones.map((milestone) => cell(milestone.name || milestone.title, 'Contract milestone')).join('; ')}`
        : 'No pricing schedule was supplied.'
  const matrix =
    requirements.length > 0
      ? requirements
          .map((requirement, index) => {
            const mandatory = requirement.isMandatory !== false ? 'Mandatory' : 'Optional'
            const statusText = cell(requirement.status, 'UNRESOLVED')
            const link = requirement.linkedVaultDocId
              ? cell(requirement.linkedVaultDocId)
              : 'None supplied'
            const health = cell(
              requirement.healthStatus,
              requirement.linkedVaultDocId ? 'Not assessed in proposal payload' : 'NO_ATTACHMENT',
            )
            return `| ${index + 1} | ${cell(requirement.title || requirement.verbatimClause, 'Requirement')} | ${mandatory} | **${statusText}** | ${link} | ${health} |`
          })
          .join('\n')
      : '| — | No compliance requirements supplied | — | — | — | — |'
  const blockerLabels = [...new Set(conditions.flatMap((condition) => condition.labels))]
  const verificationNotice = !independentlyVerified
    ? '**Readiness Verification:** Canonical company/vault readiness was not independently verified in this proposal request.'
    : rawReport?.ready === true
      ? '**Readiness Verification:** Canonical readiness report supplied by the main process.'
      : '**Readiness Verification:** Canonical readiness report failed; resolve its blocking checks before submission.'

  return `# Commercial & Technical Tender Proposal

**Project Title:** ${title}  
**Tender Reference:** ${ref}  
**Issuing Authority:** ${issuer}  
**Closing Date:** ${closing}  
**Document Date:** ${dateStr}  
**Proposal Status:** **${status}**

${pricingSection}

---

## 1. Scope and Submission Statement

This document is a conservative draft based on the tender information and compliance data supplied to Tenders. It records the identified opportunity and returnable statuses; it does not make capability, staffing, safety, engineering, certification, commissioning, payment, VAT, or other delivery claims that are not present in the supplied data.

## 2. Delivery Information

No delivery methodology or technical approach was supplied in the proposal payload. Add and verify any scope-specific approach before submission.

## 3. Pricing Schedule & Contract Milestones

${scheduleSection}

## 4. Compliance Checklist & Returnables Matrix

- **Total Evaluated Criteria**: ${requirements.length}
- **Fully Fulfilled Returnables**: ${allStatusReport.fulfilled}
- **Outstanding**: ${allStatusReport.outstanding}
- **Action Required**: ${allStatusReport.actionRequired}
- **Status Population Size**: ${requirements.length}
- **Blocking Requirements**: ${requirementBlockers.length}
- **Total Blockers:** ${conditions.length}
- **Audit Gate Status**: **${status}**
${verificationNotice}
${conditions.length > 0 ? `\n${conditions.map((condition) => `**Condition ID:** ${condition.id} — ${condition.labels.join('; ')}`).join('\n')}\n**Blockers:** ${blockerLabels.join('; ')}` : ''}

| Item | Requirement / Returnable | Mandatory / Disqualifier | Fulfillment Status | Linked Returnable | Health Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
${matrix}

---

*Generated from supplied Tenders data. Verify every returnable, linked document, price, and submission instruction against the source RFP before use.*
`
}

export const createProposalMarkdown = generateProposalMarkdown
