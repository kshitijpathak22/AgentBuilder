# AI Business Simulation & Coaching Platform

An enterprise AI simulation and coaching platform built with a high-performance **FastAPI** backend and an interactive voice/video frontend. The platform delivers real-time bidirectional voice coaching, multi-modal avatar video synchronization, document-grounded context ingestion (RAG), dynamic multi-scenario business simulations, and automated multi-dimensional performance evaluation.

---

## Table of Contents

- [Overview & Core Capabilities](#overview--core-capabilities)
- [System Architecture](#system-architecture)
  - [Project Directory Layout](#project-directory-layout)
  - [Core Components & Responsibilities](#core-components--responsibilities)
- [Role-Based Access Control (RBAC)](#role-based-access-control-rbac)
  - [Privilege Hierarchy](#privilege-hierarchy)
  - [Permission Matrix](#permission-matrix)
  - [User Allowlist Configuration](#user-allowlist-configuration)
- [Realtime Voice & Audio Streaming Pipeline](#realtime-voice--audio-streaming-pipeline)
  - [Session Lifecycle & WebSocket Flow](#session-lifecycle--websocket-flow)
  - [WebSocket Protocol Contract](#websocket-protocol-contract)
  - [Transcript Deduplication & Prefix Stripping](#transcript-deduplication--prefix-stripping)
  - [Video Avatar Pause-Frame Synchronization](#video-avatar-pause-frame-synchronization)
  - [AWS CRT Asynchronous Teardown Safeguards](#aws-crt-asynchronous-teardown-safeguards)
- [Simulation Dimensions, Scenarios & Personas](#simulation-dimensions-scenarios--personas)
  - [The 8 Universal Evaluation Dimensions](#the-8-universal-evaluation-dimensions)
  - [Simulation Scenarios](#simulation-scenarios)
  - [Counterpart Personas](#counterpart-personas)
  - [Difficulty Levels & Behavioral Scaling](#difficulty-levels--behavioral-scaling)
  - [Dynamic Role Resolution](#dynamic-role-resolution)
  - [Multilingual Support](#multilingual-support)
- [Document Intelligence & Grounding](#document-intelligence--grounding)
- [Database Schema & Persistence](#database-schema--persistence)
- [Configuration & Environment Variables](#configuration--environment-variables)
- [Prerequisites & Installation](#prerequisites--installation)
- [Running the Application](#running-the-application)
- [API Reference](#api-reference)
  - [Global Endpoints](#global-endpoints)
  - [Authentication & RBAC (`/auth/*`)](#authentication--rbac-auth)
  - [Realtime Voice Simulation (`/realtime/*`, `/ws/*`, `/api/connectivity/*`)](#realtime-voice-simulation-realtime-ws-apiconnectivity)
  - [Database & Practice Sessions (`/db/*`)](#database--practice-sessions-db)
  - [Document Processing (`/documents/*`)](#document-processing-documents)
  - [AI Analysis & Evaluation (`/ai/*`)](#ai-analysis--evaluation-ai)
- [Logging & Telemetry](#logging--telemetry)
- [Troubleshooting](#troubleshooting)

---

## Overview & Core Capabilities

- **Bidirectional Speech-to-Speech Streaming**: Powered by **Amazon Nova 2 Sonic** (`amazon.nova-2-sonic-v1:0`) via WebSockets (`/ws/nova2-sonic`) with sub-second audio turnarounds, streaming raw PCM audio chunks (16 kHz input, 24 kHz output).
- **Multi-Persona & Multi-Scenario Practice**: Supports executive briefings, consulting engagements, performance discussions, team coaching, stakeholder management, and commercial pitches against 10 distinct professional personas with scaled difficulty levels.
- **Dynamic Role Resolution**: Automatically reconciles scenario and persona combinations to prevent contradictory simulation instructions (e.g., senior partners conducting reviews versus peers seeking feedback).
- **Document Intelligence (RAG Grounding)**: Extracts structured text and tables from PDF, DOCX, and PPTX decks, generating a factual 6–7 sentence context summary protected by prompt injection boundary tags (`<untrusted_document_context>`).
- **8 Universal Professional Competency Rubrics**: Automatically scores conversations across Communication, Discovery Skills, Business Acumen, Relationship Building, Executive Presence, Problem Solving, Influence & Persuasion, and Action Orientation.
- **Automated Performance Scorecards & Recommendations**: Produces 0–100 ratings, 5 concrete strengths, 5 improvement areas, 5 actionable insights, and longitudinal learning path recommendations across historical sessions.
- **Three-Tier Role-Based Access Control (RBAC)**: Enforces email-based authorization (`developer` > `admin` > `user`) with self-healing file-backed storage (`api/allowed_users.json`).
- **Telemetry & Connection Diagnostics**: Real-time EWMA tracking of latency, input/output chunk gaps, throughput (kbps), and active WebSocket session states.

---

## System Architecture

### Project Directory Layout

```
SalesCoach/
├── api/                                # Unified FastAPI Application Backend
│   ├── __init__.py                     # Package marker
│   ├── main.py                         # Application entrypoint, lifespan, middleware & routes
│   ├── allowed_users.json              # Authorized user registry and role assignments
│   ├── document_processor.py           # Document extraction engine (PDF, DOCX, PPTX)
│   ├── practice_sessions.db            # SQLite WAL database (auto-initialized at startup)
│   ├── api_docs.md                     # Supplementary API notes
│   ├── core/                           # Core infrastructure & cross-cutting concerns
│   │   ├── auth.py                     # JWT token handling & FastAPI RBAC dependencies
│   │   ├── config.py                   # Centralized environment variable loader & validation
│   │   ├── cors.py                     # Strict CORS origin configuration
│   │   ├── database.py                 # SQLite WAL connection manager & schema migration
│   │   ├── exceptions.py               # Global exception handlers with X-Request-ID
│   │   ├── llm_client.py               # OpenAI-compatible LLM client wrapper (HTTPX)
│   │   └── middleware.py               # RequestID, RateLimit, and SecurityHeaders middleware
│   ├── realtime/                       # Real-time voice simulation engine
│   │   ├── audio.py                    # Audio utilities, base64 helpers, and monotonic timing
│   │   ├── crt_patch.py                # AWS CRT asyncio cancellation race condition patch
│   │   ├── events.py                   # Event parsing, deduplication, and prefix stripping
│   │   ├── prompts.py                  # Persona profiles, scenario guides & prompt compiler
│   │   ├── session.py                  # ClientSession state & Nova Sonic streaming loop
│   │   └── stats.py                    # Rolling EWMA telemetry & throughput tracker
│   ├── repositories/                   # Data access layer
│   │   └── session_repository.py       # SQL queries for sessions, evaluations & admin tools
│   └── routers/                        # REST & WebSocket API route handlers
│       ├── ai.py                       # Pitch analysis, reports & learning recommendations
│       ├── auth.py                     # Email login, token refresh, and RBAC management
│       ├── db.py                       # User sessions, evaluations, history & admin endpoints
│       ├── document.py                 # Document upload, extraction & sales summarization
│       └── realtime.py                 # Nova Sonic session bootstrap & WebSocket handlers
├── logs/                               # Rotating application and error log files
│   ├── salescoach.log                  # Standard application log (10 MB max, 5 backups)
│   └── errors.log                      # Dedicated error log (10 MB max, 5 backups)
├── shared_logger.py                    # Centralized logging configuration
├── requirements.txt                    # Python dependencies
└── .env                                # Environment configurations (copy from template)
```

### Core Components & Responsibilities

| Component | Responsibility |
| :--- | :--- |
| `api/main.py` | Initializes FastAPI, coordinates lifespan events, checks database health, attaches security middleware, and mounts routers. |
| `api/core/auth.py` | Generates and validates HS256 JWT access and refresh tokens. Authorizes users against `allowed_users.json` and supplies RBAC dependencies (`require_admin`, `require_developer`, `require_role`). |
| `api/core/config.py` | Centralizes all environment variables, paths, and timeouts, performing startup verification with actionable warnings. |
| `api/core/database.py` | Manages SQLite connection pooling in WAL mode (`PRAGMA journal_mode=WAL`), enforces foreign keys (`PRAGMA foreign_keys=ON`), and executes idempotent schema migrations. |
| `api/core/middleware.py` | Appends `X-Request-ID` to all responses, enforces an in-memory sliding window rate limiter (stricter on `/auth/login`), and attaches protective security headers (HSTS, nosniff, DENY). |
| `api/core/llm_client.py` | Wraps OpenAI-compatible endpoints with configurable timeouts, SSL verification, and exponential backoff retry logic. |
| `api/repositories/session_repository.py` | Encapsulates all SQL transactions for practice sessions, conversation message histories, multi-dimensional score normalization, and administrative overview aggregates. |
| `api/realtime/prompts.py` | Compiles dynamic system instructions based on scenario, counterpart persona, difficulty, business line, language, and grounding text. |
| `api/realtime/session.py` | Handles bidirectional WebSocket streams between browser clients and Bedrock Nova Sonic, routing incoming audio chunks and outgoing audio/transcript events. |
| `api/realtime/events.py` | Filters speculative tokens, strips cumulative transcript prefixes, and normalizes final conversation transcripts. |
| `api/realtime/crt_patch.py` | Intercepts `awscrt.aio.http` stream teardowns to suppress `concurrent.futures.InvalidStateError: CANCELLED` exceptions during client disconnections. |
| `api/realtime/stats.py` | Computes rolling input/output kbps, chunk gaps, and EWMA first-audio latency metrics. |

---

## Role-Based Access Control (RBAC)

### Privilege Hierarchy

The platform implements an explicit three-tier privilege hierarchy:

$$\text{developer} > \text{admin} > \text{user}$$

1. **`developer`**: Unrestricted platform access. Can assign or demote all roles (including `developer`), inspect runtime model configurations, reset connectivity telemetry, and run developer diagnostics.
2. **`admin`**: Administrative governance. Can access global session history, inspect platform-wide metrics, initialize the database, and assign `user` and `admin` roles (cannot assign `developer` or modify `developer` accounts).
3. **`user`**: Standard practitioner access. Can configure and run simulations, upload grounding materials, review personal session evaluations, and retrieve historical conversation records.

### Permission Matrix

| Capability / Resource | `user` | `admin` | `developer` |
| :--- | :---: | :---: | :---: |
| Run Realtime Voice Simulations & Upload Documents | Yes | Yes | Yes |
| View Personal Practice History & Scorecards | Yes | Yes | Yes |
| Inspect Global Analytics & All User Sessions (`/db/admin/*`) | No | **Yes** | **Yes** |
| Access Global Admin Overview (`/db/admin/overview`) | No | **Yes** | **Yes** |
| Reinitialize Database Schema (`/db/init`, `/db/admin/init`) | No | **Yes** | **Yes** |
| List Allowed Users (`/auth/users`) | No | **Yes** | **Yes** |
| Assign or Change `user` and `admin` Roles | No | **Yes** | **Yes** |
| Assign or Modify `developer` Role Accounts | No | No | **Yes** |
| Inspect Telemetry Diagnostics (`/auth/developer/diagnostics`) | No | No | **Yes** |
| Reset Realtime Connectivity Telemetry (`/api/connectivity/reset`) | No | No | **Yes** |

### User Allowlist Configuration

User authorization is governed by `api/allowed_users.json`. The backend hot-reloads this file when changes occur:

```json
{
  "allowed_users": [
    {
      "email": "developer@example.com",
      "name": "Platform Engineer",
      "role": "developer"
    },
    {
      "email": "admin@example.com",
      "name": "Practice Administrator",
      "role": "admin"
    },
    {
      "email": "practitioner@example.com",
      "name": "Jane Doe",
      "role": "user"
    }
  ],
  "note": "Allowed user roles: user, admin, developer."
}
```

Authentication is strictly **email-based**; users submit their email address to `/auth/login`. If the email is present in `allowed_users.json`, access and refresh tokens are issued containing the user's role claim.

---

## Realtime Voice & Audio Streaming Pipeline

### Session Lifecycle & WebSocket Flow

```
Practitioner Browser                   FastAPI Backend                  Amazon Bedrock
        |                                     |                                |
        | 1. POST /realtime/session           |                                |
        |------------------------------------>|                                |
        |                                     | Compile dynamic prompt         |
        |                                     | Register ClientSession         |
        | 2. Returns ws_url & session metadata|                                |
        |<------------------------------------|                                |
        |                                     |                                |
        | 3. Connect WebSocket /ws/nova2-sonic|                                |
        |------------------------------------>|                                |
        |                                     | 4. Open Bedrock Sonic stream   |
        |                                     |------------------------------->|
        | 5. "server_ready" event             |                                |
        |<------------------------------------|                                |
        |                                     |                                |
        | 6. Send "start" {session_id}        |                                |
        |------------------------------------>|                                |
        |                                     |                                |
        | 7. Stream audio chunks (PCM 16kHz)  | 8. Forward audio to Bedrock     |
        |------------------------------------>|------------------------------->|
        |                                     |                                |
        | 9. Send "end" (turn complete)       | 10. Close input stream turn    |
        |------------------------------------>|------------------------------->|
        |                                     |                                |
        |                                     | 11. Receive audio & events     |
        |                                     |<-------------------------------|
        | 12. "audio_start" + latency metrics |                                |
        |<------------------------------------|                                |
        | 13. Stream audio chunks (PCM 24kHz) |                                |
        |<------------------------------------|                                |
        | 14. "transcript" events (assistant) |                                |
        |<------------------------------------|                                |
        | 15. "audio_end" (playback complete) |                                |
        |<------------------------------------|                                |
```

### WebSocket Protocol Contract

Clients communicate over `/ws/nova2-sonic` (or the `/ws/sonic` alias) with JSON messages or base64 audio frames.

#### Client-to-Server Messages

| Type | Payload Attributes | Description |
| :--- | :--- | :--- |
| `start` | `{"session_id": "...", "system_prompt": "...", "voice_id": "..."}` | Initializes the Nova Sonic session with pre-configured parameters. |
| `audio` | `{"audio": "<base64 PCM 16kHz audio>"}` | Streams user microphone audio to the backend. |
| `end` | `{"type": "end"}` | Signals completion of the user's speaking turn, triggering model response. |
| `text` | `{"text": "..."}` | Text-based fallback input when microphone input is unavailable. |
| `ping` | `{"client_ts": 123456, "nonce": "..."}` | Latency probe; answered immediately with `pong`. |
| `client_metrics`| `{"ws_rtt_ms": ..., "playback_queue_sec": ...}` | Sends browser audio playback metrics to the server for telemetry. |
| `stats` | `{"type": "stats"}` | Requests instantaneous rolling connectivity telemetry. |
| `close` | `{"type": "close"}` | Requests graceful termination of the WebSocket session. |

#### Server-to-Client Messages

| Type | Payload Attributes | Description |
| :--- | :--- | :--- |
| `server_ready` | `{"session_id": "...", "stats_endpoint": "..."}` | Confirms WebSocket handshake and session allocation. |
| `info` | `{"message": "...", "source": "nova" \| "server"}` | Informational stream state notification. |
| `audio_start` | `{"sample_rate": 24000, "first_audio_latency_ms": 320.5}` | Emitted immediately when the first assistant audio byte arrives. |
| `audio` | `{"audio": "<base64 PCM 24kHz>", "chunk_index": 1}` | Streaming raw PCM audio frames for avatar playback. |
| `audio_end` | `{"source": "nova"}` | Emitted when assistant audio turn finishes. |
| `transcript` | `{"role": "user" \| "assistant", "text": "...", "final": bool}` | Normalized, deduplicated speech transcript. |
| `pong` | `{"client_ts": ..., "server_ts_ms": ...}` | Reply to client `ping` probe. |
| `stats` | `{"stats": { ... }}` | Telemetry payload containing EWMA latencies and buffer stats. |
| `warning` | `{"message": "..."}` | Non-fatal streaming or buffer warning. |
| `error` | `{"message": "..."}` | Error alert detailing downstream failure or malformed payload. |

### Transcript Deduplication & Prefix Stripping

Amazon Nova Sonic streams progressive, speculative transcripts that occasionally duplicate tokens across content boundaries. `api/realtime/events.py` implements:

1. **Token-Level Prefix Stripping**: `strip_previous_assistant_prefix()` removes previously spoken sentences and tokens from new incoming transcript fragments.
2. **Sliding-Window Deduplication**: `should_emit_transcript()` checks candidate phrases against an in-memory TTL cache (default 2 seconds), suppressing duplicate emissions.
3. **Generation Stage Filtering**: Suppresses `SPECULATIVE` partials and emits final strings only upon `FINAL` stage or `contentEnd` boundary markers.

### Video Avatar Pause-Frame Synchronization

To ensure visual realism when synchronizing video avatars with audio playback:
- Male avatar pause frame: **1.50 seconds** (`VIDEO_PAUSE_FRAME_MALE`)
- Female avatar pause frame: **3.00 seconds** (`VIDEO_PAUSE_FRAME_FEMALE`)

These sub-second timestamps ensure that when speech finishes and audio playback pauses, the video avatar resets to a neutral resting frame with mouth closed.

### AWS CRT Asynchronous Teardown Safeguards

When clients abruptly terminate WebSocket connections, the underlying AWS Common Runtime (CRT) asynchronous HTTP/2 event loop can attempt to set results on cancelled futures, raising `concurrent.futures.InvalidStateError: CANCELLED`. `api/realtime/crt_patch.py` safely wraps `_on_body` and `_on_complete` handlers on `awscrt.aio.http` stream classes to suppress these benign cancellation exceptions during teardown.

---

## Simulation Dimensions, Scenarios & Personas

### The 8 Universal Evaluation Dimensions

The evaluation engine assesses conversations against 8 core dimensions (scored 0–100):

1. **Communication**: Clarity, conciseness, structured articulation, and professional tone.
2. **Discovery Skills**: Uncovering core needs, asking effective probing questions, and active listening.
3. **Business Acumen**: Comprehension of commercial, organizational, and operational realities.
4. **Relationship Building**: Empathy, building rapport, psychological safety, and establishing trust.
5. **Executive Presence**: Poise under pressure, confidence, and bottom-line-first delivery.
6. **Problem Solving**: Root-cause diagnosis, structured reasoning, and viable solutions/recommendations.
7. **Influence & Persuasion**: Handling pushback/objections, gaining stakeholder buy-in, and navigating resistance.
8. **Action Orientation & Next Steps**: Establishing clear accountability, driving decisions, and concrete next steps.

*Note: The platform includes backward-compatible normalization for legacy dimension keys (e.g., `Opening & Engagement` maps to `Relationship Building`, `Objection Handling` maps to `Influence & Persuasion`).*

### Simulation Scenarios

1. **Sales & Commercial Pitches**: Commercial pitch presentation, discovery questioning, objection handling, ROI demonstration, and contracting next steps.
2. **Consulting Engagements**: Diagnostic synthesis, presenting strategic recommendations, managing scope creep, and aligning on project milestones.
3. **Stakeholder Management & Alignment**: Cross-functional alignment, addressing departmental friction, resource trade-offs, and negotiating delivery priorities.
4. **Executive Presence & C-Suite Briefings**: High-stakes board or C-suite briefing demanding concise bottom-line-first delivery, risk governance, and immediate decision-making.
5. **Leadership Conversations & Team Coaching**: Mentorship, career growth planning, resolving team dynamics, and constructive leadership coaching.
6. **Difficult Performance Discussions & Career Reviews**: Navigating constructive feedback, addressing performance gaps, handling defensiveness, and setting remediation plans.

### Counterpart Personas

The platform includes 10 fully articulated persona profiles:

| Persona | Key Focus Areas | Typical Communication Style |
| :--- | :--- | :--- |
| **Senior Leadership** (Partner / Managing Director) | Firm profitability, reputation risk, partner equity, and strategic alignment | High-level, decisive, expects bottom-line first, impatient with tactical trivia. |
| **Consulting & Strategy Lead** | Diagnostic rigor, methodology robustness, and change management feasibility | Analytical, structured, probes underlying frameworks and hypotheses. |
| **PPC Lead** (People, Performance & Culture) | Employee well-being, burnout risk, psychological safety, and talent growth | Empathetic yet governance-focused; attentive to team sentiment and morale. |
| **L&D Director** (Learning & Development) | Capability building, skills transfer, behavioral adoption, and measurable ROI | Pedagogical, outcome-oriented, focused on sustained capability uplift. |
| **CTO** (Chief Technology Officer) | System architecture, technical debt, security posture, and engineering burden | Incisive, technical, demands architectural clarity over marketing buzzwords. |
| **CFO** (Chief Financial Officer) | CapEx/OpEx, total cost of ownership (TCO), cash flow payback, and financial risk | Brevity-oriented, quantitative, highly skeptical of qualitative claims. |
| **CEO** (Chief Executive Officer) | Enterprise competitive advantage, market positioning, and enterprise value | Visionary, time-conscious, rapid evaluator of executive presence. |
| **VP of Operations** | SLA adherence, process continuity, downtime minimization, and frontline impact | Process-driven, pragmatic, acutely sensitive to operational disruption. |
| **Head of Sales** | Pipeline conversion, sales velocity, rep adoption, and commercial traction | Energetic, quota-driven, skeptical of theoretical frameworks without traction. |
| **Procurement Manager** | Contract terms, SLA commitments, pricing parity, and vendor lock-in | Formal, transactional, and negotiation-oriented. |

### Difficulty Levels & Behavioral Scaling

- **`Easy`**: Friendly and collaborative; asks simple questions; raises at most one mild objection; accepts reasonable qualitative answers.
- **`Medium`**: Professional and discerning; asks probing questions on budget, trade-offs, and timelines; requires clear justifications.
- **`Hard`**: Skeptical and demanding; challenges weak assumptions; raises layered objections; requires concrete metrics and structured methodology.
- **`Expert`**: High-stakes executive examination; tests cross-functional interdependencies; scrutinizes governance and risk; rejects generic buzzwords.

### Dynamic Role Resolution

To prevent role contradiction, `resolve_counterpart_role()` dynamically adjusts the prompt role framing:
- In **Difficult Performance Discussions**, selecting a senior persona configures the AI as an executive delivering feedback; selecting a team persona configures the AI as an employee receiving feedback.
- In **Leadership Conversations**, selecting an executive configures the session as a strategic alignment discussion; selecting a junior persona configures a mentorship session.

### Multilingual Support

The voice simulation and evaluation engines natively support:
- English (`en`)
- French (`fr`)
- German (`de`)
- Spanish (`es`)
- Italian (`it`)
- Automatic matching (`auto`): AI detects and responds in the practitioner's active language.

---

## Document Intelligence & Grounding

The platform ingests business collateral to ground simulations in real organizational context:

1. **Extraction**: `DocumentProcessor` parses raw text and structural tables from:
   - PDF Documents (`PyPDF2`)
   - Word Documents (`python-docx`)
   - PowerPoint Decks (`python-pptx`)
2. **Sanitization & Analysis**: Extracts line counts, section headers, bullet lists, tables, and top term frequencies.
3. **Factual Summarization**: `_create_llm_sales_summary()` summarizes collateral into a concise 6–7 sentence factual background block covering objectives, stakeholders, capabilities, outcomes, timelines, and risks.
4. **Prompt Injection Defense**: Background text is enclosed within `<untrusted_document_context>` XML boundary tags. Simulation instructions explicitly instruct the model to treat this content solely as passive factual background and reject any embedded instructions or prompt overrides.

---

## Database Schema & Persistence

Data is stored in SQLite using WAL mode (`PRAGMA journal_mode=WAL`) and foreign key constraints (`PRAGMA foreign_keys=ON`). All data is partitioned by the authenticated user's email (`username` column).

```
                      +-----------------------------+
                      |      practice_sessions      |
                      +-----------------------------+
                      | session_id (PK, TEXT)       |
                      | username (TEXT)             |
                      | timestamp (TEXT)            |
                      | difficulty_level (TEXT)     |
                      | client_persona (TEXT)       |
                      | industry (TEXT)             |
                      | company_size (TEXT)         |
                      | total_practice_time (INT)   |
                      | document_alignment (REAL)   |
                      | average_score (REAL)        |
                      | scenario_type (TEXT)        |
                      | business_context (TEXT)     |
                      | response_language (TEXT)    |
                      +-----------------------------+
                                     |
              +----------------------+----------------------+
              | 1                                           | 1
              |                                             |
              | * (ON DELETE CASCADE)                       | * (ON DELETE CASCADE)
              v                                             v
+-----------------------------+               +-----------------------------+
|     evaluation_results      |               |    conversation_history     |
+-----------------------------+               +-----------------------------+
| id (PK, INT AUTOINCREMENT)  |               | id (PK, INT AUTOINCREMENT)  |
| session_id (FK, TEXT)       |               | session_id (FK, TEXT)       |
| username (TEXT)             |               | username (TEXT)             |
| overall_score (REAL)        |               | message_index (INT)         |
| report_text (TEXT)          |               | role (TEXT: user/ai)        |
| dimension_scores (JSON TEXT)|               | content (TEXT)              |
| timestamp (TEXT)            |               | timestamp (TEXT)            |
+-----------------------------+               +-----------------------------+
```

---

## Configuration & Environment Variables

Configure application settings via environment variables or a `.env` file in the project root:

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| **`ENVIRONMENT`** | `development` | Environment mode (`development` or `production`). |
| **`SERVER_HOST`** | `0.0.0.0` | IP address bound by the Uvicorn server. |
| **`SERVER_PORT`** | `2089` | Port for the FastAPI backend. |
| **`SERVER_RELOAD`** | `false` | Enable auto-reload on code change (development). |
| **`CORS_ALLOWED_ORIGINS`** | `http://localhost:3000,...` | Comma-separated list of allowed origins (wildcards prohibited). |
| **`JWT_SECRET_KEY`** | `your-super-secret-key...` | Cryptographic secret for signing JWTs (must be ≥ 32 characters in production). |
| **`ACCESS_TOKEN_EXPIRE_MINUTES`** | `30` | Access token expiration lifetime in minutes. |
| **`REFRESH_TOKEN_EXPIRE_DAYS`** | `7` | Refresh token expiration lifetime in days. |
| **`RATE_LIMIT_ENABLED`** | `true` | Enables in-memory sliding window rate limiting. |
| **`RATE_LIMIT_REQUESTS`** | `100` | Allowed requests per general sliding window. |
| **`RATE_LIMIT_WINDOW_SECONDS`** | `60` | Time window for general rate limiting in seconds. |
| **`AUTH_RATE_LIMIT_REQUESTS`** | `5` | Allowed requests per login window. |
| **`AUTH_RATE_LIMIT_WINDOW_SECONDS`** | `60` | Time window for auth rate limiting in seconds. |
| **`MAX_UPLOAD_SIZE_MB`** | `50` | Maximum file upload size in megabytes. |
| **`AZURE_DOC_INTELLIGENCE_ENDPOINT`** | *(empty)* | Azure AI Document Intelligence endpoint, e.g. `https://<name>.cognitiveservices.azure.com`. Used to OCR scanned PDFs (no text layer) with the `prebuilt-read` model. Empty = OCR off; scanned PDFs are rejected with a clear message. |
| **`AZURE_DOC_INTELLIGENCE_KEY`** | *(empty)* | Key for the Document Intelligence resource. |
| **`AZURE_DOC_INTELLIGENCE_TIMEOUT_SECONDS`** | `120` | Longest wait for one OCR job. |
| **`OLLAMA_BASE_URL`** | *(empty)* | OpenAI-compatible endpoint URL for LLM evaluations. |
| **`OLLAMA_API_KEY`** | *(empty)* | API key for the LLM endpoint (optional for local Ollama). |
| **`LLM_MODEL`** | *(empty)* | Model name (e.g., `openai.gpt-oss-20b`, `llama3`). |
| **`LLM_TIMEOUT_SECONDS`** | `120` | Timeout for LLM evaluation and report requests. |
| **`LLM_MAX_RETRIES`** | `2` | Number of retry attempts on transient LLM failures. |
| **`LLM_VERIFY_SSL`** | `true` | Verify SSL certificates when contacting the LLM endpoint. |
| **`AWS_ACCESS_KEY_ID`** | *(empty)* | AWS Access Key ID for Bedrock Nova Sonic. |
| **`AWS_SECRET_ACCESS_KEY`**| *(empty)* | AWS Secret Access Key for Bedrock Nova Sonic. |
| **`AWS_SESSION_TOKEN`** | *(empty)* | Optional temporary session token for AWS credentials. |
| **`AWS_REGION`** | `us-east-1` | AWS Region for Amazon Bedrock foundation models. |
| **`NOVA_MODEL_ID`** | `amazon.nova-2-sonic-v1:0`| Bedrock Nova 2 Sonic model identifier. |
| **`NOVA_VOICE_ID`** | `matthew` | Default voice identifier for male counterparts. |
| **`NOVA_VOICE_ID_FEMALE`** | `tiffany` | Default voice identifier for female counterparts. |
| **`INPUT_AUDIO_SAMPLE_RATE`** | `16000` | Input audio sample rate (Hz). |
| **`OUTPUT_AUDIO_SAMPLE_RATE`**| `24000` | Output audio sample rate (Hz). |
| **`AZURE_OPENAI_REALTIME_TRANSCRIBE_DEPLOYMENT`** | *(empty)* | Azure deployment name of a transcription model (e.g. `gpt-4o-mini-transcribe`). Enables user-speech transcripts in Azure realtime sessions; empty leaves them off. |
| **`VOICE_PROVIDER`** | *(from `REALTIME_PROVIDER`)* | Voice backend: `aws_realtime`, `azure_realtime` or `devnagri_cascaded`. When unset, legacy `REALTIME_PROVIDER` (`nova`/`azure`) applies. With `devnagri_cascaded`, sessions in French, German, Spanish, Italian or Auto run on Azure realtime when the `AZURE_OPENAI_REALTIME_*` settings are present (Devnagri's speech recognition covers English and Indian languages only); without them those four languages are hidden in the UI. |
| **`BLACKBIRD_API_KEY`** | *(empty)* | Devnagri Blackbird ASR key (`bb_live_…`). |
| **`BLACKBIRD_WS_URL`** | `wss://blackbird.devnagri.com/v1/stream` | Blackbird streaming endpoint. |
| **`DEVNAGRI_ASR_MODE`** | `mixed` | Blackbird output mode (`native`, `mixed`, `romanized`). Language is pinned per session (`hi` or `en`). |
| **`DEVNAGRI_TTS_API_KEY`** | *(empty)* | Devnagri TTS key (`dvn_tts_…`). |
| **`DEVNAGRI_TTS_URL`** | `https://tts.devnagri.com/v1/audio/speech` | Devnagri TTS endpoint. |
| **`DEVNAGRI_TTS_SAMPLE_RATE`** | `24000` | Sample rate of Devnagri's raw PCM stream; confirm with `scripts/probe_devnagri_tts.py`. |
| **`DEVNAGRI_TTS_VOICE_ID`** / **`_FEMALE`** / **`_HI`** | `2` / `1` / `3` | Devnagri voice IDs for male, female and Hindi (Simran) counterparts. |
| **`DEVNAGRI_TTS_EMOTION_PROFILES`** | `{}` | JSON map of emotion → `{ref_audio_url, ref_text, temperature}`; emotions: neutral, skeptical, enthusiastic, frustrated, encouraging. |
| **`DEVNAGRI_TURN_COMMIT_MS`** | `500` | Silence after an ASR final before the user turn is committed. |
| **`DEVNAGRI_BARGE_IN_MIN_WORDS`** | `2` | Words of user speech needed to interrupt the coach. |
| **`DEVNAGRI_AUDIO_LEAD_MS`** | `400` | How far ahead of real time coach audio is sent (bounds audio left playing after barge-in). |
| **`DEVNAGRI_HISTORY_TURNS`** | `12` | Most recent messages sent verbatim to the LLM; older turns are condensed into rolling meeting notes. |
| **`DEVNAGRI_LLM_EXTRA_BODY`** | `{}` | JSON merged into the streaming chat request, e.g. `{"reasoning_effort": "low"}`. |
| **`VOICE_PACING_MIN_WPM`** | `90` | Pacing telemetry minimum words per minute. |
| **`VOICE_PACING_MAX_WPM`** | `180` | Pacing telemetry maximum words per minute. |
| **`VIDEO_PAUSE_FRAME_MALE`** | `1.50` | Video avatar resting frame (seconds) for male avatars. |
| **`VIDEO_PAUSE_FRAME_FEMALE`**| `3.00` | Video avatar resting frame (seconds) for female avatars. |
| **`WS_BEARER_TOKEN`** | *(empty)* | Static fallback bearer token for WebSocket connections. |
| **`LOG_LEVEL`** | `info` | Logging verbosity (`debug`, `info`, `warning`, `error`). |

---

## Prerequisites & Installation

### 1. System Requirements

- **Python**: 3.12 or newer (tested up to Python 3.14).
- **AWS Bedrock Access**: Valid AWS credentials with permission to invoke `amazon.nova-2-sonic-v1:0` in `us-east-1`.
- **LLM Endpoint**: An OpenAI-compatible LLM endpoint (e.g., local Ollama, AWS Bedrock Mantle, vLLM, or OpenAI) serving models such as `gpt-oss-20b` or `llama3`.

### 2. Environment Setup

```bash
# Clone the repository
git clone <repository-url>
cd SalesCoach

# Create and activate virtual environment
python -m venv salescoachenv

# Windows (PowerShell)
.\salescoachenv\Scripts\Activate.ps1

# Linux / macOS
source salescoachenv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 3. Configure `.env` File

Create a `.env` file in the project root:

```env
ENVIRONMENT=development
JWT_SECRET_KEY=generate-a-secure-random-32-char-string
ACCESS_TOKEN_EXPIRE_MINUTES=60
REFRESH_TOKEN_EXPIRE_DAYS=7

CORS_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000

# LLM Evaluation Configuration
OLLAMA_BASE_URL=https://bedrock-mantle.ap-south-1.api.aws/v1/
OLLAMA_API_KEY=your-api-key-here
LLM_MODEL=openai.gpt-oss-20b
LLM_TIMEOUT_SECONDS=120
LLM_MAX_RETRIES=2
LLM_VERIFY_SSL=true

# Amazon Bedrock Nova 2 Sonic Realtime Voice
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key
AWS_REGION=us-east-1
NOVA_MODEL_ID=amazon.nova-2-sonic-v1:0
NOVA_VOICE_ID=matthew
NOVA_VOICE_ID_FEMALE=tiffany

VOICE_PACING_MIN_WPM=90
VOICE_PACING_MAX_WPM=180
VIDEO_PAUSE_FRAME_MALE=1.50
VIDEO_PAUSE_FRAME_FEMALE=3.00

LOG_LEVEL=info
```

---

## Running the Application

### 1. Start the FastAPI Backend

Run using Uvicorn:

```bash
uvicorn api.main:app --host 0.0.0.0 --port 2089 --reload
```

Or execute directly through Python:

```bash
python -m api.main
```

The database schema initializes automatically during application startup.

### 2. Verify Health & OpenAPI Docs

- **Health Check**: `http://localhost:2089/health`
- **Swagger Documentation**: `http://localhost:2089/docs`
- **ReDoc Documentation**: `http://localhost:2089/redoc`

---

## API Reference

### Global Endpoints

| Method | Endpoint | Auth | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/` | No | Returns platform status, version, and route index. |
| `GET` | `/health` | No | Evaluates database connectivity and service health. |

---

### Authentication & RBAC (`/auth/*`)

| Method | Endpoint | Auth Level | Description |
| :--- | :--- | :---: | :--- |
| `POST` | `/auth/login` | Public | Authenticates email against `allowed_users.json`, returning access and refresh JWTs. |
| `POST` | `/auth/refresh` | Public | Validates a refresh token and issues a fresh token pair. |
| `GET` | `/auth/me` | Authenticated | Retrieves current user profile, email, and assigned role. |
| `GET` | `/auth/users` | `admin` / `developer` | Lists all users from `allowed_users.json`. |
| `PUT` | `/auth/users/role` | `admin` / `developer` | Updates an allowed user's role following privilege constraints. |
| `GET` | `/auth/developer/diagnostics` | `developer` only | Returns runtime model configuration and global audio stats. |

#### Example: Login Request
```bash
curl -X POST http://localhost:2089/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com"}'
```

#### Example: Role Update Request
```bash
curl -X PUT http://localhost:2089/auth/users/role \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "role": "admin"}'
```

---

### Realtime Voice Simulation (`/realtime/*`, `/ws/*`, `/api/connectivity/*`)

| Method | Endpoint | Auth Level | Description |
| :--- | :--- | :---: | :--- |
| `POST` | `/realtime/session` | Authenticated | Compiles system instructions and bootstraps an Amazon Nova 2 Sonic session. |
| `WS` | `/ws/nova2-sonic` | Token in Query/Header | Bidirectional WebSocket stream for audio exchange and live transcripts. |
| `WS` | `/ws/sonic` | Token in Query/Header | Alias route for `/ws/nova2-sonic`. |
| `GET` | `/api/connectivity/stats` | Public | Diagnostics payload containing EWMA latencies, throughput, and stream health. |
| `POST` | `/api/connectivity/reset` | Public | Resets rolling statistics and telemetry counters. |

#### Example: Bootstrap Session Request
```bash
curl -X POST http://localhost:2089/realtime/session \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "client_type": "Hard",
    "client_persona": "CTO - Chief Technology Officer",
    "scenario_type": "Executive Presence & C-Suite Briefings",
    "industry": "Technology / SaaS",
    "company_size": "Enterprise (1000+ employees)",
    "response_language": "en",
    "pitch_summary": "Core initiative overview..."
  }'
```

---

### Database & Practice Sessions (`/db/*`)

All `/db/*` endpoints (except administrative routes) are automatically scoped to the authenticated user's email.

| Method | Endpoint | Auth Level | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/db/` | Authenticated | Database API status. |
| `POST` | `/db/init` | `admin` / `developer` | Idempotent schema initialization. |
| `POST` | `/db/sessions` | Authenticated | Persists practice session metadata. |
| `GET` | `/db/sessions` | Authenticated | Retrieves current user sessions (supports `limit` and `difficulty` filters). |
| `GET` | `/db/sessions/{session_id}` | Authenticated | Retrieves session details and latest evaluation by session ID. |
| `DELETE` | `/db/sessions/{session_id}` | Authenticated | Cascading deletion of a practice session and associated records. |
| `DELETE` | `/db/sessions/last` | Authenticated | Deletes current user's most recent session. |
| `GET` | `/db/sessions/scores` | Authenticated | Returns historical session dates and average scores (supports `limit`). |
| `GET` | `/db/sessions_difficulty` | Authenticated | Returns historical scores grouped by difficulty level. |
| `PUT` | `/db/sessions/{session_id}/score` | Authenticated | Updates average score for a session. |
| `POST` | `/db/evaluations` | Authenticated | Persists post-session evaluation results and dimension scores. |
| `GET` | `/db/evaluations/{session_id}` | Authenticated | Retrieves all evaluation records for a session. |
| `POST` | `/db/conversations` | Authenticated | Persists conversation turn history. |
| `GET` | `/db/conversations/{session_id}` | Authenticated | Retrieves conversation turn history for a session. |
| `GET` | `/db/statistics` | Authenticated | Computes aggregated user statistics (averages, counts, practice time). |
| `GET` | `/db/clarity` | Authenticated | Retrieves latest and 5-session average for Communication. |
| `GET` | `/db/dimensions/summary` | Authenticated | Retrieves latest and 5-session averages across all 8 rubrics. |
| `GET` | `/db/admin/overview` | `admin` / `developer` | Platform-wide user metrics and aggregate counts. |
| `GET` | `/db/admin/sessions` | `admin` / `developer` | Returns all practice sessions across all users. |
| `GET` | `/db/admin/evaluations` | `admin` / `developer` | Returns all evaluation reports across all users. |
| `GET` | `/db/admin/conversations` | `admin` / `developer` | Returns all conversation turns across all users. |
| `GET` | `/db/admin/conversations/{id}` | `admin` / `developer` | Returns conversation turns for any session. |
| `DELETE`| `/db/admin/sessions/{id}` | `admin` / `developer` | Deletes any session and its associated data across the platform. |
| `POST` | `/db/admin/init` | `admin` / `developer` | Idempotent database schema reinitialization. |

---

### Document Processing (`/documents/*`)

| Method | Endpoint | Auth Level | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/documents/` | Authenticated | Document API info and endpoint listing. |
| `GET` | `/documents/health` | Authenticated | Document processing service health check. |
| `POST` | `/documents/upload` | Authenticated | Consolidated endpoint uploading one or multiple files (PDF, PPTX, DOCX). |
| `POST` | `/documents/summarize` | Authenticated | Generates a 6–7 sentence factual sales summary from raw text via LLM. |
| `POST` | `/documents/upload/single` | Authenticated | Ingests a single document, returning extracted content and statistics. |
| `POST` | `/documents/upload/multiple`| Authenticated | Ingests multiple files, returning individual extracted texts. |
| `POST` | `/documents/combine` | Authenticated | Merges multiple processed document payloads into a single string. |
| `POST` | `/documents/extract/pdf` | Authenticated | Extracts plain text from an uploaded PDF. |
| `POST` | `/documents/extract/pptx`| Authenticated | Extracts slide text and tables from a PowerPoint deck. |
| `POST` | `/documents/extract/docx`| Authenticated | Extracts paragraph text and tables from a Word document. |
| `POST` | `/documents/analyze/structure` | Authenticated | Computes structural metrics (sections, line counts, headers, key terms). |
| `POST` | `/documents/analyze/sales-summary` | Authenticated | Generates structured sales summary and document statistics. |
| `POST` | `/documents/process/full`| Authenticated | Full pipeline: file extraction, structural analysis, and LLM summary. |

#### Example: Document Upload Request
```bash
curl -X POST http://localhost:2089/documents/upload/single \
  -H "Authorization: Bearer <access_token>" \
  -F "file=@presentation.pdf"
```

---

### AI Analysis & Evaluation (`/ai/*`)

| Method | Endpoint | Auth Level | Description |
| :--- | :--- | :---: | :--- |
| `POST` | `/ai/analyze` | Authenticated | Produces a single-sentence tactical coaching suggestion for the active turn. |
| `POST` | `/ai/simulate-client` | Authenticated | Simulates a counterpart text response given difficulty and context. |
| `POST` | `/ai/full_report` | Authenticated | Generates comprehensive scorecard across the 8 dimensions with strengths & insights. |
| `GET` | `/ai/learning-recommendations`| Authenticated | Synthesizes performance across the last 5 sessions into 5 prioritized learning paths. |

#### Example: Full Report Request
```bash
curl -X POST http://localhost:2089/ai/full_report \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "persona": "CFO - Chief Financial Officer",
    "speech": "User: Good morning. I am presenting our multi-year cloud architecture plan...",
    "pitch_deck": "Executive deck summary content...",
    "difficulty_level": "Hard",
    "scenario_type": "Executive Presence & C-Suite Briefings",
    "response_language": "en"
  }'
```

#### Example Response
```json
{
  "score": 78.0,
  "dimensions": {
    "Communication": 82,
    "Discovery Skills": 70,
    "Business Acumen": 85,
    "Relationship Building": 74,
    "Executive Presence": 80,
    "Problem Solving": 76,
    "Influence & Persuasion": 72,
    "Action Orientation & Next Steps": 85
  },
  "report": {
    "top_strengths": [
      "Immediate bottom-line framing aligned with executive communication expectations.",
      "Effective quantitative justification of operational cost reductions.",
      "Clear articulation of risk mitigation and governance controls.",
      "Composed delivery under challenging financial pushback.",
      "Decisive call to action outlining steering committee next steps."
    ],
    "area_of_improvements": [
      "Address CapEx versus OpEx trade-offs earlier in the discussion.",
      "Incorporate deeper discovery into ongoing audit dependencies.",
      "Clarify transition-phase engineering allocation requirements.",
      "State explicit cash-flow payback milestones.",
      "Anticipate competitor benchmark pricing challenges."
    ],
    "actionable_insights": [
      "Lead briefings with a 30-second financial impact summary.",
      "Pre-empt hurdle-rate objections with a dedicated ROI slide.",
      "Ask a diagnostic question before presenting phased timelines.",
      "Frame technology upgrades in terms of risk reduction.",
      "Lock down immediate next steps before concluding."
    ]
  }
}
```

---

## Logging & Telemetry

### Structured File Logging

Configured via `shared_logger.py`:
- **Standard Application Log**: `logs/salescoach.log` (rotating, 10 MB maximum, 5 backups).
- **Error Log**: `logs/errors.log` (captures `ERROR` and `CRITICAL` records, 10 MB maximum, 5 backups).
- **Console Log**: Standard output with timestamp, log level, module name, and message.

### Telemetry & Connectivity Metrics

The platform continuously aggregates streaming performance metrics accessible via `GET /api/connectivity/stats`:
- **EWMA First-Audio Latency**: Tracks time elapsed from client turn completion (`type: end`) to the first streaming audio chunk from Bedrock Nova Sonic.
- **Audio Gap Tracking**: Tracks average and maximum chunk intervals for both browser-to-backend input and Nova-to-backend output to identify jitter or network drops.
- **Throughput Monitoring**: Rolling input and output kilobits-per-second (kbps) across sliding windows.
- **Automated Health Diagnostics**: Emits heuristic warnings when latency exceeds 1200 ms or chunk gaps exceed 450 ms.

---

## Troubleshooting

### 1. API Connection Failures
- Verify Uvicorn is bound and listening on port `2089`:
  ```bash
  curl http://127.0.0.1:2089/health
  ```
- Ensure local host firewalls or VPN proxies permit traffic to port `2089`.

### 2. Authentication Rejections (401 Unauthorized)
- Confirm the login email address is registered in `api/allowed_users.json`.
- Tokens expire based on `ACCESS_TOKEN_EXPIRE_MINUTES`. Ensure clients refresh access tokens using `POST /auth/refresh` before expiration.

### 3. Bedrock Nova Sonic Streaming Failures
- Ensure AWS credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN`) are configured and have `bedrock:InvokeModelWithResponseStream` permissions in `us-east-1`.
- Verify model access for `amazon.nova-2-sonic-v1:0` has been enabled within the AWS Bedrock console.
- Confirm browser microphone permissions are enabled for local audio capture.

### 4. LLM Evaluation & Report Errors (502 Bad Gateway)
- Verify `OLLAMA_BASE_URL` is reachable from the server environment.
- Confirm `LLM_MODEL` corresponds to a deployed, available model.
- If using self-signed internal certificates, set `LLM_VERIFY_SSL=false` in `.env`.

### 5. SQLite File Locks
- The platform uses Write-Ahead Logging (WAL). Verify the server process has read/write filesystem permissions on `api/practice_sessions.db`, `api/practice_sessions.db-wal`, and `api/practice_sessions.db-shm`.
