# Tenders Third Review + Finish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a measured, trustworthy 10-category score for `apps/tenders` at committed `77c6b68` — via a third independent review pass in which every finding is mechanically verified before it counts — then fix only the verified findings, re-verify end to end, and deliver a final scorecard plus the owner hand-offs. This is the step that replaces every prior projection ("~8.7", "6.8") with a number that can be acted on.

**Architecture:** The work is a review-and-remediate campaign, not a feature build: (1) tree hygiene + verified baseline, (2) a 10-reviewer independent pass scoped to `apps/tenders` with per-finding mechanical verification mandated, (3) consolidation + scoring from verified findings only, (4) a fix wave over confirmed findings with exclusive file ownership and reproduce-before-fix, (5) serial full verification, (6) final measured scorecard + process record, (7) owner hand-offs that are explicitly not code.

**Tech Stack:** Vitest (`apps/tenders`), tsc 28-workspace repo typecheck, the six repo gates (`check:brand`, `check:app-chrome`, `check:theme-colors`, `check:english-comments`, `check:skill-version`, `format:check`), `check:e2e-types`, `check:baseline`, `build:all`, Playwright e2e (`npm run test:e2e`). Swarm execution via `AgentSwarm` (explore for reviewers, coder for fixes).

**Spec:** The rubric is the same 10 categories used by the first review pass: Architecture, Correctness, Security, Data Integrity, Test Quality, UI/UX & a11y, Maintainability, Documentation, Performance, Error Handling. The process contract is `fork/RUNBOOK.md` — especially its "a finding is a lead, not a fact" section and the five verification shapes. This plan argues from both; executors read `fork/RUNBOOK.md` first.

## Global Constraints

- Branch `product` only. Never touch `main`, never rebase, never force-push. Normal pushes go to `origin`.
- **The Books workstream is mid-flight in the same tree** (~45 uncommitted files under `apps/books/`, plus `.agents/books_hardening/`). Do not touch, stage, commit, format, or typecheck-fix any of them. Commit the Tenders work with explicit `git add` of Tenders paths only.
- **Delete the 7 untracked TEMPORARY probes in `apps/tenders/tests/` before any suite run** (Task 1). They are explicitly marked for deletion, they pollute the vitest glob, and the "no scaffolding left" claim at `77c6b68` missed them:
  `tmp-ui-review-probe.test.tsx`, `zz-probe-durability.test.ts`, `zz-temp-probe-observability.test.ts`, `zzz-perf-probe.test.ts`, `zzz-secprobe-me.test.ts`, `zzz-secprobe2-me.test.ts`, `zzz-secprobe3-me.test.ts`.
- **OneDrive-shared disk, two workstreams:** run heavy suites one at a time. A failure that passes alone is a load artefact — the isolated run is the verdict. Never "fix" a load artefact and never weaken an assertion to make a loaded run pass.
- **A finding is a lead, not a fact.** Reproduce it mechanically (RUNBOOK's five shapes) before it counts toward a score or a fix. A refuted claim is reported as **refuted**, never as "fixed". Do not change code to satisfy an unreproduced finding.
- **Check the checkout is LF, not CRLF, before reading source-based guards.** A CRLF checkout makes multi-line-anchor guard tests fail on the checkout, not the component — that is itself the finding.
- **No score projections.** Every number in the final scorecard is measured from verified findings only. Nobody estimates.
- **Commit staged explicitly and record refutations in the commit message** — the other workstream is live in the same tree.

## Review Focus

The five failure modes this campaign must not repeat (each is pinned to the task that owns the check):

1. **CRLF checkout** — source-guard tests that pin LF anchors fail on a CRLF checkout and report component defects that exist nowhere else. Owned by Task 1 (verify `file`/gitattributes state) and Task 2 (reviewers must check before reading).
2. **Untracked probe files in `tests/`** — inflate the suite count and read as product tests to a reviewer. Seven are live right now; owned by Task 1.
3. **Load-flaky e2e on the shared machine** — shifting failures that all pass alone; the lone pass is the verdict. Owned by Task 5 (serial, quiet-machine runs only).
4. **Line-number rot after the `main/` and `ipc/` splits** — stale citations from a previous edit; re-derive every cited line from disk. Owned by Tasks 2–3 (the five verification shapes).
5. **Vacuous test guards** — a guard that still passes after the behaviour it pins is deleted. Owned by Task 4 (mutation-style verification on every "weak test" finding before repair).

## File Structure

| File / path                             | Responsibility                                         | Action                                                         |
| --------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| `apps/tenders/tests/` (7 probe files)   | Scratch verification probes                            | Delete (Task 1)                                                |
| `docs/tenders-hardening/review-pass-3/` | New review artifacts: per-category findings, scorecard | Create (Tasks 2–3, 6)                                          |
| `apps/tenders/src/**`                   | The reviewed and fixed product code                    | Fix only verified findings (Task 4)                            |
| `fork/RUNBOOK.md`                       | Process contract; record any new verification lesson   | Append only if a new lesson surfaces (Task 6)                  |
| `fork/BASELINE.md`                      | Known-failure baseline                                 | Re-record Tenders lane only (Task 6)                           |
| `fork/COMPLIANCE.md`                    | Fork rules                                             | Read-only reference; not changed unless the record requires it |

**Artifact contracts between phases** (so each phase's agents can hand off without shared context):

- **Finding record** — one file per reviewer: `docs/tenders-hardening/review-pass-3/<category>.md`. Each finding is a bullet with: the claim, the exact reproduction (command/run/grep + output), the verdict `confirmed` / `refuted` / `out-of-scope`, and why. No verdict without a reproduction attached.
- **Scorecard** — `docs/tenders-hardening/review-pass-3/scorecard.md`: the 10 categories, each with a 1–10 score, the verified findings that moved it, and the refuted findings that did not.
- **Fix list** — `docs/tenders-hardening/review-pass-3/fix-list.md`: confirmed, in-scope, code-fixable findings with exclusive file-ownership groups. Generated by Task 3; consumed by Task 4.

---

### Task 1: Tree hygiene and verified baseline

**Files:**

- Delete: `apps/tenders/tests/tmp-ui-review-probe.test.tsx`, `apps/tenders/tests/zz-probe-durability.test.ts`, `apps/tenders/tests/zz-temp-probe-observability.test.ts`, `apps/tenders/tests/zzz-perf-probe.test.ts`, `apps/tenders/tests/zzz-secprobe-me.test.ts`, `apps/tenders/tests/zzz-secprobe2-me.test.ts`, `apps/tenders/tests/zzz-secprobe3-me.test.ts`

**Interfaces:**

- Consumes: committed `77c6b68`; RUNBOOK constraints.
- Produces: a clean, measured baseline (file count + pass/fail/skip) that Tasks 2–5 compare against.

- [ ] **Step 1: Confirm the checkout line endings are LF**

Run: `git check-attr eol -- apps/tenders/tests/error-boundary.test.tsx` and `file apps/tenders/src/main/ipc/handlers.ts`
Expected: `eol: lf` (or unset, meaning repo default LF) and `ASCII text` — not CRLF. If CRLF, stop and report: the tree itself is the finding (RUNBOOK, failure mode 1).

- [ ] **Step 2: Delete the 7 probe files**

```bash
git rm -f --cached 2>/dev/null; rm -f \
  apps/tenders/tests/tmp-ui-review-probe.test.tsx \
  apps/tenders/tests/zz-probe-durability.test.ts \
  apps/tenders/tests/zz-temp-probe-observability.test.ts \
  apps/tenders/tests/zzz-perf-probe.test.ts \
  apps/tenders/tests/zzz-secprobe-me.test.ts \
  apps/tenders/tests/zzz-secprobe2-me.test.ts \
  apps/tenders/tests/zzz-secprobe3-me.test.ts
```

- [ ] **Step 3: Verify only Books workstream files remain uncommitted**

Run: `git status --porcelain | grep -v '^ M apps/books' | grep -v '^?? apps/books' | grep -v '^?? .agents/books_hardening'`
Expected: empty output. Anything else (especially anything under `apps/tenders` or `apps/shell`) is scaffolding — remove it.

- [ ] **Step 4: Measure the green baseline**

Run: `npm run test -w @genoffice/tenders` (~104 s)
Expected: 58 test files, ≥ 1901 passed / 7 skipped / 0 failed (record the exact numbers; this is the comparator for every later run).

- [ ] **Step 5: Confirm the IPC invariant still holds at HEAD**

Run: the brace-matched registration parse from RUNBOOK — split `apps/tenders/src/main/ipc/handlers*.ts` on the registration call, take the first statement of each body, require the `isTrustedTendersEvent` gate.
Expected: 33 channels, 33 first-statement gates, none missing. (This is the mechanical shape that refuted "1 of 34 is unguarded" — do not re-verify by grepping for the gate's name.)

- [ ] **Step 6: Commit (staged explicitly)**

```bash
git add -u apps/tenders 2>/dev/null; git status --porcelain | grep apps/tenders || true
git commit -m "chore(tenders): remove temporary review probes left after wave 6"
```

Expected: commit touches nothing under `apps/books`.

---

### Task 2: Third independent review pass — 10 reviewers, verification mandated

**Files:**

- Create: `docs/tenders-hardening/review-pass-3/<category>.md` (×10)

**Interfaces:**

- Consumes: clean tree from Task 1; `fork/RUNBOOK.md` verification rules; the committed `77c6b68` state.
- Produces: 10 per-category finding records, every finding carrying a reproduction and a verdict. **No scores yet.**

- [ ] **Step 1: Dispatch 10 explore reviewers via `AgentSwarm`**

One reviewer per category, prompt template with `{{item}}` = the category name. The filled prompt MUST contain, verbatim in spirit:

> You are one reviewer in an independent 10-category re-review of `apps/tenders` at committed `77c6b68` (branch `product`). Your category: `{{item}}`.
>
> Read `fork/RUNBOOK.md` first — especially "An agent-driven review: a finding is a lead, not a fact". Your job is to verify, not to trust, and you must not edit anything.
>
> Ground rules:
>
> 1. Before reading source-based guards, confirm the checkout is LF, not CRLF (`git check-attr eol`). A CRLF checkout makes guards lie — that is itself a finding.
> 2. The Books workstream has ~45 uncommitted files in the tree. Ignore them entirely; they are not part of this review.
> 3. Every finding must carry a mechanical reproduction — run it, grep it, render it, measure it — and the output. Five shapes: guard-missing (count registrations vs first-statement gates, mechanically), wrong-call-site (read + run the covering test), broken-render (render the real component via `apps/tenders/tests/helpers/render.tsx` with the console watched), never-existed (git grep + `git log -S`), vacuous-test (delete the pinned behaviour, re-run).
> 4. Verdict per finding: `confirmed` / `refuted` / `out-of-scope` (out-of-scope = product decision or a different app — name it). A claim that cannot be reproduced is `refuted`, not "unverifiable".
> 5. Line-number citations rot after the `main/` and `ipc/` splits — re-derive every cited line from disk before reporting.
> 6. Do not score. Report findings and evidence only.
>
> Write `docs/tenders-hardening/review-pass-3/{{item}}.md` with the findings, each: claim → reproduction (command + output) → verdict → why.

- [ ] **Step 2: Check the pass completed and nothing was edited**

Run: `git status --porcelain | grep -v '^ M apps/books' | grep -v '^?? apps/books' | grep -v '^?? .agents/books_hardening'`
Expected: only `?? docs/tenders-hardening/review-pass-3/` — the reviewers' output. Any source change is a protocol violation; revert and re-run the offending reviewer.

- [ ] **Step 3: Sanity-scan the 10 records**

For each `docs/tenders-hardening/review-pass-3/*.md`: every `confirmed` or `refuted` verdict has a reproduction attached; every `refuted` names the evidence that disposed of it. If a record is a list of assertions with no reproductions, send it back — it does not count.

---

### Task 3: Consolidation, verification of contested findings, scorecard draft

**Files:**

- Modify: `docs/tenders-hardening/review-pass-3/<category>.md` (dedupe, contested re-verification)
- Create: `docs/tenders-hardening/review-pass-3/fix-list.md`, `docs/tenders-hardening/review-pass-3/scorecard.md`

**Interfaces:**

- Consumes: the 10 finding records from Task 2.
- Produces: the deduped verified finding set, the scorecard draft, and the fix list with ownership groups.

- [ ] **Step 1: Dedupe and cross-check**

Merge findings that multiple reviewers reported; where two reviewers contradict on the same claim, re-run the mechanical reproduction yourself (the RUNBOOK shapes) and let the output decide. Record the tiebreak in the category file.

- [ ] **Step 2: Apply the same discipline to every load-bearing finding**

Any finding that would move a category score by ≥ 1 point gets a second, independent reproduction before it counts. The RUNBOOK's four refuted findings are the cautionary set: "a test can't pass", "an unguarded IPC handler", "a live subscription-over-early-return", "a shipping half-built lane" — each was false in the prior pass.

- [ ] **Step 3: Classify and write the fix list**

For every `confirmed` finding: `fixable-in-tenders` / `product-decision` (name the decision and the owner) / `other-app` (name the app). Write `fix-list.md` with `fixable-in-tenders` findings grouped by exclusive file ownership — one group per agent, no two groups sharing a file.

- [ ] **Step 4: Draft the scorecard from verified findings only**

Score each category 1–10 using only `confirmed` findings; record `refuted` findings alongside each category with their evidence (so the scorecard documents what did _not_ count). Apply the two known honest caps, labelled as caps, not defects: Correctness ≤ ~8.5 while the accuracy claim rests on the synthetic corpus (a real-tenders data decision); Security's shared-process Blocker if still present (other apps' handlers in the shell process without the sender check — outside `apps/tenders`).

- [ ] **Step 5: Commit the records**

```bash
git add docs/tenders-hardening/review-pass-3
git commit -m "docs(tenders): third review pass records — findings, refutations, scorecard draft"
```

---

### Task 4: Fix wave — verified findings only, exclusive file ownership

**Files:**

- Modify: exactly the files named in `fix-list.md` ownership groups (nothing else under `apps/tenders`)
- Test: the covering test file(s) for each fix

**Interfaces:**

- Consumes: `fix-list.md` from Task 3.
- Produces: one commit per ownership group; each commit's message lists the finding IDs fixed and the refutations recorded.

**Protocol for every fix (this is not a placeholder — it is the contract):**

1. **Reproduce first.** Run the mechanical reproduction from the finding record. If it does not reproduce on the clean tree, the finding is refuted — record it, do not fix (RUNBOOK: acting on the unreproduced Workspace claim would have damaged code).
2. **Write the failing test** that pins the verified defect (project has tests — use them; follow the file's existing style).
3. **Run it, confirm it fails** for the right reason.
4. **Implement the minimal fix.**
5. **Run the test, confirm green** — then the full file's tests.
6. **Mutation-check weak-guard findings:** for any "vacuous guard" finding, delete the behaviour being pinned and confirm the guard now fails. A guard that still passes is vacuous and must be repaired, whatever its shape.
7. **Commit staged explicitly** (never `git add -A`):

```bash
git add <files-for-this-group>
git commit -m "fix(tenders): <finding IDs fixed>; refuted: <any refuted in this group>"
```

**Known candidates already in the queue from wave 6's report** (fix them only if Task 3 confirmed them — each carries its own reproduction):

- `docx-intake.test.ts:707` load-sensitive flake needs an owner. Do not weaken it; the resolution is serial/quiet-machine runs (RUNBOOK rule), not a loosened assertion.
- The `validateTendersDataV2` schema walk is the largest remaining UI-thread cost (~150–185 ms per save). A fix needs a worker or a partial-revalidation API — a design decision beyond one file. If the review confirms it blocks Performance ≥ 9, say so in the scorecard and hand the design to the owner rather than half-fixing it in the wave.

**Explicitly NOT in this wave (do not attempt):**

- The accuracy-claim ceiling (Correctness) — owner data decision.
- The shell-wide sender check for other apps' handlers (Security, shared shell process) — a different codebase (`apps/crm` first), needs its own scoped change.
- The 12,000,000-character-paragraph freeze (a two-line document freezing the renderer for 5.5 s inside the published envelope) — fixing by design means lowering a published limit or adding a `document.xml` byte ceiling: a product decision, report not fix.
- The DOCX parse seam (no yield inside `parseDocx`; the engine is not ours) — same class, report not fix.

- [ ] **Step 1: Dispatch fix agents via `AgentSwarm`, one per ownership group** (coder type; each prompt embeds the group's findings from `fix-list.md` + the protocol above).
- [ ] **Step 2: Verify each agent's commit — re-run the finding's reproduction and the covering tests.** A fix whose reproduction no longer fires and whose tests pass is done; a fix whose tests pass but whose reproduction still fires was not a fix.
- [ ] **Step 3: Confirm `git status` shows no Tenders files left uncommitted and no Books files were staged.**

---

### Task 5: Serial full verification

**Files:** none (verification only)

**Interfaces:**

- Consumes: the fix-wave commits.
- Produces: the measured gate table that the scorecard's final numbers cite.

- [ ] **Step 1: Tenders unit suite**

Run: `npm run test -w @genoffice/tenders`
Expected: ≥ 58 files, ≥ Task 1's pass count, 0 failed (record actual). Any failure: reproduce alone before touching anything (load artefact rule).

- [ ] **Step 2: Repo typecheck (28 workspaces)**

Run: `npm run typecheck`
Expected: 28/28 PASS. If the Books workstream files fail typecheck, that is theirs — record, do not fix (explicitly staged-scope rule).

- [ ] **Step 3: The six gates + e2e-types + baseline**

Run (in this order, matching `verify:sync`): `npm run check:brand`, `npm run check:app-chrome`, `npm run check:theme-colors`, `npm run check:english-comments`, `npm run check:skill-version`, `npm run format:check`, `npm run check:e2e-types`, `npm run check:baseline`.
Expected: all PASS. `format:check` may be red on Books files — that is the other workstream's lane; do not format their files (record it).

- [ ] **Step 4: Build**

Run: `npm run build:all` (~20 min under load). Expected: BUILD OK.

- [ ] **Step 5: Full e2e — quiet machine only**

Run: `npm run test:e2e` (~11 min healthy; up to ~50 shared — RUNBOOK table). Only run when the machine is unloaded; a shared-machine run's failures are not verdicts. Expected: full suite green. A lone pass is the verdict for any flake.

- [ ] **Step 6: Record the measured gate table** — every number from the runs above, into the scorecard and the final commit message.

---

### Task 6: Final measured scorecard and process record

**Files:**

- Modify: `docs/tenders-hardening/review-pass-3/scorecard.md` (final numbers + caps)
- Modify: `fork/RUNBOOK.md` (append, only if a new verification lesson surfaced)
- Modify: `fork/BASELINE.md` (re-record the Tenders lane)

**Interfaces:**

- Consumes: Task 5's measured gate table, Task 3's verified finding set.
- Produces: the answer to "is it a genuine 9/10?" — a score computed from verified findings, with every cap labelled.

- [ ] **Step 1: Finalize the scorecard.** Every category's score cites the verified findings and the measured gates. The scorecard states plainly what is measured vs what is a labelled cap (Correctness, Security-if-shared-process, the two product-decision limits).
- [ ] **Step 2: Record any new verification lesson** in `fork/RUNBOOK.md` (only if this pass surfaced a failure mode not already documented; do not pad).
- [ ] **Step 3: Re-record the baseline's Tenders lane** on a quiet tree:

```bash
node fork/tools/baseline.mjs --write --with-e2e --repeat 2
```

The Books lane is pinned to an older commit (the workstream is mid-flight) — record that the re-record covers the Tenders lane only, and flag the Books lane for re-recording when that workstream lands.

- [ ] **Step 4: Final commit**

```bash
git add docs/tenders-hardening/review-pass-3 fork/RUNBOOK.md fork/BASELINE.md
git commit -m "docs(tenders): final measured scorecard from the third verified review pass"
git push origin product   # after the RUNBOOK preflight: branch, status, tracking, remotes
```

- [ ] **Step 5: Deliver the scorecard to the owner** with the honest framing: what moved, what is capped and why, and the decision list (Task 7).

---

### Task 7: Owner hand-offs — explicitly not code

**Files:** none

**Interfaces:**

- Consumes: the final scorecard's capped categories.
- Produces: a decision list for the owner, each with evidence and concrete options.

- [ ] **Step 1: Write the decision list** (from the final scorecard, do not invent new items):

1. **Correctness cap** — accuracy claim rests on the synthetic, rule-derived corpus. Option: feed licensed/anonymised real SA tenders, or relabel the claim as harness-accounting. Owner: product.
2. **Security cap (if confirmed)** — the shell's other main-process handlers (CRM first) lack the sender check the Tenders handlers carry, and the Tenders renderer shares that process. Option: a shell-wide `isTrustedXxxEvent` gate wave scoped to `apps/crm`/shell. Owner: platform.
3. **12,000,000-char paragraph freeze** — inside the published envelope; fix means lowering a published limit or a `document.xml` byte ceiling. Owner: product.
4. **DOCX parse seam** — no yield inside `parseDocx` (engine not ours); a worker or engine change. Owner: platform/product.

- [ ] **Step 2: Present the decision list to the owner.** No item in this task may be acted on without the owner's call — that is the boundary between "finish the review" and "make product decisions".

---

## Self-Review

**Spec coverage:** The spec is the RUNBOOK contract + the 10-category rubric. Task 2 implements the review; Task 3 the verification/scoring protocol; Task 4 the fix discipline (including the "never fix an unreproduced finding" rule and the mutation check); Task 5 the measured gates; Task 6 the record; Task 7 the hand-offs. The five Review Focus failure modes are each pinned (CRLF → Task 1/2, probes → Task 1, load-flakes → Task 5, line rot → Tasks 2–3, vacuous guards → Task 4).

**Placeholder scan:** No TBD/TODO. Task 4's per-finding steps are generated from Task 3's confirmed list by design — the protocol (reproduce → red test → green → mutation check → staged commit) is fully specified, and the two known candidates carry concrete instructions. The out-of-scope items are named, not deferred ambiguously.

**Type consistency:** Artifact paths are consistent across tasks (`review-pass-3/`, `fix-list.md`, `scorecard.md`); commands are the<｜image｜> exact npm scripts from `package.json`; the IPC invariant is always the brace-matched 33/33 parse, never a grep.

**Review Focus:** All five lines from the Review Focus section are exercised by the owning tasks listed there.

**Known limits:** The scorecard's final numbers depend on what the review verifies — the plan guarantees the _process_ (nothing counts unverified, nothing gets fixed unreproduced) and the _measurement_ (gates re-run serially), which is the maximum a plan can promise before the review runs.
