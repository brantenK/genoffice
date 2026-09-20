# Phase 5 — Product quality and release evidence

Objective: the app is comfortable, accessible, theme-correct, bounded, and provably
release-ready. Broad but low-risk per item. UI work goes through `@designer`; hardening
through `@fixer`; verification through `@e2e-runner`.

Read `contracts-and-invariants.md` first. Note many IPC/security items are **already
done** (Phase 2 F1–F4); the remainder is listed below.

## Phase 5 exit criteria

1. Core workflow usable at 1280×800, 1024×768 and 800×600, and keyboard-only.
2. Light / dark / system themes work without changing document/PDF rendering.
3. No critical/serious accessibility violations on core pages; dialogs/drawers have
   correct semantics and behaviour.
4. Published, measured performance/scale limits hold on reference hardware.
5. Packaged-build evidence and accurate limitation copy are in place.

## WP-12 — Responsive workspace and action hierarchy

Problem (audit): the fixed matrix/PDF split becomes cramped at ~1000px; toolbar actions
carry equal weight; secondary integrations compete with the next compliance action.

Files: `components/Workspace.tsx`, `components/RequirementList.tsx`,
`components/PdfViewer.tsx`, `components/App.tsx`, `styles/tenders.css`.

Required:

- Wide mode: resizable split with persisted proportion and sensible min/max bounds.
- Compact mode: segmented Requirements ⇄ PDF switch instead of squeezing both; preserve
  selected requirement and page when switching.
- Collapse metadata and low-frequency actions into a labelled overflow menu.
- Primary action order: 1) resolve/review blockers, 2) readiness/submission, 3) evidence
  vault. Export/proposal/CRM/milestones secondary.
- Sticky context headers that do not obscure content.

Acceptance: no horizontal clipping or unreachable controls at 800×600; usable at 200%
text zoom; Playwright at 1280×800 / 1024×768 / 800×600 with visual snapshots.

## WP-13 — Accessibility and light/dark/system theme

Problem (audit): dialogs ignored Escape and lacked `role="dialog"`; some icon controls
unnamed; system dark preference left Tenders light; supporting text very small/pale.

Files: shared dialog/drawer primitives (new, in `components/ui.tsx` or new
`Dialog.tsx`/`Drawer.tsx`/`ConfirmDialog.tsx`), all overlay components, `styles/tenders.css`,
`packages/ui/src/tokens.css` only if a semantic token is genuinely missing,
`e2e/theme-pipeline.spec.ts`, new `e2e/tenders-a11y-theme.spec.ts`.

Required:

- Semantic dialog/drawer primitive: labelled heading, `aria-modal`, Escape close, focus
  trap, initial focus, focus restoration on close.
- Keyboard-operable critical journeys; named icon buttons; visible focus; ≥24×24px targets.
- Status not conveyed by colour alone.
- Connect Tenders to suite theme events (`data-theme`), replace fixed light-only utilities
  with semantic tokens; PDF page canvases and document colours must **not** change with UI
  theme.
- Add automated axe scan + manual keyboard/screen-reader checks.

Acceptance: system/light/dark switch live and survive relaunch; no critical/serious axe
violations on core pages; full critical journey works by keyboard with no trap; contrast
4.5:1 normal / 3:1 large.

## WP-14 — Remaining IPC, export and diagnostic hardening

Already done (Phase 2): all Tenders privileged handlers trust-gated; persistence payload
bounds; path confinement for persistence; legacy downgrade guard; filtered broadcasts.

Remaining:

- Centralize authorization for the broader handler set if new channels are added; keep
  `isTrustedTendersEvent` as the single gate.
- Fail closed when trusted renderer URL is unconfigured (`isTrustedTendersEvent` /
  `isTrustedTendersWebContents` currently fail open).
- Compact `saveStoreV2` conflict payload (drop the full `current` document).
- Remove the `getAuthoritativeTendersStore(filePath?)` override parameter or assert it
  equals the default.
- Bound `saveDocument` buffer size; bound document upload/read.
- Neutralize CSV formula-leading cells in matrix export while keeping RFC 4180 + BOM.
- Ensure user-triggered IPC failures are always visible in the UI, not console-only.
- Optional diagnostic export: versions, counts, failure codes, redacted paths — never
  tender text.

Files: `shared/ipc.ts`, `main/tenders-main.ts`, `shared/validation.ts` (if added),
`main/ipc-handlers.ts` (if the main file is split), tests.

## WP-15 — Performance and supported-scale boundaries (remainder)

Phase 3 covers import scale. Remaining here:

- Publish tested limits on reference hardware; if candidates are not met, publish smaller
  honest limits.
- Virtualize/evict off-screen PDF canvases; keep page geometry/placeholders.
- Index vault keywords once per analysis rather than per requirement.
- Add benchmark scripts and a memory trace.

## Release evidence and gates

Alpha hardening gate:

- canonical readiness used by UI and proposals; no false-clear; unsafe proposal boilerplate
  removed; save failures visible; no blob fallback; explicit corruption recovery; empty
  workspaces stay empty; tests + typecheck + Tenders/Shell builds pass.

Private Beta gate:

- parser improvements + extraction review; honest scanned-page behaviour (packaged OCR
  where supported); company/customer CRUD; demo separation; managed-file delete/undo/
  reconciliation; submission receipt/outcome lifecycle; typed CRM/Books integrations;
  narrow workspace + keyboard access; no critical accessibility findings; recovery drills;
  corpus metrics documented.

Paid v1 / 9-of-10 gate:

- every must-have accepted; full unit/property suite; built-artifact Electron E2E suite;
  migration + backup-restore from a preserved v1 fixture; packaged OCR smoke where claimed;
  accessibility + keyboard checks; light/dark/system visual checks; published scale limits;
  real tender corpus report with **zero false-clear**; visible limitation copy including
  "not legal advice" and "submission is not automated".

## Absolute paid-release blockers (carry over)

1. Proposal/readiness false-clear behaviour.
2. Invented methodology, credentials, pricing, VAT or payment terms.
3. Silent save/upload failure or session-blob presented as durable.
4. Corrupt data replaced/merged with demo state.
5. Scanned pages presented as analysed when OCR did not run.
6. No correction path for critical extracted values/requirements.
7. Vault/tender deletion can orphan files without detection/recovery.
8. Direct Tenders manipulation of CRM storage.
9. Non-idempotent milestone billing.
10. Unvalidated privileged IPC or exploitable paths.
11. Core workflow unusable by keyboard or at supported narrow viewport.
12. Theme leaves substantial Tenders chrome unreadable.

Items 1–2, 8–10 are already addressed in the Phase 1–2 work; re-verify each at the gate.
Items 3, 5, 6, 7, 11, 12 depend on the deferred durability items and Phases 3–5.
