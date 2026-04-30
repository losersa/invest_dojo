"""Panel 数据装配器：Supabase → pandas Panel

职责：
- K 线字段（日频）：从 klines_all 拉取
- 基本面字段（季频）：从 fundamentals 拉取 + 按 announce_date 前向填充为日频
- 衍生字段（K 线 + 基本面）：market_cap / pe_ttm / pb

关键原则（防未来函数）：
- fundamentals 按 announce_date 可见，**公告日 t 在 t+1 起生效**
- 不能用 report_date（那是会计期末，当时还没公告）
- 滚动/pct_change 等计算由 engine 负责，panel_loader 只对齐时间
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pandas as pd

from common import get_logger
from common.supabase_client import get_supabase_client

from .registry import FUNDAMENTAL_FIELD_MAP

logger = get_logger(__name__)


# klines_all 字段 → DSL 字段名的映射
KLINE_FIELD_MAP = {
    "close": "close",
    "open": "open",
    "high": "high",
    "low": "low",
    "volume": "volume",
    "turnover": "turnover",
    "pre_close": "preclose",
    "change_percent": "pct_change",
}

# 老名字兼容（T-3.02 里的代码可能还在用）
FIELD_MAP = KLINE_FIELD_MAP


def _load_klines(
    client,
    symbols: list[str],
    load_start: str,
    end: str,
    scenario_id: str | None,
    timeframe: str,
) -> pd.DataFrame:
    """从 klines_all 拉 K 线，返回长表 DataFrame"""
    filters: dict[str, str] = {
        "symbol": f"in.({','.join(symbols)})",
        "timeframe": f"eq.{timeframe}",
        "and": f"(dt.gte.{load_start},dt.lte.{end})",
    }
    if scenario_id is None:
        filters["scenario_id"] = "is.null"
    else:
        filters["scenario_id"] = f"eq.{scenario_id}"

    rows = client.select_all(
        "klines_all",
        columns="dt,symbol,open,high,low,close,volume,turnover,pre_close,change_percent",
        filters=filters,
        order="dt.asc",
        page_size=1000,
    )
    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    df["dt"] = pd.to_datetime(df["dt"])
    return df


def _load_fundamentals(
    client,
    symbols: list[str],
    needed_fields: set[str],
) -> dict[str, pd.DataFrame]:
    """从 fundamentals 拉需要的字段，按 announce_date 对齐

    Returns:
        {field_name: DataFrame(index=announce_date, columns=symbol)}
        下游负责 reindex 到交易日并前向填充
    """
    # 推断要拉哪些 statement
    needed_stmts: set[str] = set()
    stmt_keys: dict[str, set[str]] = {}  # stmt → needed JSONB keys
    field_spec: dict[str, tuple[str, str]] = {}  # dsl_field → (stmt, json_key)

    for f in needed_fields:
        if f in FUNDAMENTAL_FIELD_MAP:
            stmt, json_key = FUNDAMENTAL_FIELD_MAP[f]
            needed_stmts.add(stmt)
            stmt_keys.setdefault(stmt, set()).add(json_key)
            field_spec[f] = (stmt, json_key)

    if not needed_stmts:
        return {}

    # 一次把所有 statement 拉回来
    filters = {
        "symbol": f"in.({','.join(symbols)})",
        "statement": f"in.({','.join(needed_stmts)})",
    }
    rows = client.select_all(
        "fundamentals",
        columns="symbol,statement,report_date,announce_date,data",
        filters=filters,
        order="announce_date.asc",
        page_size=1000,
    )
    if not rows:
        return {}

    # 展平：每个 dsl_field 一个 long-format 记录列表
    records: dict[str, list[dict]] = {f: [] for f in field_spec}

    for row in rows:
        stmt = row["statement"]
        announce = row["announce_date"]
        if not announce:
            continue
        data = row.get("data") or {}
        for field, (s, jkey) in field_spec.items():
            if s != stmt:
                continue
            val = data.get(jkey)
            if val is None:
                continue
            try:
                fval = float(val)
            except (TypeError, ValueError):
                continue
            records[field].append(
                {"announce_date": announce, "symbol": row["symbol"], "value": fval}
            )

    # 每个字段 pivot 成 DataFrame
    panel_raw: dict[str, pd.DataFrame] = {}
    for field, recs in records.items():
        if not recs:
            continue
        df = pd.DataFrame(recs)
        df["announce_date"] = pd.to_datetime(df["announce_date"])
        # 同一 symbol 同一 announce_date 可能多条（不同 report_date 的更正），取 last
        pivot = df.pivot_table(
            index="announce_date",
            columns="symbol",
            values="value",
            aggfunc="last",
        )
        panel_raw[field] = pivot

    return panel_raw


def _align_fundamentals_to_kline(
    fund_raw: dict[str, pd.DataFrame],
    kline_index: pd.DatetimeIndex,
    symbols: list[str],
) -> dict[str, pd.DataFrame]:
    """把季频基本面对齐到日频 K 线 index，**前向填充 + lag 1 天**（防未来函数）

    语义：公告日 t 的财报从 t+1 交易日起才对模型可见。
    """
    out: dict[str, pd.DataFrame] = {}
    if not fund_raw:
        return out

    # 对齐 kline_index 的时区
    tz = getattr(kline_index, "tz", None)

    for field, df in fund_raw.items():
        # 时区对齐
        if tz is not None and df.index.tz is None:
            df = df.tz_localize(tz)
        elif tz is None and df.index.tz is not None:
            df = df.tz_convert(None).tz_localize(None)

        # ① 在公告日基础上 +1 天（公告当天收盘后才看得见，次日生效）
        df = df.copy()
        df.index = df.index + pd.Timedelta(days=1)
        df = df.sort_index()

        # ② 合并 kline 日历 + 公告日，先 ffill，再 reindex
        # 直接 reindex(method="ffill") 只在新 index 里匹配最近旧 index，
        # 如果某列在该 announce_date 是 NaN（因为别的 symbol 才公告），
        # ffill 就会留 NaN。所以先 ffill 让每列独立填满。
        df = df.ffill()

        # ③ 合并索引后 reindex
        merged_index = df.index.union(kline_index).sort_values()
        aligned = df.reindex(merged_index).ffill()
        # ④ 最终只保留 kline 日期
        aligned = aligned.reindex(kline_index)
        # ⑤ 列对齐 symbols
        aligned = aligned.reindex(columns=symbols)
        out[field] = aligned

    return out


def _compute_derived(panel: dict[str, pd.DataFrame]) -> None:
    """计算衍生字段 market_cap / pe_ttm / pb，原地写入 panel"""
    close = panel.get("close")
    if close is None:
        return

    total_share = panel.get("total_share")
    eps_ttm = panel.get("eps_ttm")

    if total_share is not None:
        # 总市值 = 收盘价 × 总股本
        # BaoStock totalShare 单位是"亿股"还是"股"？看数据：总股本 * close 要像样
        # 600519 2024 total_share=12.56(亿)，×1400=17584 亿市值 ✓ 所以单位是"亿股"
        panel["market_cap"] = close * total_share * 1e8  # 折成元

    if eps_ttm is not None:
        # 市盈率 TTM = close / eps_ttm（eps_ttm 已经是元/股）
        # 避免 /0 → NaN
        pe = close / eps_ttm.replace(0, pd.NA)
        # 负 PE 会出现（亏损公司），保留（不人为 clamp）
        panel["pe_ttm"] = pe

        # PB 近似：缺 BPS，用 ROE 反推（ROE=净利润/净资产 → BPS=EPS/ROE）
        # 只有 ROE 非 0 时才有效
        roe = panel.get("roe")
        if roe is not None:
            bps = eps_ttm / roe.replace(0, pd.NA)
            panel["pb"] = close / bps.replace(0, pd.NA)


def load_panel(
    symbols: list[str],
    start: str,
    end: str,
    *,
    scenario_id: str | None = None,
    timeframe: str = "1d",
    extra_days: int = 0,
    needed_fields: set[str] | None = None,
) -> dict[str, pd.DataFrame]:
    """Panel 主入口

    Args:
        symbols: 股票代码列表
        start/end: YYYY-MM-DD
        scenario_id: 场景隔离，None = 全市场
        timeframe: 1d / 5m
        extra_days: K 线预热天数
        needed_fields: 需要哪些字段。None = 只加载 K 线；
                      非空时会按需加载 fundamentals 和 derived

    Returns:
        {field_name: DataFrame(index=date, columns=symbols)}
    """
    if not symbols:
        return {}

    dt_start = datetime.strptime(start, "%Y-%m-%d").date()
    dt_load = dt_start - timedelta(days=max(extra_days * 2, 0))
    load_start = dt_load.strftime("%Y-%m-%d")

    client = get_supabase_client()

    # ── 1. K 线 ──
    df_k = _load_klines(client, symbols, load_start, end, scenario_id, timeframe)
    if df_k.empty:
        logger.warning(
            "load_panel.no_kline",
            symbols=symbols,
            start=load_start,
            end=end,
        )
        return {}

    panel: dict[str, pd.DataFrame] = {}
    for db_col, dsl_name in KLINE_FIELD_MAP.items():
        if db_col not in df_k.columns:
            continue
        pivot = df_k.pivot_table(index="dt", columns="symbol", values=db_col, aggfunc="last")
        pivot = pivot.reindex(columns=symbols)
        panel[dsl_name] = pivot

    # ── 2. 基本面（按需）──
    if needed_fields:
        fund_needed = needed_fields & set(FUNDAMENTAL_FIELD_MAP.keys())
        # 衍生字段的依赖也要加
        if "pe_ttm" in needed_fields or "market_cap" in needed_fields:
            fund_needed.add("eps_ttm")
            fund_needed.add("total_share")
        if "pb" in needed_fields:
            fund_needed.update({"eps_ttm", "roe"})

        if fund_needed:
            fund_raw = _load_fundamentals(client, symbols, fund_needed)
            close_index = panel["close"].index
            aligned = _align_fundamentals_to_kline(fund_raw, close_index, symbols)
            panel.update(aligned)

        # ── 3. 衍生字段 ──
        _compute_derived(panel)

    logger.info(
        "load_panel.ok",
        symbols=len(symbols),
        days=len(panel.get("close", pd.DataFrame())),
        fields=sorted(panel.keys()),
    )
    return panel
