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
from pathlib import Path
from typing import Any

from factors.batch_compute import compute_and_save, compute_incremental

from common import celery_app, get_logger

logger = get_logger(__name__)

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


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
    result = compute_incremental(
        days=days,
        factor_ids=factor_ids,
        symbols=symbols,
        batch_size=batch_size,
    )
    # 错误列表只保留前 10 条，避免结果体过大
    result["errors"] = result["errors"][:10]
    logger.info(
        "feature.compute_incremental.done",
        celery_task_id=self.request.id,
        records_written=result["records_written"],
        duration_sec=result["duration_sec"],
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
        raise RuntimeError(f"update_5m_klines.py failed rc={proc.returncode}: {tail[-500:]}")
    # 从 stdout 提取汇总行（🏁 完成段）作为结果
    summary = [ln for ln in tail.splitlines() if ln.strip().startswith(("5m", "1d", "无", "失", "耗"))]
    return {"ok": True, "summary": summary, "tail": tail[-800:]}


@celery_app.task(name="feature.update_market_snapshots", bind=True, queue="feature")
def update_market_snapshots_task(self) -> dict[str, Any]:
    """盘后例行：更新市场快照（scripts/update_market_snapshots.py，默认跑当天/昨天）。

    供 Celery Beat 每日 17:45 调度（在 K线任务之后，因子计算之前）。
    """
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
        raise RuntimeError(f"update_market_snapshots.py failed rc={proc.returncode}: {tail[-400:]}")
    return {"ok": True, "tail": tail[-500:]}


@celery_app.task(name="feature.health", queue="feature")
def feature_health() -> dict:
    """health check"""
    from datetime import datetime  # noqa: PLC0415

    return {"ok": True, "at": datetime.utcnow().isoformat() + "Z"}
