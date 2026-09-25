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
    tenders-main.ts          the composition root (347 lines; was 3,702)
    ipc/                     the IPC surface and its gate
    <responsibility>.ts      one module per responsibility
  preload/index.ts           functions only, never `ipcRenderer`
  renderer/                  the UI — no privileged capability of its own
  shared/                    types, schemas, pure rules — imported by both layers
```

The dependency direction is **one-way and enforced by the import graph, not by convention**:
`renderer → preload → main`, and both layers → `shared`. `main` imports **nothing** from
`renderer/` any more (see "the edge that was removed" below).

## `main/` — the composition root and its modules

`tenders-main.ts` is now **347 lines** and is _only_ the composition root: it constructs the
services, owns the test reset, and re-exports each module's public surface. Measured:

```bash
wc -l apps/tenders/src/main/tenders-main.ts          # 347
grep -rn "from '\.\./renderer" apps/tenders/src/main/ # no matches
```

Every other module in `main/` is a real unit with one responsibility. The code was moved
**verbatim** in the split, so nothing about the behaviour changed; the counts below are the
current line counts, not the pre-split ones.

**The line counts move while the split is still being edited by its author**, and they did move
once during this pass (`composition-services.ts` grew 153 → 158 between two reads). They are
here to show the _shape_ — which module is large enough to need its own unit — not as a figure to
quote. Re-run `wc -l apps/tenders/src/main/*.ts apps/tenders/src/main/ipc/*.ts` for the current
numbers; the important one, `tenders-main.ts` at **347 lines against 3,702 before**, is the point
of the split and is stable.

| Module                      | Lines | Responsibility                                                                 |
| --------------------------- | ----- | ------------------------------------------------------------------------------ |
| `tenders-main.ts`           | 347   | the composition root; constructs services, owns the test reset, re-exports     |
| `ipc/handlers.ts`           | 1258  | **all 33 `ipcMain.handle` registrations**                                      |
| `document-store.ts`         | 984   | the managed-document metadata store (index, trash, confinement)                |
| `discovery-client.ts`       | 964   | the OCOS/discovery HTTP client — allow-list, caps, cache, retries              |
| `tenders-store.ts`          | 751   | the authoritative v2 store: atomic write, backups, recovery, revision          |
| `reminders-scheduler.ts`    | 672   | the deadline-reminder schedule; pure and testable, no Electron import          |
| `ipc/engines.ts`            | 552   | builds the two wired engines and their lifecycle; the document download bridge |
| `diagnostics-log.ts`        | 445   | the rotating log sink itself (no Electron import)                              |
| `document-lifecycle.ts`     | 401   | save / read / open / delete / restore / replace / reconcile                    |
| `proposal-generator.ts`     | 390   | markdown + DOCX proposal generation, and the readiness binding it reads        |
| `legacy-store.ts`           | 309   | the **retired** v1 `tenders-data.json` read / validate / write                 |
| `tenders-paths.ts`          | 222   | every path decision + the atomic-write primitives                              |
| `integrations.ts`           | 185   | the CRM / Books ports and their injected overrides                             |
| `ipc/proposal-payload.ts`   | 184   | the proposal + cross-app payload shape/bounds preflight                        |
| `readiness-snapshot.ts`     | 155   | the submission-readiness gate's snapshot rules                                 |
| `composition-services.ts`   | 158   | runtime config, store directory, the close-flush waiter map                    |
| `close-guard.ts`            | 121   | the shell's dirty-close guard (the flush request/answer loop)                  |
| `diagnostics-sink.ts`       | 110   | the one main-process sink instance + the `recordDiagnostic` helper             |
| `navigation-policy.ts`      | 103   | deny-by-default navigation for the privileged view                             |
| `web-contents-registry.ts`  | 87    | the live Tenders view set and the v1 broadcast channel                         |
| `ipc/trust.ts`              | 86    | **the trusted-sender gate — the security invariant lives here**                |
| `legacy-store-watcher.ts`   | 86    | the retired v1 `fs.watch` (kept for the tests that pin its behaviour)          |
| `seed-workspaces.ts`        | 70    | the v1 demo seed data (no longer a live data _source_)                         |
| `readiness-binding.ts`      | 62    | builds the canonical readiness report from the store                           |
| `store-registry.ts`         | 58    | the store seam the modules above reach through, so none imports the root       |
| `ipc/registration-state.ts` | 20    | the one "is the IPC surface registered" boolean                                |
| `main-utils.ts`             | 10    | two tiny shared helpers                                                        |
| `index.ts`                  | 1     | `export * from './tenders-main'` — the entry point                             |

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

## The IPC surface, counted

The privileged surface is unchanged in behaviour and its arithmetic still holds:

```bash
grep -cE "^\s*ipcMain\.handle" apps/tenders/src/main/ipc/handlers.ts   # 33
grep -c "isTrustedTendersEvent"  apps/tenders/src/main/ipc/handlers.ts   # 35 (33 gates + 2 comments)
```

- **33** `ipcMain.handle` registrations, all in `ipc/handlers.ts`.
- **`TENDERS_CHANNELS` declares 36** channel constants; the three that have no handler are the
  main→renderer pushes (`store-changed-v2`, `close-flush-request`, the legacy `data-changed`).
- **Every one of the 33 begins with `isTrustedTendersEvent`** — checked mechanically, not by
  reading: splitting the file on `ipcMain.handle` and requiring the gate within the first 600
  characters of each handler reports zero exceptions.
- The gate itself lives in `ipc/trust.ts`; `ipc/registration-state.ts` holds the registered
  boolean, so neither `handlers.ts` nor the root has to import the other.

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
  attached to a support request says what wrote it — **is called from `registerTendersIpc`
  (`main/ipc/handlers.ts`), before anything else can record**, and the `isTendersIpcRegistered`
  guard keeps it from being written twice, so a real session's log does open with that line. (b) A
  surface renders `diagnosticsPath()`: `ErrorBoundary` takes an optional `diagnosticsPath` prop and
  `errorBoundaryLogHint(path, code)` names the file and an error code in its fallback — the one
  moment where telling the user where the log is matters most.

The file lives on **this** machine: nothing is uploaded, nothing is networked, and each `record()`
is a completed synchronous append, so closing the app cannot lose an entry already written.

## Test infrastructure

Three additions matter structurally, and each closes a way the suite could have gone quiet.

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
Used by `tests/components/*.test.tsx` (three component specs) plus `tests/diagnostics.test.ts` and
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
