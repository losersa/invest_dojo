"""DSL 已知函数注册表 + lookback 推断规则。

单独拎出来是为了：
1. T-3.02 计算引擎直接消费这张表
2. 未来要加新函数只改这一处
3. 语义校验阶段用它查未知函数
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FunctionSpec:
    """DSL 函数规格说明"""

    name: str
    # 参数个数（min, max）。max=None 表示不限
    arity: tuple[int, int]
    # 输出类型（推断用）
    output_type: str  # "scalar" / "boolean"
    # lookback 推断：从哪个位置的参数读窗口期；None = 不贡献 lookback
    lookback_from_arg: int | None = None
    # 默认 lookback（当函数有隐含窗口但参数未显式指定时，如 MACD）
    default_lookback: int = 0
    # 是否是中缀用法（cross_up / cross_down 允许 `a cross_up b`）
    infix: bool = False
    # 描述
    desc: str = ""


# ── 内置字段（可在 DSL 里裸写 close / high / volume ... ）────
BUILTIN_FIELDS: frozenset[str] = frozenset(
    {
        "open",
        "high",
        "low",
        "close",
        "volume",
        "turnover",
        "amount",
        "preclose",
        "pct_change",
    }
)


# ── 函数注册表 ─────────────────────────────────────────────
# 参考 docs/api/02_因子库API.md §11
_FUNCTIONS: dict[str, FunctionSpec] = {
    # 均值/标准差
    "MA": FunctionSpec("MA", (2, 2), "scalar", lookback_from_arg=1, desc="简单移动平均"),
    "EMA": FunctionSpec("EMA", (2, 2), "scalar", lookback_from_arg=1, desc="指数移动平均"),
    "STD": FunctionSpec("STD", (2, 2), "scalar", lookback_from_arg=1, desc="滚动标准差"),
    # 极值
    "MAX": FunctionSpec("MAX", (2, 2), "scalar", lookback_from_arg=1, desc="滚动最大值"),
    "MIN": FunctionSpec("MIN", (2, 2), "scalar", lookback_from_arg=1, desc="滚动最小值"),
    "ARGMAX": FunctionSpec(
        "ARGMAX", (2, 2), "scalar", lookback_from_arg=1, desc="滚动最大值的位置"
    ),
    # 变化
    "DIFF": FunctionSpec("DIFF", (2, 2), "scalar", lookback_from_arg=1, desc="差分"),
    "PCT": FunctionSpec("PCT", (2, 2), "scalar", lookback_from_arg=1, desc="涨跌幅"),
    "RANK": FunctionSpec("RANK", (1, 1), "scalar", desc="横截面排名"),
    # 逻辑（函数形式）
    "cross_up": FunctionSpec(
        "cross_up", (2, 2), "boolean", default_lookback=2, infix=True, desc="a 上穿 b"
    ),
    "cross_down": FunctionSpec(
        "cross_down", (2, 2), "boolean", default_lookback=2, infix=True, desc="a 下穿 b"
    ),
    # 技术指标快捷函数（lookback 经验值）
    "RSI": FunctionSpec("RSI", (1, 1), "scalar", lookback_from_arg=0, desc="相对强弱指数"),
    "MACD": FunctionSpec("MACD", (0, 0), "scalar", default_lookback=26, desc="MACD"),
    "BOLL": FunctionSpec("BOLL", (2, 2), "scalar", lookback_from_arg=1, desc="布林带"),
    "KDJ": FunctionSpec("KDJ", (0, 1), "scalar", default_lookback=9, desc="KDJ"),
}


# ── 二元/一元运算符 ──────────────────────────────────────
# op -> (优先级, output_type)   优先级越大越紧密
OPERATORS: dict[str, tuple[int, str]] = {
    "OR": (1, "boolean"),
    "AND": (2, "boolean"),
    "==": (3, "boolean"),
    "!=": (3, "boolean"),
    "<": (4, "boolean"),
    ">": (4, "boolean"),
    "<=": (4, "boolean"),
    ">=": (4, "boolean"),
    "cross_up": (4, "boolean"),
    "cross_down": (4, "boolean"),
    "+": (5, "scalar"),
    "-": (5, "scalar"),
    "*": (6, "scalar"),
    "/": (6, "scalar"),
}

UNARY_OPERATORS: frozenset[str] = frozenset({"NOT", "-"})


def lookup_function(name: str) -> FunctionSpec | None:
    """查找函数，大小写敏感（DSL 规定：大写函数名 MA/EMA，小写 cross_up/cross_down）"""

    return _FUNCTIONS.get(name)


def is_builtin_field(name: str) -> bool:
    return name in BUILTIN_FIELDS


def known_functions() -> list[str]:
    """给错误提示用：列出所有已知函数"""

    return sorted(_FUNCTIONS.keys())
