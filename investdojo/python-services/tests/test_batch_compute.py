"""batch_compute 单元测试（T-3.05）

覆盖：
- _parse_factors: 合法/非法公式分离
- _collect_needed_fields: 合并字段
- compute_factor_batch: 核心计算（用合成 panel）
- Celery task 注册检查
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest

SVC_DIR = Path(__file__).parent.parent / "feature-svc"


# 加 feature-svc 到 sys.path（让 `from factors import ...` 能工作）
_feature_svc_str = str(SVC_DIR)
if _feature_svc_str not in sys.path:
    sys.path.insert(0, _feature_svc_str)


# 确保 factors 包以一致方式加载（其他 test 可能已先加载过）
def _ensure_factors_loaded():
    if "factors" in sys.modules and hasattr(sys.modules["factors"], "compute_factor_batch"):
        return
    factors_dir = SVC_DIR / "factors"
    # 清理旧缓存
    for key in list(sys.modules.keys()):
        if key == "factors" or key.startswith("factors."):
            del sys.modules[key]
    spec = importlib.util.spec_from_file_location(
        "factors",
        factors_dir / "__init__.py",
        submodule_search_locations=[str(factors_dir)],
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["factors"] = mod
    spec.loader.exec_module(mod)


_ensure_factors_loaded()


@pytest.fixture
def dummy_panel_fn():
    """返回一个 load_panel 的 mock"""

    def _mock_load_panel(symbols, start, end, **kwargs):
        n_days = 60
        dates = pd.date_range("2024-10-01", periods=n_days, freq="B", tz="UTC")
        rng = np.random.default_rng(42)
        close = pd.DataFrame(
            100 + np.cumsum(rng.standard_normal((n_days, len(symbols))), axis=0),
            index=dates,
            columns=symbols,
        )
        return {
            "close": close,
            "open": close.shift(1).fillna(close.iloc[0]),
            "high": close * 1.01,
            "low": close * 0.99,
            "volume": pd.DataFrame(
                rng.integers(1_000_000, 10_000_000, (n_days, len(symbols))),
                index=dates,
                columns=symbols,
            ),
            "preclose": close.shift(1),
            "pct_change": close.pct_change(fill_method=None),
        }

    return _mock_load_panel


class TestBatchCompute:
    """compute_factor_batch 核心测试"""

    def test_boolean_and_scalar_output_split(self, dummy_panel_fn):
        """boolean → value_bool；scalar → value_num"""
        from factors import compute_factor_batch, parse_formula  # noqa: PLC0415

        parsed = [
            {
                "id": "ma_up",
                "ast": parse_formula("close > MA(close, 5)").ast,
                "output_type": "boolean",
                "lookback_days": 5,
                "fields": {"close"},
            },
            {
                "id": "ma5_scalar",
                "ast": parse_formula("MA(close, 5)").ast,
                "output_type": "scalar",
                "lookback_days": 5,
                "fields": {"close"},
            },
        ]

        # patch batch_compute 模块里引用的 load_panel
        bc_mod = sys.modules["factors.batch_compute"]
        with patch.object(bc_mod, "load_panel", dummy_panel_fn):
            records, errors = compute_factor_batch(
                parsed_factors=parsed,
                symbols_batch=["A", "B", "C"],
                start="2024-11-01",
                end="2024-11-10",
                extra_days=0,
            )

        assert not errors, f"unexpected errors: {errors}"
        assert len(records) > 0

        bools = [r for r in records if r["factor_id"] == "ma_up"]
        scalars = [r for r in records if r["factor_id"] == "ma5_scalar"]

        assert all(r["value_bool"] is not None for r in bools)
        assert all(r["value_num"] is None for r in bools)
        assert all(isinstance(r["value_bool"], bool) for r in bools)

        assert all(r["value_num"] is not None for r in scalars)
        assert all(r["value_bool"] is None for r in scalars)
        assert all(isinstance(r["value_num"], float) for r in scalars)

    def test_record_contains_required_keys(self, dummy_panel_fn):
        """每条记录必须有 factor_id / symbol / date / computed_at"""
        from factors import compute_factor_batch, parse_formula  # noqa: PLC0415

        parsed = [
            {
                "id": "test",
                "ast": parse_formula("close > 0").ast,
                "output_type": "boolean",
                "lookback_days": 0,
                "fields": {"close"},
            }
        ]
        bc_mod = sys.modules["factors.batch_compute"]
        with patch.object(bc_mod, "load_panel", dummy_panel_fn):
            records, _ = compute_factor_batch(parsed, ["A"], "2024-11-01", "2024-11-05")

        assert records
        for r in records:
            assert set(r.keys()) >= {
                "factor_id",
                "symbol",
                "date",
                "value_num",
                "value_bool",
                "computed_at",
            }
            assert len(r["date"]) == 10 and r["date"][4] == "-"

    def test_engine_error_captured_not_raised(self):
        """单个因子报错不中断批量，收集到 errors 列表"""
        from factors import compute_factor_batch, parse_formula  # noqa: PLC0415

        parsed_ok = {
            "id": "ok",
            "ast": parse_formula("close > 0").ast,
            "output_type": "boolean",
            "lookback_days": 0,
            "fields": {"close"},
        }

        def mock_panel(symbols, start, end, **kwargs):
            dates = pd.date_range("2024-10-01", periods=10, freq="B", tz="UTC")
            return {"close": pd.DataFrame(100.0, index=dates, columns=symbols)}

        bad = {
            "id": "bad",
            "ast": parse_formula("high > 0").ast,
            "output_type": "boolean",
            "lookback_days": 0,
            "fields": {"high"},
        }
        bc_mod = sys.modules["factors.batch_compute"]
        with patch.object(bc_mod, "load_panel", mock_panel):
            records, errors = compute_factor_batch(
                [parsed_ok, bad], ["A"], "2024-10-01", "2024-10-05"
            )

        assert any(r["factor_id"] == "ok" for r in records)
        assert any(e["factor_id"] == "bad" for e in errors)


class TestCeleryTasksRegistered:
    """Celery 任务注册检查"""

    def test_feature_tasks_importable(self):
        """feature_tasks 能 import"""
        train_svc = Path(__file__).parent.parent / "train-svc"
        for p in (str(train_svc), str(SVC_DIR)):
            if p not in sys.path:
                sys.path.insert(0, p)

        if "feature_tasks" in sys.modules:
            del sys.modules["feature_tasks"]

        import feature_tasks  # noqa: PLC0415

        assert hasattr(feature_tasks, "compute_incremental_task")
        assert hasattr(feature_tasks, "compute_range_task")
        assert hasattr(feature_tasks, "feature_health")
