# Fork Runbook

This repository is a commercial fork of
[genspark-ai/genoffice](https://github.com/genspark-ai/genoffice) (Apache-2.0,
copyright Mainfunc, Inc.). This runbook defines how the fork tracks upstream
without fragmenting.

## Remotes and branches

| Remote / branch | Role |
| --- | --- |
| `upstream` | The original project: `https://github.com/genspark-ai/genoffice.git` |
| `origin` | Our GitHub fork: `https://github.com/brantenK/genoffice.git` |
| `main` | Pure mirror of `upstream/main`. **Never commit to it.** It only ever fast-forwards. |
| `product` | Our commercial branch. All fork changes (branding, defaults, fixes) live here. |

## Branch rules

1. All work happens on `product` (or short-lived branches merged into `product`).
2. `main` is only ever updated with `git fetch upstream && git merge --ff-only upstream/main`. If a fast-forward fails, stop and investigate — never force.
3. Never rebase `product` onto `main`. Merge only. Upstream advances via clean,
   append-only squash commits (their `CONTRIBUTING.md` documents the snapshot
   model), so merges are cheap as long as our changes stay surgical.
4. Keep fork changes in as few files as practical. Prefer adding new files
   (e.g. `fork/`, a branding module) over editing upstream files, because a new
   file can never conflict with an upstream sync.

## Weekly upstream sync

```bash
git checkout main
git fetch upstream
git merge --ff-only upstream/main     # must be a fast-forward
git push origin main

git checkout product
git merge main                        # bring upstream changes into the product branch
# resolve conflicts if any, then:
npm install                           # lockfile may have changed
npm run typecheck && npm test
git push origin product
```

After every sync, run the per-sync checks in `fork/COMPLIANCE.md`
(`ee/` exclusion, trademark sweep, modified-files list update).

## What to fix where

- **Generic bugs** (format fidelity, crashes, cross-platform issues): fix on a
  branch off `main` and send upstream a PR. Upstream actively accepts external
  PRs (#134, #156, #161, #162 are community work). Once merged upstream, the
  fix rides the next snapshot and we stop maintaining it.
- **Fork-only changes** (branding, packaging defaults, AI-provider defaults,
  updater feed, licensing files): fix on `product` only, in the thin layers
  listed in `fork/COMPLIANCE.md`, so upstream merges stay conflict-free.
- **Commercial differentiators**: keep them in separate, additive modules
  (new files/packages) — not woven into upstream engine code.

## Upstream tracking notes

- Upstream has no CLA and states the Apache-2.0 core cannot be relicensed —
  our fork's legal basis is stable.
- Upstream ships near-daily releases; expect a meaningful snapshot every few
  days and PR numbers climbing steadily.
- Their release/packaging automation is NOT in the repo; our own packaging is
  `npm run dist:win` (see fork notes on the xlsx sidecar path in CONTRIBUTING).
