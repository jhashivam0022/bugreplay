import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from pwdlib import PasswordHash

password_hash = PasswordHash.recommended()


def _load_secret() -> str:
    configured = os.getenv("BUGREPLAY_SECRET_KEY")
    if configured:
        return configured

    secret_file = Path(__file__).resolve().parents[1] / ".secret_key"
    secret_file.parent.mkdir(parents=True, exist_ok=True)
    if not secret_file.exists():
        try:
            with secret_file.open("x", encoding="utf-8") as handle:
                handle.write(secrets.token_urlsafe(48))
        except FileExistsError:
            pass
    return secret_file.read_text(encoding="utf-8").strip()


SECRET_KEY = _load_secret()
SESSION_COOKIE = "bugreplay_session"
SESSION_HOURS = 12


def hash_password(password: str) -> str:
    return password_hash.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return password_hash.verify(password, hashed)


def issue_token(user_id: int) -> str:
    expires = datetime.now(timezone.utc) + timedelta(hours=SESSION_HOURS)
    return jwt.encode({"sub": str(user_id), "exp": expires}, SECRET_KEY, algorithm="HS256")


def read_token(token: str) -> int | None:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        return int(payload["sub"])
    except (jwt.InvalidTokenError, KeyError, TypeError, ValueError):
        return None
