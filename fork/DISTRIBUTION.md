# Distributing Zanostack — updates, signing, and going proprietary

Fork-side operational doc, sibling to `RUNBOOK.md` (upstream syncs) and
`.agents/books_production_signoff.md` (books readiness). Facts verified 2026-10-02.

## 1. Two kinds of "update" — never confuse them

- **Code updates (upstream sync)**: follow `fork/RUNBOOK.md`. Pull upstream, merge into
  `product`, `node fork/rebrand-sweep.mjs` re-applies the white label, verify, push `origin`
  (the private product repo) — NEVER push to `upstream` (genspark-ai/genoffice). The app
  itself never touches git.
- **App updates for installed users**: the app ships with electron-updater
  (`apps/shell/src/main/updater.ts`) and the feed address is baked into the installer at
  build time via `GENOFFICE_UPDATE_URL` (`apps/shell/electron-builder.cjs:46`, publish
  config at `:758-766`, generic provider). Since **0.13.0** the baked feed is
  `https://github.com/brantenK/zanostack-releases/releases/latest/download`.
  **Never point `GENOFFICE_UPDATE_URL` at the upstream repo's releases**: in-app updates
  would install upstream's un-branded build over Zanostack. Point it at your own releases
  only.

## 2. Delivering a new version (what we actually do)

1. `npm run dist:win` from the repo root with `GENOFFICE_UPDATE_URL` set to the release
   feed (chains notices + full build + NSIS packaging; ~6 min; unsigned local build per
   `electron-builder.cjs:736-738` unless a sign mode is configured — see §3).
2. Three artifacts land in `apps/shell/release/`: `Zanostack Setup <version>.exe`, the
   `.blockmap`, and the generated `latest.yml`. Publish all three (see §7 for the
   asset-name rule).
3. Installing over an existing install is safe: user data lives **outside** the app
   (books ledger: `%APPDATA%\Zanostack\books\books-data.json`, with `.bak` sibling and
   `backups/`), so reinstalls and updates never touch it.
4. Version lives in `apps/shell/package.json` (**0.13.0 as of 2026-10-02**). Bump it per
   release so installer filenames and in-app `app.status` stay distinguishable.
5. Windows SmartScreen shows "unknown publisher" once per machine for unsigned builds —
   "More info → Run anyway". Expected for self-built apps.

## 3. Code signing — what's free, what isn't

- **Free, built in**: `GENOFFICE_WIN_SIGN_MODE=test` — the builder's signing dispatch
  (`electron-builder.cjs:725-755`) shells out to `scripts/win-sign.cjs`, whose two modes
  are documented there ("test" = self-signed PFX, "production" = DigiCert KeyLocker).
  **Note:** `scripts/win-sign.cjs` does not exist in this repository
  (`scripts/win-sign.cjs` belongs to upstream's separate release automation —
  upstream's public repo and CI don't contain it, and it was never committed here) —
  enabling either sign mode today fails at the signing step until the
  script is restored/committed. Unset (the default) packages unsigned, which is what all
  releases so far have used.
- **Real signing (removes the warning) is never free** — since 2023 all genuine certs live
  on hardware/cloud tokens. Cheapest routes, re-checked 2026-10-01:
  - Microsoft **Artifact Signing** (formerly Azure Trusted Signing): managed, Basic tier
    historically ~US$10/month; check current pricing and individual-developer availability.
  - Individual certificates (Certum / SSL.com / Sectigo): roughly US$70–300/year.
  - **DigiCert KeyLocker** is the wired `production` mode — buying the cert AND restoring
    the `scripts/win-sign.cjs` contract are the remaining steps for that route.
- Even with a paid certificate, SmartScreen reputation builds with download volume; the
  warning is not instant magic for a brand-new file.
- Recommendation: stay unsigned while testing; buy the cheapest managed signing when
  distributing publicly.

## 4. In-app auto-updates (current feed live since 0.13.0)

1. The feed is `https://github.com/brantenK/zanostack-releases/releases/latest/download`
   (baked into 0.13.0+ installers; the 0.12.0-era installers read the legacy fork's
   releases instead — see §7).
2. A release publishes three files with matching names: the installer `.exe`, the
   `.blockmap`, and electron-builder's `latest.yml` (the blockmap is not fetched by the
   updater — full-package policy — but ship it anyway). The updater checks the feed, asks the
   user before downloading (`autoDownload: false`), and installs on quit
   (`autoInstallOnAppQuit: true`; `updater.ts:616-619`). `allowDowngrade: false`.
3. Release flow: bump version → `dist:win` with the feed URL set → publish the three
   files → every installed user is offered the update on their next launch.
4. Hosting notes: GitHub Releases on a **public** repo works as a generic feed; a
   **private** repo's assets require authenticated downloads a generic feed can't
   provide — that is exactly why `zanostack-releases` exists as a binaries-only public
   repo while the source stays private.

## 5. Proprietary status (done 2026-10-01)

- The product source home is the **private** `brantenK/zanostack` (local remote `origin`).
- The only public surfaces are `zanostack-releases` (binaries, no code) and the legacy
  `brantenK/genoffice` fork, which is kept only for the 0.12.0-era release feed and can be
  deleted once those installers no longer matter (owner's call; deletion is web-UI only
  and cannot be undone).
- **Licensing machinery does not exist yet.** The `ee/` directory is the reserved home
  ("private deployment and offline license verification" per its README). Design sketch
  for later: offline-signed license keys + an activation gate, enforced server-side if/when
  AI is sold through your own gateway.
- AI is **fully BYOK** today (keys pasted by users in Settings, stored in
  `userData/ai-settings.json`, traffic direct to providers) — nothing of yours is exposed,
  and no baked keys exist anywhere (the OpenAI/Anthropic/etc. editor paths are strictly
  user-pasted; the dormant genspark provider can additionally use a per-machine gsk
  login key when one exists — `packages/ai-search/src/gsk.ts`) (audited 2026-09-30).
- Before commercializing, re-check the upstream project's license terms.

## 6. Data-safety facts worth repeating to users

- Books data: `%APPDATA%\Zanostack\books\books-data.json` (atomic writes, `.bak` sibling,
  `backups/` rotation, restore safety copies). Survives updates and reinstalls.
- Backups are manual — "Backup now" is the only `books-backup-*.json` producer.
- Never run an older build over data written by a newer one: newer schema versions are
  refused by older builds (safely, with an error — never corruption).

## 7. Repository layout (2026-10-01, updated 2026-10-02)

- **`brantenK/zanostack` (private)** — the product source home; local remote `origin`
  (full `product` history pushed 2026-10-01). All future code work and pushes go here.
- **`brantenK/zanostack-releases` (public)** — binaries only (installer, blockmap,
  `latest.yml`); hosts the update feed. **v0.13.0 is published here and is the current
  feed contents.** No product code lives here, so it stays public even after the source
  went private.
- **`brantenK/genoffice` (public fork)** — legacy: hosts the v0.12.0 and v0.12.0-r2
  releases that the 0.12.0-era installers read. With v0.13.0 published on
  `zanostack-releases` (new feed baked in), this fork's release duty is over; the owner
  has chosen to keep it for now, but it can be deleted from the web UI at any time
  without affecting updates for 0.13.0+ installs. Syncing does NOT need it — the runbook
  fetches upstream directly.
- **`genspark-ai/genoffice` (upstream)** — sync source only; never pushed to.

**Asset-name rule (empirically verified 2026-10-01/02):** uploading release assets via
the API normalizes spaces in names to dots (`Zanostack Setup 0.13.0.exe` becomes
`Zanostack.Setup.0.13.0.exe`), and the `/releases/download/` endpoint resolves **only the
dotted spelling** — a spaced URL 404s after the redirect. Always rewrite the generated
`latest.yml`'s `url:`/`path:` fields to the dotted form before uploading it, and upload
the installer/blockmap with dotted names in the `?name=` parameter. Publishing as a
**draft** first and flipping to published after all assets land avoids a window where
`latest.yml` exists but the installer does not.
