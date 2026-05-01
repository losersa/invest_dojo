"""feature-svc 相关 Celery 任务（T-3.05）

任务清单：
- feature.compute_incremental：增量计算最近 N 天（每日 17:00 Beat 调度）
- feature.compute_range：给定 [start, end] 计算（backfill / 手动触发）
- feature.health：健康检查

路由到 queue=feature（见 common/celery_app.py task_routes）。

**PYTHONPATH 需要包含 feature-svc**（见 Procfile train-worker 行），
这样才能 `from factors.batch_compute import ...`。
"""

from __future__ import annotations

from typing import Any

from factors.batch_compute import compute_and_save, compute_incremental

from common import celery_app, get_logger

logger = get_logger(__name__)


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


@celery_app.task(name="feature.health", queue="feature")
def feature_health() -> dict:
    """health check"""
    from datetime import datetime  # noqa: PLC0415

    return {"ok": True, "at": datetime.utcnow().isoformat() + "Z"}
