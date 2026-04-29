"""
FastAPI + Vertex AI (Gemini) backend for Nova.

New stack:
- FastAPI API server
- Vertex AI Gemini responses (streaming SSE)
- React frontend (built assets served when present)
"""

from __future__ import annotations

import base64
import io
import json
import os
import uuid
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest, urlopen
from sqlalchemy import (
    create_engine,
    String,
    Text,
    DateTime,
    Integer,
    Boolean,
    ForeignKey,
    select,
    desc,
)
from sqlalchemy.orm import declarative_base, Mapped, mapped_column, sessionmaker

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse, RedirectResponse
from pydantic import BaseModel, Field
from fastapi import Request
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from werkzeug.security import generate_password_hash, check_password_hash

try:
    # Keep ADK in the stack as requested (used for agent definition metadata).
    from google.adk.agents import LlmAgent
except Exception:  # pragma: no cover - optional import safety
    LlmAgent = None

from google import genai
from google.genai import types


load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv(Path(__file__).resolve().parent / ".env")

PROJECT_ID = (os.getenv("GCP_PROJECT") or os.getenv("GOOGLE_CLOUD_PROJECT") or "").strip()
VERTEX_LOCATION = (os.getenv("VERTEX_LOCATION") or "global").strip()
GEMINI_API_KEY = (os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY") or "").strip()
DEFAULT_MODEL = (os.getenv("VERTEX_DEFAULT_MODEL") or "gemini-2.5-flash").strip()
ALLOWED_MODELS = [
    {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash — fast, economical"},
    {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro — most capable"},
]
ALLOWED_MODEL_IDS = {m["id"] for m in ALLOWED_MODELS}
LEGACY_MODEL_MAP = {
    "gemini-2.0-flash": "gemini-2.5-flash",
    "gemini-1.5-flash": "gemini-2.5-flash",
    "gemini-1.5-pro": "gemini-2.5-pro",
    "gemini-1.5-flash-002": "gemini-2.5-flash",
    "gemini-1.5-pro-002": "gemini-2.5-pro",
}
if DEFAULT_MODEL in LEGACY_MODEL_MAP:
    DEFAULT_MODEL = LEGACY_MODEL_MAP[DEFAULT_MODEL]
if DEFAULT_MODEL not in ALLOWED_MODEL_IDS:
    DEFAULT_MODEL = "gemini-2.5-flash"
MAX_ATTACHMENTS = 6
MAX_TEXT_ATTACHMENT_CHARS = 200_000
MAX_PDF_BYTES = 16 * 1024 * 1024

DEFAULT_SETTINGS = {
    "theme": "light",
    "font_size": "medium",
    "send_on_enter": True,
    "default_model": DEFAULT_MODEL,
    "stream_responses": True,
    "max_history_turns": 20,
    "system_prompt": "",
}
DEFAULT_USER_ID = "default"
DEFAULT_USER_EMAIL = (os.getenv("DEMO_USER_EMAIL") or "user@nova.local").strip()
DEFAULT_USER_NAME = (os.getenv("DEMO_USER_NAME") or "Nova User").strip()
DEFAULT_USER_PROVIDER = "email"
SECRET_KEY = (os.getenv("SECRET_KEY") or "dev-secret-change-me").strip()
SESSION_COOKIE_NAME = "nova_session"
OAUTH_STATE_COOKIE = "nova_oauth_state"
SESSION_MAX_AGE = 60 * 60 * 24 * 14  # 14 days
session_serializer = URLSafeTimedSerializer(SECRET_KEY, salt="nova-auth")
oauth_state_serializer = URLSafeTimedSerializer(SECRET_KEY, salt="nova-oauth-state")
DATABASE_URL = (os.getenv("DATABASE_URL") or "sqlite:///nova_fastapi.db").strip()
GOOGLE_CLIENT_ID = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
GOOGLE_CLIENT_SECRET = (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()
GITHUB_CLIENT_ID = (os.getenv("GITHUB_CLIENT_ID") or "").strip()
GITHUB_CLIENT_SECRET = (os.getenv("GITHUB_CLIENT_SECRET") or "").strip()
if DATABASE_URL.startswith("sqlite:///"):
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


class SettingsRow(Base):
    __tablename__ = "fastapi_settings"
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    theme: Mapped[str] = mapped_column(String(20), default="light", nullable=False)
    font_size: Mapped[str] = mapped_column(String(20), default="medium", nullable=False)
    send_on_enter: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    default_model: Mapped[str] = mapped_column(String(100), default=DEFAULT_MODEL, nullable=False)
    stream_responses: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    max_history_turns: Mapped[int] = mapped_column(Integer, default=20, nullable=False)
    system_prompt: Mapped[str] = mapped_column(Text, default="", nullable=False)


class UserRow(Base):
    __tablename__ = "fastapi_users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(200), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    provider: Mapped[str] = mapped_column(String(20), default="email")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ConversationRow(Base):
    __tablename__ = "fastapi_conversations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), index=True, default="default")
    title: Mapped[str] = mapped_column(String(200), default="New conversation")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class MessageRow(Base):
    __tablename__ = "fastapi_messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    conversation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("fastapi_conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class LoginEventRow(Base):
    __tablename__ = "fastapi_login_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True, default=DEFAULT_USER_ID)
    ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    success: Mapped[bool] = mapped_column(Boolean, default=True)


@dataclass(frozen=True)
class CurrentUser:
    id: str
    email: str
    display_name: str
    provider: str


Base.metadata.create_all(bind=engine)

app = FastAPI(title="Nova API (FastAPI + Vertex AI)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Optional ADK agent object (kept for migration and future tool expansion).
NOVA_AGENT = (
    LlmAgent(
        name="nova",
        model=f"vertexai/{DEFAULT_MODEL}",
        instruction=(
            "You are Nova, a friendly and knowledgeable personal AI assistant. "
            "Be concise, accurate, and helpful."
        ),
    )
    if LlmAgent
    else None
)


class Attachment(BaseModel):
    kind: str
    name: str = "file"
    mime: str | None = None
    text: str | None = None
    data: str | None = None


class ChatRequest(BaseModel):
    message: str = ""
    model: str | None = None
    attachments: list[Attachment] = Field(default_factory=list)
    conversation_id: str | None = None
    temporary: bool = False


class SettingsPatch(BaseModel):
    theme: str | None = None
    font_size: str | None = None
    send_on_enter: bool | None = None
    default_model: str | None = None
    stream_responses: bool | None = None
    max_history_turns: int | None = None
    system_prompt: str | None = None


class ConversationPatch(BaseModel):
    title: str


class AuthPayload(BaseModel):
    email: str
    password: str
    display_name: str | None = None


def _client() -> genai.Client:
    if GEMINI_API_KEY:
        return genai.Client(api_key=GEMINI_API_KEY)
    if not PROJECT_ID:
        raise HTTPException(
            status_code=500,
            detail="Configure GOOGLE_API_KEY (or GEMINI_API_KEY), or set GCP_PROJECT/GOOGLE_CLOUD_PROJECT for Vertex AI.",
        )
    return genai.Client(vertexai=True, project=PROJECT_ID, location=VERTEX_LOCATION)


def _extract_pdf_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as e:  # pragma: no cover
        raise HTTPException(status_code=500, detail="pypdf dependency is missing.") from e
    try:
        reader = PdfReader(io.BytesIO(data))
        return "\n\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read PDF: {e!s}") from e


def _normalize_attachments(attachments: list[Attachment]) -> tuple[str, list[types.Part]]:
    if len(attachments) > MAX_ATTACHMENTS:
        raise HTTPException(status_code=400, detail=f"Too many attachments (max {MAX_ATTACHMENTS}).")

    text_fragments: list[str] = []
    image_parts: list[types.Part] = []
    for item in attachments:
        kind = (item.kind or "").lower()
        name = item.name or "file"
        if kind == "text":
            body = item.text or ""
            if len(body) > MAX_TEXT_ATTACHMENT_CHARS:
                body = body[:MAX_TEXT_ATTACHMENT_CHARS] + "\n\n[... truncated ...]"
            text_fragments.append(f"\n\n### Attached file: {name}\n{body}")
        elif kind == "pdf":
            raw = base64.b64decode(item.data or "", validate=True)
            if len(raw) > MAX_PDF_BYTES:
                raise HTTPException(status_code=400, detail=f"PDF {name} is too large.")
            text = _extract_pdf_text(raw)
            text_fragments.append(f"\n\n### Attached PDF: {name}\n{text[:MAX_TEXT_ATTACHMENT_CHARS]}")
        elif kind == "image":
            if not item.data:
                continue
            raw = base64.b64decode(item.data, validate=True)
            mime = (item.mime or "image/png").strip()
            image_parts.append(types.Part.from_bytes(data=raw, mime_type=mime))
            text_fragments.append(f"\n\n[Image attached: {name}]")
    return "".join(text_fragments), image_parts


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_conversation_title(message: str) -> str:
    raw = (message or "").strip()
    if not raw:
        return "New conversation"
    short = raw.replace("\n", " ")
    return (short[:60] + "…") if len(short) > 60 else short


def _get_or_create_settings(db) -> SettingsRow:
    row = db.get(SettingsRow, DEFAULT_USER_ID)
    if row:
        return row
    row = SettingsRow(user_id=DEFAULT_USER_ID)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _serialize_settings(row: SettingsRow) -> dict[str, Any]:
    return {
        "theme": row.theme,
        "font_size": row.font_size,
        "send_on_enter": row.send_on_enter,
        "default_model": row.default_model,
        "stream_responses": row.stream_responses,
        "max_history_turns": row.max_history_turns,
        "system_prompt": row.system_prompt,
    }


def _serialize_conv_row(row: ConversationRow) -> dict[str, Any]:
    return {
        "id": row.id,
        "title": row.title,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


def _upsert_oauth_user(db, *, email: str, display_name: str, provider: str) -> UserRow:
    email = (email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="OAuth provider did not return an email.")
    user = db.execute(select(UserRow).where(UserRow.email == email)).scalar_one_or_none()
    if not user:
        user = UserRow(
            email=email,
            display_name=(display_name or email.split("@")[0])[:200],
            password_hash="",
            provider=provider,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    else:
        if display_name:
            user.display_name = display_name[:200]
        user.provider = provider
        db.add(user)
        db.commit()
        db.refresh(user)
    if not db.get(SettingsRow, user.id):
        db.add(SettingsRow(user_id=user.id, default_model=DEFAULT_MODEL))
        db.commit()
    return user


def _form_post(url: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> dict[str, Any]:
    raw = urlencode(payload).encode("utf-8")
    req = UrlRequest(url, data=raw, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urlopen(req, timeout=20) as r:  # nosec B310
        body = r.read().decode("utf-8")
    return json.loads(body or "{}")


def _json_get(url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    req = UrlRequest(url, method="GET")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urlopen(req, timeout=20) as r:  # nosec B310
        body = r.read().decode("utf-8")
    return json.loads(body or "{}")


def _session_token_for(user_id: str) -> str:
    return session_serializer.dumps({"uid": user_id})


def _is_secure_request(request: Request) -> bool:
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").lower()
    if forwarded_proto:
        return forwarded_proto.split(",")[0].strip() == "https"
    return request.url.scheme == "https"


def _oauth_redirect_uri(request: Request, path: str) -> str:
    base = str(request.base_url).rstrip("/")
    if _is_secure_request(request):
        base = base.replace("http://", "https://", 1)
    return f"{base}{path}"


def _get_current_user(request: Request) -> CurrentUser | None:
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        return None
    try:
        payload = session_serializer.loads(token, max_age=SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None
    uid = str(payload.get("uid") or "").strip()
    if not uid:
        return None
    with SessionLocal() as db:
        row = db.get(UserRow, uid)
        if not row:
            return None
        return CurrentUser(
            id=row.id,
            email=row.email,
            display_name=row.display_name,
            provider=row.provider,
        )


def _require_user(request: Request) -> CurrentUser:
    user = _get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required.")
    return user


@app.get("/api/config")
def api_config() -> JSONResponse:
    return JSONResponse(
        {
            "vertex_configured": bool(PROJECT_ID),
            "project_id": PROJECT_ID,
            "location": VERTEX_LOCATION,
            "default_model": DEFAULT_MODEL,
            "adk_loaded": bool(NOVA_AGENT),
        }
    )


@app.post("/auth/register")
def auth_register(payload: AuthPayload) -> JSONResponse:
    email = (payload.email or "").strip().lower()
    password = (payload.password or "").strip()
    display_name = (payload.display_name or email.split("@")[0] or "User").strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Valid email is required.")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    with SessionLocal() as db:
        exists = db.execute(select(UserRow).where(UserRow.email == email)).scalar_one_or_none()
        if exists:
            raise HTTPException(status_code=409, detail="Email already registered.")
        user = UserRow(
            email=email,
            display_name=display_name[:200],
            password_hash=generate_password_hash(password),
            provider="email",
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        if not db.get(SettingsRow, user.id):
            db.add(SettingsRow(user_id=user.id, default_model=DEFAULT_MODEL))
            db.commit()
        db.add(LoginEventRow(user_id=user.id, success=True))
        db.commit()
        resp = JSONResponse({"ok": True, "user": {"id": user.id, "email": user.email, "display_name": user.display_name}})
        resp.set_cookie(
            key=SESSION_COOKIE_NAME,
            value=_session_token_for(user.id),
            max_age=SESSION_MAX_AGE,
            httponly=True,
            samesite="lax",
            secure=False,
        )
        return resp


@app.post("/auth/login")
def auth_login(payload: AuthPayload, request: Request) -> JSONResponse:
    email = (payload.email or "").strip().lower()
    password = (payload.password or "").strip()
    with SessionLocal() as db:
        user = db.execute(select(UserRow).where(UserRow.email == email)).scalar_one_or_none()
        ok = bool(user and check_password_hash(user.password_hash, password))
        db.add(
            LoginEventRow(
                user_id=user.id if user else DEFAULT_USER_ID,
                ip=(request.client.host if request.client else None),
                user_agent=request.headers.get("user-agent"),
                success=ok,
            )
        )
        db.commit()
        if not ok:
            raise HTTPException(status_code=401, detail="Invalid credentials.")
        if not db.get(SettingsRow, user.id):
            db.add(SettingsRow(user_id=user.id, default_model=DEFAULT_MODEL))
            db.commit()
        resp = JSONResponse({"ok": True, "user": {"id": user.id, "email": user.email, "display_name": user.display_name}})
        resp.set_cookie(
            key=SESSION_COOKIE_NAME,
            value=_session_token_for(user.id),
            max_age=SESSION_MAX_AGE,
            httponly=True,
            samesite="lax",
            secure=False,
        )
        return resp


@app.get("/auth/me")
def auth_me(request: Request) -> JSONResponse:
    user = _require_user(request)
    with SessionLocal() as db:
        row = db.get(SettingsRow, user.id) or SettingsRow(user_id=user.id, default_model=DEFAULT_MODEL)
        if not db.get(SettingsRow, user.id):
            db.add(row)
            db.commit()
            db.refresh(row)
        return JSONResponse(
            {
                "id": user.id,
                "email": user.email,
                "display_name": user.display_name,
                "provider": user.provider,
                "avatar_url": None,
                "settings": _serialize_settings(row),
            }
        )


@app.post("/auth/logout")
def auth_logout() -> JSONResponse:
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE_NAME)
    return resp


@app.post("/auth/change-password")
def auth_change_password(request: Request, payload: dict[str, str]) -> JSONResponse:
    user = _require_user(request)
    current_password = (payload.get("current_password") or "").strip()
    new_password = (payload.get("new_password") or "").strip()
    if user.provider != "email":
        raise HTTPException(status_code=400, detail="Password change is only available for email accounts.")
    if len(new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters.")
    with SessionLocal() as db:
        fresh_user = db.get(UserRow, user.id)
        if not fresh_user or not check_password_hash(fresh_user.password_hash, current_password):
            raise HTTPException(status_code=401, detail="Current password is incorrect.")
        fresh_user.password_hash = generate_password_hash(new_password)
        db.add(fresh_user)
        db.commit()
    return JSONResponse({"ok": True})


@app.get("/auth/google/login")
def auth_google_login(request: Request):
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Google OAuth is not configured.")
    state = secrets.token_urlsafe(24)
    signed_state = oauth_state_serializer.dumps({"state": state, "provider": "google"})
    redirect_uri = _oauth_redirect_uri(request, "/auth/google/callback")
    q = urlencode(
        {
            "client_id": GOOGLE_CLIENT_ID,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "openid email profile",
            "state": state,
            "access_type": "offline",
            "prompt": "consent",
        }
    )
    resp = RedirectResponse(f"https://accounts.google.com/o/oauth2/v2/auth?{q}")
    resp.set_cookie(
        OAUTH_STATE_COOKIE,
        signed_state,
        httponly=True,
        samesite="lax",
        secure=_is_secure_request(request),
        max_age=600,
    )
    return resp


@app.get("/auth/google/callback")
def auth_google_callback(request: Request, code: str | None = None, state: str | None = None):
    cookie = request.cookies.get(OAUTH_STATE_COOKIE)
    if not cookie or not code or not state:
        return RedirectResponse("/?oauth=google&error=missing_state")
    try:
        data = oauth_state_serializer.loads(cookie, max_age=600)
    except Exception:
        return RedirectResponse("/?oauth=google&error=invalid_state")
    if data.get("provider") != "google" or data.get("state") != state:
        return RedirectResponse("/?oauth=google&error=state_mismatch")
    redirect_uri = _oauth_redirect_uri(request, "/auth/google/callback")
    token = _form_post(
        "https://oauth2.googleapis.com/token",
        {
            "code": code,
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
    )
    access_token = token.get("access_token")
    if not access_token:
        return RedirectResponse("/?oauth=google&error=token_exchange")
    info = _json_get(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        {"Authorization": f"Bearer {access_token}"},
    )
    with SessionLocal() as db:
        user = _upsert_oauth_user(
            db,
            email=info.get("email", ""),
            display_name=info.get("name") or info.get("email", "").split("@")[0],
            provider="google",
        )
        user_id = user.id
        db.add(LoginEventRow(user_id=user_id, ip=(request.client.host if request.client else None), user_agent=request.headers.get("user-agent"), success=True))
        db.commit()
    resp = RedirectResponse("/")
    resp.set_cookie(
        SESSION_COOKIE_NAME,
        _session_token_for(user_id),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=_is_secure_request(request),
    )
    resp.delete_cookie(OAUTH_STATE_COOKIE)
    return resp


@app.get("/auth/github/login")
def auth_github_login(request: Request):
    if not GITHUB_CLIENT_ID or not GITHUB_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="GitHub OAuth is not configured.")
    state = secrets.token_urlsafe(24)
    signed_state = oauth_state_serializer.dumps({"state": state, "provider": "github"})
    redirect_uri = _oauth_redirect_uri(request, "/auth/github/callback")
    q = urlencode(
        {
            "client_id": GITHUB_CLIENT_ID,
            "redirect_uri": redirect_uri,
            "scope": "read:user user:email",
            "state": state,
        }
    )
    resp = RedirectResponse(f"https://github.com/login/oauth/authorize?{q}")
    resp.set_cookie(
        OAUTH_STATE_COOKIE,
        signed_state,
        httponly=True,
        samesite="lax",
        secure=_is_secure_request(request),
        max_age=600,
    )
    return resp


@app.get("/auth/github/callback")
def auth_github_callback(request: Request, code: str | None = None, state: str | None = None):
    cookie = request.cookies.get(OAUTH_STATE_COOKIE)
    if not cookie or not code or not state:
        return RedirectResponse("/?oauth=github&error=missing_state")
    try:
        data = oauth_state_serializer.loads(cookie, max_age=600)
    except Exception:
        return RedirectResponse("/?oauth=github&error=invalid_state")
    if data.get("provider") != "github" or data.get("state") != state:
        return RedirectResponse("/?oauth=github&error=state_mismatch")
    redirect_uri = _oauth_redirect_uri(request, "/auth/github/callback")
    token = _form_post(
        "https://github.com/login/oauth/access_token",
        {
            "client_id": GITHUB_CLIENT_ID,
            "client_secret": GITHUB_CLIENT_SECRET,
            "code": code,
            "redirect_uri": redirect_uri,
            "state": state,
        },
        headers={"Accept": "application/json"},
    )
    access_token = token.get("access_token")
    if not access_token:
        return RedirectResponse("/?oauth=github&error=token_exchange")
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    user_info = _json_get("https://api.github.com/user", headers)
    email = (user_info.get("email") or "").strip().lower()
    if not email:
        emails = _json_get("https://api.github.com/user/emails", headers)
        if isinstance(emails, list):
            primary = next((e for e in emails if e.get("primary") and e.get("verified")), None)
            email = (primary or {}).get("email", "")
    with SessionLocal() as db:
        user = _upsert_oauth_user(
            db,
            email=email,
            display_name=user_info.get("name") or user_info.get("login") or email.split("@")[0],
            provider="github",
        )
        user_id = user.id
        db.add(LoginEventRow(user_id=user_id, ip=(request.client.host if request.client else None), user_agent=request.headers.get("user-agent"), success=True))
        db.commit()
    resp = RedirectResponse("/")
    resp.set_cookie(
        SESSION_COOKIE_NAME,
        _session_token_for(user_id),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=_is_secure_request(request),
    )
    resp.delete_cookie(OAUTH_STATE_COOKIE)
    return resp


@app.get("/health")
def health() -> JSONResponse:
    return JSONResponse({"ok": True, "service": "nova-fastapi", "vertex_project": bool(PROJECT_ID)})


@app.get("/api/models")
def api_models() -> JSONResponse:
    return JSONResponse({"models": ALLOWED_MODELS, "default_model": DEFAULT_MODEL})


@app.get("/api/settings")
def get_settings(request: Request) -> JSONResponse:
    user = _require_user(request)
    with SessionLocal() as db:
        row = db.get(SettingsRow, user.id)
        if not row:
            row = SettingsRow(user_id=user.id, default_model=DEFAULT_MODEL)
            db.add(row)
            db.commit()
            db.refresh(row)
        return JSONResponse(_serialize_settings(row))


@app.patch("/api/settings")
def patch_settings(payload: SettingsPatch, request: Request) -> JSONResponse:
    user = _require_user(request)
    data = payload.model_dump(exclude_none=True)
    if "default_model" in data and data["default_model"] not in ALLOWED_MODEL_IDS:
        data["default_model"] = DEFAULT_MODEL
    if "max_history_turns" in data:
        data["max_history_turns"] = max(1, min(int(data["max_history_turns"]), 100))
    with SessionLocal() as db:
        row = db.get(SettingsRow, user.id)
        if not row:
            row = SettingsRow(user_id=user.id, default_model=DEFAULT_MODEL)
        for k, v in data.items():
            setattr(row, k, v)
        db.add(row)
        db.commit()
        db.refresh(row)
        return JSONResponse({"ok": True, "settings": _serialize_settings(row)})


@app.get("/api/conversations")
def list_conversations(request: Request) -> JSONResponse:
    user = _require_user(request)
    with SessionLocal() as db:
        rows = db.execute(
            select(ConversationRow).where(ConversationRow.user_id == user.id).order_by(desc(ConversationRow.updated_at))
        ).scalars().all()
        return JSONResponse([_serialize_conv_row(r) for r in rows])


@app.get("/api/conversations/{conversation_id}")
def get_conversation(conversation_id: str, request: Request) -> JSONResponse:
    user = _require_user(request)
    with SessionLocal() as db:
        conv = db.get(ConversationRow, conversation_id)
        if not conv or conv.user_id != user.id:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        msgs = db.execute(
            select(MessageRow).where(MessageRow.conversation_id == conversation_id).order_by(MessageRow.created_at)
        ).scalars().all()
        payload = _serialize_conv_row(conv)
        payload["messages"] = [
            {"id": m.id, "role": m.role, "content": m.content, "created_at": m.created_at.isoformat()} for m in msgs
        ]
        return JSONResponse(payload)


@app.patch("/api/conversations/{conversation_id}")
def patch_conversation(conversation_id: str, payload: ConversationPatch, request: Request) -> JSONResponse:
    user = _require_user(request)
    title = (payload.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required.")
    with SessionLocal() as db:
        conv = db.get(ConversationRow, conversation_id)
        if not conv or conv.user_id != user.id:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        conv.title = title[:200]
        conv.updated_at = datetime.utcnow()
        db.add(conv)
        db.commit()
        db.refresh(conv)
        return JSONResponse({"ok": True, "conversation": _serialize_conv_row(conv)})


@app.delete("/api/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, request: Request) -> JSONResponse:
    user = _require_user(request)
    with SessionLocal() as db:
        conv = db.get(ConversationRow, conversation_id)
        if conv and conv.user_id == user.id:
            db.query(MessageRow).filter(MessageRow.conversation_id == conversation_id).delete()
            db.delete(conv)
            db.commit()
    return JSONResponse({"ok": True})


@app.delete("/api/conversations")
def delete_all_conversations(request: Request) -> JSONResponse:
    user = _require_user(request)
    with SessionLocal() as db:
        conv_ids = db.execute(
            select(ConversationRow.id).where(ConversationRow.user_id == user.id)
        ).scalars().all()
        if conv_ids:
            db.query(MessageRow).filter(MessageRow.conversation_id.in_(conv_ids)).delete(synchronize_session=False)
            db.query(ConversationRow).filter(ConversationRow.user_id == user.id).delete(synchronize_session=False)
            db.commit()
    return JSONResponse({"ok": True})


@app.get("/api/security/events")
def list_security_events(request: Request) -> JSONResponse:
    user = _require_user(request)
    with SessionLocal() as db:
        rows = db.execute(
            select(LoginEventRow)
            .where(LoginEventRow.user_id == user.id)
            .order_by(desc(LoginEventRow.timestamp))
            .limit(30)
        ).scalars().all()
        return JSONResponse(
            [
                {
                    "id": r.id,
                    "ip": r.ip,
                    "user_agent": r.user_agent,
                    "timestamp": r.timestamp.isoformat(),
                    "success": r.success,
                }
                for r in rows
            ]
        )


@app.get("/api/data/export")
def export_data(request: Request) -> JSONResponse:
    user = _require_user(request)
    with SessionLocal() as db:
        convs = db.execute(
            select(ConversationRow).where(ConversationRow.user_id == user.id).order_by(ConversationRow.created_at)
        ).scalars().all()
        payload_convs = []
        for c in convs:
            msgs = db.execute(
                select(MessageRow).where(MessageRow.conversation_id == c.id).order_by(MessageRow.created_at)
            ).scalars().all()
            payload_convs.append(
                {
                    "id": c.id,
                    "title": c.title,
                    "created_at": c.created_at.isoformat(),
                    "updated_at": c.updated_at.isoformat(),
                    "messages": [
                        {"role": m.role, "content": m.content, "created_at": m.created_at.isoformat()} for m in msgs
                    ],
                }
            )
        return JSONResponse(
            {
                "user": {"id": user.id, "email": user.email, "display_name": user.display_name},
                "exported_at": _now_iso(),
                "conversations": payload_convs,
            }
        )


@app.delete("/api/account")
def delete_account_data(request: Request) -> JSONResponse:
    user = _require_user(request)
    with SessionLocal() as db:
        conv_ids = db.execute(
            select(ConversationRow.id).where(ConversationRow.user_id == user.id)
        ).scalars().all()
        if conv_ids:
            db.query(MessageRow).filter(MessageRow.conversation_id.in_(conv_ids)).delete(synchronize_session=False)
        db.query(ConversationRow).filter(ConversationRow.user_id == user.id).delete(synchronize_session=False)
        db.query(SettingsRow).filter(SettingsRow.user_id == user.id).delete(synchronize_session=False)
        db.query(LoginEventRow).filter(LoginEventRow.user_id == user.id).delete(synchronize_session=False)
        db.delete(user)
        db.commit()
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE_NAME)
    return resp


@app.post("/api/chat")
def api_chat(payload: ChatRequest, request: Request) -> StreamingResponse:
    user = _require_user(request)
    model = LEGACY_MODEL_MAP.get((payload.model or DEFAULT_MODEL).strip(), (payload.model or DEFAULT_MODEL).strip())
    if model not in ALLOWED_MODEL_IDS:
        model = DEFAULT_MODEL

    user_text = (payload.message or "").strip()
    is_temporary = bool(payload.temporary)
    conversation_id = (payload.conversation_id or "").strip() if not is_temporary else ""
    if not is_temporary:
        conversation_id = conversation_id or str(uuid.uuid4())
        with SessionLocal() as db:
            conv = db.get(ConversationRow, conversation_id)
            if not conv:
                conv = ConversationRow(
                    id=conversation_id,
                    user_id=user.id,
                    title=_new_conversation_title(user_text),
                    created_at=datetime.utcnow(),
                    updated_at=datetime.utcnow(),
                )
                db.add(conv)
                db.commit()
                db.refresh(conv)
            elif conv.user_id != user.id:
                raise HTTPException(status_code=404, detail="Conversation not found.")

    extra_text, image_parts = _normalize_attachments(payload.attachments)
    composed_text = (user_text + extra_text).strip() or "Summarize the attached context."

    text_part = types.Part.from_text(text=composed_text)
    parts: list[types.Part] = [text_part] + image_parts
    content = types.Content(role="user", parts=parts)

    def event_stream():
        full_text = ""
        try:
            # Keep an explicit client reference alive for the full stream lifecycle.
            client = _client()
            try:
                stream = client.models.generate_content_stream(
                    model=model,
                    contents=[content],
                    config=types.GenerateContentConfig(temperature=0.3),
                )
            except Exception as model_error:
                # Fallback for projects/regions without access to the requested model ID.
                if "NOT_FOUND" in str(model_error) or "not found" in str(model_error).lower():
                    stream = client.models.generate_content_stream(
                        model="gemini-2.5-flash",
                        contents=[content],
                        config=types.GenerateContentConfig(temperature=0.3),
                    )
                else:
                    raise
            for chunk in stream:
                piece = chunk.text or ""
                if piece:
                    full_text += piece
                    yield f"data: {json.dumps({'chunk': piece})}\n\n"
            if is_temporary:
                yield f"data: {json.dumps({'done': True, 'temporary': True})}\n\n"
            else:
                with SessionLocal() as db:
                    conv = db.get(ConversationRow, conversation_id)
                    if conv and conv.user_id == user.id:
                        db.add(MessageRow(conversation_id=conversation_id, role="user", content=user_text))
                        db.add(MessageRow(conversation_id=conversation_id, role="assistant", content=full_text))
                        conv.updated_at = datetime.utcnow()
                        db.add(conv)
                        db.commit()
                        title = conv.title
                    else:
                        title = _new_conversation_title(user_text)
                yield f"data: {json.dumps({'done': True, 'conversation_id': conversation_id, 'title': title})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# Serve React build (when available)
FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"


@app.get("/")
def index():
    index_html = FRONTEND_DIST / "index.html"
    if index_html.exists():
        return FileResponse(index_html)
    return JSONResponse(
        {
            "message": "Frontend build not found. Run `npm run build` in `frontend/`.",
            "api": ["/api/config", "/api/models", "/api/chat"],
        }
    )


@app.get("/{full_path:path}")
def spa_fallback(full_path: str):
    file_path = FRONTEND_DIST / full_path
    if file_path.exists() and file_path.is_file():
        return FileResponse(file_path)
    index_html = FRONTEND_DIST / "index.html"
    if index_html.exists():
        return FileResponse(index_html)
    raise HTTPException(status_code=404, detail="Not found")
