"""
Realtime WebSocket ClientSession state management, Nova Sonic bidirectional streaming, and background reader tasks.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib.parse import quote

import websockets
from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from api.core.config import (
    AWS_ACCESS_KEY_ID,
    AWS_REGION,
    AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN,
    AZURE_OPENAI_REALTIME_API_KEY,
    AZURE_OPENAI_REALTIME_DEPLOYMENT,
    AZURE_OPENAI_REALTIME_ENDPOINT,
    AZURE_OPENAI_REALTIME_TRANSCRIBE_DEPLOYMENT,
    AZURE_REALTIME_SAMPLE_RATE,
    NOVA_EMIT_EVENTS,
    NOVA_INPUT_AUDIO_SAMPLE_RATE,
    NOVA_MODEL_ID,
    NOVA_OUTPUT_AUDIO_SAMPLE_RATE,
    NOVA_SYSTEM_PROMPT,
    NOVA_VOICE_ID,
    REALTIME_PROVIDER,
)
from api.realtime.audio import b64e, fallback_reply, find_audio, now_ms, resample_pcm16
from api.realtime.events import (
    _clean_event_name,
    _event_payload,
    _normalise_transcript_text,
    emit_final_transcript,
    extract_nova_content_end,
    extract_nova_text_payload,
    json_safe,
    normalise_text,
    remember_nova_content_start,
    strip_previous_assistant_prefix,
)
from api.observability.nova_usage import (
    NovaUsage,
    apply_usage_update,
    extract_azure_usage_event,
    extract_nova_usage_event,
    )          
from api.realtime.stats import GLOBAL_STATS, build_stats
from shared_logger import get_logger

logger = get_logger(__name__)

try:
    from langchain_aws.chat_models.bedrock_nova_sonic import ChatBedrockNovaSonic
except Exception as import_exc:
    ChatBedrockNovaSonic = None  # type: ignore[assignment, misc]
    NOVA_IMPORT_ERROR = repr(import_exc)
else:
    NOVA_IMPORT_ERROR = None

# Force SigV4 credentials path for Bedrock where possible.
os.environ.pop("AWS_BEARER_TOKEN_BEDROCK", None)

USE_NOVA = os.getenv("USE_NOVA", "true").lower() in {"1", "true", "yes", "y", "on"}
TEXT_DEDUPE_TTL_SECONDS = float(os.getenv("TEXT_DEDUPE_TTL_SECONDS", "2.0"))
MAX_RECENT_TEXTS = int(os.getenv("MAX_RECENT_TEXTS", "64"))
STATS_PUSH_INTERVAL_SECONDS = float(os.getenv("STATS_PUSH_INTERVAL_SECONDS", "1.0"))

def _find_token_key_paths(
    value: Any,
    path: tuple[str, ...] = (),
) -> list[str]:
    """
    Find usage-related dictionary paths without returning values.

    This is safe for diagnostics because it does not include transcript
    text, audio content, token values, prompts, or identifiers.
    """
    matches: list[str] = []

    if isinstance(value, dict):
        for key, child in value.items():
            key_text = str(key)
            current_path = path + (key_text,)
            normalized_key = (
                key_text
                .replace("_", "")
                .replace("-", "")
                .lower()
            )

            if (
                "usage" in normalized_key
                or "token" in normalized_key
            ):
                matches.append(
                    ".".join(current_path)
                )

            matches.extend(
                _find_token_key_paths(
                    child,
                    current_path,
                )
            )

    elif isinstance(value, list):
        for index, child in enumerate(value):
            matches.extend(
                _find_token_key_paths(
                    child,
                    path + (str(index),),
                )
            )

    return matches

@dataclass
class ClientSession:
    """Manages individual WebSocket client state, audio buffers, and Nova stream lifecycle."""

    id: str
    voice_id: str = NOVA_VOICE_ID
    provider: str = REALTIME_PROVIDER  # set per session from its language (see config.provider_for_language)
    system_prompt: str = NOVA_SYSTEM_PROMPT
    nova_model: Any = None
    nova_session_cm: Any = None
    nova_session: Any = None
    nova_reader_task: Optional[asyncio.Task] = None
    started: bool = False
    nova_started: bool = False
    using_nova: bool = False
    audio_input_open: bool = False
    output_audio_open: bool = False
    input_audio_chunks: int = 0
    input_audio_bytes: int = 0
    output_audio_chunks: int = 0
    output_audio_bytes: int = 0
    text_events: int = 0
    closing: bool = False
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    recent_texts: OrderedDict[str, float] = field(default_factory=OrderedDict)
    nova_content_meta: dict[str, dict[str, Any]] = field(default_factory=dict)
    nova_text_buffers: dict[str, list[str]] = field(default_factory=dict)
    nova_active_content_id: Optional[str] = None
    nova_active_role: str = "assistant"
    nova_active_generation_stage: str = ""
    assistant_transcript_history: list[str] = field(default_factory=list)
    emitted_transcript_keys: OrderedDict[str, float] = field(default_factory=OrderedDict)
    nova_usage: NovaUsage = field(default_factory=NovaUsage)
    nova_usage_events: int = 0
    telemetry_persisted: bool = False
    telemetry_status: str = "success"
    telemetry_error_type: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    last_input_audio_at: Optional[float] = None
    last_output_audio_at: Optional[float] = None
    turn_end_at: Optional[float] = None
    first_audio_seen_for_turn: bool = False
    last_client_metrics: dict[str, Any] = field(default_factory=dict)
    client_addr: str = ""
    user_email: str = ""
    request_metadata: dict[str, Any] = field(default_factory=dict)
    

    async def send(self, ws: WebSocket, payload: dict[str, Any]) -> bool:
        if self.closing or ws.client_state != WebSocketState.CONNECTED:
            return False
        try:
            async with self.send_lock:
                if self.closing or ws.client_state != WebSocketState.CONNECTED:
                    return False
                await ws.send_text(json.dumps(payload, ensure_ascii=False))
                GLOBAL_STATS.ws_messages_out += 1
                if payload.get("type") == "warning":
                    GLOBAL_STATS.warnings += 1
                    GLOBAL_STATS.last_warning = str(payload.get("message", ""))[:500]
                return True
        except (RuntimeError, WebSocketDisconnect):
            GLOBAL_STATS.ws_send_failures += 1
            return False
        except Exception as exc:
            GLOBAL_STATS.ws_send_failures += 1
            GLOBAL_STATS.errors += 1
            GLOBAL_STATS.last_error = f"send failed: {type(exc).__name__}: {exc}"
            logger.exception("Failed sending WebSocket payload type=%s", payload.get("type"))
            return False

    def should_emit_text(self, text: str) -> bool:
        now = time.monotonic()
        cutoff = now - TEXT_DEDUPE_TTL_SECONDS
        for key, ts in list(self.recent_texts.items()):
            if ts < cutoff:
                self.recent_texts.pop(key, None)
        key = normalise_text(text)
        if not key:
            return False
        if key in self.recent_texts:
            self.recent_texts[key] = now
            return False
        self.recent_texts[key] = now
        while len(self.recent_texts) > MAX_RECENT_TEXTS:
            self.recent_texts.popitem(last=False)
        return True

    async def close(self) -> None:
        if self.closing:
            return
        self.closing = True

        if self.nova_session and self.audio_input_open:
            end_audio = getattr(self.nova_session, "end_audio_input", None)
            if callable(end_audio):
                with contextlib.suppress(Exception):
                    await end_audio()
            self.audio_input_open = False

        if self.nova_session:
            for method_name in ("close_input", "end", "stop", "close"):
                method = getattr(self.nova_session, method_name, None)
                if callable(method):
                    with contextlib.suppress(Exception):
                        await method()

        if self.nova_session_cm:
            with contextlib.suppress(Exception):
                await self.nova_session_cm.__aexit__(None, None, None)

        if self.nova_reader_task:
            self.nova_reader_task.cancel()
            with contextlib.suppress(BaseException):
                await self.nova_reader_task

    def summary(self) -> dict[str, Any]:
        age = max(time.time() - self.created_at, 0.001)
        return {
            "id": self.id,
            "client_addr": self.client_addr,
            "user_email": self.user_email,
            "age_seconds": round(age, 1),
            "using_nova": self.using_nova,
            "started": self.started,
            "audio_input_open": self.audio_input_open,
            "input_audio_chunks": self.input_audio_chunks,
            "input_audio_bytes": self.input_audio_bytes,
            "output_audio_chunks": self.output_audio_chunks,
            "output_audio_bytes": self.output_audio_bytes,
            "text_events": self.text_events,
            "voice_id": self.voice_id,
            "last_client_metrics": self.last_client_metrics,
            "nova_usage_events": self.nova_usage_events,
            "nova_usage": {
                "text_input_tokens": self.nova_usage.text_input_tokens,
                "text_output_tokens": self.nova_usage.text_output_tokens,
                "audio_input_tokens": self.nova_usage.audio_input_tokens,
                "audio_output_tokens": self.nova_usage.audio_output_tokens,
                "generic_input_tokens": self.nova_usage.generic_input_tokens,
                "generic_output_tokens": self.nova_usage.generic_output_tokens,
                "total_tokens": self.nova_usage.total_tokens,
            },
        }


def _azure_realtime_ws_url() -> str:
    endpoint = AZURE_OPENAI_REALTIME_ENDPOINT.rstrip("/")
    endpoint = endpoint.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
    deployment = quote(AZURE_OPENAI_REALTIME_DEPLOYMENT, safe="")
    return f"{endpoint}/openai/v1/realtime?model={deployment}"


class AzureRealtimeSession:
    """Duck-typed adapter so the existing Nova-oriented WS handler can drive Azure gpt-realtime too."""

    def __init__(self, ws: Any, input_sample_rate: int) -> None:
        self._ws = ws
        self._input_sample_rate = input_sample_rate

    async def send_audio_chunk(self, audio: bytes) -> None:
        resampled = resample_pcm16(audio, self._input_sample_rate, AZURE_REALTIME_SAMPLE_RATE)
        await self._ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": b64e(resampled)}))

    async def send_text(self, text: str) -> None:
        await self._ws.send(json.dumps({
            "type": "conversation.item.create",
            "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]},
        }))
        await self._ws.send(json.dumps({"type": "response.create"}))

    async def start_audio_input(self) -> None:
        return None

    async def end_audio_input(self) -> None:
        return None

    async def receive_events(self):
        async for raw in self._ws:
            try:
                yield json.loads(raw)
            except json.JSONDecodeError:
                continue

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            await self._ws.close()


async def start_azure_realtime(client: ClientSession, ws: WebSocket) -> None:
    client.nova_started = True
    if not (AZURE_OPENAI_REALTIME_ENDPOINT and AZURE_OPENAI_REALTIME_API_KEY and AZURE_OPENAI_REALTIME_DEPLOYMENT):
        await client.send(
            ws,
            {
                "type": "warning",
                "message": "Azure realtime not configured; fallback mode active",
                "source": "server",
            },
        )
        return

    try:
        azure_ws = await websockets.connect(
            _azure_realtime_ws_url(),
            additional_headers={"api-key": AZURE_OPENAI_REALTIME_API_KEY},
            max_size=16 * 1024 * 1024,
        )
        session_config: dict[str, Any] = {
            "type": "realtime",
            "instructions": client.system_prompt,
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": AZURE_REALTIME_SAMPLE_RATE},
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.5,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 500,
                        "create_response": True,
                        "interrupt_response": True,
                    },
                },
                "output": {
                    "format": {"type": "audio/pcm", "rate": AZURE_REALTIME_SAMPLE_RATE},
                    "voice": client.voice_id,
                },
            },
        }
        await azure_ws.send(json.dumps({"type": "session.update", "session": session_config}))

        if AZURE_OPENAI_REALTIME_TRANSCRIBE_DEPLOYMENT:
            # User-speech transcription is off unless configured; Azure needs a transcription
            # model deployment name here. Sent as a second update so that, if Azure rejects it,
            # the voice/VAD config above still applies.
            transcription: dict[str, Any] = {"model": AZURE_OPENAI_REALTIME_TRANSCRIBE_DEPLOYMENT}
            language = (client.request_metadata or {}).get("response_language")
            if language and language != "auto":
                transcription["language"] = language
            session_config["audio"]["input"]["transcription"] = transcription
            await azure_ws.send(json.dumps({"type": "session.update", "session": session_config}))

        client.nova_session = AzureRealtimeSession(azure_ws, NOVA_INPUT_AUDIO_SAMPLE_RATE)
        client.using_nova = True
        await client.send(
            ws,
            {
                "type": "info",
                "message": "Azure realtime session opened",
                "model_id": AZURE_OPENAI_REALTIME_DEPLOYMENT,
                "voice_id": client.voice_id,
                "source": "azure",
            },
        )
        GLOBAL_STATS.record_event("azure_session_opened", {"session_id": client.id})
    except Exception as exc:
        GLOBAL_STATS.errors += 1
        GLOBAL_STATS.last_error = f"Could not open Azure realtime: {type(exc).__name__}: {exc}"
        logger.exception("Could not open Azure realtime session; fallback mode active")
        client.using_nova = False
        await client.send(
            ws,
            {
                "type": "warning",
                "message": f"Could not open Azure realtime session; fallback mode active: {exc}",
                "source": "server",
            },
        )


async def azure_realtime_reader(client: ClientSession, ws: WebSocket) -> None:
    """Translate Azure gpt-realtime events into the same client-facing messages Nova produces."""
    try:
        async for event in client.nova_session.receive_events():
            ev_type = str(event.get("type") or "")

            usage_update = extract_azure_usage_event(event)
            if usage_update is not None:
                apply_usage_update(client.nova_usage, usage_update)
                client.nova_usage_events += 1

            # Beta and GA event names (GA: /openai/v1/realtime with session.type="realtime").
            if ev_type in ("response.audio.delta", "response.output_audio.delta"):
                audio_b64 = event.get("delta")
                if not audio_b64:
                    continue
                now = time.monotonic()
                if client.turn_end_at and not client.first_audio_seen_for_turn:
                    latency = (now - client.turn_end_at) * 1000
                    GLOBAL_STATS.record_first_audio_latency(latency)
                    client.first_audio_seen_for_turn = True
                    await client.send(
                        ws,
                        {
                            "type": "audio_start",
                            "sample_rate": AZURE_REALTIME_SAMPLE_RATE,
                            "format": "pcm_s16le",
                            "channels": 1,
                            "source": "azure",
                            "first_audio_latency_ms": round(latency, 1),
                        },
                    )
                elif not client.output_audio_open:
                    await client.send(
                        ws,
                        {
                            "type": "audio_start",
                            "sample_rate": AZURE_REALTIME_SAMPLE_RATE,
                            "format": "pcm_s16le",
                            "channels": 1,
                            "source": "azure",
                        },
                    )

                gap = (
                    None
                    if client.last_output_audio_at is None
                    else (now - client.last_output_audio_at) * 1000
                )
                client.last_output_audio_at = now
                raw_len = int(len(audio_b64) * 3 / 4)
                client.output_audio_chunks += 1
                client.output_audio_bytes += raw_len
                client.output_audio_open = True
                GLOBAL_STATS.record_output_audio(raw_len, gap)

                await client.send(
                    ws,
                    {
                        "type": "audio",
                        "audio": audio_b64,
                        "sample_rate": AZURE_REALTIME_SAMPLE_RATE,
                        "format": "pcm_s16le",
                        "channels": 1,
                        "chunk_index": client.output_audio_chunks,
                        "source": "azure",
                    },
                )

            elif ev_type in ("response.audio_transcript.delta", "response.output_audio_transcript.delta"):
                delta = str(event.get("delta") or "")
                if delta:
                    await client.send(
                        ws,
                        {
                            "type": "transcript",
                            "role": "assistant",
                            "text": strip_previous_assistant_prefix(client, delta) or delta,
                            "final": False,
                            "content_id": event.get("item_id"),
                            "source": "azure",
                        },
                    )

            elif ev_type in ("response.audio_transcript.done", "response.output_audio_transcript.done"):
                transcript = str(event.get("transcript") or "")
                if transcript:
                    await emit_final_transcript(client, ws, "assistant", transcript, event.get("item_id"))

            elif ev_type == "conversation.item.input_audio_transcription.completed":
                transcript = str(event.get("transcript") or "")
                if transcript:
                    await emit_final_transcript(client, ws, "user", transcript, event.get("item_id"))

            elif ev_type == "input_audio_buffer.speech_started":
                # Server VAD heard the user and cancels the response (interrupt_response); the browser
                # may still hold seconds of already-sent audio, so tell it to drop that too.
                await client.send(ws, {"type": "audio_interrupted", "source": "azure"})

            elif ev_type == "conversation.item.input_audio_transcription.failed":
                logger.warning("Azure input transcription failed | session=%s | %s", client.id, event.get("error"))

            elif ev_type == "response.done":
                if client.output_audio_open:
                    client.output_audio_open = False
                    await client.send(ws, {"type": "audio_end", "source": "azure"})

            elif ev_type == "error":
                error = event.get("error") or {}
                message = error.get("message") if isinstance(error, dict) else str(error)
                GLOBAL_STATS.errors += 1
                GLOBAL_STATS.last_error = f"Azure realtime error: {message}"
                await client.send(
                    ws,
                    {"type": "error", "message": f"Azure realtime error: {message}", "source": "azure"},
                )

    except asyncio.CancelledError:
        logger.info("Azure realtime reader cancelled for session %s", client.id)
    except Exception as exc:
        client.telemetry_status = "error"
        client.telemetry_error_type = type(exc).__name__
        GLOBAL_STATS.errors += 1
        GLOBAL_STATS.last_error = f"Azure realtime reader failed: {type(exc).__name__}: {exc}"
        logger.exception("Azure realtime reader failed")
        await client.send(
            ws,
            {
                "type": "error",
                "message": f"Azure realtime reader failed: {type(exc).__name__}: {exc}",
                "source": "server",
            },
        )


async def start_nova(client: ClientSession, ws: WebSocket) -> None:
    client.nova_started = True
    if not USE_NOVA:
        logger.info(
            "Nova Sonic session opened | session=%s "
            "| model=%s | region=%s | voice=%s",
            client.id,
            NOVA_MODEL_ID,
            AWS_REGION,
            client.voice_id,
        )
        await client.send(
            ws,
            {"type": "info", "message": "Nova disabled; fallback mode active", "source": "server"},
        )
        return
    if ChatBedrockNovaSonic is None:
        await client.send(
            ws,
            {
                "type": "warning",
                "message": (
                    "langchain-aws[nova-sonic] unavailable; fallback mode active. "
                    f"Import error: {NOVA_IMPORT_ERROR}"
                ),
                "source": "server",
            },
        )
        return

    try:
        kwargs: dict[str, Any] = {
            "model_id": NOVA_MODEL_ID,
            "region_name": AWS_REGION,
            "voice_id": client.voice_id,
            "input_sample_rate": NOVA_INPUT_AUDIO_SAMPLE_RATE,
            "output_sample_rate": NOVA_OUTPUT_AUDIO_SAMPLE_RATE,
        }
        if AWS_ACCESS_KEY_ID:
            kwargs["aws_access_key_id"] = AWS_ACCESS_KEY_ID
        if AWS_SECRET_ACCESS_KEY:
            kwargs["aws_secret_access_key"] = AWS_SECRET_ACCESS_KEY
        if AWS_SESSION_TOKEN:
            kwargs["aws_session_token"] = AWS_SESSION_TOKEN

        client.nova_model = ChatBedrockNovaSonic(**kwargs)
        client.nova_session_cm = client.nova_model.create_session(
            system_prompt=client.system_prompt
        )
        client.nova_session = await client.nova_session_cm.__aenter__()

        start_method = getattr(client.nova_session, "start", None)
        if callable(start_method):
            try:
                await start_method()
            except RuntimeError as exc:
                if "already active" not in str(exc).lower():
                    raise
                logger.info("Nova session already active; continuing")

        client.using_nova = True
        await client.send(
            ws,
            {
                "type": "info",
                "message": "Nova Sonic session opened",
                "model_id": NOVA_MODEL_ID,
                "region": AWS_REGION,
                "voice_id": client.voice_id,
                "source": "nova",
            },
        )
        GLOBAL_STATS.record_event("nova_session_opened", {"session_id": client.id})
    except Exception as exc:
        GLOBAL_STATS.errors += 1
        GLOBAL_STATS.last_error = f"Could not open Nova: {type(exc).__name__}: {exc}"
        logger.exception("Could not open Nova Sonic session; fallback mode active")
        client.using_nova = False
        await client.send(
            ws,
            {
                "type": "warning",
                "message": f"Could not open Nova Sonic session; fallback mode active: {exc}",
                "source": "server",
            },
        )


async def ensure_started(
    client: ClientSession,
    ws: WebSocket,
) -> None:
    if not client.started:
        client.started = True

    if not client.nova_started and not client.nova_session:
        if client.provider == "devnagri":
            from api.realtime.devnagri_pipeline import start_devnagri

            await start_devnagri(client, ws)
        elif client.provider == "azure":
            await start_azure_realtime(client, ws)
        else:
            await start_nova(client, ws)

    if (
        client.using_nova
        and client.nova_session
        and not client.nova_reader_task
    ):
        logger.info(
            "Creating Nova reader task | session=%s",
            client.id,
        )

        if client.provider == "devnagri":
            from api.realtime.devnagri_pipeline import devnagri_reader as reader_fn
        else:
            reader_fn = azure_realtime_reader if client.provider == "azure" else nova_reader
        client.nova_reader_task = asyncio.create_task(
            reader_fn(client, ws),
            name=f"nova-reader-{client.id}",
        )


async def nova_reader(
    client: ClientSession,
    ws: WebSocket,
) -> None:
    """
    Read Nova events and emit transcript/audio messages.

    Usage telemetry is processed on a best-effort basis and must
    never interrupt transcript or audio delivery.
    """
    try:
        async for event in client.nova_session.receive_events():
            ev = json_safe(event)

            ev_name, ev_payload = _event_payload(ev)
            clean_event_name = _clean_event_name(ev_name)

            payload_keys = (
                sorted(
                    str(key)
                    for key in ev_payload.keys()
                )
                if isinstance(ev_payload, dict)
                else []
            )

            if clean_event_name not in {
                "audio",
                "audiooutput",
            }:
                logger.info(
                    "Nova event received | session=%s "
                    "| event=%s | payload_keys=%s",
                    client.id,
                    clean_event_name or "unknown",
                    payload_keys,
                )

            token_key_paths = _find_token_key_paths(ev)

            if token_key_paths:
                logger.info(
                    "Nova token-related paths | session=%s "
                    "| paths=%s",
                    client.id,
                    sorted(set(token_key_paths)),
                )

            if NOVA_EMIT_EVENTS:
                await client.send(
                    ws,
                    {
                        "type": "nova_event",
                        "event": ev,
                        "source": "nova",
                    },
                )

            try:
                usage_update = extract_nova_usage_event(ev)

                if usage_update is not None:
                    apply_usage_update(
                        client.nova_usage,
                        usage_update,
                    )
                    client.nova_usage_events += 1

                    logger.info(
                        "Nova usage updated | session=%s "
                        "| event=%d | mode=%s "
                        "| text_in=%d | text_out=%d "
                        "| audio_in=%d | audio_out=%d "
                        "| generic_in=%d | generic_out=%d "
                        "| total=%d",
                        client.id,
                        client.nova_usage_events,
                        usage_update.mode,
                        client.nova_usage.text_input_tokens,
                        client.nova_usage.text_output_tokens,
                        client.nova_usage.audio_input_tokens,
                        client.nova_usage.audio_output_tokens,
                        client.nova_usage.generic_input_tokens,
                        client.nova_usage.generic_output_tokens,
                        client.nova_usage.total_tokens,
                    )

                    GLOBAL_STATS.record_event(
                        "nova_usage_updated",
                        {
                            "session_id": client.id,
                            "total_tokens": (
                                client.nova_usage.total_tokens
                            ),
                        },
                    )

            except Exception:
                logger.exception(
                    "Nova telemetry parsing failed | session=%s",
                    client.id,
                )

            # Existing transcript handling continues here.
            remember_nova_content_start(client, ev)

            

            text_payload = extract_nova_text_payload(client, ev)
            if text_payload:
                content_id = text_payload.get("content_id") or str(uuid.uuid4())
                role = str(text_payload.get("role") or "assistant")
                generation_stage = str(text_payload.get("generation_stage") or "")
                text = str(text_payload.get("text") or "")

                client.nova_text_buffers.setdefault(content_id, []).append(text)

                if role == "user":
                    await emit_final_transcript(client, ws, "user", text, content_id)
                elif role == "assistant":
                    await client.send(
                        ws,
                        {
                            "type": "transcript",
                            "role": "assistant",
                            "text": strip_previous_assistant_prefix(client, text) or text,
                            "final": False,
                            "generation_stage": generation_stage or None,
                            "content_id": content_id,
                            "source": "nova",
                        },
                    )
                    if generation_stage == "FINAL":
                        await emit_final_transcript(client, ws, "assistant", text, content_id)

            content_end = extract_nova_content_end(client, ev)
            if content_end:
                content_id = content_end.get("content_id")
                role = str(content_end.get("role") or "assistant")
                generation_stage = str(content_end.get("generation_stage") or "")
                buffered = _normalise_transcript_text(
                    " ".join(client.nova_text_buffers.pop(content_id or "", []))
                )

                if buffered and role == "assistant" and generation_stage != "SPECULATIVE":
                    await emit_final_transcript(client, ws, "assistant", buffered, content_id)

            audio = find_audio(ev)
            if audio:
                now = time.monotonic()
                if client.turn_end_at and not client.first_audio_seen_for_turn:
                    latency = (now - client.turn_end_at) * 1000
                    GLOBAL_STATS.record_first_audio_latency(latency)
                    client.first_audio_seen_for_turn = True
                    await client.send(
                        ws,
                        {
                            "type": "audio_start",
                            "sample_rate": NOVA_OUTPUT_AUDIO_SAMPLE_RATE,
                            "format": "pcm_s16le",
                            "channels": 1,
                            "source": "nova",
                            "first_audio_latency_ms": round(latency, 1),
                        },
                    )
                elif not client.output_audio_open:
                    await client.send(
                        ws,
                        {
                            "type": "audio_start",
                            "sample_rate": NOVA_OUTPUT_AUDIO_SAMPLE_RATE,
                            "format": "pcm_s16le",
                            "channels": 1,
                            "source": "nova",
                        },
                    )

                gap = (
                    None
                    if client.last_output_audio_at is None
                    else (now - client.last_output_audio_at) * 1000
                )
                client.last_output_audio_at = now
                raw_len = (
                    int(len(audio) * 3 / 4) if isinstance(audio, str) else len(audio)
                )
                client.output_audio_chunks += 1
                client.output_audio_bytes += raw_len
                client.output_audio_open = True
                GLOBAL_STATS.record_output_audio(raw_len, gap)

                await client.send(
                    ws,
                    {
                        "type": "audio",
                        "audio": audio,
                        "sample_rate": NOVA_OUTPUT_AUDIO_SAMPLE_RATE,
                        "format": "pcm_s16le",
                        "channels": 1,
                        "chunk_index": client.output_audio_chunks,
                        "source": "nova",
                    },
                )

            # ev_name, ev_payload = _event_payload(ev)
            ev_type = str(ev.get("type", "")).lower() if isinstance(ev, dict) else ""
            ev_name_lower = _clean_event_name(ev_name)
            if ev_name_lower == "contentend" and str(ev_payload.get("stopReason") or "").upper() == "INTERRUPTED":
                # Nova barge-in: the browser may still hold already-sent audio, so tell it to drop that.
                await client.send(ws, {"type": "audio_interrupted", "source": "nova"})
            if client.output_audio_open and (
                ev_type in {"content_end", "contentend", "output_end", "turn_end"}
                or ev_name_lower
                in {"contentend", "completionend", "outputend", "turnend"}
            ):
                client.output_audio_open = False
                await client.send(ws, {"type": "audio_end", "source": "nova"})

    except asyncio.CancelledError:
        logger.info("Nova reader cancelled for session %s", client.id)
    except Exception as exc:
        client.telemetry_status = "error"
        client.telemetry_error_type = type(exc).__name__
        GLOBAL_STATS.errors += 1
        GLOBAL_STATS.last_error = f"Nova reader failed: {type(exc).__name__}: {exc}"
        logger.exception("Nova reader failed")
        await client.send(
            ws,
            {
                "type": "error",
                "message": f"Voice session failed: {type(exc).__name__}: {exc}",
                "source": "server",
            },
        )


async def close_audio_input(client: ClientSession, ws: WebSocket) -> None:
    if client.using_nova and client.nova_session and client.audio_input_open:
        end_audio = getattr(client.nova_session, "end_audio_input", None)
        if callable(end_audio):
            try:
                await end_audio()
            except Exception as exc:
                await client.send(
                    ws,
                    {
                        "type": "warning",
                        "message": f"Failed to close audio input: {exc}",
                        "source": "server",
                    },
                )
    client.audio_input_open = False
    client.turn_end_at = time.monotonic()
    client.first_audio_seen_for_turn = False

