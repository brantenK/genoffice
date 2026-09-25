# Tenders — the module map (wave 3)

This file is the **structural** companion to `contracts-and-invariants.md`. That document answers
"what must not regress"; this one answers "where does each responsibility live, and why is the
boundary there". It describes **what is on disk** at the time of writing, with the arithmetic
shown so it can be re-checked.

Everything below was read from the tree, not remembered. The commands that produce each figure are
next to it.

## The shape, in one picture

```text
apps/tenders/src/
  main/            the Electron main process — every privileged decision
    tenders-main.ts          the composition root (341 lines; was 3,702)
    ipc/                     the IPC surface, its gate, and one module per domain
    <responsibility>.ts      one module per responsibility
  preload/index.ts           functions only, never `ipcRenderer`
  renderer/                  the UI — no privileged capability of its own
  shared/                    types, schemas, pure rules — imported by both layers
```

The dependency direction is **intended to run one way** — `renderer → preload → main`, and both
layers → `shared` — and the edge that violated it has been removed (see "the edge that was
removed" below). But be careful with the stronger version of that claim, because it is **not
true on disk**: the direction is **not** mechanically enforced. Nothing in the toolchain — no
lint rule, no `tsconfig` project boundary, no guard script — fails on a new `main → renderer`
import. What holds today is that a renderer-only import in `main` would pull browser globals
(`window.open`, `URL.createObjectURL`, `fetch`) into the main bundle, and that is a reason a
reviewer should reject it, not a reason the build will. The direction is a **convention kept by
review**, and this line used to claim an enforcement that does not exist.

It is also not literally one-way even now. A **type-only** edge runs `renderer → main`:
`renderer/src/diagnostics.ts` does
`import type { DiagnosticsEntry, DiagnosticsLevel } from '../../main/diagnostics-log'`. It is
erased at build time, so it carries no runtime code and no browser global into `main` — which is
why it is tolerable where the deleted `main → renderer` edge was not — but it is still an edge,
and a document that says `renderer` never imports `main` is wrong.

## `main/` — the composition root and its modules

`tenders-main.ts` is now **341 lines** (measured: `wc -l`, below) and is _only_ the composition
root: it constructs the services, owns the test reset, and re-exports each module's public
surface. Measured:

```bash
wc -l apps/tenders/src/main/tenders-main.ts           # 341
grep -rn "from '\.\./renderer" apps/tenders/src/main/ # no matches
```

Every other module in `main/` is a real unit with one responsibility. The code was moved
**verbatim** in the split, so nothing about the behaviour changed; the counts below are the
current line counts, not the pre-split ones.

**Every figure below still moves while agents edit these files.** They are here to show the
_shape_ — which module is large enough to need its own unit — not as a figure to quote. Re-run
`wc -l apps/tenders/src/main/*.ts apps/tenders/src/main/ipc/*.ts` for the current numbers. The
table was re-read from disk on 2026-09-25, **mid-split**, and four rows in it are already known to
be moving: `ipc/handlers.ts` went from 1 287 lines to **79** while this was written, `tenders-store.ts`
grew 11 lines on the same day, and the seven new `ipc/handlers-*.ts` modules below landed between
two reads. The previous version of the table was **stale in eleven rows and wrong about
`tenders-main.ts` itself** (it said 347 against the real 341), which is what a line-count table
does in a tree two agents are editing.

| Module                        | Lines | Responsibility                                                                 |
| ----------------------------- | ----- | ------------------------------------------------------------------------------ |
| `tenders-main.ts`             | 341   | the composition root; constructs services, owns the test reset, re-exports     |
| `ipc/handlers.ts`             | 79    | **the registration root** — calls the seven domain modules, holds no bodies    |
| `document-store.ts`           | 1222  | the managed-document metadata store (index, trash, confinement)                |
| `discovery-client.ts`         | 964   | the OCOS/discovery HTTP client — allow-list, caps, cache, retries              |
| `tenders-store.ts`            | 784   | the authoritative v2 store: atomic write, backups, recovery, revision          |
| `reminders-scheduler.ts`      | 672   | the deadline-reminder schedule; pure and testable, no Electron import          |
| `ipc/engines.ts`              | 553   | builds the two wired engines and their lifecycle; the document download bridge |
| `ipc/handlers-cross-app.ts`   | 506   | CRM sync/outcome/open, Books tab + billing, Sheets export (5 handles)          |
| `diagnostics-log.ts`          | 481   | the rotating log sink itself (no Electron import)                              |
| `legacy-store.ts`             | 462   | the **retired** v1 `tenders-data.json` read / validate / write                 |
| `document-lifecycle.ts`       | 436   | save / read / open / delete / restore / replace / reconcile                    |
| `proposal-generator.ts`       | 390   | markdown + DOCX proposal generation, and the readiness binding it reads        |
| `ipc/handlers-store.ts`       | 304   | authoritative v2 load/save, close-flush reply, legacy pair, Sheets export (6)  |
| `tenders-paths.ts`            | 282   | every path decision + the atomic-write primitives                              |
| `ipc/proposal-payload.ts`     | 185   | the proposal + cross-app payload shape/bounds preflight                        |
| `integrations.ts`             | 185   | the CRM / Books ports and their injected overrides                             |
| `composition-services.ts`     | 158   | runtime config, store directory, the close-flush waiter map                    |
| `readiness-snapshot.ts`       | 155   | the submission-readiness gate's snapshot rules                                 |
| `ipc/handlers-documents.ts`   | 130   | documents, trash, recovery candidates (11 handles)                             |
| `close-guard.ts`              | 122   | the shell's dirty-close guard (the flush request/answer loop)                  |
| `ipc/handlers-discovery.ts`   | 118   | the feed list/cache/refresh/release/download (5 handles)                       |
| `diagnostics-sink.ts`         | 110   | the one main-process sink instance + the `recordDiagnostic` helper             |
| `navigation-policy.ts`        | 101   | deny-by-default navigation for the privileged view                             |
| `legacy-store-watcher.ts`     | 91    | the retired v1 `fs.watch` (kept for the tests that pin its behaviour)          |
| `ipc/handlers-reminders.ts`   | 90    | reminder settings and a manual check (3 handles)                               |
| `ipc/handlers-diagnostics.ts` | 89    | the renderer's failure report and the log path (2 handles)                     |
| `web-contents-registry.ts`    | 87    | the live Tenders view set and the v1 broadcast channel                         |
| `ipc/trust.ts`                | 86    | **the trusted-sender gate — the security invariant lives here**                |
| `ipc/handlers-proposals.ts`   | 69    | the one proposal channel (1 handle)                                            |
| `seed-workspaces.ts`          | 69    | the v1 demo seed data (no longer a live data _source_)                         |
| `readiness-binding.ts`        | 62    | builds the canonical readiness report from the store                           |
| `store-registry.ts`           | 58    | the store seam the modules above reach through, so none imports the root       |
| `ipc/handlers-startup.ts`     | 43    | the work that must precede every channel (registers no channel)                |
| `ipc/handler-context.ts`      | 42    | the shared shape of one IPC registration module                                |
| `ipc/registration-state.ts`   | 20    | the one "is the IPC surface registered" boolean                                |
| `main-utils.ts`               | 10    | two tiny shared helpers                                                        |
| `index.ts`                    | 1     | `export * from './tenders-main'` — the entry point                             |

Shared by both layers (`shared/`, no Electron and no Node import except `demo-seed.ts`, which is a
frozen literal):

| Module                          | Responsibility                                                               |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `shared/demo-seed.ts`           | the frozen demo dataset `main` needed — **the module that removed the edge** |
| `shared/ipc.ts`                 | the channel names, the DTOs, the IPC bound constants                         |
| `shared/tenders-schema.ts`      | pure v1→v2 validation and migration                                          |
| `shared/tenders-persistence.ts` | persistence DTOs + the limits table                                          |
| `shared/readiness.ts`           | the readiness assessment (pure)                                              |
| `shared/rules.ts`               | the local rule catalogue                                                     |
| `shared/ai-extraction.ts`       | the AI extraction core (pure)                                                |
| `shared/discovery.ts`           | the feed's URL allow-list and coverage copy                                  |
| `shared/lifecycle.ts`           | the tender lifecycle state machine                                           |
| `shared/money.ts`               | the single rand parser/formatter                                             |
| `shared/reminders.ts`           | the reminder schedule (pure)                                                 |
| `shared/types.ts`               | the domain types                                                             |

## The edge that was removed: `main` no longer imports `renderer`

Before this split, `main/tenders-main.ts` imported three constants from `renderer/`:

```ts
import { MOCK_COMPANY } from '../renderer/src/mock/company'
import { MOCK_CUSTOMERS } from '../renderer/src/mock/customers'
import { MOCK_VAULT } from '../renderer/src/mock/vault'
```

That is a dependency-direction violation with a real cost: `renderer/` contains browser-only code
(`window.open`, `URL.createObjectURL`, `fetch`), and importing it from `main` pulls that code into
the **main bundle's import graph** for the sake of three literal constants.

The fix moves the **data** to `shared/demo-seed.ts` — a frozen literal with no Electron import, no
`node:*` import and no browser global — and leaves the renderer's three mock modules as re-export
shims (`export { MOCK_COMPANY } from '../../../shared/demo-seed'`), so every existing renderer
import path keeps working unchanged. `main` now imports `shared/` only.

Verified on disk: `grep -rn "from '\.\./renderer" apps/tenders/src/main/` returns nothing.

What this does **not** change: the values themselves are frozen, including the absolute
`/demo/vault/…` form of `VaultDoc.fileUrl`, which is part of the historical demo domain the schema
recognises. The demo classification rule is untouched.

## The IPC surface, counted — and it is now split across nine files

The privileged surface is unchanged in behaviour; its **arithmetic** is unchanged too, but the
**file that holds it is not what it was**. `ipc/handlers.ts` was 1 287 lines holding all 33 handler
bodies; it is now **79 lines** and holds none of them. It is the registration root: it runs the
startup work, then calls one `register*Channels(ipc)` per domain. The bodies moved **verbatim**
into seven domain modules plus a shared context module.

```bash
# the registration root (no bodies, one call per domain)
wc -l apps/tenders/src/main/ipc/handlers.ts                        # 79
# the 33 registrations, counted across all the domain modules
grep -hE "^\s*ipc\.handle\(" apps/tenders/src/main/ipc/handlers*.ts | wc -l   # 33
# the channels the shared contract declares
awk '/export const TENDERS_CHANNELS/,/^} as const/' apps/tenders/src/shared/ipc.ts \
  | grep -cE "^\s+[a-zA-Z]+:"                                      # 33
```

| Module                        | Handles | Channels                                                                                                                                                                                                                        |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ipc/handlers-store.ts`       | 6       | `loadStoreV2`, `saveStoreV2`, `closeFlushResult`, `getStoredData`, `saveStoredData`, `exportMatrixToSheets`                                                                                                                     |
| `ipc/handlers-documents.ts`   | 11      | `readDocument`, `saveDocument`, `openDocument`, `deleteDocument`, `replaceDocument`, `restoreDocument`, `listDocumentTrash`, `cleanupDocumentTrash`, `reconcileDocuments`, `listRecoveryCandidates`, `restoreRecoveryCandidate` |
| `ipc/handlers-discovery.ts`   | 5       | `discoveryList`, `discoveryReadCache`, `discoveryRefresh`, `discoveryRelease`, `discoveryDownloadDocument`                                                                                                                      |
| `ipc/handlers-reminders.ts`   | 3       | `remindersGet`, `remindersSet`, `remindersCheck`                                                                                                                                                                                |
| `ipc/handlers-diagnostics.ts` | 2       | `diagnosticsRecord`, `diagnosticsPath`                                                                                                                                                                                          |
| `ipc/handlers-cross-app.ts`   | 5       | `syncWithCrm`, `updateTenderOutcome`, `openInCrm`, `openBooks`, `billMilestoneInBooks`                                                                                                                                          |
| `ipc/handlers-proposals.ts`   | 1       | `draftProposalDoc`                                                                                                                                                                                                              |
| **total**                     | **33**  | **33**                                                                                                                                                                                                                          |

`ipc/handlers-startup.ts` registers **no** channel: it is the work that must precede every one of
them (the diagnostics `recordDiagnosticsStart` line, the store directory, the reminder schedule),
and `ipc/handler-context.ts` is the `TendersIpcContext` / `TendersIpcRegistry` shape the seven
modules share. `handlers.ts` refuses to register anything before the startup work has run — a
channel module called out of order throws rather than reading a store that does not exist yet.

- **33** `ipc.handle` registrations, across the seven domain modules; **33** `TENDERS_CHANNELS`
  constants, and they are the same 33 — so nothing is declared-but-unhandled and nothing is
  handled-but-undeclared. This bullet used to say **36**, with "the three that have no handler are
  `store-changed-v2`, `close-flush-request` and `data-changed`". The **count was wrong** (the
  object declares 33, not 36 — that 36 appears to have been the whole file's `tenders:` string
  count, which also picks up constants declared outside the object), and the **explanation was
  wrong too**: all three of those names _are_ members of the object. Two of them —
  `closeFlushRequest` and `dataChanged` — are pushed by main on `webContents.send` rather than
  handled; the third, `storeChangedV2`, is pushed through the broadcast seam in
  `web-contents-registry.ts` rather than from any handler module at all. Re-derive the count with
  the `awk` above, which strips the comments.
- **Every one of the 33 still begins with `isTrustedTendersEvent`** — checked mechanically, not by
  reading, and re-checked after the split: splitting every `handlers*.ts` on `ipc.handle(`, taking
  the first statement of each handler body and requiring the gate there reports **33 of 33, zero
  exceptions**. The registrations moved; the first-statement property did not.
- The gate itself lives in `ipc/trust.ts`; `ipc/registration-state.ts` holds the registered
  boolean, so neither `handlers.ts` nor the root has to import the other.

**What the split changed about how to check it.** A guard written against one file no longer sees
the whole surface: `grep -cE "^\s*ipcMain\.handle" apps/tenders/src/main/ipc/handlers.ts` now
returns **0**, which reads exactly like "the handlers vanished" and is why the count above is
taken across `handlers*.ts`. The harness is now injectable — `registerTendersIpc(ipc)` takes a
`TendersIpcRegistry` that defaults to `ipcMain` — so a test can register the surface against its
own stub and assert what each channel was asked to do without an Electron process.

`contracts-and-invariants.md` §3 carries the full per-channel breakdown and the rejection shapes.

## The diagnostics log

The one place a packaged user's problem can be seen afterwards.

- **Path:** `<userData>/tenders/tenders-diagnostics.log`, beside `tenders-data.json` —
  `diagnosticsLogDir(userDataDir)` = `<userData>/tenders`, `DIAGNOSTICS_FILE_NAME` =
  `tenders-diagnostics.log`.
- **Bounds:** the live file never passes `DEFAULT_DIAGNOSTICS_MAX_BYTES` = **1 MiB**, and
  `DEFAULT_DIAGNOSTICS_MAX_FILES` = **3** generations (`name`, `name.1`, `name.2`) are kept, so the
  directory can never hold more than **3 MiB** however long the app runs. Rotation is
  `name → name.1 → name.2`, dropping the oldest, and it is disabled for the rest of the session
  after a failed rotation rather than retrying a doomed rename on every entry.
- **What it deliberately does not record:** document content, and that is a property of the sink
  rather than a habit of its callers. `detail` values must be **primitives** (an object or array is
  dropped, never walked), every string is cut to `DIAGNOSTICS_MAX_DETAIL_CHARS` = 500, at most
  `MAX_DETAIL_KEYS` = 24 keys are written, and a list of keys that only ever carry document text
  (`clause`, `verbatimClause`, `title`, `text`, `requirements`, `workspaces`, `vault`, `buffer`,
  `html`, …) is refused outright. A message is cut to `DIAGNOSTICS_MAX_MESSAGE_CHARS` = 2 000, and
  newlines are collapsed so **one entry is one line** and `tail -f` reads whole entries.
- **Never throws.** Every filesystem call is wrapped; a logging failure is swallowed rather than
  propagated, so a logger cannot become a reason the app fails.
- **The UI surface is write-only.** Two channels, both behind the trusted-sender gate:
  `tenders:diagnostics-record` (renderer → main, one entry) and `tenders:diagnostics-path` (the
  live path, so the user can be told where to look). There is **no reader channel** — a renderer
  can add to the record and can never browse it. Both preload members are typed **optional** on
  `TendersApi`, because a stale preload legitimately lacks them.
- **The coverage gap is CLOSED on both halves, and this note used to record them as open.** (a)
  `recordDiagnosticsStart(log, version)` — the one line a fresh session should open with, so a file
  attached to a support request says what wrote it — **is reached from `registerTendersIpc`,
  before any channel can record**. Since the IPC split the call itself lives one level deeper:
  `handlers-startup.ts` calls it, and `handlers.ts` runs the startup work first and throws if a
  channel module is reached before it. The `isTendersIpcRegistered` guard keeps it from being
  written twice, so a real session's log does open with that line. (b) A
  surface renders `diagnosticsPath()`: `ErrorBoundary` takes an optional `diagnosticsPath` prop and
  `errorBoundaryLogHint(path, code)` names the file and an error code in its fallback — the one
  moment where telling the user where the log is matters most.
- **What the e2e lane does with it, and what that used to get wrong.** The log is the only record
  of what a failing app did, and it lives **inside** the scratch profile each spec deletes at
  teardown — so the lane now salvages it first. `e2e/tenders-timing.ts` owns the two helpers
  (`salvageTendersDiagnosticsLog`, `teardownScratchProfile`), and **every** Tenders spec tears its
  profile down through them; the salvage copy lands in `e2e/artifacts/diagnostics/` and its path is
  named in the spec's result JSON. The first version of this got it wrong in the exact way that
  matters: it salvaged in the spec's `finally` but wrote `diagnosticsLogArtifact` **before** that
  block ran, so a FAILING run — the only run whose log is worth having — recorded `null` while the
  artefact list recorded a real path, one document contradicting itself, with the profile already
  deleted. That is fixed at both salvage points (the throw site and the `finally`), and
  `e2e/tenders-diagnostics-artifact-guard.spec.ts` now asserts the contract mechanically, including
  that no Tenders spec deletes a scratch profile outside the helper.

The file lives on **this** machine: nothing is uploaded, nothing is networked, and each `record()`
is a completed synchronous append, so closing the app cannot lose an entry already written.

## The Windows rename retry: **parity is now complete, and it is shared code**

This section used to say the opposite — that each store had a defence the other lacked. That was
true of `e634250` and is **not true on disk now**, so it is corrected here rather than carried.

- **Both forms of the retry live in one file.** `main/tenders-paths.ts` exports **two** helpers that
  share everything that decides behaviour: `renameWithBoundedRetry(from, to)` (the synchronous one)
  and `renameWithBoundedRetryAsync(from, to)` (the asynchronous one). Both read
  `RENAME_RETRY_ATTEMPTS` = **3** and `RENAME_RETRY_DELAY_MS` = **15**, both retry only `EBUSY` /
  `EPERM` through the same `isTransientRenameError`, and both sleep rather than spin — `Atomics.wait`
  for the sync form, a `setTimeout` for the async one.
- **They differ in exactly one respect, and it is deliberate:** the synchronous form blocks the
  main process's thread (it belongs to a writer that must answer before its call returns); the
  asynchronous form awaits and does not. That is why there are two, not one.
- **The managed-document store takes the async form.** `main/document-store.ts`'s `atomicWrite()`
  writes a temp file with `flag: 'wx'` and mode `0o600`, best-effort `fsync`s it through an
  `r+` handle, then calls `renameWithBoundedRetryAsync(temporary, path)` — and unlinks the temp
  file if any of that throws.
- **The primary path and the retired v1 writer take the sync form.** `writeBufferAtomic` (in
  `tenders-paths.ts` itself) and `legacy-store.ts` both call `renameWithBoundedRetry`.

**So the comment in `legacy-store.ts` is accurate as it stands.** It reads: "_The bounded
EBUSY/EPERM retry, through the same shared constants the managed-document store's asynchronous
form uses. This writer runs to completion inside one call, so it takes the SYNCHRONOUS form; the
two share `isTransientRenameError`, the attempt count and the delay..._" — checked against disk,
every clause of that holds: `legacy-store.ts:453` calls `renameWithBoundedRetry`, and the two
helpers are three hundred lines apart in `tenders-paths.ts` with the shared constants named in
the paragraph above both of them. The earlier version of **this file** (not the source comment)
claimed the retry was asymmetric and that the managed store had none; that was a true observation
of the tree it was written in and is stale now. Whether the two should be collapsed into one is
still a code decision and is **not** made here; this records what the code does today.

## Test infrastructure

Three additions matter structurally, and each closes a way the suite could have gone quiet.

**A source guard that reads a file must not depend on the line endings it is handed.** This is not
hypothetical: `tests/components/error-boundary.test.tsx` holds the guard for the crash class that
produced the error boundary in the first place, and it was reading the real `Workspace.tsx` with
two literal LF anchors, `source.indexOf('  useEffect(() => {\n    if (!menuOpen) return')` and
`source.indexOf('  }, [menuOpen, activeMenuIndex])')`. Measured on this file: the first anchor
returns **-1** against a CRLF copy, the slice comes back empty, the `menuRef.current` assertion
fires, and the message blames the component. The second anchor returns -1 there too, so the run
it did take ran from the file's first line through the overflow-menu handler to roughly line 1 050
— it was never the roving-tabindex hook, on either checkout. The guard now matches its start as a
line-anchored pattern with an optional CR and ends on the next top-level section comment.
**Why it cannot be reproduced here, and why that is the whole lesson:** `.gitattributes` says
`* text=auto eol=lf`, so every clone checks this file out as LF and the broken form passes. It
breaks only on a **documented exception** — this working copy carries `CRLF` on all 1 775 lines of
`Workspace.tsx`, against `eol=lf`, in a tree whose `.gitattributes` exists specifically to stop
that. So the correction is two-part: the guard above takes either ending, and a reviewer who sees
this repo checked out with CRLF should treat **the checkout** as the finding. An agent-driven
review reading a CRLF tree will otherwise report real-looking source defects that exist nowhere
else — see the operational rule in `fork/RUNBOOK.md`.

**`apps/tenders/tests/helpers/render.tsx` — a renderer-component harness with no test-library
dependency.** Several honesty claims in this app live in JSX: a chip that must be **visible text**,
an alert that must be **announced**, a sentence that must be **rendered verbatim**. Before this
harness those claims could only be asserted against comment-stripped source — a broken substitute,
because a refactor that preserves behaviour can fail a source guard and a behaviour change that
keeps the old wording can pass one. `mount()` renders the real component in jsdom through
`react-dom/client` + `act` (both already dependencies) and lets a test ask what the user would
actually see. It implements a documented subset — `getByText` / `queryByText`, `getByRole` with an
accessible-name filter, `getByTestId`, `click` (a real bubbling click inside `act`), `text()` for
the whole collapsed rendered text — and its `accessibleName` is an **approximation of accname**
(`aria-labelledby` → `aria-label` → rendered text → `title`), deliberately _content-aware_ so a
marker that lives only in a `title` still has a name. Specifics are in the file's own header.
Used by `tests/components/*.test.tsx` (four component specs) plus `tests/diagnostics.test.ts` and
`tests/renderer-display-locale.test.ts`.

**The CI job that gates `product` and runs the Tenders e2e.** `.github/workflows/ci.yml` declares a
`tenders-e2e` job beside the main `test` job. It runs on `ubuntu-22.04` under `xvfb`, builds the
apps those specs drive (`tenders`, `sheets`, `markdown`, `crm`, `shell`) rather than `build:all` so
it stays affordable, and runs exactly `npx playwright test --config e2e/playwright.config.ts
tenders-`. It exists because **nothing else exercised those specs**: the `test` job's unit suite
stops at the renderer's module boundary, and the `e2e` job runs them only as part of the whole
Playwright suite. It is deliberately **not path-filtered** — a skipped run would leave the fork's
branch ungated again — and both the workflow's `push` and `pull_request` triggers include
`product`. Budget ~15 minutes warm, ~20 on a cold cache; `timeout-minutes: 30`.

**Tests are typechecked, and `e2e/` is typechecked separately.** `npm run typecheck` covers all 28
workspaces including `@genoffice/tenders`, which is what makes a `tests/*.test.ts` type error a
build failure rather than a surprise. `e2e/` sits **outside every app's tsconfig**, because it
drives _built_ apps rather than importing them — which is exactly why a merge resolution there once
dropped half a function, compiled clean, and only failed ~25 minutes into an e2e run.
`e2e/tsconfig.json` + `e2e/env.d.ts` close that lane: `npm run check:e2e-types` (`tsc --noEmit -p
e2e/tsconfig.json`) is part of `npm run verify:sync`, and enabling it immediately found two real
bugs (a shadowed DOM `document` in `ai-panel-side.spec.ts`, and three `closeAndSaveVideo` calls
writing `undefined.webm`). **Add a global a spec needs to `e2e/env.d.ts`, never a cast.**

## The invariant: no render throw may be a blank screen

**The invariant is: a render throw must never be a blank screen.** Stated as an invariant rather
than a feature because the failure it prevents is indistinguishable from "the app did not start":
the window opens, the renderer paints nothing, and the user has no way to tell a crash from a slow
load — the same shape of dishonesty as a save pill that says "Saved" over a persistence path that
does not exist (§2a).

**Status on disk: LANDED.** `renderer/src/components/ErrorBoundary.tsx` is a React class boundary,
mounted **twice**:

- in `renderer/src/main.tsx`, wrapping `<App />` inside `#root` — the last line of defence, covering
  the sidebar, the modals, the tour and anything thrown while rendering the shell itself;
- in `components/App.tsx`, wrapping the page area — so a crash in one view keeps the sidebar and its
  navigation, and the user can carry on elsewhere and come back.

Two design choices are worth recording because they are what make it honest rather than merely
present:

- **Recovery is a remount, not a re-render.** "Try this view again" keeps the failed element and
  renders it under a new `key`. Re-rendering the same element would simply throw again, and a
  "retry" that cannot work is a worse lie than no button at all.
- **The fallback claims only what is true.** The window is still running and the navigation still
  works; the failure was recorded to the diagnostics log as an **error code plus a component stack
  and nothing else** — deliberately _not_ the error message, which can embed the tender text that
  choked it, so §3e's never-record-content rule holds even here; and **nothing was confirmed on the
  user's behalf**, which is what keeps the app's core invariant intact through a crash. It does not
  claim data was lost, and does not claim it is intact — only that this render failed and that the
  save path the user can see in the save-status chip is the one that writes their file.

**What it cannot do, stated because React's own limit is easy to over-claim:** a boundary catches a
throw in a _child's_ render, a wrapped lifecycle method, or a `useEffect` body. It does **not** catch
an event handler, an async callback, or a throw in its own render — which is why the fallback never
calls anything that can throw, and why every cross-app call still reports its own failure visibly
rather than relying on a boundary to catch it.

It is pinned by a component test through `tests/helpers/render.tsx` — precisely the harness that can
assert "the screen says something", which a source guard cannot.

## What this file is not

It is not the contract. `contracts-and-invariants.md` is, and it wins on every point of behaviour:
the schema, the limits table, the readiness rules, the AI boundary, and the follow-up list. This
file only says **where the code lives** and why the boundary is where it is.
