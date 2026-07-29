"""backtest-svc Celery worker 入口 + 异步回测任务（消费 backtest.* 队列）。

启动（见 python-services/start-celery.sh）：
    python -m celery -A celery_worker.celery_app worker --queues=backtest --loglevel=info
"""
import time
from collections.abc import Callable
from datetime import UTC, datetime

from common.celery_app import celery_app
from common import get_logger, get_pg_client

logger = get_logger("backtest.tasks")


def _ensure_progress_column(client) -> None:
    """确保 backtests 表有 progress/meta 列（幂等；迁移未执行时自动补）。"""
    try:
        conn = client._conn()
        try:
            cur = conn.cursor()
            cur.execute("ALTER TABLE backtests ADD COLUMN IF NOT EXISTS progress JSONB;")
            cur.execute("ALTER TABLE backtests ADD COLUMN IF NOT EXISTS meta JSONB;")
            conn.commit()
        finally:
            client._put(conn)
    except Exception as e:  # noqa: BLE001
        logger.warning("backtest.ensure_columns_skip", error=str(e))


@celery_app.task(name="backtest.run_backtest", bind=True, max_retries=0)
def run_backtest(self, backtest_id: str, config: dict) -> None:
    client = get_pg_client()
    _ensure_progress_column(client)

    def _on_progress(stage: str, pct: int) -> None:
        try:
            client.update(
                "backtests",
                {"status": "running", "progress": {"pct": pct, "stage": stage}},
                filters={"id": f"eq.{backtest_id}"},
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("backtest.progress_update_failed", id=backtest_id, error=str(e))

    try:
        strategy = config.get("strategy") or {}
        t0 = time.perf_counter()
        _on_progress("queued", 2)

        if strategy.get("type") == "model":
            from real_engine import run_real_backtest

            result = run_real_backtest(config, on_progress=_on_progress)
        else:
            # factor / composite / signal_file：统一走真实横截面引擎
            from real_engine import run_real_backtest

            result = run_real_backtest(config, on_progress=_on_progress)

        duration_ms = max(1, int((time.perf_counter() - t0) * 1000))
        now = datetime.now(UTC).isoformat()
        client.update(
            "backtests",
            {
                "status": "completed",
                "summary": result["summary"],
                "equity_curve": result["equity_curve"],
                "segment_performance": result.get("segment_performance"),
                "feature_importance": result.get("feature_importance"),
                "meta": result.get("meta"),
                "duration_ms": duration_ms,
                "completed_at": now,
                "progress": {"pct": 100, "stage": "completed"},
            },
            filters={"id": f"eq.{backtest_id}"},
        )
    except Exception as e:  # noqa: BLE001
        logger.error("backtest.task_failed", id=backtest_id, error=str(e))
        try:
            client.update(
                "backtests",
                {
                    "status": "failed",
                    "error": {"message": str(e), "type": type(e).__name__},
                    "completed_at": datetime.now(UTC).isoformat(),
                    "progress": {"pct": 100, "stage": "failed"},
                },
                filters={"id": f"eq.{backtest_id}"},
            )
        except Exception as inner:  # noqa: BLE001
            logger.error("backtest.fail_persist_failed", error=str(inner))


__all__ = ["celery_app", "run_backtest"]
