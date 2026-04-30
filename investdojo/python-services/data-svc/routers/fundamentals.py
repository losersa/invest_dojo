"""财报接口 —— announce_date 是防未来函数关键字段

注意：
- 财报的"时间"要按 `announce_date`（公告日）而不是 `report_date`（报告期）。
  因为 2024 Q1 的财报 2024-04-29 才公告，2024-03-31 那天绝对不能看到。
"""

from __future__ import annotations

from common_utils import (
    ErrorCode,
    api_error,
    as_of_to_utc_iso,
    paginate_response,
    pagination_params,
    parse_as_of,
    parse_date,
    split_symbols,
)
from fastapi import APIRouter, Depends, Query

from common import get_logger
from common.supabase_client import get_supabase_client

logger = get_logger(__name__)
router = APIRouter()


VALID_STATEMENTS = {"profit", "balance", "cashflow", "growth", "operation"}


@router.get("/fundamentals", summary="查询财报")
async def list_fundamentals(
    symbols: str = Query(..., description="逗号分隔代码（最多 50）"),
    statement: str | None = Query(None, description=f"报表类型，可选: {sorted(VALID_STATEMENTS)}"),
    start: str | None = Query(None, description="announce_date >="),
    end: str | None = Query(None, description="announce_date <="),
    as_of: str | None = Query(
        None,
        description="截止时间（严格小于 announce_date），用于防未来函数",
    ),
    pg: dict = Depends(pagination_params),
):
    if statement is not None and statement not in VALID_STATEMENTS:
        raise api_error(
            ErrorCode.INVALID_PARAM,
            f"Invalid statement: {statement!r}. Valid: {sorted(VALID_STATEMENTS)}",
        )

    codes = split_symbols(symbols, max_count=50)
    if not codes:
        raise api_error(ErrorCode.INVALID_PARAM, "symbols is required")

    filters: dict[str, str] = {"symbol": f"in.({','.join(codes)})"}
    if statement:
        filters["statement"] = f"eq.{statement}"

    start_p = parse_date(start, name="start")
    end_p = parse_date(end, name="end")
    as_of_iso = as_of_to_utc_iso(parse_as_of(as_of))

    time_clauses: list[str] = []
    if start_p:
        time_clauses.append(f"announce_date.gte.{start_p[:10]}")
    if end_p:
        time_clauses.append(f"announce_date.lte.{end_p[:10]}")
    if as_of_iso:
        # announce_date 是 date 类型，转成 YYYY-MM-DD
        as_of_date = as_of_iso[:10]
        time_clauses.append(f"announce_date.lt.{as_of_date}")

    if len(time_clauses) == 1:
        key, val = time_clauses[0].split(".", 1)
        filters[key] = val
    elif len(time_clauses) > 1:
        filters["and"] = f"({','.join(time_clauses)})"

    client = get_supabase_client()
    total = client.count("fundamentals", filters=filters)

    offset = (pg["page"] - 1) * pg["page_size"]
    rows = client.select(
        "fundamentals",
        columns="symbol,report_date,announce_date,statement,data,derived,source",
        filters=filters,
        order="announce_date.asc,symbol.asc",
        limit=pg["page_size"],
        offset=offset,
    )

    return {
        **paginate_response(rows, **pg, total=total),
        "meta": {"as_of_applied": as_of_iso},
    }
