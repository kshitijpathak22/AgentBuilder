"""
Amazon Nova 2 Sonic usage-event parsing and session usage aggregation.

Nova usageEvent messages can contain both incremental delta usage and
cumulative totals. This module prefers cumulative totals and falls back
to incremental delta aggregation when totals are unavailable.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class NovaUsage:
    """Normalized Nova token usage."""

    text_input_tokens: int = 0
    text_output_tokens: int = 0
    audio_input_tokens: int = 0
    audio_output_tokens: int = 0

    generic_input_tokens: int = 0
    generic_output_tokens: int = 0

    total_tokens: int = 0
    mode: str = "unknown"
    provider_event_id: Optional[str] = None


def _clean_key(value: Any) -> str:
    """Normalize dictionary keys for tolerant matching."""
    return re.sub(
        r"[^a-z0-9]+",
        "",
        str(value or "").lower(),
    )


def _safe_int(value: Any) -> int:
    """Convert a numeric-looking value to a non-negative integer."""
    try:
        return max(int(value or 0), 0)
    except (TypeError, ValueError):
        return 0


def _find_usage_payload(
    event: Any,
) -> Optional[dict[str, Any]]:
    """
    Find and return a normalized Nova usage payload.

    Supports:
    1. Raw AWS usageEvent wrappers
    2. LangChain-normalized usage events
    3. Direct usage payloads
    """
    if not isinstance(event, dict):
        return None

    # Raw AWS-style wrapper:
    # {
    #     "event": {
    #         "usageEvent": {...}
    #     }
    # }
    wrapped = event.get("event")

    if isinstance(wrapped, dict):
        for key, value in wrapped.items():
            if (
                _clean_key(key)
                in {
                    "usage",
                    "usageevent",
                }
                and isinstance(value, dict)
            ):
                return value

    # Direct AWS-style event:
    # {
    #     "usageEvent": {...}
    # }
    for key, value in event.items():
        if (
            _clean_key(key)
            in {
                "usage",
                "usageevent",
            }
            and isinstance(value, dict)
        ):
            return value

    event_type = _clean_key(
        event.get("type")
        or event.get("eventType")
        or event.get("name")
    )

    # LangChain-normalized event:
    # {
    #     "type": "usage",
    #     "usage": {...}
    # }
    if event_type in {
        "usage",
        "usageevent",
    }:
        usage = event.get("usage")

        if isinstance(usage, dict):
            return usage

        usage_event = event.get("usageEvent")

        if isinstance(usage_event, dict):
            return usage_event

        # Some integrations place token fields directly beside type.
        return event

    return None


def _flatten_numeric_values(
    value: Any,
    path: tuple[str, ...] = (),
) -> list[tuple[str, int]]:
    """Flatten numeric leaves into normalized path/value pairs."""
    output: list[tuple[str, int]] = []

    if isinstance(value, dict):
        for key, child in value.items():
            output.extend(
                _flatten_numeric_values(
                    child,
                    path + (_clean_key(key),),
                )
            )
        return output

    if isinstance(value, list):
        for index, child in enumerate(value):
            output.extend(
                _flatten_numeric_values(
                    child,
                    path + (str(index),),
                )
            )
        return output

    if isinstance(value, bool):
        return output

    if isinstance(value, (int, float)):
        output.append((".".join(path), _safe_int(value)))
        return output

    if isinstance(value, str):
        stripped = value.strip()
        if stripped.isdigit():
            output.append((".".join(path), _safe_int(stripped)))

    return output


def _path_has(path: str, *terms: str) -> bool:
    normalized = _clean_key(path)
    return all(_clean_key(term) in normalized for term in terms)


def _extract_value(
    flattened: list[tuple[str, int]],
    *,
    direction: str,
    modality: str,
) -> int:
    """
    Find a modality/direction token value.

    Supports aliases such as:
    inputSpeechTokens
    speechInputTokens
    inputAudioTokens
    audioInputTokens
    """
    modality_aliases = {
        "text": ("text",),
        "audio": ("audio", "speech"),
    }

    matches: list[int] = []

    for path, value in flattened:
        normalized_path = _clean_key(path)

        if direction not in normalized_path:
            continue

        if "token" not in normalized_path:
            continue

        if not any(
            alias in normalized_path
            for alias in modality_aliases[modality]
        ):
            continue

        matches.append(value)

    return max(matches, default=0)

def _extract_generic_direction_tokens(
    flattened: list[tuple[str, int]],
    direction: str,
) -> int:
    """
    Extract generic inputTokens/outputTokens when Nova does not
    provide a text/audio modality breakdown.
    """
    matches: list[int] = []

    for path, value in flattened:
        normalized_path = _clean_key(path)

        if direction not in normalized_path:
            continue

        if "token" not in normalized_path:
            continue

        # These fields are already handled by modality extraction.
        if "text" in normalized_path:
            continue

        if "audio" in normalized_path or "speech" in normalized_path:
            continue

        # Do not treat totalTokens as input or output.
        if "totaltokens" in normalized_path:
            continue

        matches.append(value)

    return max(matches, default=0)

def _select_usage_section(
    payload: dict[str, Any],
) -> tuple[dict[str, Any], str]:
    """
    Prefer cumulative total usage.

    Falls back to delta usage when cumulative totals are absent.
    """
    details = payload.get("details")

    candidates: list[tuple[Any, str]] = [
        (payload.get("total"), "total"),
        (payload.get("totals"), "total"),
        (payload.get("cumulative"), "total"),
        (payload.get("cumulativeTotal"), "total"),
        (
            details.get("total")
            if isinstance(details, dict)
            else None,
            "total",
        ),
        (
            details.get("totals")
            if isinstance(details, dict)
            else None,
            "total",
        ),
        (
            details.get("cumulative")
            if isinstance(details, dict)
            else None,
            "total",
        ),
        (payload.get("delta"), "delta"),
        (
            details.get("delta")
            if isinstance(details, dict)
            else None,
            "delta",
        ),
    ]

    for candidate, mode in candidates:
        if isinstance(candidate, dict) and candidate:
            return candidate, mode

    return payload, "unknown"


def extract_nova_usage_event(event: Any) -> Optional[NovaUsage]:
    """Normalize a Nova 2 Sonic usageEvent."""
    payload = _find_usage_payload(event)

    if not payload:
        return None

    section, mode = _select_usage_section(payload)
    flattened = _flatten_numeric_values(section)

    text_input = _extract_value(
        flattened,
        direction="input",
        modality="text",
    )
    text_output = _extract_value(
        flattened,
        direction="output",
        modality="text",
    )
    audio_input = _extract_value(
        flattened,
        direction="input",
        modality="audio",
    )
    audio_output = _extract_value(
        flattened,
        direction="output",
        modality="audio",
    )
    generic_input = _extract_generic_direction_tokens(
        flattened,
        direction="input",
    )

    generic_output = _extract_generic_direction_tokens(
        flattened,
        direction="output",
    )

    modality_total = (
        text_input
        + text_output
        + audio_input
        + audio_output
    )

    generic_direction_total = (
        generic_input
        + generic_output
    )

    explicit_total = 0

    for path, value in flattened:
        normalized_path = _clean_key(path)

        if "totaltokens" in normalized_path:
            explicit_total = max(explicit_total, value)

    total_tokens = max(
        modality_total,
        generic_direction_total,
        explicit_total,
    )
    if total_tokens == 0:
        # Generic fallback for unexpected provider formats.
        generic_total = 0

        for path, value in flattened:
            normalized_path = _clean_key(path)

            if (
                "totaltokens" in normalized_path
                or normalized_path.endswith("tokens")
            ):
                generic_total = max(generic_total, value)

        total_tokens = generic_total

    provider_event_id = (
        payload.get("eventId")
        or payload.get("completionId")
        or payload.get("sessionId")
    )

    return NovaUsage(
        text_input_tokens=text_input,
        text_output_tokens=text_output,
        audio_input_tokens=audio_input,
        audio_output_tokens=audio_output,
        generic_input_tokens=generic_input,
        generic_output_tokens=generic_output,
        total_tokens=total_tokens,
        mode=mode,
        provider_event_id=(
            str(provider_event_id)
            if provider_event_id
            else None
        ),
    )


def extract_azure_usage_event(event: Any) -> Optional[NovaUsage]:
    """Normalize an Azure gpt-realtime `response.done` usage payload."""
    if not isinstance(event, dict) or event.get("type") != "response.done":
        return None

    response = event.get("response")
    usage = response.get("usage") if isinstance(response, dict) else None
    if not isinstance(usage, dict):
        return None

    input_details = usage.get("input_token_details") or {}
    output_details = usage.get("output_token_details") or {}

    text_input = _safe_int(input_details.get("text_tokens"))
    audio_input = _safe_int(input_details.get("audio_tokens"))
    text_output = _safe_int(output_details.get("text_tokens"))
    audio_output = _safe_int(output_details.get("audio_tokens"))

    total_tokens = _safe_int(usage.get("total_tokens")) or (
        text_input + audio_input + text_output + audio_output
    )

    response_id = response.get("id") if isinstance(response, dict) else None

    return NovaUsage(
        text_input_tokens=text_input,
        text_output_tokens=text_output,
        audio_input_tokens=audio_input,
        audio_output_tokens=audio_output,
        total_tokens=total_tokens,
        mode="delta",
        provider_event_id=str(response_id) if response_id else None,
    )


def apply_usage_update(
    current: NovaUsage,
    update: NovaUsage,
) -> NovaUsage:
    """
    Apply a Nova usage event to the session accumulator.

    Cumulative totals replace current values using max().
    Delta values are incrementally added.
    """
    previous_total = current.total_tokens

    if update.mode == "delta":
        current.text_input_tokens += update.text_input_tokens
        current.text_output_tokens += update.text_output_tokens
        current.audio_input_tokens += update.audio_input_tokens
        current.audio_output_tokens += update.audio_output_tokens
        current.generic_input_tokens += update.generic_input_tokens
        current.generic_output_tokens += update.generic_output_tokens
    else:
        current.text_input_tokens = max(
            current.text_input_tokens,
            update.text_input_tokens,
        )
        current.text_output_tokens = max(
            current.text_output_tokens,
            update.text_output_tokens,
        )
        current.audio_input_tokens = max(
            current.audio_input_tokens,
            update.audio_input_tokens,
        )
        current.audio_output_tokens = max(
            current.audio_output_tokens,
            update.audio_output_tokens,
        )
        current.generic_input_tokens = max(
            current.generic_input_tokens,
            update.generic_input_tokens,
        )
        current.generic_output_tokens = max(
            current.generic_output_tokens,
            update.generic_output_tokens,
        )

    modality_total = (
        current.text_input_tokens
        + current.text_output_tokens
        + current.audio_input_tokens
        + current.audio_output_tokens
    )

    generic_direction_total = (
        current.generic_input_tokens
        + current.generic_output_tokens
    )

    if update.mode == "delta":
        update_modality_total = (
            update.text_input_tokens
            + update.text_output_tokens
            + update.audio_input_tokens
            + update.audio_output_tokens
        )

        update_generic_total = (
            update.generic_input_tokens
            + update.generic_output_tokens
        )

        represented_update_total = max(
            update_modality_total,
            update_generic_total,
        )

        unclassified_delta = max(
            update.total_tokens - represented_update_total,
            0,
        )

        current.total_tokens = max(
            modality_total,
            generic_direction_total,
            previous_total + represented_update_total + unclassified_delta,
        )
    else:
        current.total_tokens = max(
            modality_total,
            generic_direction_total,
            previous_total,
            update.total_tokens,
        )

    current.mode = update.mode

    if update.provider_event_id:
        current.provider_event_id = update.provider_event_id

    return current