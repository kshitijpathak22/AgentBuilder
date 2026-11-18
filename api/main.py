"""
Main FastAPI Application Entry Point
Single unified application with all routers, middleware, and centralized configuration.
"""
from dotenv import load_dotenv

load_dotenv(override=False)  # Keep host-provided env vars (for example Azure App Service settings) higher priority than .env

import os
import shutil

from fastapi import FastAPI
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from shared_logger import get_logger

# Core modules
from api.core.cors import setup_cors
from api.core.config import (
    validate_config,
    IS_PRODUCTION,
    OTEL_SERVICE_NAME,
    ALLOWED_USERS_PATH,
    BUNDLED_ALLOWED_USERS_PATH,
)
from api.core.database import init_database, check_database_health
from api.core.auth import _load_allowed_users
from api.core.middleware import (
    RequestIDMiddleware,
    RateLimitMiddleware,
    SecurityHeadersMiddleware,
)
from api.core.exceptions import register_exception_handlers

# Routers
from api.routers.db import router as db_router
from api.routers.document import router as document_router
from api.routers.ai import router as ai_router
from api.routers.auth import router as auth_router
from api.routers.realtime import router as realtime_router
from api.observability.otel_setup import setup_otel


logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan event handler.
    Runs startup initialization and shutdown cleanup.
    """
    # ── Startup ──────────────────────────────────────────────────
    otel_enabled = setup_otel(OTEL_SERVICE_NAME)

    logger.info(
        "OpenTelemetry export enabled: %s",
        otel_enabled,
    )
    logger.info("=" * 60)
    logger.info("Sales Coach API v2.1.0 starting up...")
    logger.info("Environment: %s", "production" if IS_PRODUCTION else "development")

    # Validate configuration
    config_warnings = validate_config()
    for warning in config_warnings:
        if warning.startswith("CRITICAL"):
            logger.critical(warning)
        else:
            logger.warning(warning)

    # First start with ALLOWED_USERS_PATH on persistent storage: seed it from the bundled list.
    if not os.path.exists(ALLOWED_USERS_PATH) and os.path.exists(BUNDLED_ALLOWED_USERS_PATH):
        os.makedirs(os.path.dirname(ALLOWED_USERS_PATH) or ".", exist_ok=True)
        shutil.copyfile(BUNDLED_ALLOWED_USERS_PATH, ALLOWED_USERS_PATH)
        logger.info("Seeded %s from the bundled allowed_users.json", ALLOWED_USERS_PATH)

    # Initialize database and users table
    try:
        init_database()
        # Verify allowed_users.json is loadable
        allowed = _load_allowed_users()
        if not allowed:
            logger.error("WARNING: No allowed users found in allowed_users.json!")
        else:
            logger.info(
                "Loaded %d allowed email(s) from allowed_users.json",
                len(allowed),
            )
        logger.info("Database initialized successfully")
    except Exception as e:
        logger.exception("Database initialization error: %s", e)

    # Check database health
    db_health = check_database_health()
    logger.info(
        "Database health: %s (sessions: %s)",
        db_health.get("status"),
        db_health.get("session_count", "N/A"),
    )

    logger.info("Sales Coach API is ready to accept requests")
    logger.info("=" * 60)

    yield

    # ── Shutdown ─────────────────────────────────────────────────
    logger.info("Sales Coach API shutting down...")


# ── Create FastAPI Application ───────────────────────────────────

app = FastAPI(
    title="Sales Coach Unified API",
    description=(
        "Combined API for Sales Coach platform: "
        "Database, Document Processing, AI Services, and Multi-User Auth"
    ),
    version="2.1.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

# ── Apply Middleware (order matters!) ────────────────────────────

# 1. Request ID - adds X-Request-ID to all responses
app.add_middleware(RequestIDMiddleware)

# 2. Security headers - adds security-related HTTP headers
app.add_middleware(SecurityHeadersMiddleware)

# 3. Rate limiting - protects against abuse
app.add_middleware(RateLimitMiddleware)

# 4. CORS - cross-origin resource sharing (applied last so other middleware runs first)
setup_cors(app)

# ── Register Exception Handlers ──────────────────────────────────

register_exception_handlers(app)

# ── Global Root Endpoints ────────────────────────────────────────


@app.get("/", tags=["root"])
def root():
    """Global root endpoint - Sales Coach unified API info."""
    logger.info("Root endpoint called")
    return {
        "message": "Sales Coach Unified API",
        "version": "2.1.0",
        "status": "running",
        "environment": "production" if IS_PRODUCTION else "development",
        "available_endpoints": {
            "/docs": "Swagger UI documentation",
            "/redoc": "Redoc documentation",
            "/health": "Health check",
            "/auth/*": "Authentication (login, token refresh, user management)",
            "/db/*": "Database and session management API",
            "/documents/*": "Document processing API",
            "/ai/*": "AI analysis, client simulation, and reporting API",
            "/realtime/*": "Nova Sonic voice session bootstrap API",
            "/ws/nova2-sonic": "Nova Sonic bidirectional WebSocket",
            "/api/connectivity/stats": "Nova Sonic connectivity diagnostics",
        },
    }


@app.get("/health", tags=["root"])
def health_check():
    """Global health check endpoint with dependency status."""
    logger.info("Health check endpoint called")

    # Check database
    db_health = check_database_health()

    # Determine overall status
    all_healthy = db_health.get("status") == "healthy"
    overall_status = "healthy" if all_healthy else "degraded"

    return {
        "status": overall_status,
        "service": "Sales Coach Unified API",
        "version": "2.1.0",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "dependencies": {
            "database": db_health,
        },
    }


# ── Mount Routers ────────────────────────────────────────────────

# Auth router (mounted first so /auth/login is available without auth)
app.include_router(auth_router)

# Database router with /db prefix
app.include_router(db_router)

# Document processing router with /documents prefix
app.include_router(document_router)

# AI services router with /ai prefix
app.include_router(ai_router)

# Realtime / Nova Sonic router (routes register their own full paths)
app.include_router(realtime_router)


# ── Run (development only) ───────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    from api.core.config import SERVER_HOST, SERVER_PORT

    uvicorn.run(
        "api.main:app",
        host=SERVER_HOST,
        port=SERVER_PORT,
        reload=True,
        log_level="info",
    )
