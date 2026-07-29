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
import uuid
from datetime import datetime, timedelta
from typing import Any

from common_utils import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_RUNNING,
    utc_now_iso,
)

from common import celery_app, get_logger, get_pg_client
from common.minio_client import MinioPath, upload_bytes
from pipeline import booster_to_bytes, build_dataset, parse_horizon_tf, train_lightgbm

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
    client = get_pg_client()

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

    try:
        client.update("training_jobs", patch, filters={"job_id": f"eq.{job_id}"})
    except Exception as e:  # noqa: BLE001
        logger.error(
            "train.job.update_failed",
            job_id=job_id,
            status=status,
            error=str(e),
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


def _default_platform_factors(limit: int = 60) -> list[str]:
    """未指定 features 时，优先取 platform 的 scalar/rank 因子（有信息量）。

    boolean 类信号（如金叉/大阳线）在短窗口里多为常量，学不到东西，
    故默认回退到数值/排名型因子；若为空再兜底取任意 platform 因子。
    """
    try:
        client = get_pg_client()
        rows = client.select(
            "factor_definitions",
            columns="id",
            filters={"owner": "eq.platform", "output_type": "in.(scalar,rank)"},
            limit=limit,
        )
        ids = [r["id"] for r in rows]
        if not ids:
            rows = client.select(
                "factor_definitions",
                columns="id",
                filters={"owner": "eq.platform"},
                limit=limit,
            )
            ids = [r["id"] for r in rows]
        return ids
    except Exception as e:  # noqa: BLE001
        logger.warning("train.default_factors.failed", error=str(e))
        return []


@celery_app.task(name="train.lightgbm_train", bind=True, queue="train")
def lightgbm_train(self, job_id: str, config: dict) -> dict:
    """真实 LightGBM 训练任务（Epic 4 · T-4.01）

    流程：
    prepare → loading_data → fitting → 落盘 MinIO + 注册 models/model_versions
    → completed（带真实 AUC / 特征重要性）

    状态以 training_jobs 表为准（Celery result backend 仅存任务结果）。
    """
    logger.info("train.lightgbm.start", job_id=job_id, celery_task_id=self.request.id)
    try:
        _update_job_status(
            job_id, status=STATUS_RUNNING, stage="prepare", progress=0.05, started=True
        )

        factor_ids: list[str] = list(config.get("features", []) or [])
        target = config.get("target", "return_5d")
        train_start = config.get("train_start")
        train_end = config.get("train_end")
        test_start = config.get("test_start")
        test_end = config.get("test_end")
        refit_on_valid = bool(config.get("refit_on_valid", False))
        # 给了测试集但没给训练结束日：以测试集前一日作为训练窗口上界，
        # 避免测试样本被并入训练/验证切分（split_train_valid 按 train_end 排除）。
        if test_start and test_end and not train_end:
            train_end = (datetime.fromisoformat(test_start) - timedelta(days=1)).strftime("%Y-%m-%d")
        symbols = config.get("symbols")
        target_symbol = config.get("target_symbol")
        peer = config.get("peer")
        params = config.get("params", {})

        if not factor_ids:
            factor_ids = _default_platform_factors()
            if not factor_ids:
                raise ValueError("未提供 features 且无可用的 platform 因子")

        _update_job_status(
            job_id, status=STATUS_RUNNING, stage="loading_data", progress=0.2
        )

        label_spec = params.get("label") or {}
        df, used = build_dataset(
            factor_ids, target, train_start, train_end, symbols,
            label_spec=label_spec, target_symbol=target_symbol, peer=peer,
            test_start=test_start, test_end=test_end,
        )

        _update_job_status(job_id, status=STATUS_RUNNING, stage="fitting", progress=0.4)

        # 隔离带 = 前向标签周期：cutoff 前 H 个交易日的训练标签会延伸进验证
        # 窗口（边界泄漏）。1d 标签 H=N 天；5m 标签 H=⌈bars/48⌉ 天（每天 48 根）
        _h_bars, _h_tf = parse_horizon_tf(target)
        embargo_days = _h_bars if _h_tf == "1d" else max(1, (_h_bars + 47) // 48)
        params = {
            **params,
            "embargo_days": embargo_days,
            # 透传给 train_lightgbm：切分排除测试集、计算测试集索引、调参用验证集
            "train_end": train_end,
            "test_start": test_start,
            "test_end": test_end,
            # 最终模型是否并入验证集全量训练
            "refit_on_valid": refit_on_valid,
        }

        result = train_lightgbm(df, used, params=params)

        # ── 落盘 MinIO ──
        owner = config.get("owner") or "platform"
        model_id = f"model_{uuid.uuid4().hex[:12]}"
        version = "1.0.0"
        filename = f"{model_id}.txt"
        if owner == "platform":
            object_name = MinioPath.platform_model("lightgbm", version, filename)
        else:
            object_name = MinioPath.user_model(owner, model_id, version, filename)

        model_bytes = booster_to_bytes(result["booster"])
        file_path = upload_bytes(object_name, model_bytes, content_type="application/octet-stream")

        # ── 注册模型 ──
        client = get_pg_client()
        # 默认名带 model_id 后缀，保证 (owner,name,version) 唯一，避免重复训练冲突
        model_name = config.get("model_name") or f"lightgbm_{target}_{model_id}"
        client.insert(
            "models",
            {
                "id": model_id,
                "name": model_name,
                "version": version,
                "owner": owner,
                "source": "internal",
                "algorithm": "lightgbm",
                "input_features": result["feature_cols"],
                "target": target,
                "output_type": "probability",
                "training_range": {"start": train_start, "end": train_end},
                "training_samples": result["n_train"] + result["n_valid"],
                # 评估指标表（训练/验证：AUC/准确/精确/召回/F1/混淆矩阵），供训练结果页直接展示
                "validation_metrics": result["metrics_table"],
                # 完整特征重要度（按 gain，与 feature_cols 同顺序），回测/解释可直接用
                "feature_importance": result["feature_importance"],
                "file_path": file_path,
                "file_size": len(model_bytes),
                "visibility": config.get("visibility", "private"),
                "metadata": {
                    "label_spec": label_spec or {"kind": "return", "threshold": 0.0},
                    # 记录「同板块横截面特征 / 多股票预测单只」配置，便于回溯
                    "target_symbol": target_symbol,
                    "peer": peer or {"enabled": False},
                    # 训练股票池快照：回测复现 peer 横截面特征时必须用同一参照系
                    "symbols": symbols,
                    "split_method": (params or {}).get("split_method", "time"),
                    # 自适应二分类阈值（训练集 Youden J），推理/回测判正类时应与此对齐
                    "cls_threshold": result.get("cls_threshold"),
                    # 预留测试集范围与样本数：便于对比「验证集 vs 测试集」泛化漂移
                    "test_range": (
                        {"start": test_start, "end": test_end} if test_start and test_end else None
                    ),
                    "n_test": result.get("n_test"),
                },
                "status": "ready",
            },
        )
        client.insert(
            "model_versions",
            {
                "model_id": model_id,
                "version": version,
                "file_path": file_path,
                "validation_metrics": result["metrics_table"],
                "is_current": True,
                "training_job_id": job_id,
            },
        )
        client.update(
            "training_jobs",
            {"model_id": model_id},
            filters={"job_id": f"eq.{job_id}"},
        )

        # ── 指标快照 ──
        top_imp = dict(
            sorted(result["feature_importance"].items(), key=lambda kv: kv[1], reverse=True)[:20]
        )
        metrics = {
            "train_auc": result["train_auc"],
            "valid_auc": result["valid_auc"],
            # 预留测试集 AUC（未预留或测试集单类别时为 None，前端据此隐藏该项）
            "test_auc": result.get("test_auc"),
            "train_samples": result["n_train"],
            "valid_samples": result["n_valid"],
            "test_samples": result.get("n_test", 0),
            # 特征输入顺序（模型 predict 时的列序，回测/推理必须严格对齐）
            "feature_cols": result["feature_cols"],
            # 完整评估指标表（训练/验证：AUC/准确/精确/召回/F1/混淆）
            "metrics_table": result["metrics_table"],
            # Top-20 重要度（快速展示用；完整版见 models.feature_importance）
            "feature_importance": top_imp,
            "model_id": model_id,
            "file_path": file_path,
            # 自适应二分类阈值（训练集 Youden J），评估指标表同口径
            "cls_threshold": result.get("cls_threshold"),
        }

        _update_job_status(
            job_id,
            status=STATUS_COMPLETED,
            stage="done",
            progress=1.0,
            metrics_preview=metrics,
            completed=True,
        )
        logger.info(
            "train.lightgbm.completed",
            job_id=job_id,
            model_id=model_id,
            valid_auc=result["valid_auc"],
        )
        return {
            "job_id": job_id,
            "status": STATUS_COMPLETED,
            "model_id": model_id,
            "metrics_preview": metrics,
        }

    except Exception as e:
        logger.exception("train.lightgbm.failed", job_id=job_id, error=str(e))
        try:
            _update_job_status(
                job_id,
                status=STATUS_FAILED,
                error={"type": type(e).__name__, "message": str(e)},
                completed=True,
            )
        except Exception:
            logger.exception("train.lightgbm.failure_write_db_failed", job_id=job_id)
        raise
