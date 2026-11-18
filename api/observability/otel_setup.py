"""
Optional Azure Monitor OpenTelemetry bootstrap.

The application continues normally when Azure Monitor is not configured
or its package is unavailable.
"""
from __future__ import annotations

import os

from shared_logger import get_logger


logger = get_logger(__name__)

_initialized = False


def setup_otel(service_name: str = "sales-coach-api") -> bool:
    """Configure Azure Monitor/OpenTelemetry once per process."""
    global _initialized

    if _initialized:
        return True

    connection_string = os.getenv(
        "APPLICATIONINSIGHTS_CONNECTION_STRING",
        "",
    ).strip()

    if not connection_string:
        logger.info(
            "Application Insights connection string not configured; "
            "OpenTelemetry export disabled"
        )
        return False

    try:
        from azure.monitor.opentelemetry import (
            configure_azure_monitor,
        )
        from opentelemetry.sdk.resources import (
            Resource,
            SERVICE_NAME,
        )

        configure_azure_monitor(
            connection_string=connection_string,
            resource=Resource.create(
                {
                    SERVICE_NAME: service_name,
                }
            ),
        )

        _initialized = True

        logger.info(
            "Azure Monitor OpenTelemetry enabled | service=%s",
            service_name,
        )

        return True

    except ImportError as exc:
        logger.warning(
            "Azure Monitor OpenTelemetry package unavailable: %s",
            exc,
        )
        return False

    except Exception:
        logger.exception(
            "Failed to initialize Azure Monitor OpenTelemetry"
        )
        return False