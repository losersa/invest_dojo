"""共享 Celery 应用配置

所有异步任务服务（train-svc / backtest-svc / 因子回填等）都通过 `celery_app`
获得统一的 broker / backend / 序列化 / 时区 / 任务路由配置。

Broker 和 Result backend 都用 Redis（与 pub/sub 共享 Redis 实例，DB 不同）：
- DB 0: 通用（pub/sub, cache, rate limit）
- DB 1: Celery broker
- DB 2: Celery result backend

任务路由：
- `train.*` → queue=train
- `backtest.*` → queue=backtest
- `feature.*` → queue=feature
- 默认 → queue=default
"""
from __future__ import annotations

from celery import Celery

from common.config import settings


# 推导 Celery 专属 Redis URL（复用 redis_host / redis_port）
def _redis_db_url(db: int) -> str:
    """替换默认 DB，或直接拼"""
    base = settings.redis_url.rstrip("/")
    # 格式 redis://host:port/0 → 替换最后一段
    if "/" in base.split("://")[-1]:
        prefix = base.rsplit("/", 1)[0]
    else:
        prefix = base
    return f"{prefix}/{db}"


CELERY_BROKER_URL = _redis_db_url(1)
CELERY_BACKEND_URL = _redis_db_url(2)


def create_celery_app(
    name: str = "investdojo",
    *,
    include: list[str] | None = None,
) -> Celery:
    """工厂：创建配置好的 Celery 应用

    Args:
        name: app 名字（会显示在 flower 上）
        include: 任务模块列表，如 ["tasks"]
            注意：模块名需要能被 Python import。推荐启动 worker 时
            用 `--workdir train-svc`，然后传 `include=["tasks"]`。
    """
    app = Celery(name, broker=CELERY_BROKER_URL, backend=CELERY_BACKEND_URL)

    app.conf.update(
        # ── 序列化 ──
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],

        # ── 时区 ──
        timezone="Asia/Shanghai",
        enable_utc=True,

        # ── 超时 & 重试 ──
        task_time_limit=3600,                 # 硬超时 1 小时（Epic 3 会调）
        task_soft_time_limit=3300,            # 软超时 55 分钟
        task_acks_late=True,                  # 任务执行完才 ACK（防 worker 挂了丢任务）
        task_reject_on_worker_lost=True,

        # ── worker ──
        worker_prefetch_multiplier=1,         # 每次只取 1 个任务（IO 密集型回测类）
        worker_max_tasks_per_child=100,       # 跑 100 个任务后重启子进程（防内存泄漏）

        # ── 结果 ──
        result_expires=86400,                 # 结果保留 24h
        result_extended=True,                 # 保留更多元信息（task name、args）

        # ── 路由 ──
        task_default_queue="default",
        task_routes={
            "train.*": {"queue": "train"},
            "backtest.*": {"queue": "backtest"},
            "feature.*": {"queue": "feature"},
        },

        # ── 任务发现 ──
        imports=include or [],
    )

    return app


# 单例（不自动 include tasks，各服务自己 import tasks 模块）
celery_app = create_celery_app()
