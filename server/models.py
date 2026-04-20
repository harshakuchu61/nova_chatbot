"""
SQLAlchemy models: User, UserSettings, Conversation, Message, LoginEvent.
"""
import uuid
from datetime import datetime
from flask_login import UserMixin
from .extensions import db


class User(UserMixin, db.Model):
    __tablename__ = 'users'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    email = db.Column(db.String(254), unique=True, nullable=True, index=True)
    display_name = db.Column(db.String(200), nullable=False, default='')
    avatar_url = db.Column(db.String(500), nullable=True)
    password_hash = db.Column(db.String(128), nullable=True)
    provider = db.Column(db.String(20), nullable=False, default='email')
    provider_id = db.Column(db.String(200), nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    last_login = db.Column(db.DateTime, nullable=True)

    settings = db.relationship(
        'UserSettings', back_populates='user',
        uselist=False, cascade='all, delete-orphan',
    )
    conversations = db.relationship(
        'Conversation', back_populates='user',
        cascade='all, delete-orphan',
    )
    login_events = db.relationship(
        'LoginEvent', back_populates='user',
        cascade='all, delete-orphan',
    )


class UserSettings(db.Model):
    __tablename__ = 'user_settings'

    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), primary_key=True)
    theme = db.Column(db.String(20), nullable=False, default='light')
    default_model = db.Column(db.String(100), nullable=False, default='gpt-4o-mini')
    openai_api_key_enc = db.Column(db.Text, nullable=True)
    system_prompt = db.Column(db.Text, nullable=False, default='')
    stream_responses = db.Column(db.Boolean, nullable=False, default=True)
    send_on_enter = db.Column(db.Boolean, nullable=False, default=True)
    font_size = db.Column(db.String(20), nullable=False, default='medium')
    language = db.Column(db.String(10), nullable=False, default='en')
    max_history_turns = db.Column(db.Integer, nullable=False, default=20)

    user = db.relationship('User', back_populates='settings')


class Conversation(db.Model):
    __tablename__ = 'conversations'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    title = db.Column(db.String(200), nullable=False, default='New Chat')
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

    user = db.relationship('User', back_populates='conversations')
    messages = db.relationship(
        'Message', back_populates='conversation',
        cascade='all, delete-orphan',
        order_by='Message.created_at',
    )


class Message(db.Model):
    __tablename__ = 'messages'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    conversation_id = db.Column(
        db.String(36), db.ForeignKey('conversations.id'),
        nullable=False, index=True,
    )
    role = db.Column(db.String(20), nullable=False)
    content = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

    conversation = db.relationship('Conversation', back_populates='messages')


class LoginEvent(db.Model):
    __tablename__ = 'login_events'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    ip = db.Column(db.String(45), nullable=True)
    user_agent = db.Column(db.String(500), nullable=True)
    timestamp = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    success = db.Column(db.Boolean, nullable=False, default=True)

    user = db.relationship('User', back_populates='login_events')
