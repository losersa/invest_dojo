"""K 线接口 —— 强制 as_of 注入，核心接口

核心约定：
- `as_of` 参数生效时，会自动翻译为 WHERE dt < as_of（严格小于）
- 分页上限 1000 行，超过必须分页
- 支持 long / wide 两种响应格式
"""

from __future__ import annotations

from datetime import UTC

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


VALID_TIMEFRAMES = {"1m", "5m", "15m", "1h", "1d", "1w", "1M"}


def _build_klines_filters(
    *,
    symbols: list[str],
    timeframe: str,
    start: str | None,
    end: str | None,
    as_of_iso: str | None,
    scenario_id: str | None,
) -> dict[str, str]:
    """组装 klines_all 的 filter。对 as_of 自动加 dt < as_of"""
    filters: dict[str, str] = {
        "symbol": f"in.({','.join(symbols)})",
        "timeframe": f"eq.{timeframe}",
    }

    # scenario_id：NULL 代表全市场，否则场景专属
    if scenario_id is None:
        filters["scenario_id"] = "is.null"
    else:
        filters["scenario_id"] = f"eq.{scenario_id}"

    # 时间范围
    if start:
        start_iso = _date_to_beijing_utc(start, hour=0)
        filters["dt"] = f"gte.{start_iso}"
    if end:
        end_iso = _date_to_beijing_utc(end, hour=23, minute=59, second=59)
        # 如果已有 dt gte，需要合并——PostgREST 不支持 AND 同 key，改用 and=(...) 语法
        if "dt" in filters:
            # 用 and=() 组合两个条件
            start_clause = filters.pop("dt")  # "gte.xxx"
            filters["and"] = f"(dt.{start_clause},dt.lte.{end_iso})"
        else:
            filters["dt"] = f"lte.{end_iso}"

    # ─── as_of 注入（核心防未来函数）─────
    if as_of_iso:
        # 已经在 and 条件里？继续合并；否则直接加
        if "and" in filters:
            current = filters["and"]  # "(dt.gte.xxx,dt.lte.yyy)"
            inner = current.strip("()")
            filters["and"] = f"({inner},dt.lt.{as_of_iso})"
        elif "dt" in filters:
            current = filters.pop("dt")
            filters["and"] = f"(dt.{current},dt.lt.{as_of_iso})"
        else:
            filters["dt"] = f"lt.{as_of_iso}"

    return filters


def _date_to_beijing_utc(d: str, *, hour: int = 0, minute: int = 0, second: int = 0) -> str:
    """把 'YYYY-MM-DD' 按北京时间转 UTC ISO 8601"""
    from datetime import datetime, timedelta, timezone

    if "T" in d:
        # 已经是完整 ISO
        return d

    try:
        dt = datetime.strptime(d, "%Y-%m-%d")
    except ValueError as exc:
        raise api_error(
            ErrorCode.INVALID_PARAM,
            f"Invalid date: {d!r}, expected YYYY-MM-DD",
        ) from exc

    dt = dt.replace(hour=hour, minute=minute, second=second)
    dt = dt.replace(tzinfo=timezone(timedelta(hours=8)))
    return dt.astimezone(UTC).isoformat()


def _normalize_dt(rows: list[dict], timeframe: str) -> None:
    """把 dt 规范化：
    - 日 K / 周 K / 月 K：展示为 YYYY-MM-DD（北京日期）
    - 分钟 K / 小时 K：保留完整 ISO（带时区）
    """
    from datetime import datetime, timedelta, timezone

    if timeframe not in {"1d", "1w", "1M"}:
        return
    bj = timezone(timedelta(hours=8))
    for r in rows:
        dt_val = r.get("dt")
        if not dt_val:
            continue
        try:
            dt = datetime.fromisoformat(dt_val.replace("Z", "+00:00"))
            r["dt"] = dt.astimezone(bj).date().isoformat()
        except Exception:
            pass


@router.get("/klines", summary="查询 K 线")
async def get_klines(
    symbols: str = Query(..., description="逗号分隔的代码，如 '600519,000001'（最多 50 个）"),
    timeframe: str = Query("1d", description="1m/5m/15m/1h/1d/1w/1M"),
    start: str | None = Query(None, description="开始日期 YYYY-MM-DD"),
    end: str | None = Query(None, description="结束日期 YYYY-MM-DD"),
    as_of: str | None = Query(
        None,
        description="截止时间（严格小于），用于防未来函数。YYYY-MM-DD 或 ISO 8601",
    ),
    scenario_id: str | None = Query(
        None, description="场景 ID；不传则查全市场数据（scenario_id IS NULL）"
    ),
    format: str = Query("long", pattern="^(long|wide)$"),
    pg: dict = Depends(pagination_params),
):
    """查询 K 线数据（核心接口）

    - 默认查全市场（`scenario_id IS NULL`）；
    - 传 `scenario_id` 可查场景专属 5m 切片；
    - `as_of` 会自动转为 `dt < as_of`（严格小于，防未来函数）。
    """
    if timeframe not in VALID_TIMEFRAMES:
        raise api_error(
            ErrorCode.INVALID_PARAM,
            f"Invalid timeframe: {timeframe!r}. Valid: {sorted(VALID_TIMEFRAMES)}",
        )

    codes = split_symbols(symbols, max_count=50)
    if not codes:
        raise api_error(ErrorCode.INVALID_PARAM, "symbols is required")

    start_p = parse_date(start, name="start")
    end_p = parse_date(end, name="end")
    as_of_iso = as_of_to_utc_iso(parse_as_of(as_of))

    filters = _build_klines_filters(
        symbols=codes,
        timeframe=timeframe,
        start=start_p,
        end=end_p,
        as_of_iso=as_of_iso,
        scenario_id=scenario_id,
    )

    client = get_supabase_client()

    # 总数
    total = client.count("klines_all", filters=filters)

    offset = (pg["page"] - 1) * pg["page_size"]
    rows = client.select(
        "klines_all",
        columns="symbol,timeframe,dt,open,high,low,close,volume,turnover,"
        "pre_close,change_amount,change_percent,adj_factor",
        filters=filters,
        order="dt.asc,symbol.asc",
        limit=pg["page_size"],
        offset=offset,
    )

    # 时区转换：dt 存 UTC，日 K 展示为北京日期（YYYY-MM-DD），分钟 K 保留完整 ISO
    _normalize_dt(rows, timeframe)

    meta = {
        "timeframe": timeframe,
        "as_of_applied": as_of_iso,
        "total_rows": total,
    }

    if format == "wide":
        # 宽表（适合图表）
        dates: list[str] = []
        date_set: set[str] = set()
        series: dict[str, dict[str, list]] = {}
        for r in rows:
            dt = r["dt"]
            if dt not in date_set:
                dates.append(dt)
                date_set.add(dt)
            sym = r["symbol"]
            if sym not in series:
                series[sym] = {
                    "open": [],
                    "high": [],
                    "low": [],
                    "close": [],
                    "volume": [],
                    "turnover": [],
                }
            for key in ("open", "high", "low", "close", "volume", "turnover"):
                series[sym][key].append(r[key])
        return {
            "data": {"dates": dates, "symbols": series},
            "meta": meta,
            "pagination": {"page": pg["page"], "page_size": pg["page_size"], "total": total},
        }

    # long 格式
    return {**paginate_response(rows, **pg, total=total), "meta": meta}


@router.get("/klines/latest", summary="查询最新一根 K 线（实时）")
async def get_latest_klines(
    symbols: str = Query(..., description="逗号分隔代码"),
    timeframe: str = Query("1d"),
    as_of: str | None = Query(None, description="截止时间（防未来函数）"),
):
    if timeframe not in VALID_TIMEFRAMES:
        raise api_error(ErrorCode.INVALID_PARAM, f"Invalid timeframe: {timeframe!r}")
    codes = split_symbols(symbols, max_count=50)
    if not codes:
        raise api_error(ErrorCode.INVALID_PARAM, "symbols is required")

    as_of_iso = as_of_to_utc_iso(parse_as_of(as_of))

    client = get_supabase_client()
    results: list[dict] = []
    for code in codes:
        filters = _build_klines_filters(
            symbols=[code],
            timeframe=timeframe,
            start=None,
            end=None,
            as_of_iso=as_of_iso,
            scenario_id=None,
        )
        rows = client.select(
            "klines_all",
            columns="symbol,timeframe,dt,open,high,low,close,volume,turnover,"
            "pre_close,change_amount,change_percent,adj_factor",
            filters=filters,
            order="dt.desc",
            limit=1,
        )
        if rows:
            results.append(rows[0])

    _normalize_dt(results, timeframe)

    return {
        "data": results,
        "meta": {"timeframe": timeframe, "as_of_applied": as_of_iso},
    }
