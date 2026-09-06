import os

import pytest

from cli_anything.genoffice.core.errors import HarnessError
from cli_anything.genoffice.core.process_identity import ProcessIdentity
from cli_anything.genoffice.core.supervisor import E2ESupervisor, target_from_environment


class FakeProcess:
    def __init__(self):
        self.pid = os.getpid()
        self.args = ["owned-child"]
        self.returncode = None
        self.terminated = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def wait(self, timeout=None):
        return self.returncode


class FakeLauncher:
    def __init__(self, **_kwargs):
        self.process = FakeProcess()
        self._child_identity = ProcessIdentity(os.getpid(), 0, "owned-child")
        self.store = type("Store", (), {"load": lambda self: {}})()

    def start(self):
        return {"sessionRoot": "C:/private/root", "sessionId": "a" * 32}

    @staticmethod
    def _terminate_process(process):
        process.terminate()


def test_target_from_environment_requires_one_explicit_mode(monkeypatch):
    monkeypatch.delenv("GENOFFICE_PACKAGED_APP", raising=False)
    monkeypatch.delenv("GENOFFICE_ELECTRON_PATH", raising=False)
    monkeypatch.delenv("GENOFFICE_SHELL_APP_DIR", raising=False)
    with pytest.raises(HarnessError, match="explicit"):
        target_from_environment()


def test_supervisor_cleanup_reaps_only_verified_owned_child(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "LocalAppData"))
    root = tmp_path / "LocalAppData" / "GenOffice" / "agent-sessions" / ("b" * 32)
    root.parent.mkdir(parents=True)
    root.mkdir()
    supervisor = E2ESupervisor(session_path=tmp_path / "selector", app_path=tmp_path / "GenOffice.exe", launcher_factory=FakeLauncher)
    monkeypatch.setattr("cli_anything.genoffice.core.supervisor.identity_is_live", lambda identity: True)
    monkeypatch.setattr("cli_anything.genoffice.core.supervisor._remove_validated_artifacts", lambda state, store: root.rmdir())
    supervisor.start()
    supervisor.state["sessionRoot"] = str(root)
    supervisor.cleanup()
    assert supervisor.launcher.process.terminated is True
    assert supervisor.launcher.process.returncode == 0


def test_supervisor_does_not_kill_identity_mismatch(monkeypatch, tmp_path):
    supervisor = E2ESupervisor(session_path=tmp_path / "selector", app_path=tmp_path / "GenOffice.exe", launcher_factory=FakeLauncher)
    monkeypatch.setattr("cli_anything.genoffice.core.supervisor.identity_is_live", lambda identity: False)
    supervisor.start()
    with pytest.raises(HarnessError, match="identity"):
        supervisor.cleanup()
    assert supervisor.launcher.process.terminated is False


def test_supervisor_fails_if_root_remains_after_cleanup(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "LocalAppData"))
    root = tmp_path / "LocalAppData" / "GenOffice" / "agent-sessions" / ("a" * 32)
    root.parent.mkdir(parents=True)
    root.mkdir()
    supervisor = E2ESupervisor(session_path=tmp_path / "selector", app_path=tmp_path / "GenOffice.exe", launcher_factory=FakeLauncher)
    supervisor.launcher.process.returncode = 0
    supervisor._child_identity = supervisor.launcher._child_identity
    supervisor.state = {"sessionRoot": str(root), "sessionId": "a" * 32}
    monkeypatch.setattr("cli_anything.genoffice.core.supervisor.identity_is_live", lambda identity: False)
    monkeypatch.setattr("cli_anything.genoffice.core.supervisor._remove_validated_artifacts", lambda state, store: None)
    with pytest.raises(HarnessError, match="remains"):
        supervisor.cleanup()
