"""train-svc Celery worker 入口

启动 worker：
    cd python-services
    PYTHONPATH=. .venv/bin/celery -A celery_worker.celery_app worker \
        --workdir train-svc --loglevel=info --queues=train,default

或者在 Procfile 里（见本仓库 Procfile）。
"""

# 从 common 拿到配好的单例
# ⚠️ 必须 import tasks 才能触发任务注册
import tasks  # noqa: F401

from common import celery_app

__all__ = ["celery_app"]
