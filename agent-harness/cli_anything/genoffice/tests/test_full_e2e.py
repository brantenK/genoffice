import json
import os
import shutil
import subprocess
import sys
from contextlib import contextmanager

import pytest

from cli_anything.genoffice.core.supervisor import E2ESupervisor, target_from_environment


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


@contextmanager
def _neutral_directory(path):
    previous = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def _run(command, args):
    result = subprocess.run(command + args, capture_output=True, text=True, check=False)
    assert result.stdout, result.stderr
    return result, json.loads(result.stdout)


def test_e2e_subprocess_uses_scoped_parent_directory_without_cwd(monkeypatch, tmp_path):
    seen = {}

    class Result:
        returncode = 0
        stdout = '{"ok": true}'
        stderr = ""

    def fake_run(command, **kwargs):
        seen["command"] = command
        seen["kwargs"] = kwargs
        return Result()

    monkeypatch.setattr(subprocess, "run", fake_run)
    neutral = tmp_path / "neutral"
    neutral.mkdir()
    previous = os.getcwd()
    with _neutral_directory(neutral):
        _, data = _run(["cli-anything-genoffice"], ["--json", "app", "status"])
        assert os.getcwd() == str(neutral)
    assert os.getcwd() == previous
    assert "cwd" not in seen["kwargs"]
    assert data["ok"] is True


def test_real_built_shell_e2e_is_explicitly_post_shell_lane(tmp_path):
    """Run only against the real built shell; never replace it with a fake app."""
    if os.environ.get("GENOFFICE_REAL_E2E") != "1":
        pytest.fail(
            "Blocked on post-shell integration lane: build the real Electron shell, "
            "install this package, set GENOFFICE_REAL_E2E=1, then run this real-app test."
        )
    if os.environ.get("CLI_ANYTHING_FORCE_INSTALLED") != "1":
        pytest.fail("Set CLI_ANYTHING_FORCE_INSTALLED=1 for the installed real-app lane")
    try:
        target = target_from_environment()
    except Exception as error:
        pytest.fail(str(error))
    command = _resolve_cli("cli-anything-genoffice")
    session = str(tmp_path / "selector")
    neutral = tmp_path / "neutral"
    neutral.mkdir()
    supervisor = E2ESupervisor(session_path=session, **target)
    started = False
    try:
        state = supervisor.start()
        assert state["state"] == "running"
        started = True
        with _neutral_directory(neutral):
            _, status = _run(command, ["--json", "--session", session, "app", "status"])
        assert status["ok"] is True
        with _neutral_directory(neutral):
            _, tabs = _run(command, ["--json", "--session", session, "tabs", "list"])
        assert tabs["ok"] is True
    finally:
        if started:
            supervisor.cleanup()
