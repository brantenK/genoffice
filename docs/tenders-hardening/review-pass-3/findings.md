# Review Pass 3 — Verified Findings Record

Independent 10-category re-review of `apps/tenders` at committed `77c6b68` (branch `product`), run 2026-09-25. Ten read-only reviewers, one per category; per-finding mechanical verification mandated (RUNBOOK: a finding is a lead, not a fact). This file consolidates the ten reports; reviewers were read-only, so their evidence was transcribed here verbatim.

**Baseline established before the pass:** suite = 58 files / 1901 passed / 7 skipped / 0 failed; IPC invariant = 33 channels / 33 first-statement `isTrustedTendersEvent` gates (brace-parse); checkout LF (verified). Every reviewer independently re-derived at least one of these.

## Confirmed findings (each carries its reproduction)

### F1 — Trailing-dot bypass of the macro/launcher open refusal (Security / Architecture)

`openDocumentFile` (`src/main/document-lifecycle.ts:147`) is the sole open gate: `refusalForUnopenableExtension(extname(check.fullPath).toLowerCase())` then `shell.openPath` (:149 — the only `shell.openPath` in main). A stored name ending in a dot — `evil.docm.` — has `extname === '.'`, and `'.'` is in neither refusal set; `sanitizeManagedFileName` (`document-store.ts:272-279`) preserves the trailing dot. Windows strips trailing dots when resolving the association, so the container opens under its `.docm` handler — exactly what the d24ead6 refusal exists to prevent. Reachable via upload name and discovery-download name, both treated as hostile input.
Reproduction (re-run independently by the coordinator):

```
extname('evil.docm.')      -> "."
sanitizeManagedFileName('evil.docm.','rfp') -> "evil.docm."
refusalForUnopenableExtension('.') -> null
```

Verdict: **confirmed**. Same hole class applies to the launcher (`.lnk.`) set.

### F2 — Diagnostics log line-forging via the `source` (and `level`) field (Error Handling / Security)

The d24ead6 remediation hardened `message` (whitespace collapse) and `detail` (U+2028/U+2029 escaping), but `formatDiagnosticsLine` (`src/main/diagnostics-log.ts:268`) interpolates `entry.source` and `entry.level` raw. A source containing `\n` or U+2028/U+2029 splits one entry into two lines; the second half reads as a genuine forged entry. The IPC boundary (`ipc/handlers-diagnostics.ts:34-43`) checks only string-ness, non-empty-after-trim, length ≤ 64 — no line-separator check. Two independent reviewers reproduced this against the real sink (3 lines on disk for 2 entries; a forged `[error]` line at line start; raw U+2028 → split). Reachability: benign callers today are safe (renderer logger collapses `\s+`; main callers use constants), so it is a defense-in-depth gap in the one file users attach to support tickets — the exact class the remediation claimed to close.
Verdict: **confirmed** (low severity). Existing pins (`diagnostics.test.ts:158-197`) cover message/detail only; nothing pins `source`.

### F3 — `restore` never returns a document to its recorded path; the rename-guard condition is inverted (Data Integrity)

`document-store.ts` `restore` always mints a fresh `<timestamp>_<uuid>_<name>` path. The guard `if (isRealPathInside(targetRoot, resolve(targetRoot, leaf)))` → mint new name; but every record the index admits has exactly 2 path segments with no `..`/`.` in the leaf, so `resolve(root, leaf)` is always strictly inside — the condition is always true and the else-branch (keep the original name) is unreachable. A restored document never reappears at its original `relativePath`, so any surviving `fileUrl` reference cannot reconnect — the lost repair the delete leaves dangling.
Reproduction (real store, save → trash → restore): `saved.relativePath = vault/<ts>_cert.pdf`; `restoredPath = vault/<newts>_<uuid>_cert.pdf`; `SAME PATH AS ORIGINAL? false`.
Verdict: **confirmed** (minor — no data loss; the TrashDrawer copy is honest about links). Pre-dates the last four commits; remediation-wave code, not a split regression.

### F4 — Diagnostics rotation: one failed rotation disables rotation for the session → unbounded growth (Data Integrity / Error Handling)

`diagnostics-log.ts` `rotate()` has no retry (every other rename in the app routes through `renameWithBoundedRetry*`), and a failure sets `rotationDisabled = true` permanently; entries keep appending, so the live file grows without bound, contradicting the module's stated "at most `maxBytes × maxFiles`" bound.
Reproduction (real sink, ceiling 300 B / maxFiles 3, EBUSY rename seam): `live file size after 50 entries: 6500 bytes; ceiling = 300; UNBOUNDED GROWTH CONFIRMED: true`.
Verdict: **confirmed** (minor — log-only, self-heals next session). One-line fix shape: route rotation through the shared retry helper.

### F5 — `parseLegacyRequirement` ships unvalidated `category`/`riskLevel` enum values (Data Integrity)

The parser's stated invariant — carry only fields "this reader understands … nothing here has validated" — is enforced for unknown _keys_ only; the two enum _values_ pass through with a `??` default and a type cast. A mis-typed value silently falls out of every known category group in the renderer instead of being refused or normalized.
Reproduction (real `migrateAndValidateTenders` over a v1 file with `category: 123, riskLevel: {bogus: true}`): both kept raw (number / object).
Verdict: **confirmed** (minor — only a corrupt/externally-edited v1 file produces it; a claims gap, not data loss).

### F6 — Intermittent full-suite flake: test-isolation leak in `renderer-store-v2.test.ts` (Test Quality)

The baseline is not a stable property: a full run can fail 3 tests across 2 files. One captured failure is a cross-test continuation leak — a save from the preceding "loaded" test (which saves with `expectedRevision 7`) firing after the per-test boundary (`vi.resetModules()` + fresh `window.tendersApi`) against the next test's mock. Evidence: `expect(api.saveStoreV2).not.toHaveBeenCalled()` failed with `Number of calls: 1` and payload `makeLoadedDoc(7)` — the previous test's fixture. Observed 1 in 8 full runs (then 7 green incl. shuffled + 16 single-file runs green) — not reproduced on demand.
Verdict: **confirmed** as an observed intermittent failure; the trigger is a deferred-save continuation surviving the reset boundary. Makes "0 failing" claims true on most runs but not all.

### F7 — Dialog-over-Drawer overlay collision: Escape closes BOTH overlays; forward Tab cannot reach the confirm action (UI/UX & a11y)

When a confirm dialog opens while its host drawer stays mounted (`MilestonesDrawer.tsx:636-653` "Create a tax invoice in Zano Books?"; `TrashDrawer.tsx:263-292` "Empty the trash?"), the two `useOverlayBehaviour` window-capture keydown traps both fire per keydown (`stopPropagation()` does not stop same-node listeners). Escape closes the drawer _and_ the dialog; forward Tab freezes on the initial control — the confirm button is unreachable by Tab. Violates the `aria-modal` isolation promise and contradicts `TrashDrawer.tsx:274`'s own comment.
Reproduction: faithful jsdom model of the exact listener code (`Dialog.tsx:74-105`, `Drawer.tsx:115`/`Dialog.tsx:151` wiring) with real mount order: Escape → drawer.onClose then dialog.onClose; Tab from Cancel: `c1 -> c1 -> c1 -> c1`; confirm reachable: NO. (Model, not real-mount — the fixing agent must reproduce with the real components first.)
Verdict: **confirmed** (moderate — keyboard users cannot reach the confirm action of in-drawer confirmations).

### F8 — Documentation drift after the splits (Documentation / Maintainability)

All mechanically confirmed, all minor:

1. `src/main/ipc/trust.ts:4` header still says every `ipcMain.handle` in `ipc/handlers.ts` begins with the gate — that file now has **0** registrations (they live in seven `handlers-*.ts` modules); the module-map doc teaches counting across `handlers*.ts`.
2. `src/main/tenders-main.ts:25` "WHERE EVERYTHING WENT" map lists `ipc/handlers.ts — all thirty-three ipcMain.handle registrations` and omits the seven domain modules.
3. `src/shared/ipc.ts:697` says discovery/reminder handlers live in `main/tenders-main.ts` — they are in `ipc/handlers-discovery.ts` / `ipc/handlers-reminders.ts`.
4. `src/main/ipc/handlers.ts:36-38` says the 33-channel figure is "the figure `TENDERS_CHANNELS` declares" — it declares **36** keys (33 handle + 3 push-only sends).
5. `src/main/ipc/handlers-store.ts:5` header says "What holds these five together" — the module registers **six** channels.
6. `src/renderer/src/store.ts:438,515,926` perf comments cite "the 3.0 MB document `tests/tenders-persistence-bounds.test.ts` builds" — that file builds **4 MiB** (`ASSUMED_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024`); no 3.0 MB fixture exists there.
7. HEAD's perf work (DOCX yield seams, save-cost derivation, 12M-char-paragraph 5.5 s freeze) is absent from `docs/tenders-hardening/` (README / contracts-and-invariants / module-map), which were last touched before `77c6b68`.

## Refuted findings (recorded with their evidence; NOT to be fixed)

| Claim                                                     | Evidence that disposed of it                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "An IPC handler is unguarded"                             | Mechanical brace-parse: 33 registrations, 33 first-statement gates, 0 missing; no `ipcMain.handle/on/once` outside `main/ipc`; `TENDERS_CHANNELS` = 36 = 33 handle + 3 push-only. (A naive splitter that treats the channel-arg parentheses as the body start reports 0 gated — the RUNBOOK recipe needs the handler-arg skip.)                                       |
| "Save-cost change mismeasures the pretty-printed bytes"   | `indentedJsonAddedBytes` fuzzed against `TextEncoder.encode(JSON.stringify(v,null,2)).length`: 200,000+ trials (empty containers, empty-string arrays, escapes, unicode, lone surrogates, U+2028/29, control chars, `1e21`/`-0`) — **0 mismatches**; live measurement: derived `fileBytes` 5 844 491 == real pretty 5 844 491; spy proves one serialization per save. |
| "DOCX yield seams are missing / break the abort contract" | `paintAndCheckAbort` (`setTimeout(0)` + `throwIfAborted()`) awaited between `shredExtraction`/`extractTenderMeta` and before the vault pass; in-memory mutations removing the seams make the source guards fail (live, not vacuous); cancel-in-gap stops the next stage.                                                                                              |
| "v2→v1 downgrade path is still open"                      | `legacyWriteRefusal` refuses any `schemaVersion`/unknown-`version` carrier before any filesystem side effect; `saveStoredData` accepts schema-v2 only; `validateTendersDataV2` refuses `schemaVersion !== 2`; `writeTendersStore` reachable only from tests. Pinned by `store-migrations.test.ts` §1b (green).                                                        |
| "A requirement with an unknown key is silently dropped"   | `parseLegacyRequirement` keeps the record and names unknown keys in `notes`; an unreadable requirement refuses the whole tender loudly with counts. Pinned (green).                                                                                                                                                                                                   |
| "Diagnostics log is forgeable via detail/message"         | Fixed at HEAD: U+2028/U+2029 escaped, one entry = one line, rotation failure no longer wipes the file — **except the F2 `source`/`level` residual**, which is a separate confirmed finding.                                                                                                                                                                           |
| "Macro containers are handed to `shell.openPath`"         | Refused at the open boundary for all 9 OOXML-macro + launcher extensions with macro-honest copy; macro-free documents still open — **except the F1 trailing-dot residual**, which is a separate confirmed finding.                                                                                                                                                    |
| "Planted-link refusal DoS's the document feature"         | `diagnoseManagedRoot` names the entry and the way out; refusal is graceful and the feature recovers once the link is removed (real symlink planted and removed in `document-durability-ipc.test.ts:320-356`).                                                                                                                                                         |
| "Tests are vacuous / guards tag-stripped"                 | No empty bodies or empty `expect()`; the hook-order guard physically moves the hook below the early return in a fresh copy and asserts the mechanism fires; delete-the-control is done in-test.                                                                                                                                                                       |
| "Skipped tests hide coverage"                             | All 7 skips are gated benchmarks under `describe.skipIf(!RUN_BENCH)` — deliberate, documented.                                                                                                                                                                                                                                                                        |
| "12M-char-paragraph freeze is a defect to fix"            | **Out-of-scope**: mechanism verified real (952 ms unbroken gap here; 5.5 s on the reference machine) but the code names it, quantifies it, and defers it as a published-limit product decision. Report, do not fix.                                                                                                                                                   |

## Category scan (checked clean — recorded as checked, not merely absent)

IPC gate invariant 33/33 (brace-parse, all 8 handler modules); full suite 58/1901/7 reproduced by every reviewer; all five prior remediation classes + four refactor seams (main split, IPC split, save-cost, DOCX seams) re-verified clean apart from the residuals above; contrast measured ≥ AA at used sizes; focus-visible rings + roving tabindex + menu semantics; live regions wired; no div/li/span click handlers; touch targets ≥ 24 px; reduced-motion honored; v2 commit path (revision check → one walk → atomic temp+fsync+rename → read-back); orphan-prevention ordering; quarantine bounded (5); `syncWithCrm` revision-first + honest failure; billing idempotent/won-only/canonical-amount; discovery allow-list re-checked per redirect hop + caps; reminders idempotent + never rejects; close-guard fail-closed; ErrorBoundary renders real Workspace 12/12; `IPC_WRAP_LANES` matches nothing in worktree or `git log -S`; `Workspace.tsx` contains no `subscribe` calls; no TODO/FIXME/console.log in `src/`; import graph acyclic one-way; stores memoized singletons; no duplicate constants (renderer imports main's ceilings from shared).

## Not verified (admitted)

The `77c6b68` commit's absolute perf figures (188→85 ms save, 3 599→1 003 ms DOCX stretch) — no fixture is committed; mechanism confirmed, numbers not independently reproducible. The F7 reproduction is a faithful listener-code model, not a real component mount (read-only constraint) — the fix agent must reproduce against the real components before fixing.
