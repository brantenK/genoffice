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
