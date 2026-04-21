"""
AES-256-GCM encrypt / decrypt for storing OpenAI API keys at rest.
The encryption key is derived from the Flask SECRET_KEY via PBKDF2-SHA256.
"""
import os
import base64

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.backends import default_backend

_SALT = b'nova_key_salt_v1_2024'


def _derive_key(secret: str) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=SHA256(),
        length=32,
        salt=_SALT,
        iterations=100_000,
        backend=default_backend(),
    )
    return kdf.derive(secret.encode('utf-8'))


def encrypt_api_key(plaintext: str, secret: str) -> str:
    """Encrypt *plaintext* with AES-256-GCM.
    Returns a URL-safe base64 string: 12-byte nonce || ciphertext+tag.
    """
    key = _derive_key(secret)
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)
    ct = aesgcm.encrypt(nonce, plaintext.encode('utf-8'), None)
    return base64.urlsafe_b64encode(nonce + ct).decode('utf-8')


def decrypt_api_key(token: str, secret: str) -> str:
    """Decrypt a token produced by :func:`encrypt_api_key`.
    Raises ``ValueError`` on any decryption failure.
    """
    try:
        key = _derive_key(secret)
        aesgcm = AESGCM(key)
        raw = base64.urlsafe_b64decode(token.encode('utf-8'))
        nonce, ct = raw[:12], raw[12:]
        return aesgcm.decrypt(nonce, ct, None).decode('utf-8')
    except Exception as exc:
        raise ValueError('Failed to decrypt API key') from exc
