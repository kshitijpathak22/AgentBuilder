"""OCR for scanned PDFs via Azure AI Document Intelligence (REST API v4.0, prebuilt-read model).

Only used when a PDF has no text layer. Synchronous on purpose: callers run it in a worker thread.
"""
from __future__ import annotations

import base64
import time
from typing import Optional

import httpx

from api.core.config import (
    AZURE_DOC_INTELLIGENCE_ENDPOINT,
    AZURE_DOC_INTELLIGENCE_KEY,
    AZURE_DOC_INTELLIGENCE_TIMEOUT_SECONDS,
)
from shared_logger import get_logger

logger = get_logger(__name__)

API_VERSION = "2024-11-30"
MODEL_ID = "prebuilt-read"


class OcrError(Exception):
    """OCR could not produce text (service error, timeout, or failed analysis)."""


def ocr_configured() -> bool:
    return bool(AZURE_DOC_INTELLIGENCE_ENDPOINT and AZURE_DOC_INTELLIGENCE_KEY)


def ocr_pdf(file_path: str, client: Optional[httpx.Client] = None) -> str:
    """Return the text of a scanned PDF, page by page, in the same layout as the normal PDF extractor."""
    if not ocr_configured():
        raise OcrError("OCR is not configured")
    with open(file_path, "rb") as f:
        payload = {"base64Source": base64.b64encode(f.read()).decode("ascii")}

    headers = {"Ocp-Apim-Subscription-Key": AZURE_DOC_INTELLIGENCE_KEY}
    url = (
        f"{AZURE_DOC_INTELLIGENCE_ENDPOINT}/documentintelligence/documentModels/{MODEL_ID}:analyze"
        f"?_overload=analyzeDocument&api-version={API_VERSION}"
    )
    own_client = client is None
    client = client or httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0))
    try:
        started = time.monotonic()
        resp = client.post(url, json=payload, headers=headers)
        if resp.status_code != 202:
            raise OcrError(f"analyze request failed: HTTP {resp.status_code} {resp.text[:200]}")
        poll_url = resp.headers.get("Operation-Location")
        if not poll_url:
            raise OcrError("analyze response had no Operation-Location header")

        while True:
            if time.monotonic() - started > AZURE_DOC_INTELLIGENCE_TIMEOUT_SECONDS:
                raise OcrError("timed out waiting for OCR")
            time.sleep(min(float(resp.headers.get("Retry-After", 1) or 1), 5.0))
            resp = client.get(poll_url, headers=headers)
            if resp.status_code != 200:
                raise OcrError(f"poll failed: HTTP {resp.status_code} {resp.text[:200]}")
            body = resp.json()
            status = body.get("status")
            if status == "succeeded":
                break
            if status in ("failed", "canceled"):
                raise OcrError(f"analysis {status}: {body.get('error')}")
    except httpx.HTTPError as exc:
        raise OcrError(f"could not reach Document Intelligence: {exc}") from exc
    finally:
        if own_client:
            client.close()

    result = body.get("analyzeResult") or {}
    pages = result.get("pages") or []
    parts = []
    for page in pages:
        text = "\n".join(line.get("content", "") for line in page.get("lines") or [] if line.get("content"))
        if text.strip():
            parts.append(f"\n--- Page {page.get('pageNumber', len(parts) + 1)} ---\n{text}\n")
    content = "".join(parts) or (result.get("content") or "")
    logger.info("OCR read %d page(s), %d characters in %.1fs", len(pages), len(content), time.monotonic() - started)
    return content
