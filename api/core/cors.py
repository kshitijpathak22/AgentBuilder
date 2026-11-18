"""
Centralized CORS configuration for Sales Coach API
Single source of truth for CORS middleware settings.
Uses config-driven origins - NEVER uses wildcard "*" with credentials.
"""
from fastapi.middleware.cors import CORSMiddleware
from api.core.config import CORS_ALLOWED_ORIGINS, IS_PRODUCTION


def setup_cors(app):
    """
    Configure and apply CORS middleware to the FastAPI application.

    Security note: allow_credentials=True requires explicit origins,
    not wildcards. Origins are configured via CORS_ALLOWED_ORIGINS env var.
    """
    if IS_PRODUCTION and not CORS_ALLOWED_ORIGINS:
        raise RuntimeError(
            "CORS_ALLOWED_ORIGINS must be set in production. "
            "Set the CORS_ALLOWED_ORIGINS environment variable."
        )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
        expose_headers=["X-Request-ID", "X-RateLimit-Remaining", "X-RateLimit-Limit", "Retry-After"],
    )
