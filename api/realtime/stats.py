"""
Rolling statistics, throughput calculation, EWMA latency tracking, and diagnostic telemetry.
"""
from __future__ import annotations

import os
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, List, Optional

from api.core.config import (
    AWS_REGION,
    NOVA_INPUT_AUDIO_SAMPLE_RATE,
    NOVA_MODEL_ID,
    NOVA_OUTPUT_AUDIO_SAMPLE_RATE,
)
from api.realtime.audio import now_ms

STATS_WINDOW_SECONDS = float(os.getenv("STATS_WINDOW_SECONDS", "5.0"))
MAX_AUDIO_BYTES = int(os.getenv("MAX_AUDIO_BYTES", str(2 * 1024 * 1024)))
USE_NOVA = os.getenv("USE_NOVA", "true").lower() in {"1", "true", "yes", "y", "on"}


class ByteRate:
    """Sliding-window byte rate calculator."""

    def __init__(self) -> None:
        self.samples: deque[tuple[float, int]] = deque()

    def add(self, n: int) -> None:
        now = time.monotonic()
        self.samples.append((now, int(n)))
        self.prune(now)

    def prune(self, now: Optional[float] = None) -> None:
        now = time.monotonic() if now is None else now
        cutoff = now - STATS_WINDOW_SECONDS
        while self.samples and self.samples[0][0] < cutoff:
            self.samples.popleft()

    def kbps(self) -> float:
        now = time.monotonic()
        self.prune(now)
        total = sum(n for _, n in self.samples)
        return round((total * 8) / max(STATS_WINDOW_SECONDS, 0.001) / 1000, 2)


@dataclass
class RollingStats:
    """Server-wide rolling stats tracking audio, latency, messages, and events."""

    server_started_at: float = field(default_factory=time.time)
    total_sessions: int = 0
    sessions_ended: int = 0
    active_sessions_peak: int = 0
    ws_messages_in: int = 0
    ws_messages_out: int = 0
    ws_send_failures: int = 0
    errors: int = 0
    warnings: int = 0
    ping_count: int = 0
    audio_in_chunks: int = 0
    audio_in_bytes: int = 0
    audio_out_chunks: int = 0
    audio_out_bytes: int = 0
    text_events: int = 0
    first_audio_latency_ms_last: Optional[float] = None
    first_audio_latency_ms_avg: Optional[float] = None
    input_chunk_gap_ms_last: Optional[float] = None
    input_chunk_gap_ms_avg: Optional[float] = None
    input_chunk_gap_ms_max: float = 0.0
    output_chunk_gap_ms_last: Optional[float] = None
    output_chunk_gap_ms_avg: Optional[float] = None
    output_chunk_gap_ms_max: float = 0.0
    last_error: str = ""
    last_warning: str = ""
    last_event_at_ms: int = field(default_factory=now_ms)
    input_rate: ByteRate = field(default_factory=ByteRate)
    output_rate: ByteRate = field(default_factory=ByteRate)
    recent_events: deque[dict[str, Any]] = field(
        default_factory=lambda: deque(maxlen=80)
    )

    @property
    def sessions_started(self) -> int:
        return self.total_sessions

    @sessions_started.setter
    def sessions_started(self, value: int) -> None:
        self.total_sessions = value

    @property
    def total_audio_bytes_in(self) -> int:
        return self.audio_in_bytes

    @total_audio_bytes_in.setter
    def total_audio_bytes_in(self, value: int) -> None:
        self.audio_in_bytes = value

    @property
    def total_audio_bytes_out(self) -> int:
        return self.audio_out_bytes

    @total_audio_bytes_out.setter
    def total_audio_bytes_out(self, value: int) -> None:
        self.audio_out_bytes = value

    def reset(self) -> None:
        self.server_started_at = time.time()
        self.total_sessions = 0
        self.sessions_ended = 0
        self.active_sessions_peak = 0
        self.ws_messages_in = 0
        self.ws_messages_out = 0
        self.ws_send_failures = 0
        self.errors = 0
        self.warnings = 0
        self.ping_count = 0
        self.audio_in_chunks = 0
        self.audio_in_bytes = 0
        self.audio_out_chunks = 0
        self.audio_out_bytes = 0
        self.text_events = 0
        self.first_audio_latency_ms_last = None
        self.first_audio_latency_ms_avg = None
        self.input_chunk_gap_ms_last = None
        self.input_chunk_gap_ms_avg = None
        self.input_chunk_gap_ms_max = 0.0
        self.output_chunk_gap_ms_last = None
        self.output_chunk_gap_ms_avg = None
        self.output_chunk_gap_ms_max = 0.0
        self.last_error = ""
        self.last_warning = ""
        self.last_event_at_ms = now_ms()
        self.input_rate = ByteRate()
        self.output_rate = ByteRate()
        self.recent_events.clear()

    def ewma(
        self, current: Optional[float], value: float, alpha: float = 0.25
    ) -> float:
        return value if current is None else (alpha * value + (1 - alpha) * current)

    def record_event(self, kind: str, detail: dict[str, Any] | None = None) -> None:
        self.last_event_at_ms = now_ms()
        item = {"ts": self.last_event_at_ms, "kind": kind}
        if detail:
            item.update(detail)
        self.recent_events.append(item)

    def record_input_audio(self, n: int, gap_ms: Optional[float]) -> None:
        self.audio_in_chunks += 1
        self.audio_in_bytes += n
        self.input_rate.add(n)
        if gap_ms is not None:
            self.input_chunk_gap_ms_last = round(gap_ms, 1)
            self.input_chunk_gap_ms_avg = round(
                self.ewma(self.input_chunk_gap_ms_avg, gap_ms), 1
            )
            self.input_chunk_gap_ms_max = round(
                max(self.input_chunk_gap_ms_max, gap_ms), 1
            )

    def record_output_audio(self, n: int, gap_ms: Optional[float]) -> None:
        self.audio_out_chunks += 1
        self.audio_out_bytes += n
        self.output_rate.add(n)
        if gap_ms is not None:
            self.output_chunk_gap_ms_last = round(gap_ms, 1)
            self.output_chunk_gap_ms_avg = round(
                self.ewma(self.output_chunk_gap_ms_avg, gap_ms), 1
            )
            self.output_chunk_gap_ms_max = round(
                max(self.output_chunk_gap_ms_max, gap_ms), 1
            )

    def record_first_audio_latency(self, latency_ms: float) -> None:
        self.first_audio_latency_ms_last = round(latency_ms, 1)
        self.first_audio_latency_ms_avg = round(
            self.ewma(self.first_audio_latency_ms_avg, latency_ms), 1
        )


GLOBAL_STATS = RollingStats()


def build_stats(
    session_registry: Optional[Any] = None,
    nova_sdk_available: bool = False,
    nova_import_error: Optional[str] = None,
) -> dict[str, Any]:
    """Compile diagnostic status payload."""
    active_list: List[Any] = (
        list(session_registry.values()) if session_registry else []
    )
    last = active_list[-1].summary() if active_list else None
    if session_registry is not None and hasattr(session_registry, "count"):
        active_count = session_registry.count()
    elif session_registry is not None and hasattr(session_registry, "__len__"):
        active_count = len(session_registry)
    else:
        active_count = len(active_list)
    uptime = round(time.time() - GLOBAL_STATS.server_started_at, 1)

    diagnosis = []
    if (
        GLOBAL_STATS.first_audio_latency_ms_last
        and GLOBAL_STATS.first_audio_latency_ms_last > 1200
    ):
        diagnosis.append(
            "High first-audio latency after end-turn: likely Bedrock/network path delay."
        )
    if (
        GLOBAL_STATS.input_chunk_gap_ms_avg
        and GLOBAL_STATS.input_chunk_gap_ms_avg > 450
    ):
        diagnosis.append(
            "High browser-to-backend audio chunk gap: likely frontend, browser, or network upload jitter."
        )
    if (
        GLOBAL_STATS.output_chunk_gap_ms_avg
        and GLOBAL_STATS.output_chunk_gap_ms_avg > 450
    ):
        diagnosis.append(
            "High Nova-to-backend output chunk gap: likely backend-to-Bedrock/network/model streaming jitter."
        )
    if GLOBAL_STATS.ws_send_failures > 0:
        diagnosis.append(
            "WebSocket send failures seen: client may be disconnecting before backend finishes cleanup."
        )
    if not diagnosis:
        diagnosis.append(
            "No obvious backend-side audio break indicator in current window."
        )

    return {
        "ok": True,
        "ts_ms": now_ms(),
        "uptime_seconds": uptime,
        "server": {
            "region": AWS_REGION,
            "model_id": NOVA_MODEL_ID,
            "nova_sdk_available": nova_sdk_available,
            "nova_import_error": nova_import_error,
            "use_nova": USE_NOVA,
            "input_sample_rate": NOVA_INPUT_AUDIO_SAMPLE_RATE,
            "output_sample_rate": NOVA_OUTPUT_AUDIO_SAMPLE_RATE,
            "max_audio_bytes": MAX_AUDIO_BYTES,
        },
        "sessions": {
            "active": active_count,
            "total": GLOBAL_STATS.total_sessions,
            "started": GLOBAL_STATS.sessions_started,
            "ended": GLOBAL_STATS.sessions_ended,
            "peak_active": GLOBAL_STATS.active_sessions_peak,
            "last_active": last,
        },
        "websocket": {
            "messages_in": GLOBAL_STATS.ws_messages_in,
            "messages_out": GLOBAL_STATS.ws_messages_out,
            "send_failures": GLOBAL_STATS.ws_send_failures,
            "ping_count": GLOBAL_STATS.ping_count,
        },
        "audio": {
            "input_chunks": GLOBAL_STATS.audio_in_chunks,
            "input_bytes": GLOBAL_STATS.audio_in_bytes,
            "input_kbps_window": GLOBAL_STATS.input_rate.kbps(),
            "input_chunk_gap_ms_last": GLOBAL_STATS.input_chunk_gap_ms_last,
            "input_chunk_gap_ms_avg": GLOBAL_STATS.input_chunk_gap_ms_avg,
            "input_chunk_gap_ms_max": GLOBAL_STATS.input_chunk_gap_ms_max,
            "output_chunks": GLOBAL_STATS.audio_out_chunks,
            "output_bytes": GLOBAL_STATS.audio_out_bytes,
            "output_kbps_window": GLOBAL_STATS.output_rate.kbps(),
            "output_chunk_gap_ms_last": GLOBAL_STATS.output_chunk_gap_ms_last,
            "output_chunk_gap_ms_avg": GLOBAL_STATS.output_chunk_gap_ms_avg,
            "output_chunk_gap_ms_max": GLOBAL_STATS.output_chunk_gap_ms_max,
            "first_audio_latency_ms_last": GLOBAL_STATS.first_audio_latency_ms_last,
            "first_audio_latency_ms_avg": GLOBAL_STATS.first_audio_latency_ms_avg,
        },
        "events": {
            "text_events": GLOBAL_STATS.text_events,
            "errors": GLOBAL_STATS.errors,
            "warnings": GLOBAL_STATS.warnings,
            "last_error": GLOBAL_STATS.last_error,
            "last_warning": GLOBAL_STATS.last_warning,
            "recent": list(GLOBAL_STATS.recent_events)[-20:],
        },
        "diagnosis": diagnosis,
    }
