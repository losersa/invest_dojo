"""因子值批量计算器（T-3.05）

核心职责：
- 给定 [factors, symbols, start, end] → 计算并写 feature_values 表
- 按 batch 切股票，每批一次加载 panel（K 线 + 基本面）跑 N 个因子
- 支持增量（最近 K 天）和全量（2014~至今）两种模式
- 幂等：按 (factor_id, symbol, date) 冲突时覆盖

设计决策：
1. **一批 panel 算多因子**，而不是"一因子一加载"——
   I/O 成本高（Supabase HTTP）、计算是纯 CPU 向量化，所以共享 panel
2. **按股票分批**，不按因子分批——
   同一批股票的 K 线数据紧邻、cache 友好
3. **long 表存储**，不 pivot 为宽表——
   因子数量可能继续增长（MVP 后数百→数千），宽表加列成本高

写入方式：
- PostgREST upsert on_conflict=(factor_id,symbol,date)
- 分块 batch_size=1000（PostgREST 单请求上限兼容）
"""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta
from typing import Any

import pandas as pd

from common import get_logger
from common.supabase_client import get_supabase_client

from .dsl_parser import DSLError, parse_formula
from .engine import EngineError, eval_ast
from .panel_loader import load_panel

logger = get_logger(__name__)


# ═══════════════════════════════════════════════════════════════
#   辅助函数
# ═══════════════════════════════════════════════════════════════


def _load_platform_factors(factor_ids: list[str] | None = None) -> list[dict]:
    """从 factor_definitions 读要计算的因子清单

    Args:
        factor_ids: None = 所有 platform & public 因子；指定则只跑这些
    """
    client = get_supabase_client()
    filters: dict[str, str] = {
        "owner": "eq.platform",
        "visibility": "eq.public",
        "deprecated_at": "is.null",
    }
    if factor_ids:
        filters["id"] = f"in.({','.join(factor_ids)})"

    rows = client.select_all(
        "factor_definitions",
        columns="id,formula,formula_type,output_type,lookback_days",
        filters=filters,
        page_size=1000,
    )
    # 过滤只要 DSL 公式（Python 公式暂不支持）
    return [r for r in rows if r.get("formula_type") == "dsl"]


def _load_active_symbols(limit: int | None = None) -> list[str]:
    """从 symbols 表读待计算的股票清单

    注：symbols 表主键列是 `code`（不是 `symbol`）
    过滤：status='active' 或 NULL，排除已退市
    """
    client = get_supabase_client()
    filters: dict[str, str] = {"delisted_at": "is.null"}
    rows = client.select_all(
        "symbols",
        columns="code",
        filters=filters,
        order="code.asc",
        page_size=1000,
    )
    syms = [r["code"] for r in rows if r.get("code")]
    return syms[:limit] if limit else syms


def _collect_needed_fields(parsed_factors: list[dict]) -> set[str]:
    """合并所有因子需要的字段"""
    all_fields: set[str] = set()
    for pf in parsed_factors:
        all_fields |= pf["fields"]
    return all_fields


def _parse_factors(factors: list[dict]) -> tuple[list[dict], list[dict]]:
    """解析所有因子的公式，返回 (成功列表, 失败列表)"""
    parsed: list[dict] = []
    failed: list[dict] = []
    for f in factors:
        try:
            r = parse_formula(f["formula"])
            parsed.append(
                {
                    "id": f["id"],
                    "ast": r.ast,
                    "output_type": f.get("output_type") or r.output_type,
                    "lookback_days": r.lookback_days,
                    "fields": r.fields,
                }
            )
        except DSLError as e:
            failed.append({"id": f["id"], "error": f"{e.code}: {e.message}"})
    return parsed, failed


# ═══════════════════════════════════════════════════════════════
#   核心计算函数
# ═══════════════════════════════════════════════════════════════


def compute_factor_batch(
    parsed_factors: list[dict],
    symbols_batch: list[str],
    start: str,
    end: str,
    *,
    extra_days: int = 0,
) -> tuple[list[dict], list[dict]]:
    """对一批股票计算所有 parsed factors，返回要写入的记录 + 错误

    Returns:
        (records, errors)
        records: [{factor_id, symbol, date, value_num, value_bool, computed_at}, ...]
        errors: [{factor_id, error}, ...]
    """
    # 合并所有因子的 fields
    all_fields = _collect_needed_fields(parsed_factors)

    # 所有因子的最大 lookback（统一预热）
    max_lookback = max((pf["lookback_days"] for pf in parsed_factors), default=0)
    lookback_plus_extra = max(max_lookback, extra_days)

    # 加载 panel（一次搞定所有因子需要的字段）
    panel = load_panel(
        symbols_batch,
        start=start,
        end=end,
        extra_days=lookback_plus_extra,
        needed_fields=all_fields,
    )
    if not panel or "close" not in panel:
        return [], [{"factor_id": "<panel>", "error": "no kline data for batch"}]

    # 裁到 start~end 的 mask（扣预热期）
    idx = panel["close"].index
    tz = getattr(idx, "tz", None)
    if tz is not None:
        start_ts = pd.Timestamp(start, tz=tz)
        end_ts = pd.Timestamp(end, tz=tz) + pd.Timedelta(days=1)
    else:
        start_ts = pd.Timestamp(start)
        end_ts = pd.Timestamp(end) + pd.Timedelta(days=1)
    date_mask = (idx >= start_ts) & (idx < end_ts)
    target_index = idx[date_mask]

    computed_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    records: list[dict] = []
    errors: list[dict] = []

    for pf in parsed_factors:
        factor_id = pf["id"]
        output_type = pf["output_type"]
        try:
            result = eval_ast(pf["ast"], panel)
            # 裁到目标日期
            if isinstance(result, pd.DataFrame):
                result = result.loc[date_mask]
            else:
                continue
            # 写 long 表
            for dt, row in result.iterrows():
                dt_str = dt.strftime("%Y-%m-%d") if hasattr(dt, "strftime") else str(dt)[:10]
                for sym in symbols_batch:
                    if sym not in row.index:
                        continue
                    val = row[sym]
                    if pd.isna(val):
                        continue
                    if output_type == "boolean":
                        records.append(
                            {
                                "factor_id": factor_id,
                                "symbol": sym,
                                "date": dt_str,
                                "value_num": None,
                                "value_bool": bool(val),
                                "computed_at": computed_at,
                            }
                        )
                    else:
                        try:
                            fval = float(val)
                        except (TypeError, ValueError):
                            continue
                        # 过滤 inf / NaN（PostgREST 不接受 inf）
                        if not (fval == fval) or abs(fval) == float("inf"):
                            continue
                        records.append(
                            {
                                "factor_id": factor_id,
                                "symbol": sym,
                                "date": dt_str,
                                "value_num": fval,
                                "value_bool": None,
                                "computed_at": computed_at,
                            }
                        )
        except EngineError as e:
            errors.append({"factor_id": factor_id, "error": f"engine: {e.message}"})
        except Exception as e:  # noqa: BLE001
            errors.append({"factor_id": factor_id, "error": f"{type(e).__name__}: {e}"})

    # target_index 可以用于统计日期覆盖
    _ = target_index
    return records, errors


def _upsert_records(records: list[dict], chunk_size: int = 1000) -> int:
    """分块 upsert 到 feature_values 表

    Returns: 成功写入的行数
    """
    if not records:
        return 0
    client = get_supabase_client()
    total = 0
    for i in range(0, len(records), chunk_size):
        chunk = records[i : i + chunk_size]
        try:
            client.insert(
                "feature_values",
                chunk,
                on_conflict="factor_id,symbol,date",
            )
            total += len(chunk)
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "feature_values.upsert.failed",
                chunk_start=i,
                size=len(chunk),
                error=str(e),
            )
            # 出错不 raise，让上游决定是否继续
            raise
    return total


# ═══════════════════════════════════════════════════════════════
#   主入口
# ═══════════════════════════════════════════════════════════════


def compute_and_save(
    start: str,
    end: str,
    *,
    factor_ids: list[str] | None = None,
    symbols: list[str] | None = None,
    batch_size: int = 100,
    dry_run: bool = False,
) -> dict[str, Any]:
    """批量计算因子并写 feature_values

    Args:
        start/end: YYYY-MM-DD，闭区间
        factor_ids: 要算的因子，None = 全部 platform 因子
        symbols: 要算的股票，None = symbols 表全部
        batch_size: 每批股票数
        dry_run: True 时只计算不落库

    Returns:
        {records_written, factors_computed, batches, errors, duration_sec}
    """
    t0 = time.perf_counter()

    # 1. 因子清单
    factors = _load_platform_factors(factor_ids)
    parsed, parse_failed = _parse_factors(factors)
    if parse_failed:
        logger.warning("batch_compute.parse_failed", count=len(parse_failed))

    # 2. 股票清单
    if symbols is None:
        symbols = _load_active_symbols()
    else:
        symbols = list(symbols)

    logger.info(
        "batch_compute.start",
        factors=len(parsed),
        symbols=len(symbols),
        start=start,
        end=end,
        batch_size=batch_size,
        dry_run=dry_run,
    )

    total_written = 0
    total_errors: list[dict] = list(parse_failed)
    batches_done = 0

    # 3. 分批计算
    for batch_start in range(0, len(symbols), batch_size):
        batch = symbols[batch_start : batch_start + batch_size]
        try:
            records, errors = compute_factor_batch(
                parsed_factors=parsed,
                symbols_batch=batch,
                start=start,
                end=end,
            )
            total_errors.extend(errors)
            if dry_run:
                logger.info(
                    "batch_compute.dry_run",
                    batch_idx=batches_done,
                    symbols_in_batch=len(batch),
                    records_would_write=len(records),
                    errors_in_batch=len(errors),
                )
            else:
                written = _upsert_records(records)
                total_written += written
                logger.info(
                    "batch_compute.batch_done",
                    batch_idx=batches_done,
                    symbols_in_batch=len(batch),
                    records_written=written,
                )
        except Exception as e:  # noqa: BLE001
            logger.exception(
                "batch_compute.batch_failed",
                batch_idx=batches_done,
                error=str(e),
            )
            total_errors.append({"batch_start": batch_start, "error": str(e)})

        batches_done += 1

    duration = time.perf_counter() - t0
    result = {
        "records_written": total_written,
        "factors_computed": len(parsed),
        "symbols": len(symbols),
        "batches": batches_done,
        "errors": total_errors,
        "duration_sec": round(duration, 2),
        "start": start,
        "end": end,
    }
    logger.info("batch_compute.done", **{k: v for k, v in result.items() if k != "errors"})
    return result


def compute_incremental(
    days: int = 2,
    *,
    factor_ids: list[str] | None = None,
    symbols: list[str] | None = None,
    batch_size: int = 100,
    dry_run: bool = False,
) -> dict[str, Any]:
    """增量模式：算最近 N 天

    默认 2 天是为了覆盖"今天还没收盘 → 算昨天"的情形。
    """
    end = datetime.now(UTC).date()
    start = end - timedelta(days=days - 1)
    return compute_and_save(
        start=start.isoformat(),
        end=end.isoformat(),
        factor_ids=factor_ids,
        symbols=symbols,
        batch_size=batch_size,
        dry_run=dry_run,
    )
