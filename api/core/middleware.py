"""
Middleware for Sales Coach API
Includes rate limiting, request ID tracking, and security headers.
"""
import time
import uuid
from collections import defaultdict
from typing import Callable

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from api.core.config import (
    RATE_LIMIT_ENABLED,
    RATE_LIMIT_REQUESTS,
    RATE_LIMIT_WINDOW_SECONDS,
    AUTH_RATE_LIMIT_REQUESTS,
    AUTH_RATE_LIMIT_WINDOW_SECONDS,
    IS_PRODUCTION,
)
from shared_logger import get_logger

logger = get_logger(__name__)

# In-memory rate limiting records: key -> list of request timestamps
_rate_limit_records: defaultdict[str, list[float]] = defaultdict(list)


def check_rate_limit(key: str, max_requests: int, window_seconds: int) -> tuple[bool, int]:
    """
    Check if a request should be rate limited using an in-memory sliding window.

    Args:
        key: Unique identifier (e.g., IP address or IP+endpoint)
        max_requests: Maximum allowed requests in the window
        window_seconds: Time window in seconds

    Returns:
        Tuple of (is_allowed, remaining_requests)
    """
    if not RATE_LIMIT_ENABLED:
        return True, max_requests

    try:
        now = time.time()
        timestamps = _rate_limit_records[key]
        cutoff = now - window_seconds
        valid_timestamps = [t for t in timestamps if t > cutoff]
        if len(valid_timestamps) >= max_requests:
            _rate_limit_records[key] = valid_timestamps
            return False, 0
        valid_timestamps.append(now)
        _rate_limit_records[key] = valid_timestamps
        remaining = max_requests - len(valid_timestamps)
        return True, remaining
    except Exception as e:
        logger.error("Rate limit check error: %s", e)
        # Fail open - allow request if rate limiter fails
        return True, max_requests


def get_client_ip(request: Request) -> str:
    """Extract client IP from request, respecting proxy headers."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    real_ip = request.headers.get("X-Real-IP")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else "unknown"


# ── Request ID Middleware ─────────────────────────────────────────

class RequestIDMiddleware(BaseHTTPMiddleware):
    """
    Adds a unique X-Request-ID header to every response and makes it
    available for logging/tracing across the entire request lifecycle.
    """

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        request_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
        request.state.request_id = request_id

        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response


# ── Rate Limit Middleware ─────────────────────────────────────────

class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    Applies rate limiting to all API routes.
    Stricter limits are applied to authentication endpoints.
    """

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        if not RATE_LIMIT_ENABLED:
            return await call_next(request)

        client_ip = get_client_ip(request)
        path = request.url.path

        # Stricter rate limiting for auth endpoints
        if path.startswith("/auth/login"):
            max_req = AUTH_RATE_LIMIT_REQUESTS
            window = AUTH_RATE_LIMIT_WINDOW_SECONDS
        else:
            max_req = RATE_LIMIT_REQUESTS
            window = RATE_LIMIT_WINDOW_SECONDS

        rate_key = f"{client_ip}:{path}"
        allowed, remaining = check_rate_limit(rate_key, max_req, window)

        if not allowed:
            logger.warning(f"Rate limit exceeded for {rate_key}")
            return JSONResponse(
                status_code=429,
                content={
                    "detail": "Too many requests. Please try again later.",
                    "retry_after_seconds": window,
                },
                headers={"Retry-After": str(window)},
            )

        response = await call_next(request)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        response.headers["X-RateLimit-Limit"] = str(max_req)
        return response


# ── Security Headers Middleware ───────────────────────────────────

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """
    Adds security-related HTTP headers to all responses.
    """

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        response = await call_next(request)

        # Security headers
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains" if IS_PRODUCTION else "max-age=0"
        )
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

        return response