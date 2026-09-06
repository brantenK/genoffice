"""PID identity binding; PID liveness alone is never sufficient."""

from __future__ import annotations

import ctypes
import os
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    creation_time: float
    executable_path: str

    def to_dict(self) -> dict:
        return {"pid": self.pid, "creationTime": self.creation_time, "executablePath": self.executable_path}

    @classmethod
    def from_dict(cls, value: dict) -> "ProcessIdentity":
        if not isinstance(value, dict):
            raise ValueError("process identity must be an object")
        pid = value.get("pid")
        creation = value.get("creationTime")
        executable = value.get("executablePath")
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            raise ValueError("process identity PID is invalid")
        if not isinstance(creation, (int, float)) or creation < 0:
            raise ValueError("process creation time is invalid")
        if not isinstance(executable, str) or not executable:
            raise ValueError("process executable identity is invalid")
        return cls(pid, float(creation), executable)


def _windows_details(pid: int) -> tuple[float, str] | None:
    if os.name != "nt":
        return None
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_uint32]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.GetProcessTimes.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    kernel32.GetProcessTimes.restype = ctypes.c_bool
    kernel32.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_wchar), ctypes.POINTER(ctypes.c_uint32)]
    kernel32.QueryFullProcessImageNameW.restype = ctypes.c_bool
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_bool
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, ctypes.c_uint32(pid))
    if not handle:
        return None
    closed = False
    result = None
    try:
        # GetProcessTimes takes FILETIME-compatible four-word structures.
        class FILETIME(ctypes.Structure):
            _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_uint32)]
        created, exited, kernel, user = FILETIME(), FILETIME(), FILETIME(), FILETIME()
        if not kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
            return None
        creation = (created.high << 32) | created.low
        size = ctypes.c_uint32(32768)
        buffer = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return None
        # FILETIME is 100ns intervals since 1601; absolute epoch is stable per process.
        result = (creation / 10_000_000.0, buffer.value)
    finally:
        closed = bool(kernel32.CloseHandle(handle))
    if not closed:
        return None
    return result


def _proc_details(pid: int) -> tuple[float, str] | None:
    if os.name == "nt":
        return _windows_details(pid)
    stat_path = Path(f"/proc/{pid}/stat")
    exe_path = Path(f"/proc/{pid}/exe")
    try:
        fields = stat_path.read_text(encoding="utf-8").split()
        # Linux starttime is field 22, after the two leading fields.
        start_ticks = int(fields[21])
        ticks = os.sysconf(os.sysconf_names["SC_CLK_TCK"])
        return start_ticks / ticks, str(exe_path.resolve())
    except (OSError, ValueError, IndexError, KeyError):
        if pid == os.getpid():
            return 0.0, str(Path(sys.executable).resolve())
        return None


def capture_process_identity(pid: int, executable_path: str | Path | None = None) -> ProcessIdentity:
    details = _proc_details(pid)
    if details is None:
        raise RuntimeError("process identity is unavailable")
    creation, actual_executable = details
    expected = str(Path(executable_path).resolve()) if executable_path else actual_executable
    return ProcessIdentity(pid, creation, expected)


def identity_is_live(identity: ProcessIdentity | dict) -> bool:
    try:
        if isinstance(identity, dict):
            identity = ProcessIdentity.from_dict(identity)
        details = _proc_details(identity.pid)
        if details is None:
            return False
        creation, executable = details
        expected = str(Path(identity.executable_path).resolve())
        return abs(creation - identity.creation_time) < 0.01 and os.path.normcase(executable) == os.path.normcase(expected)
    except (OSError, ValueError, RuntimeError):
        return False
