"""横截面（cross-section）因子预计算：按行业分组的全市场变换 → feature_values

与普通因子的关键差异：
- 普通因子是 per-symbol 时间序列，可按 100 只/批计算；
- 横截面因子是 per-date 组内相对值（行业 rank / z-score / 板块均值），
  必须拿到「同一天全市场」数据才能算，不能按批。

数据源：klines_all 的 1d 基础字段（close/volume/turnover/change_percent），
行业映射来自 symbols 表（industry 字段）。

因子清单（8 个，xsec_ 前缀）：
- xsec_ind_rank_close      收盘价行业百分位排名（0~1）
- xsec_ind_rank_pct_change 当日涨幅行业百分位排名
- xsec_ind_rank_volume     成交量行业百分位排名
- xsec_ind_rank_turnover   成交额行业百分位排名
- xsec_ind_z_pct_change    当日涨幅行业 z-score（(x-μ)/σ）
- xsec_ind_z_volume        成交量行业 z-score
- xsec_ind_z_turnover      成交额行业 z-score
- xsec_ind_mean_pct_change 行业涨幅均值（板块水位，组内同值）

写库：value 存 value_num（scalar/rank 语义），upsert 冲突键 (factor_id, symbol, date)。
调用：compute_xsec_factors(start, end) —— 由 celery 任务在每日增量/回补完成后调用。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import pandas as pd

from common import get_logger, get_pg_client

logger = get_logger(__name__)

# (factor_id, 源字段, 变换)
_XSEC_RANK_FIELDS = ["close", "pct_change", "volume", "turnover"]
_XSEC_Z_FIELDS = ["pct_change", "volume", "turnover"]

BASE_FACTOR_IDS = (
    [f"xsec_ind_rank_{f}" for f in _XSEC_RANK_FIELDS]
    + [f"xsec_ind_z_{f}" for f in _XSEC_Z_FIELDS]
    + ["xsec_ind_mean_pct_change"]
)


def _fetch_market_daily(client, start: str, end: str) -> pd.DataFrame:
    """全市场 1d 基础字段（symbol/dt/close/volume/turnover/change_percent）。"""
    rows = client.select_all(
        "klines_all",
        columns="symbol,dt,close,volume,turnover,change_percent",
        filters={
            "timeframe": "eq.1d",
            "dt": f"gte.{start}T00:00:00+08:00",
            "and": f"(dt.lt.{end}T23:59:59+08:00)",
        },
        page_size=10000,
    )
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["dt"]).dt.tz_convert("Asia/Shanghai").dt.date
    for col in ("close", "volume", "turnover", "change_percent"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def _fetch_industry_map(client) -> dict[str, str]:
    rows = client.select_all(
        "symbols",
        columns="code,industry",
        filters={"status": "eq.active"},
        page_size=1000,
    )
    return {r["code"]: (r.get("industry") or "未知") for r in rows}


def compute_xsec_factors(start: str, end: str, dry_run: bool = False) -> dict[str, Any]:
    """计算 [start, end]（YYYY-MM-DD，含端点）的横截面因子并写 feature_values。"""
    client = get_pg_client()

    df = _fetch_market_daily(client, start, end)
    if df.empty:
        logger.warning("compute_xsec.no_kline", start=start, end=end)
        return {"start": start, "end": end, "records_written": 0, "hint": "no kline data"}

    ind_map = _fetch_industry_map(client)
    df["industry"] = df["symbol"].map(ind_map).fillna("未知")
    df = df.rename(columns={"change_percent": "pct_change"})

    records: list[dict[str, Any]] = []
    # 按 (date, industry) 分组做组内变换
    grouped = df.groupby(["date", "industry"])

    def _rank(s: pd.Series) -> pd.Series:
        return s.rank(pct=True)

    def _z(s: pd.Series) -> pd.Series:
        std = s.std(ddof=0)
        if std == 0 or pd.isna(std):
            return pd.Series(0.0, index=s.index)
        return (s - s.mean()) / std

    transformed = df.copy()
    for f in _XSEC_RANK_FIELDS:
        transformed[f"rank_{f}"] = grouped[f].transform(_rank)
    for f in _XSEC_Z_FIELDS:
        transformed[f"z_{f}"] = grouped[f].transform(_z)
    transformed["mean_pct_change"] = grouped["pct_change"].transform("mean")

    # 只写组内 ≥3 只的行业（1-2 只的"组"排名无意义）
    group_sizes = df.groupby(["date", "industry"])["symbol"].transform("count")
    valid = group_sizes >= 3

    field_factor_pairs = (
        [(f"rank_{f}", f"xsec_ind_rank_{f}") for f in _XSEC_RANK_FIELDS]
        + [(f"z_{f}", f"xsec_ind_z_{f}") for f in _XSEC_Z_FIELDS]
        + [("mean_pct_change", "xsec_ind_mean_pct_change")]
    )

    for col, factor_id in field_factor_pairs:
        sub = transformed.loc[valid & transformed[col].notna(), ["symbol", "date", col]]
        for row in sub.itertuples(index=False):
            records.append(
                {
                    "factor_id": factor_id,
                    "symbol": row.symbol,
                    "date": row.date.isoformat(),
                    "value_num": round(float(row[2]), 6),
                }
            )

    written = 0
    if not dry_run and records:
        # 分批 upsert（每批 5000 行）
        for i in range(0, len(records), 5000):
            client.insert(
                "feature_values",
                records[i : i + 5000],
                on_conflict="factor_id,symbol,date",
            )
            written += len(records[i : i + 5000])

    logger.info(
        "compute_xsec.done",
        start=start,
        end=end,
        days=df["date"].nunique(),
        symbols=df["symbol"].nunique(),
        industries=df["industry"].nunique(),
        records=written if not dry_run else len(records),
        dry_run=dry_run,
    )
    return {
        "start": start,
        "end": end,
        "days": int(df["date"].nunique()),
        "symbols": int(df["symbol"].nunique()),
        "industries": int(df["industry"].nunique()),
        "records_written": written,
        "records_would_write": len(records) if dry_run else None,
    }
