"""因子 CRUD + 详情

MVP（T-2.01）：读接口完整
Epic 3（T-3.01+）：写接口、计算接口

⚠️ 注意：FastAPI 按路由声明顺序匹配。`/factors/categories` / `/factors/tags` / `/factors/validate`
必须写在 `/factors/{factor_id}` 之前，否则会被 path parameter 吞掉。
"""

from __future__ import annotations

from common_utils import (
    CATEGORY_LABELS,
    VALID_CATEGORIES,
    ErrorCode,
    api_error,
    paginate_response,
    pagination_params,
    parse_sort,
    parse_tags,
)
from factors import DSLError, UnknownFunctionError, dump_ast, eval_ast, parse_formula
from factors.engine import EngineError
from factors.panel_loader import load_panel
from fastapi import APIRouter, Body, Depends, Query
from pydantic import BaseModel, Field

from common import get_logger
from common.supabase_client import get_supabase_client

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
        data.append(
            {
                "category": cat,
                "label": label,
                "count": counts.get(cat, 0),
            }
        )
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
    data = [{"tag": k, "count": v} for k, v in sorted(tag_count.items(), key=lambda x: -x[1])]
    return {"data": data}


# ─── 因子 DSL 校验（T-3.01）─────────────────────────────
class PreviewSpec(BaseModel):
    """validate 预览参数（可选）"""

    symbols: list[str] = Field(default_factory=list, description="预览用的股票列表，最多 5 只")
    start: str | None = Field(None, description="YYYY-MM-DD")
    end: str | None = Field(None, description="YYYY-MM-DD")


class ValidateFormulaRequest(BaseModel):
    """POST /factors/validate 请求体

    参考 docs/api/02_因子库API.md §4.4
    """

    formula: str = Field(
        ..., description="DSL 表达式", examples=["MA(close, 20) cross_up MA(close, 60)"]
    )
    formula_type: str = Field("dsl", pattern="^(dsl|python)$")
    preview: PreviewSpec | None = Field(
        None, description="可选：给定样本区间 + 股票，返回前 N 行计算结果"
    )


def _df_to_preview_rows(result, symbols: list[str], limit: int = 20) -> list[dict]:
    """DataFrame/Series 结果 → 前端友好的长表记录"""
    import numpy as np  # noqa: PLC0415
    import pandas as pd  # noqa: PLC0415

    if not isinstance(result, pd.DataFrame):
        if isinstance(result, pd.Series):
            result = result.to_frame(name="value")
        else:
            return []
    # 只取有数据的日期（drop 前置 NaN 段）
    result = result.dropna(how="all").tail(limit)

    # 根据 dtype 决定序列化方式：bool → true/false，数值 → float
    is_boolean = result.dtypes.apply(lambda d: d is bool or d is np.bool_ or str(d) == "bool").all()

    rows: list[dict] = []
    for dt, row in result.iterrows():
        dt_str = dt.strftime("%Y-%m-%d") if hasattr(dt, "strftime") else str(dt)
        for sym in symbols:
            if sym not in row:
                continue
            val = row[sym]
            if pd.isna(val):
                continue
            if is_boolean or isinstance(val, (bool, np.bool_)):
                rows.append({"symbol": sym, "date": dt_str, "value": bool(val)})
            else:
                rows.append({"symbol": sym, "date": dt_str, "value": float(val)})
    return rows


@router.post("/factors/validate", summary="校验因子公式（不保存）")
async def validate_formula(payload: ValidateFormulaRequest = Body(...)):
    """解析 + 语义校验 + 推断，返回 AST 和推断结果

    - 合法：`valid=true` + `parsed_ast` + `inferred_output_type` + `inferred_lookback`
    - 非法：`valid=false` + `error.code` ∈ {INVALID_FORMULA, UNKNOWN_FUNCTION} + `error.detail.position`
    - 可选：带 preview.symbols/start/end 时返回真实计算的前 20 行样本

    注：Python 公式暂不支持（走 mock 返回 valid=true），留给后续 Epic。
    """
    if payload.formula_type == "python":
        return {
            "data": {
                "valid": True,
                "parsed_ast": None,
                "inferred_output_type": "scalar",
                "inferred_lookback": 0,
                "preview_result": [],
                "warnings": ["Python formula parsing is not yet implemented; treating as scalar."],
            }
        }

    try:
        result = parse_formula(payload.formula)
    except (DSLError, UnknownFunctionError) as e:
        return {
            "data": {
                "valid": False,
                "parsed_ast": None,
                "error": {
                    "code": e.code,
                    "message": e.message,
                    "detail": e.to_detail(),
                },
            }
        }

    preview_rows: list[dict] = []
    warnings: list[str] = []

    # 带 preview 参数时，真实读 K 线 + 跑 engine
    if payload.preview and payload.preview.symbols:
        spec = payload.preview
        symbols = spec.symbols[:5]  # 最多 5 只
        start = spec.start or "2024-01-01"
        end = spec.end or "2024-12-31"
        try:
            panel = load_panel(
                symbols,
                start=start,
                end=end,
                extra_days=result.lookback_days,
                needed_fields=result.fields,
            )
            if not panel:
                warnings.append("preview: no kline data found for given symbols/dates")
            else:
                compute_result = eval_ast(result.ast, panel)
                preview_rows = _df_to_preview_rows(compute_result, symbols, limit=20)
        except EngineError as e:
            warnings.append(f"preview compute error: {e.message}")
        except Exception as e:  # noqa: BLE001 - 预览失败不能 kill validate
            logger.warning("validate.preview.failed", error=str(e))
            warnings.append(f"preview failed: {e.__class__.__name__}")

    return {
        "data": {
            "valid": True,
            "parsed_ast": dump_ast(result.ast),
            "inferred_output_type": result.output_type,
            "inferred_lookback": result.lookback_days,
            "preview_result": preview_rows,
            "warnings": warnings,
        }
    }


# ─── 因子计算（T-3.02）─────────────────────────────
class ComputeFactorRequest(BaseModel):
    """POST /factors/compute 请求体

    支持两种方式：
    - factor_id：从 factor_definitions 读公式
    - formula：直接传公式（用户还没保存时）
    """

    factor_id: str | None = Field(None, description="已注册因子 ID")
    formula: str | None = Field(None, description="临时公式（不保存）")
    formula_type: str = Field("dsl", pattern="^(dsl|python)$")
    symbols: list[str] = Field(..., min_length=1, max_length=100)
    start: str = Field(..., description="YYYY-MM-DD")
    end: str = Field(..., description="YYYY-MM-DD")
    scenario_id: str | None = Field(None)
    format: str = Field("long", pattern="^(long|wide)$")


@router.post("/factors/compute", summary="计算因子值（T-3.02）")
async def compute_factor(payload: ComputeFactorRequest = Body(...)):
    """给定因子/公式和股票/日期，实时计算因子值。

    - `factor_id` 或 `formula` 至少给一个
    - `format=long`：[{symbol, date, value}, ...]
    - `format=wide`：{dates: [...], symbols: {sym: [values]}}
    """
    # 解析公式
    if payload.factor_id:
        client = get_supabase_client()
        rows = client.select(
            "factor_definitions",
            filters={"id": f"eq.{payload.factor_id}"},
            limit=1,
        )
        if not rows:
            raise api_error(
                ErrorCode.FACTOR_NOT_FOUND,
                f"Factor '{payload.factor_id}' does not exist",
                status=404,
                factor_id=payload.factor_id,
            )
        formula = rows[0]["formula"]
        formula_type = rows[0].get("formula_type", "dsl")
    elif payload.formula:
        formula = payload.formula
        formula_type = payload.formula_type
    else:
        raise api_error(
            ErrorCode.INVALID_PARAM,
            "Either factor_id or formula must be provided",
        )

    if formula_type != "dsl":
        raise api_error(
            ErrorCode.INVALID_PARAM,
            "Python formula compute not yet supported",
        )

    try:
        parsed = parse_formula(formula)
    except (DSLError, UnknownFunctionError) as e:
        raise api_error(e.code, e.message, status=422, **e.to_detail()) from e

    # 拉数据
    panel = load_panel(
        payload.symbols,
        start=payload.start,
        end=payload.end,
        scenario_id=payload.scenario_id,
        extra_days=parsed.lookback_days,
        needed_fields=parsed.fields,
    )
    if not panel or "close" not in panel:
        return {
            "data": [] if payload.format == "long" else {"dates": [], "symbols": {}},
            "meta": {
                "factor_id": payload.factor_id,
                "status": "no_data",
                "message": "No kline data found for given symbols/dates",
            },
        }

    # 执行计算
    try:
        result = eval_ast(parsed.ast, panel)
    except EngineError as e:
        raise api_error("COMPUTE_ERROR", e.message, status=503) from e

    # 裁到 start~end 区间（扣掉预热期）
    import pandas as pd  # noqa: PLC0415

    # result.index 可能带时区（来自 Supabase timestamptz），比较前对齐
    idx = result.index
    if getattr(idx, "tz", None) is not None:
        start_ts = pd.Timestamp(payload.start, tz=idx.tz)
        end_ts = pd.Timestamp(payload.end, tz=idx.tz) + pd.Timedelta(days=1)
    else:
        start_ts = pd.Timestamp(payload.start)
        end_ts = pd.Timestamp(payload.end) + pd.Timedelta(days=1)
    mask = (idx >= start_ts) & (idx < end_ts)
    result = result.loc[mask]

    # 格式化
    if payload.format == "long":
        data = _df_to_preview_rows(result, payload.symbols, limit=10_000)
    else:
        dates = [d.strftime("%Y-%m-%d") for d in result.index]
        symbols_dict: dict[str, list] = {}
        for sym in payload.symbols:
            if sym in result.columns:
                col = result[sym]
                symbols_dict[sym] = [
                    None if pd.isna(v) else (bool(v) if isinstance(v, bool) else float(v))
                    for v in col
                ]
        data = {"dates": dates, "symbols": symbols_dict}

    return {
        "data": data,
        "meta": {
            "factor_id": payload.factor_id,
            "output_type": parsed.output_type,
            "lookback_days": parsed.lookback_days,
            "rows": len(result),
            "symbols": len(payload.symbols),
        },
    }


# ─── /factors/{factor_id} 必须放在所有静态路径之后 ────────
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
