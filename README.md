# Nova AI (FastAPI + React + Vertex AI)

Nova is a cloud-native AI assistant for GCP, deployed on GKE.

## Canonical Runtime

- Backend: `backend/main.py` (FastAPI)
- Frontend: `frontend/` (React + TypeScript)
- AI Provider: Vertex AI Gemini
- Container entrypoint: `backend.main:app` via Gunicorn/Uvicorn

## Quick Start (Local)

1. Create a virtual environment and install backend dependencies:

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r backend/requirements.txt
```

2. Install frontend dependencies:

```powershell
cd frontend
npm install
cd ..
```

3. Create `.env` from `.env.example` and set at least:

```env
SECRET_KEY=replace-with-long-random-value
GOOGLE_CLOUD_PROJECT=your-project-id
VERTEX_LOCATION=us-central1
VERTEX_DEFAULT_MODEL=gemini-2.0-flash
DATABASE_URL=sqlite:///nova_fastapi.db
```

4. Run backend:

```powershell
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

5. Run frontend:

```powershell
cd frontend
npm run dev
```

Open the Vite URL (usually `http://localhost:5173`).

## OAuth Redirects

- Google callback: `/auth/google/callback`
- GitHub callback: `/auth/github/callback`

Local examples:

- `http://localhost:8000/auth/google/callback`
- `http://localhost:8000/auth/github/callback`

Cloud examples:

- `https://<your-domain>/auth/google/callback`
- `https://<your-domain>/auth/github/callback`

## Main API Endpoints

- Auth: `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/me`, `/auth/change-password`
- Chat/config: `/api/chat`, `/api/models`, `/api/config`
- Settings: `/api/settings`
- Conversations: `/api/conversations` and `/api/conversations/{id}`
- Security/data: `/api/security/events`, `/api/data/export`, `/api/account`

## Deployment Notes

- Docker build is multi-stage (`frontend` build + Python runtime).
- GKE manifests are in `infra/k8s/`.
- Preferred provisioning path is `scripts/setup-gke.ps1` + Terraform under `infra/`.

## Legacy Scripts

- `scripts/deploy.ps1` and `scripts/setup.ps1` are retained as Cloud Run helpers and are not the canonical GKE path.
