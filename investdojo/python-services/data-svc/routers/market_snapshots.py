"""市场快照接口"""
from __future__ import annotations

from fastapi import APIRouter, Query

from common import get_logger
from common.supabase_client import get_supabase_client
from common_utils import (
    ErrorCode,
    api_error,
    as_of_to_utc_iso,
    parse_as_of,
    parse_date,
)

logger = get_logger(__name__)
router = APIRouter()


@router.get("/market/snapshot", summary="查询市场快照")
async def get_snapshot(
    date: str = Query(..., description="查询日期 YYYY-MM-DD"),
    as_of: str | None = Query(
        None, description="若设置，date >= as_of 时拒绝返回（防未来函数）"
    ),
):
    d = parse_date(date, name="date")
    if not d:
        raise api_error(ErrorCode.INVALID_PARAM, "date is required")
    # 只取 YYYY-MM-DD 部分
    target_date = d[:10]

    # as_of 防未来
    as_of_iso = as_of_to_utc_iso(parse_as_of(as_of))
    if as_of_iso and target_date >= as_of_iso[:10]:
        raise api_error(
            ErrorCode.FUTURE_LEAK,
            f"Future leak: date={target_date} >= as_of={as_of_iso[:10]}",
            status=403,
        )

    client = get_supabase_client()
    rows = client.select(
        "market_snapshots",
        columns="date,indexes,north_capital,money_flow,advance_decline,top_industries",
        filters={"date": f"eq.{target_date}"},
        limit=1,
    )
    if not rows:
        raise api_error(
            ErrorCode.NOT_FOUND,
            f"No snapshot for {target_date}",
            status=404,
        )
    return {"data": rows[0], "meta": {"as_of_applied": as_of_iso}}


@router.get("/market/snapshots", summary="批量查询市场快照（按日期范围）")
async def list_snapshots(
    start: str = Query(..., description="开始日期"),
    end: str = Query(..., description="结束日期"),
    as_of: str | None = Query(None),
):
    start_p = parse_date(start, name="start")
    end_p = parse_date(end, name="end")
    as_of_iso = as_of_to_utc_iso(parse_as_of(as_of))

    start_d = start_p[:10] if start_p else None
    end_d = end_p[:10] if end_p else None
    as_of_d = as_of_iso[:10] if as_of_iso else None

    clauses: list[str] = []
    if start_d:
        clauses.append(f"date.gte.{start_d}")
    if end_d:
        clauses.append(f"date.lte.{end_d}")
    if as_of_d:
        clauses.append(f"date.lt.{as_of_d}")

    filters: dict[str, str] = {}
    if len(clauses) == 1:
        k, v = clauses[0].split(".", 1)
        filters[k] = v
    elif clauses:
        filters["and"] = f"({','.join(clauses)})"

    client = get_supabase_client()
    rows = client.select(
        "market_snapshots",
        columns="date,indexes,north_capital,money_flow,advance_decline,top_industries",
        filters=filters,
        order="date.asc",
        limit=1000,
    )
    return {"data": rows, "meta": {"as_of_applied": as_of_iso, "total": len(rows)}}
