"""
Offline check of the Azure gpt-realtime bridge against a fake Azure realtime server (no keys).

    python scripts/azure_realtime_e2e_fake.py ga     # GA event names + user transcription configured
    python scripts/azure_realtime_e2e_fake.py beta   # beta event names, transcription not configured

Exit code 0 = all checks passed.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import socket
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

MODE = sys.argv[1] if len(sys.argv) > 1 else "ga"
assert MODE in ("ga", "beta")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


FAKE_PORT, API_PORT = _free_port(), _free_port()
TOKEN = "e2e-token"
os.environ.update(
    {
        "VOICE_PROVIDER": "azure_realtime",
        "AZURE_OPENAI_REALTIME_ENDPOINT": f"http://127.0.0.1:{FAKE_PORT}",
        "AZURE_OPENAI_REALTIME_API_KEY": "fake-azure-key",
        "AZURE_OPENAI_REALTIME_DEPLOYMENT": "gpt-realtime",
        "AZURE_OPENAI_REALTIME_TRANSCRIBE_DEPLOYMENT": "my-transcribe" if MODE == "ga" else "",
        "WS_BEARER_TOKEN": TOKEN,
        "LLM_TELEMETRY_ENABLED": "false",
    }
)

import httpx  # noqa: E402
import uvicorn  # noqa: E402
import websockets  # noqa: E402
from starlette.applications import Starlette  # noqa: E402
from starlette.routing import WebSocketRoute  # noqa: E402
from starlette.websockets import WebSocket  # noqa: E402

AUDIO_DELTA = "response.output_audio.delta" if MODE == "ga" else "response.audio.delta"
TRANSCRIPT_DELTA = "response.output_audio_transcript.delta" if MODE == "ga" else "response.audio_transcript.delta"
TRANSCRIPT_DONE = "response.output_audio_transcript.done" if MODE == "ga" else "response.audio_transcript.done"
LOG: dict[str, list] = {"updates": [], "headers": []}
FAILURES: list[str] = []


def check(cond: bool, label: str) -> None:
    print(("  PASS " if cond else "  FAIL ") + label)
    if not cond:
        FAILURES.append(label)


async def fake_azure(ws: WebSocket) -> None:
    LOG["headers"].append(dict(ws.headers))
    await ws.accept()
    appended = 0
    transcribing = False

    async def respond(text: str) -> None:
        item = f"item_{time.monotonic_ns()}"
        for i in range(5):
            await ws.send_json({"type": AUDIO_DELTA, "item_id": item, "delta": base64.b64encode(b"\x10\x00" * 2400).decode()})
        for word in text.split():
            await ws.send_json({"type": TRANSCRIPT_DELTA, "item_id": item, "delta": word + " "})
        await ws.send_json({"type": TRANSCRIPT_DONE, "item_id": item, "transcript": text})
        await ws.send_json({"type": "response.done", "response": {"usage": {"total_tokens": 10, "input_tokens": 6, "output_tokens": 4}}})

    with contextlib.suppress(Exception):
        while True:
            msg = json.loads(await ws.receive_text())
            typ = msg.get("type")
            if typ == "session.update":
                LOG["updates"].append(msg["session"])
                transcribing = bool(msg["session"].get("audio", {}).get("input", {}).get("transcription"))
            elif typ == "response.create":
                await respond("Hello, who is this?")
            elif typ == "input_audio_buffer.append":
                appended += 1
                if appended == 1:
                    await ws.send_json({"type": "input_audio_buffer.speech_started"})
                if appended == 5:
                    await ws.send_json({"type": "input_audio_buffer.speech_stopped"})
                    await ws.send_json({"type": "input_audio_buffer.committed", "item_id": "user_1"})
                    if transcribing:
                        await ws.send_json({"type": "conversation.item.input_audio_transcription.completed",
                                            "item_id": "user_1", "transcript": "I want to discuss pricing"})
                    await respond("Sure, what is your budget?")


async def run_client() -> None:
    from api.core.auth import User, get_current_user
    from api.main import app

    app.dependency_overrides[get_current_user] = lambda: User(email="e2e@test", full_name="E2E", is_admin=False)
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{API_PORT}") as http:
        resp = await http.post("/realtime/session", json={"client_type": "Easy", "response_language": "en"})
        check(resp.status_code == 200, f"POST /realtime/session -> {resp.status_code}")
        session = resp.json()

    url = f"ws://127.0.0.1:{API_PORT}/ws/nova2-sonic?token={TOKEN}&session_id={session['session_id']}"
    async with websockets.connect(url, max_size=16 * 1024 * 1024) as ws:
        events: list[dict] = []

        async def read():
            async for raw in ws:
                events.append(json.loads(raw))

        reader = asyncio.create_task(read())

        async def wait(pred, timeout=5.0):
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                if any(pred(e) for e in events):
                    return True
                await asyncio.sleep(0.02)
            return False

        await ws.send(json.dumps({"type": "start", "session_id": session["session_id"]}))
        check(await wait(lambda e: e.get("type") == "info" and "session opened" in str(e.get("message", "")).lower()),
              "Azure session opened")
        check(LOG["headers"] and LOG["headers"][0].get("api-key") == "fake-azure-key", "api-key header sent")

        print(f"Opener ({MODE} event names)")
        await ws.send(json.dumps({"type": "text", "text": "Start the conversation."}))
        check(await wait(lambda e: e.get("type") == "audio_end"), "audio_end after response.done")
        check(sum(e.get("type") == "audio" for e in events) == 5, "all 5 audio deltas forwarded to the browser")
        check(any(e.get("type") == "audio_start" for e in events), "audio_start sent")
        check(any(e.get("type") == "transcript" and e.get("role") == "assistant" and not e["final"] for e in events),
              "assistant transcript deltas forwarded")
        check(any(e.get("type") == "transcript" and e.get("role") == "assistant" and e["final"]
                  and e["text"] == "Hello, who is this?" for e in events), "assistant final transcript forwarded")

        print("User speech turn")
        before = len(events)
        for _ in range(5):
            await ws.send(json.dumps({"type": "audio", "audio": base64.b64encode(b"\x00\x10" * 1600).decode()}))
        await wait(lambda e: e.get("type") == "transcript" and e.get("text") == "Sure, what is your budget?")
        user = [e for e in events[before:] if e.get("type") == "transcript" and e.get("role") == "user"]
        if MODE == "ga":
            check(len(user) == 1 and user[0]["text"] == "I want to discuss pricing" and user[0]["final"],
                  "user transcript delivered when transcription is configured")
        else:
            check(not user, "no user transcript when transcription is not configured (unchanged behaviour)")
        check(await wait(lambda e: e.get("type") == "audio_interrupted" and e.get("source") == "azure"),
              "speech_started forwarded as audio_interrupted")
        check(not any(e.get("type") == "error" for e in events), "no error events")
        reader.cancel()

    base = LOG["updates"][0] if LOG["updates"] else {}
    check(base.get("audio", {}).get("output", {}).get("voice") and base.get("instructions"),
          "first session.update carries voice + instructions")
    check("transcription" not in base.get("audio", {}).get("input", {}), "first session.update unchanged (no transcription)")
    if MODE == "ga":
        check(len(LOG["updates"]) == 2, "second session.update sent for transcription")
        tx = LOG["updates"][-1]["audio"]["input"].get("transcription") if len(LOG["updates"]) == 2 else None
        check(tx == {"model": "my-transcribe", "language": "en"}, f"transcription = deployment + language hint ({tx})")
        check(LOG["updates"][-1]["audio"]["input"].get("turn_detection") == base["audio"]["input"]["turn_detection"],
              "second update keeps the same VAD settings")
    else:
        check(len(LOG["updates"]) == 1, "only one session.update when transcription is not configured")


async def main() -> int:
    fake = uvicorn.Server(uvicorn.Config(Starlette(routes=[WebSocketRoute("/openai/v1/realtime", fake_azure)]),
                                         host="127.0.0.1", port=FAKE_PORT, log_level="warning", ws="websockets"))
    from api.main import app

    api = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=API_PORT, log_level="warning", lifespan="off", ws="websockets"))
    tasks = [asyncio.create_task(fake.serve()), asyncio.create_task(api.serve())]
    while not (fake.started and api.started):
        await asyncio.sleep(0.05)
    try:
        await asyncio.wait_for(run_client(), timeout=60)
    except Exception as exc:
        FAILURES.append(f"client crashed: {type(exc).__name__}: {exc}")
    finally:
        fake.should_exit = api.should_exit = True
        await asyncio.gather(*tasks, return_exceptions=True)
    print(f"\n{'ALL CHECKS PASSED' if not FAILURES else f'{len(FAILURES)} FAILED'} ({MODE})")
    for f in FAILURES:
        print("  -", f)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
