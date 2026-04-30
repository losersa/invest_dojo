"""新闻接口"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from common import get_logger
from common.supabase_client import get_supabase_client
from common_utils import (
    ErrorCode,
    api_error,
    as_of_to_utc_iso,
    pagination_params,
    paginate_response,
    parse_as_of,
    parse_date,
)

logger = get_logger(__name__)
router = APIRouter()


@router.get("/news", summary="查询新闻事件流")
async def list_news(
    start: str | None = Query(None, description="开始日期"),
    end: str | None = Query(None, description="结束日期"),
    as_of: str | None = Query(None, description="防未来函数截断"),
    category: str | None = Query(
        None, pattern="^(macro|policy|industry|company|market|international)$"
    ),
    symbol: str | None = Query(None, description="关联股票代码"),
    scenario_id: str | None = Query(None),
    pg: dict = Depends(pagination_params),
):
    """查询新闻（支持 as_of 防未来函数）"""
    filters: dict[str, str] = {}
    if category:
        filters["category"] = f"eq.{category}"
    if scenario_id:
        filters["scenario_id"] = f"eq.{scenario_id}"
    if symbol:
        filters["related_symbols"] = f"cs.{{{symbol}}}"

    # 时间约束
    start_p = parse_date(start, name="start")
    end_p = parse_date(end, name="end")
    as_of_iso = as_of_to_utc_iso(parse_as_of(as_of))

    time_clauses: list[str] = []
    if start_p:
        time_clauses.append(f"published_at.gte.{start_p}")
    if end_p:
        time_clauses.append(f"published_at.lte.{end_p}")
    if as_of_iso:
        time_clauses.append(f"published_at.lt.{as_of_iso}")

    if len(time_clauses) == 1:
        key, val = time_clauses[0].split(".", 1)
        filters[key] = val
    elif len(time_clauses) > 1:
        filters["and"] = f"({','.join(time_clauses)})"

    client = get_supabase_client()
    total = client.count("news", filters=filters)

    offset = (pg["page"] - 1) * pg["page_size"]
    rows = client.select(
        "news",
        columns="id,scenario_id,published_at,title,content,source,category,"
        "sentiment,sentiment_score,impact_level,related_symbols,tags,url",
        filters=filters,
        order="published_at.asc",
        limit=pg["page_size"],
        offset=offset,
    )

    return {
        **paginate_response(rows, **pg, total=total),
        "meta": {"as_of_applied": as_of_iso},
    }
