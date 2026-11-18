"""
Probe the Devnagri TTS deployment: discover the raw PCM sample rate, measure time-to-first-byte,
and optionally render emotion-profile samples for a listening test.

Usage:
    DEVNAGRI_TTS_API_KEY=dvn_tts_... python scripts/probe_devnagri_tts.py [--voice-id 2] [--profiles]

Writes probe_*.wav files to the current directory.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import time
import wave
from pathlib import Path

# Load .env.devnagri from the project root (two levels up from this script)
try:
    from dotenv import load_dotenv
    _env_file = Path(__file__).resolve().parents[1] / ".env.devnagri"
    load_dotenv(_env_file)
except ImportError:
    pass  # dotenv not installed — fall back to shell env vars

import httpx

try:
    from dotenv import load_dotenv
except ImportError:
    pass
else:
    # Same .env the API loads; variables already exported in the shell win.
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"), override=False)

URL = os.getenv("DEVNAGRI_TTS_URL", "https://tts.devnagri.com/v1/audio/speech")
TEXT = "Honestly, I am not convinced yet. What makes your product different from what we already use?"


def _headers() -> dict[str, str]:
    key = os.environ.get("DEVNAGRI_TTS_API_KEY", "").strip().strip("'\"")
    if not key:
        raise SystemExit("Set DEVNAGRI_TTS_API_KEY")
    return {"Authorization": f"Bearer {key}"}


def _check(resp: httpx.Response) -> None:
    if resp.status_code != 200:
        resp.read()
        key = os.environ.get("DEVNAGRI_TTS_API_KEY", "").strip().strip("'\"")
        raise SystemExit(
            f"HTTP {resp.status_code} from {URL}: {resp.text[:300]}\n"
            f"Key sent: prefix={key[:14]!r} length={len(key)} (expected prefix dvn_tts_test_/dvn_tts_staging_/dvn_tts_production_)"
        )


def probe_wav(client: httpx.Client, voice_id: int) -> int:
    resp = client.post(URL, headers=_headers(), json={
        "model": "dvn-tts-v1", "input": TEXT, "response_format": "wav", "voice_id": voice_id,
    })
    _check(resp)
    with wave.open(io.BytesIO(resp.content)) as w:
        rate, width, channels = w.getframerate(), w.getsampwidth(), w.getnchannels()
    print(f"WAV: sample_rate={rate} sample_width={width * 8}bit channels={channels}")
    with open("probe_wav.wav", "wb") as f:
        f.write(resp.content)
    return rate


def probe_stream(client: httpx.Client, voice_id: int, rate: int, extra: dict | None = None, name: str = "stream") -> None:
    payload = {"model": "dvn-tts-v1", "input": TEXT, "stream": True, "response_format": "pcm", "voice_id": voice_id}
    payload.update(extra or {})
    if "references" in payload:
        payload.pop("voice_id")
    start = time.monotonic()
    first = None
    pcm = b""
    with client.stream("POST", URL, headers=_headers(), json=payload) as resp:
        print(f"[{name}] status={resp.status_code} content-type={resp.headers.get('content-type')}")
        _check(resp)
        for chunk in resp.iter_bytes():
            if chunk and first is None:
                first = time.monotonic() - start
            pcm += chunk
    total = time.monotonic() - start
    audio_sec = len(pcm) / 2 / rate
    print(f"[{name}] ttfb={first * 1000:.0f}ms total={total * 1000:.0f}ms audio={audio_sec:.2f}s rtf={total / max(audio_sec, 0.01):.2f}")
    with wave.open(f"probe_{name}.wav", "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm[: len(pcm) - len(pcm) % 2])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice-id", type=int, default=2)
    parser.add_argument("--profiles", action="store_true", help="render each DEVNAGRI_TTS_EMOTION_PROFILES entry")
    args = parser.parse_args()

    with httpx.Client(timeout=60) as client:
        rate = probe_wav(client, args.voice_id)
        probe_stream(client, args.voice_id, rate)
        print("If probe_stream.wav sounds right (not chipmunk/slow), set DEVNAGRI_TTS_SAMPLE_RATE=%d" % rate)
        if args.profiles:
            profiles = json.loads(os.getenv("DEVNAGRI_TTS_EMOTION_PROFILES", "{}"))
            for emotion, profile in profiles.items():
                extra: dict = {}
                if profile.get("ref_audio_url"):
                    extra["references"] = [{"audio_path": profile["ref_audio_url"], "text": profile.get("ref_text", "")}]
                if "temperature" in profile:
                    extra["temperature"] = profile["temperature"]
                probe_stream(client, args.voice_id, rate, extra, name=f"emotion_{emotion}")


if __name__ == "__main__":
    main()
