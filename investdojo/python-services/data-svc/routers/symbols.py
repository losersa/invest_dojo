"""股票元数据接口"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from common import get_logger
from common.supabase_client import get_supabase_client
from common_utils import (
    ErrorCode,
    api_error,
    pagination_params,
    paginate_response,
    split_symbols,
)

logger = get_logger(__name__)
router = APIRouter()


@router.get("/symbols", summary="查询股票列表")
async def list_symbols(
    codes: str | None = Query(None, description="逗号分隔的代码，如 '600519,000001'"),
    market: str | None = Query(None, pattern="^(SH|SZ|BJ)$"),
    industry: str | None = Query(None),
    status: str = Query("normal"),
    universe: str | None = Query(
        None, pattern="^(hs300|zz500|zz1000|all)$", description="指数池"
    ),
    search: str | None = Query(None, description="按名称/代码模糊搜索"),
    pg: dict = Depends(pagination_params),
):
    """查询股票列表（支持按代码/市场/行业/指数/搜索 + 分页）"""
    client = get_supabase_client()

    filters: dict[str, str] = {}
    if codes:
        code_list = split_symbols(codes, max_count=200)
        filters["code"] = f"in.({','.join(code_list)})"
    if market:
        filters["market"] = f"eq.{market}"
    if industry:
        filters["industry"] = f"eq.{industry}"
    # 状态别名映射：前端约定 normal/suspended/delisted；DB 里是 active/suspended/delisted
    STATUS_ALIAS = {"normal": "active", "active": "active",
                    "suspended": "suspended", "delisted": "delisted"}
    if status and status != "all":
        db_status = STATUS_ALIAS.get(status, status)
        filters["status"] = f"eq.{db_status}"
    if universe and universe != "all":
        # tags 是 JSONB array，用 cs.["..."]（JSONB 语法，不是 PostgreSQL array 的 {})
        tag = {"hs300": "沪深300", "zz500": "中证500", "zz1000": "中证1000"}[universe]
        import json as _json
        filters["tags"] = f"cs.{_json.dumps([tag], ensure_ascii=False)}"
    if search:
        # 同时匹配 code / name
        filters["or"] = f"(code.ilike.*{search}*,name.ilike.*{search}*)"

    # 先数总数
    total = client.count("symbols", filters=filters)

    # 分页查询
    offset = (pg["page"] - 1) * pg["page_size"]
    rows = client.select(
        "symbols",
        columns="code,market,name,short_name,industry,industry_level2,listed_at,"
        "delisted_at,total_share,float_share,status,tags",
        filters=filters,
        order="code.asc",
        limit=pg["page_size"],
        offset=offset,
    )
    return paginate_response(rows, **pg, total=total)


@router.get("/symbols/{code}", summary="单只股票详情")
async def get_symbol(code: str):
    client = get_supabase_client()
    rows = client.select(
        "symbols",
        filters={"code": f"eq.{code}"},
        limit=1,
    )
    if not rows:
        raise api_error(
            ErrorCode.NOT_FOUND,
            f"Symbol not found: {code}",
            status=404,
        )
    return {"data": rows[0]}


@router.get("/industries", summary="行业分类列表")
async def list_industries(
    level: int | None = Query(None, ge=1, le=2),
):
    client = get_supabase_client()
    filters: dict[str, str] = {}
    if level is not None:
        filters["level"] = f"eq.{level}"
    rows = client.select(
        "industries",
        columns="id,name,level,parent_id,code,symbol_count",
        filters=filters,
        order="level.asc,name.asc",
    )
    return {"data": rows}
