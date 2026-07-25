"""feature-svc 相关 Celery 任务（T-3.05）

任务清单：
- feature.compute_incremental：增量计算最近 N 天（每日 19:00 Beat 调度，仅工作日）
- feature.compute_range：给定 [start, end] 计算（backfill / 手动触发）
- feature.update_klines_5m：盘后例行拉取 5m K线并聚合日K落库（每日 17:35 Beat）
- feature.update_market_snapshots：盘后例行更新市场快照（每日 17:45 Beat）
- feature.health：健康检查

路由到 queue=feature（见 common/celery_app.py task_routes）。

**PYTHONPATH 需要包含 feature-svc**（见 Procfile train-worker 行），
这样才能 `from factors.batch_compute import ...`。
"""

from __future__ import annotations

import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from factors.batch_compute import compute_and_save, compute_incremental

from common import celery_app, get_logger

logger = get_logger(__name__)

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

_BJ_TZ = timezone(timedelta(hours=8))  # run_date 按北京日期归属


def _pg_conn():
    """直连 PG（运行记录/汇总写入用）"""
    import os  # noqa: PLC0415

    import psycopg2  # noqa: PLC0415

    return psycopg2.connect(
        host=os.environ.get("PG_HOST", "127.0.0.1"),
        port=int(os.environ.get("PG_PORT", "5432")),
        user=os.environ.get("PG_USER", "postgres"),
        password=os.environ.get("PG_PASSWORD", ""),
        dbname=os.environ.get("PG_DATABASE", "postgres"),
        connect_timeout=10,
    )


def _record_run(
    task_name: str,
    status: str,
    detail: dict[str, Any],
    started_monotonic: float,
) -> None:
    """例行任务运行记录 → routine_task_runs（失败不阻断任务本身）。"""
    try:
        now = datetime.now(UTC)
        run_date = now.astimezone(_BJ_TZ).date().isoformat()
        duration = round(time.monotonic() - started_monotonic, 1)
        conn = _pg_conn()
        try:
            cur = conn.cursor()
            import json  # noqa: PLC0415

            cur.execute(
                "INSERT INTO routine_task_runs "
                "(task_name, run_date, status, detail, duration_sec, started_at, finished_at) "
                "VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s)",
                (
                    task_name,
                    run_date,
                    status,
                    json.dumps(detail, ensure_ascii=False, default=str),
                    duration,
                    now - timedelta(seconds=duration),
                    now,
                ),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001
        logger.warning("routine_task_runs 记录失败（不影响任务）", task=task_name, error=str(e))


@celery_app.task(name="feature.compute_incremental", bind=True, queue="feature")
def compute_incremental_task(
    self,
    days: int = 2,
    factor_ids: list[str] | None = None,
    symbols: list[str] | None = None,
    batch_size: int = 100,
) -> dict[str, Any]:
    """增量计算最近 N 天的因子值（默认 2 天，覆盖昨天+今天）

    供 Celery Beat 每日 17:00 调度；也可手动触发用于补算。
    """
    logger.info(
        "feature.compute_incremental.start",
        celery_task_id=self.request.id,
        days=days,
        factor_count=len(factor_ids) if factor_ids else "all",
        symbol_count=len(symbols) if symbols else "all",
    )
    t0 = time.monotonic()
    try:
        result = compute_incremental(
            days=days,
            factor_ids=factor_ids,
            symbols=symbols,
            batch_size=batch_size,
        )
    except Exception as e:
        _record_run(
            "feature.compute_incremental",
            "failed",
            {"error": str(e)[:500], "days": days},
            t0,
        )
        raise
    # 错误列表只保留前 10 条，避免结果体过大
    result["errors"] = result["errors"][:10]
    logger.info(
        "feature.compute_incremental.done",
        celery_task_id=self.request.id,
        records_written=result["records_written"],
        duration_sec=result["duration_sec"],
    )
    _record_run(
        "feature.compute_incremental",
        "success",
        {
            "days": days,
            "records_written": result["records_written"],
            "start": result.get("start"),
            "end": result.get("end"),
        },
        t0,
    )
    return result


@celery_app.task(name="feature.compute_range", bind=True, queue="feature")
def compute_range_task(
    self,
    start: str,
    end: str,
    factor_ids: list[str] | None = None,
    symbols: list[str] | None = None,
    batch_size: int = 100,
) -> dict[str, Any]:
    """给定日期区间计算因子值（backfill / 补算）"""
    logger.info(
        "feature.compute_range.start",
        celery_task_id=self.request.id,
        start=start,
        end=end,
    )
    result = compute_and_save(
        start=start,
        end=end,
        factor_ids=factor_ids,
        symbols=symbols,
        batch_size=batch_size,
    )
    result["errors"] = result["errors"][:10]
    logger.info(
        "feature.compute_range.done",
        celery_task_id=self.request.id,
        records_written=result["records_written"],
        duration_sec=result["duration_sec"],
    )
    return result


@celery_app.task(name="feature.update_klines_5m", bind=True, queue="feature")
def update_klines_5m_task(
    self,
    from_date: str | None = None,
    to_date: str | None = None,
    limit: int = 0,
) -> dict[str, Any]:
    """盘后例行：增量拉取 5m K线并聚合日K落库（scripts/update_5m_klines.py）。

    供 Celery Beat 每日 17:35 调度（A股 15:00 收盘 + 数据源同步缓冲）；
    也可手动触发回补（from_date/to_date）。脚本硬上限 1h（task_time_limit），
    增量模式（每天 ~25 万行 5m）预计 10~30 分钟。非交易日脚本自检零成本退出。
    """
    t0 = time.monotonic()
    script = _REPO_ROOT / "scripts" / "update_5m_klines.py"
    cmd = [sys.executable, str(script)]
    if from_date:
        cmd += ["--from", from_date]
    if to_date:
        cmd += ["--to", to_date]
    if limit:
        cmd += ["--limit", str(limit)]

    logger.info(
        "feature.update_klines_5m.start",
        celery_task_id=self.request.id,
        cmd=" ".join(cmd),
    )
    proc = subprocess.run(
        cmd,
        cwd=_REPO_ROOT / "python-services",
        capture_output=True,
        text=True,
        timeout=3300,  # 与 soft_time_limit 对齐
    )
    tail = (proc.stdout or "")[-2000:]
    logger.info(
        "feature.update_klines_5m.done",
        celery_task_id=self.request.id,
        returncode=proc.returncode,
        stdout_tail=tail,
        stderr_tail=(proc.stderr or "")[-500:],
    )
    if proc.returncode != 0:
        _record_run(
            "feature.update_klines_5m",
            "failed",
            {"cmd": " ".join(cmd), "error": tail[-500:]},
            t0,
        )
        raise RuntimeError(f"update_5m_klines.py failed rc={proc.returncode}: {tail[-500:]}")
    # 从 stdout 提取汇总行（🏁 完成段）作为结果
    summary = [ln for ln in tail.splitlines() if ln.strip().startswith(("5m", "1d", "无", "失", "耗"))]
    # 非交易日自检退出 / 全部最新 → skipped（零成本空转，非异常）
    skipped = "无需更新" in tail or "非交易日" in tail
    _record_run(
        "feature.update_klines_5m",
        "skipped" if skipped else "success",
        {"cmd": " ".join(cmd), "summary": summary},
        t0,
    )
    return {"ok": True, "skipped": skipped, "summary": summary, "tail": tail[-800:]}


@celery_app.task(name="feature.update_market_snapshots", bind=True, queue="feature")
def update_market_snapshots_task(self) -> dict[str, Any]:
    """盘后例行：更新市场快照（scripts/update_market_snapshots.py，默认跑当天/昨天）。

    供 Celery Beat 每日 17:45 调度（在 K线任务之后，因子计算之前）。
    """
    t0 = time.monotonic()
    script = _REPO_ROOT / "scripts" / "update_market_snapshots.py"
    logger.info("feature.update_market_snapshots.start", celery_task_id=self.request.id)
    proc = subprocess.run(
        [sys.executable, str(script)],
        cwd=_REPO_ROOT / "python-services",
        capture_output=True,
        text=True,
        timeout=1800,
    )
    tail = (proc.stdout or "")[-1000:]
    logger.info(
        "feature.update_market_snapshots.done",
        celery_task_id=self.request.id,
        returncode=proc.returncode,
        stdout_tail=tail,
    )
    if proc.returncode != 0:
        _record_run(
            "feature.update_market_snapshots",
            "failed",
            {"error": tail[-400:]},
            t0,
        )
        raise RuntimeError(f"update_market_snapshots.py failed rc={proc.returncode}: {tail[-400:]}")
    skipped = "非交易日" in tail
    _record_run(
        "feature.update_market_snapshots",
        "skipped" if skipped else "success",
        {"tail": tail[-300:]},
        t0,
    )
    return {"ok": True, "skipped": skipped, "tail": tail[-500:]}


@celery_app.task(name="feature.collect_daily_metrics", bind=True, queue="feature")
def collect_daily_metrics_task(
    self,
    date_str: str | None = None,
    days: int = 1,
) -> dict[str, Any]:
    """汇总指定日期（默认今天）各数据表的写入量 → daily_data_metrics（幂等 upsert）。

    每天 20:00 Beat 调度（在 K线/快照/因子任务之后）；
    days>1 时向前回填多天（建表初期/补漏用，也可从 data-svc API 手动触发）。

    注意：klines_all 按「北京日」归属（dt AT TIME ZONE 'Asia/Shanghai'），
    走 idx_klines_all_tf_dt (timeframe, dt) 索引；feature_values 按 date 分区裁剪。
    """
    t0 = time.monotonic()
    base = (
        datetime.fromisoformat(date_str).date()
        if date_str
        else datetime.now(_BJ_TZ).date()
    )
    targets = [base - timedelta(days=i) for i in range(days)]

    conn = _pg_conn()
    written: list[dict[str, Any]] = []
    try:
        cur = conn.cursor()
        for d in targets:
            d_iso = d.isoformat()
            metrics: list[tuple[str, int, int | None]] = []

            # 5m / 1d K线（按北京日归属）
            for tf in ("5m", "1d"):
                cur.execute(
                    "SELECT COUNT(*), COUNT(DISTINCT symbol) FROM klines_all "
                    "WHERE timeframe = %s "
                    "AND (dt AT TIME ZONE 'Asia/Shanghai')::date = %s",
                    (tf, d_iso),
                )
                n, nsym = cur.fetchone()
                metrics.append((f"klines_{tf}", n, nsym))

            # 市场快照
            cur.execute(
                "SELECT COUNT(*) FROM market_snapshots WHERE date = %s", (d_iso,)
            )
            metrics.append(("market_snapshots", cur.fetchone()[0], None))

            # 因子值（分区表按 date 裁剪）
            cur.execute(
                "SELECT COUNT(*), COUNT(DISTINCT symbol) FROM feature_values WHERE date = %s",
                (d_iso,),
            )
            n, nsym = cur.fetchone()
            metrics.append(("feature_values", n, nsym))

            for metric, rows_count, symbols_covered in metrics:
                cur.execute(
                    "INSERT INTO daily_data_metrics "
                    "(date, metric, rows_count, symbols_covered, collected_at) "
                    "VALUES (%s, %s, %s, %s, NOW()) "
                    "ON CONFLICT (date, metric) DO UPDATE SET "
                    "rows_count = EXCLUDED.rows_count, "
                    "symbols_covered = EXCLUDED.symbols_covered, "
                    "collected_at = NOW()",
                    (d_iso, metric, rows_count, symbols_covered),
                )
                written.append(
                    {"date": d_iso, "metric": metric, "rows": rows_count}
                )
        conn.commit()
    except Exception as e:
        conn.rollback()
        _record_run(
            "feature.collect_daily_metrics",
            "failed",
            {"error": str(e)[:500]},
            t0,
        )
        raise
    finally:
        conn.close()

    logger.info(
        "feature.collect_daily_metrics.done",
        celery_task_id=self.request.id,
        days=days,
        base=str(base),
        rows=len(written),
    )
    _record_run(
        "feature.collect_daily_metrics",
        "success",
        {"base": str(base), "days": days, "metrics_written": len(written)},
        t0,
    )
    return {"ok": True, "written": written}


@celery_app.task(name="feature.health", queue="feature")
def feature_health() -> dict:
    """health check"""
    from datetime import datetime  # noqa: PLC0415

    return {"ok": True, "at": datetime.utcnow().isoformat() + "Z"}
