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
# 按来源分三组：
#   K 线字段（日频行情）：open/high/low/close/volume/turnover/amount/preclose/pct_change
#   基本面字段（季频，用 announce_date 前向填充为日频）：eps_ttm, roe, ...
#   衍生字段（K 线 + 基本面组合）：pe_ttm, pb, market_cap, total_mv
BUILTIN_FIELDS: frozenset[str] = frozenset(
    {
        # K 线
        "open",
        "high",
        "low",
        "close",
        "volume",
        "turnover",
        "amount",
        "preclose",
        "pct_change",
        # 基本面（BaoStock 财报 JSONB 展平，季度比率/指标）
        # profit 表
        "eps_ttm",  # 滚动 EPS
        "roe",  # 平均 ROE
        "gp_margin",  # 毛利率
        "np_margin",  # 净利率
        "net_profit",  # 净利润（元）
        "total_share",  # 总股本
        "liqa_share",  # 流通 A 股
        "revenue",  # 主营收入（MBRevenue）
        # growth 表（同比）
        "yoy_ni",  # 净利润同比
        "yoy_pni",  # 归母净利润同比
        "yoy_asset",  # 总资产同比
        "yoy_equity",  # 净资产同比
        "yoy_eps",  # EPS 同比
        # balance 表
        "cash_ratio",
        "quick_ratio",
        "current_ratio",
        "yoy_liability",
        "asset_to_equity",
        "debt_asset_ratio",  # liabilityToAsset
        # cashflow 表
        "cfo_to_gr",  # 经营现金流 / 营业收入
        "cfo_to_np",  # 经营现金流 / 净利润
        "cfo_to_or",  # 经营现金流 / 营业收入
        "ca_to_asset",  # 流动资产占比
        "nca_to_asset",  # 非流动资产占比
        # operation 表
        "asset_turn_ratio",
        "ca_turn_ratio",
        "inv_turn_days",
        "nr_turn_days",
        # 衍生（由 panel_loader 算出）
        "market_cap",  # close * total_share（总市值）
        "pe_ttm",  # close / eps_ttm（市盈率 TTM）
        "pb",  # 衍生市净率（需要 BPS，这里用 close/eps_ttm×margin 近似 —— 下一版本再完善）
    }
)


# 基本面字段 → fundamentals.data 的 JSONB key 映射
# 用于 panel_loader 展平
FUNDAMENTAL_FIELD_MAP: dict[str, tuple[str, str]] = {
    # (DSL 字段, (statement, data 里的 key))
    "eps_ttm": ("profit", "epsTTM"),
    "roe": ("profit", "roeAvg"),
    "gp_margin": ("profit", "gpMargin"),
    "np_margin": ("profit", "npMargin"),
    "net_profit": ("profit", "netProfit"),
    "total_share": ("profit", "totalShare"),
    "liqa_share": ("profit", "liqaShare"),
    "revenue": ("profit", "MBRevenue"),
    "yoy_ni": ("growth", "YOYNI"),
    "yoy_pni": ("growth", "YOYPNI"),
    "yoy_asset": ("growth", "YOYAsset"),
    "yoy_equity": ("growth", "YOYEquity"),
    "yoy_eps": ("growth", "YOYEPSBasic"),
    "cash_ratio": ("balance", "cashRatio"),
    "quick_ratio": ("balance", "quickRatio"),
    "current_ratio": ("balance", "currentRatio"),
    "yoy_liability": ("balance", "YOYLiability"),
    "asset_to_equity": ("balance", "assetToEquity"),
    "debt_asset_ratio": ("balance", "liabilityToAsset"),
    "cfo_to_gr": ("cashflow", "CFOToGr"),
    "cfo_to_np": ("cashflow", "CFOToNP"),
    "cfo_to_or": ("cashflow", "CFOToOR"),
    "ca_to_asset": ("cashflow", "CAToAsset"),
    "nca_to_asset": ("cashflow", "NCAToAsset"),
    "asset_turn_ratio": ("operation", "AssetTurnRatio"),
    "ca_turn_ratio": ("operation", "CATurnRatio"),
    "inv_turn_days": ("operation", "INVTurnDays"),
    "nr_turn_days": ("operation", "NRTurnDays"),
}


# 衍生字段（由 panel_loader 基于 K 线 + 基本面推算）
DERIVED_FIELDS: frozenset[str] = frozenset(
    {
        "market_cap",  # = close × total_share
        "pe_ttm",  # = close × total_share / (eps_ttm × total_share) = close / eps_ttm
        "pb",  # = close × total_share / 净资产（近似）
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
