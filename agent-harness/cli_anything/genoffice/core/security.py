"""Private session roots and the Python-owned Windows security attestation."""

from __future__ import annotations

import ctypes
import os
import secrets
import subprocess
from pathlib import Path

from .errors import HarnessError


_REPARSE_POINT = 0x400
_INHERITED_ACE = 0x10
_ACCESS_ALLOWED_ACE_TYPE = 0
_SE_FILE_OBJECT = 1
_OWNER_SECURITY_INFORMATION = 0x1
_DACL_SECURITY_INFORMATION = 0x4
_ACL_SIZE_INFORMATION = 2
_TOKEN_QUERY = 0x0008
_TOKEN_USER = 1
_FILE_GENERIC_MODIFY = 0x1301BF

# Win32 BOOL is a signed 32-bit integer. A one-byte ctypes boolean is incorrect
# for both BOOL return values and LPBOOL outputs.
WindowsBOOL = ctypes.c_int32


def session_base(base: str | Path | None = None) -> Path:
    if base is not None:
        result = Path(base).expanduser()
    elif os.name == "nt":
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            raise HarnessError("LOCALAPPDATA is unavailable; refusing an unsafe session fallback", "SESSION_ROOT_UNAVAILABLE")
        result = Path(local) / "GenOffice" / "agent-sessions"
    else:
        result = Path.home() / ".local" / "share" / "GenOffice" / "agent-sessions"
    if _unsafe_text(str(result)):
        raise HarnessError("session path is UNC, device, or otherwise unsafe", "SESSION_PATH_UNSAFE")
    return result


def _unsafe_text(value: str) -> bool:
    normalized = value.replace("/", "\\")
    parts = normalized.split("\\")
    return (
        "\x00" in value
        or normalized.startswith("\\\\")
        or normalized.startswith("\\\\.\\")
        or normalized.startswith("\\\\?\\")
        or ".." in parts
    )


def _windows_kernel32():
    if os.name != "nt":
        raise HarnessError("Windows API requested on a non-Windows platform", "WINDOWS_API_UNAVAILABLE")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetFileAttributesW.argtypes = [ctypes.c_wchar_p]
    kernel32.GetFileAttributesW.restype = ctypes.c_uint32
    kernel32.GetSystemDirectoryW.argtypes = [ctypes.POINTER(ctypes.c_wchar), ctypes.c_uint32]
    kernel32.GetSystemDirectoryW.restype = ctypes.c_uint32
    kernel32.GetCurrentProcess.argtypes = []
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = WindowsBOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    return kernel32


def _is_reparse(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
    except OSError:
        return True
    if os.name != "nt" or not path.exists():
        return False
    kernel32 = _windows_kernel32()
    attributes = kernel32.GetFileAttributesW(str(path))
    if attributes == 0xFFFFFFFF:
        raise HarnessError("GetFileAttributesW failed", "SESSION_REPARSE")
    return bool(attributes & _REPARSE_POINT)


def _system_directory() -> Path:
    kernel32 = _windows_kernel32()
    buffer = ctypes.create_unicode_buffer(32768)
    length = kernel32.GetSystemDirectoryW(buffer, len(buffer))
    if not length or length >= len(buffer):
        raise HarnessError("GetSystemDirectoryW failed", "SYSTEM_DIRECTORY_UNAVAILABLE")
    result = Path(buffer.value)
    if result.name.lower() != "system32" or _is_reparse(result):
        raise HarnessError("Windows system directory failed trust validation", "SYSTEM_DIRECTORY_UNSAFE")
    return result


def _current_sid() -> str:
    if os.name != "nt":
        raise HarnessError("Windows SID requested on a non-Windows platform", "SID_UNAVAILABLE")
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = _windows_kernel32()
    advapi32.OpenProcessToken.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)]
    advapi32.OpenProcessToken.restype = WindowsBOOL
    advapi32.GetTokenInformation.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)]
    advapi32.GetTokenInformation.restype = WindowsBOOL
    advapi32.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
    advapi32.ConvertSidToStringSidW.restype = WindowsBOOL
    token = ctypes.c_void_p()
    if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), _TOKEN_QUERY, ctypes.byref(token)):
        raise HarnessError("could not open the current Windows access token", "SID_UNAVAILABLE")
    try:
        size = ctypes.c_uint32()
        advapi32.GetTokenInformation(token, _TOKEN_USER, None, 0, ctypes.byref(size))
        if not size.value:
            raise HarnessError("could not size the current Windows SID", "SID_UNAVAILABLE")
        buffer = ctypes.create_string_buffer(size.value)
        if not advapi32.GetTokenInformation(token, _TOKEN_USER, buffer, size.value, ctypes.byref(size)):
            raise HarnessError("could not read the current Windows SID", "SID_UNAVAILABLE")
        # TOKEN_USER starts with a SID_AND_ATTRIBUTES whose first pointer is PSID.
        sid_ptr = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        text = ctypes.c_wchar_p()
        if not advapi32.ConvertSidToStringSidW(sid_ptr, ctypes.byref(text)) or not text.value:
            raise HarnessError("could not format the current Windows SID", "SID_UNAVAILABLE")
        try:
            return str(text.value)
        finally:
            kernel32.LocalFree(text)
    finally:
        if not kernel32.CloseHandle(token):
            raise HarnessError("CloseHandle failed for the current token", "SID_UNAVAILABLE")


def _attest_windows_dacl(path: Path) -> None:
    """Enumerate owner/DACL through security-descriptor APIs, not localized text."""
    if os.name != "nt":
        return
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = _windows_kernel32()
    class ACL_SIZE_INFORMATION(ctypes.Structure):
        _fields_ = [("AceCount", ctypes.c_uint32), ("AcedBytesInUse", ctypes.c_uint32), ("AclBytesInUse", ctypes.c_uint32)]
    class ACE_HEADER(ctypes.Structure):
        _fields_ = [("AceType", ctypes.c_ubyte), ("AceFlags", ctypes.c_ubyte), ("AceSize", ctypes.c_uint16)]
    advapi32.GetNamedSecurityInfoW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p)]
    advapi32.GetNamedSecurityInfoW.restype = ctypes.c_uint32
    advapi32.IsValidSecurityDescriptor.argtypes = [ctypes.c_void_p]
    advapi32.IsValidSecurityDescriptor.restype = WindowsBOOL
    advapi32.GetSecurityDescriptorOwner.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(WindowsBOOL)]
    advapi32.GetSecurityDescriptorOwner.restype = WindowsBOOL
    advapi32.GetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p, ctypes.POINTER(WindowsBOOL), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(WindowsBOOL)]
    advapi32.GetSecurityDescriptorDacl.restype = WindowsBOOL
    advapi32.GetAclInformation.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32]
    advapi32.GetAclInformation.restype = WindowsBOOL
    advapi32.GetAce.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)]
    advapi32.GetAce.restype = WindowsBOOL
    advapi32.ConvertStringSidToSidW.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_void_p)]
    advapi32.ConvertStringSidToSidW.restype = WindowsBOOL
    advapi32.EqualSid.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    advapi32.EqualSid.restype = WindowsBOOL
    descriptor = ctypes.c_void_p()
    owner = ctypes.c_void_p()
    dacl = ctypes.c_void_p()
    if advapi32.GetNamedSecurityInfoW(str(path), _SE_FILE_OBJECT, _OWNER_SECURITY_INFORMATION | _DACL_SECURITY_INFORMATION, ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor)) != 0:
        raise HarnessError("GetNamedSecurityInfoW failed", "ACL_UNSAFE")
    try:
        if not descriptor.value or not advapi32.IsValidSecurityDescriptor(descriptor):
            raise HarnessError("security descriptor is invalid", "ACL_UNSAFE")
        owner_defaulted = WindowsBOOL()
        if not advapi32.GetSecurityDescriptorOwner(descriptor, ctypes.byref(owner), ctypes.byref(owner_defaulted)) or not owner.value:
            raise HarnessError("session root owner is unavailable", "ACL_UNSAFE")
        sid_text = _current_sid()
        current_sid = ctypes.c_void_p()
        if not advapi32.ConvertStringSidToSidW(sid_text, ctypes.byref(current_sid)):
            raise HarnessError("current SID conversion failed", "ACL_UNSAFE")
        try:
            if not advapi32.EqualSid(owner, current_sid):
                raise HarnessError("session root owner is not the current SID", "ACL_UNSAFE")
            present = WindowsBOOL()
            defaulted = WindowsBOOL()
            if not advapi32.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)) or not present.value or not dacl.value:
                raise HarnessError("session root DACL is absent", "ACL_UNSAFE")
            info = ACL_SIZE_INFORMATION()
            if not advapi32.GetAclInformation(dacl, ctypes.byref(info), ctypes.sizeof(info), _ACL_SIZE_INFORMATION) or not info.AceCount:
                raise HarnessError("session root DACL is empty", "ACL_UNSAFE")
            for index in range(info.AceCount):
                ace = ctypes.c_void_p()
                if not advapi32.GetAce(dacl, index, ctypes.byref(ace)) or not ace.value:
                    raise HarnessError("DACL ACE enumeration failed", "ACL_UNSAFE")
                header = ctypes.cast(ace, ctypes.POINTER(ACE_HEADER)).contents
                if header.AceType != _ACCESS_ALLOWED_ACE_TYPE or header.AceFlags & _INHERITED_ACE or header.AceSize < 8:
                    raise HarnessError("session DACL contains an unexpected ACE", "ACL_UNSAFE")
                mask = ctypes.cast(ace.value + 4, ctypes.POINTER(ctypes.c_uint32)).contents.value
                sid_start = ctypes.c_void_p(ace.value + 8)
                if mask & ~_FILE_GENERIC_MODIFY or not advapi32.EqualSid(sid_start, current_sid):
                    raise HarnessError("session DACL is not current-user Modify-only", "ACL_UNSAFE")
        finally:
            kernel32.LocalFree(current_sid)
    finally:
        kernel32.LocalFree(descriptor)


def protect_windows_directory(path: Path) -> None:
    """Apply and attest the owner/current-user Modify-only DACL."""
    if os.name != "nt":
        return
    sid = _current_sid()
    icacls = _system_directory() / "icacls.exe"
    if icacls.name.lower() != "icacls.exe" or not icacls.is_file() or _is_reparse(icacls):
        raise HarnessError("trusted icacls.exe is unavailable", "ACL_UNAVAILABLE")
    grant = f"*{sid}:(OI)(CI)M"
    subprocess.run([str(icacls), str(path), "/inheritance:r", "/grant:r", grant], shell=False, check=True, capture_output=True, text=True)
    _attest_windows_dacl(path)


def prepare_session_base(base: str | Path | None = None) -> Path:
    base_path = session_base(base)
    existing = base_path
    while not existing.exists() and existing != existing.parent:
        existing = existing.parent
    if any(_is_reparse(item) for item in [existing, *existing.parents]):
        raise HarnessError("session base parent is a reparse point", "SESSION_REPARSE")
    try:
        base_path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HarnessError("could not create session base", "SESSION_ROOT_CREATE") from exc
    if _is_reparse(base_path):
        raise HarnessError("session base is a reparse point", "SESSION_REPARSE")
    lifecycle_lock = base_path / "lifecycle.lock"
    if lifecycle_lock.exists() and _is_reparse(lifecycle_lock):
        raise HarnessError("lifecycle lock is a reparse point", "SESSION_REPARSE")
    if os.name == "nt":
        protect_windows_directory(base_path)
    else:
        os.chmod(base_path, 0o700)
    return base_path


def validate_safe_path(path: str | Path, root: str | Path, *, must_exist: bool = False) -> Path:
    candidate = Path(path)
    root_path = Path(root)
    if _unsafe_text(str(candidate)) or _unsafe_text(str(root_path)):
        raise HarnessError("path is UNC, device, traversal, or contains NUL", "SESSION_PATH_UNSAFE")
    lexical_candidate = Path(os.path.abspath(candidate))
    lexical_root = Path(os.path.abspath(root_path))
    try:
        if os.path.commonpath([str(lexical_root), str(lexical_candidate)]) != str(lexical_root):
            raise HarnessError("path escapes the private session root", "SESSION_PATH_ESCAPE")
        current = lexical_root
        for part in lexical_candidate.relative_to(lexical_root).parts:
            current = current / part
            if current.exists() and _is_reparse(current):
                raise HarnessError("reparse or symlink path is not allowed", "SESSION_REPARSE")
        resolved_root = lexical_root.resolve(strict=True)
        resolved_candidate = lexical_candidate.resolve(strict=must_exist)
        if os.path.commonpath([str(resolved_root), str(resolved_candidate)]) != str(resolved_root):
            raise HarnessError("resolved path escapes the private session root", "SESSION_PATH_ESCAPE")
    except (ValueError, OSError) as exc:
        raise HarnessError("path cannot be safely resolved", "SESSION_PATH_UNSAFE") from exc
    if must_exist and not resolved_candidate.exists():
        raise HarnessError("required session path does not exist", "SESSION_PATH_MISSING")
    return resolved_candidate


def validate_launch_path(path: str | Path, *, kind: str) -> Path:
    """Validate an explicit launch target lexically before resolving it."""
    candidate = Path(path)
    if _unsafe_text(str(candidate)):
        raise HarnessError("launch target is lexically unsafe", "APP_TARGET_UNSAFE")
    lexical = Path(os.path.abspath(candidate))
    current = Path(lexical.anchor or os.curdir)
    for part in lexical.parts[1:] if lexical.anchor else lexical.parts:
        current = current / part
        if current.exists() and _is_reparse(current):
            raise HarnessError("launch target contains a reparse component", "APP_TARGET_UNSAFE")
    try:
        resolved = lexical.resolve(strict=True)
    except OSError as exc:
        raise HarnessError("launch target cannot be resolved", "APP_TARGET_INVALID") from exc
    if os.path.normcase(str(resolved)) != os.path.normcase(str(lexical)):
        raise HarnessError("launch target resolves through a link", "APP_TARGET_UNSAFE")
    if kind == "file" and not resolved.is_file():
        raise HarnessError("explicit launch executable is unavailable", "APP_UNAVAILABLE")
    if kind == "directory" and not resolved.is_dir():
        raise HarnessError("explicit shell directory is unavailable", "APP_TARGET_INVALID")
    return resolved


def _mkdir_exclusive(path: Path) -> None:
    try:
        path.mkdir()
    except FileExistsError as exc:
        raise HarnessError("session root collision", "SESSION_ROOT_COLLISION") from exc
    except OSError as exc:
        raise HarnessError("could not create private session root", "SESSION_ROOT_CREATE") from exc
    try:
        os.chmod(path, 0o700)
    except OSError:
        if os.name != "nt":
            raise


def _exclusive_file(path: Path) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)


def _remove_created_root(root: Path) -> None:
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


def create_session_root(base: str | Path | None = None) -> Path:
    base_path = prepare_session_base(base)
    for _ in range(10):
        root = base_path / secrets.token_hex(16)
        try:
            _mkdir_exclusive(root)
        except HarnessError as error:
            if error.code == "SESSION_ROOT_COLLISION":
                continue
            raise
        try:
            if os.name == "nt":
                protect_windows_directory(root)
            else:
                os.chmod(root, 0o700)
            for directory in ("input", "output", "user-data"):
                child = root / directory
                child.mkdir()
                if _is_reparse(child):
                    raise HarnessError("session child is a reparse point", "SESSION_REPARSE")
            # endpoint.json, session.json, and launch.json.consumed are reserved
            # and intentionally absent until the corresponding lifecycle phase.
            for filename in ("launch.json", "session.lock"):
                _exclusive_file(root / filename)
            return root
        except Exception:
            _remove_created_root(root)
            raise
    raise HarnessError("could not allocate an exclusive session root", "SESSION_ROOT_COLLISION")
