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


def test_train_job_config_extra_allow_preserves_extension_fields():
    """extra='allow' 必须保留 target_symbol / peer 等未显式声明的扩展字段，
    model_dump() 不能静默丢弃（否则「多股票预测单只」会失效）。"""
    cfg = TrainJobConfig(
        algorithm="lightgbm",
        target_symbol="600000.SH",
        peer={"group_by": "industry", "modes": ["rank", "relative"]},
    )
    assert cfg.target_symbol == "600000.SH"
    assert cfg.peer["group_by"] == "industry"
    dumped = cfg.model_dump()
    assert dumped["target_symbol"] == "600000.SH"
    assert dumped["peer"]["modes"] == ["rank", "relative"]


def test_train_job_config_defaults_no_target_symbol():
    cfg = TrainJobConfig()
    assert cfg.target_symbol is None
    assert cfg.peer is None


# ──────────────────────────────────────────
# 时间切分 / 同板块横截面特征（纯函数，不碰 DB）
# ──────────────────────────────────────────
_PIPELINE = _load_module(SVC_DIR / "pipeline.py", "train_svc_pipeline")


def test_split_train_valid_time_no_leakage():
    """时间切分：验证集所有日期必须严格晚于训练集（无未来函数）"""
    import numpy as np
    import pandas as pd

    dates = pd.date_range("2020-01-01", periods=100, freq="D").date
    df = pd.DataFrame({"symbol": ["A"] * 100, "dt": list(dates), "f": np.arange(100.0)})

    tr, va = _PIPELINE.split_train_valid(df, valid_ratio=0.2, split_method="time")
    assert len(tr) + len(va) == 100
    # 最近约 20% 交易日进入验证集（边界日归训练集，故验证集 <= 20）
    assert len(va) <= 20
    max_train = max(df["dt"].iloc[i] for i in tr)
    min_valid = min(df["dt"].iloc[i] for i in va)
    assert max_train < min_valid


def test_split_train_valid_single_day_falls_back_to_random():
    """仅单日数据无法时间切分，自动退化为 random 且不报错"""
    import numpy as np
    import pandas as pd

    d = pd.Timestamp("2020-01-01").date()
    df = pd.DataFrame({"symbol": ["A", "B"], "dt": [d, d], "f": [1.0, 2.0]})
    tr, va = _PIPELINE.split_train_valid(df, valid_ratio=0.5, split_method="time")
    assert len(tr) + len(va) == 2


def test_add_peer_features_rank_relative_sector_mean():
    """同板块横截面特征：rank 百分位 / 相对 z / 板块均值 计算正确"""
    import numpy as np
    import pandas as pd

    d1 = pd.Timestamp("2020-01-01").date()
    d2 = pd.Timestamp("2020-01-02").date()
    df = pd.DataFrame(
        {
            "symbol": ["A", "B", "C", "A", "B", "C"],
            "dt": [d1, d1, d1, d2, d2, d2],
            "f": [1.0, 2.0, 3.0, 10.0, 20.0, 30.0],
        }
    )
    group_map = {"A": "g1", "B": "g1", "C": "g1"}
    out, cols = _PIPELINE.add_peer_features(
        df, group_map, group_by="industry", modes=["rank", "relative", "sector_mean"]
    )

    # 组 rank 百分位（day1: 1/2/3 → 1/3, 2/3, 1）
    assert abs(out.loc[out.symbol == "A", "f__rank_industry"].iloc[0] - 1 / 3) < 1e-9
    assert "f__rel_industry" in cols
    assert "f__mean_industry" in cols
    # 板块均值 = 组内均值
    assert abs(out.loc[out.symbol == "A", "f__mean_industry"].iloc[0] - 2.0) < 1e-9


def test_train_lightgbm_returns_metrics_table():
    """train_lightgbm 返回评估指标表（train/valid：AUC/准确/精确/召回/F1/混淆）"""
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(0)
    n = 200
    dates = pd.date_range("2021-01-01", periods=100, freq="D").date
    df = pd.DataFrame(
        {
            "symbol": ["X"] * n,
            "dt": [dates[i % 100] for i in range(n)],
            "f1": rng.normal(size=n),
            "f2": rng.normal(size=n),
        }
    )
    # 让标签与 f1 相关，保证可学
    df["label"] = (df["f1"] + rng.normal(scale=0.5) > 0).astype(float)
    res = _PIPELINE.train_lightgbm(df, ["f1", "f2"], params={"label": {"kind": "return", "threshold": 0.0}})
    assert "metrics_table" in res
    mt = res["metrics_table"]
    for split in ("train", "valid"):
        m = mt[split]
        for k in ("auc", "accuracy", "precision", "recall", "f1", "confusion", "n"):
            assert k in m, f"{split}.{k} missing"
        assert len(m["confusion"]) == 2 and len(m["confusion"][0]) == 2
    # 特征重要度与特征顺序同序
    assert set(res["feature_importance"].keys()) == set(res["feature_cols"])


def test_train_lightgbm_split_range_valid_after_train():
    """时间切分下：验证集区间严格晚于训练集区间（无未来函数）"""
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(3)
    n = 200
    dates = pd.date_range("2021-01-01", periods=100, freq="D").date
    df = pd.DataFrame(
        {
            "symbol": ["X"] * n,
            "dt": [dates[i % 100] for i in range(n)],
            "f1": rng.normal(size=n),
            "f2": rng.normal(size=n),
        }
    )
    df["label"] = (df["f1"] + rng.normal(scale=0.5) > 0).astype(float)
    res = _PIPELINE.train_lightgbm(df, ["f1", "f2"], params={"label": {"kind": "return", "threshold": 0.0}})
    mt = res["metrics_table"]
    assert set(mt["split_range"].keys()) == {"train", "valid"}
    valid_start = pd.Timestamp(mt["split_range"]["valid"]["start"])
    train_end = pd.Timestamp(mt["split_range"]["train"]["end"])
    assert valid_start > train_end


def test_best_cls_threshold_finite_in_range():
    """Youden J 自适应阈值：返回有限值且被钳制在 [0.05, 0.95]"""
    import numpy as np

    y = np.array([0, 0, 1, 1])
    score = np.array([0.1, 0.2, 0.8, 0.9])  # 清晰可分
    thr = _PIPELINE._best_cls_threshold(y, score)
    assert np.isfinite(thr)
    assert 0.05 <= thr <= 0.95


def test_best_cls_threshold_beats_fixed_zero_five():
    """不平衡数据下：自适应阈值能召回正类，而固定 0.5 会漏掉全部正类"""
    import numpy as np

    # 正类 ~10%，正类分数 0.4、负类 0.2（固定 0.5 阈值全判负）
    y = np.array([0] * 90 + [1] * 10)
    score = np.array([0.2] * 90 + [0.4] * 10)
    thr = _PIPELINE._best_cls_threshold(y, score)
    assert (score >= thr).sum() > (score >= 0.5).sum()


def test_train_lightgbm_degenerate_when_no_signal():
    """模型无法分裂（min_child_samples 远超样本）→ 双 AUC=0.5，degenerate 标记
    为 True，Youden J 阈值回退 0.5。"""
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(0)
    n = 600
    dates = pd.date_range("2021-01-01", periods=200, freq="D").date
    df = pd.DataFrame(
        {
            "symbol": ["X"] * n,
            "dt": [dates[i % 200] for i in range(n)],
            "f1": rng.normal(size=n),
            "f2": rng.normal(size=n),
        }
    )
    df["label"] = (rng.normal(size=n) > 0).astype(float)
    # 强制决策树无法分裂 → 常数预测 → AUC=0.5
    res = _PIPELINE.train_lightgbm(
        df,
        ["f1", "f2"],
        params={"label": {"kind": "return", "threshold": 0.0}, "min_child_samples": 100000},
    )
    mt = res["metrics_table"]
    assert mt["degenerate"] is True
    assert res["cls_threshold"] == 0.5


def test_train_lightgbm_tune_returns_tuned_params():
    """开启 tune 时返回 tuned_params / cv_auc / cv_top，且自适应阈值字段仍齐全"""
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(2)
    n = 600
    dates = pd.date_range("2021-01-01", periods=200, freq="D").date
    df = pd.DataFrame(
        {
            "symbol": ["X"] * n,
            "dt": [dates[i % 200] for i in range(n)],
            "f1": rng.normal(size=n),
            "f2": rng.normal(size=n),
        }
    )
    df["label"] = (df["f1"] + rng.normal(scale=0.5) > 0).astype(float)
    res = _PIPELINE.train_lightgbm(
        df,
        ["f1", "f2"],
        params={"label": {"kind": "return", "threshold": 0.0}, "tune": True},
    )
    mt = res["metrics_table"]
    assert mt["tuned_params"] is not None
    assert mt["cv_auc"] is not None
    assert isinstance(mt["cv_top"], list) and len(mt["cv_top"]) > 0
    assert "cls_threshold" in mt




def test_train_lightgbm_three_way_split_with_test_set():
    """提供 test_start/test_end 时：metrics_table 含 test 拆分、时间范围齐全，
    且测试集时间区间严格晚于训练/验证窗口（测试集未泄漏进训练/调参）。"""
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(5)
    dates = pd.date_range("2021-01-01", periods=300, freq="D").date
    syms = ["X", "Y", "Z"]
    sym_col, dt_col, f1, f2 = [], [], [], []
    for d in dates:
        for s in syms:
            sym_col.append(s)
            dt_col.append(d)
            f1.append(rng.normal())
            f2.append(rng.normal())
    df = pd.DataFrame({"symbol": sym_col, "dt": dt_col, "f1": f1, "f2": f2})
    df["label"] = (df["f1"] + rng.normal(scale=0.5) > 0).astype(float)

    train_end = str(dates[199])  # 前 200 天为训练窗口
    test_start = str(dates[249])  # 后 50 天为预留测试集
    test_end = str(dates[299])
    res = _PIPELINE.train_lightgbm(
        df,
        ["f1", "f2"],
        params={
            "label": {"kind": "return", "threshold": 0.0},
            "train_end": train_end,
            "test_start": test_start,
            "test_end": test_end,
        },
    )
    mt = res["metrics_table"]
    assert "test" in mt
    assert set(mt["split_range"].keys()) == {"train", "valid", "test"}
    assert res["n_test"] > 0
    assert mt["test"]["n"] == res["n_test"]
    # 测试区间严格晚于训练/验证窗口上界（无泄漏）
    test_start_ts = pd.Timestamp(mt["split_range"]["test"]["start"])
    train_end_ts = pd.Timestamp(mt["split_range"]["train"]["end"])
    valid_end_ts = pd.Timestamp(mt["split_range"]["valid"]["end"])
    assert test_start_ts > train_end_ts
    assert test_start_ts > valid_end_ts
    # 默认（无 test）时不应出现 test 拆分
    res2 = _PIPELINE.train_lightgbm(
        df, ["f1", "f2"], params={"label": {"kind": "return", "threshold": 0.0}}
    )
    assert "test" not in res2["metrics_table"]
    assert "test" not in (res2["metrics_table"].get("split_range") or {})


def test_split_train_valid_excludes_test_by_train_end():
    """train_end 边界：dt>train_end 的样本（测试集）不得进入训练/验证切分。"""
    import pandas as pd

    dates = list(pd.date_range("2021-01-01", periods=120, freq="D").date)
    df = pd.DataFrame({"symbol": ["A"] * 120, "dt": dates, "f": [float(i) for i in range(120)]})
    train_end = dates[99]
    tr, va = _PIPELINE.split_train_valid(
        df, valid_ratio=0.2, split_method="time", train_end=str(train_end)
    )
    assert (df["dt"].iloc[list(tr)] <= train_end).all()
    assert (df["dt"].iloc[list(va)] <= train_end).all()
    chosen = set(tr.tolist() + va.tolist())
    test_idx = {i for i, d in enumerate(dates) if d > train_end}
    assert test_idx.isdisjoint(chosen)


def test_tune_on_valid_picks_valid_auc():
    """_tune_on_valid 在验证集上选最优：返回 best_params、valid_auc、非空候选榜。"""
    import numpy as np

    rng = np.random.default_rng(1)
    n = 400
    X = rng.normal(size=(n, 4))
    y = (X[:, 0] + rng.normal(scale=0.4) > 0).astype(int)
    Xv = rng.normal(size=(200, 4))
    yv = (Xv[:, 0] + rng.normal(scale=0.4) > 0).astype(int)
    best, auc, top = _PIPELINE._tune_on_valid(X, y, Xv, yv, {})
    assert isinstance(best, dict) and len(best) > 0
    assert auc is not None and 0.0 <= auc <= 1.0
    assert isinstance(top, list) and len(top) > 0



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

    from common import celery_app, get_pg_client

    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True

    # 先创建 job 记录
    job_id = new_job_id()
    client = get_pg_client()
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
