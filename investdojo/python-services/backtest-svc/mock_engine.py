"""Mock 回测引擎

核心要求：
- 决定性（同 config → 同结果，seed 由 config hash 驱动）
- 产出合理的 equity_curve（符合正态分布的日收益，累乘）
- 按策略类型生成不同的典型表现（model 看好、factor 普通、random 基线）

Epic 4（T-4.xx）会替换为 VectorBT / Backtrader 真引擎。
"""

from __future__ import annotations

import hashlib
import math
import random
import time
import uuid
from datetime import datetime, timedelta
from typing import Any


def _seed_from_config(config: dict) -> int:
    """配置 hash → 稳定 seed"""
    import json

    blob = json.dumps(config, sort_keys=True, ensure_ascii=False)
    h = hashlib.sha256(blob.encode()).digest()
    return int.from_bytes(h[:8], byteorder="big", signed=False)


def _business_days(start: str, end: str) -> list[str]:
    """粗略按"跳过周末"生成 YYYY-MM-DD 列表（假期不处理，mock 用够了）"""
    s = datetime.strptime(start, "%Y-%m-%d").date()
    e = datetime.strptime(end, "%Y-%m-%d").date()
    out: list[str] = []
    d = s
    while d <= e:
        if d.weekday() < 5:  # 0~4 是 Mon~Fri
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def _annualize_return(total_return: float, days: int) -> float:
    """简易年化：(1+r)^(252/days)-1"""
    if days <= 0:
        return 0.0
    trading_days = max(1, days)
    return (1 + total_return) ** (252 / trading_days) - 1


def _calculate_drawdowns(portfolio: list[float]) -> list[float]:
    """回撤曲线（负值）"""
    peak = portfolio[0]
    dd: list[float] = []
    for v in portfolio:
        if v > peak:
            peak = v
        dd.append((v / peak) - 1 if peak > 0 else 0.0)
    return dd


def _max_dd_period(portfolio: list[float], dates: list[str]) -> tuple[str, str, float]:
    """返回 (peak_date, trough_date, mdd)"""
    peak = portfolio[0]
    peak_i = 0
    mdd = 0.0
    mdd_peak_i = 0
    mdd_trough_i = 0
    for i, v in enumerate(portfolio):
        if v > peak:
            peak = v
            peak_i = i
        dd = v / peak - 1 if peak > 0 else 0
        if dd < mdd:
            mdd = dd
            mdd_peak_i = peak_i
            mdd_trough_i = i
    return dates[mdd_peak_i], dates[mdd_trough_i], mdd


def run_mock_backtest(config: dict) -> dict[str, Any]:
    """按 BacktestConfig dict 生成 mock BacktestResult dict。

    MVP 保证：
    - 同 config → 完全一致输出（除 created_at / completed_at / duration_ms / id）
    - 结果符合 BacktestResult schema
    - 指标合理（not all zeros）
    """
    t_start = time.perf_counter()

    seed = _seed_from_config(config)
    rng = random.Random(seed)

    start = config["start"]
    end = config["end"]
    initial_capital = float(config.get("initial_capital", 100000))
    strategy_type = config["strategy"]["type"]

    dates = _business_days(start, end)
    if not dates:
        # 范围无效，fallback
        dates = [start]

    n = len(dates)

    # ── 策略类型决定 mu/sigma（年化） ──
    # model → 年化 15% / 年化波动 20%
    # factor/composite → 年化 8% / 18%
    # signal_file → 年化 5% / 15%
    profiles = {
        "model": (0.15, 0.20),
        "factor": (0.08, 0.18),
        "composite": (0.10, 0.20),
        "signal_file": (0.05, 0.15),
    }
    mu_annual, sigma_annual = profiles.get(strategy_type, (0.05, 0.15))
    mu_daily = mu_annual / 252
    sigma_daily = sigma_annual / math.sqrt(252)

    # benchmark 固定 mu=8% sigma=18%
    bmu, bsigma = 0.08 / 252, 0.18 / math.sqrt(252)

    # ── 生成日收益（geometric brownian）──
    portfolio = [initial_capital]
    benchmark = [initial_capital]
    cash = [initial_capital]
    pos_count = [0]
    daily_rets: list[float] = []
    for i in range(1, n):
        r = rng.gauss(mu_daily, sigma_daily)
        br = rng.gauss(bmu, bsigma)
        daily_rets.append(r)
        portfolio.append(round(portfolio[-1] * (1 + r), 2))
        benchmark.append(round(benchmark[-1] * (1 + br), 2))
        # 简化：前 10 天建仓，之后 80% 仓位
        invested = min(0.8, i / 10 * 0.8)
        cash.append(round(portfolio[-1] * (1 - invested), 2))
        max_pos = (config.get("position_sizing") or {}).get("max_positions", 10)
        pos_count.append(min(max_pos, i))

    drawdowns = _calculate_drawdowns(portfolio)
    peak_date, trough_date, mdd = _max_dd_period(portfolio, dates)

    total_return = portfolio[-1] / portfolio[0] - 1
    benchmark_return = benchmark[-1] / benchmark[0] - 1
    excess_return = total_return - benchmark_return

    if daily_rets:
        mean_r = sum(daily_rets) / len(daily_rets)
        var = sum((r - mean_r) ** 2 for r in daily_rets) / max(1, len(daily_rets) - 1)
        sigma = math.sqrt(var)
        sharpe = (mean_r * 252) / (sigma * math.sqrt(252)) if sigma > 0 else 0.0
        # sortino 用下行波动
        downside = [r for r in daily_rets if r < 0]
        ds = math.sqrt(sum(r**2 for r in downside) / len(downside)) if downside else 0.001
        sortino = (mean_r * 252) / (ds * math.sqrt(252)) if ds > 0 else 0.0
    else:
        sigma = 0.0
        sharpe = 0.0
        sortino = 0.0

    annual_return = _annualize_return(total_return, n)
    calmar = annual_return / abs(mdd) if mdd < 0 else 0.0
    volatility = sigma * math.sqrt(252)

    total_trades = rng.randint(40, 200)
    win_rate = round(rng.uniform(0.45, 0.60), 3)
    profit_loss_ratio = round(rng.uniform(1.0, 2.0), 2)
    turnover_rate = round(rng.uniform(2.0, 6.0), 2)

    summary = {
        "total_return": round(total_return, 4),
        "annual_return": round(annual_return, 4),
        "benchmark_return": round(benchmark_return, 4),
        "excess_return": round(excess_return, 4),
        "sharpe": round(sharpe, 3),
        "sortino": round(sortino, 3),
        "calmar": round(calmar, 3),
        "max_drawdown": round(mdd, 4),
        "max_drawdown_period": [peak_date, trough_date],
        "volatility": round(volatility, 4),
        "win_rate": win_rate,
        "profit_loss_ratio": profit_loss_ratio,
        "turnover_rate": turnover_rate,
        "total_trades": total_trades,
        "ic": round(rng.uniform(0.01, 0.08), 3),
        "ir": round(rng.uniform(0.2, 1.2), 3),
    }

    equity_curve = {
        "dates": dates,
        "portfolio": portfolio,
        "benchmark": benchmark,
        "drawdown": [round(x, 4) for x in drawdowns],
        "cash": cash,
        "positions_count": pos_count,
    }

    # segment_performance：按时间 3 等分
    third = max(1, n // 3)
    segments: dict[str, dict[str, Any]] = {}
    for name, i0, i1 in [
        ("bull", 0, third),
        ("bear", third, 2 * third),
        ("sideways", 2 * third, n),
    ]:
        if i1 > i0 and i1 <= n:
            seg_portfolio = portfolio[i0:i1]
            seg_ret = seg_portfolio[-1] / seg_portfolio[0] - 1
            seg_dd = _calculate_drawdowns(seg_portfolio)
            segments[name] = {
                "start": dates[i0],
                "end": dates[i1 - 1],
                "return": round(seg_ret, 4),
                "volatility": round(volatility * 0.8 + rng.uniform(-0.02, 0.02), 4),
                "sharpe": round(sharpe + rng.uniform(-0.5, 0.5), 3),
                "max_drawdown": round(min(seg_dd), 4),
            }

    # feature_importance（若 advanced.include_feature_importance）
    advanced = config.get("advanced") or {}
    feature_importance: list[dict] | None = None
    if advanced.get("include_feature_importance"):
        feats = ["ma_cross_5_20", "rsi_14", "macd_hist", "volume_ratio", "pb"]
        feature_importance = [
            {
                "feature": f,
                "importance": round(rng.uniform(0.05, 0.35), 3),
                "shap_abs_mean": round(rng.uniform(0.02, 0.25), 3),
            }
            for f in feats
        ]
        feature_importance.sort(key=lambda x: -x["importance"])

    trades: list[dict] | None = None
    if advanced.get("include_trade_log"):
        # 仅生成 5 条样例
        sample_symbols = ["600519", "000001", "000858", "300750", "600036"]
        trades = []
        for i in range(5):
            sym = rng.choice(sample_symbols)
            side = "BUY" if rng.random() > 0.5 else "SELL"
            price = round(rng.uniform(10, 1700), 2)
            qty = rng.choice([100, 200, 500])
            amount = round(price * qty, 2)
            trades.append(
                {
                    "id": f"t_{uuid.uuid4().hex[:8]}",
                    "symbol": sym,
                    "side": side,
                    "datetime": dates[min(i * (n // 5), n - 1)] + "T10:00:00Z",
                    "price": price,
                    "quantity": qty,
                    "amount": amount,
                    "commission": round(max(5.0, amount * 0.0003), 2),
                    "reason": "mock signal",
                    "pnl": round(rng.uniform(-amount * 0.1, amount * 0.15), 2)
                    if side == "SELL"
                    else None,
                }
            )

    duration_ms = max(1, int((time.perf_counter() - t_start) * 1000))

    return {
        "summary": summary,
        "equity_curve": equity_curve,
        "segment_performance": segments,
        "feature_importance": feature_importance,
        "trades": trades,
        "duration_ms": duration_ms,
        "_seed": seed & 0xFFFFFFFF,
    }


def new_backtest_id() -> str:
    return f"bt_{uuid.uuid4().hex[:12]}"
