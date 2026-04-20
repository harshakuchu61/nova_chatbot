"""
Nova — Personal AI Assistant · Flask Backend
Handles authentication, chat (streaming), settings, and conversation history.
"""

import os
import re
import json
import time
import base64
import hashlib
import io
from datetime import datetime
from pathlib import Path

from flask import (
    Flask, request, Response, stream_with_context,
    send_from_directory, redirect, jsonify, abort,
)
from flask_cors import CORS
from flask_login import login_required, current_user
from werkzeug.middleware.proxy_fix import ProxyFix
from dotenv import load_dotenv
from openai import OpenAI, APIError, AuthenticationError, RateLimitError

# ── Load .env before anything else ───────────────────────────────
_env_path = Path(__file__).resolve().parent / '.env'
load_dotenv(_env_path)

# ── App factory ───────────────────────────────────────────────────
app = Flask(__name__, static_folder='../static', static_url_path='')

# Trust the X-Forwarded-Proto / X-Forwarded-Host headers from Cloud Run
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

_secret = os.getenv('SECRET_KEY')
if not _secret:
    # No SECRET_KEY env var → generate a random one.
    # On Cloud Run this means sessions reset on every container restart.
    # Run scripts/setup.ps1 to store a fixed key in Secret Manager.
    _secret = os.urandom(32).hex()
    print('[WARNING] SECRET_KEY not set. Sessions will not survive container restarts. '
          'Run scripts/setup.ps1 to fix this.', flush=True)

_insecure_transport = bool(os.getenv('OAUTHLIB_INSECURE_TRANSPORT'))
_db_url = os.getenv('DATABASE_URL', 'sqlite:///nova.db')

app.config.update(
    SECRET_KEY=_secret,
    SQLALCHEMY_DATABASE_URI=_db_url,
    SQLALCHEMY_TRACK_MODIFICATIONS=False,
    SQLALCHEMY_ENGINE_OPTIONS={
        # Keep connections alive through Cloud SQL proxy socket idle timeouts
        'pool_pre_ping': True,
        'pool_recycle': 300,
    },
    REMEMBER_COOKIE_SECURE=not _insecure_transport,
    REMEMBER_COOKIE_HTTPONLY=True,
    REMEMBER_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=not _insecure_transport,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
)

CORS(app)

# ── Extensions ────────────────────────────────────────────────────
# These imports must come after app config (Flask-Dance needs the app object).
from .extensions import db, login_manager, bcrypt, limiter  # noqa: E402
from .models import User, UserSettings, Conversation, Message, LoginEvent  # noqa: E402
from .auth import auth_bp, google_bp, github_bp  # noqa: E402
from .crypto import encrypt_api_key, decrypt_api_key  # noqa: E402

db.init_app(app)
login_manager.init_app(app)
bcrypt.init_app(app)
limiter.init_app(app)

login_manager.login_view = None  # use our custom unauthorized handler


@login_manager.user_loader
def load_user(user_id: str):
    return db.session.get(User, user_id)


@login_manager.unauthorized_handler
def unauthorized():
    if request.path.startswith('/api/') or request.path.startswith('/auth/me'):
        return jsonify({'error': 'Authentication required.', 'login': '/login.html'}), 401
    return redirect('/login.html')


# ── Blueprints ────────────────────────────────────────────────────
app.register_blueprint(google_bp, url_prefix='/google')
app.register_blueprint(github_bp, url_prefix='/github')
app.register_blueprint(auth_bp)


# ── Database initialisation (with retry for Cloud SQL cold-start) ────
def _init_db(max_attempts: int = 5, delay: float = 3.0) -> None:
    """Create all tables. Retries on connection errors (Cloud SQL may need a
    few seconds after container start before the socket is ready)."""
    for attempt in range(1, max_attempts + 1):
        try:
            with app.app_context():
                db.create_all()
            if attempt > 1:
                print(f'[DB] Connected on attempt {attempt}.', flush=True)
            return
        except Exception as exc:
            if attempt < max_attempts:
                print(f'[DB] Attempt {attempt}/{max_attempts} failed: {exc}. '
                      f'Retrying in {delay}s…', flush=True)
                time.sleep(delay)
            else:
                print(f'[DB] WARNING: Could not initialise database after '
                      f'{max_attempts} attempts: {exc}\n'
                      f'[DB] App will start but database features will fail. '
                      f'Check DATABASE_URL and Cloud SQL connection.', flush=True)


_init_db()

# ── AI / chat constants ───────────────────────────────────────────
SYSTEM_INSTRUCTION = (
    "You are Nova, a friendly and knowledgeable Personal AI Assistant. "
    "You help users with answering questions, brainstorming ideas, writing, explaining concepts, "
    "and having thoughtful conversations. You are concise but thorough, and you use a warm, "
    "approachable tone. When appropriate, use markdown formatting like **bold**, *italic*, "
    "`code`, code blocks, and lists to make your responses clear and readable."
)

MAX_ATTACHMENTS = 6
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_PDF_BYTES = 16 * 1024 * 1024
MAX_TEXT_ATTACHMENT_CHARS = 200_000
ALLOWED_IMAGE_MIMES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp"})

CHAT_MODEL_OPTIONS = [
    {"id": "gpt-4o-mini", "label": "GPT-4o mini — fast, economical"},
    {"id": "gpt-4o", "label": "GPT-4o — most capable"},
    {"id": "gpt-4-turbo", "label": "GPT-4 Turbo"},
    {"id": "gpt-3.5-turbo", "label": "GPT-3.5 Turbo"},
]
CHAT_MODEL_IDS = frozenset(m["id"] for m in CHAT_MODEL_OPTIONS)

_MODEL_ID_CACHE: dict = {}
_MODEL_CACHE_TTL_SEC = 6 * 3600


# ── Attachment helpers ────────────────────────────────────────────

def model_supports_vision(model_id: str) -> bool:
    mid = (model_id or "").lower()
    if "gpt-3.5" in mid:
        return False
    return any(x in mid for x in ("gpt-4o", "gpt-4-turbo", "gpt-4-vision", "vision", "gpt-5", "o3", "o4", "chatgpt-4"))


def _safe_attachment_name(name: str) -> str:
    n = re.sub(r'[^\w.\-]+', "_", (name or "file").strip())[:180]
    return n or "file"


def extract_pdf_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as e:
        raise ValueError("PDF support is not installed on the server.") from e
    try:
        reader = PdfReader(io.BytesIO(data))
        return "\n\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception as e:
        raise ValueError(f"Could not read PDF: {e!s}") from e


def normalize_attachments(raw) -> tuple[list, str | None]:
    if not raw:
        return [], None
    if not isinstance(raw, list):
        return [], "Invalid attachments payload."
    if len(raw) > MAX_ATTACHMENTS:
        return [], f"Too many attachments (max {MAX_ATTACHMENTS})."
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        kind = (item.get("kind") or "").lower()
        name = _safe_attachment_name(str(item.get("name") or "file"))
        if kind == "image":
            mime = (item.get("mime") or "image/png").lower().strip()
            if mime not in ALLOWED_IMAGE_MIMES:
                return [], f"Unsupported image MIME: {mime}"
            b64 = item.get("data") or ""
            if not isinstance(b64, str) or not b64.strip():
                return [], f"Image {name} has no data."
            try:
                raw_bytes = base64.b64decode(b64, validate=True)
            except Exception:
                return [], f"Image {name} is not valid base64."
            if len(raw_bytes) > MAX_IMAGE_BYTES:
                return [], f"Image {name} is too large (max {MAX_IMAGE_BYTES // (1024*1024)} MB)."
            out.append({"kind": "image", "name": name, "mime": mime, "data": b64.strip()})
        elif kind == "text":
            text = item.get("text")
            if not isinstance(text, str):
                return [], f"File {name} must be text."
            if len(text) > MAX_TEXT_ATTACHMENT_CHARS:
                return [], f"File {name} is too long."
            out.append({"kind": "text", "name": name, "text": text})
        elif kind == "pdf":
            b64 = item.get("data") or ""
            if not isinstance(b64, str) or not b64.strip():
                return [], f"PDF {name} has no data."
            try:
                raw_bytes = base64.b64decode(b64, validate=True)
            except Exception:
                return [], f"PDF {name} is not valid base64."
            if len(raw_bytes) > MAX_PDF_BYTES:
                return [], f"PDF {name} is too large (max {MAX_PDF_BYTES // (1024*1024)} MB)."
            try:
                text = extract_pdf_text(raw_bytes)
            except ValueError as e:
                return [], str(e)
            if not text.strip():
                return [], f"No text could be extracted from {name}."
            if len(text) > MAX_TEXT_ATTACHMENT_CHARS:
                text = text[:MAX_TEXT_ATTACHMENT_CHARS] + "\n\n[... truncated ...]"
            out.append({"kind": "text", "name": name, "text": text})
        else:
            return [], f"Unknown attachment kind for {name}."
    return out, None


def build_user_content_for_api(user_text: str, attachments: list, model: str):
    user_text = user_text if isinstance(user_text, str) else ""
    vision = model_supports_vision(model)
    image_atts = [a for a in attachments if a.get("kind") == "image"]
    text_atts = [a for a in attachments if a.get("kind") == "text"]
    if image_atts and not vision:
        return None, (
            "This model does not accept images. Choose a vision-capable model "
            "(e.g. GPT-4o or GPT-4o mini) or remove image attachments."
        )
    extra = "".join(
        f"\n\n### Attached file: `{a.get('name')}`\n```\n{a.get('text') or ''}\n```\n"
        for a in text_atts
    )
    combined = user_text.strip() + extra
    if not combined.strip() and not image_atts:
        return None, "No message or attachments to send."
    if not combined.strip() and image_atts:
        combined = "(User message consists of attached images.)"
    if not image_atts:
        return combined, None
    parts = [{"type": "text", "text": combined}]
    for a in image_atts:
        parts.append({"type": "image_url", "image_url": {"url": f"data:{a.get('mime', 'image/png')};base64,{a.get('data', '')}"}})
    return parts, None


# ── Model helpers ─────────────────────────────────────────────────

def default_model():
    return os.getenv("OPENAI_MODEL", "gpt-4o-mini")


def effective_default_model():
    base = (default_model() or "").strip()
    return base if base in CHAT_MODEL_IDS else CHAT_MODEL_OPTIONS[0]["id"]


def _api_key_cache_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def cache_allowed_model_ids(api_key: str, model_ids: list[str]) -> None:
    _MODEL_ID_CACHE[_api_key_cache_key(api_key)] = (time.monotonic(), frozenset(model_ids))


def get_cached_allowed_model_ids(api_key: str):
    k = _api_key_cache_key(api_key)
    entry = _MODEL_ID_CACHE.get(k)
    if not entry:
        return None
    ts, ids = entry
    if time.monotonic() - ts > _MODEL_CACHE_TTL_SEC:
        del _MODEL_ID_CACHE[k]
        return None
    return ids


_NON_CHAT_SUBSTR = (
    "embedding", "text-embedding", "-tts", "tts-", "whisper", "dall-e",
    "moderation", "davinci", "babbage", "realtime", "transcribe",
    "audio-preview", "speech", "search-doc",
)


def is_probably_chat_completions_model(model_id: str) -> bool:
    if not model_id or len(model_id) > 128:
        return False
    mid = model_id.lower()
    if any(s in mid for s in _NON_CHAT_SUBSTR) or "turbo-instruct" in mid:
        return False
    if mid.startswith("ft:"):
        return "gpt-" in mid or "o1" in mid or "o3" in mid
    return mid.startswith(("gpt-", "o1", "o3", "o4", "chatgpt-"))


def _iter_models_list(client: OpenAI):
    page = client.models.list()
    data = getattr(page, "data", None)
    yield from (data if data is not None else page)


def fetch_remote_model_choices(api_key: str) -> list[dict]:
    client = OpenAI(api_key=api_key)
    seen, ids = set(), []
    for m in _iter_models_list(client):
        mid = getattr(m, "id", None) or str(m)
        if not mid or mid in seen or not is_probably_chat_completions_model(mid):
            continue
        seen.add(mid)
        ids.append(mid)

    preferred = ("gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo")
    ids.sort(key=lambda mid: (preferred.index(mid) if mid in preferred else 50, mid.lower()))
    return [{"id": i, "label": i} for i in ids]


def pick_default_for_remote_list(choices: list[dict]) -> str:
    ids = [c["id"] for c in choices]
    env_pref = (os.getenv("OPENAI_MODEL") or "").strip()
    if env_pref in ids:
        return env_pref
    for pref in ("gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo", "gpt-4-turbo"):
        if pref in ids:
            return pref
    return ids[0]


def warm_model_cache_if_needed(api_key: str) -> None:
    if get_cached_allowed_model_ids(api_key) is not None:
        return
    try:
        choices = fetch_remote_model_choices(api_key)
        if choices:
            cache_allowed_model_ids(api_key, [c["id"] for c in choices])
    except Exception:
        pass


def resolve_chat_model(requested, api_key: str) -> str:
    req = requested.strip() if isinstance(requested, str) else ""
    allowed = get_cached_allowed_model_ids(api_key)
    if allowed and req in allowed:
        return req
    if req in CHAT_MODEL_IDS:
        return req
    if allowed:
        d = pick_default_for_remote_list([{"id": x} for x in sorted(allowed)])
        return d if d in allowed else next(iter(sorted(allowed)))
    return effective_default_model()


# ── Error logging ─────────────────────────────────────────────────

def _log_error(line: str) -> None:
    try:
        with open('error.log', 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def _openai_limit_message(exc) -> str:
    text = str(exc).lower()
    if any(w in text for w in ('quota', 'billing', 'insufficient_quota', 'credit', 'payment')):
        return (
            'OpenAI blocked the request due to **quota or billing** (HTTP 429). '
            'Add billing credits: https://platform.openai.com/account/billing'
        )
    return (
        'OpenAI **rate limit** hit. Wait 30–60 seconds and try again. '
        'Check https://platform.openai.com/account/limits'
    )


# ── Resolve per-user API key ──────────────────────────────────────

def _resolve_api_key() -> str | None:
    """Return the OpenAI API key to use for the current request.
    Priority: user's encrypted key in DB → server env var.
    """
    if current_user.is_authenticated:
        s = current_user.settings
        if s and s.openai_api_key_enc:
            try:
                return decrypt_api_key(s.openai_api_key_enc, app.config['SECRET_KEY'])
            except Exception:
                pass
    env_key = (os.getenv('OPENAI_API_KEY') or '').strip()
    return env_key if env_key and env_key != 'your_api_key_here' else None


# ═══════════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════════

@app.route('/')
@login_required
def index():
    return send_from_directory(app.static_folder, 'index.html')


@app.route('/api/config', methods=['GET'])
def api_config():
    env_key = (os.getenv('OPENAI_API_KEY') or '').strip()
    server_key_ok = bool(env_key and env_key != 'your_api_key_here')
    return jsonify({
        'openai_configured': server_key_ok,
        'default_model': effective_default_model(),
        'google_oauth': bool(os.getenv('GOOGLE_CLIENT_ID')),
        'github_oauth': bool(os.getenv('GITHUB_CLIENT_ID')),
    })


@app.route('/api/models', methods=['POST'])
@login_required
def list_chat_models():
    # Accept a raw key from the request body (used by the Settings → Test button)
    # so users can validate a new key before saving it.
    data = request.get_json(silent=True) or {}
    raw_key = (data.get('api_key') or '').strip()
    api_key = raw_key or _resolve_api_key()
    if not api_key:
        return jsonify({
            'error': 'API key required.',
            'models': CHAT_MODEL_OPTIONS,
            'source': 'static',
            'default_model': effective_default_model(),
        }), 401
    try:
        choices = fetch_remote_model_choices(api_key)
        if not choices:
            raise ValueError('No chat-capable models returned')
        cache_allowed_model_ids(api_key, [c['id'] for c in choices])
        return jsonify({
            'models': choices,
            'source': 'openai',
            'default_model': pick_default_for_remote_list(choices),
        })
    except AuthenticationError:
        return jsonify({
            'error': 'Invalid API key.',
            'models': CHAT_MODEL_OPTIONS,
            'source': 'static',
            'default_model': effective_default_model(),
        }), 401
    except Exception as e:
        _log_error(f'[MODELS_LIST] {e}')
        return jsonify({
            'models': CHAT_MODEL_OPTIONS,
            'source': 'static',
            'default_model': effective_default_model(),
            'note': 'Could not load models from OpenAI; using built-in list.',
        })


@app.route('/api/chat', methods=['POST'])
@login_required
def chat():
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Invalid JSON body'}), 400

    api_key = _resolve_api_key()
    if not api_key:
        return jsonify({'error': 'No API key configured. Add your OpenAI key in Settings → API Keys.'}), 401

    user_text = data.get('message') or ''
    if user_text is not None and not isinstance(user_text, str):
        return jsonify({'error': 'Message must be a string.'}), 400

    attachments, att_err = normalize_attachments(data.get('attachments'))
    if att_err:
        return jsonify({'error': att_err}), 400

    warm_model_cache_if_needed(api_key)
    model = resolve_chat_model(data.get('model'), api_key)

    user_content, build_err = build_user_content_for_api(user_text, attachments, model)
    if build_err:
        return jsonify({'error': build_err}), 400

    # User settings
    s = current_user.settings
    sys_prompt = (s.system_prompt or '').strip() if s else ''
    if not sys_prompt:
        sys_prompt = SYSTEM_INSTRUCTION
    max_turns = max(1, (s.max_history_turns if s else 20) or 20)

    # Conversation (create or reuse)
    conv_id = data.get('conversation_id')
    conv = None
    if conv_id:
        conv = Conversation.query.filter_by(id=conv_id, user_id=current_user.id).first()
    if not conv:
        conv = Conversation(user_id=current_user.id, title='New Chat')
        db.session.add(conv)
        db.session.commit()
        conv_id = conv.id

    # Load history from DB
    recent_rows = (
        Message.query
        .filter_by(conversation_id=conv_id)
        .order_by(Message.created_at.desc())
        .limit(max_turns * 2)
        .all()
    )
    recent_rows.reverse()
    history = [{'role': m.role, 'content': m.content} for m in recent_rows]

    # Auto-title on first message
    is_new = len(recent_rows) == 0
    if is_new and isinstance(user_text, str) and user_text.strip():
        conv.title = user_text.strip()[:80]
        db.session.commit()

    messages = [{'role': 'system', 'content': sys_prompt}]
    messages.extend(history)
    messages.append({'role': 'user', 'content': user_content})

    client = OpenAI(api_key=api_key)
    _conv_id = conv_id
    _conv_title = conv.title
    _user_text_saved = user_text if isinstance(user_text, str) else ''

    def generate():
        full_response = ''
        try:
            stream = client.chat.completions.create(model=model, messages=messages, stream=True)
            for chunk in stream:
                choice = chunk.choices[0] if chunk.choices else None
                if not choice or not choice.delta:
                    continue
                piece = choice.delta.content
                if piece:
                    full_response += piece
                    yield f"data: {json.dumps({'chunk': piece})}\n\n"

            # Persist to DB
            db.session.add(Message(conversation_id=_conv_id, role='user', content=_user_text_saved))
            db.session.add(Message(conversation_id=_conv_id, role='assistant', content=full_response))
            # Update conversation timestamp
            conv_row = db.session.get(Conversation, _conv_id)
            if conv_row:
                conv_row.updated_at = datetime.utcnow()
            db.session.commit()

            yield f"data: {json.dumps({'done': True, 'conversation_id': _conv_id, 'title': _conv_title})}\n\n"

        except AuthenticationError:
            yield f"data: {json.dumps({'error': 'Invalid API key. Check Settings → API Keys.'})}\n\n"
        except RateLimitError as e:
            _log_error(f'[RATE_LIMIT] {e}')
            yield f"data: {json.dumps({'error': _openai_limit_message(e)})}\n\n"
        except APIError as e:
            msg = str(e)
            _log_error(f'[API_ERROR] {msg}')
            code = getattr(e, 'status_code', None)
            if code == 401:
                yield f"data: {json.dumps({'error': 'Invalid API key.'})}\n\n"
            elif code == 429:
                yield f"data: {json.dumps({'error': _openai_limit_message(e)})}\n\n"
            else:
                yield f"data: {json.dumps({'error': f'Something went wrong: {msg}'})}\n\n"
        except Exception as e:
            error_msg = str(e)
            _log_error(f'[ERROR] {error_msg}')
            low = error_msg.lower()
            if '429' in error_msg or 'rate limit' in low or 'too many requests' in low:
                yield f"data: {json.dumps({'error': _openai_limit_message(e)})}\n\n"
            else:
                yield f"data: {json.dumps({'error': f'Something went wrong: {error_msg}'})}\n\n"

    return Response(
        stream_with_context(generate()),
        content_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


@app.route('/api/clear', methods=['POST'])
@login_required
def clear_chat():
    data = request.get_json(silent=True) or {}
    conv_id = data.get('conversation_id')
    if conv_id:
        conv = Conversation.query.filter_by(id=conv_id, user_id=current_user.id).first()
        if conv:
            db.session.delete(conv)
            db.session.commit()
    return jsonify({'status': 'cleared'})


# ── Settings ──────────────────────────────────────────────────────

@app.route('/api/settings', methods=['GET'])
@login_required
def get_settings():
    s = current_user.settings
    if not s:
        s = UserSettings(user_id=current_user.id)
        db.session.add(s)
        db.session.commit()
    return jsonify({
        'theme': s.theme,
        'default_model': s.default_model,
        'has_api_key': bool(s.openai_api_key_enc),
        'system_prompt': s.system_prompt,
        'stream_responses': s.stream_responses,
        'send_on_enter': s.send_on_enter,
        'font_size': s.font_size,
        'language': s.language,
        'max_history_turns': s.max_history_turns,
    })


@app.route('/api/settings', methods=['PATCH'])
@login_required
def update_settings():
    data = request.get_json(silent=True) or {}
    s = current_user.settings
    if not s:
        s = UserSettings(user_id=current_user.id)
        db.session.add(s)

    allowed_str = {'theme', 'default_model', 'system_prompt', 'font_size', 'language'}
    allowed_bool = {'stream_responses', 'send_on_enter'}
    allowed_int = {'max_history_turns'}

    for field in allowed_str:
        if field in data and isinstance(data[field], str):
            setattr(s, field, data[field][:500])
    for field in allowed_bool:
        if field in data and isinstance(data[field], bool):
            setattr(s, field, data[field])
    for field in allowed_int:
        if field in data and isinstance(data[field], int):
            setattr(s, field, max(1, min(100, data[field])))

    # API key (special handling — encrypt before storing)
    if 'openai_api_key' in data:
        raw_key = (data['openai_api_key'] or '').strip()
        if raw_key:
            s.openai_api_key_enc = encrypt_api_key(raw_key, app.config['SECRET_KEY'])
        else:
            s.openai_api_key_enc = None

    # Display name
    if 'display_name' in data and isinstance(data['display_name'], str):
        name = data['display_name'].strip()[:200]
        if name:
            current_user.display_name = name

    db.session.commit()
    return jsonify({'ok': True})


# ── Conversations ─────────────────────────────────────────────────

@app.route('/api/conversations', methods=['GET'])
@login_required
def list_conversations():
    convs = (
        Conversation.query
        .filter_by(user_id=current_user.id)
        .order_by(Conversation.updated_at.desc())
        .limit(100)
        .all()
    )
    return jsonify([
        {
            'id': c.id,
            'title': c.title,
            'updated_at': c.updated_at.isoformat(),
            'created_at': c.created_at.isoformat(),
        }
        for c in convs
    ])


@app.route('/api/conversations/<conv_id>', methods=['GET'])
@login_required
def get_conversation(conv_id: str):
    conv = Conversation.query.filter_by(id=conv_id, user_id=current_user.id).first()
    if not conv:
        abort(404)
    return jsonify({
        'id': conv.id,
        'title': conv.title,
        'created_at': conv.created_at.isoformat(),
        'messages': [
            {'role': m.role, 'content': m.content, 'created_at': m.created_at.isoformat()}
            for m in conv.messages
        ],
    })


@app.route('/api/conversations/<conv_id>', methods=['DELETE'])
@login_required
def delete_conversation(conv_id: str):
    conv = Conversation.query.filter_by(id=conv_id, user_id=current_user.id).first()
    if conv:
        db.session.delete(conv)
        db.session.commit()
    return jsonify({'ok': True})


@app.route('/api/conversations', methods=['DELETE'])
@login_required
def delete_all_conversations():
    Conversation.query.filter_by(user_id=current_user.id).delete()
    db.session.commit()
    return jsonify({'ok': True})


# ── Security / audit ──────────────────────────────────────────────

@app.route('/api/security/events', methods=['GET'])
@login_required
def security_events():
    events = (
        LoginEvent.query
        .filter_by(user_id=current_user.id)
        .order_by(LoginEvent.timestamp.desc())
        .limit(20)
        .all()
    )
    return jsonify([
        {
            'ip': e.ip,
            'user_agent': e.user_agent,
            'timestamp': e.timestamp.isoformat(),
            'success': e.success,
        }
        for e in events
    ])


# ── Data export & account management ─────────────────────────────

@app.route('/api/data/export', methods=['GET'])
@login_required
def export_data():
    convs = (
        Conversation.query
        .filter_by(user_id=current_user.id)
        .order_by(Conversation.created_at)
        .all()
    )
    payload = {
        'user': {'email': current_user.email, 'display_name': current_user.display_name},
        'exported_at': datetime.utcnow().isoformat(),
        'conversations': [
            {
                'id': c.id,
                'title': c.title,
                'created_at': c.created_at.isoformat(),
                'messages': [
                    {'role': m.role, 'content': m.content, 'created_at': m.created_at.isoformat()}
                    for m in c.messages
                ],
            }
            for c in convs
        ],
    }
    date_str = datetime.utcnow().strftime('%Y%m%d')
    return Response(
        json.dumps(payload, indent=2),
        content_type='application/json',
        headers={'Content-Disposition': f'attachment; filename=nova_chats_{date_str}.json'},
    )


@app.route('/api/account', methods=['DELETE'])
@login_required
def delete_account():
    from flask_login import logout_user
    user = current_user
    logout_user()
    db.session.delete(user)
    db.session.commit()
    return jsonify({'ok': True})


# ── Dev server entry point ────────────────────────────────────────

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    is_prod = bool(os.environ.get('K_SERVICE'))
    if not is_prod:
        print("\n--- Nova - Personal AI Assistant ---")
        print(f"    Server running at http://localhost:{port}\n")
    app.run(debug=not is_prod, host='0.0.0.0', port=port)
