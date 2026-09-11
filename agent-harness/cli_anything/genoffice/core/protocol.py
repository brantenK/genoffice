"""The narrow authenticated HTTP client for POST /v1/command."""

from __future__ import annotations

import http.client
import json
import secrets
import socket
import re
from dataclasses import dataclass
from typing import cast

from .errors import ProtocolError
from .process_identity import ProcessIdentity, identity_is_live
from .security import validate_safe_path


@dataclass(frozen=True)
class Endpoint:
    host: str
    port: int
    token: str
    session_id: str | None = None
    pid: int | None = None

    @classmethod
    def from_dict(cls, value: dict) -> "Endpoint":
        if not isinstance(value, dict) or set(value) != {"protocolVersion", "host", "port", "sessionId", "pid", "token"}:
            raise ProtocolError("endpoint metadata schema is invalid", "ENDPOINT_METADATA")
        if value.get("protocolVersion") != 1 or value.get("host") != "127.0.0.1":
            raise ProtocolError("endpoint must use the 127.0.0.1 loopback", "ENDPOINT_UNSAFE")
        port = value.get("port")
        token = value.get("token")
        if not isinstance(port, int) or isinstance(port, bool) or not 1024 <= port <= 65535:
            raise ProtocolError("endpoint port is invalid", "ENDPOINT_INVALID")
        if not isinstance(value.get("sessionId"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", value["sessionId"]):
            raise ProtocolError("endpoint session identity is invalid", "ENDPOINT_INVALID")
        if not isinstance(value.get("pid"), int) or isinstance(value["pid"], bool) or value["pid"] <= 0:
            raise ProtocolError("endpoint PID is invalid", "ENDPOINT_INVALID")
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,512}", token):
            raise ProtocolError("endpoint credential is invalid", "ENDPOINT_INVALID")
        return cls(value["host"], port, token, value["sessionId"], value["pid"])


class ProtocolClient:
    def __init__(self, endpoint: Endpoint, *, timeout: float = 10.0):
        self.endpoint = endpoint
        self.timeout = timeout

    def command(self, command: str, payload: dict | None = None) -> dict:
        if not isinstance(command, str) or not command or not isinstance(payload or {}, dict):
            raise ProtocolError("command and payload are invalid", "REQUEST_INVALID")
        request_id = secrets.token_urlsafe(16)
        body = {"version": 1, "requestId": request_id, "command": command, "payload": payload or {}}
        encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > 1024 * 1024:
            raise ProtocolError("request body is too large", "REQUEST_TOO_LARGE")
        connection = http.client.HTTPConnection(self.endpoint.host, self.endpoint.port, timeout=self.timeout)
        try:
            connection.request(
                "POST", "/v1/command", body=encoded,
                headers={
                    "Authorization": f"Bearer {self.endpoint.token}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Content-Length": str(len(encoded)),
                },
            )
            response = connection.getresponse()
            raw = response.read(1024 * 1024 + 1)
        except (TimeoutError, socket.timeout) as exc:
            raise ProtocolError("GenOffice automation request timed out", "TIMEOUT") from exc
        except (OSError, http.client.HTTPException) as exc:
            raise ProtocolError("could not connect to GenOffice automation endpoint", "CONNECTION") from exc
        finally:
            connection.close()
        if len(raw) > 1024 * 1024:
            raise ProtocolError("endpoint response is too large", "BAD_RESPONSE", status=response.status)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            if response.status == 401:
                raise ProtocolError("GenOffice automation authentication failed", "UNAUTHORIZED", status=401) from exc
            raise ProtocolError("endpoint returned invalid JSON", "BAD_RESPONSE", status=response.status) from exc
        if not isinstance(data, dict):
            raise ProtocolError("endpoint returned an invalid response", "BAD_RESPONSE", status=response.status)
        if response.status < 200 or response.status >= 300 or data.get("ok") is False:
            error_data = cast(dict, data.get("error")) if isinstance(data.get("error"), dict) else {}
            message = str(error_data.get("message") or f"GenOffice command failed with HTTP {response.status}")
            message = message.replace(self.endpoint.token, "[redacted]")
            code = str(error_data.get("code") or ("UNAUTHORIZED" if response.status == 401 else "REMOTE_ERROR"))
            response_request_id = data.get("requestId")
            if response_request_id is not None and response_request_id != request_id:
                raise ProtocolError("endpoint response request ID does not match", "BAD_RESPONSE", status=response.status)
            raise ProtocolError(
                message,
                code, status=response.status,
                details={"requestId": response_request_id or request_id},
            )
        if data.get("requestId") != request_id:
            raise ProtocolError("endpoint response request ID does not match", "BAD_RESPONSE", status=response.status)
        result = data.get("result", {})
        if not isinstance(result, dict):
            raise ProtocolError("endpoint result must be an object", "BAD_RESPONSE", status=response.status)
        return result


def endpoint_from_metadata(path, *, session_root=None, expected_session_id=None, expected_identity: ProcessIdentity | None = None) -> Endpoint:
    from pathlib import Path
    metadata_path = Path(path)
    if session_root is not None:
        root = Path(session_root)
        try:
            validate_safe_path(metadata_path, root, must_exist=True)
        except Exception as exc:
            raise ProtocolError("endpoint metadata path is outside the session root", "ENDPOINT_PATH_UNSAFE") from exc
        if metadata_path.name != "endpoint.json":
            raise ProtocolError("launch.json is not endpoint metadata", "ENDPOINT_METADATA")
    try:
        data = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ProtocolError("endpoint metadata is unavailable or corrupt", "ENDPOINT_METADATA") from exc
    endpoint = Endpoint.from_dict(data)
    if expected_session_id is not None and endpoint.session_id != expected_session_id:
        raise ProtocolError("endpoint session identity does not match session", "ENDPOINT_STALE")
    if expected_identity is not None:
        if endpoint.pid != expected_identity.pid or not identity_is_live(expected_identity):
            raise ProtocolError("endpoint process identity does not match session", "PROCESS_IDENTITY_MISMATCH")
    return endpoint
