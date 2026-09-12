---
name: 'cli-anything-genoffice'
description: 'Control a real GenOffice Electron shell through a private authenticated loopback API.'
---

# GenOffice CLI skill — frozen reduced V1

Install from `agent-harness` with `python -m pip install -e .`. A real built or
packaged shell is required. Select it explicitly:

```text
cli-anything-genoffice --json app start --app-path C:\\built\\GenOffice.exe
cli-anything-genoffice --json app start --electron-path C:\\electron.exe --app-dir C:\\repo\\apps\\shell
```

The harness does not infer a checkout from site-packages and never falls back to
`npm run dev`.

## Commands

```text
app start|status
tabs list
tabs activate TAB_ID
files open DOCX_PATH
files recent
```

`files open` accepts only a canonical regular `.docx` below the private session
`input/` directory. V1 has no `tabs open`, document creation, Markdown, Docs
mutation, export, business mutation, Sheets, generic IPC, JavaScript, force
close, CDP, or inspector command. Markdown/Tiptap automation is deferred until
the tracked Gate 3 decision.

## JSON and safety

Use `--json` globally or after a leaf command. Every success, parser failure,
usage failure, protocol failure, and expected harness failure emits exactly one
JSON object on stdout. Parse `ok`; on failure inspect `error.code`,
`error.message`, and `requestId`. Diagnostics go to stderr.

Session roots are random exclusive per-user application-data directories. On
Windows the root DACL is created and verified with the current numeric SID and
trusted `System32\\icacls.exe`; no temp, UNC, device, reparse, or unauthenticated
fallback is allowed. The endpoint must be `127.0.0.1` and `POST /v1/command`.
Session state persists process identity and metadata paths but never the bearer
token. A selected `--session` is preserved through the stateful default REPL.
The pending E2E lane uses either `GENOFFICE_PACKAGED_APP`, or both
`GENOFFICE_ELECTRON_PATH` and `GENOFFICE_SHELL_APP_DIR`; its supervisor is
test-only child cleanup and is not a CLI shutdown feature.
