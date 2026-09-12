import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from cli_anything.genoffice.core.errors import HarnessError, ProtocolError
from cli_anything.genoffice.core.launcher import LaunchTarget, Launcher, build_launch_record, create_session_root, sanitize_environment
from cli_anything.genoffice.core.process_identity import ProcessIdentity, capture_process_identity, identity_is_live
from cli_anything.genoffice.core.protocol import endpoint_from_metadata
from cli_anything.genoffice.core.session import SessionStore, validate_safe_path


def test_session_root_has_required_layout_and_is_not_temp(tmp_path, monkeypatch):
    local_app_data = tmp_path / "LocalAppData"
    monkeypatch.setenv("LOCALAPPDATA", str(local_app_data))
    root = create_session_root()
    assert root.parent == local_app_data / "GenOffice" / "agent-sessions"
    assert root != Path(os.getenv("TEMP", ""))
    assert {p.name for p in root.iterdir()} >= {"input", "output", "user-data"}
    assert (root / "launch.json").is_file()
    assert (root / "session.lock").is_file()


def test_session_root_rejects_unsafe_paths(tmp_path):
    for value in (r"\\server\share\x", r"\\.\PIPE\x", r"\\?\C:\x"):
        with pytest.raises(HarnessError):
            validate_safe_path(Path(value), tmp_path)


def test_launch_record_is_exact_frozen_schema(tmp_path):
    root = tmp_path / "session"
    root.mkdir()
    record = build_launch_record(root)
    assert set(record) == {
        "protocolVersion", "sessionId", "nonce", "createdAt", "expiresAt",
        "rendezvousPath", "sessionRoot", "userDataPath", "inputRoot", "outputRoot",
    }
    assert record["rendezvousPath"] == str(root / "launch.json")
    assert record["sessionRoot"] == str(root)


def test_launch_record_is_not_accepted_as_endpoint(tmp_path):
    record = build_launch_record(tmp_path)
    (tmp_path / "launch.json").write_text(json.dumps(record), encoding="utf-8")
    with pytest.raises(ProtocolError):
        endpoint_from_metadata(tmp_path / "launch.json")


def test_poisoned_environment_is_removed():
    env = sanitize_environment({
        "PATH": "safe", "SystemRoot": r"C:\Windows", "NODE_OPTIONS": "--inspect",
        "ELECTRON_RUN_AS_NODE": "1", "GENOFFICE_RENDERER_URL": "http://evil",
        "PLAYWRIGHT_TEST": "1", "SCREENSHOT_DIR": "evil", "GENOFFICE_USER_DATA": "evil",
    })
    assert env["PATH"] == "safe"
    assert "NODE_OPTIONS" not in env
    assert "ELECTRON_RUN_AS_NODE" not in env
    assert not any(key.startswith("GENOFFICE_") for key in env)
    assert "PLAYWRIGHT_TEST" not in env


def test_launch_targets_require_explicit_inputs(tmp_path):
    executable = tmp_path / "GenOffice.exe"
    electron = tmp_path / "electron.exe"
    app_dir = tmp_path / "shell"
    executable.touch()
    electron.touch()
    app_dir.mkdir()
    (app_dir / "package.json").write_text("{}", encoding="utf-8")
    (app_dir / "out" / "main").mkdir(parents=True)
    (app_dir / "out" / "main" / "index.js").write_text("", encoding="utf-8")
    packaged = LaunchTarget.packaged(executable)
    source = LaunchTarget.source(electron, app_dir)
    assert packaged.argv(Path("r"))[-2:] == ["--genoffice-automation", "--genoffice-automation-rendezvous=" + str(Path("r").resolve())]
    assert source.argv(Path("r"))[0:2] == [str(electron), str(app_dir)]


def test_process_identity_rejects_pid_reuse():
    identity = ProcessIdentity(pid=os.getpid(), creation_time=-1, executable_path="not-this-process")
    assert identity_is_live(identity) is False


def test_current_process_identity_uses_pointer_safe_apis():
    identity = capture_process_identity(os.getpid(), sys.executable)
    assert identity.pid == os.getpid()
    assert identity.creation_time >= 0
    assert identity_is_live(identity) is True


def test_session_store_has_lifecycle_lock_context(tmp_path):
    store = SessionStore(tmp_path / "session.json")
    with store.lifecycle_lock() as state:
        assert state == {}
        store.write_locked({"sessionId": "x", "state": "starting"})
    assert store.load()["state"] == "starting"


def test_competing_lifecycle_operation_times_out(tmp_path):
    first = SessionStore(tmp_path / "session.json", lock_timeout=0.1)
    second = SessionStore(tmp_path / "other.json", lock_timeout=0.1)
    # Both stores share the same parent lock to model app start/status/stop.
    with first.lifecycle_lock():
        with pytest.raises(HarnessError, match="lock timeout"):
            with second.lifecycle_lock():
                pass


def test_session_substitution_cannot_attach_by_pid_only(tmp_path):
    store = SessionStore(tmp_path / "session.json")
    store.save({"state": "running", "pid": os.getpid()})
    with pytest.raises(HarnessError, match="process identity"):
        Launcher(session_path=tmp_path / "session.json").endpoint()


def test_spawn_failure_cleans_private_root(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "LocalAppData"))
    executable = tmp_path / "GenOffice.exe"
    executable.touch()
    import cli_anything.genoffice.core.launcher as launcher_module

    def fail_spawn(*_args, **_kwargs):
        raise OSError("spawn failed")

    monkeypatch.setattr(launcher_module.subprocess, "Popen", fail_spawn)
    with pytest.raises(OSError):
        Launcher(app_path=executable).start()
    roots = list((tmp_path / "LocalAppData" / "GenOffice" / "agent-sessions").glob("*"))
    assert all(root.name == "lifecycle.lock" for root in roots)


@pytest.mark.skipif(os.name != "nt", reason="requires the Windows ACL implementation")
def test_windows_root_has_current_user_only_acl(tmp_path):
    root = create_session_root(base=tmp_path / "LocalAppData")
    result = subprocess.run(
        [os.environ["SystemRoot"] + r"\System32\icacls.exe", str(root)],
        capture_output=True, text=True, shell=False, check=True,
    )
    assert "(M)" in result.stdout or "(F)" in result.stdout


@pytest.mark.skipif(os.name != "nt", reason="requires real Windows security descriptor APIs")
def test_windows_bool_abi_and_real_owner_dacl_attestation(tmp_path):
    from ctypes import sizeof
    from cli_anything.genoffice.core.security import WindowsBOOL, _attest_windows_dacl

    assert sizeof(WindowsBOOL) == 4
    root = create_session_root(base=tmp_path / "LocalAppData")
    _attest_windows_dacl(root)
