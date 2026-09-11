import json
import os
import sys
import time
from pathlib import Path

import pytest

from cli_anything.genoffice.core.errors import HarnessError, ProtocolError
from cli_anything.genoffice.core.launcher import Launcher, build_launch_record
from cli_anything.genoffice.core.protocol import Endpoint, ProtocolClient
from cli_anything.genoffice.core.session import SessionStore


def test_launch_record_is_explicit_and_secret_free(tmp_path):
    record = build_launch_record(tmp_path)
    assert record["protocolVersion"] == 1
    assert record["rendezvousPath"] == str(tmp_path / "launch.json")
    assert record["userDataPath"] == str(tmp_path / "user-data")
    assert "token" not in json.dumps(record).lower()


def test_launcher_never_substitutes_root_dev_command(tmp_path):
    launcher = Launcher(session_path=tmp_path / "session.json", app_path=tmp_path / "missing.exe")
    with pytest.raises(HarnessError, match="launch target|packaged Electron"):
        launcher.start()


def test_launcher_arguments_are_only_automation_switches(tmp_path):
    launcher = Launcher(session_path=tmp_path / "session.json", app_path=sys.executable)
    args = launcher.automation_args(tmp_path / "rendezvous.json")
    assert args == [
        "--genoffice-automation",
        f"--genoffice-automation-rendezvous={tmp_path / 'rendezvous.json'}",
    ]


def test_endpoint_rejects_non_loopback():
    with pytest.raises(ProtocolError, match="loopback"):
        Endpoint.from_dict({
            "protocolVersion": 1, "host": "0.0.0.0", "port": 1234,
            "sessionId": "0123456789abcdef0123456789abcdef", "pid": 1, "token": "s" * 43,
        })


def test_protocol_client_sends_bearer_and_command(tmp_path):
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    seen = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            seen["authorization"] = self.headers.get("Authorization")
            seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            response = json.dumps({"ok": True, "requestId": seen["body"]["requestId"], "result": {}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)
        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = ProtocolClient(Endpoint("127.0.0.1", server.server_port, "t" * 43, "0123456789abcdef0123456789abcdef", os.getpid()))
        result = client.command("app.status", {})
        assert result == {}
        assert seen["authorization"] == "Bearer " + "t" * 43
        assert seen["body"]["command"] == "app.status"
        assert "t" * 43 not in repr(client)
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_session_save_is_valid_and_never_persists_token(tmp_path):
    store = SessionStore(tmp_path / "session.json")
    store.save({"sessionId": "abc", "pid": 42})
    raw = (tmp_path / "session.json").read_text()
    assert json.loads(raw)["sessionId"] == "abc"
    assert "token" not in raw.lower()


def test_session_update_is_atomic_and_lock_released_on_error(tmp_path):
    store = SessionStore(tmp_path / "session.json")
    store.save({"counter": 0})
    with pytest.raises(RuntimeError):
        store.update(lambda _data: (_ for _ in ()).throw(RuntimeError("boom")))
    store.update(lambda data: {**data, "counter": data["counter"] + 1})
    assert store.load()["counter"] == 1


def test_stale_pid_is_detected(tmp_path):
    store = SessionStore(tmp_path / "session.json")
    store.save({"pid": 99999999, "state": "running"})
    assert store.is_stale() is True
