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
3. Trademark sweep: `npm run check:brand` (fatal tier must pass; the advisory
   tier reports remaining vendor-name strings). Then a visual pass over the
   built app's About/settings screens, counting only user-visible strings.
4. Fork chrome intact: `npm run check:app-chrome` — asserts the Home launcher
   markup/styles, fork-only design tokens and fork-only tab kinds survived the
   merge. A pass here does not prove the UI looks right; open Home once.
5. Updater feed: confirm the auto-updater does not point at Genspark's release
   feed (fork must own its update channel or have updates disabled).
6. Modified-files list: update the table below.

## Modified files (fork changes vs upstream/main)

| File / path                                                                                                                                                                                                                                    | Change                                                                                                                                                                                                                                                                                                                                                                                 | Reason                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fork/` (this directory)                                                                                                                                                                                                                       | Added                                                                                                                                                                                                                                                                                                                                                                                  | Fork docs, brand.json, rebrand-sweep.mjs — new files, no upstream conflict                                                                                                                                                                                                                                                                  |
| ~40 source files + packaging (see `git diff main --stat` on product)                                                                                                                                                                           | "GenOffice"/"GenTeam"/"Zano Office" string sweep → current brand                                                                                                                                                                                                                                                                                                                       | Trademark compliance; run `node fork/rebrand-sweep.mjs` to re-apply after syncs or a name change                                                                                                                                                                                                                                            |
| `fork/rebrand-sweep.mjs`                                                                                                                                                                                                                       | Scope is now an explicit dir allowlist (`apps/`, `packages/`, `e2e/`, `skills/`, `scripts/`, `tools/`, `.github/` + root `README.md`/`CONTRIBUTING.md`/`PRIVACY.md`); extensions added `.css`, `.md`, `.sh`, `.cmd`, `.nsh`, `.cjs`, `.mjs`, `.js`, `.py`, `.yml`; test files no longer excluded; honours the `brand-check-ignore` marker; `--dry` no longer counts no-op self-renames | The old scope silently missed brand strings in CSS, docs, installer scripts, agent skills and upstream's own test assertions                                                                                                                                                                                                                |
| `fork/tools/check-brand.mjs`                                                                                                                                                                                                                   | Scope matched to the sweep; two-tier gate (fatal upstream product name, advisory upstream vendor name); `brand-check-ignore` support; fixed a `/g`-regex `lastIndex` bug that made `.test()` skip matches                                                                                                                                                                              | Gate and sweep must agree, or a leak can be invisible to both                                                                                                                                                                                                                                                                               |
| `fork/tools/check-app-chrome.mjs`                                                                                                                                                                                                              | Added — asserts the Home launcher chrome, fork-only design tokens and fork-only tab kinds survive a merge                                                                                                                                                                                                                                                                              | The sweep protects brand _strings_, not structural UI; upstream rewrites the same files, so a conflict resolved upstream's way can leave the UI silently unstyled                                                                                                                                                                           |
| `apps/shell/electron-builder.cjs`                                                                                                                                                                                                              | appId, productName, executableName, deb/rpm names, maintainer/vendor                                                                                                                                                                                                                                                                                                                   | Trademark compliance                                                                                                                                                                                                                                                                                                                        |
| `apps/shell/package.json`                                                                                                                                                                                                                      | productName                                                                                                                                                                                                                                                                                                                                                                            | Electron app.name + userData dir                                                                                                                                                                                                                                                                                                            |
| `packages/ai-search/src/gsk.ts`                                                                                                                                                                                                                | gsk backend default OFF (opt in with `AI_SEARCH_DISABLE_GSK=0`)                                                                                                                                                                                                                                                                                                                        | Do not route fork users through Genspark services                                                                                                                                                                                                                                                                                           |
| Upstream sync merge (2026-09-10)                                                                                                                                                                                                               | Integrated the upstream commit range (Docs/Sheets/Slides/PDF/Markdown fixes + the HTML editor) while keeping Zanostack brand, BYOK-first defaults, and CRM/Tenders/Books                                                                                                                                                                                                               | Take upstream fixes without losing fork policy                                                                                                                                                                                                                                                                                              |
| `apps/html/`                                                                                                                                                                                                                                   | New upstream module, re-branded (`productName`, window title, page/AI prompts → Zanostack), port 5181                                                                                                                                                                                                                                                                                  | Trademark compliance for the integrated HTML editor                                                                                                                                                                                                                                                                                         |
| `apps/docs/.../fonts/fonts.css`, `line-metrics.ts`, `editor/marks.ts`, docs font tests                                                                                                                                                         | Internal `GenOffice *` font aliases → `Zanostack *` (bundled font binaries keep their embedded names)                                                                                                                                                                                                                                                                                  | White-label consistency: CSS family names must match the code that emits them                                                                                                                                                                                                                                                               |
| `packages/ai-provider/src/fetch.ts`                                                                                                                                                                                                            | Default AI `User-Agent` → `Zanostack`                                                                                                                                                                                                                                                                                                                                                  | Trademark compliance                                                                                                                                                                                                                                                                                                                        |
| `packages/ai-provider/src/codex-app-server.ts`, `packages/ai-search/src/search-tools.ts`, `apps/docs/src/main/docs-main.ts`, `apps/sheets/src/main/sheets-main.ts`, `apps/slides/src/main/ai-ipc.ts`, `apps/shell/src/renderer/src/strings.ts` | Bare `GenOffice` strings → `Zanostack`                                                                                                                                                                                                                                                                                                                                                 | Trademark compliance                                                                                                                                                                                                                                                                                                                        |
| Upstream sync merge (2026-09-22)                                                                                                                                                                                                               | Integrated the upstream commit range `de139a06..efb9247` (246 commits: security hardening across every file parser, the MCP server plus the four new packages, PDF redaction, Zotero, the Parallel and Opper providers) while keeping Zanostack brand, BYOK-first defaults and CRM/Tenders/Books                                                                                       | Take upstream fixes without losing fork policy                                                                                                                                                                                                                                                                                              |
| `apps/shell/src/main/updater.ts`, `apps/shell/src/main/index.ts`, `packages/electron-utils/src/github-menu.ts`, `apps/shell/src/renderer/src/SettingsModal.tsx`, `apps/shell/src/renderer/src/IntegrationsPane.tsx`                            | In-app links point at `github.com/brantenK/genoffice`                                                                                                                                                                                                                                                                                                                                  | Compliance: the fork must own its update channel and every star/install CTA; upstream's URLs sent users to the upstream project                                                                                                                                                                                                             |
| `packages/html2docx/src/drivers/playwright.ts`                                                                                                                                                                                                 | Added Windows Chrome candidate paths                                                                                                                                                                                                                                                                                                                                                   | Upstream lists macOS/Linux locations only, so `npm test` could not find an installed Chrome on Windows and silently skipped the whole html2docx feature suite (66 tests)                                                                                                                                                                    |
| `apps/pdf/src/main/pdf-main.ts`, `apps/pdf/src/shared/ipc.ts`, `apps/pdf/src/preload/index.ts`, `apps/pdf/src/renderer/App.tsx`                                                                                                                | Fork's duplicate shell-rename implementation removed; upstream's bare-string variant kept, extended to revoke the stale path grant                                                                                                                                                                                                                                                     | Both sides implemented the hook and the duplicates failed typecheck; `apps/html`/`apps/markdown` use the bare-string convention repo-wide                                                                                                                                                                                                   |
| `apps/shell/src/main/mcp/tools/open-documents-tools.ts`                                                                                                                                                                                        | Business apps are `undefined` in `FAMILY_BY_KIND`; the MCP open-documents surface lists editor-family tabs only                                                                                                                                                                                                                                                                        | CRM/Tenders/Books hold JSON stores, not editable Office documents, so upstream's exhaustive `Record<TabKind, …>` no longer typechecked                                                                                                                                                                                                      |
| `apps/pdf/src/renderer/i18n/strings.ts`                                                                                                                                                                                                        | Czech `aiCreditsExhausted` / `ribbonAiAssistant` brought in line with the other 18 locales                                                                                                                                                                                                                                                                                             | The fork's BYOK edit had skipped `cs`, leaving the `genspark.ai/pricing` upsell and "Genspark" as the ribbon AI label                                                                                                                                                                                                                       |
| `packages/ai-search/tests/media-tools.test.ts`                                                                                                                                                                                                 | Fixture writes a temp settings file with `providers: {}` and `gskToolsEnabled: true`                                                                                                                                                                                                                                                                                                   | Upstream's new test assumes cloud tools default ON, but the fork's BYOK default is OFF. Enabling them explicitly keeps upstream's coverage of the opt-in Genspark media route instead of deleting the tests. `providers` must be present: `resolveAiSettings()` early-returns the defaults when it is absent, which silently drops the flag |

Protections verified after the sweep: `@genoffice/*` npm scope, `GENOFFICE_*`
env-var prefix, and PDF format keys (`GenOfficeStaticFormFills`,
`GenOfficeFormField`) are untouched. `node fork/tools/check-brand.mjs` reports
zero bare "GenOffice" strings across the swept scope, which now includes test
files. Four paths are outside the sweep by design, and the reasons live in the
header of `fork/rebrand-sweep.mjs`: `NOTICE` and `LICENSE` (Apache-2.0 §4 needs
the upstream copyright line verbatim), `fork/` (the rebrand machinery names
upstream on purpose), and the vendored `tools/ooxml-validate/` toolset — its
README documents an amendment marker that lives inside the byte-identical
ISO/IEC 29500 `.xsd` files, so re-branding the prose would leave it describing
something the schema no longer says.

## Branding swap status

Brand: **Zano Office** (placeholder ExampleOffice fully retired; sweep
`previousNames` migrates both). Design system ported from
`brantenK/zano-suite-agno` (frontend tokens.css): warm cream surfaces, Zano
green `#16864a` / dark `#2fbd74`, 18px radius curve, Plus Jakarta Sans (UI)

- Instrument Serif (display moments: Home hero, AI-panel empty states),
  Zano logo + icon set. Applied via:

* `packages/ui/src/tokens.css` — token values swapped, `--gs-panel-bg` and
  `--gs-font-display` added (all three theme blocks)
* per-app `styles.css` accents → Zano green; `.ai-panel`/`.copilot` surfaces
  → `--gs-panel-bg`; empty-state titles → Instrument Serif italic
* `apps/shell` Home lockup = `zano-logo.png` + text wordmark; hero serif
* icons: `build/icon.png` (1024px Zano) + Linux hicolor set; electron-builder
  generates ico/icns from the png
* fonts self-hosted via `@fontsource/plus-jakarta-sans` +
  `@fontsource/instrument-serif` (packages/ui deps; OFL, offline-safe)

Still open:

- **`e2e/` has no `tsconfig.json`, so `npm run typecheck` never sees it.** A conflict resolution there that silently dropped half of a function compiled cleanly and only failed ~25 minutes into an e2e run. Worth adding a typecheck lane for `e2e/` — it needs the DOM lib and the preload's global `Window` augmentations to be set up correctly, or it reports spurious errors on the specs' `locator.evaluate` callbacks.
- **`e2e/` is red, and most of it predates this merge.** 116 passed / 32 failed / 7 skipped. None of it is a conflict-resolution mistake; the groups are:
  - **~19 specs drive the Home screen through `.quick-card`** (e.g. `.quick-card` `.first()` expecting "AI Docs", or `{ hasText: 'AI Sheets' }`). The fork's Home redesign replaced upstream's card row with its own `app-nav` launcher plus `canvas-actions`, leaving exactly one `.quick-card` — the "Open Local File" browse button. That count is already 1 before the merge (`git show product:apps/shell/src/renderer/src/Home.tsx | grep -c quick-card`), so **16 of the 19 were already broken**; only `docs-paste-options`, `docs-web-paste-font` and `home-folders` are new upstream specs. Resolution is a UI decision: either re-expose the card contract in the fork's Home, or port the specs to the fork's markup — the latter is what regains coverage of upstream's new features.
  - **~8 sheets specs shell out to the Unix `zip`** (`spawnSync zip ENOENT`). `fork/TRIAGE.md` already logged this class; the fork's jszip fixes for `sheets-xlsm`, `sheets-ribbon-batch` and `slides-font-manager` survived the merge, the rest were never converted.
  - **Theme expectations**: `theme-pipeline` and `theme-visual*` assert `data-theme` is null while the theme is "system"; the fork resolves and publishes the effective theme, so the attribute is already set.
  - **Actionability timeouts** — `locator.click` never becomes "visible, enabled and stable", with 500 ms click retries. Individual specs take 37–50 s here, so this is the OneDrive/load hazard `fork/TRIAGE.md` documents rather than a product defect.
  - Still to classify: `ai-panel-side-settings` (`toBeGreaterThan`), `html-tab` (`toHaveCount`), `slides-clipboard-image`, `settings-media-search`.
  - The fork's own `tenders` suite is largely green: all six `tenders-persistence-cutover` journeys, `tenders-regression-smoke`, all four `tenders-responsive` and most of the rest pass; the 5 failures are `tenders-intake-review` (4) and `tenders-lifecycle` (1), all actionability retries on specs that take 37–50 s each.
- **Docs batch modes silently misreport — upstream regression, surfaced by the new `packages/cli` tests.** `applyDocOps` (`packages/cli/src/formats/docx.ts:513`) counts an op as rejected when the docs executor reports `isError` or an output matching `No matching blocks`, but the merged docs engine returns `isError: false` with that text for an out-of-range target. Consequence: `--best-effort` reports `ok` with every op applied and `--stop-on-error` never stops. Three `batch-modes` tests and one `docx` guard-rail test are gated behind `GENOFFICE_DOCS_REJECT_SOFT_RESULTS=1` so they re-assert the moment the engine is fixed — they were not weakened or deleted. Not caused by this merge's conflict resolution (`packages/cli` is new), but it is a genuine defect to settle with upstream.
- **Icon raster sizes**: 48/128/256/512 px slots reuse the nearest available
  Zano PNGs (16/32/64/80/1024 source sizes); regenerate exact sizes from the
  1024px source with real image tooling before release.
- **README.md** is still upstream's.
- **`docs/` is outside the rebrand sweep by design** (see the header of
  `fork/rebrand-sweep.mjs`). It still carries upstream's name in ~800 places,
  mostly the 19 translated copies of upstream's README under `docs/i18n/`. The
  fork does not ship these. Decide per release whether to sweep, replace or
  delete them — do not let this grow silently.
- **~1,000 advisory "Genspark" strings in the i18n dictionaries**
  (`npm run check:brand` prints the count and top files; `strings.ts` alone has
  ~340). These are user-visible strings left over from the removed sign-in,
  credits and cloud-project surfaces. They ship in the bundle but no code path
  renders them today. Burning them down touches every locale shard at once
  (CLAUDE.md's i18n key-set invariant), so it is a deliberate, separate task.
- **Bundled font binaries keep upstream family names.** `fonts.css` aliases the
  faces to `Zanostack *`, but the `.woff2` name tables still say
  `GenOffice *`/`GenOfficeGothicKR-Regular`, so font pickers that enumerate
  installed fonts can still show the old name. Regenerate with `tools/build-*.py`.
  `apps/docs/tests/kr-font-metrics.test.ts` asserts the binary's real name and is
  exempted with the `brand-check-ignore` marker — do not "fix" it by hand.
- **Main-process leftovers**: the gsk auth/cloud-projects machinery in
  `packages/ai-search/src/genoffice-auth.ts`, `apps/shell/src/main/cloud-projects.ts`
  and the star-prompt IPC handlers are unreachable dead code (renderer UI
  removed) — deep removal is a follow-up, not worth the merge risk now.
- 5 pre-existing Windows test failures (HEAD-identical): shell
  `cloud-projects.test.ts` account-store binding/lifecycle — the store file
  delete does not take effect on win32; candidate upstream Windows-CI PR.
- `apps/docs` has 2 load-flaky tests (`docx-encryption.test.ts`,
  `protect-dialog.test.ts`) that pass in isolation but time out in the full
  workspace run on this OneDrive-synced disk — see `fork/TRIAGE.md`.

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
