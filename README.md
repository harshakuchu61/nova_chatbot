# Nova AI

A production-grade AI chat assistant built on Flask and the OpenAI Chat Completions API. Deployed to GCP Cloud Run with a PostgreSQL backend, full user authentication, persistent conversation history, and a CI/CD pipeline that ships on every push to `main`.

![CI/CD](https://github.com/harshakuchu61/nova_chatbot/actions/workflows/ci-cd.yml/badge.svg)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?style=flat-square&logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask-3.1-000000?style=flat-square&logo=flask)
![Cloud Run](https://img.shields.io/badge/Cloud_Run-GCP-4285F4?style=flat-square&logo=googlecloud&logoColor=white)

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Repository Structure](#repository-structure)
- [Local Development](#local-development)
- [Environment Variables](#environment-variables)
- [Database](#database)
- [Authentication Setup](#authentication-setup)
- [Deployment](#deployment)
- [CI/CD Pipeline](#cicd-pipeline)
- [API Reference](#api-reference)
- [Security](#security)
- [Troubleshooting](#troubleshooting)

---

## Overview

Nova runs as a single Cloud Run service that serves both the frontend (static HTML/CSS/JS) and the REST API from the same Flask process. There is no separate frontend build step — everything is vanilla HTML, CSS, and JavaScript served directly by Flask's static file handler.

All secrets live in GCP Secret Manager. The container image holds no credentials. The database is Cloud SQL (PostgreSQL 15) connected via the Cloud SQL Python Connector, which means no sidecar proxy is required.

---

## Features

**Authentication**
- Email/password registration and login
- Google OAuth (OpenID Connect)
- GitHub OAuth
- Rate limiting on auth endpoints (5 registrations/hour, 10 logins per 15 minutes)
- Login event audit log (IP, user agent, timestamp, success/fail) stored per user

**Chat**
- Streaming responses via Server-Sent Events — text appears as it generates
- Persistent conversation history stored in PostgreSQL, loaded on login
- Conversations can be renamed and deleted individually or all at once
- Configurable system prompt per user
- Configurable number of history turns sent to the model (1–100)
- File attachments: images (passed to vision-capable models), PDFs (text extracted), plain text and code files
- Voice input via the browser Web Speech API
- Read aloud (Text-to-Speech) with a stop button
- Markdown rendering: code blocks with syntax highlighting, tables, bold, italic, ordered and unordered lists

**Model Selection**
- Curated list of current OpenAI production models with friendly labels (GPT-4o, GPT-4o mini, o1, o3, o4-mini, etc.)
- Any new models released by OpenAI that are chat-capable and not dated snapshots are automatically discovered and shown at the bottom of the list
- Users can supply their own OpenAI API key in Settings; the server-level key is the fallback

**Settings Panel**
- Theme: Light / Dark (applies instantly, auto-saved)
- Font size: Small / Medium / Large (scales the entire UI, applies instantly)
- Default model and max history turns
- Streaming toggle
- System prompt override
- OpenAI API key: store, test, and remove (encrypted with AES-256-GCM at rest)
- Display name change
- Password change (email accounts only — not shown for OAuth users)
- Data export (downloads all conversations as a JSON file)
- Delete all conversations
- Permanently delete account

**Infrastructure**
- Terraform scripts for full GCP environment provisioning and teardown
- GitHub Actions CI/CD: lint → security audit → build → push → deploy
- Keyless GCP auth from GitHub Actions via Workload Identity Federation

---

## Architecture

```
Browser
  │
  │  HTTPS
  ▼
Cloud Run (nova-chatbot)
  ├── Flask (Gunicorn · 1 worker · 8 threads)
  │     ├── /                  → serves web/index.html
  │     ├── /login.html        → serves web/login.html
  │     ├── /auth/*            → email/password + OAuth callbacks
  │     ├── /api/chat          → OpenAI streaming proxy
  │     ├── /api/conversations → CRUD, stored in Cloud SQL
  │     ├── /api/settings      → per-user preferences
  │     └── /api/models        → curated model list (fetched live from OpenAI)
  │
  ├── Cloud SQL Python Connector ──► Cloud SQL (PostgreSQL 15 · nova-db)
  └── Secret Manager            ──► SECRET_KEY, DATABASE_URL, OPENAI_API_KEY,
                                    GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET
```

The container does not use the Cloud SQL Auth Proxy sidecar. The Cloud SQL Python Connector opens a direct mTLS connection from within the process, which avoids the Unix socket dependency entirely.

---

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Language | Python | 3.12 |
| Web framework | Flask | 3.1.1 |
| WSGI server | Gunicorn | 23.0.0 |
| ORM | SQLAlchemy (via Flask-SQLAlchemy) | 2.0.40 |
| Auth sessions | Flask-Login | 0.6.3 |
| OAuth | Flask-Dance (Google + GitHub) | 7.1.0 |
| Password hashing | Flask-Bcrypt (bcrypt) | 1.0.1 |
| Rate limiting | Flask-Limiter | 3.5.0 |
| API key encryption | cryptography (AES-256-GCM) | 44.0.2 |
| AI provider | OpenAI Python SDK | 1.75.0 |
| PDF parsing | pypdf | 5.1.0 |
| DB driver (prod) | Cloud SQL Python Connector + pg8000 | 1.16.0 / 1.31.2 |
| DB driver (local) | psycopg2-binary / SQLite | 2.9.10 |
| Frontend | Vanilla HTML, CSS, JavaScript | — |
| Container | Docker (python:3.12-slim) | — |
| Hosting | GCP Cloud Run | us-central1 |
| Database | GCP Cloud SQL (PostgreSQL 15) | db-f1-micro |
| Secrets | GCP Secret Manager | — |
| Container registry | GCP Artifact Registry | nova-repo |
| IaC | Terraform | — |
| CI/CD | GitHub Actions | — |

---

## Repository Structure

```
nova_chatbot/
│
├── .github/
│   └── workflows/
│       └── ci-cd.yml           # GitHub Actions pipeline (lint → build → deploy)
│
├── backend/                    # Python Flask application (package)
│   ├── __init__.py
│   ├── app.py                  # Application factory, all routes, OpenAI integration
│   ├── auth.py                 # Auth blueprint: email/password + Google/GitHub OAuth
│   ├── models.py               # SQLAlchemy models (User, UserSettings, Conversation, Message, LoginEvent)
│   ├── extensions.py           # Flask extension singletons (db, bcrypt, login_manager, limiter)
│   ├── crypto.py               # AES-256-GCM encryption/decryption for stored API keys
│   └── requirements.txt        # Python dependencies with pinned versions
│
├── web/                        # Frontend — served as Flask static files
│   ├── index.html              # Main chat interface (requires login)
│   ├── login.html              # Login and registration page
│   ├── css/
│   │   ├── style.css           # Chat UI styles (theme, layout, components)
│   │   └── login.css           # Login page styles
│   └── js/
│       └── app.js              # All client-side logic (chat, settings, auth checks)
│
├── infra/                      # Terraform — full GCP infrastructure
│   ├── main.tf                 # Provider config and shared locals
│   ├── variables.tf            # Input variables
│   ├── apis.tf                 # GCP API enablement
│   ├── registry.tf             # Artifact Registry repository
│   ├── database.tf             # Cloud SQL instance, database, user
│   ├── cloudrun.tf             # Cloud Run service definition
│   ├── secrets.tf              # Secret Manager secrets
│   ├── iam.tf                  # IAM bindings for Cloud Run SA
│   ├── outputs.tf              # Output values (service URL, DB connection)
│   └── terraform.tfvars.example
│
├── scripts/                    # PowerShell operational scripts (Windows)
│   ├── config.ps1              # Shared GCP config — edit this before running anything
│   ├── setup.ps1               # One-time GCP setup: APIs, Cloud SQL, Secret Manager
│   ├── setup-gha.ps1           # Workload Identity Federation setup for GitHub Actions
│   └── deploy.ps1              # Manual build + push + deploy (bypasses CI/CD)
│
├── .env.example                # Environment variable reference for local development
├── .dockerignore               # Excludes secrets, caches, and scripts from the image
├── .gitignore
├── Dockerfile                  # Production image (python:3.12-slim, Gunicorn)
└── README.md
```

---

## Local Development

### Prerequisites

- Python 3.12
- An OpenAI API key (`sk-...`)
- Git

No Docker or GCP account is required to run locally. SQLite is used by default.

### 1. Clone and set up a virtual environment

```bash
git clone https://github.com/harshakuchu61/nova_chatbot.git
cd nova_chatbot

python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate
```

### 2. Install dependencies

```bash
pip install -r backend/requirements.txt
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in at minimum:

```
SECRET_KEY=<any random 32+ char string>
OPENAI_API_KEY=sk-...
DATABASE_URL=sqlite:///nova.db
```

OAuth credentials are optional for local development. If left empty, only email/password login is shown.

### 4. Start the development server

```bash
python -m backend.app
```

The app starts on [http://localhost:5000](http://localhost:5000). Flask's built-in server is used — do not use this in production.

> **Note:** For Google/GitHub OAuth to work locally, set `OAUTHLIB_INSECURE_TRANSPORT=1` in your `.env` and register `http://localhost:5000/google/authorized` (or `/github/authorized`) as a valid redirect URI in the respective developer console.

---

## Environment Variables

All variables are loaded from `.env` (local) or GCP Secret Manager (production). The app reads them at startup. Changing a value requires a container restart (Cloud Run handles this automatically on redeploy).

| Variable | Required | Description |
|---|---|---|
| `SECRET_KEY` | Yes | Flask session signing key. Must be a fixed random string in production — if unset, a random one is generated per container start, which breaks sessions on restart. |
| `OPENAI_API_KEY` | Yes | Server-level OpenAI key. All users share this unless they supply their own in Settings. |
| `OPENAI_MODEL` | No | Default model ID if the user hasn't set one. Defaults to `gpt-4o-mini`. |
| `DATABASE_URL` | Yes (prod) | Full SQLAlchemy connection string. SQLite is used if unset. See examples in `.env.example`. |
| `GOOGLE_CLIENT_ID` | No | Google OAuth 2.0 client ID. Both Google and GitHub buttons are hidden if not set. |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth 2.0 client secret. |
| `GITHUB_CLIENT_ID` | No | GitHub OAuth App client ID. |
| `GITHUB_CLIENT_SECRET` | No | GitHub OAuth App client secret. |
| `OAUTHLIB_INSECURE_TRANSPORT` | Local only | Set to `1` to allow OAuth over HTTP. Never set in production. |

### How secrets are stored in production

The Cloud Run service is configured to pull each secret directly from Secret Manager at startup via `--set-secrets`. The container has no `.env` file and no hardcoded credentials. The Cloud Run service account is granted `roles/secretmanager.secretAccessor` on each individual secret.

---

## Database

### Schema

Five tables are created automatically on first startup via `db.create_all()`:

| Table | Description |
|---|---|
| `users` | Core user record: email, display name, avatar, provider (`email`, `google`, `github`), bcrypt password hash |
| `user_settings` | Per-user preferences: theme, font size, default model, system prompt, streaming toggle, encrypted API key |
| `conversations` | A conversation thread: title, timestamps, linked to a user |
| `messages` | Individual messages: role (`user` / `assistant`), text content, timestamp, linked to a conversation |
| `login_events` | Audit trail: IP address, user agent, timestamp, success flag |

The `messages.conversation_id` foreign key has `ON DELETE CASCADE`, applied automatically on startup if not already present. This means deleting a conversation removes all its messages without a separate query.

### Local vs production

| | Local | Production |
|---|---|---|
| Engine | SQLite (file: `nova.db`) | PostgreSQL 15 (Cloud SQL) |
| Driver | Built-in | Cloud SQL Python Connector + pg8000 |
| Location | Project root | `nova-db` instance, `us-central1-b` |
| Connection | File path | mTLS via connector (no proxy sidecar) |

---

## Authentication Setup

### Email / Password

Works out of the box. Password is hashed with bcrypt (cost factor 12). Minimum password length is 8 characters. Registration is rate-limited to 5 attempts per hour per IP, login to 10 per 15 minutes.

### Google OAuth

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services → Credentials**
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Add authorised redirect URIs:
   - `https://<your-cloud-run-url>/google/authorized`
   - `http://localhost:5000/google/authorized` (for local dev)
4. Add your email to the OAuth consent screen test users list (while the app is in testing mode)
5. Store the client ID and secret in Secret Manager:
   ```powershell
   .\scripts\setup.ps1  # handles this interactively
   ```

### GitHub OAuth

1. Go to [github.com/settings/developers](https://github.com/settings/developers) → **OAuth Apps → New OAuth App**
2. Set **Authorization callback URL** to `https://<your-cloud-run-url>/github/authorized`
   - GitHub OAuth Apps only support a single callback URL. Use the primary Cloud Run URL.
3. Store the client ID and secret via `setup.ps1` or directly in Secret Manager

> The `fqs4x2kmoa` and `787410280026` URLs are both valid aliases for the same Cloud Run service. For GitHub OAuth, register only the canonical `787410280026` URL.

---

## Deployment

### Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed and authenticated (`gcloud auth login`)
- Docker (for local builds only — Cloud Build handles production builds)
- PowerShell (scripts are Windows PowerShell)

### First-time GCP setup

Edit `scripts/config.ps1` and set your `$PROJECT_ID`. Then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

This script:
- Enables required GCP APIs (Cloud Run, Cloud SQL Admin, Secret Manager, Cloud Build, Artifact Registry)
- Creates the Cloud SQL instance and database (`nova-db`, PostgreSQL 15, `db-f1-micro`, `us-central1`)
- Creates Secret Manager secrets and stores an auto-generated `SECRET_KEY`
- Interactively prompts for OAuth credentials and stores them
- Grants the Cloud Run default service account the necessary IAM roles
- Triggers an initial deploy

### Manual deploy (without CI/CD)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
```

Or directly with gcloud:

```powershell
gcloud builds submit --tag "us-central1-docker.pkg.dev/<PROJECT_ID>/nova-repo/nova-app:latest" --timeout=15m .
gcloud run deploy nova-chatbot --image "us-central1-docker.pkg.dev/<PROJECT_ID>/nova-repo/nova-app:latest" --region us-central1
```

### Terraform (optional — full environment provisioning)

The `infra/` directory contains Terraform for managing the complete GCP environment. Useful for spinning up a fresh environment or tearing one down entirely to control costs.

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
# Fill in terraform.tfvars with your project ID and credentials

terraform init
terraform plan
terraform apply
```

To tear down everything:
```bash
terraform destroy
```

---

## CI/CD Pipeline

Every push to `main` runs the full pipeline. Pull requests run lint and security only (no deploy).

```
push to main
    │
    ▼
[ci] Lint & Security
    ├── flake8 backend/ (max line length 120)
    └── pip-audit -r backend/requirements.txt (CVE scan, non-blocking)
    │
    ▼
[deploy] Build & Push
    ├── Authenticates to GCP via Workload Identity Federation (no SA keys)
    ├── Builds Docker image with Artifact Registry layer cache
    └── Pushes two tags: :latest and :<git-sha>
    │
    ▼
[deploy] Deploy to Cloud Run
    └── google-github-actions/deploy-cloudrun → nova-chatbot, us-central1
```

The deploy job is gated behind the `production` GitHub Environment. Add required reviewers in `Settings → Environments → production` to require manual approval before every production deploy.

### First-time GitHub Actions setup

**Step 1** — Run the WIF provisioning script:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-gha.ps1 -GitHubOwner "your-github-username"
```

**Step 2** — The script prints three values. Add them as GitHub repository secrets under `Settings → Secrets and variables → Actions`:

| Secret | Description |
|---|---|
| `WIF_PROVIDER` | Workload Identity Federation provider resource name |
| `WIF_SERVICE_ACCOUNT` | Service account email the pipeline impersonates |
| `GCP_PROJECT_ID` | GCP project ID |

**Step 3** — Create the `production` environment in `Settings → Environments`.

**Step 4** — Push to `main`. The Actions tab shows the pipeline.

---

## API Reference

All endpoints except `/auth/register`, `/auth/login`, and the static file routes require an active session (set by login).

### Auth

| Method | Path | Description |
|---|---|---|
| `GET` | `/auth/me` | Returns current user profile and settings |
| `POST` | `/auth/register` | Create account (email/password) |
| `POST` | `/auth/login` | Log in (email/password) |
| `POST` | `/auth/logout` | End session |
| `POST` | `/auth/change-password` | Change password (email accounts only) |
| `GET` | `/google/login` | Start Google OAuth flow |
| `GET` | `/google/authorized` | Google OAuth callback |
| `GET` | `/github/login` | Start GitHub OAuth flow |
| `GET` | `/github/authorized` | GitHub OAuth callback |

### Chat

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/chat` | Send a message; returns a streaming SSE response |
| `POST` | `/api/models` | List available models (fetches live from OpenAI using the active API key) |
| `GET` | `/api/config` | Public config: which OAuth providers are enabled |

### Conversations

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/conversations` | List all conversations for the current user (max 100, ordered by last updated) |
| `GET` | `/api/conversations/<id>` | Get a single conversation with all messages |
| `PATCH` | `/api/conversations/<id>` | Rename a conversation (`{ "title": "..." }`) |
| `DELETE` | `/api/conversations/<id>` | Delete a single conversation and its messages |
| `DELETE` | `/api/conversations` | Delete all conversations for the current user |

### Settings

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/settings` | Get current user settings |
| `PATCH` | `/api/settings` | Update one or more settings fields |

Updatable fields: `theme`, `font_size`, `default_model`, `system_prompt`, `stream_responses`, `send_on_enter`, `max_history_turns`, `openai_api_key`, `display_name`.

### Account & Data

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/security/events` | Last 20 login events for the current user |
| `GET` | `/api/data/export` | Download all conversations as a JSON file |
| `DELETE` | `/api/account` | Permanently delete account and all associated data |

---

## Security

**Passwords** are hashed with bcrypt. Plain-text passwords are never stored or logged.

**OpenAI API keys** stored by users are encrypted with AES-256-GCM before writing to the database. The encryption key is derived from the application's `SECRET_KEY`. The raw key is never stored.

**Sessions** use Flask's signed cookie mechanism. The signature key is `SECRET_KEY`, fetched from Secret Manager. If `SECRET_KEY` is not set, a random one is generated per process — this breaks sessions across container restarts and is flagged with a warning log.

**OAuth tokens** from Google and GitHub are not persisted. The token is used once to fetch user profile info and then discarded. Only the user row in the database is kept.

**Rate limiting** is applied at the auth layer: registration is capped at 5 requests per hour per IP, login at 10 per 15 minutes. This is handled by Flask-Limiter using in-memory storage (resets on container restart — acceptable for Cloud Run's single-instance model).

**Secrets in production** are injected by Cloud Run from Secret Manager at container startup. The image itself contains no credentials. The Cloud Run service account is granted `secretAccessor` on each secret individually, not at the project level.

**HTTPS** is enforced by Cloud Run. `ProxyFix` middleware is configured to trust the `X-Forwarded-Proto` header so Flask correctly identifies requests as HTTPS, which is required for OAuth redirects and secure cookie flags.

---

## Troubleshooting

**Login works but I'm redirected back to the login page immediately**
The frontend API calls are failing. Open browser DevTools → Network and check that calls to `/auth/me` return 200 with a JSON body. If they return 401, the session cookie is not being set — check that `SECRET_KEY` is a fixed value (not randomly generated per restart).

**Google OAuth — "invalid_client"**
The `GOOGLE_CLIENT_ID` in Secret Manager does not match any active OAuth 2.0 client in your Google Cloud project. Re-create the client, update the secret, and redeploy.

**GitHub OAuth — callback URL mismatch**
GitHub OAuth Apps only support one callback URL. Make sure the "Authorization callback URL" in the GitHub app settings matches exactly what the app sends: `https://<your-cloud-run-url>/github/authorized`.

**Database connection error on startup**
The Cloud SQL connector needs `roles/cloudsql.client` on the service account and the instance connection name to be correct in `DATABASE_URL`. Check the startup logs in Cloud Run for `[DB]` prefixed lines.

**"No chat-capable models returned" in the model selector**
The OpenAI API key does not have access to any models in the curated list. Verify the key is valid and active. Users can supply their own key in Settings → API Keys if the server-level key is restricted.

**Font size / theme not applying**
Clear the browser cache with `Ctrl + Shift + R` (hard reload). Settings are applied on load using the saved preference from the server.

**CI/CD pipeline fails with "workload_identity_provider must be specified"**
The GitHub secret `WIF_PROVIDER` is not set or is empty. Re-run `setup-gha.ps1` and add the printed value as a repository secret.

---

## License

MIT
