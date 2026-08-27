# Fork Compliance Checklist

Legal obligations for distributing this fork commercially, per the Apache
License 2.0 (`LICENSE`) and the upstream project's statements in `README.md`,
`NOTICE`, and `CONTRIBUTING.md`. Run the per-sync checks after every upstream
merge (see `fork/RUNBOOK.md`).

## Standing obligations (Apache-2.0 §4)

1. **License retention** — a copy of Apache-2.0 ships with every distribution
   (electron-builder packages `LICENSE` automatically; verify in the built
   installer before each release).
2. **NOTICE retention** — upstream `NOTICE` ("GenOffice / Copyright 2026
   Mainfunc, Inc.") must be carried through. Do not delete or rewrite the
   copyright line; our fork's own notice may be added alongside it.
3. **Modified-files notice** — files modified relative to upstream must be
   marked (Apache-2.0 §4(b)). Keep the running list below.
4. **Third-party notices** — run `node tools/gen-third-party-notices.mjs`
   before packaging; electron-builder includes the output in the bundle.

## Hard restrictions

- **Trademark**: "GenOffice" and "Genspark" names/logos are trademarks of
  Mainfunc, Inc. and are NOT licensed to us (README License section, Apache-2.0
  §6). Our product must ship under our own brand. Every user-visible occurrence
  must be swept (see per-sync check #3).
- **`ee/` directory**: under the proprietary GenOffice Enterprise License, not
  Apache-2.0. It is currently empty (LICENSE/README only) but must never be
  packaged or distributed, and never contributed to.
- **Genspark services**: Genspark sign-in and `gsk` search endpoints run on
  Mainfunc's servers. Our build must default to BYOK providers and the keyless
  search fallback, and must not ship Genspark credentials.

## Per-sync checks

1. `ee/` exclusion: confirm nothing under `ee/` is referenced by
   `apps/shell/electron-builder.cjs` (files/extraResources) or added to
   installers.
2. NOTICE intact: `git diff main -- NOTICE LICENSE` shows no deletions.
3. Trademark sweep: `grep -ri "genoffice" apps packages --include="*.ts" -l`
   (excluding i18n string-data files and tests) plus a visual pass over the
   built app's About/settings screens. Count only user-visible strings.
4. Updater feed: confirm the auto-updater does not point at Genspark's release
   feed (fork must own its update channel or have updates disabled).
5. Modified-files list: update the table below.

## Modified files (fork changes vs upstream/main)

| File / path | Change | Reason |
| --- | --- | --- |
| `fork/` (this directory) | Added | Fork docs, brand.json, rebrand-sweep.mjs — new files, no upstream conflict |
| 37 source files + packaging (see `git diff main --stat` on product) | "GenOffice"/"GenTeam" string sweep → current brand | Trademark compliance; run `node fork/rebrand-sweep.mjs` to re-apply after syncs or a name change |
| `apps/shell/electron-builder.cjs` | appId, productName, executableName, deb/rpm names, maintainer/vendor | Trademark compliance |
| `apps/shell/package.json` | productName | Electron app.name + userData dir |
| `packages/ai-search/src/gsk.ts` | gsk backend default OFF (opt in with `AI_SEARCH_DISABLE_GSK=0`) | Do not route fork users through Genspark services |

Protections verified after the sweep: `@genoffice/*` npm scope, `GENOFFICE_*`
env-var prefix, and PDF format keys (`GenOfficeStaticFormFills`,
`GenOfficeFormField`) are untouched; zero bare "GenOffice" strings remain in
non-test sources.

## Branding swap status

Brand: **Zano Office** (placeholder ExampleOffice fully retired; sweep
`previousNames` migrates both). Design system ported from
`brantenK/zano-suite-agno` (frontend tokens.css): warm cream surfaces, Zano
green `#16864a` / dark `#2fbd74`, 18px radius curve, Plus Jakarta Sans (UI)
+ Instrument Serif (display moments: Home hero, AI-panel empty states),
Zano logo + icon set. Applied via:

- `packages/ui/src/tokens.css` — token values swapped, `--gs-panel-bg` and
  `--gs-font-display` added (all three theme blocks)
- per-app `styles.css` accents → Zano green; `.ai-panel`/`.copilot` surfaces
  → `--gs-panel-bg`; empty-state titles → Instrument Serif italic
- `apps/shell` Home lockup = `zano-logo.png` + text wordmark; hero serif
- icons: `build/icon.png` (1024px Zano) + Linux hicolor set; electron-builder
  generates ico/icns from the png
- fonts self-hosted via `@fontsource/plus-jakarta-sans` +
  `@fontsource/instrument-serif` (packages/ui deps; OFL, offline-safe)

Still open:
- **Icon raster sizes**: 48/128/256/512 px slots reuse the nearest available
  Zano PNGs (16/32/64/80/1024 source sizes); regenerate exact sizes from the
  1024px source with real image tooling before release.
- **README.md** is still upstream's.
- **Main-process leftovers**: the gsk auth/cloud-projects machinery in
  `packages/ai-search/src/genoffice-auth.ts`, `apps/shell/src/main/cloud-projects.ts`
  and the star-prompt IPC handlers are unreachable dead code (renderer UI
  removed) — deep removal is a follow-up, not worth the merge risk now.
- 5 pre-existing Windows test failures (HEAD-identical): shell
  `cloud-projects.test.ts` account-store binding/lifecycle — the store file
  delete does not take effect on win32; candidate upstream Windows-CI PR.

## Genspark surface removal (done)

- AI provider list no longer offers Genspark; fresh settings default to
  Claude, gsk tools off; legacy settings files degrade to Claude.
- Settings: account pane is a BYOK note; sign-in/credits/logout UI removed;
  gsk-tools toggle removed.
- AI panel/ribbon monogram → Zano logo (`ZanoMark`).
- Home: cloud-projects nav + sign-in CTA + account-name greeting removed.
- Onboarding credits offer panel removed.
- Star prompt removed (renderer + files + IPC query).
- `AI_SEARCH_DISABLE_GSK` default-off flip in `packages/ai-search` still
  governs the engine path; settings key `gskToolsEnabled` now defaults false.

## Safe-by-default packaging (verified in electron-builder.cjs)

- Auto-update feed (`GENOFFICE_UPDATE_URL`): unset for fork builds → no
  `app-update.yml` baked, auto-update disabled. Never point it at upstream's
  feed.
- GA4 analytics (`GENOFFICE_GA4_*`): unset → fully disabled.
- Font CDN (`GENOFFICE_FONT_CDN_URL`): unset → download catalog hidden.

