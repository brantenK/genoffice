// Pure metric computation for the synthetic Tenders intake corpus.
//
// The harness (apps/tenders/tests/corpus-extraction.test.ts) runs the REAL
// parser over every fixture and hands `{ gold, actual }` records here. Nothing
// in this module fabricates parser output; it only scores it against gold.
//
// All metric definitions are stated explicitly so the baseline report is
// reproducible and so a future parser lane can be measured against the same
// predicates.

export const CRITICAL_FIELDS = [
  'title',
  'referenceNumber',
  'issuingBody',
  'closingDateTime',
  'submissionMethod',
  'submissionDestination',
]

/** Normalise text for tolerant gold comparisons (case, quotes, dashes, spaces). */
export function normalizeText(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .normalize('NFKD')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim()
}

function isAbsent(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

/** The parser surfaced competing values for this field (needs user review). */
function isConflicted(actual, field) {
  return (actual.conflictedFields ?? []).includes(field)
}

/** A field is "unconfirmed" when it is missing or has competing candidates. */
function isUnconfirmed(actual, field) {
  return isAbsent(actual[field]) || isConflicted(actual, field)
}

function containsEither(a, b) {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (!na || !nb) return false
  return na.includes(nb) || nb.includes(na)
}

/**
 * Is one critical-metadata field correctly extracted?
 *
 *  - A field gold marks `unconfirmedFields` must be left null/unconfirmed
 *    (competing or unreadable values must not be silently resolved).
 *  - A field gold marks null must be null (do not invent a value).
 *  - Otherwise the parser value must match gold (tolerant for free text).
 */
export function fieldCorrect(field, gold, actual, goldClosingInstant) {
  const unconfirmed = (gold.unconfirmedFields ?? []).includes(field)
  // A correct intake leaves the field unconfirmed when the document is
  // ambiguous — either by returning nothing or by surfacing competing
  // candidates for the review UI, never by silently picking one.
  if (unconfirmed) return isUnconfirmed(actual, field)

  const expected = gold[field]
  if (isAbsent(expected)) return isAbsent(actual[field])

  switch (field) {
    case 'title': {
      if (isAbsent(actual.title) || actual.fallbackTitleUsed) return false
      const candidates = [gold.title, ...(gold.titleAlternatives ?? [])]
      return candidates.some((candidate) => containsEither(actual.title, candidate))
    }
    case 'referenceNumber': {
      if (isAbsent(actual.referenceNumber)) return false
      return containsEither(actual.referenceNumber, gold.referenceNumber)
    }
    case 'issuingBody': {
      if (isAbsent(actual.issuingBody)) return false
      return containsEither(actual.issuingBody, gold.issuingBody)
    }
    case 'closingDateTime': {
      if (isAbsent(actual.closingInstant)) return false
      return goldClosingInstant !== null && actual.closingInstant === goldClosingInstant
    }
    case 'submissionMethod': {
      if (isAbsent(actual.submissionMethod)) return false
      return actual.submissionMethod === gold.submissionMethod
    }
    case 'submissionDestination': {
      if (isAbsent(actual.submissionDestination)) return false
      return containsEither(actual.submissionDestination, gold.submissionDestination)
    }
    default:
      return false
  }
}

function pct(numerator, denominator) {
  if (denominator === 0) return null
  return Math.round((numerator / denominator) * 10000) / 10000
}

/**
 * Compute the full metric report.
 * @param {Array<{ gold: object, actual: object, goldClosingInstant: string|null }>} records
 */
export function computeMetrics(records) {
  const perField = Object.fromEntries(
    CRITICAL_FIELDS.map((field) => [field, { correct: 0, total: 0 }]),
  )

  const requirementGold = new Set()
  const requirementFound = new Set()
  const requirementMissed = new Set()
  const requirementExtra = new Set()
  const mandatoryMissed = new Set()
  const disqualifierMissed = new Set()
  let mandatoryTotal = 0
  let disqualifierTotal = 0
  let extractedTotal = 0

  let conflictCorrect = 0
  let conflictTotal = 0
  let unconfirmedCorrect = 0
  let unconfirmedTotal = 0

  let pageCorrect = 0
  let pageTotal = 0
  const pageMismatches = []

  let falseReadinessCount = 0
  const falseReadinessFixtures = []
  const falseReadinessBlockedByOcr = []

  let pricingExpected = 0
  let pricingDetected = 0

  const fixtures = []

  for (const record of records) {
    const { gold, actual, goldClosingInstant } = record
    const fieldResults = {}
    let metadataCorrect = 0
    let metadataTotal = 0

    for (const field of CRITICAL_FIELDS) {
      const correct = fieldCorrect(field, gold, actual, goldClosingInstant)
      fieldResults[field] = correct
      perField[field].total += 1
      if (correct) perField[field].correct += 1
      metadataCorrect += correct ? 1 : 0
      metadataTotal += 1
    }

    const goldKeys = new Set(gold.expectedRequirementKeys)
    const actualKeys = new Set(actual.requirementKeys)
    const matched = [...goldKeys].filter((key) => actualKeys.has(key))
    const missedForFixture = [...goldKeys].filter((key) => !actualKeys.has(key))
    for (const key of goldKeys) requirementGold.add(key)
    for (const key of matched) requirementFound.add(key)
    for (const key of goldKeys) if (!actualKeys.has(key)) requirementMissed.add(key)
    for (const key of actualKeys) if (!goldKeys.has(key)) requirementExtra.add(key)
    for (const key of gold.mandatoryRequirements) {
      mandatoryTotal += 1
      if (!actualKeys.has(key)) mandatoryMissed.add(key)
    }
    for (const key of gold.disqualifiers) {
      disqualifierTotal += 1
      if (!actualKeys.has(key)) disqualifierMissed.add(key)
    }
    extractedTotal += actualKeys.size

    // ── conflict detection ──
    const conflictFields = Object.entries(gold.conflicts ?? {})
      .filter(([, value]) => value === true)
      .map(([field]) => field)
    let conflictDetectedForFixture = 0
    for (const field of conflictFields) {
      conflictTotal += 1
      if (isUnconfirmed(actual, field)) {
        conflictCorrect += 1
        conflictDetectedForFixture += 1
      }
    }

    // ── unconfirmed classification ──
    for (const field of gold.unconfirmedFields ?? []) {
      unconfirmedTotal += 1
      if (isUnconfirmed(actual, field)) unconfirmedCorrect += 1
    }

    // ── native vs scanned page classification ──
    const scanned = new Set(gold.scannedPages ?? [])
    const pageCount = Math.max(gold.pageCount ?? 0, actual.perPageNeedsOcr.length)
    for (let index = 0; index < pageCount; index += 1) {
      const expectedOcr = scanned.has(index + 1)
      const actualOcr = Boolean(actual.perPageNeedsOcr[index])
      pageTotal += 1
      if (expectedOcr === actualOcr) pageCorrect += 1
      else pageMismatches.push({ fixture: gold.id, page: index + 1, expectedOcr, actualOcr })
    }

    // ── false readiness ──
    // A naive downstream that trusts the parse would auto-clear when every
    // critical field is confidently present, at least one requirement was
    // found, and no page was flagged OCR-blocked. That becomes a FALSE
    // readiness when either:
    //   (a) gold says a field is ambiguous (competing/absent) but the parser
    //       silently resolved it to a single value instead of surfacing the
    //       competing candidates, or
    //   (b) the parser silently missed a mandatory/disqualifying requirement,
    //       so it would clear a tender that is not compliant.
    // A conflict surfaced anywhere keeps readiness blocked for a correct
    // system, but it must be the *specific* gold ambiguity that is silently
    // resolved to count here.
    const goldConfirmationFields = [
      ...new Set([...(gold.unconfirmedFields ?? []), ...conflictFields]),
    ]
    const silentlyResolved = goldConfirmationFields.some((field) => !isUnconfirmed(actual, field))
    const missedCritical = missedForFixture.some(
      (key) =>
        (gold.mandatoryRequirements ?? []).includes(key) ||
        (gold.disqualifiers ?? []).includes(key),
    )
    const parserTrustedClear =
      !isAbsent(actual.title) &&
      !actual.fallbackTitleUsed &&
      !isAbsent(actual.referenceNumber) &&
      !isAbsent(actual.issuingBody) &&
      !isAbsent(actual.closingInstant) &&
      !isAbsent(actual.submissionMethod) &&
      actual.requirementKeys.length > 0 &&
      !actual.perPageNeedsOcr.some(Boolean)
    const falseReadiness =
      parserTrustedClear && ((!gold.clearable && silentlyResolved) || missedCritical)
    if (falseReadiness) {
      falseReadinessCount += 1
      falseReadinessFixtures.push(gold.id)
    }
    if (!gold.clearable && actual.perPageNeedsOcr.some(Boolean)) {
      falseReadinessBlockedByOcr.push(gold.id)
    }

    // ── pricing / BOQ requirement recall ──
    for (const key of gold.pricingRequirements ?? []) {
      pricingExpected += 1
      if (actualKeys.has(key)) pricingDetected += 1
    }

    fixtures.push({
      id: gold.id,
      sector: gold.sector,
      tags: gold.tags,
      metadata: { correct: metadataCorrect, total: metadataTotal, fields: fieldResults },
      requirements: {
        expected: [...goldKeys],
        found: [...actualKeys].filter((key) => goldKeys.has(key)),
        missed: [...goldKeys].filter((key) => !actualKeys.has(key)),
        extra: [...actualKeys].filter((key) => !goldKeys.has(key)),
      },
      conflicts: { total: conflictFields.length, detected: conflictDetectedForFixture },
      conflictedFields: actual.conflictedFields ?? [],
      parserConflictNotes: actual.parserConflictNotes ?? [],
      falseReadiness,
      scannedPages: [...scanned].sort((a, b) => a - b),
      actualOcrPages: actual.perPageNeedsOcr
        .map((needsOcr, index) => (needsOcr ? index + 1 : null))
        .filter((page) => page !== null),
    })
  }

  const matchedCount = requirementFound.size
  const falsePositiveCount = requirementExtra.size

  return {
    corpusKind: 'synthetic',
    fixtureCount: records.length,
    metrics: {
      criticalMetadataAccuracy: {
        overall: pct(
          Object.values(perField).reduce((sum, entry) => sum + entry.correct, 0),
          Object.values(perField).reduce((sum, entry) => sum + entry.total, 0),
        ),
        perField,
      },
      criticalRequirementRecall: {
        overall: pct(matchedCount, requirementGold.size),
        mandatory: pct(mandatoryTotal - mandatoryMissed.size, mandatoryTotal),
        disqualifiers: pct(disqualifierTotal - disqualifierMissed.size, disqualifierTotal),
        expected: requirementGold.size,
        found: matchedCount,
        missed: [...requirementMissed],
      },
      falsePositiveRate: {
        overall: extractedTotal === 0 ? 0 : pct(falsePositiveCount, extractedTotal),
        falsePositives: falsePositiveCount,
        extracted: extractedTotal,
        detail: [...requirementExtra],
      },
      conflictDetectionAccuracy: {
        overall: pct(conflictCorrect, conflictTotal),
        correct: conflictCorrect,
        total: conflictTotal,
      },
      unconfirmedClassificationAccuracy: {
        overall: pct(unconfirmedCorrect, unconfirmedTotal),
        correct: unconfirmedCorrect,
        total: unconfirmedTotal,
      },
      nativeVsScannedPageAccuracy: {
        overall: pct(pageCorrect, pageTotal),
        correct: pageCorrect,
        total: pageTotal,
        mismatches: pageMismatches,
      },
      pricingRequirementRecall: {
        overall: pricingExpected === 0 ? null : pct(pricingDetected, pricingExpected),
        expected: pricingExpected,
        detected: pricingDetected,
        note: 'Recall of gold pricing/BOQ requirements (pricing_schedule, bill_of_quantities).',
      },
      falseReadinessCount: {
        count: falseReadinessCount,
        target: 0,
        fixtures: falseReadinessFixtures,
        blockedByOcr: falseReadinessBlockedByOcr,
      },
    },
    fixtures,
  }
}
