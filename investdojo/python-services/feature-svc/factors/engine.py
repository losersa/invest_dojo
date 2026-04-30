"""因子计算引擎（T-3.02）

输入：
- AST（由 T-3.01 dsl_parser.parse_formula 产生）
- Panel：dict[str, DataFrame]，字段名 → DataFrame(index=date, columns=symbols)
  常见字段：open / high / low / close / volume / amount / turnover / preclose / pct_change

输出：
- DataFrame(index=date, columns=symbols) —— 因子值，shape 跟输入对齐
- 对于 RANK 等横截面算子，结果是每个截面上的排名（0~1 的百分位）

两种调用模式：
- batch：eval_ast(ast, panel)         —— 返回整张结果表
- instant：eval_instant(ast, panel)   —— 返回最后一行（Series），用于单股单日

设计决策：
1. 所有函数都是向量化的，**不允许 Python for-loop 遍历样本**
2. NaN 传播：rolling(n) 前 n-1 行是 NaN，直接透传给下游（pandas 语义）
3. bool 结果用 pandas BooleanDtype 或原生 bool（boolean AST 输出）
4. 窗口期参数是 AST 里的 NumberLit，直接用 int(node.value)
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np
import pandas as pd

from .ast_nodes import BinOp, Call, FieldRef, Node, UnaryOp
from .dsl_parser import DSLError
from .registry import BUILTIN_FIELDS, lookup_function

# ═══════════════════════════════════════════════════════════════
#   Panel 类型
# ═══════════════════════════════════════════════════════════════

# Panel = 字段 → DataFrame(index=date, columns=symbols)
Panel = dict[str, pd.DataFrame]


class EngineError(DSLError):
    """计算期错误（数据缺字段、类型不兼容等）"""

    code = "COMPUTE_ERROR"


# 值类型：Series 或 DataFrame 或标量
Value = pd.DataFrame | pd.Series | float | int | bool


# ═══════════════════════════════════════════════════════════════
#   函数实现（每个 DSL 函数 → 一个 pandas 函数）
# ═══════════════════════════════════════════════════════════════
#
# 约定：
# - 第一个参数通常是 DataFrame（被滚动的 series）
# - 窗口参数是 int
# - 所有函数都保持 shape 对齐（index=date, columns=symbols）


def _as_df(x: Value) -> pd.DataFrame:
    """保证入参是 DataFrame（标量会被广播，但窗口函数不允许对标量滚）"""

    if isinstance(x, pd.DataFrame):
        return x
    if isinstance(x, pd.Series):
        return x.to_frame()
    raise EngineError(f"Expected time-series, got {type(x).__name__}")


def _as_int(x: Value) -> int:
    """把 AST 里的数字字面量转成 int（窗口期）"""

    if isinstance(x, int | float):
        return int(x)
    if isinstance(x, pd.DataFrame | pd.Series):
        # 极端情况：窗口是表达式结果（少见），取唯一值
        vals = x.values.flatten() if hasattr(x, "values") else []
        if len(vals) and np.allclose(vals, vals[0]):
            return int(vals[0])
    raise EngineError(f"Expected integer window, got {type(x).__name__}")


# ── 均值 / 标准差 ──
def fn_ma(series: Value, period: Value) -> pd.DataFrame:
    return _as_df(series).rolling(window=_as_int(period), min_periods=_as_int(period)).mean()


def fn_ema(series: Value, period: Value) -> pd.DataFrame:
    n = _as_int(period)
    # EMA 的 adjust=False 更符合 "逐日迭代" 的经典语义（TA-Lib/通达信）
    return _as_df(series).ewm(span=n, adjust=False, min_periods=n).mean()


def fn_std(series: Value, period: Value) -> pd.DataFrame:
    n = _as_int(period)
    return _as_df(series).rolling(window=n, min_periods=n).std()


# ── 极值 ──
def fn_max(series: Value, period: Value) -> pd.DataFrame:
    n = _as_int(period)
    return _as_df(series).rolling(window=n, min_periods=n).max()


def fn_min(series: Value, period: Value) -> pd.DataFrame:
    n = _as_int(period)
    return _as_df(series).rolling(window=n, min_periods=n).min()


def fn_argmax(series: Value, period: Value) -> pd.DataFrame:
    """滚动最大值的位置（距离当前多少根）"""
    n = _as_int(period)
    return (
        _as_df(series)
        .rolling(window=n, min_periods=n)
        .apply(lambda w: len(w) - 1 - int(np.argmax(w.values)), raw=False)
    )


# ── 变化 ──
def fn_diff(series: Value, period: Value) -> pd.DataFrame:
    return _as_df(series).diff(periods=_as_int(period))


def fn_pct(series: Value, period: Value) -> pd.DataFrame:
    return _as_df(series).pct_change(periods=_as_int(period), fill_method=None)


# ── 横截面 ──
def fn_rank(series: Value) -> pd.DataFrame:
    """横截面百分位排名（0~1，1=最高）"""
    df = _as_df(series)
    # axis=1 按行（截面）排，pct=True 返回百分位
    return df.rank(axis=1, pct=True)


# ── 逻辑 ──
def fn_cross_up(a: Value, b: Value) -> pd.DataFrame:
    """a 从下方上穿 b：今天 a>b 且昨天 a<=b"""
    df_a, df_b = _broadcast(a, b)
    prev_below = df_a.shift(1) <= df_b.shift(1)
    now_above = df_a > df_b
    return prev_below & now_above


def fn_cross_down(a: Value, b: Value) -> pd.DataFrame:
    df_a, df_b = _broadcast(a, b)
    prev_above = df_a.shift(1) >= df_b.shift(1)
    now_below = df_a < df_b
    return prev_above & now_below


# ── 技术指标快捷 ──
def fn_rsi(period: Value) -> pd.DataFrame:
    """RSI 需要在 eval 层面注入 close，这里通过闭包变通（见 _build_env）"""
    raise EngineError("RSI 必须由引擎注入 close，请走 _call() 调度")


def _rsi_impl(close: pd.DataFrame, period: int) -> pd.DataFrame:
    """RSI(close, period)"""
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi


def _macd_impl(
    close: pd.DataFrame, fast: int = 12, slow: int = 26, signal: int = 9
) -> pd.DataFrame:
    """MACD 柱（DIF - DEA）"""
    ema_fast = close.ewm(span=fast, adjust=False, min_periods=fast).mean()
    ema_slow = close.ewm(span=slow, adjust=False, min_periods=slow).mean()
    dif = ema_fast - ema_slow
    dea = dif.ewm(span=signal, adjust=False, min_periods=signal).mean()
    return (dif - dea) * 2  # MACD 柱


def _boll_impl(close: pd.DataFrame, period: int, k: float = 2.0) -> pd.DataFrame:
    """BOLL 上下轨宽度"""
    ma = close.rolling(window=period, min_periods=period).mean()
    std = close.rolling(window=period, min_periods=period).std()
    upper = ma + k * std
    lower = ma - k * std
    return upper - lower


def _kdj_impl(
    high: pd.DataFrame, low: pd.DataFrame, close: pd.DataFrame, period: int = 9
) -> pd.DataFrame:
    """KDJ 的 K 值"""
    low_min = low.rolling(window=period, min_periods=period).min()
    high_max = high.rolling(window=period, min_periods=period).max()
    rsv = (close - low_min) / (high_max - low_min).replace(0, np.nan) * 100
    # K 是 RSV 的 3 日 EMA
    return rsv.ewm(alpha=1 / 3, adjust=False, min_periods=period).mean()


# ═══════════════════════════════════════════════════════════════
#   辅助：广播对齐
# ═══════════════════════════════════════════════════════════════


def _broadcast(a: Value, b: Value) -> tuple[pd.DataFrame, pd.DataFrame]:
    """把两个值对齐成相同 shape 的 DataFrame（标量广播）"""

    if isinstance(a, pd.DataFrame) and isinstance(b, pd.DataFrame):
        return a.align(b, join="outer")
    if isinstance(a, pd.DataFrame):
        # 标量 → 同 shape
        return a, pd.DataFrame(b, index=a.index, columns=a.columns)
    if isinstance(b, pd.DataFrame):
        return pd.DataFrame(a, index=b.index, columns=b.columns), b
    # 都是标量（罕见）
    return pd.DataFrame([[a]]), pd.DataFrame([[b]])


# ═══════════════════════════════════════════════════════════════
#   函数调度表
# ═══════════════════════════════════════════════════════════════

# 普通函数（签名：args → result）
SIMPLE_FUNCTIONS: dict[str, Callable[..., Value]] = {
    "MA": fn_ma,
    "EMA": fn_ema,
    "STD": fn_std,
    "MAX": fn_max,
    "MIN": fn_min,
    "ARGMAX": fn_argmax,
    "DIFF": fn_diff,
    "PCT": fn_pct,
    "RANK": fn_rank,
    "cross_up": fn_cross_up,
    "cross_down": fn_cross_down,
}


# ═══════════════════════════════════════════════════════════════
#   核心：AST 求值
# ═══════════════════════════════════════════════════════════════


class Engine:
    """因子计算引擎。

    Usage:
        engine = Engine(panel={"close": close_df, "volume": vol_df, ...})
        result = engine.eval(ast)         # batch 模式
        latest = engine.eval_instant(ast) # 最新一行
    """

    def __init__(self, panel: Panel) -> None:
        self.panel = panel

    def eval(self, ast: Node) -> Value:
        """batch 计算：返回完整的 DataFrame"""
        return self._eval(ast)

    def eval_instant(self, ast: Node) -> pd.Series:
        """即时计算：返回最新一行 Series(symbol → value)"""
        result = self._eval(ast)
        if isinstance(result, pd.DataFrame):
            return result.iloc[-1]
        if isinstance(result, pd.Series):
            return result
        # 标量
        return pd.Series({"_scalar_": result})

    # ── 内部递归 ──
    def _eval(self, node: Node) -> Value:
        kind = node.type

        if kind == "number":
            return float(node.value)

        if kind == "bool":
            return bool(node.value)

        if kind == "field":
            return self._resolve_field(node)

        if kind == "call":
            return self._call(node)

        if kind == "unary":
            return self._unary(node)

        if kind == "binop":
            return self._binop(node)

        raise EngineError(f"Unknown AST node type: {kind}", pos=getattr(node, "pos", 0))

    # ── 解字段 ──
    def _resolve_field(self, node: FieldRef) -> pd.DataFrame:
        if node.name not in BUILTIN_FIELDS:
            raise EngineError(f"Unknown field: {node.name!r}", pos=node.pos)
        if node.name not in self.panel:
            raise EngineError(
                f"Field {node.name!r} not in panel (available: {sorted(self.panel.keys())})",
                pos=node.pos,
            )
        return self.panel[node.name]

    # ── 函数调用 ──
    def _call(self, node: Call) -> Value:
        name = node.name
        args = [self._eval(a) for a in node.args]

        # 特殊处理：技术指标快捷函数需要从 panel 取 close/high/low
        if name == "RSI":
            period = _as_int(args[0])
            return _rsi_impl(self._require_field("close"), period)

        if name == "MACD":
            return _macd_impl(self._require_field("close"))

        if name == "BOLL":
            # BOLL(series, period) → 上下轨宽度
            series = args[0]
            period = _as_int(args[1])
            return _boll_impl(_as_df(series), period)

        if name == "KDJ":
            period = _as_int(args[0]) if args else 9
            return _kdj_impl(
                self._require_field("high"),
                self._require_field("low"),
                self._require_field("close"),
                period,
            )

        fn = SIMPLE_FUNCTIONS.get(name)
        if fn is None:
            spec = lookup_function(name)
            if spec is None:
                raise EngineError(f"Unknown function: {name}", pos=node.pos)
            raise EngineError(f"Function {name!r} not yet implemented in engine", pos=node.pos)

        return fn(*args)

    def _require_field(self, name: str) -> pd.DataFrame:
        if name not in self.panel:
            raise EngineError(f"Panel missing required field {name!r}")
        return self.panel[name]

    # ── 一元 ──
    def _unary(self, node: UnaryOp) -> Value:
        v = self._eval(node.operand)
        if node.op == "-":
            return -v if not isinstance(v, bool) else -int(v)
        if node.op == "NOT":
            if isinstance(v, pd.DataFrame | pd.Series):
                return ~v.astype(bool)
            return not v
        raise EngineError(f"Unknown unary operator: {node.op}", pos=node.pos)

    # ── 二元 ──
    def _binop(self, node: BinOp) -> Value:
        op = node.op
        # 注意求值顺序：两边都先算出来
        a = self._eval(node.left)
        b = self._eval(node.right)

        # 中缀形式的 cross_up / cross_down 走和函数一样的实现
        if op == "cross_up":
            return fn_cross_up(a, b)
        if op == "cross_down":
            return fn_cross_down(a, b)

        # 算术
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op == "/":
            # pandas 除法自动处理 / 0 → inf/nan
            return a / b

        # 比较
        if op == "==":
            return a == b
        if op == "!=":
            return a != b
        if op == ">":
            return a > b
        if op == "<":
            return a < b
        if op == ">=":
            return a >= b
        if op == "<=":
            return a <= b

        # 逻辑（注意：pandas 用 & | ~，不是 and or not）
        if op == "AND":
            return _logical_and(a, b)
        if op == "OR":
            return _logical_or(a, b)

        raise EngineError(f"Unknown binary operator: {op}", pos=node.pos)


def _logical_and(a: Value, b: Value) -> Value:
    if isinstance(a, pd.DataFrame | pd.Series) or isinstance(b, pd.DataFrame | pd.Series):
        return (a.astype(bool) if hasattr(a, "astype") else bool(a)) & (
            b.astype(bool) if hasattr(b, "astype") else bool(b)
        )
    return bool(a) and bool(b)


def _logical_or(a: Value, b: Value) -> Value:
    if isinstance(a, pd.DataFrame | pd.Series) or isinstance(b, pd.DataFrame | pd.Series):
        return (a.astype(bool) if hasattr(a, "astype") else bool(a)) | (
            b.astype(bool) if hasattr(b, "astype") else bool(b)
        )
    return bool(a) or bool(b)


# ═══════════════════════════════════════════════════════════════
#   公共入口
# ═══════════════════════════════════════════════════════════════


def eval_ast(ast: Node, panel: Panel) -> Value:
    """批量模式：AST + 面板 → 结果 DataFrame"""
    return Engine(panel).eval(ast)


def eval_instant(ast: Node, panel: Panel) -> pd.Series:
    """即时模式：返回最新一行"""
    return Engine(panel).eval_instant(ast)
