"""train-svc · LightGBM 训练管线（Epic 4 真实算法）

职责：
- 从 feature_values 取因子矩阵 X（宽表：行=symbol×date，列=factor_id）
- 从 klines_all 计算前向收益标签 y（如 return_5d = close[t+H]/close[t]-1）
- 时间切分 train/valid（默认；杜绝未来函数/信息泄漏），训练 LightGBM 二分类
- 可选「同板块横截面特征」：计算当前股票在同业中的排名/相对强弱/板块均值/板块前向收益
- 可选「多股票输入预测单只」：target_symbol 指定目标，universe=目标+同业，标签只留目标
- 返回模型、指标、特征重要性

后续：
- 回归 / 多分类 / XGBoost 可在此基础上扩展
- WebSocket 流式推理见 Epic 6
"""

from __future__ import annotations

import io
import re
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    confusion_matrix,
    f1_score,
    log_loss,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)

from common import get_logger, get_pg_client

logger = get_logger(__name__)


# ──────────────────────────────────────────
# 配置解析
# ──────────────────────────────────────────
_HORIZON_RE = re.compile(r"return_(\d+)([dhm])", re.IGNORECASE)


def parse_horizon(target: str) -> int:
    """从 target 名解析前向收益周期（交易日）。

    `return_5d` -> 5（天）。`return_10d` -> 10。默认 5。
    分钟/小时级周期近似折算为天数（训练以日频因子为主）。
    """
    m = _HORIZON_RE.search(target or "")
    if not m:
        return 5
    n = int(m.group(1))
    unit = m.group(2).lower()
    if unit == "d":
        return n
    if unit == "h":
        return max(1, n // 6)
    return 1


# 1 个交易日 = 4 小时 = 48 根 5m bar
_BARS_PER_HOUR = 12


def parse_horizon_tf(target: str) -> tuple[int, str]:
    """解析前向周期 → (horizon, timeframe)。

    - `return_Nd` → (N, '1d')：日频标签（历史全量可用）
    - `return_Nh` → (N*12, '5m')：5m bar 标签（真实小时级，数据自 2025-01-02 起，已历史回补）
    - `return_Nm` → (ceil(N/5), '5m')：5m bar 标签（真实分钟级）
    标签归属日 = 样本 bar 的北京交易日，与日频特征对齐。
    """
    m = _HORIZON_RE.search(target or "")
    if not m:
        return 5, "1d"
    n = int(m.group(1))
    unit = m.group(2).lower()
    if unit == "d":
        return n, "1d"
    if unit == "h":
        return max(1, n * _BARS_PER_HOUR), "5m"
    # m：N 分钟 / 5 分钟每 bar，向上取整至少 1 根
    return max(1, (n + 4) // 5), "5m"


def _date_range_clause(start: str | None, end: str | None, col: str) -> dict[str, str]:
    """用 `and` 语法表达 [start, end] 闭区间，避免 dict key 冲突。"""
    parts: list[str] = []
    if start:
        parts.append(f"{col}.gte.{start}")
    if end:
        parts.append(f"{col}.lte.{end}")
    if not parts:
        return {}
    return {"and": "(" + ",".join(parts) + ")"}


# ──────────────────────────────────────────
# 数据拉取
# ──────────────────────────────────────────
def fetch_features(
    factor_ids: list[str],
    start: str | None,
    end: str | None,
    symbols: list[str] | None = None,
    page_size: int = 10_000,
) -> pd.DataFrame:
    """拉取因子长表：columns=[symbol, dt, factor_id, value]。

    仅取 value_num（scalar/rank 因子）。缺失的 (factor, symbol, date) 在 pivot 时留 NaN。

    性能：特征多 × 股票多 × 区间长时行数爆炸（如 229 因子 × 196 股 × 1 年
    ≈ 1100 万行），单查询 + 默认 1000/页要上万次往返，会撞 celery 55 分钟
    软超时（train_3510f583ce9f 事故）。按 50 因子/块 + 1 万行/页拉取。
    """
    client = get_pg_client()
    frames: list[pd.DataFrame] = []
    chunks = [factor_ids[i : i + 50] for i in range(0, len(factor_ids), 50)] or [[]]
    for ci, chunk in enumerate(chunks):
        filt: dict[str, str] = {}
        if chunk:
            filt["factor_id"] = "in.(" + ",".join(chunk) + ")"
        if symbols:
            filt["symbol"] = "in.(" + ",".join(symbols) + ")"
        filt.update(_date_range_clause(start, end, "date"))
        rows = client.select_all(
            "feature_values",
            columns="factor_id,symbol,date,value_num,value_bool",
            filters=filt,
            page_size=page_size,
        )
        logger.info(
            "fetch_features.chunk",
            chunk=f"{ci + 1}/{len(chunks)}",
            factors=len(chunk),
            rows=len(rows),
        )
        if rows:
            frames.append(pd.DataFrame(rows))
    if not frames:
        return pd.DataFrame()
    df = pd.concat(frames, ignore_index=True)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"]).dt.date
    # 统一为数值：scalar/rank 因子用 value_num；boolean 因子（如交叉信号）用 value_bool(→1/0)
    df["value_num"] = pd.to_numeric(df["value_num"], errors="coerce")
    df["value_bool"] = df["value_bool"].map(
        lambda b: 1 if b is True else (0 if b is False else None)
    )
    df["value"] = df["value_num"].fillna(df["value_bool"])
    df = df.rename(columns={"date": "dt"})
    return df[["symbol", "dt", "factor_id", "value"]]


# ──────────────────────────────────────────
# 标签定义（默认 + 自定义 DSL）
# ──────────────────────────────────────────
# 默认标签：未来 H 日「收盘价涨跌方向」，二值化时 metric > threshold 为正类。
DEFAULT_LABEL_SPEC: dict[str, Any] = {
    "kind": "return",   # return | max_return | min_return | custom
    "threshold": 0.0,   # 涨跌阈值：metric > threshold 记为正类（1）
    "expr": "",         # kind=custom 时的自定义表达式
}

# 自定义标签表达式可用的变量（均为「当日 t」与「前向窗口 (t, t+H]」聚合，逐行对齐）：
LABEL_VARIABLES: dict[str, str] = {
    "open": "当日开盘价",
    "high": "当日最高价",
    "low": "当日最低价",
    "close": "当日收盘价 close[t]",
    "volume": "当日成交量",
    "close_fwd": "H 日后收盘价 close[t+H]",
    "high_max": "前向窗口内最高价 max(high[t+1..t+H])",
    "low_min": "前向窗口内最低价 min(low[t+1..t+H])",
    "vol_mean": "前向窗口内平均成交量",
    "ret": "收盘收益 close_fwd/close - 1（默认标签）",
    "max_ret": "期间最大涨幅 high_max/close - 1",
    "min_ret": "期间最大回撤 low_min/close - 1（通常为负）",
}


def label_spec_description(spec: dict[str, Any] | None) -> str:
    """把标签规格转成人类可读描述（用于日志/回溯）。"""
    spec = {**DEFAULT_LABEL_SPEC, **(spec or {})}
    kind = spec.get("kind", "return")
    thr = spec.get("threshold", 0.0)
    kind_txt = {
        "return": "未来 H 日收盘涨跌 (ret)",
        "max_return": "未来 H 日期间最大涨幅 (max_ret)",
        "min_return": "未来 H 日期间最大回撤 (min_ret)",
        "custom": f"自定义: {spec.get('expr', '')}",
    }.get(kind, kind)
    return f"{kind_txt}，正类条件 metric > {thr}"


# ── 自定义表达式安全求值（白名单 AST，禁止属性访问/下标/导入/lambda） ──
import ast  # noqa: E402
import operator as _op  # noqa: E402

_ALLOWED_BINOPS = {
    ast.Add: _op.add,
    ast.Sub: _op.sub,
    ast.Mult: _op.mul,
    ast.Div: _op.truediv,
    ast.Pow: _op.pow,
    ast.Mod: _op.mod,
}
_ALLOWED_UNARY = {ast.UAdd: _op.pos, ast.USub: _op.neg}
_ALLOWED_CMP = {
    ast.Gt: _op.gt,
    ast.Lt: _op.lt,
    ast.GtE: _op.ge,
    ast.LtE: _op.le,
    ast.Eq: _op.eq,
    ast.NotEq: _op.ne,
}
_ALLOWED_FUNCS: dict[str, Any] = {
    "abs": np.abs,
    "maximum": np.maximum,
    "minimum": np.minimum,
    "clip": np.clip,
    "sign": np.sign,
    "log": np.log,
    "log1p": np.log1p,
    "sqrt": np.sqrt,
    "where": np.where,
}


def _safe_eval_label(expr: str, namespace: dict[str, Any]) -> Any:
    """安全求值自定义标签表达式（仅白名单运算/函数/变量）。"""
    if not expr or not expr.strip():
        raise ValueError("kind=custom 但未提供 expr 表达式")
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as e:  # noqa: BLE001
        raise ValueError(f"自定义标签表达式语法错误: {e}") from e

    def _ev(node: ast.AST) -> Any:
        if isinstance(node, ast.Expression):
            return _ev(node.body)
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (int, float)):
                return node.value
            raise ValueError("表达式只允许数字常量")
        if isinstance(node, ast.Name):
            if node.id in namespace:
                return namespace[node.id]
            raise ValueError(
                f"未知变量 {node.id!r}；可用变量：{', '.join(namespace.keys())}"
            )
        if isinstance(node, ast.BinOp) and type(node.op) in _ALLOWED_BINOPS:
            return _ALLOWED_BINOPS[type(node.op)](_ev(node.left), _ev(node.right))
        if isinstance(node, ast.UnaryOp) and type(node.op) in _ALLOWED_UNARY:
            return _ALLOWED_UNARY[type(node.op)](_ev(node.operand))
        if isinstance(node, ast.Compare) and len(node.ops) == 1 and type(node.ops[0]) in _ALLOWED_CMP:
            return _ALLOWED_CMP[type(node.ops[0])](_ev(node.left), _ev(node.comparators[0]))
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in _ALLOWED_FUNCS
        ):
            if node.keywords:
                raise ValueError("自定义标签函数不支持关键字参数")
            return _ALLOWED_FUNCS[node.func.id](*[_ev(a) for a in node.args])
        raise ValueError("表达式包含不支持的语法（禁止属性访问/下标/导入/lambda 等）")

    return _ev(tree)


def _forward_window_aggregates(g: pd.DataFrame, horizon: int) -> dict[str, pd.Series]:
    """按 symbol 分组，逐行计算「当日 t」与「前向窗口 (t, t+H]」的聚合序列。"""
    g = g.sort_values("dt").reset_index(drop=True)
    close_t = g["close"]
    close_fwd = close_t.shift(-horizon)
    # 前向窗口 (t, t+H] 的最高/最低/均量：H 通常很小，用 shift 拼接保证语义清晰
    highs = pd.concat([g["high"].shift(-k) for k in range(1, horizon + 1)], axis=1)
    lows = pd.concat([g["low"].shift(-k) for k in range(1, horizon + 1)], axis=1)
    vols = pd.concat([g["volume"].shift(-k) for k in range(1, horizon + 1)], axis=1)
    high_max = highs.max(axis=1)
    low_min = lows.min(axis=1)
    vol_mean = vols.mean(axis=1)
    ns: dict[str, pd.Series] = {
        "dt": g["dt"],
        "open": g["open"],
        "high": g["high"],
        "low": g["low"],
        "close": close_t,
        "volume": g["volume"],
        "close_fwd": close_fwd,
        "high_max": high_max,
        "low_min": low_min,
        "vol_mean": vol_mean,
        "ret": close_fwd / close_t - 1.0,
        "max_ret": high_max / close_t - 1.0,
        "min_ret": low_min / close_t - 1.0,
    }
    return ns


def fetch_forward_returns(
    start: str,
    end: str,
    horizon: int,
    symbols: list[str] | None = None,
    label_spec: dict[str, Any] | None = None,
    timeframe: str = "1d",
) -> pd.DataFrame:
    """计算前向标签（连续 metric）。默认=收盘涨跌，支持 max/min/自定义。

    从 klines_all 取 OHLCV，按 symbol 分组计算前向窗口聚合，
    再按 `label_spec.kind` 生成连续标签 metric（正负二值化在 train_lightgbm 用 threshold 完成）。

    timeframe：
    - '1d'：日频标签（return_Nd），查询窗口向后延展 horizon 个日历日（+7 天缓冲）
    - '5m'：5m bar 标签（return_Nh/Nm），horizon 单位为 5m bar 数；
      样本点取「每日最后一根 bar」（收盘时点），标签归属日=该 bar 的北京交易日，
      与日频特征对齐；5m 数据自 2025-01-02 起（已历史回补），更早的样本天然无标签（被丢弃）。
    """
    from datetime import datetime, timedelta

    spec = {**DEFAULT_LABEL_SPEC, **(label_spec or {})}
    kind = spec.get("kind", "return")

    if timeframe == "5m":
        # 延展：horizon 根 bar ≈ horizon/48 个交易日，+3 天缓冲
        end_dt = (
            datetime.strptime(end, "%Y-%m-%d")
            + timedelta(days=horizon // 48 + 4)
        ).strftime("%Y-%m-%d")
    else:
        end_dt = (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=horizon + 7)).strftime("%Y-%m-%d")
    client = get_pg_client()
    filt: dict[str, str] = {"timeframe": f"eq.{timeframe}"}
    if symbols:
        filt["symbol"] = "in.(" + ",".join(symbols) + ")"
    filt.update(_date_range_clause(start, end_dt, "dt"))

    rows = client.select_all(
        "klines_all",
        columns="symbol,dt,open,high,low,close,volume",
        filters=filt,
    )
    df = pd.DataFrame(rows)
    if df.empty:
        return pd.DataFrame(columns=["symbol", "dt", "label"])
    for col in ("open", "high", "low", "close", "volume"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    if timeframe == "5m":
        return _forward_returns_5m(df, horizon, kind, spec)

    df["dt"] = pd.to_datetime(df["dt"]).dt.date
    frames = []
    for sym, g in df.groupby("symbol"):
        ns = _forward_window_aggregates(g, horizon)
        if kind == "return":
            metric = ns["ret"]
        elif kind == "max_return":
            metric = ns["max_ret"]
        elif kind == "min_return":
            metric = ns["min_ret"]
        elif kind == "custom":
            expr_ns = {k: v for k, v in ns.items() if k != "dt"}
            metric = _safe_eval_label(spec.get("expr", ""), expr_ns)
            metric = pd.Series(np.asarray(metric, dtype="float64"), index=ns["close"].index)
        else:
            raise ValueError(f"不支持的标签 kind={kind!r}（return/max_return/min_return/custom）")
        # 仅保留前向窗口完整（close[t+H] 存在）的样本，避免窗口不足导致的偏差
        metric = metric.where(ns["close_fwd"].notna())
        frames.append(
            pd.DataFrame({"symbol": sym, "dt": ns["dt"].values, "label": metric.values})
        )
    return pd.concat(frames, ignore_index=True)


def _forward_returns_5m(
    df: pd.DataFrame, horizon: int, kind: str, spec: dict[str, Any]
) -> pd.DataFrame:
    """5m bar 标签：样本点=每日最后一根 bar（收盘时点），前向 horizon 根 bar。"""
    df["dt_ts"] = pd.to_datetime(df["dt"])
    df["trade_date"] = df["dt_ts"].dt.tz_convert("Asia/Shanghai").dt.date

    frames = []
    for sym, g in df.groupby("symbol"):
        g = g.sort_values("dt_ts").reset_index(drop=True)
        close_t = g["close"]
        close_fwd = close_t.shift(-horizon)
        if kind == "return":
            metric = close_fwd / close_t - 1
        elif kind in ("max_return", "min_return"):
            col = "high" if kind == "max_return" else "low"
            exts = pd.concat([g[col].shift(-k) for k in range(1, horizon + 1)], axis=1)
            metric = (
                exts.max(axis=1) / close_t - 1
                if kind == "max_return"
                else exts.min(axis=1) / close_t - 1
            )
        elif kind == "custom":
            ns = {
                "ret": close_fwd / close_t - 1,
                "close": close_t,
                "close_fwd": close_fwd,
                "max_ret": pd.concat(
                    [g["high"].shift(-k) for k in range(1, horizon + 1)], axis=1
                ).max(axis=1)
                / close_t
                - 1,
                "min_ret": pd.concat(
                    [g["low"].shift(-k) for k in range(1, horizon + 1)], axis=1
                ).min(axis=1)
                / close_t
                - 1,
            }
            metric = _safe_eval_label(spec.get("expr", ""), ns)
            metric = pd.Series(np.asarray(metric, dtype="float64"), index=close_t.index)
        else:
            raise ValueError(f"不支持的标签 kind={kind!r}（return/max_return/min_return/custom）")
        metric = metric.where(close_fwd.notna())

        # 样本点：每日最后一根 bar（收盘时点）
        g["label"] = metric.values
        last_bars = g.groupby("trade_date").tail(1)
        frames.append(
            pd.DataFrame(
                {"symbol": sym, "dt": last_bars["trade_date"].values, "label": last_bars["label"].values}
            )
        )
    return pd.concat(frames, ignore_index=True)


# ──────────────────────────────────────────
# 数据集组装
# ──────────────────────────────────────────
def _bounded_symbols(limit: int = 200) -> list[str]:
    """symbols 未指定时，取一个有界股票池，避免对 feature_values 全表扫描。"""
    client = get_pg_client()
    rows = client.select("feature_values", columns="symbol", limit=limit * 4)
    seen: list[str] = []
    for r in rows:
        s = r["symbol"]
        if s not in seen:
            seen.append(s)
        if len(seen) >= limit:
            break
    return seen


# ══════════════════════════════════════════════════════════════════
# 板块 / 同业分组 与 横截面（同板块）特征
# ══════════════════════════════════════════════════════════════════
# 把股票按「行业 / 二级行业 / 市场」归到同一组，组内互称同业（同板块）。
# 横截面特征就是描述「当前股票在其同板块不同股票中的排名 / 关系」，
# 让模型不只能看个股自身因子，还能感知它在板块里的相对位置。
_GROUP_COL_MAP = {
    "industry": "industry",
    "industry_level2": "industry_level2",
    "market": "market",
}


def _resolve_group_col(group_by: str) -> str:
    if group_by not in _GROUP_COL_MAP:
        raise ValueError(
            f"不支持的分组维度 group_by={group_by!r}；可选：industry / industry_level2 / market"
        )
    return _GROUP_COL_MAP[group_by]


def fetch_group_map(symbols: list[str], group_by: str = "industry") -> dict[str, str]:
    """取 code → 分组键（同板块/同行业/同市场）映射，用于横截面特征分组。"""
    col = _resolve_group_col(group_by)
    client = get_pg_client()
    rows = client.select(
        "symbols",
        columns=f"code,{col}",
        filters={"code": f"in.({','.join(symbols)})"},
        limit=len(symbols) + 50,
    )
    return {r["code"]: (r.get(col) or "_unknown_") for r in rows}


def fetch_peer_symbols(target_symbol: str, group_by: str = "industry") -> list[str]:
    """取与目标股票同板块/同行业/同市场的全部股票（含目标自身）。

    用于「以同业作为上下文，预测单只股票」：universe = 目标 + 同业。
    若目标无分组信息，则退化为仅 [target_symbol]。
    """
    col = _resolve_group_col(group_by)
    client = get_pg_client()
    tgt = client.select(
        "symbols", columns=f"code,{col}",
        filters={"code": f"eq.{target_symbol}"}, limit=1,
    )
    if not tgt:
        return [target_symbol]
    gv = tgt[0].get(col)
    if not gv:
        return [target_symbol]
    rows = client.select(
        "symbols", columns="code",
        filters={col: f"eq.{gv}", "status": "eq.active"}, limit=1000,
    )
    return [r["code"] for r in rows] or [target_symbol]


def add_peer_features(
    wide: pd.DataFrame,
    group_map: dict[str, str],
    group_by: str = "industry",
    modes: list[str] | None = None,
) -> tuple[pd.DataFrame, list[str]]:
    """在因子宽表上追加「同板块横截面特征」。

    输入 wide: 含 [symbol, dt, factor1, factor2, ...]
    输出 (wide_with_peers, new_cols)

    支持的 modes（可组合）：
    - "rank"          : 该股票因子值在组内同日的百分位排名 (0~1, 1=最高)
    - "relative"      : (自身值 - 组内均值) / 组内标准差（Z-score，相对强弱）
    - "sector_mean"   : 组内均值（所有同业相同，刻画板块整体水位）

    说明：这些特征全部基于「当前已知因子值」计算，让模型「知道」当前股票
    在其板块里的位置/关系；当只保留目标股票行、但保留这些同业聚合特征时，
    等价于「多种股票输入，预测其中一只」。

    注意：历史上曾存在 "sector_return" 模式（板块未来收益均值），但该特征
    由前向标签聚合得到，属于未来函数 / 标签泄漏，已移除，请勿再加回。
    """
    modes = modes or ["rank", "relative", "sector_mean"]

    # 硬拦截：只允许基于「当前已知因子值」的模式。任何依赖未来/标签数据的
    # 模式（如已移除的 "sector_return"）都是未来函数，禁止作为特征进入训练。
    # 这是对「线上拿不到的数据不得出现在训练特征中」红线的编译期保障。
    _ALLOWED = {"rank", "relative", "sector_mean"}
    bad = [m for m in modes if m not in _ALLOWED]
    if bad:
        raise ValueError(
            f"不支持的 peer 特征模式 {bad}。只允许基于当前已知因子值的模式 "
            f"{sorted(_ALLOWED)}；依赖未来/标签数据的模式（如 'sector_return'）"
            f"属未来函数，禁止作为特征。"
        )

    df = wide.copy()
    df["_grp"] = df["symbol"].map(lambda s: group_map.get(s, "_unknown_"))

    new_cols: list[str] = []
    factor_cols = [c for c in df.columns if c not in ("symbol", "dt", "_grp")]

    for c in factor_cols:
        if "rank" in modes:
            name = f"{c}__rank_{group_by}"
            df[name] = df.groupby(["_grp", "dt"])[c].rank(pct=True)
            new_cols.append(name)
        if "relative" in modes:
            g = df.groupby(["_grp", "dt"])[c]
            mean = g.transform("mean")
            std = g.transform("std")
            name = f"{c}__rel_{group_by}"
            df[name] = (df[c] - mean) / std.replace(0, np.nan)
            new_cols.append(name)
        if "sector_mean" in modes:
            name = f"{c}__mean_{group_by}"
            df[name] = df.groupby(["_grp", "dt"])[c].transform("mean")
            new_cols.append(name)

    df = df.drop(columns=["_grp"])
    return df, new_cols


def fetch_factor_categories(factor_ids: list[str]) -> dict[str, str]:
    """因子 id → category（用于 B 模式限定 K线 / technical 因子）。"""
    if not factor_ids:
        return {}
    client = get_pg_client()
    rows = client.select(
        "factor_definitions", columns="id,category",
        filters={"id": f"in.({','.join(factor_ids)})"}, limit=len(factor_ids) + 50,
    )
    return {r["id"]: (r.get("category") or "custom") for r in rows}


def add_pool_feature_block(
    wide: pd.DataFrame,
    factor_ids: list[str],
    stats: list[str] | None = None,
    kline_only: bool = False,
) -> tuple[pd.DataFrame, list[str]]:
    """B 模式：把股票池当作特征输入——对池中全部股票的因子按交易日做「跨池横截面统计」，
    生成与池大小无关的有界特征块（pool__{factor}__{stat}），广播到目标股当日行。

    设计取舍（避免维度爆炸 & 模型不可移植）：
    - 不直接把每只股票的特征拼成 N×F 列（维度随池线性膨胀，~240 样本扛不住）；
    - 改为对池中全部股票按交易日聚合 mean/std/min/max/median（确定性变换），
      维度 = 因子数 × 统计数，与池大小无关，且预测时可从同一批 feature_values 复现，
      不需持久化任何 transformer；
    - kline_only=True：仅用 technical 类因子（价格/成交量派生），避开基本面因子的
      低频/缺失噪声，更贴合「同业 K线 联动」直觉。
    """
    if stats is None:
        stats = ["mean", "std", "min", "max", "median"]
    cols = [c for c in factor_ids if c in wide.columns]
    if kline_only:
        cats = fetch_factor_categories(factor_ids)
        cols = [c for c in cols if cats.get(c) == "technical"]
    if not cols:
        return wide, []
    stat_tbl = wide.groupby("dt")[cols].agg(stats)
    stat_tbl.columns = [f"pool__{c}__{st}" for c, st in stat_tbl.columns]
    stat_tbl = stat_tbl.reset_index()
    out = wide.merge(stat_tbl, on="dt", how="left")
    new_cols = [c for c in stat_tbl.columns if c != "dt"]
    return out, new_cols


def build_dataset(
    factor_ids: list[str],
    target: str,
    train_start: str | None,
    train_end: str | None,
    symbols: list[str] | None = None,
    label_spec: dict[str, Any] | None = None,
    target_symbol: str | None = None,
    peer: dict[str, Any] | None = None,
    feature_page_size: int = 10_000,
    test_start: str | None = None,
    test_end: str | None = None,
) -> tuple[pd.DataFrame, list[str]]:
    """组装训练数据集。

    返回 (wide_df, used_factor_ids)
    - wide_df: index 重置后含 [symbol, dt]，columns=各 factor_id + 同板块横截面特征 + 'label'
    - label: 前向标签（连续 metric，按 label_spec 计算）；训练时按阈值二值化

    ── 新增能力（备注） ──
    1) 同板块横截面特征（peer features）：peer.enabled=True 时，除个股自身因子外，
       额外计算该股票在「同行业/同市场」同业中的排名/相对强弱/板块均值等特征，
       让模型感知「当前股票在同板块不同股票中的排名或关系」。
       分组维度由 peer.group_by 决定（industry / industry_level2 / market），
       特征类型由 peer.modes 选择（rank / relative / sector_mean）。
    2) 多股票输入预测单只（target_symbol）：指定 target_symbol 时，universe 取
       「目标 + 同板块同业」（或由 peer.peer_symbols 显式指定），标签只保留目标股票，
       但特征里包含同业聚合特征，等价于「用一篮子同业作为上下文，预测其中一只的涨跌」。
       不指定 target_symbol 时，仍按原逻辑做全市场面板训练（每行一支股票各自预测）。
    """
    peer = peer or {}
    peer_enabled = bool(peer.get("enabled", False))
    group_by = peer.get("group_by", "industry")
    peer_modes = peer.get("modes") or ["rank", "relative", "sector_mean"]
    # 池用途开关：
    #  - "reference"（A，默认）：池作横截面参照系，算目标股在池中的 rank/rel/mean
    #  - "features"（B）：池作特征输入，算跨池横截面统计块（有界维度，见 add_pool_feature_block）
    pool_mode = (peer.get("pool_mode") or "reference") if peer_enabled else "reference"
    pool_kline_only = bool(peer.get("pool_kline_only", False))

    # ── 1. 决定股票池 universe ──
    if target_symbol:
        # 预测单只：上下文 = 目标 + 同业。
        # 优先级：peer.peer_symbols > 前端「股票池」框(config.symbols) > 按 group_by 自动取同行业
        # （修复：此前 config.symbols 在 target 模式下被忽略，手填池不生效）
        explicit_peers = peer.get("peer_symbols") or (list(symbols) if symbols else None)
        if explicit_peers:
            universe = list(dict.fromkeys([target_symbol] + list(explicit_peers)))
        else:
            universe = fetch_peer_symbols(target_symbol, group_by)
        symbols_used = universe
        logger.info(
            "build_dataset.target_symbol",
            target=target_symbol, group_by=group_by, pool_mode=pool_mode,
            universe_size=len(universe),
        )
    else:
        if not symbols:
            symbols = _bounded_symbols()
        symbols_used = symbols
        logger.info("build_dataset.symbols_auto", count=len(symbols_used))

    if not _HORIZON_RE.search(target or ""):
        raise ValueError(
            f"不支持的 target={target!r}；仅支持 return_Nx 格式（x=d天/h时/m分，如 return_20d）"
        )
    horizon, label_tf = parse_horizon_tf(target)
    start = train_start or "2018-01-01"
    end = train_end or "2023-12-31"
    # 测试集（用户预留、不参与训练/调参，仅最终评估）：把因子值与标签的抓取上沿
    # 扩展到 test_end，使测试样本的特征与（可计算部分的）标签可用。test_end 不晚于
    # train_end 时不扩展。
    fetch_end = end
    if test_end and (train_end is None or test_end > train_end):
        fetch_end = test_end
    logger.info(
        "build_dataset.label",
        spec=label_spec_description(label_spec),
        label_timeframe=label_tf,
        horizon=horizon,
        test_start=test_start,
        test_end=test_end,
    )

    feat = fetch_features(factor_ids, start, fetch_end, symbols_used, page_size=feature_page_size)
    labels = fetch_forward_returns(
        start, fetch_end, horizon, symbols_used, label_spec=label_spec, timeframe=label_tf
    )

    if feat.empty:
        raise ValueError(
            "feature_values 为空：请确认 factor_ids 正确且 train_start/train_end 范围内有因子值"
        )
    if labels.empty:
        raise ValueError("klines_all 取不到标签所需的收盘价数据")

    wide = feat.pivot_table(index=["symbol", "dt"], columns="factor_id", values="value")
    wide = wide.reset_index()

    # ── 2. 同板块横截面特征 / 池特征输入 ──
    if peer_enabled:
        if pool_mode == "features":
            # B：池作为特征输入 —— 跨池横截面统计块（维度与池大小无关）
            wide, _peer_cols = add_pool_feature_block(
                wide, factor_ids, kline_only=pool_kline_only
            )
            logger.info(
                "build_dataset.pool_features",
                kline_only=pool_kline_only, added=len(_peer_cols),
            )
        else:
            # A：池作为横截面参照系 —— 目标股在池中的 rank/rel/mean
            group_map = fetch_group_map(symbols_used, group_by)
            wide, _peer_cols = add_peer_features(
                wide, group_map, group_by=group_by, modes=peer_modes
            )
            logger.info(
                "build_dataset.peer_features",
                group_by=group_by, modes=peer_modes, added=len(_peer_cols),
            )

    merged = wide.merge(labels, on=["symbol", "dt"], how="inner").dropna(subset=["label"])

    # ── 3. 若指定 target_symbol，只保留目标股票的标签行（特征仍含同业聚合）──
    if target_symbol:
        merged = merged[merged["symbol"] == target_symbol].reset_index(drop=True)
        if merged.empty:
            raise ValueError(
                f"目标股票 {target_symbol} 在 [{start} ~ {end}] 内无可用样本"
            )

    # 丢弃所有因子列都缺失的行
    factor_cols = [c for c in merged.columns if c not in ("symbol", "dt", "label")]
    merged = merged.dropna(subset=factor_cols, how="all")

    used = list(merged.columns)
    for drop in ("symbol", "dt", "label"):
        used.remove(drop)
    return merged, used


# ──────────────────────────────────────────
# 训练
# ──────────────────────────────────────────
def _drop_low_variance(
    df: pd.DataFrame,
    feature_cols: list[str],
    min_variance: float = 1e-12,
    max_nan_ratio: float = 0.95,
) -> list[str]:
    """特征选择（第一关）：丢弃无信息量的因子列。

    - 常量列（如恒为 1 的 boolean 信号）：nunique<=1 → 模型学不到任何东西
    - 缺失率过高的列：> max_nan_ratio
    - 方差过低（数值缩放后几乎不变）：var < min_variance

    返回保留的因子列名。
    """
    kept: list[str] = []
    for c in feature_cols:
        col = df[c]
        non_null = col.dropna()
        if len(non_null) == 0:
            continue
        if non_null.nunique(dropna=True) <= 1:
            continue
        if col.isna().mean() > max_nan_ratio:
            continue
        var = non_null.var()
        if pd.isna(var) or var < min_variance:
            continue
        kept.append(c)
    return kept


def _select_by_importance(
    X: "np.ndarray",
    y: "np.ndarray",
    feature_cols: list[str],
    max_features: int,
    seed: int = 42,
) -> list[str]:
    """特征选择（第二关，可选）：先训练一个轻量 LightGBM，按 gain 选 top-k。"""
    if max_features is None or len(feature_cols) <= max_features:
        return feature_cols
    base = {
        "objective": "binary",
        "metric": "auc",
        "boosting_type": "gbdt",
        "learning_rate": 0.1,
        "num_leaves": 31,
        "min_child_samples": 100,
        "n_jobs": -1,
        "seed": seed,
        "verbose": -1,
    }
    ds = lgb.Dataset(X, y)
    # 注意：不能挂 early_stopping——这里没有 valid 集，LightGBM 4.x 会直接抛
    # "For early stopping, at least one dataset and eval metric is required"
    # （train_57d54f87ee66 事故；特征数 ≤ max_features 时提前 return 所以以前没踩到）。
    # 重要性排序只需轻量固定轮数。
    booster = lgb.train(
        base,
        ds,
        num_boost_round=100,
        callbacks=[lgb.log_evaluation(0)],
    )
    imp = booster.feature_importance(importance_type="gain")
    order = [c for _, c in sorted(zip(imp, feature_cols), key=lambda kv: kv[0], reverse=True)]
    return order[:max_features]


def split_train_valid(
    data: "pd.DataFrame",
    valid_ratio: float = 0.2,
    split_method: str = "time",
    seed: int = 42,
    embargo_days: int = 0,
    train_end: str | None = None,
) -> tuple["np.ndarray", "np.ndarray"]:
    """计算训练/验证切分的位置索引 (train_idx, valid_idx)。

    - "time"（默认）：按 dt 升序切分，验证集 = 最近 valid_ratio 比例的「交易日」，
      训练集 = 其余较早交易日。验证集在时间上严格晚于训练集，杜绝未来函数。
    - "random"：随机切分（仅用于对照实验，不推荐实际训练）。
    - embargo_days：隔离带（= 前向标签周期 H）。cutoff 前 H 个交易日的训练样本，
      其前向标签会延伸进验证窗口（边界泄漏），丢弃不用。

    若数据仅含单日（无法时间切分），自动退化为 random 并告警。
    """
    if split_method == "time":
        dt = data["dt"]
        if train_end:
            # 归一化为与 dt 同类型，避免 python date 对象与字符串直接比较抛 TypeError
            te = (
                pd.Timestamp(train_end)
                if pd.api.types.is_datetime64_any_dtype(dt)
                else pd.Timestamp(train_end).date()
            )
            # 仅以 [.., train_end] 区间内的日期作为切分基准，排除预留测试集（dt>train_end），
            # 否则训练/验证切分会把测试样本也分进来。
            uniq_dates = dt[dt <= te].drop_duplicates().sort_values()
        else:
            te = None
            uniq_dates = dt.drop_duplicates().sort_values()
        n_dates = len(uniq_dates)
        if n_dates <= 1:
            logger.warning("train.split.time_fallback_random", n_dates=n_dates)
            split_method = "random"
        else:
            cut_idx = int(n_dates * (1.0 - valid_ratio))
            cut_idx = max(1, min(n_dates - 1, cut_idx))  # 保证训练/验证都至少 1 天
            cut_date = uniq_dates.iloc[cut_idx]
            if embargo_days > 0:
                # 隔离带：训练样本截止日再往前推 H 个交易日，
                # 保证所有训练标签的窗口都不触碰验证期
                emb_idx = max(1, cut_idx - embargo_days)
                train_end_date = uniq_dates.iloc[emb_idx - 1]
            else:
                train_end_date = cut_date
            upper = te if te is not None else dt.max()
            is_train = ((dt <= train_end_date) & (dt <= upper)).values
            is_valid = ((dt > cut_date) & (dt <= upper)).values
            return np.where(is_train)[0], np.where(is_valid)[0]

    # random 分支
    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(data))
    n_valid = int(len(idx) * valid_ratio)
    return idx[n_valid:], idx[:n_valid]


# 自动调参网格（围绕正则强度：叶子数 / 最小子样本 / 特征采样 / L2）
_TUNE_GRID: list[dict[str, Any]] = [
    {"num_leaves": 7, "min_child_samples": 200, "feature_fraction": 0.6, "lambda_l2": 10.0},
    {"num_leaves": 15, "min_child_samples": 100, "feature_fraction": 0.8, "lambda_l2": 1.0},
    {"num_leaves": 15, "min_child_samples": 200, "feature_fraction": 0.7, "lambda_l2": 5.0},
    {"num_leaves": 15, "min_child_samples": 400, "feature_fraction": 0.7, "lambda_l2": 10.0},
    {"num_leaves": 31, "min_child_samples": 100, "feature_fraction": 0.9, "lambda_l2": 0.0},
    {"num_leaves": 31, "min_child_samples": 200, "feature_fraction": 0.8, "lambda_l2": 5.0},
    {"num_leaves": 31, "min_child_samples": 400, "feature_fraction": 0.7, "lambda_l2": 10.0},
    {"num_leaves": 63, "min_child_samples": 200, "feature_fraction": 0.8, "lambda_l2": 1.0},
]


# 自动调参可选目标指标（均在验证集上计算；logloss 越低越好，其余越高越好）
# - auc：ROC-AUC，排序能力（默认）。验证集正样本很少时噪声大。
# - pr_auc：平均精确率（PR 曲线下面积），类不平衡下比 ROC-AUC 更敏感、更稳。
# - logloss：概率校准质量，对「预测概率整体漂移」敏感，全样本参与、噪声最小。
# - f1：先用训练集 Youden J 选阈值，再算验证集 F1，直接对齐「阈值化后能否开单」。
TUNE_METRICS = ("auc", "pr_auc", "logloss", "f1")


def _tune_on_valid(
    X_train: "np.ndarray",
    y_train: "np.ndarray",
    X_valid: "np.ndarray",
    y_valid: "np.ndarray",
    base_params: dict[str, Any],
    *,
    num_boost_round: int = 150,
    seed: int = 42,
    metric: str = "auc",
) -> tuple[dict[str, Any], float, list[dict[str, Any]]]:
    """用训练窗口内切出的验证集直接调参，返回 (best_params, best_score, top3 候选榜)。

    每个候选：在 train 上训练、在 valid（train_lightgbm 已排除测试集）上按 `metric`
    打分取最优（见 TUNE_METRICS）。符合「用验证集调参、不用测试集调参」的协议；
    验证集不参与最终模型训练（保留为干净评估集），故又能与测试集效果对比。
    """
    if metric not in TUNE_METRICS:
        metric = "auc"
    higher_better = metric != "logloss"

    def _score(booster: "lgb.Booster") -> float:
        # 验证集单类别：AUC/PR-AUC/F1 无意义，logloss 也失真 → 记最差分
        if len(np.unique(y_valid)) < 2:
            return 99.0 if metric == "logloss" else 0.0
        pred = booster.predict(X_valid)
        if metric == "pr_auc":
            return float(average_precision_score(y_valid, pred))
        if metric == "logloss":
            return float(log_loss(y_valid, np.clip(pred, 1e-7, 1 - 1e-7), labels=[0, 1]))
        if metric == "f1":
            thr = _best_cls_threshold(y_train, booster.predict(X_train))
            return float(f1_score(y_valid, (pred >= thr).astype(int), zero_division=0))
        return float(roc_auc_score(y_valid, pred))
    n = len(X_train)
    # min_child_samples 按训练集规模收缩：小样本下 200/400 的叶子约束会让树无法分裂，
    # 模型退化为单叶常数（AUC=0.5、重要度全 0 的事故）
    mcs_cap = max(20, int(n * 0.4) // 10)
    grid: list[dict[str, Any]] = []
    seen: set[tuple] = set()
    for cand in _TUNE_GRID:
        c = {**cand, "min_child_samples": min(cand["min_child_samples"], mcs_cap)}
        key = tuple(sorted(c.items()))
        if key not in seen:
            seen.add(key)
            grid.append(c)
    leaderboard: list[dict[str, Any]] = []
    for cand in grid:
        booster = lgb.train(
            {**base_params, **cand},
            lgb.Dataset(X_train, y_train),
            num_boost_round=num_boost_round,
            callbacks=[lgb.log_evaluation(0)],
        )
        leaderboard.append({**cand, "score": round(_score(booster), 4), "metric": metric})
    leaderboard.sort(key=lambda r: r["score"], reverse=higher_better)
    if not leaderboard:
        return {}, 0.0, []
    best = {k: v for k, v in leaderboard[0].items() if k not in ("score", "metric")}
    return best, float(leaderboard[0]["score"]), leaderboard[:3]


def _best_cls_threshold(y_true: "np.ndarray", y_score: "np.ndarray") -> float:
    """Youden's J（max TPR−FPR）在「训练集」上选二分类阈值。

    不平衡数据（正类 ~20%）下固定 0.5 阈值常导致零正类预测；
    自适应阈值让混淆矩阵/精确率/召回率/F1 有实际意义。
    只用训练集选阈值（不用验证集），避免阈值层面的信息泄漏。
    """
    try:
        fpr, tpr, thrs = roc_curve(y_true, y_score)
        j = tpr - fpr
        thr = float(thrs[int(np.argmax(j))])
        if not np.isfinite(thr):  # roc_curve 首点阈值为 inf
            return 0.5
        # 钳制到合理区间，避免退化阈值（全判正/全判负）
        return round(min(max(thr, 0.05), 0.95), 4)
    except Exception:  # noqa: BLE001 - 任何异常回退默认阈值
        return 0.5


def train_lightgbm(
    df: pd.DataFrame,
    feature_cols: list[str],
    params: dict[str, Any] | None = None,
    valid_ratio: float = 0.2,
    seed: int = 42,
) -> dict[str, Any]:
    """训练 LightGBM 二分类（按涨跌阈值预测标签方向）。

    标签二值化：y = (label_metric > params.label.threshold)。label_metric 由
    build_dataset 依 params.label.kind（return/max_return/min_return/custom）算出。

    内置两关特征选择（受 config.params.selection 控制）：
    1. variance  —— 丢弃常量/高缺失/零方差因子（默认开启）
    2. importance —— 按 gain 选 top-k（method="importance" 时开启）

    返回 dict：{ booster, train_auc, valid_auc, n_train, n_valid,
                feature_importance(dict), feature_cols(最终选中),
                metrics_table(训练/验证评估指标表) }
    """
    params = params or {}
    # LightGBM 原生支持 NaN（分裂时自动学默认方向），不按「任一特征缺失」整行丢——
    # 多特征交集会把样本饿死（70 特征 1 年仅剩 ~1700 样本、模型退化 AUC=0.5 的事故）。
    # 仅丢「全部特征都缺失」的行（build_dataset 已做 how="all"，此处兜底）。
    data = df.dropna(subset=feature_cols, how="all").copy()
    if data.empty:
        raise ValueError("无可用样本（因子覆盖太低）")

    # ── 特征选择 ──
    selection = params.get("selection") or {}
    sel_method = selection.get("method", "variance")
    max_features = selection.get("max_features")
    min_variance = float(selection.get("min_variance", 1e-12))

    kept = _drop_low_variance(data, feature_cols, min_variance=min_variance)
    if not kept:
        raise ValueError(
            "特征选择后无可用因子：传入的 features 几乎全部为常量/缺失。"
            "请传入有方差的 scalar/rank 因子，或显式指定 symbols/日期范围。"
        )
    feature_cols = kept
    logger.info("train.selection.variance", kept=len(feature_cols), total=len(kept))

    X = data[feature_cols].astype(float).values

    # ── 标签二值化：涨跌阈值 metric > threshold 记为正类 ──
    label_conf = params.get("label") or {}
    threshold = float(label_conf.get("threshold", 0.0))
    y = (data["label"].astype(float) > threshold).astype(int).values
    pos = int(y.sum())
    neg = int(len(y) - pos)
    if pos == 0 or neg == 0:
        raise ValueError(
            f"阈值 threshold={threshold} 导致样本全为单一类别"
            f"（正类 {pos} / 负类 {neg}）；请调低/调高阈值或更换标签定义。"
        )
    logger.info("train.label", threshold=threshold, pos=pos, neg=neg)

    if sel_method == "importance" and max_features:
        feature_cols = _select_by_importance(X, y, feature_cols, int(max_features), seed)
        X = data[feature_cols].astype(float).values
        logger.info("train.selection.importance", kept=len(feature_cols))

    if len(feature_cols) == 0:
        raise ValueError("特征选择后无可用因子")

    # ──────────────────────────────────────────────────────────────
    # 训练 / 验证切分（默认「按时间」，避免未来函数 / 信息泄漏）
    # ──────────────────────────────────────────────────────────────
    # 金融时序严禁随机切分：随机会把「未来样本」混入训练、「历史样本」混入验证，
    # 导致验证 AUC 虚高、实盘泛化差。正确做法是时间切分——训练用较早时段，
    # 验证用最近时段，二者在时间上严格不重叠（验证集完全晚于训练集）。
    # valid_ratio 语义变为「最近 time 比例」作为验证集（如 0.2 = 最近 20% 交易日）。
    split_method = params.get("split_method", "time")
    # 隔离带 = 前向标签周期（tasks 按 target 算出）：cutoff 前 H 个交易日的
    # 训练标签会延伸进验证窗口（边界泄漏），丢弃不用
    embargo_days = int(params.get("embargo_days", 0) or 0)
    train_idx, valid_idx = split_train_valid(
        data,
        valid_ratio=valid_ratio,
        split_method=split_method,
        seed=seed,
        embargo_days=embargo_days,
        # 仅以 [.., train_end] 内的日期做训练/验证切分，排除预留测试集（dt>train_end）
        train_end=params.get("train_end"),
    )
    # 预留测试集：dt 落在 [test_start, test_end] 的样本，参与最终评估但不参与训练/调参。
    test_start = params.get("test_start")
    test_end = params.get("test_end")
    if test_start and test_end:
        # 归一化为与 data["dt"] 同类型，避免 date 对象与字符串比较抛 TypeError
        if pd.api.types.is_datetime64_any_dtype(data["dt"]):
            ts, te = pd.Timestamp(test_start), pd.Timestamp(test_end)
        else:
            ts, te = pd.Timestamp(test_start).date(), pd.Timestamp(test_end).date()
        test_mask = (data["dt"] >= ts) & (data["dt"] <= te)
        test_idx = np.where(test_mask.values)[0]
    else:
        test_idx = np.array([], dtype=int)
    if split_method == "time":
        logger.info(
            "train.split.time",
            n_train=len(train_idx), n_valid=len(valid_idx), embargo_days=embargo_days,
        )

    # min_child_samples 随训练样本量收缩：固定 100 在小样本（数百行）下
    # 同样无法分裂（与调参网格同一坑）
    _mcs_default = min(100, max(20, len(train_idx) // 10))
    default_params = {
        "objective": "binary",
        "metric": "auc",
        "boosting_type": "gbdt",
        "learning_rate": 0.05,
        "num_leaves": 31,
        "feature_fraction": 0.9,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "min_child_samples": _mcs_default,
        # 类别不平衡（正类常仅 ~20%）：放大正类权重，避免预测概率被压到
        # 0.5 以下导致「零正类预测」（精确率/召回率/F1 全 0 的假象）
        "scale_pos_weight": (neg / pos) if pos > 0 else 1.0,
        "n_jobs": -1,
        "seed": seed,
        "verbose": -1,
    }
    # 仅把「LightGBM 原生参数」透传给引擎；selection / num_boost_round 等
    # 是训练管线的控制项，不能塞进 LightGBM params（否则报 Unknown parameter）。
    _control_keys = {
        "selection", "num_boost_round", "label", "tune", "tune_metric",
        "embargo_days", "split_method", "train_end", "test_start", "test_end",
        "refit_on_valid",
    }
    lgbm_params = {k: v for k, v in params.items() if k not in _control_keys}
    default_params.update(lgbm_params)

    num_boost_round = int(params.get("num_boost_round", 200))

    # ── 自动调参（可选）：用 carved 验证集直接网格搜索正则强度（防测试集泄漏）──
    tuned_params: dict[str, Any] | None = None
    cv_auc: float | None = None
    cv_top: list[dict[str, Any]] = []
    tune_metric = str(params.get("tune_metric") or "auc").lower()
    if tune_metric not in TUNE_METRICS:
        tune_metric = "auc"
    if params.get("tune"):
        logger.info("train.tune.start", candidates=len(_TUNE_GRID), metric=tune_metric)
        best, cv_auc, cv_top = _tune_on_valid(
            X[train_idx],
            y[train_idx],
            X[valid_idx],
            y[valid_idx],
            default_params,
            num_boost_round=min(num_boost_round, 150),
            seed=seed,
            metric=tune_metric,
        )
        if best:
            tuned_params = best
            default_params.update(best)
        logger.info("train.tune.done", best=best, cv_score=cv_auc, metric=tune_metric)

    # ── 最终模型训练集：是否并入验证集全量训练（refit_on_valid 开关）──
    # 默认 false：最终模型只在 train 上训练，验证集保留为干净评估（损失约 20% 数据）。
    # true：在 train+valid 上全量训练（用更多数据、更强拟合），但验证集变为样本内，
    # 此时仅「预留测试集」能作为真实的泛化锚点（cv_auc 仍是调参阶段的验证集 AUC）。
    refit_on_valid = bool(params.get("refit_on_valid", False))
    if refit_on_valid:
        final_idx = np.concatenate([train_idx, valid_idx])
        logger.info(
            "train.refit_on_valid",
            n_train=len(train_idx), n_valid=len(valid_idx), n_final=len(final_idx),
        )
    else:
        final_idx = train_idx

    train_set = lgb.Dataset(X[final_idx], y[final_idx])
    valid_set = lgb.Dataset(X[valid_idx], y[valid_idx], reference=train_set)

    booster = lgb.train(
        default_params,
        train_set,
        num_boost_round=num_boost_round,
        valid_sets=[valid_set],
        callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(0)],
    )

    train_pred = booster.predict(X[train_idx])
    valid_pred = booster.predict(X[valid_idx])
    test_pred = booster.predict(X[test_idx]) if len(test_idx) else np.array([], dtype=float)
    train_auc = float(roc_auc_score(y[train_idx], train_pred))
    valid_auc = float(roc_auc_score(y[valid_idx], valid_pred))
    test_auc = (
        float(roc_auc_score(y[test_idx], test_pred))
        if len(test_idx) and len(np.unique(y[test_idx])) > 1
        else None
    )

    # 退化检测：双 AUC ≈ 0.5 → 模型没学到任何东西（单叶常数），必须显式标记
    degenerate = bool(train_auc < 0.52 and valid_auc < 0.52)
    if degenerate:
        logger.warning(
            "train.degenerate",
            train_auc=round(train_auc, 4),
            valid_auc=round(valid_auc, 4),
            n_train=int(len(train_idx)),
            n_features=len(feature_cols),
            hint="样本过少/特征无区分度/标签阈值不合理",
        )

    importance = booster.feature_importance(importance_type="gain")
    feat_imp = {c: float(v) for c, v in zip(feature_cols, importance)}

    # ──────────────────────────────────────────────────────────────
    # 评估指标表（train / valid 对比）：便于训练完成后直接「拿到结果」
    # 含 AUC / 准确率 / 精确率 / 召回率 / F1 / 混淆矩阵。
    # 分类阈值：不平衡数据下固定 0.5 常导致零正类预测（概率被压在 0.5 以下），
    # 改为「训练集 Youden J 自适应阈值」（不用验证集，避免阈值泄漏）。
    # 注意：若某切分只有单一类别（标签被阈值筛成一类），AUC 无定义 → 记 None。
    # ──────────────────────────────────────────────────────────────
    cls_threshold = _best_cls_threshold(y[train_idx], train_pred)

    def _split_metrics(y_true: "np.ndarray", y_pred: "np.ndarray", thr: float) -> dict:
        y_true = y_true.astype(int)
        y_hat = (y_pred >= thr).astype(int)
        auc = None
        if len(np.unique(y_true)) > 1:
            auc = round(float(roc_auc_score(y_true, y_pred)), 4)
        tn, fp, fn, tp = confusion_matrix(y_true, y_hat, labels=[0, 1]).ravel()
        return {
            "auc": auc,
            "accuracy": round(float(accuracy_score(y_true, y_hat)), 4),
            "precision": round(float(precision_score(y_true, y_hat, zero_division=0)), 4),
            "recall": round(float(recall_score(y_true, y_hat, zero_division=0)), 4),
            "f1": round(float(f1_score(y_true, y_hat, zero_division=0)), 4),
            "confusion": [[int(tn), int(fp)], [int(fn), int(tp)]],
            "n": int(len(y_true)),
            # 正样本数与占比：诊断类不平衡 / 三段分布漂移
            "pos": int(y_true.sum()),
            "pos_ratio": round(float(y_true.mean()), 4) if len(y_true) else None,
        }

    # 训练/验证的实际时间范围（页面展示用；时间切分时 valid 严格晚于 train）
    dt_vals = data["dt"].to_numpy()

    def _date_range(idx: "np.ndarray") -> dict[str, str]:
        d = dt_vals[idx]
        return {
            "start": str(pd.Timestamp(d.min()).date()),
            "end": str(pd.Timestamp(d.max()).date()),
        }

    metrics_table = {
        "train": _split_metrics(y[train_idx], train_pred, cls_threshold),
        "valid": _split_metrics(y[valid_idx], valid_pred, cls_threshold),
        "cls_threshold": cls_threshold,
        "split_range": {"train": _date_range(train_idx), "valid": _date_range(valid_idx)},
        # 自动调参结果（未开启时为 None）。cv_auc 字段名保留兼容旧数据，
        # 实际含义是「cv_metric 指标下验证集最优得分」（logloss 越低越好）
        "tuned_params": tuned_params,
        "cv_auc": cv_auc,
        "cv_metric": tune_metric if tuned_params is not None else None,
        "cv_top": cv_top,
        # 退化标记（双 AUC≈0.5，模型未学到有效信号）
        "degenerate": degenerate,
        # 最终模型训练模式：true=并入验证集全量训练（验证集为样本内）
        "final_train_on_valid": refit_on_valid,
    }
    # 测试集（用户预留、不参与训练/调参）：仅最终评估，用于与验证集对比泛化漂移
    if len(test_idx):
        metrics_table["test"] = _split_metrics(y[test_idx], test_pred, cls_threshold)
        metrics_table["split_range"]["test"] = _date_range(test_idx)

    return {
        "booster": booster,
        "train_auc": round(train_auc, 4),
        "valid_auc": round(valid_auc, 4),
        "test_auc": round(test_auc, 4) if test_auc is not None else None,
        "n_train": int(len(train_idx)),
        "n_valid": int(len(valid_idx)),
        "n_final_train": int(len(final_idx)),
        "final_train_on_valid": refit_on_valid,
        "n_test": int(len(test_idx)),
        "feature_importance": feat_imp,
        "feature_cols": feature_cols,
        "metrics_table": metrics_table,
        "cls_threshold": cls_threshold,
    }


def booster_to_bytes(booster: Any) -> bytes:
    """把 LightGBM Booster 序列化到内存字节（用于上传 MinIO）。

    LightGBM 的 `Booster.save()` 只接受文件路径，内存序列化用 `model_to_string()`。
    """
    return booster.model_to_string().encode("utf-8")
