"""Builtin 因子完整性测试（T-3.03）

覆盖：
- 加载 80 个内置因子不报错
- 所有 id 唯一
- 所有公式能解析
- 所有 lookback/output_type 已推断
- 在 dummy panel 上每个都能执行
- 必填字段齐全（id/name/formula/category）
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

SVC_DIR = Path(__file__).parent.parent / "feature-svc"


def _load_factors():
    factors_dir = SVC_DIR / "factors"
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

    # 加载 builtin_loader 子模块
    loader_spec = importlib.util.spec_from_file_location(
        "factors.builtin_loader", factors_dir / "builtin_loader.py"
    )
    loader_mod = importlib.util.module_from_spec(loader_spec)
    sys.modules["factors.builtin_loader"] = loader_mod
    loader_spec.loader.exec_module(loader_mod)
    return loader_mod


_builtin_loader = _load_factors()
load_all_builtins = _builtin_loader.load_all_builtins
check_no_duplicate_ids = _builtin_loader.check_no_duplicate_ids
validate_with_engine = _builtin_loader.validate_with_engine


@pytest.fixture(scope="module")
def all_builtins():
    """加载全部内置因子（测模块内复用）"""
    return load_all_builtins()


@pytest.fixture(scope="module")
def dummy_panel():
    """260 天 × 3 股票，满足最长 lookback=250 的因子"""
    n_days = 260
    dates = pd.date_range("2024-01-01", periods=n_days, freq="B")
    rng = np.random.default_rng(42)
    syms = ["A", "B", "C"]
    close = pd.DataFrame(
        100 + np.cumsum(rng.standard_normal((n_days, 3)), axis=0),
        index=dates,
        columns=syms,
    )
    return {
        "close": close,
        "open": close.shift(1).fillna(close.iloc[0]),
        "high": close * 1.01,
        "low": close * 0.99,
        "volume": pd.DataFrame(
            rng.integers(1_000_000, 10_000_000, (n_days, 3)), index=dates, columns=syms
        ),
        "preclose": close.shift(1),
        "pct_change": close.pct_change(fill_method=None),
    }


class TestBuiltinInventory:
    """因子清单的基本属性"""

    def test_at_least_80_technical(self, all_builtins):
        """T-3.03 验收：至少 80 个技术因子"""
        tech = [f for f in all_builtins if f["category"] == "technical"]
        assert len(tech) >= 80, f"expected >= 80 technical factors, got {len(tech)}"

    def test_no_duplicate_ids(self, all_builtins):
        check_no_duplicate_ids(all_builtins)

    def test_all_required_fields_present(self, all_builtins):
        for f in all_builtins:
            assert f.get("id"), "factor missing id"
            assert f.get("name"), f"factor {f.get('id')} missing name"
            assert f.get("formula"), f"factor {f.get('id')} missing formula"
            assert f.get("category"), f"factor {f.get('id')} missing category"

    def test_all_have_inferred_lookback(self, all_builtins):
        """loader 应该已推断或读取 lookback_days"""
        for f in all_builtins:
            assert isinstance(f["lookback_days"], int), f"{f['id']} lookback not int"
            assert f["lookback_days"] >= 0

    def test_all_have_output_type(self, all_builtins):
        for f in all_builtins:
            assert f["output_type"] in {"boolean", "scalar", "rank"}, (
                f"{f['id']} unknown output_type {f['output_type']}"
            )

    def test_owner_is_platform(self, all_builtins):
        for f in all_builtins:
            assert f["owner"] == "platform", f"{f['id']} owner != platform"

    def test_visibility_is_public(self, all_builtins):
        for f in all_builtins:
            assert f["visibility"] == "public", f"{f['id']} visibility != public"


class TestBuiltinFormulas:
    """公式层面：全部可解析 + 可执行"""

    def test_all_formulas_executable(self, all_builtins, dummy_panel):
        """80 个因子在 260 天 × 3 股票上都能跑通"""
        failures = validate_with_engine(all_builtins, dummy_panel)
        if failures:
            msg = "\n".join(f"  {fid}: {err}" for fid, err in failures)
            pytest.fail(f"{len(failures)} factors failed engine:\n{msg}")

    def test_boolean_factor_has_bool_result(self, all_builtins, dummy_panel):
        """output_type=boolean 的因子应返回布尔数据"""
        from factors import eval_ast, parse_formula  # noqa: PLC0415

        # 只抽查 5 个 boolean 因子（全量测在 test_all_formulas_executable）
        booleans = [f for f in all_builtins if f["output_type"] == "boolean"][:5]
        for f in booleans:
            ast = parse_formula(f["formula"]).ast
            result = eval_ast(ast, dummy_panel)
            # dropna 后的值必须都是 bool 或 bool 可转
            valid = result.dropna(how="all").tail(10)
            # 允许 bool dtype 或能 astype(bool)
            assert valid.dtypes.apply(
                lambda d: str(d) in {"bool", "boolean"} or d == np.bool_
            ).all(), f"{f['id']} expected boolean dtype, got {valid.dtypes.tolist()}"

    def test_scalar_factor_has_numeric_result(self, all_builtins, dummy_panel):
        """output_type=scalar 的因子应返回数值"""
        from factors import eval_ast, parse_formula  # noqa: PLC0415

        scalars = [f for f in all_builtins if f["output_type"] == "scalar"][:5]
        for f in scalars:
            ast = parse_formula(f["formula"]).ast
            result = eval_ast(ast, dummy_panel)
            valid = result.dropna(how="all").tail(10)
            assert valid.dtypes.apply(
                lambda d: str(d).startswith("float") or str(d).startswith("int")
            ).all(), f"{f['id']} expected numeric dtype, got {valid.dtypes.tolist()}"


class TestBuiltinCategories:
    """按 8 大类分布校验（MVP Sprint0 PRD §T-3.03）"""

    def test_categories_covered(self, all_builtins):
        """清单应涵盖：均线/交叉/MACD/BOLL/RSI/KDJ/动量/波动率"""
        all_ids = {f["id"] for f in all_builtins}
        # 经典代表因子都应存在
        must_have = {
            "ma_5_above_close",  # 均线
            "golden_cross_5_20",  # 交叉
            "macd_positive",  # MACD
            "boll_break_upper",  # BOLL
            "rsi_14_oversold",  # RSI
            "kdj_k_oversold",  # KDJ
            "momentum_20d",  # 动量
            "volume_3x",  # 成交量
            "new_high_20d",  # 新高新低
            "volatility_20d",  # 波动率
        }
        missing = must_have - all_ids
        assert not missing, f"missing key factors: {missing}"

    def test_has_cross_up_and_cross_down(self, all_builtins):
        """金叉死叉必须成对覆盖"""
        ids = {f["id"] for f in all_builtins}
        assert any(i.startswith("golden_cross") for i in ids)
        assert any(i.startswith("death_cross") for i in ids)
