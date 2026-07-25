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
import os

import feature_tasks  # noqa: F401
import tasks  # noqa: F401
from celery.schedules import crontab

from common import celery_app

# ═══════════════════════════════════════════════════════════════
# Celery Beat 定时调度（T-3.05）
# ═══════════════════════════════════════════════════════════════
#
# 每日 17:00（Asia/Shanghai）触发增量因子计算。
# A 股 15:00 收盘，数据源同步到 Supabase 约 16:00，预留缓冲。
#
# 启动 Beat：在 Procfile 里的 `feature-beat` 行，或 start-dev.ps1 自动拉起。
#
# 默认开启：2026-05-01 曾因 Supabase Free tier 磁盘 500MB 接近上限而暂停；
# 现已迁移到自托管 Supabase Lite（Docker），磁盘不再受限，故默认启用。
# 仍可用环境变量 ENABLE_DAILY_BEAT=0 关闭。

if os.environ.get("ENABLE_DAILY_BEAT", "1") == "1":
    # 调度分层原则：「是否交易日」由数据源自检判定，不靠星期几硬编码
    # （星期几不可靠：调休/规则变化/其他市场都可能打破"周一~周五开市"的假设）。
    #
    # ①② 数据拉取任务：每天触发，脚本内交易日自检兜底——非交易日零成本退出
    #     （1 次指数探测 + 1 次 DB 查询，见 update_5m_klines.py::is_trade_day）。
    # ③ 因子计算：保持仅工作日——周末 A 股必闭市无新 K线可算，
    #     跑了只会触发 zero_records 噪音告警；周一 days=2 自动覆盖周末无缺口。
    celery_app.conf.beat_schedule = {
        # ① 盘后先拉 5m K线并聚合日K（A股 15:00 收盘 + 数据源同步缓冲）
        "daily-5m-klines-update": {
            "task": "feature.update_klines_5m",
            "schedule": crontab(hour=17, minute=35),  # 每天；非交易日自检退出
            "options": {"queue": "feature"},
        },
        # ② 市场快照（指数/北向/涨跌家数）
        "daily-market-snapshots-update": {
            "task": "feature.update_market_snapshots",
            "schedule": crontab(hour=17, minute=45),  # 每天；非交易日脚本内跳过
            "options": {"queue": "feature"},
        },
        # ③ K线落库后再算因子（原 17:00 常因 K线未刷新而 0 条写入，改 19:00）
        "daily-incremental-factor-compute": {
            "task": "feature.compute_incremental",
            "schedule": crontab(hour=19, minute=0, day_of_week="1-5"),  # 仅工作日
            "kwargs": {"days": 2},
            "options": {"queue": "feature"},
        },
        # ④ 汇总当天各表写入量 → daily_data_metrics（数据管理页图表数据源）
        "daily-metrics-collect": {
            "task": "feature.collect_daily_metrics",
            "schedule": crontab(hour=20, minute=0),  # 每天 20:00
            "options": {"queue": "feature"},
        },
    }
else:
    celery_app.conf.beat_schedule = {}


__all__ = ["celery_app"]
