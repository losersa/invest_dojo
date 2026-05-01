"""因子 CRUD + 详情

MVP（T-2.01）：读接口完整
Epic 3（T-3.01+）：写接口、计算接口
Epic 3（T-3.06）：补 POST/PUT/DELETE/batch-query/compare/publish/history 真实查

⚠️ 注意：FastAPI 按路由声明顺序匹配。`/factors/categories` / `/factors/tags` / `/factors/validate`
必须写在 `/factors/{factor_id}` 之前，否则会被 path parameter 吞掉。
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

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
from fastapi import APIRouter, Body, Depends, Header, Query
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


# ═══════════════════════════════════════════════════════════════
# T-3.06 · 因子 CRUD（POST / PUT / DELETE）
# ═══════════════════════════════════════════════════════════════


def _get_user_id(x_user_id: str | None) -> str:
    """MVP：从 header 读 user_id；生产应接 Supabase Auth JWT"""
    return x_user_id or "anon"


def _gen_custom_factor_id(name: str, user_id: str) -> str:
    """生成自定义因子 id：custom_{user}_{short_uuid}"""
    return f"custom_{user_id[:8]}_{uuid4().hex[:8]}"


class FactorCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    name_en: str | None = None
    description: str | None = None
    long_description: str | None = None
    category: str = Field("custom")
    tags: list[str] = Field(default_factory=list)
    formula: str = Field(..., min_length=1)
    formula_type: str = Field("dsl", pattern="^(dsl|python)$")
    output_type: str | None = Field(None, pattern="^(boolean|scalar|rank)$")
    output_range: list[float] | None = None
    lookback_days: int | None = None
    update_frequency: str = Field("daily", pattern="^(daily|realtime|hourly)$")
    visibility: str = Field("private", pattern="^(public|private|unlisted)$")


class FactorUpdateRequest(BaseModel):
    """PUT 所有字段可选"""

    name: str | None = None
    name_en: str | None = None
    description: str | None = None
    long_description: str | None = None
    tags: list[str] | None = None
    formula: str | None = None
    formula_type: str | None = Field(None, pattern="^(dsl|python)$")
    output_type: str | None = Field(None, pattern="^(boolean|scalar|rank)$")
    output_range: list[float] | None = None
    lookback_days: int | None = None
    visibility: str | None = Field(None, pattern="^(public|private|unlisted)$")


def _infer_from_formula(formula: str, formula_type: str) -> tuple[str, int, dict | None]:
    """解析公式拿到 output_type / lookback / ast（python 类型跳过）

    返回 (output_type, lookback_days, parsed_ast_dict or None)
    """
    if formula_type != "dsl":
        return "scalar", 0, None
    try:
        r = parse_formula(formula)
    except (DSLError, UnknownFunctionError) as e:
        raise api_error(
            e.code if e.code in ("UNKNOWN_FUNCTION",) else ErrorCode.INVALID_FORMULA,
            e.message,
            status=422,
            **e.to_detail(),
        ) from e
    return r.output_type, r.lookback_days, dump_ast(r.ast)


@router.post("/factors", status_code=201, summary="新建自定义因子")
async def create_factor(
    payload: FactorCreateRequest = Body(...),
    x_user_id: str | None = Header(None, alias="X-User-Id"),
):
    """创建一个自定义因子（owner != platform）

    - 公式必须解析通过（INVALID_FORMULA / UNKNOWN_FUNCTION）
    - category 非法 → 400
    - 同 owner 同 name 重复 → 409 FACTOR_NAME_DUPLICATE
    - 未指定 output_type / lookback_days 时从 AST 推断
    """
    if payload.category not in VALID_CATEGORIES:
        raise api_error(
            ErrorCode.INVALID_PARAM,
            f"Invalid category: {payload.category!r}. Valid: {sorted(VALID_CATEGORIES)}",
        )

    owner = _get_user_id(x_user_id)

    # 重名检查（同 owner 下）
    client = get_supabase_client()
    dups = client.select(
        "factor_definitions",
        columns="id",
        filters={"owner": f"eq.{owner}", "name": f"eq.{payload.name}"},
        limit=1,
    )
    if dups:
        raise api_error(
            ErrorCode.FACTOR_NAME_DUPLICATE,
            f"You already have a factor named {payload.name!r}",
            status=409,
        )

    # 推断
    inferred_output, inferred_lookback, _ast = _infer_from_formula(
        payload.formula, payload.formula_type
    )
    output_type = payload.output_type or inferred_output
    lookback = payload.lookback_days if payload.lookback_days is not None else inferred_lookback

    factor_id = _gen_custom_factor_id(payload.name, owner)
    row = {
        "id": factor_id,
        "name": payload.name,
        "name_en": payload.name_en,
        "description": payload.description or "",
        "long_description": payload.long_description,
        "category": payload.category,
        "tags": payload.tags,
        "formula": payload.formula,
        "formula_type": payload.formula_type,
        "output_type": output_type,
        "output_range": payload.output_range,
        "lookback_days": lookback,
        "update_frequency": payload.update_frequency,
        "version": 1,
        "owner": owner,
        "visibility": payload.visibility,
    }
    try:
        inserted = client.insert("factor_definitions", [row])
    except Exception as e:  # noqa: BLE001
        logger.exception("factor.create.db_failed", user=owner, name=payload.name)
        raise api_error("DB_ERROR", f"Failed to insert factor: {e}", status=500) from e

    return {"data": _factor_row_to_api(inserted[0] if inserted else row)}


@router.put("/factors/{factor_id}", summary="更新自定义因子")
async def update_factor(
    factor_id: str,
    payload: FactorUpdateRequest = Body(...),
    x_user_id: str | None = Header(None, alias="X-User-Id"),
):
    """更新：只有 owner 可改；platform 因子拒绝。
    如果改了 formula，自动重新推断 output_type / lookback_days。
    """
    client = get_supabase_client()
    existing = client.select(
        "factor_definitions",
        filters={"id": f"eq.{factor_id}"},
        limit=1,
    )
    if not existing:
        raise api_error(
            ErrorCode.FACTOR_NOT_FOUND,
            f"Factor {factor_id!r} not found",
            status=404,
            factor_id=factor_id,
        )
    row = existing[0]
    if row["owner"] == "platform":
        raise api_error(
            ErrorCode.FACTOR_PERMISSION_DENIED,
            "Platform factors are not editable",
            status=403,
        )
    user = _get_user_id(x_user_id)
    if row["owner"] != user:
        raise api_error(
            ErrorCode.FACTOR_PERMISSION_DENIED,
            "Only the owner can update this factor",
            status=403,
        )

    patch: dict = {}
    for field in (
        "name",
        "name_en",
        "description",
        "long_description",
        "tags",
        "output_range",
        "update_frequency",
        "visibility",
    ):
        val = getattr(payload, field, None)
        if val is not None:
            patch[field] = val

    # 改公式：重新推断 + version +1
    if payload.formula and payload.formula != row.get("formula"):
        formula_type = payload.formula_type or row.get("formula_type", "dsl")
        out, lb, _ = _infer_from_formula(payload.formula, formula_type)
        patch["formula"] = payload.formula
        patch["formula_type"] = formula_type
        patch["output_type"] = payload.output_type or out
        patch["lookback_days"] = payload.lookback_days if payload.lookback_days is not None else lb
        patch["version"] = int(row.get("version") or 1) + 1
    else:
        # 只显式设了 output_type / lookback 也能改
        if payload.output_type is not None:
            patch["output_type"] = payload.output_type
        if payload.lookback_days is not None:
            patch["lookback_days"] = payload.lookback_days

    if not patch:
        return {"data": _factor_row_to_api(row)}

    patch["updated_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"

    import httpx as _httpx  # noqa: PLC0415

    url = f"{client.url}/rest/v1/factor_definitions?id=eq.{factor_id}"
    resp = client._http.patch(url, json=patch, headers={"Prefer": "return=representation"})
    try:
        resp.raise_for_status()
    except _httpx.HTTPStatusError as e:
        logger.error("factor.update.db_failed", factor_id=factor_id, body=resp.text[:200])
        raise api_error("DB_ERROR", f"Update failed: {e}", status=500) from e
    updated_rows = resp.json()
    if not updated_rows:
        raise api_error(ErrorCode.FACTOR_NOT_FOUND, "After update, row not found", status=404)
    return {"data": _factor_row_to_api(updated_rows[0])}


@router.delete("/factors/{factor_id}", status_code=204, summary="删除自定义因子")
async def delete_factor(
    factor_id: str,
    x_user_id: str | None = Header(None, alias="X-User-Id"),
):
    """删除：owner 可删；platform 不可删；被引用时 409。

    MVP：暂不检查"被模型训练用过"（model_factors 关联表 Epic 3 后续加）。
    但至少检查 feature_values 是否已有数据（有就软删 = 标记 deprecated）。
    """
    client = get_supabase_client()
    existing = client.select(
        "factor_definitions",
        filters={"id": f"eq.{factor_id}"},
        limit=1,
    )
    if not existing:
        raise api_error(
            ErrorCode.FACTOR_NOT_FOUND,
            f"Factor {factor_id!r} not found",
            status=404,
        )
    row = existing[0]
    if row["owner"] == "platform":
        raise api_error(
            ErrorCode.FACTOR_PERMISSION_DENIED,
            "Platform factors cannot be deleted",
            status=403,
        )
    user = _get_user_id(x_user_id)
    if row["owner"] != user:
        raise api_error(
            ErrorCode.FACTOR_PERMISSION_DENIED,
            "Only the owner can delete this factor",
            status=403,
        )

    # 检查是否有 feature_values 数据，有则软删
    values = client.select(
        "feature_values",
        columns="factor_id",
        filters={"factor_id": f"eq.{factor_id}"},
        limit=1,
    )

    if values:
        # 软删：标记 deprecated_at

        url = f"{client.url}/rest/v1/factor_definitions?id=eq.{factor_id}"
        resp = client._http.patch(
            url,
            json={"deprecated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z"},
        )
        resp.raise_for_status()
        logger.info("factor.soft_delete", factor_id=factor_id, reason="has_feature_values")
    else:
        # 硬删
        client.delete("factor_definitions", filters={"id": f"eq.{factor_id}"})
        logger.info("factor.hard_delete", factor_id=factor_id)

    return None


@router.post("/factors/{factor_id}/publish", summary="发布私有因子为公开")
async def publish_factor(
    factor_id: str,
    payload: dict = Body(default_factory=dict),  # noqa: B008
    x_user_id: str | None = Header(None, alias="X-User-Id"),
):
    """private → public。发布后进入因子市场，其他用户可订阅。

    Body 可选：
    - long_description: 完整说明
    - license: 如 MIT
    """
    client = get_supabase_client()
    existing = client.select(
        "factor_definitions",
        filters={"id": f"eq.{factor_id}"},
        limit=1,
    )
    if not existing:
        raise api_error(ErrorCode.FACTOR_NOT_FOUND, f"Factor {factor_id!r} not found", status=404)
    row = existing[0]
    if row["owner"] == "platform":
        raise api_error(
            ErrorCode.FACTOR_PERMISSION_DENIED, "Platform factor already public", status=400
        )
    user = _get_user_id(x_user_id)
    if row["owner"] != user:
        raise api_error(ErrorCode.FACTOR_PERMISSION_DENIED, "Only owner can publish", status=403)

    patch = {
        "visibility": "public",
        "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    if payload.get("long_description"):
        patch["long_description"] = payload["long_description"]

    url = f"{client.url}/rest/v1/factor_definitions?id=eq.{factor_id}"
    resp = client._http.patch(url, json=patch, headers={"Prefer": "return=representation"})
    resp.raise_for_status()
    updated = resp.json()
    return {"data": _factor_row_to_api(updated[0]) if updated else row}


# ═══════════════════════════════════════════════════════════════
# T-3.06 · 批量查询 & 对比
# ═══════════════════════════════════════════════════════════════


class BatchQueryRequest(BaseModel):
    factor_ids: list[str] = Field(..., min_length=1, max_length=50)
    symbols: list[str] = Field(..., min_length=1, max_length=100)
    date: str = Field(..., description="YYYY-MM-DD 单日")


@router.post("/factors/batch-query", summary="批量查询多因子多股票的值（矩阵返回）")
async def batch_query(payload: BatchQueryRequest = Body(...)):
    """从 feature_values 表拿预计算好的值。

    返回矩阵格式：
        values[symbol_idx][factor_idx]
    """
    client = get_supabase_client()

    rows = client.select_all(
        "feature_values",
        columns="factor_id,symbol,value_num,value_bool",
        filters={
            "factor_id": f"in.({','.join(payload.factor_ids)})",
            "symbol": f"in.({','.join(payload.symbols)})",
            "date": f"eq.{payload.date}",
        },
        page_size=1000,
    )

    # 构建矩阵（保持入参顺序）
    lookup: dict[tuple[str, str], object] = {}
    for r in rows:
        fid = r["factor_id"]
        sym = r["symbol"]
        val = r["value_num"] if r["value_num"] is not None else r["value_bool"]
        lookup[(sym, fid)] = val

    values = []
    for sym in payload.symbols:
        row_vals = []
        for fid in payload.factor_ids:
            row_vals.append(lookup.get((sym, fid)))
        values.append(row_vals)

    return {
        "data": {
            "date": payload.date,
            "factors": payload.factor_ids,
            "symbols": payload.symbols,
            "values": values,
        },
        "meta": {
            "rows_matched": len(rows),
            "rows_expected": len(payload.symbols) * len(payload.factor_ids),
        },
    }


class CompareRequest(BaseModel):
    factor_ids: list[str] = Field(..., min_length=2, max_length=10)
    start: str
    end: str
    metrics: list[str] = Field(
        default_factory=lambda: ["trigger_count", "trigger_rate"],
        description="支持: trigger_count / trigger_rate / avg_value",
    )


@router.post("/factors/compare", summary="多因子对比（从 feature_values 聚合）")
async def compare_factors(payload: CompareRequest = Body(...)):
    """多因子在同一时间窗口上的表现对比。

    MVP 指标（从 feature_values 聚合，不算未来收益）：
    - trigger_count: 有多少条 value_bool=true 记录（仅 boolean 因子）
    - trigger_rate: trigger_count / 总条数
    - avg_value: value_num 的均值（仅 scalar 因子）
    - coverage_symbols: 覆盖的股票数

    说明：winrate/sharpe 这些涉及"未来 N 日收益"，需要模型/回测联动，Epic 4 做。
    """
    client = get_supabase_client()

    # 拉所有因子的定义（拿到 output_type）
    defs_rows = client.select(
        "factor_definitions",
        columns="id,name,output_type",
        filters={"id": f"in.({','.join(payload.factor_ids)})"},
        limit=len(payload.factor_ids),
    )
    defs = {r["id"]: r for r in defs_rows}

    comparison = []
    for fid in payload.factor_ids:
        d = defs.get(fid)
        if not d:
            comparison.append({"factor_id": fid, "error": "not_found"})
            continue

        # 拉值
        values = client.select_all(
            "feature_values",
            columns="symbol,date,value_num,value_bool",
            filters={
                "factor_id": f"eq.{fid}",
                "and": f"(date.gte.{payload.start},date.lte.{payload.end})",
            },
            page_size=1000,
        )
        if not values:
            comparison.append(
                {"factor_id": fid, "name": d["name"], "total": 0, "coverage_symbols": 0}
            )
            continue

        symbols_covered = len({v["symbol"] for v in values})
        total = len(values)
        row = {
            "factor_id": fid,
            "name": d["name"],
            "output_type": d["output_type"],
            "total": total,
            "coverage_symbols": symbols_covered,
        }

        if d["output_type"] == "boolean":
            trig = sum(1 for v in values if v.get("value_bool") is True)
            if "trigger_count" in payload.metrics:
                row["trigger_count"] = trig
            if "trigger_rate" in payload.metrics:
                row["trigger_rate"] = round(trig / total, 4) if total else 0.0
        elif d["output_type"] == "scalar" and "avg_value" in payload.metrics:
            nums = [v["value_num"] for v in values if v.get("value_num") is not None]
            row["avg_value"] = round(sum(nums) / len(nums), 4) if nums else None

        comparison.append(row)

    # winner_by_metric：每个指标选数值最大的
    winner: dict[str, str] = {}
    for metric in payload.metrics:
        best_fid = None
        best_val = None
        for c in comparison:
            v = c.get(metric)
            if v is None:
                continue
            if best_val is None or v > best_val:
                best_val = v
                best_fid = c["factor_id"]
        if best_fid:
            winner[metric] = best_fid

    return {
        "data": {
            "comparison": comparison,
            "winner_by_metric": winner,
            "window": {"start": payload.start, "end": payload.end},
        }
    }


# ─── /factors/{factor_id} 必须放在所有静态路径和 history/performance 之后 ────────


@router.get("/factors/{factor_id}/history", summary="因子历史值时间序列（T-3.06 接真实数据）")
async def get_factor_history(
    factor_id: str,
    symbols: str = Query(..., description="逗号分隔，最多 20 个"),
    start: str | None = Query(None),
    end: str | None = Query(None),
    format: str = Query("long", pattern="^(long|wide)$"),
):
    """从 feature_values 表读预计算的因子历史值。

    - long：`[{symbol, date, value}, ...]`
    - wide：`{dates: [...], symbols: {sym: [values]}}`

    如果该 (factor, symbol, date 区间) 还没跑过，返回空 + status=not_computed。
    """
    symbol_list = [s.strip() for s in symbols.split(",") if s.strip()][:20]
    if not symbol_list:
        raise api_error(ErrorCode.INVALID_PARAM, "symbols cannot be empty")

    client = get_supabase_client()
    # 确认因子存在
    existing = client.select(
        "factor_definitions", columns="id,output_type", filters={"id": f"eq.{factor_id}"}, limit=1
    )
    if not existing:
        raise api_error(
            ErrorCode.FACTOR_NOT_FOUND,
            f"Factor {factor_id!r} not found",
            status=404,
        )
    output_type = existing[0].get("output_type")

    # 查 feature_values
    filters: dict[str, str] = {
        "factor_id": f"eq.{factor_id}",
        "symbol": f"in.({','.join(symbol_list)})",
    }
    if start and end:
        filters["and"] = f"(date.gte.{start},date.lte.{end})"
    elif start:
        filters["date"] = f"gte.{start}"
    elif end:
        filters["date"] = f"lte.{end}"

    rows = client.select_all(
        "feature_values",
        columns="symbol,date,value_num,value_bool",
        filters=filters,
        order="date.asc",
        page_size=1000,
    )

    def _val(r):
        return r["value_bool"] if r["value_num"] is None else r["value_num"]

    if format == "long":
        data = [{"symbol": r["symbol"], "date": r["date"], "value": _val(r)} for r in rows]
        return {
            "data": data,
            "meta": {
                "factor_id": factor_id,
                "output_type": output_type,
                "rows": len(data),
                "status": "ok" if data else "not_computed",
            },
        }
    else:  # wide
        dates_set: set[str] = set()
        by_sym: dict[str, dict[str, object]] = {s: {} for s in symbol_list}
        for r in rows:
            dates_set.add(r["date"])
            by_sym[r["symbol"]][r["date"]] = _val(r)
        dates_sorted = sorted(dates_set)
        symbols_out = {s: [by_sym[s].get(d) for d in dates_sorted] for s in symbol_list}
        return {
            "data": {"dates": dates_sorted, "symbols": symbols_out},
            "meta": {
                "factor_id": factor_id,
                "output_type": output_type,
                "dates": len(dates_sorted),
                "status": "ok" if dates_sorted else "not_computed",
            },
        }


@router.get(
    "/factors/{factor_id}/performance",
    summary="因子历史表现统计（MVP：从 feature_values 聚合）",
)
async def get_factor_performance(
    factor_id: str,
    start: str | None = Query(None, description="YYYY-MM-DD"),
    end: str | None = Query(None, description="YYYY-MM-DD"),
):
    """给前端详情页展示：这个因子历史上的触发/分布情况。

    MVP 指标（无未来收益概念，Epic 4 回测后补 winrate/sharpe）：
    - total_records: 预计算的总条数
    - coverage_symbols: 覆盖多少支股票
    - coverage_days: 覆盖多少个交易日
    - boolean: trigger_count, trigger_rate
    - scalar: min / max / mean / std
    """
    client = get_supabase_client()
    existing = client.select(
        "factor_definitions", columns="id,output_type", filters={"id": f"eq.{factor_id}"}, limit=1
    )
    if not existing:
        raise api_error(ErrorCode.FACTOR_NOT_FOUND, f"Factor {factor_id!r} not found", status=404)
    output_type = existing[0].get("output_type")

    filters: dict[str, str] = {"factor_id": f"eq.{factor_id}"}
    if start and end:
        filters["and"] = f"(date.gte.{start},date.lte.{end})"

    rows = client.select_all(
        "feature_values",
        columns="symbol,date,value_num,value_bool",
        filters=filters,
        page_size=1000,
    )

    coverage_symbols = len({r["symbol"] for r in rows})
    coverage_days = len({r["date"] for r in rows})
    total = len(rows)
    data: dict = {
        "factor_id": factor_id,
        "output_type": output_type,
        "total_records": total,
        "coverage_symbols": coverage_symbols,
        "coverage_days": coverage_days,
        "window": {"start": start, "end": end},
    }

    if output_type == "boolean":
        trig = sum(1 for r in rows if r.get("value_bool") is True)
        data["trigger_count"] = trig
        data["trigger_rate"] = round(trig / total, 4) if total else 0.0
    elif output_type == "scalar":
        nums = [r["value_num"] for r in rows if r.get("value_num") is not None]
        if nums:
            n = len(nums)
            m = sum(nums) / n
            var = sum((x - m) ** 2 for x in nums) / n
            data["min"] = min(nums)
            data["max"] = max(nums)
            data["mean"] = round(m, 4)
            data["std"] = round(var**0.5, 4)

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
    return {"data": data}
