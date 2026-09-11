"""Nine-case real Python → TypeScript bootstrap preflight; no Electron launch."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from cli_anything.genoffice.core.launcher import _write_json, build_launch_record
from cli_anything.genoffice.core.process_identity import capture_process_identity
from cli_anything.genoffice.core.protocol import ProtocolClient, endpoint_from_metadata
from cli_anything.genoffice.core.security import create_session_root


REPO = Path(__file__).resolve().parents[4]
HELPER = REPO / "apps" / "shell" / "tests" / "helpers" / "automation-bootstrap-preflight.ts"
TSX = REPO / "node_modules" / ".bin" / ("tsx.cmd" if os.name == "nt" else "tsx")


def _start_driver(root: Path):
    if not HELPER.is_file() or not TSX.is_file():
        pytest.fail(f"expected repo-local tsx and helper: {TSX}, {HELPER}")
    process = subprocess.Popen(
        [str(TSX), str(HELPER), "--rendezvous", str(root / "launch.json")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        shell=False,
    )
    line = process.stdout.readline() if process.stdout else ""
    return process, line


def _finish_driver(process: subprocess.Popen[str]) -> None:
    assert process.stdin is not None
    process.stdin.close()
    process.wait(timeout=10)
    assert process.returncode == 0, process.stderr.read() if process.stderr else ""


def _assert_rejected(root: Path) -> None:
    process, line = _start_driver(root)
    assert line == "", f"rejected bootstrap emitted output: {line!r}"
    process.wait(timeout=10)
    assert process.returncode != 0
    assert process.stderr is not None
    assert process.stderr.read() == "automation bootstrap preflight failed\n"


@pytest.mark.parametrize("scenario", [
    "happy", "endpoint-preexistence", "replay", "schema-mismatch",
    "id-mismatch", "metadata-session-substitution", "metadata-pid-substitution",
    "invalid-acl", "reparse-path",
])
def test_real_cross_language_bootstrap_preflight(scenario, monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "LocalAppData"))

    if scenario == "invalid-acl":
        from cli_anything.genoffice.core import security

        def reject_acl(_path):
            raise RuntimeError("test ACL attestation rejection")

        monkeypatch.setattr(security, "protect_windows_directory", reject_acl)
        with pytest.raises(RuntimeError, match="ACL attestation"):
            create_session_root()
        return

    root = create_session_root()
    record = build_launch_record(root)
    _write_json(root / "launch.json", record, root)

    if scenario == "endpoint-preexistence":
        _write_json(root / "endpoint.json", {"poisoned": True}, root)
        _assert_rejected(root)
        return
    if scenario == "schema-mismatch":
        record.pop("outputRoot")
        _write_json(root / "launch.json", record, root)
        _assert_rejected(root)
        return
    if scenario == "id-mismatch":
        record["sessionId"] = "fedcba9876543210fedcba9876543210"
        _write_json(root / "launch.json", record, root)
        _assert_rejected(root)
        return
    if scenario == "reparse-path":
        input_root = root / "input"
        input_root.rmdir()
        os.symlink(root / "output", input_root, target_is_directory=True)
        _assert_rejected(root)
        return

    process, line = _start_driver(root)
    assert process.poll() is None, process.stderr.read() if process.stderr else ""
    ready = json.loads(line)
    assert set(ready) == {"ready", "sessionId", "pid", "host", "port"}
    assert ready["ready"] is True
    assert ready["sessionId"] == record["sessionId"]
    assert isinstance(ready["pid"], int) and ready["pid"] > 0
    assert "token" not in line
    metadata_path = root / "endpoint.json"
    assert metadata_path.is_file()
    identity = capture_process_identity(ready["pid"])
    endpoint = endpoint_from_metadata(metadata_path, session_root=root, expected_session_id=record["sessionId"], expected_identity=identity)
    assert endpoint.pid == ready["pid"]
    assert ProtocolClient(endpoint).command("app.status")["pid"] == ready["pid"]

    if scenario == "metadata-session-substitution":
        poisoned = json.loads(metadata_path.read_text(encoding="utf-8"))
        poisoned["sessionId"] = "fedcba9876543210fedcba9876543210"
        _write_json(metadata_path, poisoned, root)
        with pytest.raises(Exception):
            endpoint_from_metadata(metadata_path, session_root=root, expected_session_id=record["sessionId"])
    elif scenario == "metadata-pid-substitution":
        poisoned = json.loads(metadata_path.read_text(encoding="utf-8"))
        poisoned["pid"] = ready["pid"] + 1
        _write_json(metadata_path, poisoned, root)
        with pytest.raises(Exception):
            endpoint_from_metadata(metadata_path, session_root=root, expected_session_id=record["sessionId"], expected_identity=identity)

    _finish_driver(process)
    assert not metadata_path.exists()

    if scenario == "replay":
        _assert_rejected(root)
