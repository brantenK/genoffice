# Zanostack Fork Runbook

This repository is a commercial fork of
[genspark-ai/genoffice](https://github.com/genspark-ai/genoffice) (Apache-2.0,
copyright Mainfunc, Inc.). This runbook defines how Zanostack tracks upstream
without mixing the upstream mirror with the product.

Read this document before an upstream sync, a branch repair, or any push whose
target is not obvious. For the short mandatory rules AI agents load first, see
[`../CLAUDE.md`](../CLAUDE.md).

## The model at a glance

```text
original project                 Zanostack fork

upstream/main  ──fast-forward──> main
                                      │
                                      │ reviewed upstream integration
                                      ▼
                                  product ──> feature branches / releases
```

- `main` is the exact mirror of the original project.
- `product` is the real Zanostack app: branding, BYOK policy, extra modules,
  fixes, and releases all live there.
- An upstream update is first mirrored into `main`, then integrated into
  `product`. `product` is never replaced by the mirror.

## Remotes and branches

| Remote / branch            | Role                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `upstream`                 | The original project: `https://github.com/genspark-ai/genoffice.git`. Fetch from it to track upstream.                               |
| `origin`                   | Our GitHub fork: `https://github.com/brantenK/genoffice.git`. Normal Zanostack pushes go here.                                       |
| `main`                     | Pure mirror of `upstream/main`. **Never commit fork work to it.** Its ordinary update is fast-forward only.                          |
| `product`                  | Zanostack development and release branch. All fork changes live here.                                                                |
| `integration/*`            | Short-lived isolated branches for a conflict-heavy upstream integration. They must be reviewed and validated before `product` moves. |
| `backup/*`, `checkpoint/*` | Named recovery points. Keep them until the related work is accepted and running.                                                     |

`main` usually tracks `origin/main` locally because that is the fork's published
mirror. The synchronization source of truth remains `upstream/main`. Do not
change tracking configuration merely because those two names differ.

## Non-negotiable safety rules

1. All normal Zanostack work happens on `product` or on a short-lived branch
   created from `product`.
2. `main` is only updated with a fast-forward from `upstream/main`. If that
   fails, stop and investigate. Do not merge fork work into it.
3. Never rebase `product` onto `main`. Merge/integrate upstream changes into
   `product` instead.
4. Normal fork pushes go to `origin`, never to `upstream`. A generic bug may be
   contributed upstream only through a deliberate upstream PR workflow.
5. Do not use `git reset --hard`, `git push --force`, or
   `git push --force-with-lease` as a routine repair. If Git state is unclear,
   preserve it with a backup branch and report the facts.
6. Keep fork changes in as few upstream files as practical. Prefer additive
   layers (`fork/`, a branding module, separate modules) because new files do
   not conflict during a future sync.

The local pre-commit hook blocks normal commits while `main` is checked out. It
is a useful backstop, not permission to skip the rules above.

## Before every commit, merge, or push

Run these read-only checks and interpret them before changing Git state:

```bash
git status --short --branch
git branch -vv
git remote -v
```

Confirm all of the following:

- The current branch is the branch you intended to use.
- The working tree has no unrelated edits or untracked files that could be
  accidentally committed.
- The tracking branch shown by `git branch -vv` is the intended
  `origin/<branch>` target.
- `origin` is the Zanostack repository and `upstream` is the original project.
- The proposed command does not modify `main` unless this runbook explicitly
  calls for a mirror update.

If any point is unclear, do not commit, push, merge, rebase, reset, or change
remotes. Report the command output and ask for direction.

## Normal Zanostack feature workflow

Use this for most product changes.

### Option A: direct product work

Use this only when the owner explicitly wants a small, direct product change.

```bash
git checkout product
git pull --ff-only origin product
# edit, validate, and commit
git push
```

Before `git push`, complete the preflight checklist above and ensure
`product` tracks `origin/product`.

### Option B: a short-lived feature branch

This is the preferred workflow for meaningful work because it gives the change
an isolated review point.

```bash
git checkout product
git pull --ff-only origin product
git checkout -b feature/<short-description>
# edit, validate, and commit
git push -u origin feature/<short-description>
```

For later pushes on that branch, re-run the preflight checklist and use plain:

```bash
git push
```

Open an internal pull request with **`product` as the base branch**. Do not use
an internal PR to move Zanostack work into mirror-only `main`.

## Upstream synchronization

Upstream synchronization is maintenance work, not a normal feature push. First
ensure the worktree is clean; `npm run sync:upstream` intentionally refuses a
dirty worktree.

### Simple, clean fast-forward sync

When there are no substantial fork conflicts expected, use the maintained
helper from a clean checkout:

```bash
git checkout product
git status --short --branch  # must show no unrelated work
npm run sync:upstream
```

The helper fetches upstream, fast-forwards the mirror, pushes the mirror to
`origin/main`, then merges the mirror into the branch that was active when the
command started. Therefore, start it from `product`, not from an experimental
or temporary branch.

After the helper completes:

```bash
npm install                  # if the lockfile changed
npm run typecheck
npm test
git push origin product
```

Then complete every required check in `fork/COMPLIANCE.md`.

### Conflict-heavy or high-risk sync

Use an integration branch when the update is large, changes core code, or would
conflict with Zanostack branding, providers, modules, packaging, or policy.

1. Preserve `product` with a named checkpoint/backup branch.
2. Fast-forward `main` from `upstream/main` and publish it to `origin/main`.
3. Create `integration/<description>` from the mirror or the intended merge
   base in a separate worktree.
4. Merge `product` and the mirror as appropriate, resolve conflicts in reviewable
   batches, and preserve the Zanostack rules in `CLAUDE.md` and
   `fork/COMPLIANCE.md`.
5. Run focused tests while resolving, then full validation before moving
   `product`.
6. Push the integration branch for review. Only after acceptance, merge or
   fast-forward it into `product`, validate `product` again, and push
   `origin/product` normally.

Never use blanket `--ours`/`--theirs`, a rebase of `product` onto `main`, or a
force-push as a shortcut through an integration conflict.

### Manual mirror commands (reference / recovery)

Use these only when the helper is unsuitable and you understand why:

```bash
git checkout main
git fetch upstream
git merge --ff-only upstream/main
git push origin main

git checkout product
git merge main
# resolve conflicts, validate, then:
git push origin product
```

A non-fast-forward mirror update is a stop condition, not an invitation to
force-push.

## Verify a sync

Run `npm run verify:sync`. It is read-only and runs the gates in the order that
matters, so nobody has to remember the sequence:

1. the rebrand sweep **in `--dry` mode** — fails if it would change anything, so
   "the tree is fully rebranded" is a check rather than a step to forget;
2. `prebuild:locales` — must precede typecheck and tests, or newly merged i18n
   keys render verbatim;
3. the gates: brand, fork chrome, theme tokens, English comments, skill version,
   formatting, typecheck, **e2e typecheck**, baseline;
4. only if all of those pass: `build:all`, then e2e.

`--fast` stops after step 3 (`fork/tools/verify-sync.mjs` reads that flag; there is no
`--skip-heavy`). Heavy steps are skipped for **either** reason, and the tool says which: a cheap
gate that failed (`Skipping build:all and e2e: N cheap gate(s) failed.`), or the flag
(`Skipping build:all and e2e (--fast).`) — so a broken tree does not cost a 20-minute e2e run.

**`e2e/` is typechecked separately** (`npm run check:e2e-types`). It sits outside
every app's tsconfig because it drives _built_ apps rather than importing them —
which is exactly why a merge resolution there once dropped half a function,
compiled clean, and only failed ~25 minutes into an e2e run. Add a global a spec
needs to `e2e/env.d.ts`, never a cast.

### Compare against the baseline, always

`fork/BASELINE.md` records the tests that are _already_ failing, and
`npm run check:baseline` fails only on failures the baseline does not list. It
records failing test **IDs**, not counts, because a count can match while the set
of failures changes underneath it.

Refresh it after a fix lands (`--repeat 2` files genuinely flaky tests under "(flaky)" so
they stop reappearing as new failures):

```bash
node fork/tools/baseline.mjs --write --with-e2e --repeat 2
```

Both lanes are stale, and this paragraph used to quote counts that were never re-measured.
What is verifiable without running a suite: **HEAD is `e634250`** with an **uncommitted**
structural wave on top of it (the `main/` composition-root split, `shared/demo-seed.ts`, the
e2e timing contract, and these documents) plus a concurrent `apps/books` workstream, so
`check:baseline` reports both lanes as changed until it is re-recorded. The old claim here
("the Tenders unit suite is green: 1011 passed / 0 failed / 7 skipped") is withdrawn rather
than restated.

**`fork/BASELINE.md`'s Tenders entry has been re-measured.** It said
`1068 passed, 0 failed, 7 skipped`; it now records **1854 passed / 0 failed / 7 skipped over
58 test files**, taken from two clean identical runs (`npx vitest run` from `apps/tenders`,
104 s and 103 s) at `e634250` plus the uncommitted structural wave. The two earlier figures in
this section are superseded and kept only as a caution: `1604 passed / 8 failed / 7 skipped`
over 58 files was measured while the tree was being edited by two other agents (a `main/` split
and a `shared/demo-seed.ts` extraction landing mid-run, and an in-flight
`tests/components/__probe.test.tsx` that rewrites a fixture module on disk), and three of those
failures — `adversarial-stress.test.ts`, `ai-e2e-contract.test.ts` and
`renderer-display-locale.test.ts` — **passed when run alone (61 passed / 61)**. They were
concurrent-edit noise, and on a quiet tree there were none. `fork/BASELINE.md` now says which
sections were re-measured and which were not; the tool command in its guidance is unchanged and
remains the way to re-record the file whole.

Before the _next_ sync, re-record it at the pre-merge commit. That comparison is
the single highest-value thing this runbook asks for: in the 2026-09-22 sync it
proved that 16 of the 19 "merge-broken" e2e specs were already broken by the
fork's own Home redesign, which is the difference between fixing the merge and
fixing the wrong thing.

### Run heavy suites one at a time

This checkout lives on a OneDrive-synced disk. Two heavy suites at once produce
failures that pass in isolation — measured here as `sheets` failing a _different_
three tests each run, and Playwright `locator.click` never becoming "visible,
enabled and stable". If a failure passes alone, treat the isolated run as the
verdict and re-run the full suite serially; do not "fix" it.

### The Playwright e2e suite is load-sensitive, and a lone pass is the verdict

**Measured wall times for the whole `e2e/` Playwright suite on this machine:**

| Conditions                                                              | Wall time                     |
| ----------------------------------------------------------------------- | ----------------------------- |
| Idle machine, healthy                                                   | **~11 min**                   |
| Shared with another workstream (4–9× oversubscribed), two observed runs | **49.6 min** and **49.8 min** |

**What happens under load is not a stable extra failure — it is a _shifting_ one.**
In those two long runs the failing test moved every time: first the vault flow,
then the requirement-status flow, then the close-guard journey — and **every one of
them passed when run alone** (for the Tenders regression smoke, `1 passed (2.2m)`
in isolation). The Tenders lane polls the on-disk store between a UI action and its
assertion, and those poll windows were the part that shrank: they were hand-picked
per spec, and the smaller ones were too tight at 4–9× load. A single Electron
window that takes 2 s to render on an idle machine can take 15 s on a loaded one
without anything in the app being wrong.

**Two operational consequences, and the rule they imply:**

1. **A failure that passes when run alone is a load artefact, not a regression.**
   Treat the isolated run as the verdict. Do not "fix" the app to make the loaded
   run pass, and do not weaken the assertion either — re-run the suite serially on
   an unloaded machine and judge from that.
2. **A loaded run's wall time is not a performance signal about the app.** 49.6
   minutes against a healthy ~11 is the machine, not the product. Do not quote a
   loaded figure as the suite's cost, and do not treat a longer run as evidence
   anything regressed.

The Tenders lane's poll windows are no longer hand-picked: they are declared once
in `e2e/tenders-timing.ts`, derived from a measurement of the app's own commit
latency against the built shell (a healthy commit is observed by a poll in **under
~600 ms**; the slowest thing any journey covers is **under 1 s**; the default
`STORE_COMMIT_POLL_MS` is **20× that slowest figure**). The measurement, the
figures the new ones replaced, and what was deliberately left alone are in
`docs/tenders-hardening/contracts-and-invariants.md` §7. The one deliberate
exception is the close-guard journey's 300 ms debounce gate, which is a
_measurement_ rather than a wait: its figure is not widened, because widening it
would let the races it exists to catch pass too.

The relevant `package.json` scripts and what each costs:

```bash
npm run test:e2e      # the WHOLE Playwright suite — ~11 min healthy, up to ~50 under load
npm run check:e2e-types   # cheap; tsc over e2e/tsconfig.json only
```

`npm run verify:sync` runs `check:e2e-types` among its cheap gates and only reaches
e2e after `build:all`; `--fast` stops before both. Prefer `--fast` while iterating,
and reserve a full `test:e2e` for a machine you are not sharing.

## Porting an upstream spec to the fork's UI

Upstream's e2e specs are written against upstream's Home and are refreshed with
every sync, so this is recurring maintenance, not a one-off. The fork's Home
replaced upstream's `.quick-card` row with a grouped sidebar launcher, so a spec
that looks up a card by its label (`{ hasText: 'AI Docs' }`, `.quick-card`
`.nth(1)`) will never find it.

Do this instead — it is a one-line change per call site:

```ts
import { openAppFromHome } from './helpers'

// upstream:  await page.locator('.quick-card', { hasText: 'AI Sheets' }).click()
// fork:      await openAppFromHome(page, 'xlsx')
```

`ext` is `docx` / `xlsx` / `pptx` / `pdf` / `md` / `html` for the Office apps and
`crm` / `tenders` / `books` for the business apps. The items carry `data-ext`
precisely so specs never match a translated label — several specs run in French.

Other stable hooks: the remaining `.quick-card` is the genuine "Open Local File"
browse button, and the canvas create action carries `data-action="new-doc"`. When
the fork diverges from an upstream selector, **add a `data-*` hook to the fork's
markup rather than teaching the spec a fork-specific label** — the hook is
invisible, additive, and keeps the next sync's port mechanical.

Do not weaken an assertion to make a ported spec pass, and do not revert a
deliberate fork divergence to satisfy a stale upstream spec. If the divergence is
real, the spec is what changes.

## Rare exception: owner-authorized mirror repair

The only acceptable reason to force-update `origin/main` is an explicit owner
instruction to restore `main` as an exact upstream mirror after it was
accidentally polluted. This is a remote-facing, exceptional operation.

Before doing it:

1. Confirm the exact current remote main SHA, exact `upstream/main` SHA, and
   current `product` SHA.
2. Create and verify a named remote backup of the current remote main, such as
   `backup/main-pre-upstream-mirror-YYYY-MM-DD`.
3. Confirm the owner has explicitly authorized replacing **that exact remote
   `main`** with **that exact upstream SHA**.
4. Use `--force-with-lease` pinned to the observed old main SHA, never plain
   `--force`.
5. Fetch and verify afterward that `main`, `origin/main`, and `upstream/main`
   have the same SHA, and that `product` did not move.

If any condition is missing, stop. Do not infer authorization from a general
request to “sync” or “clean up branches.”

## What to fix where

- **Generic bugs** (format fidelity, crashes, cross-platform issues): develop
  an isolated fix from `main` and deliberately send it to the upstream
  repository as a PR. Once merged upstream, it arrives through a later mirror
  update and the fork stops maintaining it separately.
- **Fork-only changes** (branding, packaging defaults, AI-provider defaults,
  updater feed, licensing files): make them on `product`, ideally in thin
  layers listed in `fork/COMPLIANCE.md`.
- **Commercial differentiators**: keep them in separate, additive modules —
  not woven into upstream engine code.

## Prune temporary branches after acceptance

A sync is not finished when `product` is pushed. Every sync creates temporary
branches, and leaving them behind makes the branch list unreadable and hides
which branches actually matter.

**Steady state is two branches plus at most one safety net:**

| Branch                 | Role                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| `main`                 | upstream mirror                                                             |
| `product`              | Zanostack development and release                                           |
| at most one `backup/*` | short-lived undo point, deleted once the app has been used without problems |

After an accepted sync, delete the temporary branches — locally **and** on
`origin`:

```bash
# first prove nothing unique would be lost
git rev-list --count product..<temp-branch>   # must be 0
git merge-base --is-ancestor <temp-branch> product && echo "safe to delete"

# remove the worktree that pins an integration branch, then the branch
git worktree remove --force ../genoffice-sync-<date>
git worktree prune
git branch -d integration/<name> checkpoint/<name> backup/<old-name>
git push origin --delete integration/<name> checkpoint/<name> backup/<old-name>
```

Delete a branch only when `git rev-list --count product..<branch>` is `0` (it
is fully contained in `product`) or you have confirmed its commits are wanted.
Do not keep integration or checkpoint branches "just in case" once the merged
result has been validated — `product` already contains every commit, so any
branch can be recreated from its SHA if it is ever needed again.

## Recovery rule

When Git says non-fast-forward, reports unexpected divergence, or produces a
conflict you do not understand:

1. Stop before destructive commands.
2. Record `git status --short --branch`, `git branch -vv`, `git remote -v`, and
   the relevant `git log --oneline` output.
3. Create a named backup branch only if doing so is safe and authorized.
4. Report the facts and choose a reviewed path.

A preserved branch is cheap. An unreviewed reset, rebase, or force-push can
lose history or publish the wrong code.

## Upstream tracking notes

- Upstream has no CLA and states the Apache-2.0 core cannot be relicensed —
  our fork's legal basis is stable.
- Upstream ships near-daily releases; expect a meaningful snapshot every few
  days and PR numbers climbing steadily.
- Their release/packaging automation is not in the repository; our own
  packaging is `npm run dist:win` (see fork notes on the xlsx sidecar path in
  `CONTRIBUTING.md`).
