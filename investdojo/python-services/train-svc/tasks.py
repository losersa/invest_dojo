"""train-svc Celery 任务定义

**关键架构决定**：
- `tasks.py` 放在 `train-svc/` 目录下
- 通过 Celery 的 `imports` 字段加载（见 common/celery_app.py）
- 任务名前缀 `train.*`（路由到 queue=train）
- tasks 通过 Supabase 读写 training_jobs 表做状态持久化

MVP（T-2.02）：只有 `dummy_train` 任务
Epic 3（T-3.02）：加 LightGBM baseline / XGBoost baseline

状态流转：
    pending → running → completed / failed / cancelled

注意：Celery 的 result backend 只存任务结果，**真正的业务状态持久化必须写 DB**。
Celery 任务崩溃重试时可能状态丢失，以 DB 为准。
"""

from __future__ import annotations

import time
from typing import Any

from common_utils import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_RUNNING,
    utc_now_iso,
)

from common import celery_app, get_logger, get_supabase_client

logger = get_logger(__name__)


def _update_job_status(
    job_id: str,
    *,
    status: str,
    progress: float | None = None,
    stage: str | None = None,
    metrics_preview: dict | None = None,
    error: dict | None = None,
    started: bool = False,
    completed: bool = False,
) -> None:
    """统一更新 training_jobs 状态"""
    client = get_supabase_client()

    patch: dict[str, Any] = {"status": status}
    if progress is not None:
        patch["progress"] = round(progress, 2)
    if stage is not None:
        patch["stage"] = stage
    if metrics_preview is not None:
        patch["metrics_preview"] = metrics_preview
    if error is not None:
        patch["error"] = error
    if started:
        patch["started_at"] = utc_now_iso()
    if completed:
        patch["completed_at"] = utc_now_iso()

    import httpx

    url = f"{client.url}/rest/v1/training_jobs?job_id=eq.{job_id}"
    resp = client._http.patch(url, json=patch)
    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        logger.error(
            "train.job.update_failed",
            job_id=job_id,
            status=status,
            error=str(e),
            body=resp.text[:200],
        )
        raise


@celery_app.task(name="train.dummy_train", bind=True, queue="train")
def dummy_train(self, job_id: str, config: dict) -> dict:
    """模拟训练任务：什么都不算，只为验证状态流转

    状态流转：
        pending → running (prepare) → running (fitting 0-100%) → completed

    Args:
        job_id: training_jobs.job_id
        config: 训练配置（来自 TrainJobConfig）

    Returns:
        {job_id, status, metrics_preview}
    """
    logger.info("train.dummy.start", job_id=job_id, celery_task_id=self.request.id)

    try:
        # ── running: prepare ──
        _update_job_status(
            job_id,
            status=STATUS_RUNNING,
            stage="prepare",
            progress=0.05,
            started=True,
        )

        # ── running: fitting ──
        duration = int(config.get("simulated_duration_sec", 2))
        steps = max(1, duration)  # 1 步/秒
        for i in range(steps):
            time.sleep(1)
            progress = 0.05 + (i + 1) / steps * 0.9
            _update_job_status(
                job_id,
                status=STATUS_RUNNING,
                stage="fitting",
                progress=progress,
            )

        # ── completed ──
        metrics = {
            "train_auc": 0.687,
            "valid_auc": 0.631,
            "train_samples": 0,
            "valid_samples": 0,
            "feature_importance": {},
            "note": "dummy training — no actual model computed",
        }
        _update_job_status(
            job_id,
            status=STATUS_COMPLETED,
            stage="done",
            progress=1.0,
            metrics_preview=metrics,
            completed=True,
        )
        logger.info("train.dummy.completed", job_id=job_id)

        return {"job_id": job_id, "status": STATUS_COMPLETED, "metrics_preview": metrics}

    except Exception as e:
        logger.exception("train.dummy.failed", job_id=job_id, error=str(e))
        try:
            _update_job_status(
                job_id,
                status=STATUS_FAILED,
                error={"type": type(e).__name__, "message": str(e)},
                completed=True,
            )
        except Exception:
            logger.exception("train.dummy.failure_write_db_failed", job_id=job_id)
        raise


@celery_app.task(name="train.health", queue="train")
def health_ping() -> dict:
    """worker 健康检查任务（冒烟用）"""
    return {"ok": True, "at": utc_now_iso()}
