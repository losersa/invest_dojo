"""backtest-svc 单元测试"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

SVC_DIR = Path(__file__).parent.parent / "backtest-svc"


def _load_module(path: Path, name: str):
    if name in sys.modules:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_cu = _load_module(SVC_DIR / "common_utils.py", "backtest_svc_common_utils")
_me = _load_module(SVC_DIR / "mock_engine.py", "backtest_svc_mock_engine")

BacktestConfig = _cu.BacktestConfig
StrategySpec = _cu.StrategySpec
QuickFactorRequest = _cu.QuickFactorRequest
BacktestSummary = _cu.BacktestSummary

run_mock_backtest = _me.run_mock_backtest
new_backtest_id = _me.new_backtest_id
_business_days = _me._business_days
_seed_from_config = _me._seed_from_config


# ──────────────────────────────────────────
# BacktestConfig / StrategySpec
# ──────────────────────────────────────────
def test_config_minimal_ok():
    cfg = BacktestConfig(
        mode="fast",
        strategy=StrategySpec(type="model", model_id="m_a"),
        start="2023-01-01",
        end="2023-06-30",
    )
    assert cfg.mode == "fast"
    assert cfg.universe == "hs300"
    assert cfg.initial_capital == 100000
    assert cfg.benchmark == "000300"


def test_config_bad_date():
    with pytest.raises(ValidationError):
        BacktestConfig(
            mode="fast",
            strategy=StrategySpec(type="model", model_id="m"),
            start="bad-date",
            end="2023-06-30",
        )


def test_config_negative_capital():
    with pytest.raises(ValidationError):
        BacktestConfig(
            mode="fast",
            strategy=StrategySpec(type="model", model_id="m"),
            start="2023-01-01",
            end="2023-06-30",
            initial_capital=-1,
        )


def test_strategy_required_field():
    s = StrategySpec(type="model", model_id="abc")
    assert s.required_field() == "model_id"
    assert StrategySpec(type="factor", factor_id="f").required_field() == "factor_id"
    assert StrategySpec(type="composite", composite_id="c").required_field() == "composite_id"
    assert StrategySpec(type="signal_file", signal_file_id="s").required_field() == "signal_file_id"


def test_quick_factor_request():
    req = QuickFactorRequest(
        factor_id="ma_cross_5_20",
        start="2023-01-01",
        end="2023-02-01",
    )
    assert req.universe == "hs300"
    assert req.benchmark == "000300"


# ──────────────────────────────────────────
# mock 引擎
# ──────────────────────────────────────────
def _sample_config(**overrides):
    cfg = {
        "mode": "fast",
        "strategy": {"type": "model", "model_id": "m_a"},
        "start": "2023-01-01",
        "end": "2023-03-31",
        "universe": "hs300",
        "initial_capital": 100000,
        "benchmark": "000300",
    }
    cfg.update(overrides)
    return cfg


def test_business_days_skip_weekends():
    days = _business_days("2023-01-02", "2023-01-08")  # 周一~周日
    # 周一(2)、周二(3)、周三(4)、周四(5)、周五(6) = 5 天
    assert len(days) == 5
    assert days[0] == "2023-01-02"
    assert days[-1] == "2023-01-06"


def test_mock_backtest_shape():
    r = run_mock_backtest(_sample_config())
    assert "summary" in r
    assert "equity_curve" in r
    assert "segment_performance" in r
    assert "duration_ms" in r

    s = r["summary"]
    # 必须有的字段
    for k in ("total_return", "annual_return", "sharpe", "max_drawdown",
              "volatility", "total_trades", "ic", "ir"):
        assert k in s

    # Summary schema 校验
    BacktestSummary(**s)


def test_mock_backtest_deterministic():
    """同 config → 完全一致输出（除 duration_ms / 含 trades 的 id）"""
    cfg = _sample_config()
    r1 = run_mock_backtest(cfg)
    r2 = run_mock_backtest(cfg)
    # 摘除非决定性字段
    for r in (r1, r2):
        r.pop("duration_ms")
    assert r1["summary"] == r2["summary"]
    assert r1["equity_curve"] == r2["equity_curve"]
    assert r1["_seed"] == r2["_seed"]


def test_mock_backtest_different_seeds_for_different_config():
    a = _sample_config()
    b = _sample_config(strategy={"type": "factor", "factor_id": "rsi_14"})
    ra = run_mock_backtest(a)
    rb = run_mock_backtest(b)
    assert ra["_seed"] != rb["_seed"]


def test_mock_backtest_equity_curve_length():
    r = run_mock_backtest(_sample_config(start="2023-01-02", end="2023-01-13"))
    dates = r["equity_curve"]["dates"]
    # 2023-01-02 ~ 2023-01-13 跳周末 = 10 天
    assert len(dates) == 10
    assert dates[0] == "2023-01-02"


def test_mock_backtest_feature_importance_only_when_flagged():
    r_off = run_mock_backtest(_sample_config())
    assert r_off["feature_importance"] is None

    r_on = run_mock_backtest(_sample_config(advanced={"include_feature_importance": True}))
    assert r_on["feature_importance"] is not None
    assert len(r_on["feature_importance"]) >= 3
    # 按 importance 降序
    imps = [f["importance"] for f in r_on["feature_importance"]]
    assert imps == sorted(imps, reverse=True)


def test_mock_backtest_trades_only_when_flagged():
    r = run_mock_backtest(_sample_config(advanced={"include_trade_log": True}))
    assert r["trades"] is not None
    assert len(r["trades"]) > 0
    t = r["trades"][0]
    for k in ("id", "symbol", "side", "datetime", "price", "quantity", "amount", "commission"):
        assert k in t


def test_mock_backtest_drawdown_non_positive():
    r = run_mock_backtest(_sample_config())
    dds = r["equity_curve"]["drawdown"]
    # 回撤必须是 <= 0
    assert all(d <= 0 for d in dds)


def test_mock_backtest_portfolio_starts_at_initial_capital():
    r = run_mock_backtest(_sample_config(initial_capital=50000))
    assert r["equity_curve"]["portfolio"][0] == 50000


def test_new_backtest_id_format():
    i = new_backtest_id()
    assert i.startswith("bt_")
    assert len(i) == len("bt_") + 12


# ──────────────────────────────────────────
# seed 稳定性（同样 input 永远产生同样 seed）
# ──────────────────────────────────────────
def test_seed_stable_across_calls():
    cfg = _sample_config()
    assert _seed_from_config(cfg) == _seed_from_config(cfg)


def test_seed_differs_with_key_order_noop():
    """key 顺序不同但内容相同 → seed 相同（因为我们用 sort_keys）"""
    cfg1 = {"b": 2, "a": 1}
    cfg2 = {"a": 1, "b": 2}
    assert _seed_from_config(cfg1) == _seed_from_config(cfg2)
