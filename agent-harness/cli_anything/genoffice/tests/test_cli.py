import json
import os
import shutil
import subprocess
import sys

from click.testing import CliRunner

import cli_anything.genoffice.genoffice_cli as cli_module
from cli_anything.genoffice.genoffice_cli import cli


def _resolve_cli(name):
    """Resolve installed CLI command; falls back to python -m for dev."""
    force = os.environ.get("CLI_ANYTHING_FORCE_INSTALLED", "").strip() == "1"
    path = shutil.which(name)
    if path:
        print(f"[_resolve_cli] Using installed command: {path}")
        return [path]
    if force:
        raise RuntimeError(f"{name} not found in PATH. Install with: pip install -e .")
    module = name.replace("cli-anything-", "cli_anything.") + "." + name.split("-")[-1] + "_cli"
    print(f"[_resolve_cli] Falling back to: {sys.executable} -m {module}")
    return [sys.executable, "-m", module]


def test_help_and_json_option():
    runner = CliRunner()
    result = runner.invoke(cli, ["--help"])
    assert result.exit_code == 0
    assert "tabs" in result.output
    result = runner.invoke(cli, ["--json", "app", "status"])
    assert result.exit_code != 0
    assert json.loads(result.output)["ok"] is False


def test_bare_json_is_usage_error_and_not_repl():
    result = CliRunner().invoke(cli, ["--json"])
    assert result.exit_code != 0
    assert result.output.count("\n") == 1
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["error"]["code"] == "CLI_USAGE"


def test_only_v1_commands_are_exposed():
    runner = CliRunner()
    result = runner.invoke(cli, ["--help"])
    for forbidden in ("ipc", "eval", "execute", "mutate"):
        assert forbidden not in result.output
    assert "tabs open" not in result.output
    assert "document" not in result.output


def test_leaf_parser_failure_is_exactly_one_json_object():
    result = CliRunner().invoke(cli, ["--json", "tabs", "activate"])
    assert result.exit_code != 0
    assert result.output.count("\n") == 1
    assert json.loads(result.output)["error"]["code"] == "CLI_USAGE"


def test_files_open_requires_the_private_input_root():
    result = CliRunner().invoke(cli, ["--json", "files", "open", "fixture.docx"])
    assert result.exit_code != 0
    data = json.loads(result.output)
    assert data["ok"] is False
    assert data["error"]["code"] in {"SESSION_NOT_RUNNING", "FILE_UNSAFE"}


def test_repl_preserves_selected_session(monkeypatch, tmp_path):
    import cli_anything.genoffice.genoffice_cli as module
    seen = []

    class FakeSkin:
        def __init__(self, *_args, **_kwargs):
            self.lines = iter(["app status", "quit"])
        def print_banner(self):
            pass
        def create_prompt_session(self):
            return None
        def get_input(self, _session):
            return next(self.lines)
        def print_goodbye(self):
            pass
        def error(self, _message):
            pass
        def help(self, _commands):
            pass

    original = module.cli.main
    def capture(*, args, **kwargs):
        seen.append(args)
    monkeypatch.setattr(module, "ReplSkin", FakeSkin)
    monkeypatch.setattr(module.cli, "main", capture)
    try:
        module._repl(type("Context", (), {"find_root": lambda self: type("Root", (), {"params": {"session_path": tmp_path / "selected"}})()})())
    finally:
        monkeypatch.setattr(module.cli, "main", original)
    assert seen == [["--session", str(tmp_path / "selected"), "app", "status"]]


def test_unknown_command_is_one_json_error():
    result = CliRunner().invoke(cli, ["--json", "not-a-command"])
    assert result.exit_code != 0
    assert json.loads(result.output)["ok"] is False


def test_installed_subprocess_helper_is_used():
    assert _resolve_cli("cli-anything-genoffice")


def test_installed_subprocess_help_has_no_cwd_dependency():
    command = _resolve_cli("cli-anything-genoffice")
    result = subprocess.run(command + ["--help"], capture_output=True, text=True, check=False)
    assert result.returncode == 0
    assert "GenOffice" in result.stdout


def test_installed_subprocess_json_status():
    command = _resolve_cli("cli-anything-genoffice")
    result = subprocess.run(command + ["--json", "app", "status"], capture_output=True, text=True, check=False)
    assert result.returncode != 0
    assert json.loads(result.stdout)["ok"] is False


def test_screenshots_capture_json_contract_and_payload(monkeypatch):
    seen = []

    class FakeLauncher:
        def __init__(self, **_kwargs):
            pass

        def request(self, command, payload):
            seen.append((command, payload))
            return {
                "path": "C:/session/output/capture.png",
                "tabId": payload.get("tabId", "home"),
                "name": payload.get("name", "capture.png"),
                "width": 1280,
                "height": 720,
            }

    monkeypatch.setattr(cli_module, "Launcher", FakeLauncher)
    result = CliRunner().invoke(
        cli,
        ["--json", "screenshots", "capture", "--tab", "crm_1", "--name", "CRM-shot.PNG"],
    )
    assert result.exit_code == 0, result.output
    data = json.loads(result.output)
    assert data == {
        "ok": True,
        "result": {
            "path": "C:/session/output/capture.png",
            "tabId": "crm_1",
            "name": "CRM-shot.PNG",
            "width": 1280,
            "height": 720,
        },
    }
    assert seen == [("screenshots.capture", {"tabId": "crm_1", "name": "CRM-shot.PNG"})]

    result = CliRunner().invoke(cli, ["--json", "screenshots", "capture"])
    assert result.exit_code == 0, result.output
    assert seen[-1] == ("screenshots.capture", {})


def test_screenshots_capture_rejects_invalid_name_and_tab_before_transport(monkeypatch):
    calls = []

    class FakeLauncher:
        def __init__(self, **_kwargs):
            pass

        def request(self, command, payload):
            calls.append((command, payload))
            return {}

    monkeypatch.setattr(cli_module, "Launcher", FakeLauncher)
    for args, code in [
        (["--name", "capture.jpg"], "SCREENSHOT_NAME_INVALID"),
        (["--tab", "bad/tab"], "SCREENSHOT_TAB_INVALID"),
    ]:
        result = CliRunner().invoke(cli, ["--json", "screenshots", "capture", *args])
        assert result.exit_code != 0
        data = json.loads(result.output)
        assert data["ok"] is False
        assert data["error"]["code"] == code
    assert calls == []
