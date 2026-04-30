"""data-svc 专用工具

- as_of 参数解析 + 验证
- 分页响应模板
- 错误响应
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from fastapi import HTTPException, Query
from pydantic import BaseModel, Field


# ─── 错误码 ────────────────────────────────────────
class ErrorCode:
    INVALID_PARAM = "invalid_param"
    NOT_FOUND = "not_found"
    FUTURE_LEAK = "future_leak"
    TOO_MANY_SYMBOLS = "too_many_symbols"


def api_error(code: str, message: str, status: int = 400) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail={"error": {"code": code, "message": message}},
    )


# ─── 分页 ────────────────────────────────────────
class Pagination(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(100, ge=1, le=1000)
    total: int
    total_pages: int


def paginate_response(
    data: list[Any],
    *,
    page: int,
    page_size: int,
    total: int,
) -> dict[str, Any]:
    total_pages = (total + page_size - 1) // page_size if total > 0 else 0
    return {
        "data": data,
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": total_pages,
        },
    }


# ─── as_of 解析 ────────────────────────────────────────
def parse_as_of(as_of: str | None) -> str | None:
    """解析 as_of 参数，返回 ISO 8601 字符串（UTC）或 None

    接受格式：
    - "2024-03-15"         → 2024-03-15T00:00:00+00:00（UTC 零点）
    - "2024-03-15T15:00"   → 同上加时分
    - "2024-03-15T15:00:00+08:00"
    """
    if not as_of:
        return None
    try:
        s = as_of.strip()
        if "T" not in s:
            s = f"{s}T00:00:00+00:00"
        elif not (s.endswith("Z") or "+" in s[-6:] or "-" in s[10:]):
            s += "+00:00"
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc).isoformat()
    except Exception as exc:
        raise api_error(
            ErrorCode.INVALID_PARAM,
            f"Invalid as_of format: {as_of!r}. Expected ISO 8601.",
        ) from exc


def parse_date(value: str | None, *, name: str = "date") -> str | None:
    """解析 YYYY-MM-DD / ISO 8601，返回 ISO 字符串"""
    if not value:
        return None
    try:
        s = value.strip()
        if "T" not in s:
            # 纯日期，返回 date 字符串原样
            datetime.strptime(s, "%Y-%m-%d")
            return s
        # 带时间
        if not (s.endswith("Z") or "+" in s[-6:] or "-" in s[10:]):
            s += "+00:00"
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc).isoformat()
    except Exception as exc:
        raise api_error(
            ErrorCode.INVALID_PARAM,
            f"Invalid {name}: {value!r}. Expected YYYY-MM-DD or ISO 8601.",
        ) from exc


# ─── 通用 FastAPI 依赖 ────────────────────────────────────────
def pagination_params(
    page: int = Query(1, ge=1, description="页码，从 1 开始"),
    page_size: int = Query(100, ge=1, le=1000, description="每页行数，上限 1000"),
) -> dict[str, int]:
    return {"page": page, "page_size": page_size}


def split_symbols(symbols: str | None, *, max_count: int = 50) -> list[str]:
    """逗号分隔的 symbols 拆分 + 去重 + 校验上限"""
    if not symbols:
        return []
    codes = [c.strip() for c in symbols.split(",") if c.strip()]
    # 去重保持顺序
    seen: set[str] = set()
    unique: list[str] = []
    for c in codes:
        if c not in seen:
            seen.add(c)
            unique.append(c)
    if len(unique) > max_count:
        raise api_error(
            ErrorCode.TOO_MANY_SYMBOLS,
            f"Too many symbols: {len(unique)} > {max_count}",
        )
    return unique


# ─── 时区辅助 ────────────────────────────────────────
def as_of_to_utc_iso(as_of: str | None) -> str | None:
    """如果 as_of 是纯日期，按北京时间 00:00 转为 UTC 前一天 16:00"""
    if not as_of:
        return None
    if "T" in as_of:
        return as_of  # 已经是完整 ISO
    # 纯日期 "2024-03-15" 视为 北京时间该日 00:00:00
    from datetime import timedelta
    d = datetime.strptime(as_of, "%Y-%m-%d")
    beijing = d.replace(tzinfo=timezone(timedelta(hours=8)))
    return beijing.astimezone(timezone.utc).isoformat()
