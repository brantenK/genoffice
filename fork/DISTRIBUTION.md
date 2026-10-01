# Distributing Zanostack — updates, signing, and going proprietary

Fork-side operational doc, sibling to `RUNBOOK.md` (upstream syncs) and
`.agents/books_production_signoff.md` (books readiness). Facts verified 2026-09-30.

## 1. Two kinds of "update" — never confuse them

- **Code updates (upstream sync)**: follow `fork/RUNBOOK.md`. Pull upstream, merge into
  `product`, `node fork/rebrand-sweep.mjs` re-applies the white label, verify, push `origin`
  only — NEVER push to `upstream` (genspark-ai/genoffice). The app itself never touches git.
- **App updates for installed users**: the app ships with electron-updater
  (`apps/shell/src/main/updater.ts`) but it is **inert unless the installer was built with
  `GENOFFICE_UPDATE_URL` set** (`apps/shell/electron-builder.cjs:46`, publish config at
  `:758-766`, generic provider). Local builds have no feed baked in, so the in-app update
  check can never fetch anything — which is the safe default.
  **Never point `GENOFFICE_UPDATE_URL` at the upstream repo's releases**: in-app updates would
  install upstream's un-branded build over Zanostack. Point it at your own releases only.

## 2. Delivering a new version today (what we actually do)

1. `npm run dist:win` from the repo root (chains notices + full build + NSIS packaging;
   ~7 min; unsigned local build per `electron-builder.cjs:736-738`).
2. Ship `apps/shell/release/Zanostack Setup <version>.exe` (+ its `.blockmap`) — hand the
   installer to people or host it yourself.
3. Installing over an existing install is safe: user data lives **outside** the app
   (books ledger: `%APPDATA%\Zanostack\books\books-data.json`, with `.bak` sibling and
   `backups/`), so reinstalls and updates never touch it.
4. Version lives in `apps/shell/package.json` (0.11.0 as of 2026-09-30). Bump it per
   release so installer filenames and in-app `app.status` stay distinguishable.
5. Windows SmartScreen shows "unknown publisher" once per machine for unsigned builds —
   "More info → Run anyway". Expected for self-built apps.

## 3. Code signing — what's free, what isn't

- **Free, built in**: `GENOFFICE_WIN_SIGN_MODE=test` → self-signed PFX via
  `scripts/win-sign.cjs` (contract documented at `electron-builder.cjs:725-742`). Helps on
  machines with strict child-process policies (unsigned sidecars died with `spawn UNKNOWN`
  there), but does **not** remove the "unknown publisher" warning for your users.
- **Real signing (removes the warning) is never free** — since 2023 all genuine certs live on
  hardware/cloud tokens. Cheapest routes, verified 2026-09-30:
  - Microsoft **Artifact Signing** (formerly Azure Trusted Signing): managed, Basic tier
    historically ~US$10/month; check current pricing and individual-developer availability.
  - Individual certificates (Certum / SSL.com / Sectigo): roughly US$70–300/year.
  - **DigiCert KeyLocker** is already wired as the `production` mode of
    `scripts/win-sign.cjs` — buying the cert is the only remaining step for that route.
- Even with a paid certificate, SmartScreen reputation builds with download volume; the
  warning is not instant magic for a brand-new file.
- Recommendation: stay unsigned (or `test` mode) while testing; buy the cheapest managed
  signing when distributing publicly.

## 4. In-app auto-updates for end users (when ready)

1. Choose a HTTPS URL you control that can host three files per release: the installer
   `.exe`, the `.blockmap`, and electron-builder's generated `latest.yml`.
2. Build with `GENOFFICE_UPDATE_URL=https://your-url` set — the app then checks that feed,
   asks the user before downloading (`autoDownload: false`), and installs on quit
   (`autoInstallOnAppQuit: true`; `updater.ts:616-619`). `allowDowngrade: false`.
3. Hosting notes: GitHub Releases on a **public** repo works as a generic feed; a **private**
   repo's release assets require authenticated downloads that a generic feed can't provide —
   host on your own server/object storage instead.
4. Release flow once wired: bump version → `dist:win` → upload the three files → every
   installed user is offered the update on their next launch.

## 5. Going proprietary (later)

- The GitHub fork (`brantenK/genoffice`) is **public today**, white label included. The
  installer contains no source, but making the product proprietary means making the fork
  private (and not publishing the `product` branch).
- **Licensing machinery does not exist yet.** The `ee/` directory is the reserved home
  ("private deployment and offline license verification" per its README). Design sketch for
  later: offline-signed license keys + an activation gate, enforced server-side if/when AI
  is sold through your own gateway.
- AI is **fully BYOK** today (keys pasted by users in Settings, stored in
  `userData/ai-settings.json`, traffic direct to providers) — nothing of yours is exposed,
  and no baked keys exist anywhere (audited 2026-09-30).
- Check the upstream repo's license before commercializing — this is a fork of a public
  project and its terms govern what you may do.

## 6. Data-safety facts worth repeating to users

- Books data: `%APPDATA%\Zanostack\books\books-data.json` (atomic writes, `.bak` sibling,
  `backups/` rotation, restore safety copies). Survives updates and reinstalls.
- Backups are manual — "Backup Now" is the only `books-backup-*.json` producer.
- Never run an older build over data written by a newer one: newer schema versions are
  refused by older builds (safely, with an error — never corruption).
