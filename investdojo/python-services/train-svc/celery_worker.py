"""train-svc Celery worker 入口（同时托管 feature 因子计算任务）

启动 worker：
    cd python-services
    PYTHONPATH=. .venv/bin/celery -A celery_worker.celery_app worker \
        --workdir train-svc --loglevel=info --queues=train,feature,default

或者在 Procfile 里（见本仓库 Procfile）。

包含任务：
- tasks.py: train.* 任务（T-2.02）
- feature_tasks.py: feature.* 任务（T-3.05）
"""

# 从 common 拿到配好的单例
# ⚠️ 必须 import 任务模块才能触发注册
import feature_tasks  # noqa: F401
import tasks  # noqa: F401

# ═══════════════════════════════════════════════════════════════
# Celery Beat 定时调度（T-3.05）
# ═══════════════════════════════════════════════════════════════
#
# 每日 17:00（Asia/Shanghai）触发增量因子计算。
# A 股 15:00 收盘，数据源同步到 Supabase 约 16:00，预留缓冲。
#
# 启动 Beat：在 Procfile 里的 `feature-beat` 行。
from celery.schedules import crontab  # noqa: E402

from common import celery_app

celery_app.conf.beat_schedule = {
    "daily-incremental-factor-compute": {
        "task": "feature.compute_incremental",
        "schedule": crontab(hour=17, minute=0),  # 每天 17:00
        "kwargs": {"days": 2},
        "options": {"queue": "feature"},
    },
}


__all__ = ["celery_app"]
