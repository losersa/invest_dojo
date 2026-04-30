"""train-svc 单元测试

覆盖：
1. job_id 生成格式
2. 状态常量契约
3. TrainJobConfig 校验
4. dummy_train 任务（用 always_eager 模式同步跑）

注意：dummy_train 测试会真的写 Supabase，因此标 integration。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SVC_DIR = Path(__file__).parent.parent / "train-svc"


def _load_module(path: Path, name: str):
    if name in sys.modules:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# 加载 train-svc common_utils（别名，避免与其他 svc 同名冲突）
_cu = _load_module(SVC_DIR / "common_utils.py", "train_svc_common_utils")

new_job_id = _cu.new_job_id
utc_now_iso = _cu.utc_now_iso
TERMINAL_STATUSES = _cu.TERMINAL_STATUSES
VALID_STATUSES = _cu.VALID_STATUSES
TrainJobConfig = _cu.TrainJobConfig
TrainJobCreate = _cu.TrainJobCreate


# ──────────────────────────────────────────
# 单元测试（不碰 DB / Redis）
# ──────────────────────────────────────────
def test_new_job_id_format():
    jid = new_job_id()
    assert jid.startswith("train_")
    assert len(jid) == len("train_") + 12  # 12 位 hex


def test_new_job_id_unique():
    assert new_job_id() != new_job_id()


def test_utc_now_iso_format():
    v = utc_now_iso()
    # ISO 8601 with timezone
    assert "T" in v
    assert "+00:00" in v or v.endswith("Z")


def test_terminal_statuses_subset_of_valid():
    assert TERMINAL_STATUSES.issubset(VALID_STATUSES)


def test_terminal_includes_completed_failed_cancelled():
    assert "completed" in TERMINAL_STATUSES
    assert "failed" in TERMINAL_STATUSES
    assert "cancelled" in TERMINAL_STATUSES
    assert "pending" not in TERMINAL_STATUSES
    assert "running" not in TERMINAL_STATUSES


def test_train_job_config_defaults():
    cfg = TrainJobConfig()
    assert cfg.algorithm == "dummy"
    assert cfg.target == "return_5d"
    assert cfg.features == []
    assert cfg.simulated_duration_sec == 2


def test_train_job_config_rejects_negative_duration():
    with pytest.raises(Exception):  # pydantic ValidationError
        TrainJobConfig(simulated_duration_sec=-1)


def test_train_job_config_rejects_huge_duration():
    with pytest.raises(Exception):
        TrainJobConfig(simulated_duration_sec=99999)


def test_train_job_create_minimal():
    """最简提交：只给 config"""
    body = TrainJobCreate(config=TrainJobConfig())
    assert body.model_id is None
    assert body.config.algorithm == "dummy"


def test_train_job_create_full():
    body = TrainJobCreate(
        model_id="m_test_1",
        config=TrainJobConfig(
            algorithm="dummy",
            features=["ma_cross_5_20"],
            target="return_5d",
            simulated_duration_sec=1,
        ),
    )
    assert body.model_id == "m_test_1"
    assert body.config.features == ["ma_cross_5_20"]


# ──────────────────────────────────────────
# 集成测试（需要 Redis + Supabase）
# ──────────────────────────────────────────
@pytest.mark.integration
def test_dummy_train_eager_mode():
    """用 Celery eager 模式同步跑 dummy_train"""
    # Eager 配置 + 加载 tasks
    sys.modules["common_utils"] = _cu
    if str(SVC_DIR) not in sys.path:
        sys.path.insert(0, str(SVC_DIR))
    _tasks = _load_module(SVC_DIR / "tasks.py", "train_svc_tasks")

    from common import celery_app, get_supabase_client

    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True

    # 先创建 job 记录
    job_id = new_job_id()
    client = get_supabase_client()
    client.insert(
        "training_jobs",
        {
            "job_id": job_id,
            "status": "pending",
            "progress": 0,
            "stage": "queued",
            "config": {"algorithm": "dummy", "simulated_duration_sec": 0},
        },
    )

    try:
        # eager 模式下 .delay() 会同步执行
        result = _tasks.dummy_train.delay(
            job_id, {"algorithm": "dummy", "simulated_duration_sec": 0}
        )
        assert result.get()["status"] == "completed"

        # 校验 DB 状态
        rows = client.select(
            "training_jobs",
            filters={"job_id": f"eq.{job_id}"},
            limit=1,
        )
        assert len(rows) == 1
        assert rows[0]["status"] == "completed"
        assert rows[0]["progress"] == 1.0
        assert rows[0]["metrics_preview"]["train_auc"] == 0.687
    finally:
        # 清理
        client.delete("training_jobs", filters={"job_id": f"eq.{job_id}"})
        celery_app.conf.task_always_eager = False
