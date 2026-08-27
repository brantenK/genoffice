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
| `fork/` (this directory) | Added | Fork docs — new files, no upstream conflict |
| _(updated at each sync / change)_ | | |

## Branding swap status

See the rebrand inventory in this file's companion notes from the rebrand
scaffold work. Placeholder brand token is in use until the final brand name is
confirmed.
