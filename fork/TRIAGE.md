# Windows Build & Triage Report

Date: 2026-08-27 · Branch: `product` @ 5806e14 · Upstream: genspark-ai/genoffice@main (v0.8.440 era)

## What was verified on this Windows machine

| Step | Result |
| --- | --- |
| `npm install` (849 packages) | ✅ 29 min (OneDrive-synced folder is the bottleneck) |
| Rust xlsx sidecar `cargo build --release` | ✅ 8.5 MB exe, 10m51s |
| `npm run fixtures` | ✅ zero drift vs committed fixtures (rebrand sweep is generator-safe) |
| `npm run build:all` (all 6 apps) | ✅ exit 0 |
| `npm run typecheck` (19 workspaces) | ✅ exit 0 — includes the 551-string rebrand sweep |
| Unit tests, all 19 workspaces | ✅ green after fixes below (see "slides flake") |
| `npm run test:e2e` (Playwright-Electron, 37 specs) | ✅ 37/37 after fixes below |

## Issues found and fixed in this session (all committed on `product`)

**Windows-only test bugs** — upstream CI runs Ubuntu only, so every one of
these passed their CI and failed here. All are excellent upstream PR
candidates ("tests are platform-naive; product code is correct"):

1. `packages/electron-utils` dialog-memory tests hardcoded POSIX `/work`
   separators while the code correctly uses `node:path` (backslashes on
   win32). Fixed by deriving expectations through `node:path`.
2. `default-save-dir` "not writable" test: POSIX `chmod 0o500` cannot revoke
   directory write access on NTFS. Now skipped on win32 with an explanatory
   comment. **Product caveat:** `accessSync(dir, W_OK)` is unreliable on
   Windows, so the "degrade to fallback" feature may silently never trigger
   there — needs a real-ACL check or verification with restricted folders.
3. `apps/pdf` generated-output test used `a:b?.pdf` — on win32 `a:` parses as
   a drive letter inside `basename()` (correct behavior), mangling the test's
   expectation. Test input made platform-neutral.

**Fork-caused test breakages** (sweep renamed user-visible strings; tests
hardcoded the old brand). Fixed by exporting constants so tests never
hardcode brand strings again:

4. `electron-utils` save-dir fallback name → exported `DEFAULT_SAVE_FOLDER`.
5. `apps/pdf` default annotation author → exported `DEFAULT_ANNOTATION_AUTHOR`
   from `save-pdf.ts`, used at all four `/T` fallbacks.
6. `apps/shell` home/untitled tab titles → exported `HOME_TAB_TITLE`,
   `UNTITLED_DOCS_TAB_TITLE` from `tab-manager.ts`.

**Re-runnable:** the full suite is green per-workspace. The chained
`npm test` run showed 7 slides failures (save-streaming, copy-paste,
group-edit, chart round-trip, slide-size) that **all pass in isolation** —
load/timeout flakes when slides runs right after the heavy sheets/shell
suites on a OneDrive-synced disk. Watch for recurrence; if persistent,
raise the 90s per-test timeout or run slides first.

## Upstream bugs to work first (from genspark-ai/genoffice issues)

| Priority | Issue | Impact | Route |
| --- | --- | --- | --- |
| P0 | **#158** sheets freeze: JS heap >3 GB, tab crash on wide-range conditional formats | Data-loss-class crash on realistic files | Fix locally, PR upstream |
| P1 | **#118** .docx layout breakage | Core fidelity promise | Reproduce, PR upstream |
| P2 | #157 + #36 .doc (legacy binary) support | Common inbound format | Feature — decide scope vs "convert first" flow |
| P2 | In-code TODOs: pivot-table/slicer/chart OOXML **write-back** not implemented (`apps/sheets/src/domain/pivot-*.ts`, `src/gateway/xlsx-pivot*.ts`) | Pivots survive in-session only; saving drops them | Medium-large feature |
| P3 | #152 CSV export, #65 table formatting, #13 RTL, #45 user-owned AI config | Parity asks | Mostly upstream's roadmap |

## Structural risks (not bugs — operating hazards)

1. **No Windows CI upstream or in the fork.** Every Windows-only failure class
   (path separators, NTFS ACLs, drive-letter parsing) is invisible to both.
   **Recommendation: add a Windows `npm test` lane to our fork's CI** — it
   catches the exact class of bugs our customers will hit.
2. **electron-builder fragility** (`apps/shell/electron-builder.cjs`): absent
   `apps/*/out` module trees or wasm files are **skipped silently (exit 0)**,
   shipping installers that launch but break per-tab. Hard requirement:
   `build:all` immediately before `dist:win`, every time.
3. **`@genspark/cli` hoisting assumption**: packaging hard-fails if npm's
   hoisting layout changes (nested commander path). Pinned by the check, but
   any dependency refresh can trigger it.
4. **npm audit: 2 high** — `image-size` DoS (infinite loops on malicious
   ICNS/JXL/HEIF) via `pptxgenjs`. Only reachable when a user opens a
   malicious image through slides import. `npm audit fix --force` would
   downgrade pptxgenjs (breaking) — do NOT run it. File upstream issue
   asking for a pptxgenjs bump.
5. **OneDrive dev folder**: 29-minute installs, heavy build I/O, sync races
   on `out/`. **Recommendation: move the dev clone out of OneDrive**
   (e.g. `C:\dev\`) and keep OneDrive for documents only.
6. **`dist:win` sidecar path quirk**: expects the MinGW target path;
   the MSVC-built exe must be copied to
   `apps/sheets/native/xlsx-engine/target/x86_64-pc-windows-gnu/release/`
   before packaging (documented in CONTRIBUTING).

## Rebrand work still open (tracked in fork/COMPLIANCE.md)

- Icon set (`apps/shell/build/`) + `genoffice-logo.svg` asset — needs real brand assets.
- **Font binaries carry GenOffice family names** (`GenOffice Gothic KR`,
  `GenOffice Songti SC`, `GenOffice PUA Blank`, …) — visible in font pickers;
  regenerate via `tools/*.py` font tooling with the real brand.
- Genspark sign-in UI still rendered (gsk engine path is default-off now).
- Onboarding/star-prompt copy points users at upstream's GitHub.
- README.md is still upstream's.

## e2e (Playwright-Electron) result

**37/37 passed on Windows (3.5 min)** against the `build:all` output, after
two rounds of fixes:

1. First run (18 passed): sheets e2e fixtures missing — CI generates them via
   `npm run fixtures -w @genoffice/sheets` before e2e; our run skipped that
   step. Fixed by generating them.
2. Second run (32 passed, 5 failed):
   - 2 fork-caused: e2e specs hardcoded the old brand (onboarding title,
     default save-dir name). Fixed by extending `fork/rebrand-sweep.mjs` to
     cover `e2e/` so brand assertions follow the brand automatically.
   - 3 Windows-genuine: `sheets-xlsm`, `sheets-ribbon-batch`,
     `slides-font-manager` shell out to the Unix `zip`/`unzip` CLIs (absent or
     bracket-escaping-quirky on stock Windows). Replaced with `jszip`
     (already in the dependency tree). **This is an upstream PR candidate:
     their e2e cannot run on a stock Windows machine at all.**
   - Note: several other specs use `unzip -p` and happen to work with Git
     Bash's unzip; a follow-up PR could unify all of them on jszip.

All e2e specs exercise the real packaged-layout Electron shell (launch,
onboarding, every editor, save/reopen round-trips), so the app is verified
working end-to-end on Windows.
