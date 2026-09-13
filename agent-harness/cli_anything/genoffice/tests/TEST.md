# cli-anything-genoffice — current bounded validation record

## Scope and status

The tracked `agent-harness/GENOFFICE.md` is the release-facing authority. The
current reduced non-Electron V1 surface is:

```text
app start
app status
tabs list
tabs activate TAB_ID
files open DOCX_PATH
files recent
screenshots capture [--tab TAB_ID] [--name NAME]
```

There is no protocol shutdown, tab close, editor/document mutation, Markdown,
Docs creation, export, business operation, force/discard action, CDP, or Node
inspector capability. Markdown/Tiptap automation remains deferred.

`test_full_e2e.py` exists as the approved isolated real-Electron test. Its
real-shell case is explicitly gated and skips when the configured target lane
is absent; broader release and coverage claims remain out of scope.

## Current test inventory

The current non-Electron inventory contains exactly these files:

| File                               | Status and purpose                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `test_core.py`                     | Executed; session, protocol, secret, and launcher fundamentals.                                            |
| `test_remediation.py`              | Executed; Windows ACL/BOOL ABI, roots, reparse safety, locks, identity, targets, environment, and cleanup. |
| `test_supervisor.py`               | Executed; owned-child supervision, identity refusal, and residual-cleanup failure.                         |
| `test_cli.py`                      | Executed; reduced CLI, JSON contracts, installed subprocesses, DOCX input, and REPL session behavior.      |
| `test_protocol_integration.py`     | Executed; request IDs, structured failures, and unauthorized responses.                                    |
| `test_cross_language_bootstrap.py` | Executed; real Python-to-TypeScript no-Electron bootstrap matrix.                                          |

The latest local run contains 52 passed tests and 1 skipped real-shell test;
the skip is the explicitly gated `test_full_e2e.py` target lane.

## TDD history

### Initial RED gates

- The remediation tests initially failed during collection because the required
  security, target, and process-identity APIs were absent.
- The Windows BOOL regression was deliberately run with a temporary one-byte
  `ctypes.c_bool` declaration and failed with `sizeof(...) == 1` instead of 4.
- The bare JSON regression initially entered the ReplSkin path and emitted
  banner output rather than one JSON usage object.
- The supervisor residual-root regression initially returned successfully even
  when the validated root remained after cleanup.

### GREEN corrections

- `WindowsBOOL = ctypes.c_int32` is now used for all Win32 BOOL return values
  and LPBOOL storage in `security.py`; the real owner/DACL attestation passes.
- Bare `--json` now emits one `CLI_USAGE` JSON object and exits with status 2.
- Supervisor cleanup now raises on a remaining validated session root or
  selector after process termination and artifact cleanup.

## Canonical executed validation

| Layer                 | Command/evidence                                                       | Result                                                    |
| --------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| Editable install      | `python -m pip install -e .`                                           | Passed; `cli-anything-genoffice-0.1.0` installed.         |
| Python installed lane | Force-installed suite across the six current non-Electron test files   | **48 passed in 6.09s**.                                   |
| Bootstrap             | Included in the installed suite; nine real Python→TypeScript scenarios | **9 passed**; no fake endpoint JSON.                      |
| Bare JSON             | Installed command outside pytest: `cli-anything-genoffice --json`      | Passed; exactly one `CLI_USAGE` JSON object, exit code 2. |
| Shell focused suite   | Orchestrator result                                                    | **11 tests passed**.                                      |
| Shell typecheck       | Orchestrator result                                                    | Passed.                                                   |

The installed subprocess checks used `CLI_ANYTHING_FORCE_INSTALLED=1`, resolved
`_resolve_cli("cli-anything-genoffice")` from `PATH`, and did not set `cwd`.

The bootstrap matrix used the repo-local TypeScript helper and real production
mode/server publication with Python-created and ACL-attested roots. Scenarios
covered happy path, endpoint preexistence, replay, schema mismatch, ID
mismatch, metadata session substitution, metadata PID substitution, invalid
ACL, and reparse-path rejection.

Windows evidence includes current-SID retrieval, pointer-safe process identity,
`GetSystemDirectoryW`-derived `System32\icacls.exe`, owner/DACL/ACE attestation,
and the corrected 4-byte BOOL ABI. The vendored ReplSkin remains byte-identical
to pinned commit `0ab6b0931e121b997f0924c7972d9df51f850de6` with SHA-256
`F84F0FF681853A16E669A412C02CE26597810A1A46DD61C5AA4557C22512E6CF`.

## Phase 6 executed result

The final command was run from `agent-harness` with this redacted environment:

```text
CLI_ANYTHING_FORCE_INSTALLED=1
GENOFFICE_REAL_E2E=1
GENOFFICE_ELECTRON_PATH=<repo>\node_modules\electron\dist\electron.exe
GENOFFICE_SHELL_APP_DIR=<repo>\apps\shell
GENOFFICE_PACKAGED_APP=<unset>
```

Command:

```text
python -m pytest cli_anything/genoffice/tests -v --tb=no -s
```

Result: **50 passed in 7.70s**. The installed CLI resolved
`cli-anything-genoffice.EXE` from `PATH`. The supervised source-runtime E2E
started the configured Electron shell, ran installed `app status --json` and
`tabs list --json` from a neutral parent directory without subprocess `cwd`,
and completed supervisor cleanup.

### Full named-test transcript

```text
test_core.py::test_launch_record_is_explicit_and_secret_free PASSED
test_core.py::test_launcher_never_substitutes_root_dev_command PASSED
test_core.py::test_launcher_arguments_are_only_automation_switches PASSED
test_core.py::test_endpoint_rejects_non_loopback PASSED
test_core.py::test_protocol_client_sends_bearer_and_command PASSED
test_core.py::test_session_save_is_valid_and_never_persists_token PASSED
test_core.py::test_session_update_is_atomic_and_lock_released_on_error PASSED
test_core.py::test_stale_pid_is_detected PASSED
test_remediation.py::test_session_root_has_required_layout_and_is_not_temp PASSED
test_remediation.py::test_session_root_rejects_unsafe_paths PASSED
test_remediation.py::test_launch_record_is_exact_frozen_schema PASSED
test_remediation.py::test_launch_record_is_not_accepted_as_endpoint PASSED
test_remediation.py::test_poisoned_environment_is_removed PASSED
test_remediation.py::test_launch_targets_require_explicit_inputs PASSED
test_remediation.py::test_process_identity_rejects_pid_reuse PASSED
test_remediation.py::test_current_process_identity_uses_pointer_safe_apis PASSED
test_remediation.py::test_session_store_has_lifecycle_lock_context PASSED
test_remediation.py::test_competing_lifecycle_operation_times_out PASSED
test_remediation.py::test_session_substitution_cannot_attach_by_pid_only PASSED
test_remediation.py::test_spawn_failure_cleans_private_root PASSED
test_remediation.py::test_windows_root_has_current_user_only_acl PASSED
test_remediation.py::test_windows_bool_abi_and_real_owner_dacl_attestation PASSED
test_supervisor.py::test_target_from_environment_requires_one_explicit_mode PASSED
test_supervisor.py::test_supervisor_cleanup_reaps_only_verified_owned_child PASSED
test_supervisor.py::test_supervisor_does_not_kill_identity_mismatch PASSED
test_supervisor.py::test_supervisor_fails_if_root_remains_after_cleanup PASSED
test_cli.py::test_help_and_json_option PASSED
test_cli.py::test_bare_json_is_usage_error_and_not_repl PASSED
test_cli.py::test_only_v1_commands_are_exposed PASSED
test_cli.py::test_leaf_parser_failure_is_exactly_one_json_object PASSED
test_cli.py::test_files_open_requires_the_private_input_root PASSED
test_cli.py::test_repl_preserves_selected_session PASSED
test_cli.py::test_unknown_command_is_one_json_error PASSED
test_cli.py::test_installed_subprocess_helper_is_used PASSED
test_cli.py::test_installed_subprocess_help_has_no_cwd_dependency PASSED
test_cli.py::test_installed_subprocess_json_status PASSED
test_protocol_integration.py::test_structured_protocol_error_is_mapped PASSED
test_protocol_integration.py::test_response_request_id_mismatch_is_rejected PASSED
test_protocol_integration.py::test_unauthorized_pre_dispatch_error_is_typed PASSED
test_cross_language_bootstrap.py::test_real_cross_language_bootstrap_preflight[happy] PASSED
test_cross_language_bootstrap.py::test_real_cross_language_bootstrap_preflight[endpoint-preexistence] PASSED
test_cross_language_bootstrap.py::test_real_cross_language_bootstrap_preflight[replay] PASSED
test_cross_language_bootstrap.py::test_real_cross_language_bootstrap_preflight[schema-mismatch] PASSED
test_cross_language_bootstrap.py::test_real_cross_language_bootstrap_preflight[id-mismatch] PASSED
test_cross_language_bootstrap.py::test_real_cross_language_bootstrap_preflight[metadata-session-substitution] PASSED
test_cross_language_bootstrap.py::test_real_cross_language_bootstrap_preflight[metadata-pid-substitution] PASSED
test_cross_language_bootstrap.py::test_real_cross_language_bootstrap_preflight[invalid-acl] PASSED
test_cross_language_bootstrap.py::test_real_cross_language_bootstrap_preflight[reparse-path] PASSED
test_full_e2e.py::test_e2e_subprocess_uses_scoped_parent_directory_without_cwd PASSED
test_full_e2e.py::test_real_built_shell_e2e_is_explicitly_post_shell_lane PASSED
```

### E2E isolation and cleanup evidence

The E2E used the source-runtime target only; no packaged-target E2E was run.
The test-owned supervisor retained the production Launcher child, revalidated
identity, verified terminal child exit, and removed endpoint, session, selector,
and session-root artifacts. After completion, only the global idle
`lifecycle.lock` remained under `%LOCALAPPDATA%\GenOffice\agent-sessions`.

## Screenshots capture validation

Executed from `agent-harness/cli_anything/genoffice`:

```text
python -m pytest tests/ -q
```

Result: **52 passed, 1 skipped in 4.40s**. The run covered the JSON success
payload, omission of absent `tabId`/`name`, exact client-side name and tab-ID
validation, and authenticated transport forwarding for `screenshots.capture`.

The real-shell capture-after-activate workflow was **blocked/skipped** because
`GENOFFICE_REAL_E2E=1` and `CLI_ANYTHING_FORCE_INSTALLED=1` were not configured,
and no explicit packaged or source shell target was present. It was not run
against a fake replacement app. To execute it, use the existing explicit target
environment and installed CLI requirements documented above.

## Remaining limitations

This is not full release approval. No coverage percentage has been measured,
no packaged-target E2E has been executed, no broader V1/release approval has
been granted, and no claim is made for deferred editor/business capabilities.
The shell focused evidence remains 10 tests passed with typecheck passed.
