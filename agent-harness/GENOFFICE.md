# GenOffice Harness SOP — Frozen Reduced V1

This tracked document is the release-facing authority for the Python harness.
The harness is a transport client for the real GenOffice Electron shell; it does
not implement editor behavior, write GenOffice stores, use CDP/Node inspector,
or run `npm run dev` as a fallback.

## V1 boundary

Supported commands are only:

- `app start`, `app status`
- `tabs list`, `tabs activate`
- `files open`, `files recent`
- `screenshots capture [--tab TAB_ID] [--name NAME]`

`files open` accepts only a canonical regular `.docx` fixture below the private
session `input/` directory. Tab close and protocol shutdown are not exposed.
`tabs open`, document creation, Markdown, Docs mutation, exports, business mutation,
Sheets, generic IPC, JavaScript execution, force/discard controls, CDP, and the
Node inspector are not V1 capabilities. Markdown/Tiptap automation is deferred
until its tracked Gate 3 security/adapter decision is complete.

## Launch targets

The launcher never infers a checkout from the installed package. Select one
explicit target:

```powershell
# Packaged executable
cli-anything-genoffice --json app start --app-path 'C:\built\GenOffice.exe'

# Source-built shell: both values are required
cli-anything-genoffice --json app start `
  --electron-path 'C:\repo\node_modules\electron\dist\electron.exe' `
  --app-dir 'C:\repo\apps\shell'
```

There is no npm/dev fallback. The child receives a strict sanitized environment
and only the automation switches in addition to the explicit launch target.
Renderer URLs, test hooks, debug/inspector/Node controls, and arbitrary
`GENOFFICE_*` controls are removed.

The isolated source-runtime E2E lane has passed once; future E2E runs accept exactly one of these target configurations:
`GENOFFICE_PACKAGED_APP`, or both `GENOFFICE_ELECTRON_PATH` and
`GENOFFICE_SHELL_APP_DIR`. Its test-owned supervisor retains the production
Launcher child handle and reaps only after identity reattestation; this is test
cleanup infrastructure, not a public shutdown command.

## Private session contract

Session roots are random exclusive directories below
`%LOCALAPPDATA%\GenOffice\agent-sessions` on Windows, or the platform-safe
per-user application-data equivalent elsewhere. Each root owns:

`launch.json`, `session.lock`, `input/`, `output/`, and `user-data/` before
startup. `endpoint.json` is published by Electron only after readiness;
`session.json` is persisted only after endpoint/process validation.

Windows roots are protected with the current numeric SID using the trusted
System32 `icacls.exe`, inheritance is disabled, and the resulting owner/DACL is
verified. UNC, device, reparse-point, traversal, and root-substitution paths
fail closed. The lifecycle lock spans session check, root setup, launch record,
spawn, endpoint/process validation, persistence, and request. Only a verified
child reap exists for test cleanup; no graceful shutdown command is exposed.
Session JSON stores process identity and endpoint metadata path, never the
bearer token.

## JSON and REPL operation

Use `--json` globally or after a leaf command. Every parser, usage, protocol,
and expected harness failure emits exactly one JSON object on stdout; human
diagnostics go to stderr. Inspect `ok`, `error.code`, `error.message`, and
`requestId`.

No-argument invocation starts the ReplSkin-backed stateful REPL. A selected
`--session` is carried into every REPL command. The vendored ReplSkin source is
Apache-2.0 licensed; see `THIRD_PARTY_NOTICES.md` and the package license file.

Screenshot coverage is limited to the typed `screenshots.capture` operation:
the client validates tab IDs and PNG names, omits absent payload keys, and
returns the shell's safe `{path, tabId, name, width, height}` result.
