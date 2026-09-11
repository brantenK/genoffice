# CLAUDE.md

Guidance for AI agents and human contributors working in this repo.

## Git and fork workflow (mandatory)

This checkout is a Zanostack fork of GenOffice. Treat the branch roles as part
of the product architecture, not as a suggestion:

| Name       | Role                                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| `upstream` | The original GenOffice repository. Read/fetch from it for upstream tracking. |
| `origin`   | The Zanostack GitHub repository. Normal fork pushes go here.                 |
| `main`     | Read-only, fast-forward-only mirror of `upstream/main`.                      |
| `product`  | Zanostack development and release branch. Fork work belongs here.            |

### Normal work and pushes

1. Before a commit, merge, or push, inspect the facts first:

   ```bash
   git status --short --branch
   git branch -vv
   git remote -v
   ```

   Confirm the current branch and its tracking target. Do not infer them from a
   branch name, an old conversation, or a GitHub page.

2. Start ordinary Zanostack work from `product`, or from a short-lived branch
   created from `product`. Target `product` when opening an internal pull
   request.
3. For a feature branch's first push, verify its name and push only to the fork:

   ```bash
   git push -u origin <branch-name>
   ```

   For later pushes, use plain `git push` only after confirming it tracks the
   intended `origin/<branch-name>`.

4. Never push Zanostack work to `upstream`. A generic fix can go upstream only
   through an intentional, separately prepared upstream contribution.

### Mirror and safety rules

- Do not commit to, merge fork work into, rebase onto, reset, or normally push
  `main`. Its normal update is only a fast-forward from `upstream/main`.
- Never use `--force`, `--force-with-lease`, or a destructive reset on any
  remote branch unless the repository owner explicitly asks for that exact
  operation. First create and verify a named backup branch.
- Do not run `npm run sync:upstream` or `fork/tools/sync-upstream.mjs` casually.
  Read `fork/RUNBOOK.md`, ensure the worktree is clean, and follow its sync
  procedure.
- If branch tracking, the push destination, divergence, merge conflicts, or the
  intended target is unclear, stop. Report `git status --short --branch`,
  `git branch -vv`, and `git remote -v`; do not try to repair Git state by
  guessing.

`fork/RUNBOOK.md` is the detailed maintenance procedure. Read
`fork/COMPLIANCE.md` after every upstream integration.

## Theming rules (mandatory)

The suite supports light / dark / system UI themes. The switching mechanism is a
`data-theme` attribute on `<html>` plus CSS custom properties defined once in
`packages/ui/src/tokens.css` (light defaults in `:root`, overrides in
`[data-theme='dark']`, and a `prefers-color-scheme` media-query fallback for
system mode).

1. **UI chrome colors must use semantic tokens.** Never write raw `#hex` /
   `rgb()` in renderer CSS rules or chrome-related inline styles — reference
   `var(--surface)`, `var(--text)`, `var(--hover)`, etc. from
   `packages/ui/src/tokens.css`. Raw values are allowed only on custom-property
   definition lines (`--x: #...;` — token, accent, or app-scoped variable
   definitions). CI enforces this for new/changed renderer CSS lines
   (`tools/check-theme-colors.mjs`).
2. **Every new token gets both values.** Adding a token means adding it to all
   three blocks in `tokens.css` (light, dark, system-dark fallback).
3. **Accent colors stay per-app.** Each app defines `--accent` /
   `--accent-dark` / `--accent-soft` (and its dark-adjusted values) in its own
   `styles.css`. Shared rules reference `var(--accent)` and inherit the app's
   brand color.
4. **Document content is never re-authored by the theme.** Page surfaces, cell
   fills, slide content, PDF page bitmaps, export/print stylesheets, chart
   palettes, highlight color maps, stamps, and WordArt presets are document
   data: they stay hardcoded, must not reference chrome tokens, and every
   save/export/print path must produce identical output in both themes. A
   Word/Excel-style _dark page_ (Sheets via Univer's `darkMode`, Docs via
   `apps/docs/src/renderer/editor/dark-page.ts`) is a display-time remap only:
   the authored color stays the real declaration, the remapped twin lives in
   a screen-only `--dk-*` / `.page-dark` layer, and print/export never see it.
5. **Canvas-drawn UI affordances go through a constants table.** Konva/canvas
   editing chrome (selection frames, guides, handles) reads from the app's
   canvas color table (e.g. `canvas-colors.ts`) keyed by the current theme —
   no inline hex in draw calls.

## Build gotchas

- App main-process code (`apps/*/src/main`) is compiled into the **shell**
  build. After changing it, rebuild the shell or the change silently does not
  run.
- In dev mode, preload changes require a rebuild — a stale preload leaves the
  renderer blank.
- Workspace packages listed in an app's `dependencies` must also be added to
  the `externalizeDepsPlugin` `exclude` list, or the packaged app crashes on
  launch.
- `useI18n()`'s `t` is not referentially stable; never put it in a hook
  dependency array. Store the key and translate at render time.

## UI strings (i18n)

- Large dictionaries are sharded per locale: `i18n/strings-<domain>.ts` is a
  thin aggregator over `i18n/<domain>/<lang>.ts` (one file per language, `zh`
  defines the key set). Add a new key to `zh.ts` and to every sibling shard;
  the `satisfies Record<keyof typeof zh, string>` on each shard turns a
  missing or extra key into a type error. Never grow the aggregator back into
  a single 19-locale object.
