import asyncio
import json
import logging
import os
from pathlib import Path
from urllib.parse import quote

import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("realtime-proxy")

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
app = FastAPI()
app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


def azure_ws_url() -> str:
    endpoint = os.environ["AZURE_OPENAI_ENDPOINT"].strip().rstrip("/")
    endpoint = endpoint.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
    deployment = quote(os.environ["AZURE_OPENAI_REALTIME_DEPLOYMENT"].strip(), safe="")
    return f"{endpoint}/openai/v1/realtime?model={deployment}"


def session_update() -> dict:
    return {
        "type": "session.update",
        "session": {
            "type": "realtime",
            "instructions": os.getenv("REALTIME_INSTRUCTIONS", "You are a concise, helpful voice assistant."),
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": 24000},
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
                    "format": {"type": "audio/pcm", "rate": 24000},
                    "voice": os.getenv("REALTIME_VOICE", "marin"),
                },
            },
        },
    }


@app.get("/")
async def index():
    return FileResponse(FRONTEND / "index.html")


@app.websocket("/ws")
async def realtime_proxy(client: WebSocket):
    await client.accept()
    missing = [k for k in ("AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_REALTIME_DEPLOYMENT") if not os.getenv(k)]
    if missing:
        await client.send_json({"type": "proxy.error", "error": f"Missing variables: {', '.join(missing)}"})
        await client.close(code=1011)
        return

    url = azure_ws_url()
    headers = {"api-key": os.environ["AZURE_OPENAI_API_KEY"].strip()}
    log.info("Connecting to Azure Realtime: %s", url)

    try:
        async with websockets.connect(url, additional_headers=headers, max_size=16 * 1024 * 1024) as azure:
            await azure.send(json.dumps(session_update()))
            await client.send_json({"type": "proxy.connected"})

            async def browser_to_azure():
                while True:
                    message = await client.receive_text()
                    await azure.send(message)

            async def azure_to_browser():
                async for message in azure:
                    await client.send_text(message)

            tasks = [asyncio.create_task(browser_to_azure()), asyncio.create_task(azure_to_browser())]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                exc = task.exception()
                if exc and not isinstance(exc, WebSocketDisconnect):
                    raise exc
    except WebSocketDisconnect:
        log.info("Browser disconnected")
    except Exception as exc:
        log.exception("Realtime proxy failed")
        try:
            await client.send_json({"type": "proxy.error", "error": str(exc)})
            await client.close(code=1011)
        except Exception:
            pass
