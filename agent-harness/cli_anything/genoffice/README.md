# cli-anything-genoffice

Python transport harness for a real GenOffice Electron shell. Install from
`agent-harness` with `python -m pip install -e .`.

## Frozen reduced V1

```text
app start|status
tabs list|activate TAB_ID
files open PATH|recent
screenshots capture [--tab TAB_ID] [--name NAME]
```

`files open` accepts only a regular canonical `.docx` inside the private
session `input/` directory. There is intentionally no `tabs open`,
`document create`, Markdown, Docs mutation, export, generic IPC, business
mutation, force-close, CDP, or inspector command. Markdown/Tiptap automation is
deferred pending the tracked Gate 3 decision.

## Launch and state

Choose a real launch target explicitly:

```powershell
cli-anything-genoffice --json app start --app-path C:\built\GenOffice.exe
cli-anything-genoffice --json app start --electron-path C:\electron.exe --app-dir C:\repo\apps\shell
```

The harness never discovers a repository from site-packages and never uses
`npm run dev`. Session roots are private random directories under the per-user
application-data session base. On Windows they receive a verified current-user
SID DACL through trusted `System32\icacls.exe`; unsafe/reparse/UNC/device paths
are rejected. Session JSON is atomically written under lifecycle locking and
contains PID/process identity and metadata paths, never the bearer token.

The pending E2E test accepts either `GENOFFICE_PACKAGED_APP`, or the pair
`GENOFFICE_ELECTRON_PATH` and `GENOFFICE_SHELL_APP_DIR`. A test-owned supervisor
retains and verifies the production Launcher child handle for teardown; this is
not exposed as a CLI shutdown operation.

## Screenshots

Capture a PNG from an open shell page. The optional tab ID and output name are
validated before transport; names must end in `.png` and contain only safe ASCII
filename characters.

```powershell
cli-anything-genoffice --json screenshots capture --tab crm --name crm-page.png
```

The result contains `path`, `tabId`, `name`, `width`, and `height`.

## Agent contract

Put `--json` before a command, or after a leaf command. Success and failure each
produce exactly one JSON object on stdout. On failure, use `error.code` and
`requestId`; there is no protocol shutdown command. Human diagnostics are on stderr.
The no-argument invocation starts a stateful ReplSkin REPL and preserves the
selected `--session` for all commands.

See `GENOFFICE.md`, `skills/SKILL.md`, and `tests/TEST.md` for the SOP, agent
examples, and planned versus executed validation.
