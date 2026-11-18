"""
Audio utilities, base64 encoding/decoding, timing helpers.
"""
from __future__ import annotations

import asyncio
import base64
import time
from typing import Any, Optional

import numpy as np


def b64e(data: bytes) -> str:
    """Encode bytes to ASCII base64 string."""
    return base64.b64encode(data).decode("ascii")


def b64d(value: str) -> bytes:
    """Decode ASCII base64 string to bytes."""
    return base64.b64decode(value, validate=True)


def resample_pcm16(pcm_bytes: bytes, src_rate: int, dst_rate: int) -> bytes:
    """Linearly resample 16-bit mono little-endian PCM audio between sample rates."""
    if src_rate == dst_rate or not pcm_bytes:
        return pcm_bytes
    samples = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float64)
    if samples.size == 0:
        return pcm_bytes
    dst_count = max(int(round(samples.size * dst_rate / src_rate)), 1)
    src_positions = np.arange(samples.size, dtype=np.float64)
    dst_positions = np.linspace(0, samples.size - 1, num=dst_count, dtype=np.float64)
    resampled = np.interp(dst_positions, src_positions, samples)
    return resampled.astype("<i2").tobytes()


def now_ms() -> int:
    """Current epoch timestamp in milliseconds."""
    return int(time.time() * 1000)


def monotonic_ms() -> float:
    """Monotonic clock in milliseconds."""
    return time.monotonic() * 1000.0


def find_audio(event: Any) -> Optional[str]:
    """Recursively search an event structure for base64 audio data."""
    if not isinstance(event, dict):
        return None
    if event.get("encoding") == "base64" and isinstance(event.get("data"), str):
        return event["data"]
    for key in ("audio", "audioData", "audioOutput", "audio_output", "data", "bytes"):
        value = event.get(key)
        if isinstance(value, str) and len(value) > 80:
            return value
        if isinstance(value, dict):
            result = find_audio(value)
            if result:
                return result
    for value in event.values():
        if isinstance(value, dict):
            result = find_audio(value)
            if result:
                return result
        elif isinstance(value, list):
            for item in value:
                result = find_audio(item)
                if result:
                    return result
    return None


async def fallback_reply(
    client: Any, ws: Any, text: str, sample_rate: int = 24000
) -> None:
    """Send clean text response when Nova voice synthesis is unavailable (text-only fallback)."""
    await client.send(
        ws,
        {
            "type": "transcript",
            "role": "assistant",
            "text": text,
            "fallback": True,
            "source": "fallback",
        },
    )

