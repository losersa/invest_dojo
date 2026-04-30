"""因子 CRUD + 详情

MVP（T-2.01）：读接口完整
Epic 3（T-3.01+）：写接口、计算接口

⚠️ 注意：FastAPI 按路由声明顺序匹配。`/factors/categories` / `/factors/tags` 必须
写在 `/factors/{factor_id}` 之前，否则会被 path parameter 吞掉。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from common import get_logger
from common.supabase_client import get_supabase_client
from common_utils import (
    ErrorCode,
    CATEGORY_LABELS,
    api_error,
    VALID_CATEGORIES,
    paginate_response,
    pagination_params,
    parse_sort,
    parse_tags,
)

logger = get_logger(__name__)
router = APIRouter()


# 可排序字段（stats_cache 里的也能排，用 JSONB 子路径）
VALID_SORT_FIELDS = {
    "updated_at",
    "created_at",
    "name",
    "version",
}


def _factor_row_to_api(row: dict) -> dict:
    """把 factor_definitions 的行变成 API schema。

    做的事：
    - 展开 stats_cache → stats
    - 去除内部字段 stats_cached_at
    - 保证 tags 是 list
    """
    if not row:
        return row
    out = dict(row)
    stats_cache = out.pop("stats_cache", None)
    out.pop("stats_cached_at", None)
    if stats_cache:
        out["stats"] = stats_cache
    if out.get("tags") is None:
        out["tags"] = []
    return out


@router.get("/factors", summary="查询因子列表（读）")
async def list_factors(
    category: str | None = Query(None, description=f"分类：{sorted(VALID_CATEGORIES)}"),
    tags: str | None = Query(None, description="逗号分隔，AND 关系"),
    owner: str = Query("all", pattern="^(platform|user|all)$"),
    visibility: str = Query("public", pattern="^(public|private|all)$"),
    search: str | None = Query(None, description="按 name/description 模糊搜索"),
    sort: str = Query("-updated_at", description="排序字段，- 开头表降序"),
    include_stats: bool = Query(True, description="是否包含 stats（关闭可加速）"),
    pg: dict = Depends(pagination_params),
):
    """查询因子列表（支持筛选/排序/分页）

    - `owner=platform` 只看官方因子；`owner=user` 只看用户自定义（owner != 'platform'）
    - `visibility=public` 默认只返公开的
    - 排序默认 `-updated_at`（最近更新优先）
    """
    if category and category not in VALID_CATEGORIES:
        raise api_error(
            ErrorCode.INVALID_PARAM,
            f"Invalid category: {category!r}. Valid: {sorted(VALID_CATEGORIES)}",
        )

    filters: dict[str, str] = {}
    if category:
        filters["category"] = f"eq.{category}"
    if owner == "platform":
        filters["owner"] = "eq.platform"
    elif owner == "user":
        filters["owner"] = "neq.platform"
    if visibility != "all":
        filters["visibility"] = f"eq.{visibility}"

    # tags：PostgREST 的 cs.[...] 是 JSONB array contains（注意不是 {...}）
    tag_list = parse_tags(tags)
    if tag_list:
        import json as _json
        filters["tags"] = f"cs.{_json.dumps(tag_list, ensure_ascii=False)}"

    if search:
        filters["or"] = f"(name.ilike.*{search}*,description.ilike.*{search}*)"

    # 已弃用因子不在列表里
    filters["deprecated_at"] = "is.null"

    sort_pair = parse_sort(sort, valid=VALID_SORT_FIELDS)
    order = f"{sort_pair[0]}.{sort_pair[1]}" if sort_pair else "updated_at.desc"

    client = get_supabase_client()
    total = client.count("factor_definitions", filters=filters)

    offset = (pg["page"] - 1) * pg["page_size"]
    columns = (
        "id,name,name_en,description,category,tags,formula,formula_type,"
        "output_type,output_range,lookback_days,update_frequency,version,"
        "owner,visibility,created_at,updated_at,deprecated_at"
    )
    if include_stats:
        columns += ",stats_cache,stats_cached_at"

    rows = client.select(
        "factor_definitions",
        columns=columns,
        filters=filters,
        order=order,
        limit=pg["page_size"],
        offset=offset,
    )
    data = [_factor_row_to_api(r) for r in rows]

    return paginate_response(data, **pg, total=total)


# ─── 静态路径必须在 /factors/{factor_id} 之前声明 ────────
@router.get("/factors/categories", summary="所有分类及其因子数量")
async def list_categories():
    """聚合公开、未弃用因子的 category 统计"""
    client = get_supabase_client()
    rows = client.select(
        "factor_definitions",
        columns="category",
        filters={"visibility": "eq.public", "deprecated_at": "is.null"},
    )
    counts: dict[str, int] = {}
    for r in rows:
        c = r.get("category")
        if c:
            counts[c] = counts.get(c, 0) + 1

    data = []
    for cat, label in CATEGORY_LABELS.items():
        data.append({
            "category": cat,
            "label": label,
            "count": counts.get(cat, 0),
        })
    return {"data": data}


@router.get("/factors/tags", summary="所有标签及出现次数")
async def list_tags():
    """聚合所有公开因子的 tag 统计（用于前端 autocomplete）"""
    client = get_supabase_client()
    rows = client.select(
        "factor_definitions",
        columns="tags",
        filters={"visibility": "eq.public", "deprecated_at": "is.null"},
    )
    tag_count: dict[str, int] = {}
    for r in rows:
        for t in r.get("tags") or []:
            tag_count[t] = tag_count.get(t, 0) + 1
    data = [
        {"tag": k, "count": v}
        for k, v in sorted(tag_count.items(), key=lambda x: -x[1])
    ]
    return {"data": data}


@router.get("/factors/{factor_id}", summary="因子详情")
async def get_factor(
    factor_id: str,
    include_stats: bool = Query(True),
):
    client = get_supabase_client()
    rows = client.select(
        "factor_definitions",
        filters={"id": f"eq.{factor_id}"},
        limit=1,
    )
    if not rows:
        raise api_error(
            ErrorCode.FACTOR_NOT_FOUND,
            f"Factor with id '{factor_id}' does not exist",
            status=404,
            factor_id=factor_id,
        )
    row = rows[0]
    data = _factor_row_to_api(row)
    if not include_stats:
        data.pop("stats", None)
    # Epic 3 会加 examples（触发案例），这里先省略
    return {"data": data}


@router.get("/factors/{factor_id}/history", summary="因子历史值时间序列（占位）")
async def get_factor_history(
    factor_id: str,
    symbols: str = Query(..., description="逗号分隔，最多 20 个"),
    start: str | None = Query(None),
    end: str | None = Query(None),
    format: str = Query("long", pattern="^(long|wide)$"),
):
    """因子在指定股票上的历史值（读 factor_values 分区表）

    MVP（T-2.01）：只返回占位结构，Epic 3 完善计算/回填后启用。
    """
    # 占位：返回空数据，避免前端白屏
    return {
        "data": [] if format == "long" else {"dates": [], "symbols": {}},
        "meta": {
            "factor_id": factor_id,
            "status": "not_computed",
            "message": "Factor values not yet computed. Will be implemented in Epic 3 (T-3.01).",
        },
    }
