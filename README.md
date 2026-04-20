# Nova — AI Chatbot

A personal AI assistant with authentication, persistent chat history, and a settings panel. Built with Python Flask and the OpenAI API, deployed to GCP Cloud Run.

![CI/CD](https://github.com/harshakuchu61/nova_chatbot/actions/workflows/ci-cd.yml/badge.svg)
![Powered by OpenAI](https://img.shields.io/badge/Powered_by-OpenAI-412991?style=flat-square)

## Features

- **Authentication** — Google OAuth, GitHub OAuth, or email/password sign-in
- **Persistent Chat History** — Conversations saved to PostgreSQL per user
- **Settings Panel** — Theme, AI model, system prompt, encrypted API key, password change, data export
- **Streaming Responses** — Real-time typing effect via SSE
- **File Attachments** — Images (vision), PDFs, and text/code files
- **Voice Input** — Browser speech recognition
- **Markdown Rendering** — Code blocks, tables, bold, italic, lists
- **Responsive UI** — Works on desktop and mobile

## Project Structure

```
nova_chatbot/
├── .github/
│   └── workflows/
│       └── ci-cd.yml           # GitHub Actions CI/CD pipeline
├── server/
│   ├── app.py                  # Flask app — routes, auth, OpenAI
│   ├── models.py               # SQLAlchemy models (User, Conversation …)
│   ├── auth.py                 # Auth blueprint (email + OAuth)
│   ├── extensions.py           # Flask extension instances
│   ├── crypto.py               # AES-256-GCM API key encryption
│   ├── requirements.txt        # Python dependencies
│   └── .env.example            # Environment variable reference
├── static/
│   ├── index.html              # Chat interface
│   ├── login.html              # Login / register page
│   ├── css/style.css           # Main stylesheet
│   ├── css/login.css           # Login page styles
│   └── js/app.js               # Client-side logic
├── scripts/
│   ├── config.ps1              # GCP project config (edit this first)
│   ├── setup.ps1               # One-time GCP infrastructure setup
│   ├── setup-gha.ps1           # GitHub Actions × GCP auth setup (WIF)
│   └── deploy.ps1              # Manual deploy script
├── Dockerfile
└── .env.example
```

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, Vanilla JS |
| Backend | Python 3.12, Flask |
| Database | PostgreSQL (Cloud SQL) / SQLite (local) |
| AI | OpenAI Chat Completions |
| Auth | Flask-Login, Flask-Dance (Google/GitHub OAuth) |
| Hosting | GCP Cloud Run |
| CI/CD | **GitHub Actions** |
| Container Registry | GCP Artifact Registry |
| Secrets | GCP Secret Manager |

---

## Local Development

### 1. Copy environment file

```bash
cp server/.env.example server/.env
# Fill in OPENAI_API_KEY and optional OAuth credentials
```

### 2. Install dependencies

```bash
pip install -r server/requirements.txt
```

### 3. Run

```bash
cd server && python app.py
```

Open [http://localhost:5000](http://localhost:5000).

---

## CI/CD — GitHub Actions

Every push to `main` automatically runs:

1. **Lint & Security** (`flake8` + `pip-audit`) — runs on all branches and PRs
2. **Build** — Docker image built with layer caching via Artifact Registry
3. **Push** — image pushed to GCP Artifact Registry
4. **Deploy** — Cloud Run updated to the new image

Authentication uses **Workload Identity Federation** (keyless — no SA JSON keys stored anywhere).

### First-time GitHub Actions setup

**Step 1** — Edit `scripts/config.ps1` and set your `$PROJECT_ID`.

**Step 2** — Run the WIF setup script (one time only):

```powershell
.\scripts\setup-gha.ps1 -GitHubOwner "your-github-username"
```

**Step 3** — The script will print 3 values. Add them as **GitHub Secrets**:
`Settings → Secrets and variables → Actions → New secret`

| Secret name | Value |
|---|---|
| `WIF_PROVIDER` | printed by setup script |
| `WIF_SERVICE_ACCOUNT` | printed by setup script |
| `GCP_PROJECT_ID` | your GCP project ID |

**Step 4** — Create a GitHub **Environment** named `production`:
`Settings → Environments → New environment`
Optionally add required reviewers for a manual approval gate before every deploy.

**Step 5** — Push to `main`. The Actions tab shows the pipeline running.

---

## Manual Deploy

To deploy without GitHub Actions:

```powershell
.\scripts\deploy.ps1
```

---

## License

MIT
