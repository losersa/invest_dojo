"""鉴权路由（自建，替代 Supabase Auth / GoTrue）

挂在 data-svc 下：/api/v1/auth/{register,login,logout,me}
前端经 Next 中间件代理（/svc/data）访问，Cookie 由本路由设置到 :3000 域。
"""

from __future__ import annotations

import re

from common_utils import api_error
from fastapi import APIRouter, Request, Response

from common import get_logger, settings
from common.auth import (
    SESSION_COOKIE,
    authenticate,
    create_user,
    issue_token,
    user_from_token,
)

logger = get_logger(__name__)
router = APIRouter()

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class AuthBody:
    """简单请求体解析（避免额外 pydantic 模型文件）"""

    @staticmethod
    def parse(body: dict) -> tuple[str, str, str | None]:
        email = (body.get("email") or "").strip().lower()
        password = body.get("password") or ""
        display_name = (body.get("display_name") or "").strip() or None
        return email, password, display_name


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        samesite="lax",
        path="/",
        max_age=settings.auth_token_ttl_seconds,
        secure=settings.is_production,
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=SESSION_COOKIE, path="/")


@router.post("/register", summary="注册")
async def register(request: Request, response: Response):
    try:
        body = await request.json()
    except Exception:
        raise api_error(ErrorCode.INVALID_PARAM, "invalid json body", status=400)

    email, password, display_name = AuthBody.parse(body)
    if not _EMAIL_RE.match(email):
        raise api_error(ErrorCode.INVALID_PARAM, "邮箱格式不合法", status=400)
    if len(password) < 6:
        raise api_error(ErrorCode.INVALID_PARAM, "密码至少 6 位", status=400)

    from common.auth import get_user_by_email

    if get_user_by_email(email):
        raise api_error("already_exists", "该邮箱已注册", status=409)

    user = create_user(email, password, display_name=display_name)
    token = issue_token(user)
    _set_session_cookie(response, token)
    return {"user": user.to_dict()}


@router.post("/login", summary="登录")
async def login(request: Request, response: Response):
    try:
        body = await request.json()
    except Exception:
        raise api_error(ErrorCode.INVALID_PARAM, "invalid json body", status=400)

    email, password, _ = AuthBody.parse(body)
    user = authenticate(email, password)
    if user is None:
        raise api_error("unauthorized", "邮箱或密码错误", status=401)

    token = issue_token(user)
    _set_session_cookie(response, token)
    return {"user": user.to_dict()}


@router.post("/logout", summary="退出登录")
async def logout(response: Response):
    _clear_session_cookie(response)
    return {"ok": True}


@router.get("/me", summary="当前登录用户")
async def me(request: Request):
    token = request.cookies.get(SESSION_COOKIE)
    user = user_from_token(token)
    if user is None:
        raise api_error("unauthorized", "未登录", status=401)
    return {"user": user.to_dict()}
