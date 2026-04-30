"""Panel 数据装配器：从 Supabase klines_all 读数据 → pandas Panel

职责：
- 给因子引擎提供面板数据（close/open/high/low/volume/...）
- 字段名约定与 dsl_parser.BUILTIN_FIELDS 对齐
- scenario_id 隔离：默认只取全市场（scenario_id IS NULL）
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pandas as pd

from common import get_logger
from common.supabase_client import get_supabase_client

logger = get_logger(__name__)


# klines_all 字段 → DSL 字段名的映射
# DB 字段 → Panel 字段
# 注：klines_all 里 amount 字段不存在（用 turnover 作为成交额），preclose 叫 pre_close
FIELD_MAP = {
    "close": "close",
    "open": "open",
    "high": "high",
    "low": "low",
    "volume": "volume",
    "turnover": "turnover",  # 成交额
    "pre_close": "preclose",  # DB 是 pre_close，DSL 是 preclose
    "change_percent": "pct_change",  # DSL 里叫 pct_change
}


def load_panel(
    symbols: list[str],
    start: str,
    end: str,
    *,
    scenario_id: str | None = None,
    timeframe: str = "1d",
    extra_days: int = 0,
) -> dict[str, pd.DataFrame]:
    """从 klines_all 拉多股多日的 K 线 → panel dict

    Args:
        symbols: 股票代码列表
        start: 'YYYY-MM-DD' 起始日（包含）
        end: 'YYYY-MM-DD' 截止日（包含）
        scenario_id: 场景隔离，默认 None = 全市场
        timeframe: '1d' / '5m'
        extra_days: 在 start 之前多拉几天（给 rolling 预热用）

    Returns:
        {
            "close": DataFrame(index=date, columns=symbols),
            "open":  ...,
            ...
        }

    只返真实存在数据的字段；缺失的字段下游引擎会报错。
    """
    if not symbols:
        return {}

    # 算预热起点
    dt_start = datetime.strptime(start, "%Y-%m-%d").date()
    dt_load = dt_start - timedelta(days=max(extra_days * 2, 0))  # *2 避开周末
    load_start = dt_load.strftime("%Y-%m-%d")

    client = get_supabase_client()
    # 用 PostgREST 的 and=(col.op.val,col.op.val) 合成范围查询
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
        logger.warning(
            "load_panel.no_data",
            symbols=symbols,
            start=load_start,
            end=end,
            scenario_id=scenario_id,
        )
        return {}

    df = pd.DataFrame(rows)
    # dt 可能是字符串或日期，统一成 datetime
    df["dt"] = pd.to_datetime(df["dt"])

    panel: dict[str, pd.DataFrame] = {}
    for db_col, dsl_name in FIELD_MAP.items():
        if db_col not in df.columns:
            continue
        pivot = df.pivot_table(
            index="dt",
            columns="symbol",
            values=db_col,
            aggfunc="last",
        )
        # 保持 symbols 顺序，缺列补 NaN
        pivot = pivot.reindex(columns=symbols)
        panel[dsl_name] = pivot

    logger.info(
        "load_panel.ok",
        symbols=len(symbols),
        days=len(panel.get("close", pd.DataFrame())),
        fields=list(panel.keys()),
    )
    return panel
