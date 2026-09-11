"""Atomic session state with a lock that can span the complete lifecycle."""

from __future__ import annotations

import json
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable

from .errors import HarnessError
from .process_identity import ProcessIdentity, identity_is_live
from .security import _is_reparse, prepare_session_base, session_base, validate_safe_path


_FORBIDDEN = {"token", "bearer", "authorization", "access_token"}


def default_session_path() -> Path:
    # This is a pointer/selector, not the session JSON.  A launched session's
    # actual session.json always lives inside its random private root.
    return session_base() / "current-session"


def _contains_secret(value) -> bool:
    if isinstance(value, dict):
        return any(str(k).lower() in _FORBIDDEN or _contains_secret(v) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return any(_contains_secret(v) for v in value)
    return False


@contextmanager
def _locked(path: Path, timeout: float = 10.0):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b")
    deadline = time.monotonic() + timeout
    locked = False
    try:
        if os.name == "nt":
            import msvcrt
            while True:
                try:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    locked = True
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise HarnessError("session lock timeout", "SESSION_LOCK_TIMEOUT")
                    time.sleep(0.02)
        else:
            import fcntl
            while True:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    locked = True
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise HarnessError("session lock timeout", "SESSION_LOCK_TIMEOUT")
                    time.sleep(0.02)
        yield handle
    finally:
        if locked:
            try:
                if os.name == "nt":
                    import msvcrt
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            finally:
                handle.close()
        else:
            handle.close()


@contextmanager
def _protected_lock(path: Path, timeout: float = 10.0):
    # Attest/protect the base before creating or opening the lifecycle lock.
    prepare_session_base()
    if path.exists() and _is_reparse(path):
        raise HarnessError("session lock is a reparse point", "SESSION_REPARSE")
    with _locked(path, timeout) as handle:
        yield handle


class SessionStore:
    def __init__(self, path: str | Path | None = None, *, lock_timeout: float = 10.0, selector: bool | None = None):
        self.selector = path is None if selector is None else selector
        self.path = Path(path) if path else default_session_path()
        self.lock_timeout = lock_timeout

    @property
    def lock_path(self) -> Path:
        if self.selector:
            return session_base() / "lifecycle.lock"
        return self.path.parent / "session.lock"

    def _state_path(self) -> Path:
        if not self.selector or not self.path.exists():
            return self.path
        try:
            target = Path(self.path.read_text(encoding="utf-8").strip())
            base = session_base().resolve(strict=True)
            return validate_safe_path(target, base, must_exist=False)
        except (OSError, ValueError, HarnessError):
            return self.path

    def load(self) -> dict:
        if self.selector:
            with _protected_lock(self.lock_path, self.lock_timeout):
                return self._read_path_unlocked(self._state_path())
        with _protected_lock(self.lock_path, self.lock_timeout):
            return self._read_path_unlocked(self.path)

    def _read_path_unlocked(self, path: Path) -> dict:
        if not path.exists():
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise HarnessError("session JSON is corrupt or unreadable", "SESSION_CORRUPT") from exc
        if not isinstance(value, dict):
            raise HarnessError("session JSON must be an object", "SESSION_CORRUPT")
        return value

    def _read_unlocked(self) -> dict:
        return self._read_path_unlocked(self.path)

    @contextmanager
    def lifecycle_lock(self):
        """Hold the lifecycle lock from check through spawn/validation/persist."""
        with _protected_lock(self.lock_path, self.lock_timeout):
            yield self._read_path_unlocked(self._state_path())

    def write_locked(self, value: dict, *, path: Path | None = None) -> None:
        target = path or self._state_path()
        self._validate_value(value)
        target.parent.mkdir(parents=True, exist_ok=True)
        self._atomic_write_unlocked(target, value)

    def save(self, value: dict) -> None:
        self._validate_value(value)
        target = self._state_path()
        with _protected_lock(self.lock_path, self.lock_timeout):
            target.parent.mkdir(parents=True, exist_ok=True)
            self._atomic_write_unlocked(target, value)

    def _validate_value(self, value: dict) -> None:
        if not isinstance(value, dict):
            raise HarnessError("session state must be an object", "SESSION_INVALID")
        if _contains_secret(value):
            raise HarnessError("session state cannot contain bearer credentials", "SESSION_SECRET")

    def _atomic_write_unlocked(self, target: Path, value: dict) -> None:
        value = dict(value)
        value.setdefault("version", 1)
        fd, temporary = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=target.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                json.dump(value, stream, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def update(self, updater: Callable[[dict], dict]) -> dict:
        with self.lifecycle_lock() as current:
            updated = updater(dict(current))
            self._validate_value(updated)
            self.write_locked(updated)
            return updated

    def set_current(self, state_path: str | Path) -> None:
        target = Path(state_path).resolve()
        base = session_base().resolve(strict=True)
        validate_safe_path(target, base, must_exist=False)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(str(target), encoding="utf-8")
        os.replace(temporary, self.path)

    def clear(self) -> None:
        with _protected_lock(self.lock_path, self.lock_timeout):
            self.clear_locked()

    def clear_locked(self) -> None:
        target = self._state_path()
        try:
            target.unlink()
        except FileNotFoundError:
            pass
        if self.selector:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass

    def is_stale(self, state: dict | None = None) -> bool:
        state = state if state is not None else self.load()
        identity = state.get("processIdentity")
        if not isinstance(identity, dict):
            return True
        try:
            return not identity_is_live(ProcessIdentity.from_dict(identity))
        except (ValueError, TypeError):
            return True
