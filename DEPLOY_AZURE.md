# Deploying KCoach to Azure

Resources (resource group shown in the portal):

| Resource | Used for |
|---|---|
| `slc-webapp-plan` | App Service plan for both apps |
| `slcciufrntapp` | Frontend (React build, served by Node) |
| `slcciufrntapp/slcuicibackendapp` | Backend (FastAPI, Python 3.12). It is a *slot* of the frontend app; see the caution below |
| `slcciupstgredb` | PostgreSQL flexible server (sessions, reports, transcripts, telemetry) |
| `slcuatcifndry` (+ project) | Foundry: text LLM, realtime voice model, transcription model, OCR |
| `slcciustgacc` | Storage account (not used by the app yet) |

> **Caution: backend as a slot.** Slots are meant for staging copies of one app. If anyone presses **Swap** on
> `slcciufrntapp`, the frontend and backend trade places and the site breaks. A separate App Service on the same
> plan costs nothing extra. Everything below works either way.

Locally nothing changes: without `DATABASE_URL` the app uses the SQLite file `api/practice_sessions.db`.

---

## 1. PostgreSQL (`slcciupstgredb`)

1. **Networking:** allow the backend to connect. With public access, tick *Allow public access from any Azure
   service within Azure to this server* (or add the backend's outbound IPs). With private networking, put the
   backend app in the same VNet.
2. **Create a database**, e.g. `kcoach` (Databases → Add), and use a password login (admin user or a dedicated
   user with rights on that database). Entra-ID-only authentication is not supported by the app.
3. **Connection string** for the backend setting `DATABASE_URL`:
   ```
   postgresql://<user>:<url-encoded-password>@slcciupstgredb.postgres.database.azure.com:5432/kcoach?sslmode=require
   ```
   URL-encode special characters in the password (`@` → `%40`, `#` → `%23`, `/` → `%2F`).

The tables are created automatically on the backend's first start. Existing local SQLite data is not copied.

## 2. Foundry (`slcuatcifndry`)

Note the **deployment names** of your models (Foundry → Models + endpoints) and the resource **key** and
**endpoint** (`https://slcuatcifndry.openai.azure.com/`; the `cognitiveservices.azure.com` form also works).

You need:
- a **chat model** (e.g. `gpt-4o-mini` / `gpt-4.1-mini`): reports, hints, translation, document summaries
- a **realtime model** (`gpt-realtime` or `gpt-4o-mini-realtime`): the voice conversation
- a **transcription model** (`gpt-4o-mini-transcribe`): what the user said, for transcripts and evaluation

## 3. Backend app (`slcuicibackendapp`)

**Configuration → General settings**
- Stack: **Python 3.12**
- Startup command:
  ```
  python -m uvicorn api.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips="*"
  ```
  One process only (no `--workers`): live voice sessions are held in memory.
- **Web sockets: On**, **Always on: On**, HTTPS only: On
- Health check path: `/health`
- Scale out: **1 instance**

**Environment variables** (these replace `.env`; do not upload `.env`)

| Name | Value |
|---|---|
| `ENVIRONMENT` | `production` |
| `JWT_SECRET_KEY` | a random string of 48+ characters |
| `CORS_ALLOWED_ORIGINS` | `https://slcciufrntapp.azurewebsites.net` (the frontend URL shown in the portal) |
| `DATABASE_URL` | the connection string from step 1 |
| `ALLOWED_USERS_PATH` | `/home/data/allowed_users.json` |
| `USER_PHOTOS_DIR` | `/home/data/user_photos` |
| `LOG_DIR` | `/home/data/logs` |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` |
| `OLLAMA_BASE_URL` | `https://slcuatcifndry.openai.azure.com/openai/v1/` |
| `OLLAMA_API_KEY` | Foundry key |
| `LLM_MODEL` | chat model deployment name |
| `VOICE_PROVIDER` | `azure_realtime` (Azure for every language) or `devnagri_cascaded` (Devnagri for English/Hindi; French, German, Spanish, Italian and Auto still go to Azure) |
| `AZURE_OPENAI_REALTIME_ENDPOINT` | `https://slcuatcifndry.openai.azure.com` |
| `AZURE_OPENAI_REALTIME_API_KEY` | Foundry key |
| `AZURE_OPENAI_REALTIME_DEPLOYMENT` | realtime model deployment name |
| `AZURE_OPENAI_REALTIME_TRANSCRIBE_DEPLOYMENT` | transcription model deployment name |
| `AZURE_DOC_INTELLIGENCE_ENDPOINT` / `_KEY` | optional, OCR for scanned PDFs (the Foundry endpoint and key usually work) |
| `BLACKBIRD_API_KEY`, `DEVNAGRI_TTS_API_KEY` | only with `VOICE_PROVIDER=devnagri_cascaded` |

`/home` is the App Service's persistent storage: the user list, photos and logs there survive redeploys and
restarts. On first start the bundled `api/allowed_users.json` is copied to `ALLOWED_USERS_PATH`; after that,
manage users from the Admin panel (redeploying does not overwrite them).

**Deploy the code:** zip the project root **without** `frontend/`, `venv/`, `node_modules/`, `.env`,
`avatar_drafts/`, `logs/`, `api/practice_sessions.db`, `api/user_photos/` and `.claude/`, then deploy it
(VS Code Azure extension, `az webapp deploy --type zip --slot slcuicibackendapp ...`, or Deployment Center).
Azure installs `requirements.txt` during the deployment.

**Check:** `https://<backend-url>/health` should show `"status": "healthy"` and `"backend": "postgresql"`.

## 4. Frontend app (`slcciufrntapp`)

1. Build locally with the backend URL baked in (copy the exact URL from the backend's Overview page):
   ```bash
   cd frontend
   npm install
   REACT_APP_API_BASE_URL=https://<backend-url> npm run build
   ```
2. **Configuration → General settings:** stack **Node 20 LTS**, startup command:
   ```
   pm2 serve /home/site/wwwroot --no-daemon --spa
   ```
   (`--spa` makes page refreshes on routes like `/dashboard` work.)
3. Deploy the **contents** of `frontend/build/` (zip the files inside `build`, not the folder) to `slcciufrntapp`.
   Set `SCM_DO_BUILD_DURING_DEPLOYMENT=false` on this app; the build is already done.

## 5. Final checks

- [ ] Open the frontend URL over **https** (the microphone only works on https)
- [ ] Log in with an email from the user list; Admin → Users shows everyone
- [ ] Start a session: the counterpart greets you and the avatar talks with the voice
- [ ] Stop & Evaluate: the report opens; Practice History shows the session and its transcript
- [ ] Backend `/health` shows `"backend": "postgresql"`
- [ ] Restart the backend: sessions and users are still there

## Troubleshooting

| Symptom | Cause |
|---|---|
| Browser console: `Mixed Content ... ws://` | startup command is missing `--proxy-headers --forwarded-allow-ips="*"` |
| Login fails with a CORS error | `CORS_ALLOWED_ORIGINS` does not match the frontend URL exactly (scheme, no trailing slash) |
| Voice never connects | Web sockets is Off on the backend |
| `/health` unhealthy, "connection refused/timeout" | PostgreSQL networking (step 1.1) or `sslmode=require` missing |
| Page refresh shows 404 | frontend startup command is missing `--spa` |
| Everyone was logged out / users vanished | `ALLOWED_USERS_PATH` is not under `/home/data` |
