"""train-svc · 训练任务 API（FastAPI）

启动：
    uvicorn main:app --app-dir train-svc --port 8002

职责：
- 接收训练任务提交 → 写 training_jobs + 推 Celery 队列
- 查询任务状态（从 DB 读，以 DB 为准）
- 列出任务

Celery worker 由独立进程跑（Procfile `train-worker`）。
"""

from __future__ import annotations

# 任务导入（确保 Celery 注册；FastAPI 侧也需要）
import tasks  # noqa: F401
from common_utils import (
    STATUS_CANCELLED,
    STATUS_PENDING,
    TERMINAL_STATUSES,
    ErrorCode,
    TrainJobCreate,
    api_error,
    new_job_id,
    utc_now_iso,
)
from fastapi import APIRouter, Header, Query
from fastapi.responses import Response

from common import create_app, get_logger, get_pg_client, settings
from common.minio_client import download_bytes, get_presigned_url

logger = get_logger("train-svc")

app = create_app(
    service_name="train-svc",
    version="0.1.0",
    description="模型训练任务服务（Celery 驱动）",
)


@app.get("/", tags=["system"])
async def root() -> dict:
    return {
        "service": "train-svc",
        "docs": "/docs",
        "health": "/health",
        "port": settings.train_svc_port,
        "endpoints": [
            "POST /api/v1/training/jobs",
            "GET /api/v1/training/jobs",
            "GET /api/v1/training/jobs/{job_id}",
            "DELETE /api/v1/training/jobs/{job_id}",
        ],
        "status": "Epic 2 骨架 · dummy 训练任务；真实算法见 Epic 3 (T-3.02)",
    }


# ──────────────────────────────────────────
# 业务路由
# ──────────────────────────────────────────
router = APIRouter(prefix="/api/v1/training", tags=["training"])


def _resolve_user_id(x_user_id: str | None) -> str | None:
    """从 X-User-Id 头解析有效用户主键（auth.users.id / profiles.id）。

    非法值（anon/undefined/null/短串）视为匿名（None），避免污染 user_id 列。
    """
    if not x_user_id:
        return None
    if x_user_id in ("anon", "undefined", "null", ""):
        return None
    if len(x_user_id) < 32:  # UUID 长度 36，宽松下限 32
        return None
    return x_user_id


@router.post("/jobs", summary="提交训练任务（异步）")
async def create_training_job(
    payload: TrainJobCreate,
    x_user_id: str | None = Header(None, alias="X-User-Id"),
):
    """提交训练任务。

    流程：
    1. 生成 job_id
    2. 写 training_jobs（status=pending，含 user_id / target_symbol）
    3. 推 Celery 队列（queue=train）
    4. 立即返回 job_id + Celery task_id

    参数与结果的归属：user_id（用主键 id 关联 auth.users），config.owner 同步为该
    用户，训练完成后 models.owner=该用户，实现「参数 + 结果」按用户 + 任务 id 保存。
    """
    job_id = new_job_id()
    model_id = payload.model_id  # 可空；Epic 3 完成训练后才写入 models 表

    user_id = _resolve_user_id(x_user_id)

    # 登录用户：模型归属该用户（用主键 id）；匿名：保持 platform 归属
    if user_id:
        payload.config.owner = user_id

    config_dict = payload.config.model_dump()
    # target_symbol 提升为独立列（便于按目标分模块/过滤），空串归一为 NULL
    target_symbol = (config_dict.get("target_symbol") or "").strip() or None

    client = get_pg_client()
    client.insert(
        "training_jobs",
        {
            "job_id": job_id,
            "model_id": model_id,
            "user_id": user_id,
            "target_symbol": target_symbol,
            "status": STATUS_PENDING,
            "progress": 0,
            "stage": "queued",
            "config": config_dict,
        },
    )

    # 推 Celery：根据 algorithm 选择任务
    algorithm = config_dict.get("algorithm", "dummy")
    if algorithm == "dummy":
        async_result = tasks.dummy_train.delay(job_id, config_dict)
    elif algorithm == "lightgbm":
        # Epic 4 真实训练流水线
        async_result = tasks.lightgbm_train.delay(job_id, config_dict)
    else:
        # Epic 4 后续接入 xgboost / torch 等
        raise api_error(
            ErrorCode.INVALID_PARAM,
            f"Algorithm {algorithm!r} not implemented yet. "
            f"Supported: 'dummy', 'lightgbm'.",
        )

    logger.info("train.job.created", job_id=job_id, celery_task_id=async_result.id)

    return {
        "data": {
            "job_id": job_id,
            "status": STATUS_PENDING,
            "celery_task_id": async_result.id,
            "queued_at": utc_now_iso(),
        }
    }


@router.get("/jobs", summary="列出训练任务")
async def list_training_jobs(
    status: str | None = Query(None, description="过滤状态"),
    user_id: str | None = Query(None),
    target_symbol: str | None = Query(
        None,
        description="按预测目标股票过滤；传 '__none__' 只取全市场面板任务（target_symbol 为空）",
    ),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    filters: dict[str, str] = {}
    if status:
        filters["status"] = f"eq.{status}"
    if user_id:
        filters["user_id"] = f"eq.{user_id}"
    if target_symbol == "__none__":
        filters["target_symbol"] = "is.null"
    elif target_symbol:
        filters["target_symbol"] = f"eq.{target_symbol}"

    client = get_pg_client()
    total = client.count("training_jobs", filters=filters)

    offset = (page - 1) * page_size
    rows = client.select(
        "training_jobs",
        columns="job_id,model_id,user_id,target_symbol,status,progress,stage,config,"
        "metrics_preview,error,started_at,completed_at,created_at",
        filters=filters,
        order="created_at.desc",
        limit=page_size,
        offset=offset,
    )

    total_pages = (total + page_size - 1) // page_size if total > 0 else 0
    return {
        "data": rows,
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": total_pages,
            "has_next": page < total_pages,
        },
    }


@router.get("/targets", summary="按预测目标股票聚合训练任务（分模块用）")
async def list_training_targets(
    user_id: str | None = Query(None, description="按用户过滤（用主键 id）"),
):
    """按 target_symbol 聚合当前用户的训练任务，供训练首页「分模块」展示。

    返回每个目标股票的：任务数、最近任务状态/时间/名称。
    target_symbol 为空的任务归到 code=None（全市场面板）分组。
    """
    filters: dict[str, str] = {}
    if user_id:
        filters["user_id"] = f"eq.{user_id}"

    client = get_pg_client()
    rows = client.select(
        "training_jobs",
        columns="target_symbol,status,config,model_id,created_at",
        filters=filters,
        order="created_at.desc",
    )

    groups: dict[str, dict] = {}
    for r in rows:
        code = (r.get("target_symbol") or "").strip() or "__none__"
        g = groups.get(code)
        if g is None:
            cfg = r.get("config") or {}
            g = {
                "target_symbol": None if code == "__none__" else code,
                "job_count": 0,
                "completed_count": 0,
                # rows 已按 created_at desc，故首个命中即最近
                "latest_status": r.get("status"),
                "latest_created_at": r.get("created_at"),
                "latest_target": cfg.get("target"),
                "latest_algorithm": cfg.get("algorithm"),
            }
            groups[code] = g
        g["job_count"] += 1
        if r.get("status") == "completed":
            g["completed_count"] += 1

    # 排序：有目标的分组按最近任务时间倒序在前，全市场面板（None）排最后
    named = [g for g in groups.values() if g["target_symbol"] is not None]
    named.sort(key=lambda x: str(x["latest_created_at"] or ""), reverse=True)
    panel = [g for g in groups.values() if g["target_symbol"] is None]
    return {"data": named + panel}


@router.get("/jobs/{job_id}", summary="查询训练任务详情")
async def get_training_job(job_id: str):
    client = get_pg_client()
    rows = client.select(
        "training_jobs",
        filters={"job_id": f"eq.{job_id}"},
        limit=1,
    )
    if not rows:
        raise api_error(
            ErrorCode.JOB_NOT_FOUND,
            f"Training job not found: {job_id}",
            status=404,
            job_id=job_id,
        )
    return {"data": rows[0]}


@router.get("/jobs/{job_id}/result", summary="训练结果产物（模型/特征顺序/重要度/指标表）")
async def get_training_result(job_id: str):
    """训练完成后的「一站式结果产物」，供前端训练页直接展示 / 回测直接调用。

    返回：
    - model_id / model_name / algorithm / target
    - file_path（模型文件 MinIO 路径）+ download_url（预签名下载链接）
    - input_features（特征输入顺序，predict 必须严格对齐）
    - feature_importance（完整重要度，与 input_features 同序）
    - metrics_table（训练/验证评估指标表：AUC/准确/精确/召回/F1/混淆矩阵）
    - label_spec / peer / split_method / target_symbol（训练配置回溯）
    """
    client = get_pg_client()
    jobs = client.select(
        "training_jobs",
        filters={"job_id": f"eq.{job_id}"},
        columns="job_id,model_id,status,config,metrics_preview",
        limit=1,
    )
    if not jobs:
        raise api_error(
            ErrorCode.JOB_NOT_FOUND,
            f"Training job not found: {job_id}",
            status=404,
            job_id=job_id,
        )
    job = jobs[0]
    model_id = job.get("model_id")
    if not model_id:
        # 任务可能仍在跑或失败：返回当前已有信息，便于前端判断
        return {
            "data": {
                "job_id": job_id,
                "status": job.get("status"),
                "ready": False,
                "metrics_preview": job.get("metrics_preview"),
                "message": "模型尚未注册（任务未完成或失败）",
            }
        }

    models = client.select(
        "models",
        filters={"id": f"eq.{model_id}"},
        columns=(
            "id,name,algorithm,target,input_features,feature_importance,"
            "validation_metrics,file_path,file_size,training_range,metadata,version"
        ),
        limit=1,
    )
    if not models:
        raise api_error(
            ErrorCode.JOB_NOT_FOUND,
            f"Model not found for job: {model_id}",
            status=404,
            model_id=model_id,
        )
    m = models[0]
    meta = m.get("metadata") or {}

    download_url = None
    fp = m.get("file_path")
    if fp:
        try:
            download_url = get_presigned_url(fp, expires_seconds=600)
        except Exception as e:  # noqa: BLE001
            logger.warning("train.result.presign_failed", model_id=model_id, error=str(e))

    return {
        "data": {
            "job_id": job_id,
            "status": job.get("status"),
            "ready": True,
            "model_id": m["id"],
            "model_name": m.get("name"),
            "algorithm": m.get("algorithm"),
            "target": m.get("target"),
            "version": m.get("version"),
            "model_file": {
                "file_path": fp,
                "file_size": m.get("file_size"),
                "download_url": download_url,
            },
            "input_features": m.get("input_features"),  # 特征输入顺序
            "feature_importance": m.get("feature_importance"),  # 完整重要度
            "metrics_table": m.get("validation_metrics"),  # 评估指标表
            "training_range": m.get("training_range"),
            "config": {
                "label_spec": meta.get("label_spec"),
                "target_symbol": meta.get("target_symbol"),
                "peer": meta.get("peer"),
                "split_method": meta.get("split_method", "time"),
            },
            "metrics_preview": job.get("metrics_preview"),
        }
    }


@router.get("/models/{model_id}/download", summary="获取模型文件预签名下载链接")
async def download_model(model_id: str):
    """返回模型文件的预签名下载 URL（默认 10 分钟有效）。

    前端「下载模型」按钮直接打开该 URL 即可拿到 .txt（LightGBM booster 字符串）。
    """
    client = get_pg_client()
    rows = client.select(
        "models",
        filters={"id": f"eq.{model_id}"},
        columns="id,name,file_path,file_size",
        limit=1,
    )
    if not rows or not rows[0].get("file_path"):
        raise api_error(
            ErrorCode.JOB_NOT_FOUND,
            f"Model file not found: {model_id}",
            status=404,
            model_id=model_id,
        )
    m = rows[0]
    try:
        url = get_presigned_url(m["file_path"], expires_seconds=600)
    except Exception as e:  # noqa: BLE001
        logger.error("train.download.presign_failed", model_id=model_id, error=str(e))
        raise api_error(
            ErrorCode.INVALID_PARAM,
            f"生成下载链接失败：{e}",
            status=500,
            model_id=model_id,
        )
    return {
        "data": {
            "model_id": m["id"],
            "name": m.get("name"),
            "file_path": m["file_path"],
            "file_size": m.get("file_size"),
            "download_url": url,
            "expires_in_seconds": 600,
        }
    }


@router.get("/models/{model_id}/file", summary="模型文件下载（同源流式转发）")
async def download_model_file(model_id: str):
    """经 train-svc 流式转发 MinIO 模型文件，替代预签名 URL。

    预签名 URL 指向 localhost:9000——远程浏览器里 localhost 是用户自己电脑，
    必然 ERR_CONNECTION_REFUSED（手册 ## 0）。前端走 /svc/train 同源代理访问本端点。
    """
    client = get_pg_client()
    rows = client.select(
        "models",
        filters={"id": f"eq.{model_id}"},
        columns="id,name,file_path",
        limit=1,
    )
    if not rows or not rows[0].get("file_path"):
        raise api_error(
            ErrorCode.JOB_NOT_FOUND,
            f"Model file not found: {model_id}",
            status=404,
            model_id=model_id,
        )
    fp = rows[0]["file_path"]
    try:
        data = download_bytes(fp)
    except Exception as e:  # noqa: BLE001
        logger.error("train.download.read_failed", model_id=model_id, error=str(e))
        raise api_error(
            ErrorCode.INVALID_PARAM,
            f"读取模型文件失败：{e}",
            status=500,
            model_id=model_id,
        )
    filename = fp.rsplit("/", 1)[-1] or f"{model_id}.txt"
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete("/jobs/{job_id}", summary="取消训练任务")
async def cancel_training_job(job_id: str):
    """仅支持取消 pending / running 状态的任务。

    注意：已经在 worker 里跑的任务，revoke(terminate=True) 会发 SIGTERM，
    任务看自己的中断点决定是否响应。MVP 只标状态不终止进程。
    """
    client = get_pg_client()
    rows = client.select(
        "training_jobs",
        filters={"job_id": f"eq.{job_id}"},
        columns="job_id,status",
        limit=1,
    )
    if not rows:
        raise api_error(
            ErrorCode.JOB_NOT_FOUND,
            f"Training job not found: {job_id}",
            status=404,
        )
    current = rows[0]["status"]
    if current in TERMINAL_STATUSES:
        raise api_error(
            ErrorCode.JOB_ALREADY_TERMINAL,
            f"Job already in terminal state: {current}",
            status=409,
            current_status=current,
        )

    # 只更新状态；真正终止见 Epic 6
    client.update(
        "training_jobs",
        {
            "status": STATUS_CANCELLED,
            "completed_at": utc_now_iso(),
        },
        filters={"job_id": f"eq.{job_id}"},
    )
    return {"data": {"job_id": job_id, "status": STATUS_CANCELLED}}


app.include_router(router)
