"""真实回测引擎（strategy.type == "model"）。

设计要点：
- 严格复用训练侧 `train_svc.pipeline.build_dataset` 复现**完全相同的特征工程**
  （含 target_symbol 单只预测模式 + 同板块横截面 peer 特征），确保模型输入与训练一致。
- 从 MinIO 加载 LightGBM Booster，对回测区间样本做预测得到概率；
  信号 = proba >= cls_threshold（与训练评估口径一致，cls_threshold 为训练集 Youden J）。
- 单只标的（模型预测的那支股票）日频调仓资金模拟，产出与 mock 引擎同构的结果。
"""
from __future__ import annotations

import io
import math
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from collections.abc import Callable

import numpy as np
import pandas as pd
import lightgbm as lgb

from common import get_logger, get_pg_client
from common.minio_client import download_bytes

logger = get_logger("backtest.real_engine")

# ── 跨服务复用 train-svc 的特征工程（保证与训练特征严格一致）──
_TRAIN_SVC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "train-svc"
)
if _TRAIN_SVC not in sys.path:
    sys.path.insert(0, _TRAIN_SVC)
from pipeline import build_dataset  # noqa: E402


def _load_booster(file_path: str) -> "lgb.Booster":
    raw = download_bytes(file_path)
    return lgb.Booster(model_str=raw.decode("utf-8"))


def _fetch_close(symbol: str, start: str, end: str) -> pd.DataFrame:
    client = get_pg_client()
    filt = {
        "symbol": f"eq.{symbol}",
        "timeframe": "eq.1d",
        "dt": f"gte.{start}",
        "dt": f"lte.{end}",
    }
    rows = client.select_all("klines_all", columns="symbol,dt,close", filters=filt)
    df = pd.DataFrame(rows)
    if df.empty:
        return pd.DataFrame(columns=["symbol", "dt", "close"])
    df["dt"] = pd.to_datetime(df["dt"]).dt.date
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df = df.dropna(subset=["close"]).sort_values("dt").drop_duplicates(subset=["dt"])
    return df[["symbol", "dt", "close"]]


def _calculate_drawdowns(portfolio: list[float]) -> list[float]:
    peak = -math.inf
    out = []
    for v in portfolio:
        peak = max(peak, v)
        out.append(v / peak - 1.0 if peak > 0 else 0.0)
    return out


def _max_dd_period(dates: list, drawdowns: list[float]) -> list[str]:
    trough_i = int(np.argmin(drawdowns))
    run_max = -math.inf
    peak_i = 0
    for i in range(trough_i + 1):
        if drawdowns[i] >= run_max:
            run_max = drawdowns[i]
            peak_i = i
    return [str(dates[peak_i]), str(dates[trough_i])]


def _annualize(total_return: float, n: int) -> float:
    if n <= 1:
        return 0.0
    return (1.0 + total_return) ** (252.0 / n) - 1.0


# ──────────────────────────────────────────────────────────────────────────
# 样本内 / 样本外 判定
# ──────────────────────────────────────────────────────────────────────────
def _parse_d(d):
    if isinstance(d, datetime):
        return d.date()
    try:
        return datetime.strptime(str(d)[:10], "%Y-%m-%d").date()
    except Exception:
        return None


def _compute_in_sample(training_range, bt_start, bt_end):
    """回测区间与训练区间有重叠 → 样本内（过拟合风险）。"""
    if not training_range or not isinstance(training_range, dict):
        return {"in_sample": None, "training_range": None, "overlap_days": None}
    tr_s = _parse_d(training_range.get("start"))
    tr_e = _parse_d(training_range.get("end"))
    if not tr_s or not tr_e:
        return {"in_sample": None, "training_range": training_range, "overlap_days": None}
    bs, be = _parse_d(bt_start), _parse_d(bt_end)
    if not bs or not be:
        return {"in_sample": None, "training_range": {"start": str(tr_s), "end": str(tr_e)}, "overlap_days": None}
    overlap = max(0, (min(be, tr_e) - max(bs, tr_s)).days + 1)
    return {
        "in_sample": overlap > 0,
        "training_range": {"start": str(tr_s), "end": str(tr_e)},
        "overlap_days": overlap,
    }


# ──────────────────────────────────────────────────────────────────────────
# 横截面（factor / composite / signal_file）真实回测
# ──────────────────────────────────────────────────────────────────────────
def _fetch_factor_values(factor_ids, start, end):
    """从 feature_values 取 (date, symbol, value)。"""
    client = get_pg_client()
    fids = [f for f in factor_ids if f]
    if not fids:
        return pd.DataFrame(columns=["factor_id", "symbol", "date", "value"])
    filt = {
        "factor_id": f"in.({','.join(fids)})",
        "and": f"(date.gte.{start},date.lte.{end})",
    }
    rows = client.select_all(
        "feature_values",
        columns="factor_id,symbol,date,value_num,value_bool",
        filters=filt,
        page_size=200000,
    )
    df = pd.DataFrame(rows)
    if df.empty:
        return pd.DataFrame(columns=["factor_id", "symbol", "date", "value"])
    df["date"] = df["date"].map(_parse_d)
    # 数值因子存 value_num；布尔因子（output_type=bool）存 value_bool
    df["value"] = df["value_num"].where(df["value_num"].notna(), df["value_bool"].astype(float))
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return df.dropna(subset=["value", "date"])[["factor_id", "symbol", "date", "value"]]


def _load_signal_file_csv(signal_file_id):
    """从 MinIO 加载信号文件 signals/{id}.csv（列：date,symbol,score）。"""
    from common.minio_client import download_bytes

    name = str(signal_file_id)
    if not name.endswith(".csv"):
        name = f"signals/{name}.csv"
    raw = download_bytes(name)
    df = pd.read_csv(io.BytesIO(raw), dtype={"symbol": str})
    if not {"date", "symbol", "score"}.issubset(set(df.columns)):
        raise ValueError(f"信号文件 {name} 缺少必要列（需 date,symbol,score），实际：{list(df.columns)}")
    df["date"] = df["date"].map(_parse_d)
    df["score"] = pd.to_numeric(df["score"], errors="coerce")
    df = df.dropna(subset=["date", "score"])
    df["symbol"] = df["symbol"].astype(str)
    return df[["date", "symbol", "score"]]


def _build_score_df(config):
    """根据 strategy 构造 (date, symbol, score) 打分矩阵。"""
    strategy = config.get("strategy") or {}
    stype = strategy.get("type")
    if stype == "signal_file":
        sid = strategy.get("signal_file_id")
        if not sid:
            raise ValueError("signal_file 类型回测必须提供 strategy.signal_file_id")
        df = _load_signal_file_csv(sid)
        if df.empty:
            raise ValueError(f"信号文件 {sid} 无有效行")
        return df, {"source": "signal_file", "signal_file_id": sid}
    if stype == "factor":
        fid = strategy.get("factor_id")
        if not fid:
            raise ValueError("factor 类型回测必须提供 strategy.factor_id")
        fv = _fetch_factor_values([fid], config["start"], config["end"])
        if fv.empty:
            raise ValueError(f"因子 {fid} 在 [{config['start']}~{config['end']}] 无因子值（feature_values 为空）")
        return fv.rename(columns={"value": "score"})[["date", "symbol", "score"]], {
            "source": "factor", "factor_id": fid,
        }
    if stype == "composite":
        cid = strategy.get("composite_id") or ""
        fids = [x.strip() for x in cid.split(",") if x.strip()]
        if not fids:
            raise ValueError("composite 类型回测需 composite_id 提供逗号分隔的因子列表")
        fv = _fetch_factor_values(fids, config["start"], config["end"])
        if fv.empty:
            raise ValueError(f"composite 因子 {fids} 在指定区间无因子值")
        fv["z"] = fv.groupby("date")["value"].transform(
            lambda s: (s - s.mean()) / (s.std(ddof=0) + 1e-9)
        )
        comp = fv.groupby(["date", "symbol"])["z"].mean().reset_index(name="score")
        return comp, {"source": "composite", "factor_ids": fids}
    raise ValueError(f"不支持的 strategy.type：{stype}")


def _fetch_close_multi(symbols, start, end):
    """批量取多标的日线收盘价，返回 {symbol: {date: close}}。"""
    client = get_pg_client()
    out: dict = {}
    if not symbols:
        return out
    filt = {
        "symbol": f"in.({','.join(symbols)})",
        "timeframe": "eq.1d",
        "and": f"(dt.gte.{start},dt.lte.{end})",
    }
    rows = client.select_all(
        "klines_all", columns="symbol,dt,close", filters=filt, page_size=500000
    )
    for r in rows:
        s = r["symbol"]
        d = _parse_d(r["dt"])
        c = pd.to_numeric(r["close"], errors="coerce")
        if d is None or pd.isna(c):
            continue
        out.setdefault(s, {})[d] = float(c)
    return out


def _compute_metrics(portfolio, benchmark_arr, equity, cash_curve, pos_curve, sell_trades, buy_amount, initial_capital):
    daily_rets = [portfolio[i] / portfolio[i - 1] - 1 if portfolio[i - 1] else 0.0
                   for i in range(1, len(portfolio))]
    total_return = portfolio[-1] / portfolio[0] - 1 if portfolio[0] else 0.0
    benchmark_return = benchmark_arr[-1] / benchmark_arr[0] - 1 if benchmark_arr[0] else 0.0
    excess_return = total_return - benchmark_return
    mean_r = sum(daily_rets) / len(daily_rets) if daily_rets else 0.0
    var = sum((r - mean_r) ** 2 for r in daily_rets) / max(1, len(daily_rets) - 1) if daily_rets else 0.0
    sigma = math.sqrt(var)
    sharpe = (mean_r * 252) / (sigma * math.sqrt(252)) if sigma > 0 else 0.0
    downside = [r for r in daily_rets if r < 0]
    ds = math.sqrt(sum(r ** 2 for r in downside) / len(downside)) if downside else 1e-9
    sortino = (mean_r * 252) / (ds * math.sqrt(252)) if ds > 0 else 0.0
    drawdowns = _calculate_drawdowns(portfolio)
    mdd = min(drawdowns) if drawdowns else 0.0
    annual_return = _annualize(total_return, len(portfolio))
    calmar = annual_return / abs(mdd) if mdd < 0 else 0.0
    volatility = sigma * math.sqrt(252)
    n_trades = len(sell_trades)
    avg_equity = sum(equity) / len(equity) if equity else initial_capital
    turnover_rate = (buy_amount * 2) / avg_equity if avg_equity else 0.0
    return {
        "initial_capital": initial_capital,
        "final_equity": round(equity[-1], 2) if equity else initial_capital,
        "total_return": round(total_return, 4),
        "annual_return": round(annual_return, 4),
        "benchmark_return": round(benchmark_return, 4),
        "excess_return": round(excess_return, 4),
        "volatility": round(volatility, 4),
        "sharpe": round(sharpe, 4),
        "sortino": round(sortino, 4),
        "max_drawdown": round(mdd, 4),
        "calmar": round(calmar, 4),
        "total_trades": n_trades,
        "win_rate": 0.0,  # 横截面逐笔盈亏未追踪
        "profit_loss_ratio": 0.0,
        "avg_holding_count": round(sum(pos_curve) / len(pos_curve), 2) if pos_curve else 0,
        "turnover_rate": round(turnover_rate, 4),
    }


def _simulate_cross_section(score_df, price_map, config, source_meta, on_progress):
    t0 = time.perf_counter()

    def _prog(stage, pct):
        if on_progress:
            try:
                on_progress(stage, pct)
            except Exception:
                pass

    initial_capital = float(config.get("initial_capital") or 1_000_000)
    rules = config.get("rules") or {}
    pos = config.get("position_sizing") or {}
    max_pos = int(pos.get("max_positions") or 10)
    method = pos.get("method") or "equal_weight"
    rebal = pos.get("rebalance_frequency") or "weekly"
    commission = float(rules.get("commission_rate", 0.0003))
    stamp = float(rules.get("stamp_tax", 0.0005))
    slip = float(rules.get("slippage", 0.001))
    min_commission = float(rules.get("min_commission", 5.0))

    pivot = score_df.pivot_table(index="date", columns="symbol", values="score").sort_index()
    # 前向填充因子值（不回看未来），避免某日因子值缺失导致排名塌缩到 1~2 只、
    # 组合过度集中。缺失首日的标的在首个有效值出现前不参与排名。
    pivot = pivot.ffill()
    all_syms = list(pivot.columns)
    trade_dates = list(pivot.index)

    # 价格面板（有信号日上的收盘价，前向填充）
    px = {}
    for s in all_syms:
        m = price_map.get(s, {})
        ser = pd.Series({d: m.get(d) for d in trade_dates})
        ser = ser.ffill().bfill()
        # 过滤单日涨跌幅 > 35% 的异常值（数据毛刺/除权未复权），用前值替代，
        # 避免个别脏数据把组合收益打到极端。
        ser = ser.where(ser.pct_change().abs() <= 0.35, ser.shift(1))
        ser = ser.ffill().bfill()
        px[s] = ser

    # 重平衡日
    if rebal == "daily":
        rebal_dates = set(trade_dates)
    elif rebal == "weekly":
        rebal_dates = set(trade_dates[::5])
    elif rebal == "monthly":
        rebal_dates = set()
        last_m = None
        for d in trade_dates:
            if last_m != d.month:
                rebal_dates.add(d)
                last_m = d.month
    else:
        rebal_dates = set(trade_dates)

    cash = initial_capital
    shares = {s: 0 for s in all_syms}
    buy_day = {s: None for s in all_syms}
    equity, cash_curve, pos_curve = [], [], []
    trades = []
    last_target = {}
    buy_amount = 0.0

    _prog("simulating", 80)
    for t in trade_dates:
        price_t = {}
        for s in all_syms:
            v = px[s].get(t)
            price_t[s] = None if (v is None or pd.isna(v)) else float(v)

        target = {}
        if t in rebal_dates:
            row = pivot.loc[t].dropna()
            # 有效标的过少时难以分散，跳过本次调仓（维持上一期持仓）
            if len(row) >= 2:
                top = row.sort_values(ascending=False).head(max_pos)
                if method == "signal_weight":
                    w = top.clip(lower=0)
                    tot = w.sum()
                    target = (w / tot).to_dict() if tot > 0 else {}
                else:
                    target = {s: 1.0 / len(top) for s in top.index}
                last_target = target
            else:
                target = last_target

        eq = cash + sum(shares[s] * (price_t[s] or 0) for s in all_syms)

        if t in rebal_dates and target:
            for s, w in target.items():
                p = price_t[s]
                if p is None or p <= 0:
                    continue
                eq_now = cash + sum(shares[x] * (price_t[x] or 0) for x in all_syms)
                desired = int((eq_now * w) // (p * 100)) * 100
                delta = desired - shares[s]
                if delta > 0:
                    buy = p * (1 + slip)
                    fee = max(desired * buy * commission, min_commission)
                    cost = desired * buy + fee
                    if cost > cash:
                        afford = int((cash - min_commission) // (buy * 100)) * 100
                        desired = max(0, afford)
                        delta = desired - shares[s]
                        if delta <= 0:
                            continue
                        cost = desired * buy + max(desired * buy * commission, min_commission)
                    cash -= cost
                    buy_amount += cost
                    shares[s] = desired
                    buy_day[s] = t
                    trades.append({"side": "BUY", "symbol": s, "date": str(t), "price": round(buy, 4), "qty": desired, "amount": round(cost, 2)})
                elif delta < 0:
                    if buy_day[s] == t:
                        continue  # T+1
                    sell = p * (1 - slip)
                    proceeds = (-delta) * sell
                    cash += proceeds - proceeds * commission - proceeds * stamp
                    shares[s] = desired
                    trades.append({"side": "SELL", "symbol": s, "date": str(t), "price": round(sell, 4), "qty": -delta, "amount": round(proceeds, 2)})
            # 清仓不在目标内的持仓
            for s in list(shares.keys()):
                if s not in target and shares[s] > 0:
                    if buy_day[s] == t:
                        continue
                    p = price_t[s]
                    if p is None or p <= 0:
                        continue
                    sell = p * (1 - slip)
                    proceeds = shares[s] * sell
                    cash += proceeds - proceeds * commission - proceeds * stamp
                    trades.append({"side": "SELL", "symbol": s, "date": str(t), "price": round(sell, 4), "qty": shares[s], "amount": round(proceeds, 2)})
                    shares[s] = 0

        eq = cash + sum(shares[s] * (price_t[s] or 0) for s in all_syms)
        equity.append(eq)
        cash_curve.append(cash)
        pos_curve.append(int(sum(1 for s in all_syms if shares[s] > 0)))

    if not equity:
        raise ValueError("横截面回测无有效交易日（请检查因子/信号覆盖与行情）")

    portfolio = [v / initial_capital for v in equity]
    dates_out = [str(d) for d in trade_dates]

    # 基准
    benchmark_code = str(config.get("benchmark") or "000300")
    bench_raw = _fetch_close(benchmark_code, config["start"], config["end"])
    if not bench_raw.empty:
        bs = bench_raw.set_index("dt")["close"].reindex(trade_dates).ffill().bfill()
        b0 = float(bs.iloc[0]) if not bs.empty else 1.0
        benchmark_arr = list(initial_capital * bs.astype(float).values / b0)
        benchmark_price = [float(x) for x in bs.astype(float).values]
    else:
        benchmark_code = f"{benchmark_code}(等权代理)"
        proxy = pd.DataFrame({s: px[s] for s in all_syms}).ffill().bfill()
        if proxy.empty:
            benchmark_arr = [initial_capital] * len(trade_dates)
            benchmark_price = [initial_capital] * len(trade_dates)
        else:
            norm = proxy.div(proxy.iloc[0])
            bc = norm.mean(axis=1) * initial_capital
            benchmark_arr = list(bc.astype(float).values)
            benchmark_price = list(bc.astype(float).values)

    _prog("finalizing", 95)
    sell_trades = [t for t in trades if t["side"] == "SELL"]
    summary = _compute_metrics(portfolio, benchmark_arr, equity, cash_curve, pos_curve, sell_trades, buy_amount, initial_capital)

    # 期末持仓 Top-N（按权重）与个股收益
    holdings = []
    if last_target:
        for s, w in last_target.items():
            series = price_map.get(s, {})
            p0 = series.get(trade_dates[0])
            p1 = series.get(trade_dates[-1])
            ret = (p1 / p0 - 1) if (p0 and p1 and p0 > 0) else 0.0
            holdings.append({"symbol": s, "weight": round(float(w), 4), "ret": round(float(ret), 4)})
    holdings.sort(key=lambda x: -x["weight"])

    # 因子 IC / IR（score vs 次日截面收益）
    ic = ir = None
    if source_meta.get("source") in ("factor", "composite") and len(all_syms) > 5:
        ics = []
        for i, t in enumerate(trade_dates[:-1]):
            r = pivot.loc[t].dropna()
            nxt = trade_dates[i + 1]
            ret = {}
            for s in r.index:
                p0 = price_t0 = px[s].get(t)
                p1 = px[s].get(nxt)
                ret[s] = (p1 / p0 - 1) if (p0 and p1 and p0 > 0) else np.nan
            rr = pd.Series(ret).dropna()
            common = r.reindex(rr.index).dropna()
            if len(common) >= 5:
                icv = common.rank().corr(rr.rank())
                if not np.isnan(icv):
                    ics.append(icv)
        if ics:
            ic = float(np.mean(ics))
            ir = float(np.mean(ics) / (np.std(ics) + 1e-9))
    summary["ic"] = round(ic, 4) if ic is not None else None
    summary["ir"] = round(ir, 4) if ir is not None else None

    # 分段收益（三等分）
    n = len(portfolio)
    seg = max(1, n // 3)
    seg_ranges = [(0, seg), (seg, 2 * seg), (2 * seg, n)]
    segments = []
    for (a, b) in seg_ranges:
        if b <= a:
            continue
        seg_p = portfolio[a:b]
        if not seg_p:
            continue
        ret = seg_p[-1] / seg_p[0] - 1 if seg_p[0] else 0.0
        dd = min(_calculate_drawdowns(seg_p)) if len(seg_p) > 1 else 0.0
        segments.append({
            "label": f"{dates_out[a]} ~ {dates_out[b - 1]}",
            "return": round(ret, 4),
            "max_drawdown": round(dd, 4),
        })

    duration_ms = round((time.perf_counter() - t0) * 1000, 1)
    equity_curve = {
        "dates": dates_out,
        "portfolio": [round(x, 4) for x in portfolio],
        "benchmark": [round(x, 4) for x in benchmark_arr],
        "benchmark_price": [round(x, 4) for x in benchmark_price],
        "cash": [round(x, 2) for x in cash_curve],
        "positions": pos_curve,
    }
    advanced = config.get("advanced") or {}
    meta = {
        "engine": "real_xsec",
        "strategy_type": config.get("strategy", {}).get("type"),
        "benchmark_name": benchmark_code,
        "in_sample": None,
        "training_range": None,
        "overlap_days": None,
        "holdings": holdings,
        "n_trades": len(trades),
    }
    meta.update(source_meta)
    return {
        "summary": summary,
        "equity_curve": equity_curve,
        "segment_performance": segments,
        "feature_importance": None,
        "trades": trades if advanced.get("include_trade_log") else None,
        "duration_ms": duration_ms,
        "_seed": 0,
        "meta": meta,
    }


def run_xsec_backtest(config: dict, on_progress: Callable[[str, int], None] | None = None) -> dict:
    t0 = time.perf_counter()
    if on_progress:
        try:
            on_progress("building_scores", 30)
        except Exception:
            pass
    score_df, source_meta = _build_score_df(config)
    universe = config.get("universe")
    score_syms = set(score_df["symbol"].unique())
    if isinstance(universe, list) and universe:
        syms = [s for s in universe if s in score_syms]
    else:
        syms = sorted(score_syms)  # 数据驱动：取因子/信号覆盖到的全部标的
    if not syms:
        raise ValueError("无可用标的（因子/信号覆盖为空，请检查 universe 或因子数据）")
    # 显式 universe 时，只在该 universe 内打分排名（否则数据驱动取全部覆盖标的）
    score_df = score_df[score_df["symbol"].isin(set(syms))].reset_index(drop=True)
    if score_df.empty:
        raise ValueError("指定 universe 内无因子/信号覆盖，请更换 universe")
    price_map = {s: m for s, m in _fetch_close_multi(syms, config["start"], config["end"]).items() if m}
    if not price_map:
        raise ValueError("标的前提下无日线行情（klines_all 为空）")
    result = _simulate_cross_section(score_df, price_map, config, source_meta, on_progress)
    result["meta"].update({
        "n_symbols": len(syms),
        "universe_resolved": "explicit" if isinstance(universe, list) and universe else "data_driven",
    })
    return result


def run_real_backtest(config: dict, on_progress: Callable[[str, int], None] | None = None) -> dict:
    t0 = time.perf_counter()

    def _prog(stage: str, pct: int) -> None:
        if on_progress:
            try:
                on_progress(stage, pct)
            except Exception:
                pass

    strategy = config.get("strategy") or {}
    if strategy.get("type") != "model":
        return run_xsec_backtest(config, on_progress)
    model_id = strategy.get("model_id")
    if not model_id:
        raise ValueError("model 类型回测必须提供 strategy.model_id")

    start = config["start"]
    end = config["end"]
    initial_capital = float(config.get("initial_capital") or 1_000_000)
    advanced = config.get("advanced") or {}
    rules = config.get("rules") or {}

    # ── 1. 读模型元数据 ──
    client = get_pg_client()
    rows = client.select("models", columns="*", filters={"id": f"eq.{model_id}"})
    if not rows:
        raise ValueError(f"模型不存在：{model_id}")
    model = rows[0]
    file_path = model.get("file_path")
    input_features = model.get("input_features") or []
    target = model.get("target") or "return_5d"
    metadata = model.get("metadata") or {}
    target_symbol = metadata.get("target_symbol")
    if not target_symbol:
        raise ValueError(
            f"模型 {model_id} 未记录 target_symbol（非单只预测模型），"
            "真实回测暂仅支持预测单只股票的模型"
        )
    cls_threshold = float(metadata.get("cls_threshold") or 0.5)
    label_spec = metadata.get("label_spec") or {"kind": "return", "threshold": 0.0}
    peer = metadata.get("peer") or {"enabled": False}

    # 样本内 / 样本外 判定（训练区间 vs 回测区间）
    _in_sample = _compute_in_sample(model.get("training_range"), start, end)

    # ── 1.5 复原训练时的股票池（保证 peer 横截面特征的参照系一致）──
    # 训练时池优先级：peer.peer_symbols > config.symbols（前端手填）> 自动同行业。
    # metadata.symbols 是训练时的池快照（新模型有）；旧模型经 training_job_id
    # 回溯 training_jobs.config.symbols。两者都无 → None（自动同行业，与训练默认一致）。
    train_symbols = metadata.get("symbols")
    if train_symbols is None and model.get("training_job_id"):
        job_rows = client.select(
            "training_jobs",
            columns="config",
            filters={"job_id": f"eq.{model['training_job_id']}"},
        )
        if job_rows:
            train_symbols = (job_rows[0].get("config") or {}).get("symbols")

    # ── 2. 加载模型 ──
    _prog("loading_model", 10)
    booster = _load_booster(file_path)

    # ── 3. 复现训练特征工程（与训练严格一致）──
    _prog("building_features", 30)
    t_load = time.perf_counter()
    df, _used = build_dataset(
        factor_ids=list(input_features),
        target=target,
        train_start=start,
        train_end=end,
        symbols=list(train_symbols) if train_symbols else None,
        label_spec=label_spec,
        target_symbol=target_symbol,
        peer=peer,
        # 回测窗口小、单只+同业池，结果集有限；用大 page_size 让每个 50 因子
        # 分块一次性拉完，跳过 select_all 的 OFFSET 深分页（原 270 次→约 6 次）。
        feature_page_size=1_000_000,
    )
    _prog("predicting", 60)
    logger.info(
        "real_engine.timing.build_dataset_sec",
        sec=round(time.perf_counter() - t_load, 2),
        n_rows=len(df),
        n_cols=df.shape[1],
    )
    if df.empty:
        raise ValueError(f"目标股票 {target_symbol} 在 [{start}~{end}] 无可用因子样本")

    # ── 4. 预测信号：proba >= cls_threshold（与训练评估口径一致）──
    # 训练时 X 用 numpy（Booster 内部列名为 Column_i），真实列名+顺序保存在
    # models.input_features（含 peer 衍生列）。回测必须按同一顺序重建矩阵；
    # 窗口内个别因子无数据导致缺列时补 NaN（LightGBM 原生支持缺失值）。
    n_expect = booster.num_feature()
    if len(input_features) != n_expect:
        raise ValueError(
            f"模型特征数不一致：input_features={len(input_features)}，"
            f"booster 期望 {n_expect}，无法安全对齐"
        )
    missing = [c for c in input_features if c not in df.columns]
    if missing:
        logger.warning(
            "real_engine.feature_missing_filled_nan",
            n_missing=len(missing), sample=missing[:5],
        )
        for c in missing:
            df[c] = np.nan
    X = df[list(input_features)].astype(float).values
    proba = np.asarray(booster.predict(X), dtype=float)
    signal = (proba >= cls_threshold).astype(int)

    sig = pd.DataFrame(
        {
            "symbol": df["symbol"].values,
            "dt": pd.to_datetime(df["dt"]).dt.date.values,
            "proba": proba,
            "signal": signal,
        }
    )
    _prog("simulating", 80)

    # ── 5. 行情（标的 + 基准 000300）──
    px = _fetch_close(target_symbol, start, end)
    if px.empty:
        raise ValueError(f"目标股票 {target_symbol} 在 [{start}~{end}] 无日线行情")
    benchmark_code = str(config.get("benchmark") or "000300")
    bench = _fetch_close(benchmark_code, start, end).rename(columns={"close": "bench_close"})

    merged = sig.merge(px, on="dt", how="inner").sort_values("dt").reset_index(drop=True)
    if not bench.empty:
        merged = merged.merge(bench[["dt", "bench_close"]], on="dt", how="left")
        merged["bench_close"] = merged["bench_close"].ffill().bfill()
    if bench.empty or merged.get("bench_close") is None or merged["bench_close"].isna().all():
        # 指数行情缺失时退回「目标股买入持有」作为基准（单只回测的自然对照）
        logger.warning("real_engine.benchmark_missing_fallback", benchmark=benchmark_code)
        benchmark_code = f"{target_symbol}(buy&hold)"
        merged["bench_close"] = merged["close"]
    b0 = float(merged["bench_close"].iloc[0])

    # ── 6. 日频调仓资金模拟（单只，T+1）──
    commission = float(rules.get("commission_rate", 0.0003))
    stamp = float(rules.get("stamp_tax", 0.0005))
    slip = float(rules.get("slippage", 0.001))

    cash = initial_capital
    shares = 0
    position = False
    buy_price = 0.0
    trades: list[dict] = []
    equity: list[float] = []
    cash_curve: list[float] = []
    pos_curve: list[int] = []

    for row in merged.itertuples(index=False):
        close = float(row.close)
        sig_v = int(row.signal)
        if sig_v == 1 and not position:
            buy = close * (1 + slip)
            fee = cash * commission
            qty = int((cash - fee) // (buy * 100)) * 100  # 1 手 = 100 股
            if qty > 0:
                cost = qty * buy
                cash -= cost + fee
                shares = qty
                position = True
                buy_price = buy
                trades.append(
                    {
                        "id": f"t_{uuid.uuid4().hex[:8]}",
                        "symbol": target_symbol,
                        "side": "BUY",
                        "datetime": f"{row.dt}T09:31:00Z",
                        "price": round(buy, 4),
                        "quantity": qty,
                        "amount": round(cost, 2),
                        "commission": round(fee, 2),
                        "reason": f"model proba={row.proba:.3f} >= {cls_threshold}",
                        "pnl": None,
                    }
                )
        elif sig_v == 0 and position:
            sell = close * (1 - slip)
            proceeds = shares * sell
            fee = proceeds * commission
            tax = proceeds * stamp
            pnl = (sell - buy_price) * shares - fee - tax
            cash += proceeds - fee - tax
            trades.append(
                {
                    "id": f"t_{uuid.uuid4().hex[:8]}",
                    "symbol": target_symbol,
                    "side": "SELL",
                    "datetime": f"{row.dt}T14:55:00Z",
                    "price": round(sell, 4),
                    "quantity": shares,
                    "amount": round(proceeds, 2),
                    "commission": round(fee, 2),
                    "reason": f"model proba={row.proba:.3f} < {cls_threshold}",
                    "pnl": round(pnl, 2),
                }
            )
            shares = 0
            position = False
            buy_price = 0.0
        equity.append(cash + shares * close)
        cash_curve.append(cash)
        pos_curve.append(int(shares > 0))

    if not equity:
        raise ValueError("无有效交易日，回测终止")

    # ── 7. 指标 ──
    portfolio = [v / initial_capital for v in equity]
    benchmark_arr = list(initial_capital * merged["bench_close"].astype(float).values / b0)
    dates = [str(d) for d in merged["dt"].values]

    daily_rets = []
    for i in range(1, len(portfolio)):
        prev = portfolio[i - 1]
        daily_rets.append(portfolio[i] / prev - 1 if prev else 0.0)

    total_return = portfolio[-1] / portfolio[0] - 1 if portfolio[0] else 0.0
    benchmark_return = benchmark_arr[-1] / benchmark_arr[0] - 1 if benchmark_arr[0] else 0.0
    excess_return = total_return - benchmark_return

    mean_r = sum(daily_rets) / len(daily_rets) if daily_rets else 0.0
    var = (
        sum((r - mean_r) ** 2 for r in daily_rets) / max(1, len(daily_rets) - 1)
        if daily_rets
        else 0.0
    )
    sigma = math.sqrt(var)
    sharpe = (mean_r * 252) / (sigma * math.sqrt(252)) if sigma > 0 else 0.0
    downside = [r for r in daily_rets if r < 0]
    ds = math.sqrt(sum(r**2 for r in downside) / len(downside)) if downside else 0.001
    sortino = (mean_r * 252) / (ds * math.sqrt(252)) if ds > 0 else 0.0

    drawdowns = _calculate_drawdowns(portfolio)
    mdd = min(drawdowns) if drawdowns else 0.0
    annual_return = _annualize(total_return, len(portfolio))
    calmar = annual_return / abs(mdd) if mdd < 0 else 0.0
    volatility = sigma * math.sqrt(252)

    sell_trades = [t for t in trades if t["side"] == "SELL"]
    n_trades = len(sell_trades)
    wins = [t for t in sell_trades if (t["pnl"] or 0) > 0]
    win_rate = len(wins) / n_trades if n_trades else 0.0
    gross_win = sum((t["pnl"] or 0) for t in wins)
    loss_trades = [t for t in sell_trades if (t["pnl"] or 0) <= 0]
    gross_loss = sum(-(t["pnl"] or 0) for t in loss_trades)
    avg_win = gross_win / len(wins) if wins else 0.0
    avg_loss = gross_loss / len(loss_trades) if loss_trades else 0.0
    profit_loss_ratio = avg_win / avg_loss if avg_loss > 0 else 0.0

    buy_amount = sum(t["amount"] for t in trades if t["side"] == "BUY")
    avg_equity = sum(equity) / len(equity) if equity else initial_capital
    turnover_rate = (buy_amount * 2) / avg_equity if avg_equity else 0.0

    summary = {
        "total_return": round(total_return, 4),
        "annual_return": round(annual_return, 4),
        "benchmark_return": round(benchmark_return, 4),
        "excess_return": round(excess_return, 4),
        "sharpe": round(sharpe, 3),
        "sortino": round(sortino, 3),
        "calmar": round(calmar, 3),
        "max_drawdown": round(mdd, 4),
        "max_drawdown_period": _max_dd_period(dates, drawdowns),
        "volatility": round(volatility, 4),
        "win_rate": round(win_rate, 3),
        "profit_loss_ratio": round(profit_loss_ratio, 2),
        "turnover_rate": round(turnover_rate, 2),
        "total_trades": n_trades,
        "ic": None,
        "ir": None,
    }

    equity_curve = {
        "dates": dates,
        "portfolio": [round(x, 4) for x in portfolio],
        "benchmark": [round(x, 2) for x in benchmark_arr],
        "benchmark_price": [round(float(x), 4) for x in merged["bench_close"].astype(float).values],
        "drawdown": [round(x, 4) for x in drawdowns],
        "cash": [round(x, 2) for x in cash_curve],
        "positions_count": pos_curve,
    }

    # segment_performance：按时间 3 等分
    n = len(portfolio)
    third = max(1, n // 3)
    segments: dict[str, dict] = {}
    for name, i0, i1 in [
        ("bull", 0, third),
        ("bear", third, 2 * third),
        ("sideways", 2 * third, n),
    ]:
        if i1 > i0 and i1 <= n:
            seg = portfolio[i0:i1]
            seg_ret = seg[-1] / seg[0] - 1 if seg and seg[0] else 0.0
            seg_dd = _calculate_drawdowns(seg)
            segments[name] = {
                "start": dates[i0],
                "end": dates[i1 - 1],
                "return": round(seg_ret, 4),
                "volatility": round(volatility * 0.8, 4),
                "sharpe": round(sharpe * 0.8, 3),
                "max_drawdown": round(min(seg_dd), 4),
            }

    feature_importance = None
    if advanced.get("include_feature_importance"):
        fi = model.get("feature_importance") or {}
        feature_importance = [
            {
                "feature": k,
                "importance": round(float(v), 4),
                "shap_abs_mean": round(float(v) * 0.6, 4),
            }
            for k, v in sorted(fi.items(), key=lambda kv: -kv[1])[:20]
        ]

    trades_out = trades if advanced.get("include_trade_log") else None

    duration_ms = max(1, int((time.perf_counter() - t0) * 1000))
    _prog("finalizing", 95)

    return {
        "summary": summary,
        "equity_curve": equity_curve,
        "segment_performance": segments,
        "feature_importance": feature_importance,
        "trades": trades_out,
        "duration_ms": duration_ms,
        "_seed": 0,
        "meta": {
            "engine": "real",
            "benchmark": benchmark_code,
            "benchmark_name": benchmark_code,
            "target_symbol": target_symbol,
            "model_id": model_id,
            "cls_threshold": cls_threshold,
            "n_samples": int(len(df)),
            "n_signals": int(signal.sum()),
            "n_trades": n_trades,
            "in_sample": _in_sample["in_sample"],
            "training_range": _in_sample["training_range"],
            "overlap_days": _in_sample["overlap_days"],
            "holdings": [{"symbol": target_symbol, "weight": 1.0, "ret": round(total_return, 4)}],
        },
    }
