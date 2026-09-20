# Phase 4 — Workflows (first use, lifecycle, integrations)

Objective: a fresh user can complete the real tender lifecycle without sample data, and
cross-app writes go through typed, revision-aware integrations.

Read `contracts-and-invariants.md` first. Persistence, readiness, and the authoritative
store from Phase 2 are the foundation. UI-visible work should go through `@designer`;
mechanical wiring through `@fixer`.

## Phase 4 exit criteria

1. A clean install reaches a useful workspace with **no sample records**, and every record
   needed to produce a truthful bid pack can be created and maintained.
2. Submission evidence and outcome are recorded honestly (the app never claims it
   submitted anything by itself).
3. CRM and Books integration is typed, idempotent, and never a prerequisite for the core
   workflow.
4. Proposal generation has a main-owned canonical readiness snapshot (truthful positive
   `READY` is possible end-to-end).

## WP-8 — First-use separation and company/customer CRUD

Problem (from the audit): a new company had **no visible way to add/edit customers** and
**no way to edit the company profile**, while seeded sample data made the product look
complete.

Files: `components/App.tsx`, `components/OnboardingModal.tsx`,
`components/pages/ProfilePage.tsx`, `components/pages/CustomersPage.tsx`,
`components/pages/OverviewPage.tsx`, `renderer/src/store.ts`, new
`CompanyFormDialog.tsx`, `CustomerFormDialog.tsx`, `FirstUsePage.tsx`, mock sources.

Required:

- Fresh install presents two explicit choices: **Set up company** vs **Explore sample
  workspace**. Demo data lives in a clearly labelled, isolated demo workspace
  (`dataOrigin: 'demo'` already exists in v2). Demo must never be a recovery fallback.
- Disable CRM/Books writes from demo data unless the user explicitly copies a tender into
  a real workspace.
- Company create / view / edit / archive: registration, VAT, tax/TCS PIN, CSD, B-BBEE,
  directors, capability/profile text, projects, contacts, addresses.
- Customer create / view / edit / archive, including required-document definitions.
- Replace passive empty states with contextual actions ("Add customer", "Complete company
  profile", "Upload your first document").
- Fix copy that says files are "session-only / kept in this browser" — they persist to disk.

Keep customers intentionally tender-focused. Do **not** add CRM-style activities,
pipelines, campaigns, or enrichment.

Acceptance: fresh-install E2E reaches a useful empty workspace with no sample records;
company/customer CRUD persists through restart; deleting a company lists owned
tenders/documents and requires confirmation.

## WP-11 — Submission receipt and outcome lifecycle

Problem: workflow stops at `READY_FOR_SUBMISSION`; there is no proof of submission and no
outcome record. `TenderStatus` has four states but the UI only moves between two.

Files: `shared/types.ts`, new `shared/lifecycle.ts`, `renderer/src/store.ts`, new
`components/SubmissionDialog.tsx`, `OutcomeDialog.tsx`, `TenderLifecyclePanel.tsx`,
`components/Workspace.tsx`, `components/TenderList.tsx`.

Lifecycle states: preparing → ready to assemble → pack generated → ready to submit →
submitted (evidence required) → submitted (evidence recorded) → won / lost / withdrawn /
cancelled → archived.

Submission records capture: submitted date/time + time zone, method and destination,
confirmation/reference number, receipt/evidence attachment, person, notes, and the
readiness snapshot at submission.

Rules:

- A current readiness checkpoint is required to submit. Exceptionally submitting with
  blockers requires an explicit override reason and preserves the blocker snapshot — and
  is never described as "cleared".
- Outcome records: pending / won / lost / withdrawn / cancelled, notice date, reason,
  awarded value, evidence attachment.
- Won enables contract milestones and optional CRM synchronisation. Lost/withdrawn must
  not expose milestone billing.
- Keep an append-only-enough lifecycle history (when/why status changed).

Acceptance: state-machine tests; override audit tests; submitted tenders visibly show
receipt/evidence status; outcome survives restart and reflects in Overview and (when
requested) CRM.

## WP-10 — Typed CRM and Books integration ports

Problem: Tenders previously wrote `crm/deals.json` directly. Phase 2 already routed
`syncWithCrm` and `billMilestoneInBooks` through the authoritative store `mutate`, resolved
paths in main, added `expectedRevision` conflict handling, and added the Books
`crmDealId = tender-milestone-<tenderId>-<milestoneId>` idempotency key. Remaining work is
the **typed port** layer and the known races.

Files: `shared/ipc.ts`, `main/tenders-main.ts`, new `main/integrations.ts`,
`renderer/src/components/Workspace.tsx`, `MilestonesDrawer.tsx`,
`apps/crm/src/shared/types.ts`, `apps/crm/src/main/crm-store.ts` / `crm-main.ts`,
`apps/books/src/main/books-core.ts`, `apps/shell/src/main/index.ts`.

Required:

- Define small typed ports injected through `configureTendersRuntime` (shell is the
  composition root): upsert tender opportunity, update tender outcome, issue milestone
  invoice, open owning app at returned entity.
- CRM owns deal validation/audit/soft-delete/recovery; add typed tender-provenance fields
  to the CRM `Deal` type instead of undeclared runtime properties.
- Surface integration errors + retry in Tenders; core workflow must pass with integrations
  disabled.
- Fix the two known races: `syncWithCrm` currently persists the CRM file **before** the
  tender commit (partial application on conflict) — resolve tender revision first or
  reconcile; the billing reservation is an in-memory CAS — consider a persisted
  `BILLING_IN_PROGRESS` marker or reconciliation on conflict.
- Discovery gate: if Docs lacks a stable creation API, keep Markdown generation and label
  it as Markdown.

Acceptance: no Tenders module reads/writes `crm/deals.json`; repeating CRM sync updates
one deal; a mid-commit crash around milestone billing creates at most one invoice;
CRM recovery lock prevents writes with a useful error.

## Readiness snapshot binding (deferred from Phase 2)

Deliver here so the proposal path can finally say `READY` truthfully:

- Main loads canonical tender + company + vault for the requested tender id and builds the
  `ReadinessReport` itself; pass it to `generateProposalMarkdown(input, { readinessReport })`.
- Include tender id/revision/fingerprint in the report and verify it matches before
  emitting ready language (a report must not be applied to the wrong or stale tender).
- Add a parity test: a proposal cannot be `READY` unless the canonical report is ready.

Files: `main/tenders-main.ts`, `main/proposal-generator.ts`, `shared/readiness.ts` (report
fingerprint), tests.

## Tests / evidence

- Fresh-install E2E; demo-isolation E2E; CRUD + restart tests.
- Lifecycle state-machine tests; override audit; submission receipt E2E; won/lost paths.
- Typed contract tests per port; corrupt/invalid CRM store; duplicate-request tests;
  cross-app Electron E2E (Tenders ↔ CRM ↔ Books).
- Proposal readiness parity tests.

## Risks

- Workspace/company deletion has broad data impact — must reuse the managed-file/trash
  semantics (deferred Phase 2 item) before destructive delete ships.
- Cross-app E2E is heavy; keep it to the critical paths.
