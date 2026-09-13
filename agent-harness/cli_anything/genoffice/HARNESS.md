# GenOffice CLI Harness Standards

## Purpose and boundary

`cli-anything-genoffice` is a Python transport client for the real GenOffice
Electron shell. It never emulates editor behaviour, discovers a repository from
an installed package, starts a development server, invokes generic IPC, uses
CDP or the Node inspector, or exposes arbitrary JavaScript execution.

The shell owns every product operation. The Python package owns only CLI parsing,
the authenticated loopback transport, session selection, launch validation, and
safe client-side path validation.

## Architecture

- The Click entry point is `genoffice_cli.py`; leaf commands delegate to
  `Launcher.request(command, payload)`.
- Core lifecycle, protocol, process identity, session, and filesystem safety
  code lives in `core/`. Do not put Electron behaviour in the Python CLI.
- Electron's typed allowlist is declared in
  `apps/shell/src/shared/automation-api.ts` and enforced by
  `apps/shell/src/main/automation-dispatcher.ts`.
- Electron adapters belong in `apps/shell/src/main/index.ts` and must use
  product-owned APIs rather than test-only hooks.
- The protocol is loopback-only, bearer-token authenticated, request-ID based,
  and serialized by the dispatcher.

## CLI and output contract

- Use Click groups and leaf commands. Keep help text aligned with the real,
  supported automation surface.
- Every command supports global `--json`; leaf-local `--json` is hidden only to
  preserve the established `command --json` compatibility pattern.
- JSON success is exactly one stdout object:
  `{"ok": true, "result": ...}`. Expected failures are exactly one stdout
  object with `ok: false` and a stable `error.code`; human diagnostics go to
  stderr.
- Parser and usage failures must obey the same one-object JSON contract.
- The no-argument REPL uses `ReplSkin`; add every supported command to its help
  map and preserve the selected session when dispatching a REPL line.

## Session, launch, and filesystem safety

- A caller must supply either a packaged `--app-path`, or both
  `--electron-path` and `--app-dir`. Never add repository inference or an
  `npm run dev` fallback.
- Session roots are private random directories. The lifecycle lock covers
  session lookup, launch, endpoint/process validation, persistence, and each
  request. Session JSON never contains the bearer token.
- Treat all user-supplied paths as hostile. Reject UNC, device, traversal,
  NUL-containing, reparse-point, symlink, and unsafe root-substitution paths.
- Inputs may only be read from the session `input/` root; generated artifacts
  may only be written to the session `output/` root. Validate the path before
  use and enforce the same policy again in Electron immediately before the
  operation.
- Automation mode uses a sanitized environment. Never revive debug, renderer
  URL, test-hook, inspector, or arbitrary `GENOFFICE_*` controls.
- Do not add a public shutdown, force-close, generic IPC, `eval`, or raw browser
  control command.

## Extending the typed automation surface

For every new observable operation, change all of the following together:

1. Add the exact command name, payload, result contract, and error behaviour to
   `automation-api.ts`.
2. Add it to the dispatcher allowlist and validate an exact, minimal payload.
3. Implement a narrow Electron adapter using product APIs and enforce output
   safety immediately before side effects.
4. Add the Python Click command, `--json` handling, and any client-side
   validation in the existing `Launcher`/`core` pattern.
5. Update REPL help, `README.md`, `tests/TEST.md`, and
   `agent-harness/GENOFFICE.md`.

Do not widen one command to carry generic selectors, arbitrary file paths,
arbitrary browser options, or arbitrary JavaScript. New capabilities must be
explicit, least-privilege protocol operations.

## Tests and validation

- Add Python unit coverage in `tests/test_core.py` for client-side validation
  and transport behaviour.
- Add CLI contract coverage in `tests/test_cli.py` and subprocess/workflow
  coverage in `tests/test_full_e2e.py` where appropriate.
- Add shell dispatcher tests in `apps/shell/tests/automation-dispatcher.test.ts`
  for success, malformed payloads, unsafe paths, and rejected commands.
- Preserve the existing real-built-shell E2E boundary: it runs only when its
  explicit target environment is configured, never against a fake replacement
  app.
- Run the narrow Python and shell test targets first, then record the exact
  executed and blocked validation in `tests/TEST.md`.

## Existing V1 surface

The current public commands are `app start`, `app status`, `tabs list`,
`tabs activate`, `files open`, and `files recent`. `files open` accepts only a
canonical regular `.docx` beneath the private session `input/` directory.
Existing commands are additive-only: do not remove or weaken them while adding
new coverage.
