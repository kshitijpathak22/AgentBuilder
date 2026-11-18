"""
Global Exception Handlers for Sales Coach API
Provides consistent error responses across all endpoints.
"""
from fastapi import Request, status
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from shared_logger import get_logger

logger = get_logger(__name__)


def get_request_id(request: Request) -> str:
    """Safely extract request ID from request state."""
    return getattr(request.state, "request_id", "unknown")


async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    """Handle HTTP exceptions with consistent format."""
    request_id = get_request_id(request)
    logger.warning(
        "HTTP %s on %s %s [request_id=%s]: %s",
        exc.status_code,
        request.method,
        request.url.path,
        request_id,
        exc.detail,
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": True,
            "status_code": exc.status_code,
            "detail": exc.detail,
            "request_id": request_id,
        },
        headers=exc.headers if hasattr(exc, "headers") and exc.headers else None,
    )


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Handle Pydantic validation errors with user-friendly messages."""
    request_id = get_request_id(request)
    errors = []
    for error in exc.errors():
        field = " -> ".join(str(loc) for loc in error["loc"])
        errors.append({"field": field, "message": error["msg"]})

    logger.warning(
        "Validation error on %s %s [request_id=%s]: %s",
        request.method,
        request.url.path,
        request_id,
        errors,
    )
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "error": True,
            "status_code": 422,
            "detail": "Validation error",
            "errors": errors,
            "request_id": request_id,
        },
    )


async def generic_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Handle unexpected exceptions with safe error messages."""
    request_id = get_request_id(request)
    logger.exception(
        "Unhandled exception on %s %s [request_id=%s]: %s",
        request.method,
        request.url.path,
        request_id,
        str(exc),
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": True,
            "status_code": 500,
            "detail": "An unexpected internal error occurred. Please try again later.",
            "request_id": request_id,
        },
    )


def register_exception_handlers(app):
    """
    Register all exception handlers on the FastAPI application.
    Call this during app setup.
    """
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, generic_exception_handler)
    logger.info("Exception handlers registered")