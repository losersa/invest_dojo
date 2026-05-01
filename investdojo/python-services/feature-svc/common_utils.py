"""feature-svc 工具：和 data-svc 类似的分页 / 错误 / 参数解析"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Query
from pydantic import BaseModel, Field


class ErrorCode:
    INVALID_PARAM = "invalid_param"
    FACTOR_NOT_FOUND = "factor_not_found"
    FACTOR_ALREADY_EXISTS = "factor_already_exists"
    FACTOR_NAME_DUPLICATE = "factor_name_duplicate"
    FACTOR_IN_USE = "factor_in_use"
    FACTOR_PERMISSION_DENIED = "factor_permission_denied"
    INVALID_FORMULA = "invalid_formula"
    UNKNOWN_FUNCTION = "unknown_function"
    UNAUTHORIZED = "unauthorized"


def api_error(code: str, message: str, status: int = 400, **detail: Any) -> HTTPException:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if detail:
        body["error"]["detail"] = detail
    return HTTPException(status_code=status, detail=body)


class Pagination(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(20, ge=1, le=100)
    total: int
    total_pages: int
    has_next: bool


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
            "has_next": page < total_pages,
        },
    }


def pagination_params(
    page: int = Query(1, ge=1, description="页码，从 1 开始"),
    page_size: int = Query(20, ge=1, le=100, description="每页行数，上限 100"),
) -> dict[str, int]:
    return {"page": page, "page_size": page_size}


VALID_CATEGORIES = {
    "technical",
    "valuation",
    "growth",
    "sentiment",
    "fundamental",
    "macro",
    "custom",
}

CATEGORY_LABELS = {
    "technical": "技术类",
    "valuation": "估值类",
    "growth": "成长类",
    "sentiment": "情绪类",
    "fundamental": "基本面",
    "macro": "宏观",
    "custom": "用户自定义",
}


def parse_tags(tags: str | None) -> list[str]:
    """逗号分隔的 tags"""
    if not tags:
        return []
    return [t.strip() for t in tags.split(",") if t.strip()]


def parse_sort(sort: str | None, *, valid: set[str]) -> tuple[str, str] | None:
    """解析排序参数 '-updated_at' → ('updated_at', 'desc')

    Args:
        sort: 形如 `-updated_at` 或 `winrate_20d`
        valid: 允许的字段集合
    """
    if not sort:
        return None
    desc = sort.startswith("-")
    field = sort[1:] if desc else sort
    if field not in valid:
        raise api_error(
            ErrorCode.INVALID_PARAM,
            f"Invalid sort field: {field!r}. Valid: {sorted(valid)}",
        )
    return field, "desc" if desc else "asc"
