"""
Amazon Nova 2 Sonic speech-to-speech WebSocket bridge and session router.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
import time
from typing import Any, Optional
from xmlrpc import client
from api.observability.telemetry import persist_nova_session_usage

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.websockets import WebSocketState

from api.core.auth import User, get_current_user
from api.core.config import (
    AZURE_OPENAI_REALTIME_API_KEY,
    AZURE_OPENAI_REALTIME_DEPLOYMENT,
    AZURE_OPENAI_REALTIME_ENDPOINT,
    AZURE_OPENAI_REALTIME_VOICE,
    AZURE_OPENAI_REALTIME_VOICE_FEMALE,
    BLACKBIRD_API_KEY,
    DEVNAGRI_TTS_API_KEY,
    DEVNAGRI_TTS_VOICE_ID,
    DEVNAGRI_TTS_VOICE_ID_FEMALE,
    DEVNAGRI_TTS_VOICE_ID_HI,
    NOVA_SYSTEM_PROMPT,
    NOVA_VOICE_ID,
    NOVA_VOICE_ID_FEMALE,
    REALTIME_PROVIDER,
    provider_for_language,
    unavailable_languages,
    VIDEO_PAUSE_FRAME_FEMALE,
    VIDEO_PAUSE_FRAME_MALE,
    VOICE_PACING_MAX_WPM,
    VOICE_PACING_MIN_WPM,
    WS_BEARER_TOKEN,
)
from api.realtime.audio import b64d, fallback_reply, monotonic_ms, now_ms
from api.realtime.crt_patch import patch_awscrt_cancelled_future_race
from api.realtime.prompts import LANGUAGE_CODE_PATTERN, build_instructions, build_opener_cue
from api.realtime.session import (
    ChatBedrockNovaSonic,
    ClientSession,
    NOVA_IMPORT_ERROR,
    close_audio_input,
    ensure_started,
)
from api.realtime.stats import GLOBAL_STATS, MAX_AUDIO_BYTES, RollingStats, build_stats
from shared_logger import get_logger

logger = get_logger(__name__)

# Apply CRT cancellation race patch on startup
patch_awscrt_cancelled_future_race()

router = APIRouter(tags=["realtime"])


class ActiveSessionRegistry:
    """In-memory active session store replacing artificial port/adapter indirection."""

    def __init__(self) -> None:
        self._sessions: dict[str, ClientSession] = {}

    def put(self, session_id: str, session: ClientSession) -> None:
        self._sessions[session_id] = session

    def get(self, session_id: str) -> Optional[ClientSession]:
        return self._sessions.get(session_id)

    def pop(self, session_id: str) -> Optional[ClientSession]:
        return self._sessions.pop(session_id, None)

    def values(self):
        return self._sessions.values()

    def count(self) -> int:
        return len(self._sessions)

    def __len__(self) -> int:
        return len(self._sessions)


_session_registry = ActiveSessionRegistry()


def get_session_registry() -> ActiveSessionRegistry:
    """Dependency provider for the active session registry."""
    return _session_registry


def set_session_registry(registry: ActiveSessionRegistry) -> None:
    """Set an alternate session registry (for testing/DI)."""
    global _session_registry
    _session_registry = registry


# ── Pydantic Request / Response Models ───────────────────────────────────────

class RealtimeSessionRequest(BaseModel):
    client_type: str = Field(
        default="Medium",
        pattern=r"^(Easy|Medium|Hard|Expert)$",
    )
    client_persona: str = Field(default="", max_length=255)
    industry: str = Field(default="", max_length=255)
    company_size: str = Field(default="", max_length=255)
    pitch_summary: str = Field(default="", max_length=8000)
    scenario_type: Optional[str] = Field(default="Sales & Commercial Pitches", max_length=255)
    business_context: Optional[str] = Field(default="", max_length=255)
    response_language: str = Field(
        default="auto",
        pattern=LANGUAGE_CODE_PATTERN,
    )
    voice: Optional[str] = Field(default=None, max_length=50)


class RealtimeSessionResponse(BaseModel):
    ws_url: str
    stats_url: str
    voice_id: str
    voice_gender: str = "male"  # lets the frontend pick an avatar that matches the voice
    system_prompt: str
    session_id: Optional[str] = None
    pacing: dict[str, int]
    video_pause_frames: dict[str, float] = {}


# ── Authentication Helper ───────────────────────────────────────────────────

async def _ws_user(ws: WebSocket) -> Optional[User]:
    """Authenticate a WebSocket using the JWT token query param or header."""
    token = ws.query_params.get("token")
    auth_header = ws.headers.get("authorization", "")
    if not token and auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()

    if not token:
        return None

    if WS_BEARER_TOKEN and token == WS_BEARER_TOKEN:
        return User(email="bearer", full_name="Bearer", is_admin=False)

    try:
        return await get_current_user(token)
    except HTTPException:
        return None


# ── HTTP Endpoints ───────────────────────────────────────────────────────────

@router.post("/realtime/session", response_model=RealtimeSessionResponse)
async def create_realtime_session(
    request: RealtimeSessionRequest,
    http_request: Request,
    current_user: User = Depends(get_current_user),
) -> RealtimeSessionResponse:
    logger.info(
        "Nova Sonic session requested by %s (difficulty=%s, industry=%s)",
        current_user.email,
        request.client_type,
        request.industry,
    )

    system_prompt = build_instructions(request)
    provider = provider_for_language(request.response_language)
    female_voice = request.client_type in ("Medium", "Expert")
    if provider == "devnagri" and request.response_language == "hi" and not request.voice:
        female_voice = True  # the Hindi voice (Simran) is female
    if provider == "devnagri":
        if request.response_language == "hi":
            voice_id = request.voice or DEVNAGRI_TTS_VOICE_ID_HI
        else:
            voice_id = request.voice or (
                DEVNAGRI_TTS_VOICE_ID_FEMALE
                if request.client_type in ("Medium", "Expert")
                else DEVNAGRI_TTS_VOICE_ID
            )
    elif provider == "azure":
        voice_id = request.voice or (
            AZURE_OPENAI_REALTIME_VOICE_FEMALE
            if request.client_type in ("Medium", "Expert")
            else AZURE_OPENAI_REALTIME_VOICE
        )
    else:
        voice_id = request.voice or (
            NOVA_VOICE_ID_FEMALE if request.client_type in ("Medium", "Expert") else NOVA_VOICE_ID
        )
    session_id = str(uuid.uuid4())

    req_metadata = request.model_dump() if hasattr(request, "model_dump") else request.dict()
    pre_client = ClientSession(
        id=session_id,
        user_email=current_user.email,
        voice_id=voice_id,
        system_prompt=system_prompt,
        request_metadata=req_metadata,
        provider=provider,
    )
    registry = get_session_registry()
    registry.put(session_id, pre_client)

    token = http_request.query_params.get("token")
    auth_header = http_request.headers.get("authorization", "")
    if not token and auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()

    scheme = "wss" if http_request.url.scheme == "https" else "ws"
    host = http_request.headers.get("host", "localhost:2089")
    ws_url = f"{scheme}://{host}/ws/nova2-sonic"
    query_parts = []
    if token:
        query_parts.append(f"token={token}")
    query_parts.append(f"session_id={session_id}")
    ws_url += f"?{'&'.join(query_parts)}"

    return RealtimeSessionResponse(
        ws_url=ws_url,
        stats_url="/api/connectivity/stats",
        voice_id=voice_id,
        voice_gender="female" if female_voice else "male",
        system_prompt=system_prompt,
        session_id=session_id,
        pacing={
            "min_wpm": VOICE_PACING_MIN_WPM,
            "max_wpm": VOICE_PACING_MAX_WPM,
        },
        video_pause_frames={
            "male": VIDEO_PAUSE_FRAME_MALE,
            "female": VIDEO_PAUSE_FRAME_FEMALE,
        },
    )


@router.get("/realtime/languages")
async def realtime_languages(current_user: User = Depends(get_current_user)) -> dict:
    """Response languages the configured voice providers cannot handle, so the UI can hide them."""
    return {"unavailable": unavailable_languages()}


@router.get("/api/connectivity/stats")
async def connectivity_stats() -> JSONResponse:
    registry = get_session_registry()
    if REALTIME_PROVIDER == "devnagri":
        sdk_available = bool(BLACKBIRD_API_KEY and DEVNAGRI_TTS_API_KEY)
        sdk_import_error = None
    elif REALTIME_PROVIDER == "azure":
        sdk_available = bool(
            AZURE_OPENAI_REALTIME_ENDPOINT and AZURE_OPENAI_REALTIME_API_KEY and AZURE_OPENAI_REALTIME_DEPLOYMENT
        )
        sdk_import_error = None
    else:
        sdk_available = ChatBedrockNovaSonic is not None
        sdk_import_error = NOVA_IMPORT_ERROR
    stats = build_stats(
        session_registry=registry,
        nova_sdk_available=sdk_available,
        nova_import_error=sdk_import_error,
    )
    return JSONResponse(stats)


@router.post("/api/connectivity/reset")
async def reset_connectivity_stats() -> JSONResponse:
    GLOBAL_STATS.reset()
    return JSONResponse({"ok": True, "message": "Connectivity stats reset"})


# ── WebSocket Handler ────────────────────────────────────────────────────────

async def ws_handler(ws: WebSocket) -> None:
    user = await _ws_user(ws)
    if user is None:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await ws.accept()
    registry = get_session_registry()
    param_session_id = ws.query_params.get("session_id")
    client = None
    if param_session_id:
        existing = registry.get(param_session_id)
        if existing and isinstance(existing, ClientSession) and not existing.started:
            client = existing
            client.user_email = user.email

    if client is None:
        client_id = param_session_id or str(uuid.uuid4())
        client = ClientSession(id=client_id, user_email=user.email)
        registry.put(client.id, client)

    client.client_addr = (
        f"{ws.client.host}:{ws.client.port}" if ws.client else "unknown"
    )

    GLOBAL_STATS.total_sessions += 1
    GLOBAL_STATS.active_sessions_peak = max(
        GLOBAL_STATS.active_sessions_peak, registry.count()
    )
    GLOBAL_STATS.record_event(
        "client_connected",
        {"session_id": client.id, "client_addr": client.client_addr},
    )
    logger.info(
        "Client connected: %s %s (%s)", client.id, client.client_addr, user.email
    )

    server_ready_sent = await client.send(
        ws,
        {
            "type": "server_ready",
            "session_id": client.id,
            "message": "Connected",
            "source": "server",
            "stats_endpoint": "/api/connectivity/stats",
        },
    )

    logger.info(
        "server_ready sent | session=%s | success=%s",
        client.id,
        server_ready_sent,
    )

    try:
        while True:
            raw = await ws.receive_text()
            GLOBAL_STATS.ws_messages_in += 1
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError as exc:
                GLOBAL_STATS.errors += 1
                await client.send(
                    ws,
                    {
                        "type": "error",
                        "message": f"Invalid JSON: {exc.msg}",
                        "source": "server",
                    },
                )
                continue

            typ = msg.get("type")

            logger.info(
                "WebSocket message received | session=%s | type=%s",
                client.id,
                typ,
            )
            
            if typ == "start":
                start_session_id = msg.get("session_id")
                if start_session_id and start_session_id != client.id:
                    pre_session = registry.get(start_session_id)
                    if pre_session:
                        if pre_session.system_prompt:
                            client.system_prompt = pre_session.system_prompt
                        if pre_session.voice_id:
                            client.voice_id = pre_session.voice_id
                        if pre_session.request_metadata:
                            client.request_metadata = pre_session.request_metadata
                        client.provider = getattr(pre_session, "provider", client.provider)
                        registry.pop(start_session_id)
                elif not client.system_prompt or client.system_prompt == NOVA_SYSTEM_PROMPT:
                    client.system_prompt = msg.get("system_prompt") or client.system_prompt

                client.voice_id = client.voice_id or msg.get("voice_id")
                await client.send(
                    ws,
                    {
                        "type": "info",
                        "message": "Session started",
                        "session_id": client.id,
                        "source": "server",
                    },
                )
                await ensure_started(client, ws)

            elif typ == "text":
                text = str(msg.get("text") or "").strip()
                if msg.get("opener"):
                    # The backend owns the opener so it is a stage cue, not something the speaker said.
                    text = build_opener_cue(client.request_metadata)
                if not text:
                    await client.send(
                        ws,
                        {
                            "type": "warning",
                            "message": "Empty text ignored",
                            "source": "server",
                        },
                    )
                    continue
                await ensure_started(client, ws)
                if client.using_nova and client.nova_session:
                    send_text = getattr(client.nova_session, "send_text", None)
                    if callable(send_text):
                        await send_text(text)
                    else:
                        await client.send(
                            ws,
                            {
                                "type": "warning",
                                "message": "Nova session has no send_text(); using fallback",
                                "source": "server",
                            },
                        )
                        await fallback_reply(client, ws, text)
                else:
                    await fallback_reply(client, ws, f"Fallback response to: {text}")

            elif typ == "audio":
                await ensure_started(client, ws)
                audio_b64 = msg.get("audio")
                if not isinstance(audio_b64, str) or not audio_b64:
                    await client.send(
                        ws,
                        {
                            "type": "warning",
                            "message": "Audio packet missing base64 audio",
                            "source": "server",
                        },
                    )
                    continue
                try:
                    audio = b64d(audio_b64)
                except Exception as exc:
                    GLOBAL_STATS.errors += 1
                    await client.send(
                        ws,
                        {
                            "type": "error",
                            "message": f"Invalid audio base64: {exc}",
                            "source": "server",
                        },
                    )
                    continue
                if len(audio) > MAX_AUDIO_BYTES:
                    await client.send(
                        ws,
                        {
                            "type": "warning",
                            "message": f"Audio chunk too large: {len(audio)} bytes",
                            "source": "server",
                        },
                    )
                    continue

                now = time.monotonic()
                gap = (
                    None
                    if client.last_input_audio_at is None
                    else (now - client.last_input_audio_at) * 1000
                )
                client.last_input_audio_at = now
                client.input_audio_chunks += 1
                client.input_audio_bytes += len(audio)
                GLOBAL_STATS.record_input_audio(len(audio), gap)

                if client.using_nova and client.nova_session:
                    if not client.audio_input_open:
                        start_audio = getattr(
                            client.nova_session, "start_audio_input", None
                        )
                        if callable(start_audio):
                            try:
                                await start_audio()
                            except RuntimeError as exc:
                                if "already" not in str(exc).lower():
                                    raise
                        client.audio_input_open = True
                    await client.nova_session.send_audio_chunk(audio)

            elif typ == "end":
                await close_audio_input(client, ws)
                await client.send(
                    ws,
                    {
                        "type": "info",
                        "message": "Audio input ended. Waiting for response...",
                        "input_chunks": client.input_audio_chunks,
                        "input_bytes": client.input_audio_bytes,
                        "source": "server",
                    },
                )

            elif typ == "ping":
                GLOBAL_STATS.ping_count += 1
                await client.send(
                    ws,
                    {
                        "type": "pong",
                        "client_ts": msg.get("client_ts"),
                        "nonce": msg.get("nonce"),
                        "server_ts_ms": now_ms(),
                        "server_monotonic_ms": monotonic_ms(),
                        "source": "server",
                    },
                )

            elif typ == "client_metrics":
                client.last_client_metrics = {
                    "ts_ms": now_ms(),
                    "ws_rtt_ms": msg.get("ws_rtt_ms"),
                    "playback_queue_sec": msg.get("playback_queue_sec"),
                    "playback_underruns": msg.get("playback_underruns"),
                    "browser_audio_context_state": msg.get("audio_context_state"),
                    "mic_on": msg.get("mic_on"),
                    "micsent": msg.get("micsent"),
                    "audio_played": msg.get("audio_played"),
                    "client_input_kbps": msg.get("client_input_kbps"),
                    "client_output_kbps": msg.get("client_output_kbps"),
                }

            elif typ == "stats":
                registry = get_session_registry()
                if REALTIME_PROVIDER == "devnagri":
                    sdk_available = bool(BLACKBIRD_API_KEY and DEVNAGRI_TTS_API_KEY)
                    sdk_import_error = None
                elif REALTIME_PROVIDER == "azure":
                    sdk_available = bool(
                        AZURE_OPENAI_REALTIME_ENDPOINT
                        and AZURE_OPENAI_REALTIME_API_KEY
                        and AZURE_OPENAI_REALTIME_DEPLOYMENT
                    )
                    sdk_import_error = None
                else:
                    sdk_available = ChatBedrockNovaSonic is not None
                    sdk_import_error = NOVA_IMPORT_ERROR
                await client.send(
                    ws,
                    {
                        "type": "stats",
                        "stats": build_stats(
                            session_registry=registry,
                            nova_sdk_available=sdk_available,
                            nova_import_error=sdk_import_error,
                        ),
                        "source": "server",
                    },
                )

            elif typ == "close":
                break

            else:
                await client.send(
                    ws,
                    {
                        "type": "warning",
                        "message": f"Unknown message type: {typ}",
                        "source": "server",
                    },
                )

    except WebSocketDisconnect:
        logger.info("Client disconnected: %s", client.id)
    except Exception as exc:
        client.telemetry_status = "error"
        client.telemetry_error_type = type(exc).__name__
        GLOBAL_STATS.errors += 1
        GLOBAL_STATS.last_error = f"WS handler failed: {type(exc).__name__}: {exc}"
        logger.exception("WebSocket handler failed")
        await client.send(
            ws,
            {
                "type": "error",
                "message": f"Server error: {type(exc).__name__}: {exc}",
                "source": "server",
            },
        )
    # finally:
    #     await client.close()
    #     registry.pop(client.id)
    #     GLOBAL_STATS.sessions_ended += 1
    #     GLOBAL_STATS.record_event("client_disconnected", {"session_id": client.id})
    #     with contextlib.suppress(Exception):
    #         if ws.client_state == WebSocketState.CONNECTED:
    #             await ws.close()
    finally:
        with contextlib.suppress(Exception):
            await client.close()

        # Persist one consolidated token and cost record.
        persist_nova_session_usage(client)

        registry.pop(client.id)
        GLOBAL_STATS.sessions_ended += 1
        GLOBAL_STATS.record_event(
            "client_disconnected",
            {"session_id": client.id},
        )

        with contextlib.suppress(Exception):
            if ws.client_state == WebSocketState.CONNECTED:
                await ws.close()

@router.websocket("/ws/nova2-sonic")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws_handler(ws)


@router.websocket("/ws/sonic")
async def ws_endpoint_alias(ws: WebSocket) -> None:
    await ws_handler(ws)
