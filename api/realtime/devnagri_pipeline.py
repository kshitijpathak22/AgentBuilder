"""
Devnagri cascaded voice pipeline: Blackbird streaming ASR -> OpenAI-compatible text LLM -> Devnagri TTS.

Drop-in alternative to the Azure/Nova speech-to-speech sessions. It implements the same duck-typed
session interface the WebSocket handler drives (send_audio_chunk / send_text / start_audio_input /
end_audio_input / close) and emits the same client-facing events, so the frontend is unchanged.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import re
import ssl
import time
import uuid
from typing import Any, Optional

import certifi

# SSL context that trusts the certifi CA bundle (fixes macOS cert issues with Devnagri/Blackbird)
_SSL_CTX = ssl.create_default_context(cafile=certifi.where())

import httpx
import websockets
from fastapi import WebSocket
from openai import AsyncOpenAI

from api.core.config import (
    BLACKBIRD_API_KEY,
    BLACKBIRD_WS_URL,
    DEVNAGRI_ASR_MODE,
    DEVNAGRI_AUDIO_LEAD_MS,
    DEVNAGRI_BARGE_IN_MIN_WORDS,
    DEVNAGRI_HISTORY_TURNS,
    DEVNAGRI_LLM_EXTRA_BODY,
    DEVNAGRI_TTS_API_KEY,
    DEVNAGRI_TTS_EMOTION_PROFILES,
    DEVNAGRI_TTS_SAMPLE_RATE,
    DEVNAGRI_TTS_URL,
    DEVNAGRI_TTS_VOICE_ID,
    DEVNAGRI_TURN_COMMIT_MS,
    LLM_MODEL,
    LLM_TIMEOUT_SECONDS,
    LLM_VERIFY_SSL,
    NOVA_INPUT_AUDIO_SAMPLE_RATE,
    OLLAMA_API_KEY,
    OLLAMA_BASE_URL,
)
from api.observability.nova_usage import NovaUsage, apply_usage_update
from api.realtime.audio import b64e, resample_pcm16
from api.realtime.events import emit_final_transcript, normalise_text
from api.realtime.stats import GLOBAL_STATS
from shared_logger import get_logger

logger = get_logger(__name__)

SOURCE = "devnagri"
OUTPUT_SAMPLE_RATE = 24000  # the rate the frontend playback AudioContext runs at
FRAME_MS = 100
MAX_CHUNK_CHARS = 220
ASR_MAX_RECONNECTS = 3

EMOTIONS = ("neutral", "skeptical", "enthusiastic", "frustrated", "encouraging")
DIFFICULTY_DEFAULT_EMOTION = {
    "Easy": "encouraging",
    "Medium": "neutral",
    "Hard": "skeptical",
    "Expert": "skeptical",
}

# Devnagri inline tag spoken at the start of each sentence for our emotion labels (see the
# "Emotion & expressive tags" section of the Devnagri TTS docs). An emotion profile's "tag" overrides it.
DEVNAGRI_EMOTION_TAGS = {
    "neutral": "",
    "skeptical": "<|emotion:contemplation|>",
    "enthusiastic": "<|emotion:elation|>",
    "frustrated": "<|emotion:bitterness|>",
    "encouraging": "<|emotion:contentment|>",
}

EMOTION_INSTRUCTION = (
    "VOICE DELIVERY: Your reply is spoken aloud by a text-to-speech voice. "
    "Begin every sentence with exactly one emotion tag from "
    "<emo:neutral> <emo:skeptical> <emo:enthusiastic> <emo:frustrated> <emo:encouraging>, "
    "chosen to match how this persona genuinely feels at that moment. "
    "Your baseline is <emo:{default}>. Never mention or explain the tags. "
    "Write plain spoken sentences only: no markdown, lists, emojis or stage directions."
)

NOTES_INSTRUCTION = (
    "You keep concise meeting notes for the counterpart in an ongoing business conversation. "
    "Merge the earlier notes with the new transcript excerpt (USER is the other person, ASSISTANT is the counterpart) "
    "and return updated notes under exactly these labels, one line each, at most 150 words in total:\n"
    "Their claims and numbers:\nTheir commitments:\nObjections raised (resolved or open):\n"
    "Open questions:\nContradictions:\nFacts the counterpart stated about its own company:\n"
    "Copy names and numbers exactly. Write 'none' for an empty label. No other text."
)

# Languages Blackbird is told to listen for; anything else (auto, European languages) uses Indian English.
ASR_LANGUAGES = ("hi", "gu", "mr", "ta", "te", "bn", "kn", "ml", "pa")

# "Stop / wait / be quiet": interrupts the counterpart even as a single word, and gets a short
# acknowledgement instead of an LLM reply. A turn counts only if every word is from STOP_WORDS.
STOP_TRIGGERS = {
    "stop", "wait", "hold", "chup", "chupp", "ruko", "ruk", "rukiye", "rukjao", "bas", "thamba", "aapu",
    "चुप", "रुको", "रुक", "रुकिए", "बस", "थांबा", "थांब", "ઊભા", "થોભો", "બસ", "நிறுத்து", "நிறுத்துங்கள்",
    "ఆపు", "ఆపండి", "থামুন", "থামো", "ನಿಲ್ಲಿಸಿ", "നിർത്തൂ", "ਰੁਕੋ", "ਬੱਸ",
}
STOP_WORDS = STOP_TRIGGERS | {
    "on", "please", "ho", "hoja", "jao", "ja", "jaiye", "karo", "kar", "ek", "one", "1", "minute", "min",
    "second", "sec", "just", "ji", "sir", "ma'am", "madam", "bhai", "yaar", "arre", "hey", "ok", "okay",
    "हो", "जाओ", "जा", "जाइए", "करो", "कर", "एक", "मिनट", "जरा", "ज़रा", "जी", "भाई", "यार", "अरे",
    "रहो", "करा", "कराना", "मिनिट",
}
STOP_ACKS = {
    "en": "Sure, go ahead.",
    "hi": "जी, बोलिए।",
    "gu": "હા, બોલો.",
    "mr": "हो, बोला.",
    "ta": "சரி, சொல்லுங்கள்.",
    "te": "సరే, చెప్పండి.",
    "bn": "হ্যাঁ, বলুন।",
    "kn": "ಸರಿ, ಹೇಳಿ.",
    "ml": "ശരി, പറയൂ.",
    "pa": "ਜੀ, ਦੱਸੋ।",
    "fr": "D'accord, je vous écoute.",
    "de": "Gut, bitte sprechen Sie.",
    "es": "Claro, adelante.",
    "it": "Certo, prego.",
}
_HINDI_ROMAN_STOPS = {"chup", "chupp", "ruko", "ruk", "rukiye", "rukjao", "bas"}


def _stop_words(text: str) -> list[str]:
    return [w.strip(".,!?।|'\"-") for w in text.lower().split() if w.strip(".,!?।|'\"-")]


def is_stop_command(text: str) -> bool:
    words = _stop_words(text)
    return 0 < len(words) <= 6 and any(w in STOP_TRIGGERS for w in words) and all(w in STOP_WORDS for w in words)


def collapse_repeats(text: str, min_repeats: int = 3, max_ngram: int = 6) -> str:
    """Speech recognition sometimes loops ("Thank you Sir Thank you Sir ..."); keep one copy of each run."""
    tokens = text.split()
    keys = [t.strip(".,!?।").lower() for t in tokens]
    out: list[str] = []
    i = 0
    while i < len(tokens):
        for n in range(1, max_ngram + 1):
            count = 1
            while keys[i + count * n:i + (count + 1) * n] == keys[i:i + n] and i + (count + 1) * n <= len(keys):
                count += 1
            if count >= min_repeats:
                out.extend(tokens[i:i + n])
                i += n * count
                break
        else:
            out.append(tokens[i])
            i += 1
    return " ".join(out)


_TAG_RE = re.compile(r"<emo:([a-zA-Z]+)>")
_PARTIAL_TAG_RE = re.compile(r"<(e(m(o(:[a-zA-Z]*)?)?)?)?$")
_SENTENCE_END_RE = re.compile(r"[.?!।]+[\"')\]*_]*\s|\n")
_CLAUSE_END_RE = re.compile(r"[,;:]\s")
_MARKDOWN_RE = re.compile(r"[*#_`]|<[^>]*>")


def _clean_chunk(text: str) -> str:
    return " ".join(_MARKDOWN_RE.sub("", text).split())


class SentenceChunker:
    """Buffers streamed LLM tokens into speakable (emotion, text) chunks, stripping emotion tags.

    The first chunk is released early at a clause boundary to cut time-to-first-audio; later
    chunks split on sentence boundaries. Tags may arrive split across tokens.
    """

    def __init__(self, default_emotion: str = "neutral") -> None:
        self.emotion = default_emotion
        self._buf = ""
        self._emitted_any = False

    def feed(self, delta: str) -> list[tuple[str, str]]:
        self._buf += delta
        out: list[tuple[str, str]] = []
        while (chunk := self._next_chunk()) is not None:
            if chunk[1]:
                out.append(chunk)
        return out

    def flush(self) -> list[tuple[str, str]]:
        out = self.feed("")
        self._buf = _PARTIAL_TAG_RE.sub("", self._buf)
        text = _clean_chunk(self._buf)
        self._buf = ""
        if text:
            out.append((self.emotion, text))
        return out

    def _next_chunk(self) -> Optional[tuple[str, str]]:
        tag = _TAG_RE.search(self._buf)
        region = self._buf[: tag.start()] if tag else self._buf
        if not tag:
            # Never cut inside a tag that is still arriving.
            region = _PARTIAL_TAG_RE.sub("", region)

        cut = self._find_cut(region)
        if cut is not None:
            text = region[:cut]
            self._buf = self._buf[cut:]
            return self._make(text)

        if tag:
            # A tag starts a new sentence: whatever precedes it is a chunk of the old emotion.
            text = region
            emotion = self.emotion
            self._buf = self._buf[tag.end():]
            name = tag.group(1).lower()
            if name in EMOTIONS:
                self.emotion = name
            cleaned = _clean_chunk(text)
            if cleaned:
                self._emitted_any = True
            return emotion, cleaned
        return None

    def _find_cut(self, region: str) -> Optional[int]:
        cuts = []
        sentence = _SENTENCE_END_RE.search(region)
        if sentence:
            cuts.append(sentence.end())
        if not self._emitted_any:
            for clause in _CLAUSE_END_RE.finditer(region):
                if len(region[: clause.end()].split()) >= 4:
                    cuts.append(clause.end())
                    break
        if cuts:
            return min(cuts)
        if len(region) > MAX_CHUNK_CHARS:
            space = region.rfind(" ", 0, MAX_CHUNK_CHARS)
            return space if space > 0 else MAX_CHUNK_CHARS
        return None

    def _make(self, text: str) -> tuple[str, str]:
        cleaned = _clean_chunk(text)
        if cleaned:
            self._emitted_any = True
        return self.emotion, cleaned


class PcmReframer:
    """Resamples a raw PCM16 byte stream to the output rate and re-slices it into fixed frames."""

    def __init__(self, src_rate: int, dst_rate: int = OUTPUT_SAMPLE_RATE, frame_ms: int = FRAME_MS) -> None:
        self._src_rate = src_rate
        self._dst_rate = dst_rate
        self._frame_bytes = dst_rate * 2 * frame_ms // 1000
        self._carry = b""
        self._out = b""

    def push(self, data: bytes) -> list[bytes]:
        data = self._carry + data
        even = len(data) - (len(data) % 2)
        self._carry = data[even:]
        self._out += resample_pcm16(data[:even], self._src_rate, self._dst_rate)
        frames = []
        while len(self._out) >= self._frame_bytes:
            frames.append(self._out[: self._frame_bytes])
            self._out = self._out[self._frame_bytes:]
        return frames

    def flush(self) -> list[bytes]:
        out, self._out, self._carry = self._out, b"", b""
        return [out] if out else []


def _load_json(raw: str, name: str) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except json.JSONDecodeError:
        logger.warning("%s is not valid JSON; ignoring", name)
        return {}
    return value if isinstance(value, dict) else {}


class DevnagriCascadedSession:
    """Duck-typed realtime session backed by Blackbird ASR, the text LLM and Devnagri TTS."""

    def __init__(self, client: Any, ws: WebSocket) -> None:
        self._client = client
        self._ws = ws
        metadata = client.request_metadata or {}
        self._reply_language = str(metadata.get("response_language") or "auto")
        self._language = self._reply_language if self._reply_language in ASR_LANGUAGES else "en"
        default_emotion = DIFFICULTY_DEFAULT_EMOTION.get(str(metadata.get("client_type")), "neutral")
        self._default_emotion = default_emotion
        self._system_prompt = f"{client.system_prompt}\n\n{EMOTION_INSTRUCTION.format(default=default_emotion)}"
        self._emotion_profiles = _load_json(DEVNAGRI_TTS_EMOTION_PROFILES, "DEVNAGRI_TTS_EMOTION_PROFILES")
        self._llm_extra_body = _load_json(DEVNAGRI_LLM_EXTRA_BODY, "DEVNAGRI_LLM_EXTRA_BODY")
        voice = str(client.voice_id or DEVNAGRI_TTS_VOICE_ID)
        self._voice_id = int(voice) if voice.isdigit() else int(DEVNAGRI_TTS_VOICE_ID)

        self.history: list[dict[str, str]] = []
        # Turns that fall out of the verbatim window are folded into these notes in the background.
        self._notes = ""
        self._notes_upto = 0
        self._notes_task: Optional[asyncio.Task] = None
        self._pending_user_text: list[str] = []
        self._spoken: list[str] = []
        self._last_spoken = ""
        self._playback_end = 0.0
        self._turn_committed_at: Optional[float] = None
        self._first_audio_sent = False

        self._asr_ws: Any = None
        self._asr_task: Optional[asyncio.Task] = None
        self._commit_task: Optional[asyncio.Task] = None
        self._response_task: Optional[asyncio.Task] = None
        self._tts_tasks: set[asyncio.Task] = set()
        self._closing = False
        self._closed = asyncio.Event()

        self._http = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0), verify=certifi.where())
        self._llm = AsyncOpenAI(
            base_url=OLLAMA_BASE_URL,
            api_key=OLLAMA_API_KEY or "not-needed",
            timeout=LLM_TIMEOUT_SECONDS,
            max_retries=0,
            http_client=httpx.AsyncClient(verify=LLM_VERIFY_SSL, timeout=LLM_TIMEOUT_SECONDS),
        )

    # ── Session interface used by the WebSocket handler ──────────────

    async def connect(self) -> None:
        await self._open_asr()
        self._asr_task = asyncio.create_task(self._asr_loop(), name=f"devnagri-asr-{self._client.id}")

    async def send_audio_chunk(self, audio: bytes) -> None:
        if self._asr_ws is None:
            return
        with contextlib.suppress(websockets.ConnectionClosed):
            await self._asr_ws.send(audio)

    async def send_text(self, text: str) -> None:
        await self._start_response(text)

    async def start_audio_input(self) -> None:
        return None

    async def end_audio_input(self) -> None:
        # The frontend's own VAD says the user stopped talking: commit now instead of waiting.
        if self._closing or self._client.closing:
            return
        self._cancel_commit()
        await self._commit_turn()

    async def wait_closed(self) -> None:
        await self._closed.wait()

    async def close(self) -> None:
        if self._closing:
            return
        self._closing = True
        self._cancel_commit()
        await self._cancel_response()
        if self._notes_task:
            self._notes_task.cancel()
        if self._asr_task:
            self._asr_task.cancel()
            with contextlib.suppress(BaseException):
                await self._asr_task
        if self._asr_ws is not None:
            with contextlib.suppress(Exception):
                await self._asr_ws.send(json.dumps({"type": "finalize"}))
            with contextlib.suppress(Exception):
                await self._asr_ws.close()
        with contextlib.suppress(Exception):
            await self._http.aclose()
        with contextlib.suppress(Exception):
            await self._llm.close()
        self._closed.set()

    # ── ASR: Blackbird streaming WebSocket ───────────────────────────

    async def _open_asr(self) -> None:
        self._asr_ws = await websockets.connect(BLACKBIRD_WS_URL, max_size=4 * 1024 * 1024, ping_interval=20, ssl=_SSL_CTX)
        await self._asr_ws.send(
            json.dumps(
                {
                    "api_key": BLACKBIRD_API_KEY,
                    "language": self._language,
                    "mode": DEVNAGRI_ASR_MODE,
                    "sample_rate": NOVA_INPUT_AUDIO_SAMPLE_RATE,
                    "encoding": "pcm_s16le",
                    "interim_results": True,
                }
            )
        )
        ready = json.loads(await asyncio.wait_for(self._asr_ws.recv(), timeout=10))
        if ready.get("type") != "ready":
            raise RuntimeError(f"Blackbird rejected stream config: {ready}")

    async def _asr_loop(self) -> None:
        reconnects = 0
        while not self._closing:
            try:
                async for raw in self._asr_ws:
                    if isinstance(raw, bytes):
                        continue
                    with contextlib.suppress(json.JSONDecodeError):
                        await self._on_asr_event(json.loads(raw))
            except asyncio.CancelledError:
                raise
            except websockets.ConnectionClosed:
                pass
            except Exception:
                logger.exception("Blackbird ASR loop failed | session=%s", self._client.id)

            if self._closing:
                break
            reconnects += 1
            if reconnects > ASR_MAX_RECONNECTS:
                await self._client.send(
                    self._ws,
                    {"type": "error", "message": "Speech recognition disconnected", "source": SOURCE},
                )
                break
            logger.warning("Reconnecting Blackbird ASR (%d) | session=%s", reconnects, self._client.id)
            await asyncio.sleep(0.5 * reconnects)
            with contextlib.suppress(Exception):
                await self._open_asr()

    async def _on_asr_event(self, event: dict[str, Any]) -> None:
        ev_type = event.get("type")
        text = str(event.get("text") or "").strip()

        if ev_type == "partial":
            if text:
                # The user is still talking: hold the commit, and interrupt the coach if needed.
                self._cancel_commit()
                if self._should_barge_in(text):
                    await self._barge_in()
        elif ev_type == "final":
            text = collapse_repeats(text)
            if text and not self._looks_like_echo(text):
                self._pending_user_text.append(text)
                if self._should_barge_in(text):
                    await self._barge_in()
                self._arm_commit()
        elif ev_type == "error":
            message = event.get("message") or event.get("code") or "unknown error"
            GLOBAL_STATS.errors += 1
            GLOBAL_STATS.last_error = f"Blackbird ASR error: {message}"
            await self._client.send(
                self._ws,
                {"type": "warning", "message": f"Speech recognition error: {message}", "source": SOURCE},
            )

    def _looks_like_echo(self, text: str) -> bool:
        """Coach audio leaking back through the mic would otherwise become a user turn."""
        key = normalise_text(text)
        if len(key.split()) < 3:
            return False
        spoken = normalise_text(" ".join(self._spoken) + " " + self._last_spoken)
        return key in spoken

    def _should_barge_in(self, text: str) -> bool:
        if not (self._response_task and not self._response_task.done()):
            return False
        long_enough = len(text.split()) >= DEVNAGRI_BARGE_IN_MIN_WORDS or is_stop_command(text)
        return long_enough and not self._looks_like_echo(text)

    async def _barge_in(self) -> None:
        GLOBAL_STATS.record_event("devnagri_barge_in", {"session_id": self._client.id})
        # Tells the browser to drop the audio it already has queued (the pacing lead).
        await self._client.send(self._ws, {"type": "audio_interrupted", "source": SOURCE})
        await self._cancel_response()

    # ── Turn taking ──────────────────────────────────────────────────

    def _arm_commit(self) -> None:
        self._cancel_commit()
        self._commit_task = asyncio.create_task(self._commit_after(DEVNAGRI_TURN_COMMIT_MS / 1000))

    def _cancel_commit(self) -> None:
        if self._commit_task and not self._commit_task.done():
            self._commit_task.cancel()
        self._commit_task = None

    async def _commit_after(self, delay: float) -> None:
        await asyncio.sleep(delay)
        self._commit_task = None
        # Once committing has begun, a late partial must not cancel it half-way (transcript sent, no reply).
        await asyncio.shield(self._commit_turn())

    async def _commit_turn(self) -> None:
        text = " ".join(self._pending_user_text).strip()
        self._pending_user_text.clear()
        if not text:
            return
        await emit_final_transcript(self._client, self._ws, "user", text, f"devnagri-user-{uuid.uuid4().hex[:12]}")
        await self._start_response(text, self._stop_ack(text) if is_stop_command(text) else None)

    def _stop_ack(self, text: str) -> str:
        language = self._reply_language
        if language not in STOP_ACKS:  # auto: answer Hindi stop words in Hinglish, anything else in English
            language = "hi_roman" if set(_stop_words(text)) & _HINDI_ROMAN_STOPS else "en"
        return "Ji, boliye." if language == "hi_roman" else STOP_ACKS[language]

    async def _start_response(self, user_text: str, fixed_reply: Optional[str] = None) -> None:
        await self._cancel_response()
        self._turn_committed_at = time.monotonic()
        self._first_audio_sent = False
        self._response_task = asyncio.create_task(
            self._respond(user_text, fixed_reply), name=f"devnagri-response-{self._client.id}"
        )

    async def _cancel_response(self) -> None:
        task = self._response_task
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(BaseException):
                await task
        self._response_task = None

    # ── Response: LLM -> chunker -> TTS -> paced audio ───────────────

    async def _respond(self, user_text: str, fixed_reply: Optional[str] = None) -> None:
        content_id = f"devnagri-{uuid.uuid4().hex[:12]}"
        self.history.append({"role": "user", "content": user_text})
        self._spoken = []
        chunk_q: asyncio.Queue[Optional[tuple[str, str]]] = asyncio.Queue()
        if fixed_reply:  # spoken as-is, no LLM call
            chunk_q.put_nowait((self._default_emotion, fixed_reply))
            chunk_q.put_nowait(None)
            producer = asyncio.create_task(asyncio.sleep(0))
        else:
            producer = asyncio.create_task(self._llm_to_chunks(chunk_q))
        interrupted = False
        try:
            await self._speak_chunks(chunk_q, content_id)
            await producer
        except asyncio.CancelledError:
            interrupted = True
            raise
        except Exception as exc:
            GLOBAL_STATS.errors += 1
            GLOBAL_STATS.last_error = f"Devnagri response failed: {type(exc).__name__}: {exc}"
            logger.exception("Devnagri response failed | session=%s", self._client.id)
            await self._client.send(
                self._ws,
                {"type": "error", "message": f"Voice response failed: {exc}", "source": SOURCE},
            )
        finally:
            producer.cancel()
            for task in list(self._tts_tasks):
                task.cancel()
            with contextlib.suppress(BaseException):
                await producer
            spoken = " ".join(self._spoken).strip()
            self._last_spoken = spoken
            self._spoken = []
            if spoken:
                # Only what was actually voiced goes into history and the transcript.
                self.history.append({"role": "assistant", "content": spoken + (" —" if interrupted else "")})
                await emit_final_transcript(self._client, self._ws, "assistant", spoken, content_id)
            self._schedule_notes()
            if self._client.output_audio_open:
                self._client.output_audio_open = False
                await self._client.send(self._ws, {"type": "audio_end", "source": SOURCE})

    async def _llm_to_chunks(self, chunk_q: asyncio.Queue) -> None:
        chunker = SentenceChunker(self._default_emotion)
        system = self._system_prompt
        if self._notes:
            system += f"\n\nMEETING NOTES SO FAR (earlier part of this conversation):\n{self._notes}"
        messages = [{"role": "system", "content": system}] + self.history[-DEVNAGRI_HISTORY_TURNS:]
        try:
            stream = await self._llm.chat.completions.create(
                model=LLM_MODEL,
                messages=messages,
                temperature=0.7,
                stream=True,
                stream_options={"include_usage": True},
                extra_body=self._llm_extra_body or None,
            )
            try:
                async for event in stream:
                    if getattr(event, "usage", None):
                        self._record_usage(event.usage)
                    if not event.choices:
                        continue
                    for chunk in chunker.feed(event.choices[0].delta.content or ""):
                        await chunk_q.put(chunk)
            finally:
                with contextlib.suppress(Exception):
                    await stream.close()
            for chunk in chunker.flush():
                await chunk_q.put(chunk)
        finally:
            chunk_q.put_nowait(None)

    def _schedule_notes(self) -> None:
        window_start = len(self.history) - DEVNAGRI_HISTORY_TURNS
        if window_start <= self._notes_upto or (self._notes_task and not self._notes_task.done()):
            return
        self._notes_task = asyncio.create_task(self._refresh_notes(window_start))

    async def _refresh_notes(self, upto: int) -> None:
        excerpt = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in self.history[self._notes_upto:upto])
        try:
            response = await self._llm.chat.completions.create(
                model=LLM_MODEL,
                messages=[
                    {"role": "system", "content": NOTES_INSTRUCTION},
                    {"role": "user", "content": f"Earlier notes:\n{self._notes or 'none'}\n\nNew excerpt:\n{excerpt}"},
                ],
                temperature=0.1,
                max_tokens=400,
                extra_body=self._llm_extra_body or None,
            )
            notes = (response.choices[0].message.content or "").strip()
            if response.usage:
                self._record_usage(response.usage)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Without notes the window still bounds the prompt; only older detail is lost.
            logger.exception("Devnagri meeting notes update failed | session=%s", self._client.id)
            return
        if notes:
            self._notes = notes
            self._notes_upto = upto

    def _record_usage(self, usage: Any) -> None:
        apply_usage_update(
            self._client.nova_usage,
            NovaUsage(
                text_input_tokens=int(usage.prompt_tokens or 0),
                text_output_tokens=int(usage.completion_tokens or 0),
                total_tokens=int(usage.total_tokens or 0),
                mode="delta",
            ),
        )
        self._client.nova_usage_events += 1

    async def _next_tts(self, chunk_q: asyncio.Queue) -> Optional[tuple[str, asyncio.Queue, asyncio.Task]]:
        item = await chunk_q.get()
        if item is None:
            return None
        emotion, text = item
        audio_q: asyncio.Queue[Optional[bytes]] = asyncio.Queue()
        task = asyncio.create_task(self._tts_fetch(text, emotion, audio_q))
        self._tts_tasks.add(task)
        task.add_done_callback(self._tts_tasks.discard)
        return text, audio_q, task

    async def _speak_chunks(self, chunk_q: asyncio.Queue, content_id: str) -> None:
        current = await self._next_tts(chunk_q)
        while current:
            text, audio_q, fetch_task = current
            # Prefetch one chunk ahead: at most two TTS generations in flight (Devnagri's guidance).
            next_task = asyncio.create_task(self._next_tts(chunk_q))
            try:
                reframer = PcmReframer(DEVNAGRI_TTS_SAMPLE_RATE)
                announced = False
                while (data := await audio_q.get()) is not None:
                    for frame in reframer.push(data):
                        if not announced:
                            announced = True
                            await self._announce_chunk(text, content_id)
                        await self._send_audio_frame(frame)
                for frame in reframer.flush():
                    await self._send_audio_frame(frame)
                try:
                    await fetch_task
                except Exception as exc:
                    logger.warning("Devnagri TTS failed for chunk | session=%s | %s", self._client.id, exc)
                    await self._client.send(
                        self._ws,
                        {"type": "warning", "message": f"Speech synthesis failed: {exc}", "source": SOURCE},
                    )
                if not announced:
                    await self._announce_chunk(text, content_id)
            except BaseException:
                next_task.cancel()
                with contextlib.suppress(BaseException):
                    await next_task
                raise
            current = await next_task

    async def _announce_chunk(self, text: str, content_id: str) -> None:
        self._spoken.append(text)
        await self._client.send(
            self._ws,
            {
                "type": "transcript",
                "role": "assistant",
                "text": text,
                "final": False,
                "content_id": content_id,
                "source": SOURCE,
            },
        )

    def _tts_payload(self, text: str, emotion: str) -> dict[str, Any]:
        profile = self._emotion_profiles.get(emotion) or {}
        tag = profile.get("tag", DEVNAGRI_EMOTION_TAGS.get(emotion, ""))
        payload: dict[str, Any] = {
            "model": "dvn-tts-v1",
            "input": f"{tag}{text}",
            "stream": True,
            "response_format": "pcm",
        }
        if profile.get("ref_audio_url"):
            # voice_id would override references, so it is left out when a reference clip is used.
            payload["references"] = [{"audio_path": profile["ref_audio_url"], "text": profile.get("ref_text", "")}]
        else:
            payload["voice_id"] = self._voice_id
        if "temperature" in profile:
            payload["temperature"] = profile["temperature"]
        return payload

    async def _tts_fetch(self, text: str, emotion: str, audio_q: asyncio.Queue) -> None:
        payload = self._tts_payload(text, emotion)
        headers = {"Authorization": f"Bearer {DEVNAGRI_TTS_API_KEY}"}
        try:
            for attempt in range(2):
                async with self._http.stream("POST", DEVNAGRI_TTS_URL, json=payload, headers=headers) as resp:
                    if resp.status_code in (429, 503) and attempt == 0:
                        await resp.aread()
                        retry_after = resp.headers.get("retry-after", "")
                        await asyncio.sleep(min(float(retry_after), 2.0) if retry_after.isdigit() else 0.5)
                        continue
                    if resp.status_code != 200 or "json" in resp.headers.get("content-type", ""):
                        body = (await resp.aread())[:300]
                        raise RuntimeError(f"HTTP {resp.status_code}: {body.decode('utf-8', 'replace')}")
                    async for data in resp.aiter_bytes():
                        if data:
                            await audio_q.put(data)
                    return
        finally:
            audio_q.put_nowait(None)

    async def _send_audio_frame(self, frame: bytes) -> None:
        # The frontend cannot flush queued audio, so pace sends to real time plus a small lead:
        # on barge-in, at most the lead is left playing in the browser.
        now = time.monotonic()
        ahead = self._playback_end - now
        lead = DEVNAGRI_AUDIO_LEAD_MS / 1000
        if ahead > lead:
            await asyncio.sleep(ahead - lead)
            now = time.monotonic()

        client = self._client
        if not client.output_audio_open:
            payload: dict[str, Any] = {
                "type": "audio_start",
                "sample_rate": OUTPUT_SAMPLE_RATE,
                "format": "pcm_s16le",
                "channels": 1,
                "source": SOURCE,
            }
            if not self._first_audio_sent and self._turn_committed_at is not None:
                latency = (now - self._turn_committed_at) * 1000
                GLOBAL_STATS.record_first_audio_latency(latency)
                payload["first_audio_latency_ms"] = round(latency, 1)
            self._first_audio_sent = True
            client.output_audio_open = True
            await client.send(self._ws, payload)

        gap = None if client.last_output_audio_at is None else (now - client.last_output_audio_at) * 1000
        client.last_output_audio_at = now
        client.output_audio_chunks += 1
        client.output_audio_bytes += len(frame)
        GLOBAL_STATS.record_output_audio(len(frame), gap)
        await client.send(
            self._ws,
            {
                "type": "audio",
                "audio": b64e(frame),
                "sample_rate": OUTPUT_SAMPLE_RATE,
                "format": "pcm_s16le",
                "channels": 1,
                "chunk_index": client.output_audio_chunks,
                "source": SOURCE,
            },
        )
        self._playback_end = max(self._playback_end, now) + len(frame) / 2 / OUTPUT_SAMPLE_RATE


async def start_devnagri(client: Any, ws: WebSocket) -> None:
    client.nova_started = True
    missing = [
        name
        for name, value in (
            ("BLACKBIRD_API_KEY", BLACKBIRD_API_KEY),
            ("DEVNAGRI_TTS_API_KEY", DEVNAGRI_TTS_API_KEY),
            ("OLLAMA_BASE_URL", OLLAMA_BASE_URL),
            ("LLM_MODEL", LLM_MODEL),
        )
        if not value
    ]
    if missing:
        await client.send(
            ws,
            {
                "type": "warning",
                "message": f"Devnagri voice not configured (missing {', '.join(missing)}); fallback mode active",
                "source": "server",
            },
        )
        return

    session = DevnagriCascadedSession(client, ws)
    try:
        await session.connect()
        client.nova_session = session
        client.using_nova = True
        await client.send(
            ws,
            {
                "type": "info",
                "message": "Devnagri cascaded session opened",
                "model_id": LLM_MODEL,
                "voice_id": client.voice_id,
                "source": SOURCE,
            },
        )
        GLOBAL_STATS.record_event("devnagri_session_opened", {"session_id": client.id})
    except Exception as exc:
        await session.close()
        GLOBAL_STATS.errors += 1
        GLOBAL_STATS.last_error = f"Could not open Devnagri session: {type(exc).__name__}: {exc}"
        logger.exception("Could not open Devnagri cascaded session; fallback mode active")
        client.using_nova = False
        await client.send(
            ws,
            {
                "type": "warning",
                "message": f"Could not open Devnagri session; fallback mode active: {exc}",
                "source": "server",
            },
        )


async def devnagri_reader(client: Any, ws: WebSocket) -> None:
    """The pipeline sends to the browser itself; this keeps the reader-task lifecycle the same."""
    try:
        await client.nova_session.wait_closed()
    except asyncio.CancelledError:
        logger.info("Devnagri reader cancelled for session %s", client.id)
