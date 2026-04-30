"""因子计算引擎单元测试（T-3.02）

验收标准（来自 docs/product/99_MVP_Sprint0.md §T-3.02）：
1. 结果与手动 pandas 计算完全一致（回归测试）
2. 单个因子在 3000 股票 × 1 年上计算 < 3s
"""

from __future__ import annotations

import importlib.util
import sys
import time
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
    return mod


_factors = _load_factors()
parse_formula = _factors.parse_formula
eval_ast = _factors.eval_ast
eval_instant = _factors.eval_instant
Engine = _factors.Engine
EngineError = _factors.EngineError


# ═══════════════════════════════════════════════════════════════
#   Fixture：60 天 × 3 股票的面板（固定随机种子，可复现）
# ═══════════════════════════════════════════════════════════════


@pytest.fixture
def panel():
    dates = pd.date_range("2025-01-01", periods=60, freq="D")
    rng = np.random.default_rng(42)
    close = pd.DataFrame(
        100 + np.cumsum(rng.standard_normal((60, 3)), axis=0),
        index=dates,
        columns=["AAA", "BBB", "CCC"],
    )
    return {
        "close": close,
        "open": close.shift(1).fillna(close.iloc[0]),
        "high": close * 1.01,
        "low": close * 0.99,
        "volume": pd.DataFrame(
            rng.integers(1_000_000, 10_000_000, (60, 3)),
            index=dates,
            columns=["AAA", "BBB", "CCC"],
        ),
        "preclose": close.shift(1),
    }


def _evaluate(src: str, panel: dict) -> pd.DataFrame:
    ast = parse_formula(src).ast
    return eval_ast(ast, panel)


# ═══════════════════════════════════════════════════════════════
#   回归测试：结果必须与手写 pandas 一致
# ═══════════════════════════════════════════════════════════════


class TestRegressionMA:
    def test_ma_matches_rolling_mean(self, panel):
        """MA(close, 10) == close.rolling(10).mean()"""
        result = _evaluate("MA(close, 10)", panel)
        expected = panel["close"].rolling(window=10, min_periods=10).mean()
        pd.testing.assert_frame_equal(result, expected)

    def test_ma_multiple_windows(self, panel):
        for period in (5, 10, 20, 30):
            result = _evaluate(f"MA(close, {period})", panel)
            expected = panel["close"].rolling(window=period, min_periods=period).mean()
            pd.testing.assert_frame_equal(result, expected, check_names=False)

    def test_ma_on_volume(self, panel):
        result = _evaluate("MA(volume, 20)", panel)
        expected = panel["volume"].rolling(window=20, min_periods=20).mean()
        pd.testing.assert_frame_equal(result, expected)


class TestRegressionStdMaxMin:
    def test_std(self, panel):
        result = _evaluate("STD(close, 20)", panel)
        expected = panel["close"].rolling(20, min_periods=20).std()
        pd.testing.assert_frame_equal(result, expected)

    def test_max(self, panel):
        result = _evaluate("MAX(high, 20)", panel)
        expected = panel["high"].rolling(20, min_periods=20).max()
        pd.testing.assert_frame_equal(result, expected)

    def test_min(self, panel):
        result = _evaluate("MIN(low, 20)", panel)
        expected = panel["low"].rolling(20, min_periods=20).min()
        pd.testing.assert_frame_equal(result, expected)


class TestRegressionChange:
    def test_diff(self, panel):
        result = _evaluate("DIFF(close, 1)", panel)
        expected = panel["close"].diff(1)
        pd.testing.assert_frame_equal(result, expected)

    def test_pct_change(self, panel):
        result = _evaluate("PCT(close, 5)", panel)
        expected = panel["close"].pct_change(periods=5, fill_method=None)
        pd.testing.assert_frame_equal(result, expected)


class TestRegressionCrossUp:
    def test_cross_up_binop_form(self, panel):
        """a cross_up b（中缀形式）"""
        result = _evaluate("MA(close, 5) cross_up MA(close, 20)", panel)
        ma5 = panel["close"].rolling(5, min_periods=5).mean()
        ma20 = panel["close"].rolling(20, min_periods=20).mean()
        expected = (ma5.shift(1) <= ma20.shift(1)) & (ma5 > ma20)
        pd.testing.assert_frame_equal(result, expected, check_names=False)

    def test_cross_up_function_form(self, panel):
        """cross_up(a, b)（函数形式）"""
        result = _evaluate("cross_up(MA(close,5), MA(close,20))", panel)
        ma5 = panel["close"].rolling(5, min_periods=5).mean()
        ma20 = panel["close"].rolling(20, min_periods=20).mean()
        expected = (ma5.shift(1) <= ma20.shift(1)) & (ma5 > ma20)
        pd.testing.assert_frame_equal(result, expected, check_names=False)

    def test_cross_down(self, panel):
        result = _evaluate("cross_down(MA(close,5), MA(close,20))", panel)
        ma5 = panel["close"].rolling(5, min_periods=5).mean()
        ma20 = panel["close"].rolling(20, min_periods=20).mean()
        expected = (ma5.shift(1) >= ma20.shift(1)) & (ma5 < ma20)
        pd.testing.assert_frame_equal(result, expected, check_names=False)


class TestRegressionRank:
    def test_rank_pct_cross_section(self, panel):
        """RANK 是截面百分位，axis=1"""
        result = _evaluate("RANK(close)", panel)
        expected = panel["close"].rank(axis=1, pct=True)
        pd.testing.assert_frame_equal(result, expected)

    def test_rank_all_in_unit_interval(self, panel):
        """每个截面值都在 (0, 1] 范围"""
        result = _evaluate("RANK(close)", panel)
        valid = result.dropna()
        assert ((valid > 0) & (valid <= 1)).all().all()


class TestRegressionArithmetic:
    def test_add(self, panel):
        result = _evaluate("close + open", panel)
        expected = panel["close"] + panel["open"]
        pd.testing.assert_frame_equal(result, expected)

    def test_sub(self, panel):
        result = _evaluate("close - open", panel)
        expected = panel["close"] - panel["open"]
        pd.testing.assert_frame_equal(result, expected)

    def test_mul_scalar(self, panel):
        result = _evaluate("close * 2", panel)
        expected = panel["close"] * 2
        pd.testing.assert_frame_equal(result, expected)

    def test_div(self, panel):
        result = _evaluate("close / open", panel)
        expected = panel["close"] / panel["open"]
        pd.testing.assert_frame_equal(result, expected)

    def test_nested(self, panel):
        """(close - MIN(low,20)) / (MAX(high,20) - MIN(low,20)) 经典标准化"""
        result = _evaluate("(close - MIN(low, 20)) / (MAX(high, 20) - MIN(low, 20))", panel)
        low_min = panel["low"].rolling(20, min_periods=20).min()
        high_max = panel["high"].rolling(20, min_periods=20).max()
        expected = (panel["close"] - low_min) / (high_max - low_min)
        pd.testing.assert_frame_equal(result, expected)


class TestRegressionComparison:
    def test_gt(self, panel):
        result = _evaluate("close > open", panel)
        expected = panel["close"] > panel["open"]
        pd.testing.assert_frame_equal(result, expected)

    def test_gt_scalar(self, panel):
        result = _evaluate("close > 100", panel)
        expected = panel["close"] > 100
        pd.testing.assert_frame_equal(result, expected)

    def test_lt(self, panel):
        result = _evaluate("close < open", panel)
        expected = panel["close"] < panel["open"]
        pd.testing.assert_frame_equal(result, expected)

    def test_compound_condition(self, panel):
        """volume > MA(volume, 20) * 1.5 AND close > open"""
        result = _evaluate("volume > MA(volume, 20) * 1.5 AND close > open", panel)
        ma20 = panel["volume"].rolling(20, min_periods=20).mean()
        expected = (panel["volume"] > ma20 * 1.5) & (panel["close"] > panel["open"])
        pd.testing.assert_frame_equal(result, expected, check_names=False)


class TestRegressionLogical:
    def test_not(self, panel):
        result = _evaluate("NOT (close > open)", panel)
        expected = ~(panel["close"] > panel["open"])
        pd.testing.assert_frame_equal(result, expected, check_names=False)

    def test_and(self, panel):
        result = _evaluate("close > 50 AND close < 200", panel)
        expected = (panel["close"] > 50) & (panel["close"] < 200)
        pd.testing.assert_frame_equal(result, expected, check_names=False)

    def test_or(self, panel):
        result = _evaluate("close > 200 OR close < 50", panel)
        expected = (panel["close"] > 200) | (panel["close"] < 50)
        pd.testing.assert_frame_equal(result, expected, check_names=False)


class TestRegressionUnary:
    def test_neg(self, panel):
        result = _evaluate("-close", panel)
        expected = -panel["close"]
        pd.testing.assert_frame_equal(result, expected)


# ═══════════════════════════════════════════════════════════════
#   技术指标（不对细节断言，只断言 shape & 数值合理性）
# ═══════════════════════════════════════════════════════════════


class TestTechnicalIndicators:
    def test_rsi_shape_and_range(self, panel):
        """RSI 必须在 [0, 100] 范围"""
        result = _evaluate("RSI(14)", panel)
        assert result.shape == panel["close"].shape
        valid = result.dropna()
        assert (valid >= 0).all().all()
        assert (valid <= 100).all().all()

    def test_macd_returns_dataframe(self, panel):
        """MACD 柱可正可负，只断言类型和 shape"""
        result = _evaluate("MACD()", panel)
        assert isinstance(result, pd.DataFrame)
        assert result.shape == panel["close"].shape

    def test_boll_width_non_negative(self, panel):
        """BOLL 上下轨差值必须 ≥ 0"""
        result = _evaluate("BOLL(close, 20)", panel)
        valid = result.dropna()
        assert (valid >= 0).all().all()


# ═══════════════════════════════════════════════════════════════
#   NaN 传播
# ═══════════════════════════════════════════════════════════════


class TestNanPropagation:
    def test_leading_nan_from_rolling(self, panel):
        """MA(close, 20) 前 19 行应该是 NaN"""
        result = _evaluate("MA(close, 20)", panel)
        assert result.iloc[:19].isna().all().all()
        assert not result.iloc[19:].isna().any().any()

    def test_max_window_drives_leading_nan(self, panel):
        """MA(close, 5) + MA(close, 30) 前 29 行 NaN（受更长窗口支配）"""
        result = _evaluate("MA(close, 5) + MA(close, 30)", panel)
        assert result.iloc[:29].isna().all().all()


# ═══════════════════════════════════════════════════════════════
#   instant 模式
# ═══════════════════════════════════════════════════════════════


class TestInstantMode:
    def test_instant_returns_series(self, panel):
        ast = parse_formula("MA(close, 10)").ast
        result = eval_instant(ast, panel)
        assert isinstance(result, pd.Series)
        assert list(result.index) == ["AAA", "BBB", "CCC"]

    def test_instant_matches_last_row(self, panel):
        ast = parse_formula("MA(close, 10)").ast
        batch = eval_ast(ast, panel)
        latest = eval_instant(ast, panel)
        pd.testing.assert_series_equal(latest, batch.iloc[-1], check_names=False)


# ═══════════════════════════════════════════════════════════════
#   错误处理
# ═══════════════════════════════════════════════════════════════


class TestErrors:
    def test_missing_field_raises(self, panel):
        panel_no_close = {k: v for k, v in panel.items() if k != "close"}
        ast = parse_formula("MA(close, 10)").ast
        with pytest.raises(EngineError) as exc_info:
            eval_ast(ast, panel_no_close)
        assert "close" in str(exc_info.value)

    def test_rsi_requires_close(self, panel):
        panel_no_close = {k: v for k, v in panel.items() if k != "close"}
        ast = parse_formula("RSI(14)").ast
        with pytest.raises(EngineError):
            eval_ast(ast, panel_no_close)


# ═══════════════════════════════════════════════════════════════
#   性能验收（3000 股 × 252 天 < 3s）
# ═══════════════════════════════════════════════════════════════


class TestPerformance:
    @pytest.fixture(scope="class")
    def large_panel(self):
        """3000 股 × 252 天（1 年）"""
        n_symbols = 3000
        n_days = 252
        dates = pd.date_range("2024-01-01", periods=n_days, freq="B")
        rng = np.random.default_rng(42)
        symbols = [f"S{i:04d}" for i in range(n_symbols)]
        close = pd.DataFrame(
            100 + np.cumsum(rng.standard_normal((n_days, n_symbols)), axis=0),
            index=dates,
            columns=symbols,
        )
        return {
            "close": close,
            "open": close.shift(1).fillna(close.iloc[0]),
            "high": close * 1.01,
            "low": close * 0.99,
            "volume": pd.DataFrame(
                rng.integers(1_000_000, 10_000_000, (n_days, n_symbols)),
                index=dates,
                columns=symbols,
            ),
        }

    @pytest.mark.parametrize(
        "formula",
        [
            "MA(close, 20)",
            "MA(close, 5) cross_up MA(close, 20)",
            "volume > MA(volume, 20) * 1.5 AND close > MAX(high, 20)",
            "RSI(14) < 30",
        ],
    )
    def test_large_scale_under_3s(self, large_panel, formula: str):
        """单个因子 3000 股 × 252 天应 < 3s"""
        ast = parse_formula(formula).ast
        t0 = time.perf_counter()
        result = eval_ast(ast, large_panel)
        elapsed = time.perf_counter() - t0
        assert elapsed < 3.0, f"{formula} took {elapsed:.2f}s (> 3s)"
        # 结果形状对
        assert result.shape == (252, 3000)
