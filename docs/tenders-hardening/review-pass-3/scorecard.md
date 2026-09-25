# Review Pass 3 — Scorecard (final, measured)

Computed after the fix wave (Groups A–G, commits `b67b9c5` `2d3288b` `df329b8` `51ea562` `4c5033f` `18648ea` `8f68cef`, HEAD `8f68cef`) and the serial verification. Every category score cites confirmed findings (`findings.md`) and the measured gates below. No category is scored from a projection.

## Measured gates at `8f68cef`

| Gate                             | Result                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tenders unit suite               | **59 files / 1929 passed / 7 skipped / 0 failed**                                                                                                                                                                                                                                                                                                                        |
| Repo typecheck (28 workspaces)   | **28/28 PASS** (exit 0)                                                                                                                                                                                                                                                                                                                                                  |
| Six gates + e2e-types + baseline | **8/8 PASS** (`check:baseline`: "no regressions"; the 2 CLI regressions were the OneDrive wipe's missing sheets fixtures — regenerated, now green)                                                                                                                                                                                                                       |
| `build:all` (11 workspaces)      | **BUILD OK** (exit 0, ~2.5 min)                                                                                                                                                                                                                                                                                                                                          |
| Full Playwright e2e              | **166 passed / 3 failed / 7 skipped** (19.1 min). Of the 3: `html-tab:46` passes alone (load artefact — isolated run is the verdict); `docs-spellcheck-reenable:51` and `html-tab:276` fail in isolation but are non-Tenders specs at committed HEAD on a clean tree — **not caused by this wave**, recorded for the docs/html workstreams. **Tenders e2e lane: green.** |

## Final scores (verified findings only)

| Category        | Before (pass 2) | At `77c6b68` (this pass) | **Final** | What moved it                                                                                                                                            |
| --------------- | --------------- | ------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture    | 7.5             | 8.5                      | **9**     | F1 (open-boundary refusal gap) fixed; F8.4 comment fixed; structure verified clean by all 10 reviewers                                                   |
| Correctness     | 8               | 8.5                      | **8.5**   | F3, F5 fixed; **cap: accuracy claim rests on the synthetic corpus (owner decision)**                                                                     |
| Security        | 5               | 8.0                      | **8.5**   | F1 (real trailing-dot bypass) fixed; F2 (defense-in-depth) fixed; **cap: shared-process sender check for other apps' handlers (outside `apps/tenders`)** |
| Data Integrity  | 7.5             | 8.0                      | **8.5**   | F3, F4, F5 fixed; no data-loss path remains                                                                                                              |
| Test Quality    | 7               | 8.0                      | **8.5**   | F6 isolation leak sealed (file green 6× + shuffled); suite now 1929 passing incl. 28 new pins                                                            |
| UI/UX & a11y    | 8               | 8.0                      | **8.5**   | F7 overlay collision fixed with real-render pins (4/4, mutation-checked)                                                                                 |
| Maintainability | 7               | 8.5                      | **9**     | F8 doc drift fixed; no behavior defects found                                                                                                            |
| Documentation   | 7               | 7.5                      | **8.5**   | F8.1–F8.7 all fixed; HEAD perf work now recorded in the hardening docs                                                                                   |
| Performance     | 6               | 8.5                      | **8.5**   | No defects found (save-cost exactness fuzz-verified); 12M-char freeze = named product decision                                                           |
| Error Handling  | 5               | 8.0                      | **8.5**   | F2 + F4 fixed; fail-closed posture verified everywhere else                                                                                              |

**Overall: 8.6/10 — measured, not projected.**

## The honest answer to "is it a genuine 9/10?"

**Not quite — and the gap is now precisely known.** Within `apps/tenders` itself, every confirmed defect from this pass is fixed and pinned, and the suite/gates/e2e all re-measured clean. The two remaining points are owner decisions, not code:

1. **Correctness (8.5, capped):** the accuracy claim is measured on a synthetic, rule-derived corpus. Only licensed/anonymised real SA tenders can move it past ~8.5. Data decision.
2. **Security (8.5, capped):** the shell's other apps' main-process handlers (CRM first) still lack the sender check the Tenders handlers carry, and the Tenders renderer shares that process. A shell/CRM scoped change — a different codebase.

Plus two product decisions already named in-source: the 12,000,000-char-paragraph freeze (lower a published limit or add a `document.xml` byte ceiling) and the DOCX parse seam (engine not ours; worker or engine change).

## Refutation ledger

8 findings refuted with mechanical evidence (`findings.md`), none fixed, none counted — including both load-bearing false findings of the previous pass (unguarded handler; Workspace subscription). 1 finding classified out-of-scope (12M-char freeze) with its mechanism verified. **This pass's rule held: a finding is a lead, not a fact — reproduce it, then count it.**

## One deviation from plan

The plan's Task 2 called for per-category reviewer files; explore agents are read-only (no Write), so reviewers returned reports and the coordinator consolidated them into `findings.md`. The record is complete; the artifact shape differs only.
