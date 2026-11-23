"""Request-size caps, enforced before a body is spooled or parsed.

Starlette writes a multipart body to a temp file before the endpoint (or the
feature gate, or auth) runs, and FastAPI reads and parses a JSON body before
the handler's own checks, so a size check in the handler comes too late. This
pure-ASGI middleware looks at Content-Length up front and counts bytes for
chunked bodies, answering 413 once the cap is exceeded. A request on a path it
does not cover costs one match on the path.
"""

import json
import re
from typing import Any

from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

DETAIL = "files_too_large"


class BodyLimit:
    """413 with `{"detail": detail}` for a body above `max_bytes` on a path that
    matches the regular expression `paths` whole."""

    def __init__(
        self, app: ASGIApp, *, max_bytes: int, paths: str, detail: Any
    ) -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.paths = re.compile(paths, re.DOTALL)
        self.detail = detail

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not self.paths.fullmatch(scope["path"]):
            await self.app(scope, receive, send)
            return

        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None:
            try:
                too_big = int(declared) > self.max_bytes
            except ValueError:
                too_big = False  # malformed: let the server stack reject it
            if too_big:
                await self._reject(send)
                return

        total = 0

        async def counting_receive() -> Message:
            nonlocal total
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > self.max_bytes:
                    # An HTTPException survives FastAPI's body-parsing error
                    # handling and is rendered as the 413 by the router.
                    raise HTTPException(413, self.detail)
            return message

        await self.app(scope, counting_receive, send)

    async def _reject(self, send: Send) -> None:
        body = json.dumps({"detail": self.detail}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                    (b"connection", b"close"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


class SupportBodyLimit(BodyLimit):
    """The support API's cap: every path at or under `prefix`."""

    def __init__(self, app: ASGIApp, *, max_bytes: int, prefix: str) -> None:
        super().__init__(
            app,
            max_bytes=max_bytes,
            paths=re.escape(prefix.rstrip("/")) + "(/.*)?",
            detail=DETAIL,
        )
