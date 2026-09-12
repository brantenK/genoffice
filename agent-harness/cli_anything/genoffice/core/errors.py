class HarnessError(Exception):
    """An expected, user-actionable harness failure."""

    def __init__(self, message: str, code: str = "HARNESS_ERROR", *, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


class ProtocolError(HarnessError):
    """A transport or structured GenOffice automation protocol failure."""

    def __init__(self, message: str, code: str = "PROTOCOL_ERROR", *, status=None, details=None):
        super().__init__(message, code, details=details)
        self.status = status
