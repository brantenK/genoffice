"""Explicit built/packaged launch targets and lifecycle-wide session binding."""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from .errors import HarnessError, ProtocolError
from .process_identity import ProcessIdentity, capture_process_identity, identity_is_live
from .protocol import Endpoint, ProtocolClient, endpoint_from_metadata
from .security import create_session_root, session_base, validate_launch_path, validate_safe_path
from .session import SessionStore


_ENV_ALLOWLIST = {
    "PATH", "Path", "SystemRoot", "SYSTEMROOT", "SystemDrive", "WINDIR",
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
    "LANG", "LC_ALL", "LC_CTYPE", "TZ",
}


def sanitize_environment(source: dict[str, str] | None = None) -> dict[str, str]:
    source = dict(source or os.environ)
    return {key: value for key, value in source.items() if key in _ENV_ALLOWLIST}


@dataclass(frozen=True)
class LaunchTarget:
    mode: str
    executable: Path
    app_dir: Path | None = None

    @classmethod
    def packaged(cls, executable: str | Path) -> "LaunchTarget":
        raw = str(executable).replace("/", "\\")
        if raw.startswith(("\\\\", "\\\\.\\", "\\\\?\\")) or "\x00" in raw:
            raise HarnessError("launch target is UNC, device, or contains NUL", "APP_TARGET_UNSAFE")
        path = validate_launch_path(executable, kind="file")
        return cls("packaged", path)

    @classmethod
    def source(cls, electron: str | Path, app_dir: str | Path) -> "LaunchTarget":
        for value in (electron, app_dir):
            raw = str(value).replace("/", "\\")
            if raw.startswith(("\\\\", "\\\\.\\", "\\\\?\\")) or "\x00" in raw:
                raise HarnessError("launch target is UNC, device, or contains NUL", "APP_TARGET_UNSAFE")
        runtime = validate_launch_path(electron, kind="file")
        directory = validate_launch_path(app_dir, kind="directory")
        validate_launch_path(directory / "package.json", kind="file")
        validate_launch_path(directory / "out" / "main" / "index.js", kind="file")
        return cls("source", runtime, directory)

    def argv(self, rendezvous: Path) -> list[str]:
        switches = [
            "--genoffice-automation",
            f"--genoffice-automation-rendezvous={Path(rendezvous).resolve()}",
        ]
        if self.mode == "packaged":
            return [str(self.executable), *switches]
        return [str(self.executable), str(self.app_dir), *switches]


def build_launch_record(session_root: Path, *, ttl: float = 120.0) -> dict:
    root = Path(session_root).resolve()
    created = int(time.time() * 1000)
    lifetime = min(max(1, int(ttl * 1000)), 120_000)
    session_id = root.name if re.fullmatch(r"[0-9a-f]{32}", root.name) else secrets.token_hex(16)
    return {
        "protocolVersion": 1,
        "sessionId": session_id,
        "nonce": secrets.token_hex(32),
        "createdAt": created,
        "expiresAt": created + lifetime,
        "rendezvousPath": str(root / "launch.json"),
        "sessionRoot": str(root),
        "userDataPath": str(root / "user-data"),
        "inputRoot": str(root / "input"),
        "outputRoot": str(root / "output"),
    }


def _write_json(path: Path, value: dict, root: Path) -> None:
    validate_safe_path(path, root, must_exist=False)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        if os.name != "nt":
            raise


def _remove_root(root: Path) -> None:
    if not root.exists():
        return
    for child in sorted(root.glob("**/*"), reverse=True):
        try:
            if child.is_file() or child.is_symlink():
                child.unlink()
            else:
                child.rmdir()
        except OSError:
            pass
    try:
        root.rmdir()
    except OSError:
        pass


class Launcher:
    def __init__(self, *, session_path=None, app_path=None, electron_path=None, app_dir=None, startup_timeout: float = 30.0):
        # A selector path is only a pointer; the actual session.json is always
        # placed inside the random protected root created during start.
        self.store = SessionStore(session_path, selector=True)
        self.app_path = Path(app_path).expanduser() if app_path else None
        self.electron_path = Path(electron_path).expanduser() if electron_path else None
        self.app_dir = Path(app_dir).expanduser() if app_dir else None
        self.startup_timeout = startup_timeout
        self.process = None
        self._child_identity: ProcessIdentity | None = None

    @staticmethod
    def automation_args(rendezvous_path: Path) -> list[str]:
        return [
            "--genoffice-automation",
            f"--genoffice-automation-rendezvous={Path(rendezvous_path).resolve()}",
        ]

    def target(self) -> LaunchTarget:
        if self.app_path and (self.electron_path or self.app_dir):
            raise HarnessError("choose either packaged --app-path or source --electron-path/--app-dir", "APP_TARGET_INVALID")
        if self.app_path:
            return LaunchTarget.packaged(self.app_path)
        if self.electron_path and self.app_dir:
            return LaunchTarget.source(self.electron_path, self.app_dir)
        raise HarnessError(
            "a built/packaged --app-path or explicit --electron-path plus --app-dir is required; "
            "repository inference and npm run dev are disabled",
            "APP_TARGET_REQUIRED",
        )

    def start(self) -> dict:
        with self.store.lifecycle_lock() as current:
            if current and current.get("state") == "running" and not self.store.is_stale(current):
                return current
            if current and current.get("state") == "running" and self.store.is_stale(current):
                stale_root = current.get("sessionRoot")
                if isinstance(stale_root, str):
                    try:
                        root_path = validate_safe_path(stale_root, session_base().resolve(strict=True), must_exist=True)
                        _remove_root(root_path)
                    except HarnessError:
                        # A stale but unsafe path is not trusted or deleted.
                        pass
            target = self.target()
            root = create_session_root()
            process = None
            try:
                record = build_launch_record(root)
                _write_json(root / "launch.json", record, root)
                process = subprocess.Popen(
                    target.argv(root / "launch.json"),
                    cwd=str(target.app_dir or target.executable.parent),
                    env=sanitize_environment(),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    close_fds=(os.name != "nt"),
                    shell=False,
                )
                self.process = process
                try:
                    identity = capture_process_identity(process.pid, target.executable)
                except Exception as error:
                    raise HarnessError("could not bind launched process identity", "PROCESS_IDENTITY_UNAVAILABLE") from error
                endpoint_path = root / "endpoint.json"
                self._child_identity = identity
                started = time.monotonic()
                endpoint = None
                while time.monotonic() - started < self.startup_timeout:
                    if process.poll() is not None:
                        raise HarnessError("GenOffice exited before endpoint readiness", "APP_START_FAILED")
                    if endpoint_path.is_file():
                        try:
                            endpoint = endpoint_from_metadata(
                                endpoint_path,
                                session_root=root,
                                expected_session_id=record["sessionId"],
                                expected_identity=identity,
                            )
                            break
                        except ProtocolError as error:
                            if error.code not in {"ENDPOINT_METADATA", "ENDPOINT_INVALID"}:
                                raise
                    time.sleep(0.1)
                if endpoint is None:
                    raise HarnessError("timed out waiting for GenOffice endpoint metadata", "APP_START_TIMEOUT")
                if not identity_is_live(identity):
                    raise HarnessError("launched process identity is no longer live", "PROCESS_IDENTITY_MISMATCH")
                state = {
                    "version": 1,
                    "sessionId": record["sessionId"],
                    "processIdentity": identity.to_dict(),
                    "endpointMetadataPath": str(endpoint_path),
                    "launchRecordPath": str(root / "launch.json"),
                    "sessionRoot": str(root),
                    "appPath": str(target.executable),
                    "startedAt": time.time(),
                    "state": "running",
                }
                root_store = SessionStore(root / "session.json")
                root_store.write_locked(state)
                self.store.set_current(root / "session.json")
                return state
            except Exception:
                if process is not None:
                    self._terminate_process(process)
                _remove_root(root)
                raise

    def _validated_state(self, state: dict | None = None) -> tuple[dict, ProcessIdentity, Path, Endpoint]:
        state = state if state is not None else self.store.load()
        if not state or state.get("state") != "running":
            raise HarnessError("no live GenOffice automation session", "SESSION_NOT_RUNNING")
        try:
            identity = ProcessIdentity.from_dict(state["processIdentity"])
        except (KeyError, ValueError, TypeError) as exc:
            raise HarnessError("session process identity is invalid", "PROCESS_IDENTITY_MISMATCH") from exc
        if not identity_is_live(identity):
            raise HarnessError("session process identity is stale or reused", "PROCESS_IDENTITY_MISMATCH")
        base = session_base().resolve(strict=True)
        root = validate_safe_path(state["sessionRoot"], base, must_exist=True)
        metadata = validate_safe_path(state["endpointMetadataPath"], root, must_exist=True)
        endpoint = endpoint_from_metadata(metadata, session_root=root, expected_session_id=state["sessionId"], expected_identity=identity)
        return state, identity, metadata, endpoint

    def endpoint(self) -> Endpoint:
        with self.store.lifecycle_lock() as state:
            _, _, _, endpoint = self._validated_state(state)
            return endpoint

    def request(self, command: str, payload: dict | None = None) -> dict:
        with self.store.lifecycle_lock() as state:
            state, _, _, endpoint = self._validated_state(state)
            return ProtocolClient(endpoint).command(command, payload or {})

    def input_path(self, path: str | Path) -> Path:
        with self.store.lifecycle_lock() as current:
            state, _, _, _ = self._validated_state(current)
            root = Path(state["sessionRoot"])
            candidate = validate_safe_path(path, root / "input", must_exist=True)
            if candidate.suffix.lower() != ".docx" or not candidate.is_file() or candidate.is_symlink():
                raise HarnessError("files open accepts only a regular .docx fixture in session input", "FILE_UNSAFE")
            return candidate

    def reap_verified_child(self) -> None:
        """Test cleanup only; no CLI or remote shutdown capability."""
        if self.process is None:
            return
        identity = self._child_identity
        if identity is None:
            raise HarnessError("test child identity is unavailable", "PROCESS_IDENTITY_UNAVAILABLE")
        if not identity_is_live(identity):
            return
        self._terminate_process(self.process)

    @staticmethod
    def _terminate_process(process):
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
