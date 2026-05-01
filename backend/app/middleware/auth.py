"""
HTTP Basic Auth middleware for the FastAPI backend.

Why we need this even though the Vercel frontend already gates access:
the Render URL is publicly resolvable. Without this, anyone who finds
that URL can hit /api/calls directly. So we gate at both layers with
the same credentials.

Bypassed paths:
  - /health (so Render's healthcheck works)
  - /api/webhooks/*  (Hunar isn't authenticated)
  - /docs, /openapi.json (FastAPI swagger — gate manually if you care)
"""
from __future__ import annotations

import base64
import secrets

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

BYPASS_PREFIXES = ("/health", "/api/webhooks/", "/docs", "/openapi.json", "/redoc")


class BasicAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, username: str, password: str | None) -> None:
        super().__init__(app)
        self.username = username
        self.password = password

    async def dispatch(self, request: Request, call_next):
        # If no password configured, treat as open (dev mode).
        if not self.password:
            return await call_next(request)

        # Bypass auth for paths that need to be public.
        for prefix in BYPASS_PREFIXES:
            if request.url.path.startswith(prefix):
                return await call_next(request)

        header = request.headers.get("authorization")
        if not header or not header.startswith("Basic "):
            return _challenge()

        try:
            decoded = base64.b64decode(header[6:]).decode("utf-8")
            user, _, pwd = decoded.partition(":")
        except Exception:
            return _challenge()

        # constant-time compare to avoid timing attacks
        if not (secrets.compare_digest(user, self.username) and secrets.compare_digest(pwd, self.password)):
            return _challenge()

        return await call_next(request)


def _challenge() -> Response:
    return Response(
        content="Authentication required",
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="Testbook AI Calling API"'},
    )
