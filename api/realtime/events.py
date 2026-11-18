"""
Event parsing, transcript normalisation, deduplication, and prefix stripping for Nova Sonic streams.
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from typing import Any, Optional

from api.realtime.audio import b64e
from api.realtime.stats import GLOBAL_STATS

TEXT_DEDUPE_TTL_SECONDS = float(os.getenv("TEXT_DEDUPE_TTL_SECONDS", "2.0"))
MAX_RECENT_TEXTS = int(os.getenv("MAX_RECENT_TEXTS", "64"))


def json_safe(value: Any) -> Any:
    """Make arbitrary event payload JSON serializable."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"encoding": "base64", "data": b64e(bytes(value))}
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(v) for v in value]
    try:
        json.dumps(value)
        return value
    except TypeError:
        return str(value)


def normalise_text(text: str) -> str:
    """Normalize text by collapsing whitespace and lowercasing."""
    return " ".join(text.split()).strip().lower()


def find_text(event: Any) -> Optional[str]:
    """Extract text content from various event dictionary structures."""
    if isinstance(event, str):
        text = event.strip()
        return text if text else None
    if not isinstance(event, dict):
        return None

    event_type = str(event.get("type", "")).lower()
    if event_type in {"audio", "audiooutput", "audio_output"}:
        return None

    for key in (
        "text",
        "transcript",
        "outputText",
        "inputTranscript",
        "outputTranscript",
    ):
        value = event.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    for key, value in event.items():
        if key.lower() in {
            "audio",
            "audiodata",
            "audiooutput",
            "audio_output",
            "bytes",
            "data",
        }:
            continue
        if isinstance(value, dict):
            found = find_text(value)
            if found:
                return found
        elif isinstance(value, list):
            for item in value:
                found = find_text(item)
                if found:
                    return found
    return None


def _event_payload(event: Any) -> tuple[str, dict[str, Any]]:
    """Normalize LangChain and raw AWS Nova Sonic event shapes."""
    if not isinstance(event, dict):
        return "", {}

    wrapped = event.get("event")
    if isinstance(wrapped, dict) and wrapped:
        name, payload = next(iter(wrapped.items()))
        return str(name), payload if isinstance(payload, dict) else {"value": payload}

    event_type = str(
        event.get("type") or event.get("eventType") or event.get("name") or ""
    )
    return event_type, event


def _parse_additional_model_fields(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _first_present(payload: dict[str, Any], keys: tuple[str, ...]) -> Optional[str]:
    for key in keys:
        value = payload.get(key)
        if value is not None:
            return str(value)
    return None


def _clean_event_name(value: str) -> str:
    return str(value or "").replace("_", "").replace("-", "").lower()


def _normalise_role(value: Any) -> str:
    role = str(value or "").strip().lower()
    if role in {"user", "human", "customer"}:
        return "user"
    if role in {"assistant", "ai", "agent"}:
        return "assistant"
    if role == "system":
        return "system"
    return "assistant"


def _normalise_transcript_text(value: str) -> str:
    return " ".join(str(value or "").split()).strip()


def _tokenise_for_prefix(value: str) -> list[str]:
    normalised = re.sub(r"[^a-zA-Z0-9']+", " ", str(value or "").lower())
    return [part for part in normalised.split() if part]


def _strip_token_prefix(text: str, prefix: str) -> str:
    text = _normalise_transcript_text(text)
    prefix_tokens = _tokenise_for_prefix(prefix)
    text_tokens = _tokenise_for_prefix(text)
    if not text or not prefix_tokens or len(text_tokens) <= len(prefix_tokens):
        return text
    if text_tokens[: len(prefix_tokens)] != prefix_tokens:
        return text
    return " ".join(text_tokens[len(prefix_tokens) :]).strip()


def strip_previous_assistant_prefix(client: Any, text: str) -> str:
    """Remove cumulative assistant transcript prefixes already emitted to the UI."""
    cleaned = _normalise_transcript_text(text)
    if not cleaned or not client.assistant_transcript_history:
        return cleaned

    cleaned_key = normalise_text(cleaned)
    if any(
        normalise_text(existing) == cleaned_key
        for existing in client.assistant_transcript_history
    ):
        return ""

    all_previous = " ".join(client.assistant_transcript_history)
    stripped = _strip_token_prefix(cleaned, all_previous)
    if stripped != cleaned:
        return stripped

    stripped = _strip_token_prefix(
        cleaned, client.assistant_transcript_history[-1]
    )
    if stripped != cleaned:
        return stripped

    return cleaned


def should_emit_transcript(client: Any, role: str, text: str) -> bool:
    key = normalise_text(f"{role}:{text}")
    if not key:
        return False
    now = time.monotonic()
    cutoff = now - max(TEXT_DEDUPE_TTL_SECONDS, 15.0)
    for old_key, ts in list(client.emitted_transcript_keys.items()):
        if ts < cutoff:
            client.emitted_transcript_keys.pop(old_key, None)
    if key in client.emitted_transcript_keys:
        client.emitted_transcript_keys[key] = now
        return False
    client.emitted_transcript_keys[key] = now
    while len(client.emitted_transcript_keys) > MAX_RECENT_TEXTS:
        client.emitted_transcript_keys.popitem(last=False)
    return True


def remember_nova_content_start(
    client: Any, event: Any
) -> Optional[dict[str, Any]]:
    event_name, payload = _event_payload(event)
    if _clean_event_name(event_name) != "contentstart" or not payload:
        return None

    fields = _parse_additional_model_fields(payload.get("additionalModelFields"))
    content_id = (
        _first_present(
            payload, ("contentId", "contentName", "content_id", "content_name")
        )
        or str(uuid.uuid4())
    )
    role = _normalise_role(payload.get("role") or fields.get("role"))
    generation_stage = (
        str(fields.get("generationStage") or payload.get("generationStage") or "")
        .strip()
        .upper()
    )
    content_type = (
        str(
            payload.get("type")
            or payload.get("contentType")
            or payload.get("mediaType")
            or ""
        )
        .strip()
        .upper()
    )

    meta = {
        "content_id": content_id,
        "role": role,
        "generation_stage": generation_stage,
        "content_type": content_type,
    }
    client.nova_content_meta[content_id] = meta
    client.nova_active_content_id = content_id
    client.nova_active_role = role
    client.nova_active_generation_stage = generation_stage
    client.nova_text_buffers.setdefault(content_id, [])
    return meta


def extract_nova_text_payload(
    client: Any, event: Any
) -> Optional[dict[str, Any]]:
    event_name, payload = _event_payload(event)
    if not payload:
        return None

    clean_name = _clean_event_name(event_name)
    event_type = _clean_event_name(str(payload.get("type", "")))
    if (
        clean_name
        in {
            "audio",
            "audiooutput",
            "contentend",
            "completionend",
            "usageevent",
        }
        or event_type in {"audio", "audiooutput"}
    ):
        return None

    text = None
    for key in (
        "content",
        "text",
        "transcript",
        "outputText",
        "inputTranscript",
        "outputTranscript",
    ):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            text = value.strip()
            break

    if not text and clean_name in {"text", "textoutput", "transcript", "asr"}:
        text = find_text(payload)

    if not text:
        return None

    fields = _parse_additional_model_fields(payload.get("additionalModelFields"))
    content_id = (
        _first_present(
            payload, ("contentId", "contentName", "content_id", "content_name")
        )
        or client.nova_active_content_id
        or str(uuid.uuid4())
    )
    meta = client.nova_content_meta.get(content_id, {})
    role = _normalise_role(
        payload.get("role")
        or fields.get("role")
        or meta.get("role")
        or client.nova_active_role
    )
    generation_stage = str(
        fields.get("generationStage")
        or payload.get("generationStage")
        or meta.get("generation_stage")
        or client.nova_active_generation_stage
        or ""
    ).strip().upper()

    return {
        "content_id": content_id,
        "role": role,
        "text": _normalise_transcript_text(text),
        "generation_stage": generation_stage,
    }


def extract_nova_content_end(
    client: Any, event: Any
) -> Optional[dict[str, Any]]:
    event_name, payload = _event_payload(event)
    if _clean_event_name(event_name) != "contentend":
        return None

    content_id = (
        _first_present(
            payload, ("contentId", "contentName", "content_id", "content_name")
        )
        if payload
        else None
    )
    content_id = content_id or client.nova_active_content_id
    meta = client.nova_content_meta.get(content_id or "", {})
    return {
        "content_id": content_id,
        "role": meta.get("role") or client.nova_active_role,
        "generation_stage": (
            meta.get("generation_stage") or client.nova_active_generation_stage
        ),
        "content_type": meta.get("content_type", ""),
    }


async def emit_final_transcript(
    client: Any,
    ws: Any,
    role: str,
    text: str,
    content_id: Optional[str] = None,
) -> None:
    role = _normalise_role(role)
    text = _normalise_transcript_text(text)
    if not text or role == "system":
        return

    if role == "assistant":
        text = strip_previous_assistant_prefix(client, text)
        if not text:
            return

    if not should_emit_transcript(client, role, text):
        return

    client.text_events += 1
    GLOBAL_STATS.text_events += 1
    await client.send(
        ws,
        {
            "type": "transcript",
            "role": role,
            "text": text,
            "final": True,
            "content_id": content_id,
            "source": "nova",
        },
    )

    if role == "assistant":
        client.assistant_transcript_history.append(text)
        client.assistant_transcript_history[:] = (
            client.assistant_transcript_history[-30:]
        )
