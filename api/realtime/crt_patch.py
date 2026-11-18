"""AWS CRT cancelled-future teardown race workaround."""
from __future__ import annotations

from shared_logger import get_logger

logger = get_logger(__name__)


def patch_awscrt_cancelled_future_race() -> None:
    """Suppress only the known AWS CRT asyncio cancelled-future teardown race."""
    try:
        import concurrent.futures
        import awscrt.aio.http as aio_http
    except Exception:
        return

    if getattr(aio_http, "_nova_cancelled_future_patch", False):
        return

    patched_any = False
    for class_name in (
        "AIOHttpClientStream",
        "AIOHttpClientStreamUnified",
        "HttpClientStream",
        "Http2ClientStream",
    ):
        cls = getattr(aio_http, class_name, None)
        if cls is None:
            continue
        for method_name in ("_on_body", "_on_complete"):
            original = getattr(cls, method_name, None)
            if not callable(original) or getattr(original, "_nova_patched", False):
                continue

            def make_safe(fn):
                def safe_method(self, *args, **kwargs):
                    try:
                        return fn(self, *args, **kwargs)
                    except concurrent.futures.InvalidStateError as exc:
                        if "CANCELLED" in str(exc):
                            return None
                        raise

                safe_method._nova_patched = True
                return safe_method

            setattr(cls, method_name, make_safe(original))
            patched_any = True

    aio_http._nova_cancelled_future_patch = True
    if patched_any:
        logger.info("Applied AWS CRT cancelled-future teardown patch")
