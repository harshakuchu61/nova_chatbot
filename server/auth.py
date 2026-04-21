"""
Authentication blueprint: Google/GitHub OAuth via Flask-Dance + email/password.
"""
import os
from datetime import datetime

from flask import Blueprint, request, jsonify
from flask_login import login_user, logout_user, login_required, current_user
from flask_dance.contrib.google import make_google_blueprint, google
from flask_dance.contrib.github import make_github_blueprint, github
from flask_dance.consumer import oauth_authorized

from .extensions import db, bcrypt, limiter
from .models import User, UserSettings, LoginEvent

# ── Auth blueprint (email/password + util routes) ────────────────
auth_bp = Blueprint('auth', __name__, url_prefix='/auth')

# ── OAuth blueprints (registered in app.py) ──────────────────────
google_bp = make_google_blueprint(
    client_id=os.getenv('GOOGLE_CLIENT_ID', ''),
    client_secret=os.getenv('GOOGLE_CLIENT_SECRET', ''),
    scope=[
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
    ],
    offline=False,
    reprompt_consent=False,
    login_url='/google/login',
    authorized_url='/google/authorized',
)

github_bp = make_github_blueprint(
    client_id=os.getenv('GITHUB_CLIENT_ID', ''),
    client_secret=os.getenv('GITHUB_CLIENT_SECRET', ''),
    scope='user:email',
    login_url='/github/login',
    authorized_url='/github/authorized',
)


# ── Helpers ───────────────────────────────────────────────────────

def _log_event(user_id: str, success: bool = True) -> None:
    ua = (request.user_agent.string or '')[:500] if request.user_agent else ''
    db.session.add(LoginEvent(
        user_id=user_id,
        ip=request.remote_addr,
        user_agent=ua,
        success=success,
    ))
    db.session.commit()


def _upsert_user(*, email, display_name, avatar_url, provider, provider_id) -> User:
    """Find or create a User row; update profile info on re-login."""
    user = User.query.filter_by(provider=provider, provider_id=str(provider_id)).first()
    if not user and email:
        user = User.query.filter_by(email=email.lower()).first()
    if not user:
        user = User(
            email=email.lower() if email else None,
            display_name=display_name or (email or 'User'),
            avatar_url=avatar_url,
            provider=provider,
            provider_id=str(provider_id),
        )
        db.session.add(user)
        db.session.flush()
        db.session.add(UserSettings(user_id=user.id))
    else:
        if display_name:
            user.display_name = display_name
        if avatar_url:
            user.avatar_url = avatar_url
        user.provider = provider
        user.provider_id = str(provider_id)
    user.last_login = datetime.utcnow()
    db.session.commit()
    return user


# ── OAuth signal handlers ─────────────────────────────────────────

@oauth_authorized.connect_via(google_bp)
def google_logged_in(blueprint, token):
    if not token:
        return False
    resp = google.get('/oauth2/v2/userinfo')
    if not resp.ok:
        return False
    info = resp.json()
    user = _upsert_user(
        email=info.get('email'),
        display_name=info.get('name'),
        avatar_url=info.get('picture'),
        provider='google',
        provider_id=info.get('id') or info.get('sub', ''),
    )
    login_user(user, remember=True)
    _log_event(user.id)
    return False  # don't persist token to session/DB


@oauth_authorized.connect_via(github_bp)
def github_logged_in(blueprint, token):
    if not token:
        return False
    resp = github.get('/user')
    if not resp.ok:
        return False
    info = resp.json()
    email = info.get('email')
    if not email:
        er = github.get('/user/emails')
        if er.ok:
            for e in er.json():
                if e.get('primary') and e.get('verified'):
                    email = e['email']
                    break
    user = _upsert_user(
        email=email,
        display_name=info.get('name') or info.get('login'),
        avatar_url=info.get('avatar_url'),
        provider='github',
        provider_id=info.get('id', ''),
    )
    login_user(user, remember=True)
    _log_event(user.id)
    return False


# ── Auth routes ───────────────────────────────────────────────────

@auth_bp.route('/me')
@login_required
def me():
    u = current_user
    s = u.settings
    return jsonify({
        'id': u.id,
        'email': u.email,
        'display_name': u.display_name,
        'avatar_url': u.avatar_url,
        'provider': u.provider,
        'created_at': u.created_at.isoformat() if u.created_at else None,
        'settings': {
            'theme': s.theme if s else 'light',
            'default_model': s.default_model if s else 'gpt-4o-mini',
            'has_api_key': bool(s and s.openai_api_key_enc),
            'system_prompt': s.system_prompt if s else '',
            'stream_responses': s.stream_responses if s else True,
            'send_on_enter': s.send_on_enter if s else True,
            'font_size': s.font_size if s else 'medium',
            'language': s.language if s else 'en',
            'max_history_turns': s.max_history_turns if s else 20,
        },
    })


@auth_bp.route('/register', methods=['POST'])
@limiter.limit("5 per hour")
def register():
    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''
    name = (data.get('name') or '').strip() or (email.split('@')[0] if email else 'User')

    if not email or '@' not in email:
        return jsonify({'error': 'A valid email address is required.'}), 400
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters.'}), 400
    if User.query.filter_by(email=email).first():
        return jsonify({'error': 'An account with this email already exists.'}), 409

    pw_hash = bcrypt.generate_password_hash(password).decode('utf-8')
    user = User(email=email, display_name=name, password_hash=pw_hash, provider='email')
    db.session.add(user)
    db.session.flush()
    db.session.add(UserSettings(user_id=user.id))
    db.session.commit()
    login_user(user, remember=True)
    _log_event(user.id)
    return jsonify({'ok': True}), 201


@auth_bp.route('/login', methods=['POST'])
@limiter.limit("10 per 15 minutes")
def login():
    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''
    user = User.query.filter_by(email=email, provider='email').first()
    if not user or not user.password_hash or \
            not bcrypt.check_password_hash(user.password_hash, password):
        if user:
            _log_event(user.id, success=False)
        return jsonify({'error': 'Invalid email or password.'}), 401
    user.last_login = datetime.utcnow()
    db.session.commit()
    login_user(user, remember=True)
    _log_event(user.id)
    return jsonify({'ok': True}), 200


@auth_bp.route('/logout', methods=['POST'])
def logout():
    logout_user()
    return jsonify({'ok': True}), 200


@auth_bp.route('/change-password', methods=['POST'])
@login_required
def change_password():
    if current_user.provider != 'email':
        return jsonify({'error': 'Password change is only available for email accounts.'}), 400
    data = request.get_json(silent=True) or {}
    cur = data.get('current_password') or ''
    new_pw = data.get('new_password') or ''
    if not current_user.password_hash or \
            not bcrypt.check_password_hash(current_user.password_hash, cur):
        return jsonify({'error': 'Current password is incorrect.'}), 401
    if len(new_pw) < 8:
        return jsonify({'error': 'New password must be at least 8 characters.'}), 400
    current_user.password_hash = bcrypt.generate_password_hash(new_pw).decode('utf-8')
    db.session.commit()
    return jsonify({'ok': True}), 200
