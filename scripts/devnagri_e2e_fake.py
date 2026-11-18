"""
Offline end-to-end check of the Devnagri cascaded voice path, no API keys needed.

Starts fake Blackbird ASR (WebSocket), fake Devnagri TTS (chunked PCM) and a fake OpenAI-compatible
LLM (SSE) on localhost, runs the real Sales Coach API against them, then drives /ws/nova2-sonic the
way the browser does: create session -> start -> opener -> spoken turn -> barge-in -> close.

Usage:  python scripts/devnagri_e2e_fake.py      (exit code 0 = all checks passed)
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import math
import os
import socket
import struct
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


FAKE_PORT, API_PORT = _free_port(), _free_port()
FAKE = f"127.0.0.1:{FAKE_PORT}"
TOKEN = "e2e-token"
TTS_RATE = 22050  # deliberately not 24 kHz so resampling is exercised

os.environ.update(
    {
        "VOICE_PROVIDER": "devnagri_cascaded",
        "BLACKBIRD_API_KEY": "bb_test_fake",
        "BLACKBIRD_WS_URL": f"ws://{FAKE}/v1/stream",
        "DEVNAGRI_TTS_API_KEY": "dvn_tts_test_fake",
        "DEVNAGRI_TTS_URL": f"http://{FAKE}/v1/audio/speech",
        "DEVNAGRI_TTS_SAMPLE_RATE": str(TTS_RATE),
        "OLLAMA_BASE_URL": f"http://{FAKE}/v1",
        "OLLAMA_API_KEY": "fake",
        "LLM_MODEL": "fake-gpt-oss",
        "WS_BEARER_TOKEN": TOKEN,
        "LLM_TELEMETRY_ENABLED": "false",
        "DEVNAGRI_TURN_COMMIT_MS": "300",
        "DEVNAGRI_HISTORY_TURNS": "4",  # small window so meeting notes kick in during the run
    }
)

import httpx  # noqa: E402
import uvicorn  # noqa: E402
import websockets  # noqa: E402
from starlette.applications import Starlette  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.responses import JSONResponse, StreamingResponse  # noqa: E402
from starlette.routing import Route, WebSocketRoute  # noqa: E402
from starlette.websockets import WebSocket  # noqa: E402

# ── Fake services ────────────────────────────────────────────────────────────

LOG: dict[str, list] = {"tts": [], "llm": [], "asr": [], "notes": []}
NOTES_TEXT = "Their claims and numbers: price before ROI. Objections raised: existing vendor (open)."
USER_UTTERANCES = ["मुझे price बताइए", "wait wait listen to me"]
LLM_REPLIES = [
    "<emo:skeptical>नमस्ते, मैं बहुत busy हूँ। <emo:neutral>आप जल्दी बताइए आपका product क्या करता है?",
    "<emo:skeptical>Price से पहले, मुझे ROI बताइए। हमारे पास पहले से एक vendor है।",
    " ".join(f"<emo:frustrated>यह लंबा जवाब नंबर {i} है जो बीच में रोका जाएगा।" for i in range(1, 9)),
    "<emo:encouraging>ठीक है, बोलिए।",
]


async def fake_asr(ws: WebSocket) -> None:
    await ws.accept()
    config = json.loads(await ws.receive_text())
    LOG["asr"].append({"config": config})
    if config.get("api_key") != "bb_test_fake":
        await ws.send_json({"type": "error", "code": "invalid_api_key", "message": "bad key"})
        await ws.close()
        return
    await ws.send_json({"type": "ready", "session_id": "fake", "model": "blackbird-indic-v1"})
    speech_ms = silence_ms = 0
    partial_sent = False
    utterance = 0
    while True:
        msg = await ws.receive()
        if msg["type"] == "websocket.disconnect":
            return
        if msg.get("text"):
            if json.loads(msg["text"]).get("type") == "finalize":
                LOG["asr"].append({"finalize": True})
                with contextlib.suppress(Exception):  # the API may already have closed its side
                    await ws.send_json({"type": "done", "text": ""})
                    await ws.close()
                return
            continue
        frame = msg.get("bytes") or b""
        samples = struct.unpack(f"<{len(frame) // 2}h", frame[: len(frame) // 2 * 2])
        loud = bool(samples) and max(abs(s) for s in samples) > 1000
        ms = len(samples) * 1000 // config["sample_rate"]
        text = USER_UTTERANCES[min(utterance, len(USER_UTTERANCES) - 1)]
        if loud:
            speech_ms += ms
            silence_ms = 0
            if speech_ms >= 300 and not partial_sent:
                partial_sent = True
                await ws.send_json({"type": "partial", "text": text, "start_ms": 0, "end_ms": speech_ms})
        elif speech_ms:
            silence_ms += ms
            if silence_ms >= 250:
                await ws.send_json({"type": "final", "segment_id": utterance, "text": text, "language": config["language"]})
                utterance += 1
                speech_ms = silence_ms = 0
                partial_sent = False


async def fake_tts(request: Request):
    body = await request.json()
    LOG["tts"].append({"auth": request.headers.get("authorization"), **body})
    if request.headers.get("authorization") != "Bearer dvn_tts_test_fake":
        return JSONResponse({"detail": "Invalid API key."}, status_code=401)
    seconds = min(0.04 * len(body["input"]), 3.0)
    n = int(TTS_RATE * seconds)
    pcm = b"".join(struct.pack("<h", int(3000 * math.sin(2 * math.pi * 220 * i / TTS_RATE))) for i in range(n))

    async def gen():
        for i in range(0, len(pcm), 2047):  # odd chunk size exercises the byte carry
            await asyncio.sleep(0.005)
            yield pcm[i : i + 2047]

    return StreamingResponse(gen(), media_type="application/octet-stream")


async def fake_llm(request: Request):
    body = await request.json()
    if not body.get("stream"):  # meeting-notes request
        LOG["notes"].append(body)
        return JSONResponse({"id": "n", "object": "chat.completion", "created": 0, "model": body["model"],
                             "choices": [{"index": 0, "finish_reason": "stop",
                                          "message": {"role": "assistant", "content": NOTES_TEXT}}],
                             "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70}})
    LOG["llm"].append(body)
    reply = LLM_REPLIES[min(len(LOG["llm"]) - 1, len(LLM_REPLIES) - 1)]

    async def gen():
        for i in range(0, len(reply), 6):
            chunk = {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": body["model"],
                     "choices": [{"index": 0, "delta": {"content": reply[i : i + 6]}, "finish_reason": None}]}
            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
            await asyncio.sleep(0.01)
        if body.get("stream_options", {}).get("include_usage"):
            usage = {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": body["model"], "choices": [],
                     "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}}
            yield f"data: {json.dumps(usage)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


fake_app = Starlette(
    routes=[
        WebSocketRoute("/v1/stream", fake_asr),
        Route("/v1/audio/speech", fake_tts, methods=["POST"]),
        Route("/v1/chat/completions", fake_llm, methods=["POST"]),
    ]
)

# ── Browser-like client ──────────────────────────────────────────────────────

FAILURES: list[str] = []


def check(cond: bool, label: str) -> None:
    print(("  PASS " if cond else "  FAIL ") + label)
    if not cond:
        FAILURES.append(label)


def pcm_frame(loud: bool, ms: int = 100, rate: int = 16000) -> str:
    n = rate * ms // 1000
    amp = 8000 if loud else 0
    data = b"".join(struct.pack("<h", int(amp * math.sin(2 * math.pi * 300 * i / rate))) for i in range(n))
    return base64.b64encode(data).decode()


class Browser:
    def __init__(self, ws) -> None:
        self.ws = ws
        self.events: list[tuple[float, dict]] = []
        self._reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        async for raw in self.ws:
            self.events.append((time.monotonic(), json.loads(raw)))

    async def wait_for(self, pred, timeout: float = 10.0, start: int = 0) -> dict | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for _, ev in self.events[start:]:
                if pred(ev):
                    return ev
            await asyncio.sleep(0.02)
        return None

    async def speak(self, speech_ms: int, silence_ms: int = 0) -> None:
        for _ in range(speech_ms // 100):
            await self.ws.send(json.dumps({"type": "audio", "audio": pcm_frame(True)}))
            await asyncio.sleep(0.1)
        for _ in range(silence_ms // 100):
            await self.ws.send(json.dumps({"type": "audio", "audio": pcm_frame(False)}))
            await asyncio.sleep(0.1)


def since(browser: Browser, idx: int, typ: str, **match) -> list[dict]:
    return [e for _, e in browser.events[idx:] if e.get("type") == typ and all(e.get(k) == v for k, v in match.items())]


async def run_client() -> None:
    from api.core.auth import User, get_current_user
    from api.main import app

    app.dependency_overrides[get_current_user] = lambda: User(email="e2e@test", full_name="E2E", is_admin=False)

    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{API_PORT}") as http:
        print("1. Create session (Hard, Hindi)")
        resp = await http.post("/realtime/session", json={
            "client_type": "Hard", "industry": "SaaS", "pitch_summary": "CRM tool", "response_language": "hi",
        })
        check(resp.status_code == 200, f"POST /realtime/session -> {resp.status_code}")
        session = resp.json()
        check(session.get("voice_id") == "3", f"Hindi session uses Simran voice_id=3 (got {session.get('voice_id')})")
        stats = (await http.get("/api/connectivity/stats")).json()
        check(stats.get("nova_sdk_available") is True or "sdk" in json.dumps(stats), "connectivity stats served")

    ws_url = f"ws://127.0.0.1:{API_PORT}/ws/nova2-sonic?token={TOKEN}&session_id={session['session_id']}"
    async with websockets.connect(ws_url, max_size=16 * 1024 * 1024) as ws:
        b = Browser(ws)
        print("2. Start -> session opened")
        await ws.send(json.dumps({"type": "start", "session_id": session["session_id"]}))
        opened = await b.wait_for(lambda e: e.get("type") == "info" and "session opened" in str(e.get("message", "")).lower())
        check(opened is not None and opened.get("source") == "devnagri", "info 'Devnagri cascaded session opened'")
        asr_cfg = LOG["asr"][0]["config"] if LOG["asr"] else {}
        check(asr_cfg.get("language") == "hi" and asr_cfg.get("mode") == "mixed", f"Blackbird config language=hi mode=mixed ({asr_cfg})")
        check(asr_cfg.get("sample_rate") == 16000 and asr_cfg.get("encoding") == "pcm_s16le", "Blackbird gets 16 kHz pcm_s16le")

        print("3. Opener (text turn)")
        idx = len(b.events)
        t0 = time.monotonic()
        await ws.send(json.dumps({"type": "text", "text": "frontend opener text", "opener": True}))
        final = await b.wait_for(lambda e: e.get("type") == "transcript" and e.get("role") == "assistant" and e.get("final"), start=idx)
        end = await b.wait_for(lambda e: e.get("type") == "audio_end", start=idx)
        check(final is not None and end is not None, "assistant final transcript + audio_end")
        starts = since(b, idx, "audio_start")
        check(len(starts) == 1 and starts[0]["sample_rate"] == 24000 and starts[0]["format"] == "pcm_s16le", "one audio_start @24 kHz pcm_s16le")
        check("first_audio_latency_ms" in (starts[0] if starts else {}), "first_audio_latency_ms reported")
        audio = since(b, idx, "audio")
        audio_sec = sum(len(base64.b64decode(e["audio"])) for e in audio) / 2 / 24000
        expected = sum(min(0.04 * len(t["input"]), 3.0) for t in LOG["tts"])
        check(abs(audio_sec - expected) < 0.05, f"resampled 22.05k->24k duration {audio_sec:.2f}s ≈ {expected:.2f}s")
        check(all(len(base64.b64decode(e["audio"])) % 2 == 0 for e in audio), "every audio frame is whole samples")
        span = [t for t, e in b.events[idx:] if e.get("type") == "audio"]
        check(span[-1] - span[0] > audio_sec - 0.8, f"audio paced to real time (sent over {span[-1] - span[0]:.2f}s for {audio_sec:.2f}s)")
        texts = [e["text"] for e in since(b, idx, "transcript")]
        check(not any("<emo" in t or "emo:" in t for t in texts), "emotion tags never reach transcripts")
        check(final and final["text"].startswith("नमस्ते"), f"final transcript text: {final and final['text'][:40]}")
        check([t.get("voice_id") for t in LOG["tts"]] == [3, 3], f"TTS called per sentence with voice_id=3 ({[t.get('voice_id') for t in LOG['tts']]})")
        check(all(t["stream"] is True and t["response_format"] == "pcm" for t in LOG["tts"]), "TTS requests stream raw PCM")
        system = LOG["llm"][0]["messages"][0]["content"]
        check("<emo:skeptical>" in system and "baseline is <emo:skeptical>" in system, "system prompt has emotion instruction, Hard -> skeptical")
        check("Hinglish" in system, "system prompt has Hinglish language rule")
        cue = LOG["llm"][0]["messages"][1]["content"]
        check(cue.startswith("[STAGE]") and "skeptical" in cue, f"opener replaced by backend stage cue: {cue[:70]}")
        check(LOG["llm"][0].get("stream") is True and LOG["llm"][0].get("stream_options") == {"include_usage": True}, "LLM streamed with usage")
        print(f"   opener total {time.monotonic() - t0:.2f}s")

        print("4. Spoken user turn")
        idx = len(b.events)
        await b.speak(800, 500)
        user = await b.wait_for(lambda e: e.get("type") == "transcript" and e.get("role") == "user" and e.get("final"), start=idx)
        check(user is not None and user["text"] == USER_UTTERANCES[0], f"user transcript from ASR final: {user and user['text']}")
        await ws.send(json.dumps({"type": "end"}))  # frontend VAD fires after its own silence window
        reply = await b.wait_for(lambda e: e.get("type") == "audio_end", start=idx)
        check(reply is not None, "assistant replied with audio")
        check(len(since(b, idx, "transcript", role="user", final=True)) == 1, "late 'end' did not create a duplicate turn")
        msgs = LOG["llm"][1]["messages"]
        check(msgs[-1] == {"role": "user", "content": USER_UTTERANCES[0]}, "LLM got the user's words as the last message")
        check(msgs[-2]["role"] == "assistant" and "<emo" not in msgs[-2]["content"], "history holds spoken assistant text, tags stripped")

        print("5. Barge-in")
        await ws.send(json.dumps({"type": "text", "text": "Explain at length."}))
        idx = len(b.events)
        first = await b.wait_for(lambda e: e.get("type") == "audio", start=idx)
        check(first is not None, "long reply started playing")
        await asyncio.sleep(1.0)
        t_interrupt = time.monotonic()
        await b.speak(500)
        cut = await b.wait_for(lambda e: e.get("type") == "audio_end", start=idx)
        t_cut = next((t for t, e in b.events[idx:] if e.get("type") == "audio_end"), None)
        check(cut is not None, "audio_end sent on barge-in")
        check(any(e.get("type") == "audio_interrupted" for _, e in b.events[idx:]), "audio_interrupted sent so the browser drops queued audio")
        if t_cut:
            print(f"   audio_end {t_cut - t_interrupt:.2f}s after user started talking")
        cut_final = next((e for _, e in b.events[idx:] if e.get("type") == "transcript" and e.get("role") == "assistant" and e.get("final")), None)
        check(cut_final is not None and "नंबर 8" not in cut_final["text"], f"assistant transcript truncated to spoken part: {cut_final and cut_final['text'][:60]}…")
        end_idx = next(i for i, (_, e) in enumerate(b.events) if i >= idx and e.get("type") == "audio_end")
        after = [e for _, e in b.events[end_idx + 1 :] if e.get("type") == "audio"]
        await b.speak(0, 400)
        nxt = await b.wait_for(lambda e: e.get("type") == "transcript" and e.get("role") == "user" and e.get("text") == USER_UTTERANCES[1], start=idx)
        check(nxt is not None, "interrupting words become the next user turn")
        resumed = await b.wait_for(lambda e: e.get("type") == "audio_end", start=end_idx + 1)
        check(resumed is not None, "coach answers after the interruption")
        audio_between = [e for _, e in b.events[end_idx + 1:] if e.get("type") == "audio"]
        check(len(after) == 0 or len(audio_between) > 0, "no stale audio from the cancelled reply")
        hist = LOG["llm"][-1]["messages"]
        check(any(m["role"] == "assistant" and m["content"].endswith("—") for m in hist), "LLM history marks the reply as cut off")

        print("6. Memory window + meeting notes")
        await asyncio.sleep(0.3)
        check(len(LOG["notes"]) >= 1, f"meeting notes requested once history outgrew the window ({len(LOG['notes'])})")
        last = LOG["llm"][-1]["messages"]
        check(len(last) - 1 <= 4, f"only the last 4 messages sent verbatim ({len(last) - 1})")
        check("MEETING NOTES SO FAR" in last[0]["content"] and NOTES_TEXT in last[0]["content"], "notes injected into the system prompt")

        print("7. Close")
        await ws.send(json.dumps({"type": "close"}))
        await asyncio.sleep(0.5)
        errors = [e for _, e in b.events if e.get("type") == "error"]
        check(not errors, f"no error events ({errors[:2]})")
    await asyncio.sleep(0.5)
    check(any(x.get("finalize") for x in LOG["asr"]), "Blackbird stream finalized on close")


async def main() -> int:
    fake = uvicorn.Server(uvicorn.Config(fake_app, host="127.0.0.1", port=FAKE_PORT, log_level="warning", ws="websockets"))
    from api.main import app

    # lifespan off: skip DB init/OTel so the run has no side effects on the project database.
    api = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=API_PORT, log_level="warning", lifespan="off", ws="websockets"))
    tasks = [asyncio.create_task(fake.serve()), asyncio.create_task(api.serve())]
    while not (fake.started and api.started):
        await asyncio.sleep(0.05)
    try:
        await asyncio.wait_for(run_client(), timeout=90)
    except Exception as exc:
        FAILURES.append(f"client crashed: {type(exc).__name__}: {exc}")
        import traceback

        traceback.print_exc()
    finally:
        fake.should_exit = api.should_exit = True
        await asyncio.gather(*tasks, return_exceptions=True)
    print(f"\n{'ALL CHECKS PASSED' if not FAILURES else f'{len(FAILURES)} FAILED'}")
    for f in FAILURES:
        print("  -", f)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
