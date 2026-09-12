import logging
from urllib.parse import urlsplit

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger(__name__)

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


class SameOriginOnly:
    """Pure-ASGI, not BaseHTTPMiddleware: the latter buffers through an
    anyio stream and would sit between the client and a streaming response."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or self._permitted(scope):
            await self.app(scope, receive, send)
            return

        response = JSONResponse({"detail": "cross-origin request rejected"}, status_code=403)
        await response(scope, receive, send)

    def _permitted(self, scope: Scope) -> bool:
        if scope["method"] in SAFE_METHODS:
            return True

        origins = [value for name, value in scope["headers"] if name == b"origin"]
        if not origins:
            return True

        hosts = [value for name, value in scope["headers"] if name == b"host"]
        if len(origins) > 1 or len(hosts) != 1:
            logger.warning(f"rejected {scope['method']} {scope['path']}: {len(origins)} Origin / {len(hosts)} Host headers")
            return False

        if urlsplit(origins[0]).netloc == hosts[0]:
            return True

        logger.warning(f"rejected cross-origin {scope['method']} {scope['path']} from {origins[0]!r} (host {hosts[0]!r})")
        return False
