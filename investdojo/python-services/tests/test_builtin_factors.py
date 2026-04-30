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
    """260 天 × 3 股票，满足最长 lookback=250 的因子。

    包含 K 线 + 所有 fundamental + derived 字段（使用合成数据，仅测执行路径）
    """
    n_days = 260
    dates = pd.date_range("2024-01-01", periods=n_days, freq="B")
    rng = np.random.default_rng(42)
    syms = ["A", "B", "C"]
    close = pd.DataFrame(
        100 + np.cumsum(rng.standard_normal((n_days, 3)), axis=0),
        index=dates,
        columns=syms,
    )
    panel = {
        "close": close,
        "open": close.shift(1).fillna(close.iloc[0]),
        "high": close * 1.01,
        "low": close * 0.99,
        "volume": pd.DataFrame(
            rng.integers(1_000_000, 10_000_000, (n_days, 3)), index=dates, columns=syms
        ),
        "turnover": pd.DataFrame(rng.uniform(1e8, 1e9, (n_days, 3)), index=dates, columns=syms),
        "preclose": close.shift(1),
        "pct_change": close.pct_change(fill_method=None),
    }
    # 所有基本面字段（合成数据，0.1~0.5 的小数）
    fund_fields = [
        "eps_ttm",
        "roe",
        "gp_margin",
        "np_margin",
        "net_profit",
        "total_share",
        "liqa_share",
        "revenue",
        "yoy_ni",
        "yoy_pni",
        "yoy_asset",
        "yoy_equity",
        "yoy_eps",
        "cash_ratio",
        "quick_ratio",
        "current_ratio",
        "yoy_liability",
        "asset_to_equity",
        "debt_asset_ratio",
        "cfo_to_gr",
        "cfo_to_np",
        "cfo_to_or",
        "ca_to_asset",
        "nca_to_asset",
        "asset_turn_ratio",
        "ca_turn_ratio",
        "inv_turn_days",
        "nr_turn_days",
    ]
    for fld in fund_fields:
        panel[fld] = pd.DataFrame(rng.uniform(0.1, 0.5, (n_days, 3)), index=dates, columns=syms)
    # 衍生字段
    panel["market_cap"] = close * 1e9
    panel["pe_ttm"] = close / panel["eps_ttm"]
    panel["pb"] = close / (panel["eps_ttm"] / panel["roe"])
    return panel


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


class TestT304Coverage:
    """T-3.04 验收：至少 200 个因子，4 大类全覆盖"""

    def test_total_at_least_200(self, all_builtins):
        """总计至少 200 个"""
        assert len(all_builtins) >= 200, f"expected >= 200, got {len(all_builtins)}"

    def test_four_categories_present(self, all_builtins):
        """technical / valuation / growth / sentiment 四大类都要有"""
        cats = {f["category"] for f in all_builtins}
        required = {"technical", "valuation", "growth", "sentiment"}
        missing = required - cats
        assert not missing, f"missing categories: {missing}"

    def test_each_category_has_40_plus(self, all_builtins):
        """每大类至少 40 个"""
        from collections import Counter  # noqa: PLC0415

        cnt = Counter(f["category"] for f in all_builtins)
        for cat in ["valuation", "growth", "sentiment"]:
            assert cnt[cat] >= 40, f"{cat} has only {cnt[cat]} factors"

    def test_valuation_key_factors_exist(self, all_builtins):
        """估值类经典因子"""
        ids = {f["id"] for f in all_builtins}
        must_have = {"pe_low_20", "pb_low_1", "deep_value", "peg_value_growth", "large_cap_100b"}
        missing = must_have - ids
        assert not missing, f"missing valuation factors: {missing}"

    def test_growth_key_factors_exist(self, all_builtins):
        """成长类经典因子"""
        ids = {f["id"] for f in all_builtins}
        must_have = {"yoy_ni_high_20", "roe_high_15", "quality_compound_growth"}
        missing = must_have - ids
        assert not missing, f"missing growth factors: {missing}"

    def test_sentiment_key_factors_exist(self, all_builtins):
        """情绪类经典因子"""
        ids = {f["id"] for f in all_builtins}
        must_have = {"limit_up_day", "strong_up_day", "panic_sell", "vol_breakout_up"}
        missing = must_have - ids
        assert not missing, f"missing sentiment factors: {missing}"

    def test_fundamental_fields_recognized(self):
        """基本面字段必须在 DSL BUILTIN_FIELDS 里"""
        from factors.registry import BUILTIN_FIELDS, FUNDAMENTAL_FIELD_MAP  # noqa: PLC0415

        for dsl_field in FUNDAMENTAL_FIELD_MAP:
            assert dsl_field in BUILTIN_FIELDS, f"{dsl_field} not registered"

    def test_derived_fields_registered(self):
        """衍生字段 market_cap / pe_ttm / pb 必须在 BUILTIN_FIELDS"""
        from factors.registry import BUILTIN_FIELDS  # noqa: PLC0415

        for f in ["market_cap", "pe_ttm", "pb"]:
            assert f in BUILTIN_FIELDS, f"derived field {f} not registered"

    def test_collect_fields_works_on_fundamental_formula(self):
        """collect_fields 要能识别基本面字段"""
        from factors import parse_formula  # noqa: PLC0415

        r = parse_formula("pe_ttm < 20 AND yoy_ni > 0.2 AND roe > 0.1")
        assert r.fields == {"pe_ttm", "yoy_ni", "roe"}
