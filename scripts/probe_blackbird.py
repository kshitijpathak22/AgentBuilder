"""
Probe the Blackbird ASR stream: confirm the key is accepted, then stream a speech WAV in real time
and print the partial and final transcripts.

Usage:
    python scripts/probe_blackbird.py [--wav probe_wav.wav] [--language en] [--mode mixed]

probe_wav.wav comes from scripts/probe_devnagri_tts.py. Without a usable WAV the script only checks the key.
"""
from __future__ import annotations

import argparse
import array
import asyncio
import json
import os
import sys
import time
import wave
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent

try:
    from dotenv import load_dotenv
except ImportError:
    pass
else:
    load_dotenv(ROOT / ".env", override=False)

SAMPLE_RATE = 16000  # what the browser sends and the pipeline declares
FRAME_MS = 100
TRAILING_SILENCE_S = 1.5
FINAL_WAIT_S = 6


def load_pcm16k(path: Path) -> bytes:
    with wave.open(str(path)) as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise SystemExit(f"{path} must be 16-bit mono")
        rate = wav.getframerate()
        samples = array.array("h", wav.readframes(wav.getnframes()))
    if sys.byteorder == "big":
        samples.byteswap()
    if rate == SAMPLE_RATE:
        return samples.tobytes()
    out = array.array("h")
    for i in range(int(len(samples) * SAMPLE_RATE / rate)):
        pos = i * rate / SAMPLE_RATE
        left = int(pos)
        right = min(left + 1, len(samples) - 1)
        out.append(int(samples[left] + (samples[right] - samples[left]) * (pos - left)))
    return out.tobytes()


async def stream_audio(ws, pcm: bytes) -> None:
    frame = SAMPLE_RATE * 2 * FRAME_MS // 1000
    pcm += b"\0" * int(SAMPLE_RATE * 2 * TRAILING_SILENCE_S)
    for start in range(0, len(pcm), frame):
        await ws.send(pcm[start:start + frame])
        await asyncio.sleep(FRAME_MS / 1000)


async def read_events(ws, started: float, finals: list[str]) -> None:
    async for raw in ws:
        if isinstance(raw, bytes):
            continue
        event = json.loads(raw)
        print(f"[{time.perf_counter() - started:5.2f}s] {json.dumps(event, ensure_ascii=False)[:200]}")
        if event.get("type") == "final":
            finals.append(event.get("text") or event.get("transcript") or "")
        elif event.get("type") == "error":
            break


async def run(args: argparse.Namespace) -> int:
    key = os.getenv("BLACKBIRD_API_KEY", "").strip()
    url = os.getenv("BLACKBIRD_WS_URL", "wss://blackbird.devnagri.com/v1/stream")
    if not key:
        raise SystemExit("Set BLACKBIRD_API_KEY (in .env or the shell)")
    print(f"Connecting to {url} with key {key[:8]}... (length {len(key)})")

    async with websockets.connect(url, max_size=4 * 1024 * 1024, ping_interval=20) as ws:
        await ws.send(json.dumps({
            "api_key": key, "language": args.language, "mode": args.mode,
            "sample_rate": SAMPLE_RATE, "encoding": "pcm_s16le", "interim_results": True,
        }))
        first = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        if first.get("type") != "ready":
            print(f"REJECTED: {first}")
            return 1
        print(f"KEY ACCEPTED: {first}")

        wav = Path(args.wav)
        if not wav.exists():
            print(f"{wav} not found, so no audio was sent. Run scripts/probe_devnagri_tts.py to create it.")
            return 0

        started = time.perf_counter()
        finals: list[str] = []
        reader = asyncio.create_task(read_events(ws, started, finals))
        await stream_audio(ws, load_pcm16k(wav))
        # The server may keep the stream open after the audio, so stop reading after a fixed wait.
        await asyncio.wait({reader}, timeout=FINAL_WAIT_S)
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)
        print(f"\nTranscript: {' '.join(finals) or '(no final received)'}")
        return 0 if finals else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wav", default=str(ROOT / "probe_wav.wav"))
    parser.add_argument("--language", default="en")
    parser.add_argument("--mode", default=os.getenv("DEVNAGRI_ASR_MODE", "mixed"))
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
