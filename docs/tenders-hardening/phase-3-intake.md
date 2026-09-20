# Phase 3 — Intake (parser, extraction review, OCR, scale)

Objective: make tender intake **reliable and correctable**, and make scanned-document
support honest. This is the phase most likely to run long, because it depends on real
tender documents and on empirical parser quality.

Read `contracts-and-invariants.md` first. The readiness/proposal machinery from Phase 1
already consumes whatever the parser produces.

## Phase 3 exit criteria

1. Critical tender metadata and requirements are extracted against a **gold-annotated
   corpus**, with measured recall/precision and a **zero false-clear** outcome on the corpus.
2. Users can **correct** every readiness-relevant field and add/edit/remove/ignore
   requirements, with source provenance preserved.
3. Scanned pages are either genuinely OCR'd on supported platforms **or** explicitly
   blocked from readiness — never silently treated as extracted.
4. Import is cancellable and bounded, with published, measured limits.

## Blocker / dependency: the corpus

Phase 3 **cannot be validated without a corpus**. Target 25–40 anonymised or legally
reusable tender documents covering:

- office equipment, construction/civil, professional services
- municipal/government issuers
- pricing schedules / BOQs, forms, annexures
- multi-column layouts, tables
- scanned-only and mixed text/scanned PDFs
- conflicting/amended deadlines, time-zone variants
- B-BBEE terminology and OCR punctuation variants

Each fixture stores expected title/reference/issuer/closing date-time/submission
method+destination/mandatory requirements/disqualifiers/pricing requirements plus source
page/clause. **This is a user-input dependency** — parsers cannot be measured without it.

Corpus location: `apps/tenders/tests/fixtures/` (or `e2e/assets/tenders/`).

Metrics to report (from the planner's test strategy):
critical-metadata accuracy, critical-requirement recall, false-positive rate,
conflict-detection accuracy, correct "unconfirmed" classification, native-vs-OCR page
results, and **false-readiness count (must be 0)**.

## WP-6 — Parser improvements + extraction review (largest item)

Files:

- `apps/tenders/src/shared/rules.ts` (rule catalogue: also carries `evidenceKind` /
  `validityKind` from Phase 1)
- `apps/tenders/src/renderer/src/pdf/extract.ts`, `pdf/clauses.ts`, `pdf/shred.ts`
- new `apps/tenders/src/renderer/src/components/ExtractionReview.tsx`
- `components/TenderList.tsx`, `components/Workspace.tsx`, `components/RequirementList.tsx`
- `tests/shredder-heuristics.test.ts` + new corpus tests

Parser work:

- Normalise Unicode spaces/dashes, OCR punctuation, repeated headers, table-like text.
- Score candidate values across the **whole document**, not just page 1.
- Explicit fields for contact email, submission destination, and structured closing
  date/time/time-zone.
- Improve issuing-authority scoring (label adjacency, letterhead position, government
  suffixes, repeated references).
- Add pricing/price-schedule/BOQ requirement rules.
- Harden B-BBEE matching across punctuation/OCR variants.
- Preserve **competing candidates** for dates/submission methods/addresses/issuer and
  show conflicts for user resolution. Never silently pick one.

Review UI (mandatory before readiness):

- Edit/confirm title, reference, issuer, contact, deadline, method, destination, value.
- Add, edit, remove, reclassify requirements; mark a field "not stated".
- Show confidence and source page/clause; keep original extracted text after correction.

Acceptance:

- Every audited miss (issuing body, contact email, B-BBEE, pricing schedule) has a fixture
  and passes.
- Every low-confidence or conflicting critical field is visibly unconfirmed.
- A user can repair any parser miss without reimporting.

## WP-7 — OCR (decide: implement or narrow the promise)

Decision from the Oracle pressure-test: **do not** build a huge OCR stack before
measuring corpus need, and **do not** claim scanned support while doing only
`needsOcr` detection (current state).

Alpha behaviour (do immediately, cheap):

- Mark each page: native text extracted / OCR required / OCR unavailable / failed /
  manually reviewed.
- OCR-required or OCR-failed pages **block readiness** until manually reviewed.
- Fix all onboarding/tutorial copy that implies scanned pages are read.

Beta behaviour (only if corpus shows scanned documents are common — likely):

- Reuse the already-packaged local platform OCR helpers (see
  `packages/pdf2docx/src/ocr.ts` / `ocr-vision.ts` and the shell's system OCR packaging).
- OCR only pages that need it; bound resolution and concurrency; add progress + cancel.
- Map OCR boxes into the existing top-left `PageLine` coordinates so highlighting and
  clause extraction keep working.
- Persist page-level extraction method/confidence/review state.
- Windows/macOS: supported and package-tested. Linux: explicit unsupported unless a
  tested local engine is added.

Anti-goal: keep "OCR pages" from being presented as work performed when it is only a
detection flag.

## WP-15 (partial) — Import scale and cancellation

Files: `pdf/extract.ts`, new `pdf/ocr.ts`, `components/PdfViewer.tsx`,
`components/TenderList.tsx`, `renderer/src/store.ts`, benchmarks under `tests/performance/`.

- Benchmark representative hardware; publish measured limits rather than aspirational ones.
  Planner's candidate envelope: native/mixed PDF up to 100 MB or 500 pages; OCR-heavy up
  to 50 MB or 150 scanned pages; 250 active tenders; 1000 vault documents; 10 000
  requirements. **Reduce and publish if not met.**
- Preflight size limits before reading large buffers; page-level progress; cancellation;
  bounded OCR concurrency.
- Virtualise/evict off-screen PDF canvases (currently every viewed canvas is retained).
- Index vault keywords once per analysis instead of rescanning per requirement.

## Tests

- Corpus regression suite with per-fixture expected metadata/requirements.
- Conflict and "unconfirmed" classification tests.
- Correction-flow E2E: import → correct → resolve → readiness.
- OCR: fake-engine unit tests, coordinate mapping, scanned/mixed fixtures, helper
  unavailable/crash/timeout, packaged smoke.
- Scale: timed benchmarks, memory trace, long-PDF scroll, cancellation, limit boundaries.

## Risks

- Regex/tuning increases recall but raises false positives — measure both, never one.
- OCR packaging and box-coordinate mapping are platform-sensitive.
- Corpus licensing/confidentiality — must be anonymised or legally reusable.
