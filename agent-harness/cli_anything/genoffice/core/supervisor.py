"""Test-owned supervision for the real Launcher; never a production command."""

from __future__ import annotations

import os
from pathlib import Path

from .errors import HarnessError
from .launcher import Launcher, _remove_root
from .process_identity import ProcessIdentity, identity_is_live
from .security import session_base, validate_safe_path


def target_from_environment() -> dict:
    packaged = os.environ.get("GENOFFICE_PACKAGED_APP")
    electron = os.environ.get("GENOFFICE_ELECTRON_PATH")
    shell_dir = os.environ.get("GENOFFICE_SHELL_APP_DIR")
    if packaged and (electron or shell_dir):
        raise HarnessError("choose one explicit packaged or source launch mode", "E2E_TARGET_INVALID")
    if packaged:
        return {"app_path": packaged}
    if electron and shell_dir:
        return {"electron_path": electron, "app_dir": shell_dir}
    raise HarnessError("E2E supervision requires an explicit launch target", "E2E_TARGET_REQUIRED")


def _remove_validated_artifacts(state: dict, store) -> None:
    root = validate_safe_path(state["sessionRoot"], session_base().resolve(strict=True), must_exist=True)
    for name in ("endpoint.json", "session.json", "launch.json.consumed"):
        candidate = validate_safe_path(root / name, root, must_exist=False)
        if candidate.exists():
            candidate.unlink()
    if hasattr(store, "clear"):
        store.clear()
    _remove_root(root)


class E2ESupervisor:
    """Own a production Launcher/Popen handle for test-only teardown."""

    def __init__(self, *, session_path=None, launcher_factory=Launcher, **target):
        self.launcher = launcher_factory(session_path=session_path, **target)
        self.state: dict | None = None

    @classmethod
    def from_environment(cls, *, session_path=None, launcher_factory=Launcher) -> "E2ESupervisor":
        return cls(session_path=session_path, launcher_factory=launcher_factory, **target_from_environment())

    def start(self) -> dict:
        try:
            state = self.launcher.start()
            if self.launcher.process is None or self.launcher._child_identity is None:
                raise HarnessError("production Launcher did not retain its verified child handle", "E2E_SUPERVISION_INVALID")
            self.state = state
            return state
        except Exception:
            self._reap_owned_child()
            raise

    def _reap_owned_child(self) -> None:
        process = getattr(self.launcher, "process", None)
        identity = getattr(self.launcher, "_child_identity", None)
        if process is None or identity is None or process.poll() is not None:
            return
        if not identity_is_live(identity):
            raise HarnessError("refusing to reap a process with mismatched identity", "E2E_PROCESS_IDENTITY")
        self.launcher._terminate_process(process)
        process.wait(timeout=10)
        if process.poll() is None:
            raise HarnessError("owned child did not terminate", "E2E_PROCESS_REAP")

    def cleanup(self) -> None:
        if self.state is None:
            self._reap_owned_child()
            return
        process = self.launcher.process
        identity: ProcessIdentity | None = self.launcher._child_identity
        if process is None or identity is None:
            raise HarnessError("supervisor has no verified child handle", "E2E_SUPERVISION_INVALID")
        if process.poll() is None:
            if not identity_is_live(identity):
                raise HarnessError("refusing to reap a process with mismatched identity", "E2E_PROCESS_IDENTITY")
            self.launcher._terminate_process(process)
        process.wait(timeout=10)
        if process.poll() is None:
            raise HarnessError("owned child did not terminate", "E2E_PROCESS_REAP")
        root = validate_safe_path(self.state["sessionRoot"], session_base().resolve(strict=True), must_exist=True)
        selector = getattr(self.launcher.store, "path", None)
        _remove_validated_artifacts(self.state, self.launcher.store)
        if root.exists():
            raise HarnessError("validated session root remains after cleanup", "E2E_CLEANUP_RESIDUAL")
        if selector is not None and selector.exists():
            raise HarnessError("session selector remains after cleanup", "E2E_CLEANUP_RESIDUAL")
        self.state = None
