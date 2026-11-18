"""
Centralized Configuration for Sales Coach API
Single source of truth for all settings, loaded from environment variables.
"""
import os
from pathlib import Path
from typing import List, Optional

# ── Project paths ────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
API_DIR = Path(__file__).resolve().parent.parent
LOG_DIR = Path(os.getenv("LOG_DIR", "").strip() or PROJECT_ROOT / "logs")

# Files the app writes at runtime default to the code folder (fine locally). On a host that replaces the
# code folder on every deploy (Azure App Service), point these at persistent storage such as /home/data.

# ── Database ─────────────────────────────────────────────────────
# DATABASE_URL (postgresql://user:password@host:5432/dbname?sslmode=require) selects PostgreSQL;
# without it the app uses the SQLite file at DATABASE_PATH.
DATABASE_URL: str = os.getenv("DATABASE_URL", "").strip()
DATABASE_PATH = os.getenv("DATABASE_PATH", "").strip() or str(API_DIR / "practice_sessions.db")

# ── Allowed Users ─────────────────────────────────────────────────
# The copy bundled with the code seeds ALLOWED_USERS_PATH the first time it is missing.
BUNDLED_ALLOWED_USERS_PATH = str(API_DIR / "allowed_users.json")
ALLOWED_USERS_PATH = os.getenv("ALLOWED_USERS_PATH", "").strip() or BUNDLED_ALLOWED_USERS_PATH
# Profile pictures uploaded from the admin panel (file names are random; the user record keeps the name).
USER_PHOTOS_DIR = os.getenv("USER_PHOTOS_DIR", "").strip() or str(API_DIR / "user_photos")

# ── JWT / Authentication ─────────────────────────────────────────
SECRET_KEY: str = os.getenv("JWT_SECRET_KEY", "your-super-secret-key-change-me-in-production")
ALGORITHM: str = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "30"))
REFRESH_TOKEN_EXPIRE_DAYS: int = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "7"))

# ── Authentication / Allowed Users ────────────────────────────────
# Access is controlled by the allowed_users.json file stored in the api folder.
# The first email in the list is considered the admin.

# ── CORS ─────────────────────────────────────────────────────────
# WARNING: Never use "*" with allow_credentials=True in production.
# Explicitly list allowed origins here.
CORS_ALLOWED_ORIGINS: List[str] = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001",
    ).split(",")
    if origin.strip()
]

# ── Server ───────────────────────────────────────────────────────
SERVER_HOST: str = os.getenv("SERVER_HOST", "0.0.0.0")
SERVER_PORT: int = int(os.getenv("SERVER_PORT", "2089"))
SERVER_RELOAD: bool = os.getenv("SERVER_RELOAD", "false").lower() == "true"

# ── Rate Limiting ────────────────────────────────────────────────
RATE_LIMIT_ENABLED: bool = os.getenv("RATE_LIMIT_ENABLED", "true").lower() == "true"
RATE_LIMIT_REQUESTS: int = int(os.getenv("RATE_LIMIT_REQUESTS", "100"))
RATE_LIMIT_WINDOW_SECONDS: int = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "60"))
AUTH_RATE_LIMIT_REQUESTS: int = int(os.getenv("AUTH_RATE_LIMIT_REQUESTS", "5"))
AUTH_RATE_LIMIT_WINDOW_SECONDS: int = int(os.getenv("AUTH_RATE_LIMIT_WINDOW_SECONDS", "60"))

# ── File Upload ──────────────────────────────────────────────────
MAX_UPLOAD_SIZE_MB: int = int(os.getenv("MAX_UPLOAD_SIZE_MB", "50"))
MAX_UPLOAD_SIZE_BYTES: int = MAX_UPLOAD_SIZE_MB * 1024 * 1024
ALLOWED_UPLOAD_EXTENSIONS: List[str] = [".pdf", ".pptx", ".docx"]

# ── OCR for scanned PDFs (Azure AI Document Intelligence, "prebuilt-read") ──
# Used only when a PDF has no text layer. Leave empty to turn OCR off (scanned PDFs are then rejected).
AZURE_DOC_INTELLIGENCE_ENDPOINT: str = os.getenv("AZURE_DOC_INTELLIGENCE_ENDPOINT", "").strip().rstrip("/")
AZURE_DOC_INTELLIGENCE_KEY: str = os.getenv("AZURE_DOC_INTELLIGENCE_KEY", "").strip()
AZURE_DOC_INTELLIGENCE_TIMEOUT_SECONDS: int = int(os.getenv("AZURE_DOC_INTELLIGENCE_TIMEOUT_SECONDS", "120"))

# ── LLM / AI ─────────────────────────────────────────────────────
OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "")
OLLAMA_API_KEY: str = os.getenv("OLLAMA_API_KEY", "")
LLM_MODEL: str = os.getenv("LLM_MODEL", "")
# Gemini via its OpenAI-compatible endpoint: used only when no OLLAMA_* LLM is configured.
GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "").strip()
if GEMINI_API_KEY and not OLLAMA_BASE_URL:
    OLLAMA_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
    OLLAMA_API_KEY = OLLAMA_API_KEY or GEMINI_API_KEY
    LLM_MODEL = LLM_MODEL or "gemini-flash-lite-latest"
LLM_TIMEOUT_SECONDS: int = int(os.getenv("LLM_TIMEOUT_SECONDS", "120"))
LLM_MAX_RETRIES: int = int(os.getenv("LLM_MAX_RETRIES", "2"))
LLM_VERIFY_SSL: bool = os.getenv("LLM_VERIFY_SSL", "true").lower() == "true"

# ── Amazon Nova 2 Sonic speech-to-speech ─────────────────────────
AWS_ACCESS_KEY_ID: str = os.getenv("AWS_ACCESS_KEY_ID", "")
AWS_SECRET_ACCESS_KEY: str = os.getenv("AWS_SECRET_ACCESS_KEY", "")
AWS_SESSION_TOKEN: Optional[str] = (
    os.getenv("AWS_SESSION_TOKEN", "").strip() or None
)
AWS_REGION: str = os.getenv("AWS_REGION", os.getenv("AWS_DEFAULT_REGION", "us-east-1"))
NOVA_MODEL_ID: str = os.getenv("NOVA_MODEL_ID", os.getenv("SONIC_MODEL_ID", "amazon.nova-2-sonic-v1:0"))
NOVA_VOICE_ID: str = os.getenv("NOVA_VOICE_ID", "matthew")
NOVA_VOICE_ID_FEMALE: str = os.getenv("NOVA_VOICE_ID_FEMALE", "tiffany")
NOVA_SYSTEM_PROMPT: str = os.getenv(
    "NOVA_SYSTEM_PROMPT",
    "You are a concise, natural voice assistant. Reply clearly and briefly.",
)
NOVA_INPUT_AUDIO_SAMPLE_RATE: int = int(os.getenv("INPUT_AUDIO_SAMPLE_RATE", "16000"))
NOVA_OUTPUT_AUDIO_SAMPLE_RATE: int = int(os.getenv("OUTPUT_AUDIO_SAMPLE_RATE", "24000"))
NOVA_EMIT_EVENTS: bool = os.getenv("EMIT_NOVA_EVENTS", "false").lower() == "true"
WS_BEARER_TOKEN: str = os.getenv("WS_BEARER_TOKEN", os.getenv("WS_AUTH_TOKEN", ""))

# ── Azure OpenAI GPT-Realtime (alternative realtime provider) ────
# Set REALTIME_PROVIDER=azure to route the /ws realtime bridge through Azure
# gpt-realtime instead of Nova Sonic. Nova code/config above is left intact.
# VOICE_PROVIDER (azure_realtime | aws_realtime | devnagri_cascaded) takes precedence;
# when unset it is derived from the legacy REALTIME_PROVIDER so existing deployments are unchanged.
_LEGACY_VOICE_PROVIDERS = {"azure": "azure_realtime", "nova": "aws_realtime"}
VOICE_PROVIDER: str = (
    os.getenv("VOICE_PROVIDER", "").strip().lower()
    or _LEGACY_VOICE_PROVIDERS.get(os.getenv("REALTIME_PROVIDER", "nova").strip().lower(), "aws_realtime")
)
REALTIME_PROVIDER: str = {"azure_realtime": "azure", "devnagri_cascaded": "devnagri"}.get(VOICE_PROVIDER, "nova")
AZURE_OPENAI_REALTIME_ENDPOINT: str = os.getenv(
    "AZURE_OPENAI_REALTIME_ENDPOINT", os.getenv("AZURE_OPENAI_ENDPOINT", "")
).strip()
AZURE_OPENAI_REALTIME_API_KEY: str = os.getenv(
    "AZURE_OPENAI_REALTIME_API_KEY", os.getenv("AZURE_OPENAI_API_KEY", "")
).strip()
AZURE_OPENAI_REALTIME_DEPLOYMENT: str = os.getenv(
    "AZURE_OPENAI_REALTIME_DEPLOYMENT", os.getenv("AZURE_OPENAI_DEPLOYMENT_NAME", "")
).strip()
AZURE_OPENAI_REALTIME_VOICE: str = os.getenv("AZURE_OPENAI_REALTIME_VOICE", "cedar")  # male; pairs with the male avatar
AZURE_OPENAI_REALTIME_VOICE_FEMALE: str = os.getenv("AZURE_OPENAI_REALTIME_VOICE_FEMALE", "shimmer")
AZURE_REALTIME_MODEL_ID: str = os.getenv("AZURE_REALTIME_MODEL_ID", "gpt-realtime")
# Deployment name of a transcription model (e.g. gpt-4o-mini-transcribe) for user-speech
# transcripts in Azure realtime sessions. Empty leaves transcription off.
AZURE_OPENAI_REALTIME_TRANSCRIBE_DEPLOYMENT: str = os.getenv("AZURE_OPENAI_REALTIME_TRANSCRIBE_DEPLOYMENT", "").strip()
AZURE_REALTIME_SAMPLE_RATE: int = 24000  # fixed; the only PCM rate Azure realtime accepts
AZURE_REALTIME_CONFIGURED: bool = bool(
    AZURE_OPENAI_REALTIME_ENDPOINT and AZURE_OPENAI_REALTIME_API_KEY and AZURE_OPENAI_REALTIME_DEPLOYMENT
)

# Devnagri's speech recognition covers English and Indian languages only (it rejects French, German,
# Spanish and Italian). When Devnagri is the voice provider and Azure realtime is configured, sessions in
# those languages, and Auto (the speaker may use any of them), run on Azure instead.
AZURE_ROUTED_LANGUAGES = ("auto", "fr", "de", "es", "it")
DEVNAGRI_UNSUPPORTED_LANGUAGES = ("fr", "de", "es", "it")


def provider_for_language(response_language: Optional[str]) -> str:
    """Voice provider for one session: the configured one, or Azure for languages Devnagri cannot hear."""
    if (
        REALTIME_PROVIDER == "devnagri"
        and AZURE_REALTIME_CONFIGURED
        and (response_language or "auto") in AZURE_ROUTED_LANGUAGES
    ):
        return "azure"
    return REALTIME_PROVIDER


def unavailable_languages() -> List[str]:
    """Languages no configured provider can hear (offered nowhere in the UI)."""
    return list(DEVNAGRI_UNSUPPORTED_LANGUAGES) if provider_for_language("fr") == "devnagri" else []

# ── Devnagri cascaded voice (Blackbird ASR -> text LLM -> Devnagri TTS) ──
# Used when VOICE_PROVIDER=devnagri_cascaded. The LLM is the OLLAMA_BASE_URL / LLM_MODEL above.
BLACKBIRD_API_KEY: str = os.getenv("BLACKBIRD_API_KEY", "").strip()
BLACKBIRD_WS_URL: str = os.getenv("BLACKBIRD_WS_URL", "wss://blackbird.devnagri.com/v1/stream")
DEVNAGRI_ASR_MODE: str = os.getenv("DEVNAGRI_ASR_MODE", "mixed")
DEVNAGRI_TTS_API_KEY: str = os.getenv("DEVNAGRI_TTS_API_KEY", "").strip()
DEVNAGRI_TTS_URL: str = os.getenv("DEVNAGRI_TTS_URL", "https://tts.devnagri.com/v1/audio/speech")
DEVNAGRI_TTS_SAMPLE_RATE: int = int(os.getenv("DEVNAGRI_TTS_SAMPLE_RATE", "24000"))  # confirm with scripts/probe_devnagri_tts.py
DEVNAGRI_TTS_VOICE_ID: str = os.getenv("DEVNAGRI_TTS_VOICE_ID", "2")  # Indian English male
DEVNAGRI_TTS_VOICE_ID_FEMALE: str = os.getenv("DEVNAGRI_TTS_VOICE_ID_FEMALE", "1")  # Indian English female
DEVNAGRI_TTS_VOICE_ID_HI: str = os.getenv("DEVNAGRI_TTS_VOICE_ID_HI", "3")  # Simran, Hindi/Hinglish
# JSON: {"skeptical": {"ref_audio_url": "...", "ref_text": "...", "temperature": 0.8}, ...}
DEVNAGRI_TTS_EMOTION_PROFILES: str = os.getenv("DEVNAGRI_TTS_EMOTION_PROFILES", "{}")
DEVNAGRI_TURN_COMMIT_MS: int = int(os.getenv("DEVNAGRI_TURN_COMMIT_MS", "500"))
DEVNAGRI_BARGE_IN_MIN_WORDS: int = int(os.getenv("DEVNAGRI_BARGE_IN_MIN_WORDS", "2"))
DEVNAGRI_AUDIO_LEAD_MS: int = int(os.getenv("DEVNAGRI_AUDIO_LEAD_MS", "400"))
# Most recent messages sent verbatim to the LLM; older ones are condensed into meeting notes.
DEVNAGRI_HISTORY_TURNS: int = int(os.getenv("DEVNAGRI_HISTORY_TURNS", "12"))
# JSON merged into the chat completion request, e.g. {"reasoning_effort": "low"} for gpt-oss.
DEVNAGRI_LLM_EXTRA_BODY: str = os.getenv("DEVNAGRI_LLM_EXTRA_BODY", "{}")

# ── Voice pacing ─────────────────────────────────────────────────
VOICE_PACING_MIN_WPM: int = int(os.getenv("VOICE_PACING_MIN_WPM", "90"))
VOICE_PACING_MAX_WPM: int = int(os.getenv("VOICE_PACING_MAX_WPM", "180"))

# ── Video pause frames ──────────────────────────────────────────
# Sub-second precision (float, in seconds) for where each avatar video
# should land when paused. Allows tuning so the avatar's face is always
# in a natural resting position (e.g. mouth closed, neutral expression).
VIDEO_PAUSE_FRAME_MALE: float = float(os.getenv("VIDEO_PAUSE_FRAME_MALE", "1.50"))
VIDEO_PAUSE_FRAME_FEMALE: float = float(os.getenv("VIDEO_PAUSE_FRAME_FEMALE", "3.00"))

# ── Logging ──────────────────────────────────────────────────────
LOG_LEVEL: str = os.getenv("LOG_LEVEL", "info").lower()

# ── Environment ──────────────────────────────────────────────────
IS_PRODUCTION: bool = os.getenv("ENVIRONMENT", "development").lower() == "production"
IS_DEVELOPMENT: bool = not IS_PRODUCTION

# ── LLM / Realtime Usage Telemetry ───────────────────────────────

LLM_TELEMETRY_ENABLED: bool = (
    os.getenv("LLM_TELEMETRY_ENABLED", "true").lower()
    in {"1", "true", "yes", "y", "on"}
)

APPLICATIONINSIGHTS_CONNECTION_STRING: str = os.getenv(
    "APPLICATIONINSIGHTS_CONNECTION_STRING",
    "",
)

OTEL_SERVICE_NAME: str = os.getenv(
    "OTEL_SERVICE_NAME",
    "sales-coach-api",
)


def validate_config() -> List[str]:
    """
    Validate critical configuration and return a list of warnings.
    Call this on startup to catch misconfigurations early.
    """
    warnings: List[str] = []

    if IS_PRODUCTION:
        if SECRET_KEY == "your-super-secret-key-change-me-in-production":
            warnings.append(
                "CRITICAL: Using default JWT_SECRET_KEY in production. "
                "Set the JWT_SECRET_KEY environment variable."
            )
        if not OLLAMA_BASE_URL:
            warnings.append("WARNING: OLLAMA_BASE_URL is not set. AI endpoints will fail.")
        if not LLM_MODEL:
            warnings.append("WARNING: LLM_MODEL is not set. AI endpoints will fail.")
        if not AWS_REGION:
            warnings.append(
                "WARNING: AWS_REGION is not set. Nova Sonic voice session will fail."
            )
        if not NOVA_MODEL_ID:
            warnings.append(
                "WARNING: NOVA_MODEL_ID is not set. Nova Sonic voice session will fail."
            )

    if REALTIME_PROVIDER == "devnagri":
        if not BLACKBIRD_API_KEY:
            warnings.append("WARNING: BLACKBIRD_API_KEY is not set. Devnagri voice session will fail.")
        if not DEVNAGRI_TTS_API_KEY:
            warnings.append("WARNING: DEVNAGRI_TTS_API_KEY is not set. Devnagri voice session will fail.")
        if not (OLLAMA_BASE_URL and LLM_MODEL):
            warnings.append("WARNING: OLLAMA_BASE_URL/LLM_MODEL not set. Devnagri voice session has no LLM.")

    if not SECRET_KEY or len(SECRET_KEY) < 32:
        warnings.append(
            "WARNING: JWT_SECRET_KEY is too short (< 32 chars). Use a strong key."
        )

    if (
        VOICE_PACING_MIN_WPM > 0
        and VOICE_PACING_MAX_WPM > 0
        and VOICE_PACING_MIN_WPM >= VOICE_PACING_MAX_WPM
    ):
        warnings.append(
            "WARNING: VOICE_PACING_MIN_WPM must be lower than VOICE_PACING_MAX_WPM."
        )

    return warnings