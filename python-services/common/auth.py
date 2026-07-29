"""自建轻量鉴权模块（替代原 Supabase Auth / GoTrue）

设计要点：
- 用户表：public.users（见 migrations/009_users_auth.sql）
- 密码哈希：stdlib pbkdf2_hmac（sha256 + 随机盐），零第三方依赖
- 会话：HS256 JWT 写入 httpOnly Cookie（由 data-svc 路由层设置）
- 不依赖任何外部鉴权服务；前端经 Next 中间件代理访问 /api/v1/auth/*

仅做登录态签发/校验，权限（role）校验在各业务服务内自行处理。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any

from common.config import settings
from common.logging import get_logger
from common.pg_client import get_pg_client

logger = get_logger(__name__)

# Cookie / Token 名
SESSION_COOKIE = "id_session"
# 开发默认密钥（生产务必通过环境变量 AUTH_JWT_SECRET 覆盖）
_DEFAULT_JWT_SECRET = "investdojo-dev-jwt-secret-v1"
_TOKEN_TTL_SECONDS = 60 * 60 * 24  # 1 天


def _jwt_secret() -> str:
    return getattr(settings, "auth_jwt_secret", None) or _DEFAULT_JWT_SECRET


# ──────────────────────────────────────────────
# 密码哈希（pbkdf2）
# ──────────────────────────────────────────────

def hash_password(password: str, *, iterations: int = 100_000) -> str:
    """返回可存储的串：pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>"""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256${}${}${}".format(
        iterations,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(dk).decode("ascii"),
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters_s, salt_b64, hash_b64 = stored.split("$")
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False
    try:
        iterations = int(iters_s)
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
    except (ValueError, base64.binascii.Error):
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(dk, expected)


# ──────────────────────────────────────────────
# JWT（HS256，纯标准库实现）
# ──────────────────────────────────────────────

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def encode_jwt(payload: dict[str, Any], *, ttl_seconds: int = _TOKEN_TTL_SECONDS) -> str:
    now = int(time.time())
    body = {**payload, "iat": now, "exp": now + ttl_seconds}
    header = {"alg": "HS256", "typ": "JWT"}
    signing_input = (
        _b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
        + "."
        + _b64url(json.dumps(body, separators=(",", ":")).encode("utf-8"))
    ).encode("ascii")
    sig = hmac.new(_jwt_secret().encode("utf-8"), signing_input, hashlib.sha256).digest()
    return signing_input.decode("ascii") + "." + _b64url(sig)


def decode_jwt(token: str) -> dict[str, Any] | None:
    try:
        header_b64, payload_b64, sig_b64 = token.split(".")
    except ValueError:
        return None
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected = hmac.new(_jwt_secret().encode("utf-8"), signing_input, hashlib.sha256).digest()
    try:
        got = _b64url_decode(sig_b64)
    except (ValueError, base64.binascii.Error):
        return None
    if not hmac.compare_digest(got, expected):
        return None
    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except (ValueError, base64.binascii.Error):
        return None
    exp = payload.get("exp")
    if exp is not None and int(time.time()) >= int(exp):
        return None
    return payload


# ──────────────────────────────────────────────
# 用户 CRUD（基于现有 PGClient）
# ──────────────────────────────────────────────

@dataclass
class AuthUser:
    id: str
    email: str
    display_name: str | None
    role: str
    provider: str
    created_at: Any | None

    def to_dict(self) -> dict[str, Any]:
        created = self.created_at
        if created is not None:
            try:
                created = created.isoformat()
            except AttributeError:
                created = str(created)
        return {
            "id": self.id,
            "email": self.email,
            "displayName": self.display_name or "",
            "role": self.role,
            "provider": self.provider,
            "createdAt": created,
        }


def _row_to_user(row: dict[str, Any]) -> AuthUser:
    return AuthUser(
        id=str(row["id"]),
        email=row["email"],
        display_name=row.get("display_name"),
        role=row.get("role") or "user",
        provider=row.get("provider") or "email",
        created_at=row.get("created_at"),
    )


def get_user_by_email(email: str) -> AuthUser | None:
    client = get_pg_client()
    rows = client.select("users", filters={"email": f"eq.{email.lower()}"}, limit=1)
    return _row_to_user(rows[0]) if rows else None


def get_user_by_id(user_id: str) -> AuthUser | None:
    client = get_pg_client()
    rows = client.select("users", filters={"id": f"eq.{user_id}"}, limit=1)
    return _row_to_user(rows[0]) if rows else None


def create_user(
    email: str,
    password: str,
    *,
    display_name: str | None = None,
    role: str = "user",
    provider: str = "email",
) -> AuthUser:
    client = get_pg_client()
    password_hash = hash_password(password)
    rows = client.insert(
        "users",
        {
            "email": email.lower(),
            "password_hash": password_hash,
            "display_name": display_name or email.split("@")[0],
            "role": role,
            "provider": provider,
        },
    )
    return _row_to_user(rows[0])


def authenticate(email: str, password: str) -> AuthUser | None:
    user = get_user_by_email(email)
    if user is None:
        # 故意做一次哈希以缓解用户不存在时的时序侧信道
        hash_password("dummy-password-for-timing")
        return None
    client = get_pg_client()
    rows = client.select("users", columns="password_hash", filters={"email": f"eq.{email.lower()}"}, limit=1)
    if not rows:
        return None
    if not verify_password(password, rows[0]["password_hash"]):
        return None
    return user


def issue_token(user: AuthUser) -> str:
    return encode_jwt(
        {
            "sub": user.id,
            "email": user.email,
            "role": user.role,
            "provider": user.provider,
        }
    )


def user_from_token(token: str | None) -> AuthUser | None:
    if not token:
        return None
    payload = decode_jwt(token)
    if not payload or "sub" not in payload:
        return None
    return get_user_by_id(payload["sub"])
