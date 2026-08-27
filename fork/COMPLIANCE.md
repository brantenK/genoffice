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

Placeholder brand **ExampleOffice** is applied everywhere except:
- **Icons** — `apps/shell/build/` (icon.icns/.ico/png + icons/ set) still
  carries upstream logos. Replace when real brand assets exist.
- **Genspark sign-in UI** — gsk backend is now default-off, but the sign-in
  UI flow (Home.tsx / SettingsModal.tsx / provider-logos.tsx) should be
  hidden or reworded for the fork.
- **Onboarding / star-prompt copy** — shell strings still encourage starring
  upstream's GitHub repo and mention alpha status; copy needs a fork-specific
  rewrite (functional, not just a name swap).
- **README.md / repo docs** — still upstream's; rewrite before any public
  distribution.

## Safe-by-default packaging (verified in electron-builder.cjs)

- Auto-update feed (`GENOFFICE_UPDATE_URL`): unset for fork builds → no
  `app-update.yml` baked, auto-update disabled. Never point it at upstream's
  feed.
- GA4 analytics (`GENOFFICE_GA4_*`): unset → fully disabled.
- Font CDN (`GENOFFICE_FONT_CDN_URL`): unset → download catalog hidden.

