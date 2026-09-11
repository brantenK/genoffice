import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from cli_anything.genoffice.core.errors import ProtocolError
from cli_anything.genoffice.core.protocol import Endpoint, ProtocolClient


def test_structured_protocol_error_is_mapped():
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            body = json.dumps({"ok": False, "requestId": request["requestId"], "error": {"code": "NOT_ALLOWED", "message": "nope"}}).encode()
            self.send_response(403)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with pytest.raises(ProtocolError) as error:
            ProtocolClient(Endpoint("127.0.0.1", server.server_port, "s" * 43, "0123456789abcdef0123456789abcdef", 1)).command("app.status", {})
        assert error.value.code == "NOT_ALLOWED"
        assert "s" * 43 not in str(error.value)
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_response_request_id_mismatch_is_rejected():
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            body = b'{"ok":true,"requestId":"wrong","result":{}}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with pytest.raises(ProtocolError, match="request ID"):
            ProtocolClient(Endpoint("127.0.0.1", server.server_port, "s" * 43, "0123456789abcdef0123456789abcdef", 1)).command("tabs.list", {})
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_unauthorized_pre_dispatch_error_is_typed():
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            body = b'{"ok":false,"error":{"code":"UNAUTHORIZED","message":"missing bearer"}}'
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with pytest.raises(ProtocolError) as error:
            ProtocolClient(Endpoint("127.0.0.1", server.server_port, "s" * 43, "0123456789abcdef0123456789abcdef", 1)).command("app.status", {})
        assert error.value.code == "UNAUTHORIZED"
        assert error.value.status == 401
    finally:
        server.shutdown()
        thread.join(timeout=2)
