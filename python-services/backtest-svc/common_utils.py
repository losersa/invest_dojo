"""backtest-svc · pydantic 模型 + 工具"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator


# ──────────────────────────────────────────
# 错误码
# ──────────────────────────────────────────
class ErrorCode:
    INVALID_PARAM = "invalid_param"
    INVALID_STRATEGY = "invalid_strategy"
    BACKTEST_NOT_FOUND = "backtest_not_found"
    BACKTEST_FAST_MODE_TOO_LARGE = "backtest_fast_mode_too_large"


def api_error(code: str, message: str, status: int = 400, **detail: Any) -> HTTPException:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if detail:
        body["error"]["detail"] = detail
    return HTTPException(status_code=status, detail=body)


# ──────────────────────────────────────────
# 枚举
# ──────────────────────────────────────────
BacktestMode = Literal["fast", "realistic"]
StrategyType = Literal["factor", "composite", "model", "signal_file"]
BacktestStatus = Literal["pending", "running", "completed", "failed", "cancelled"]


# ──────────────────────────────────────────
# 配置
# ──────────────────────────────────────────
class StrategySpec(BaseModel):
    """策略来源（四选一）"""

    type: StrategyType
    factor_id: str | None = None
    composite_id: str | None = None
    model_id: str | None = None
    model_version: str | None = None
    signal_file_id: str | None = None

    @field_validator("type", mode="before")
    @classmethod
    def _check_type_lowercase(cls, v):
        if isinstance(v, str):
            return v.lower()
        return v

    def required_field(self) -> str:
        """返回 type 对应的必填字段名"""
        return {
            "factor": "factor_id",
            "composite": "composite_id",
            "model": "model_id",
            "signal_file": "signal_file_id",
        }[self.type]


class TradeRules(BaseModel):
    commission_rate: float = 0.0003
    stamp_tax: float = 0.001
    slippage: float = 0.0005
    min_commission: float = 5.0
    t_plus_1: bool = True
    allow_limit_order: bool = False


class PositionSizing(BaseModel):
    method: Literal["equal_weight", "signal_weight", "fixed_amount", "custom"] = "equal_weight"
    max_positions: int = Field(default=10, ge=1, le=100)
    single_stock_pct: float = Field(default=0.1, gt=0, le=1)
    rebalance_frequency: Literal["daily", "weekly", "monthly", "signal_triggered"] = "daily"


class AdvancedOptions(BaseModel):
    include_feature_importance: bool = False
    include_trade_log: bool = False
    include_daily_positions: bool = False


class BacktestConfig(BaseModel):
    mode: BacktestMode = "fast"
    strategy: StrategySpec
    start: str = Field(..., description="开始日期 YYYY-MM-DD")
    end: str = Field(..., description="结束日期 YYYY-MM-DD")
    universe: str | list[str] = Field(default="hs300")
    initial_capital: float = Field(default=100000.0, gt=0)
    rules: TradeRules | None = None
    position_sizing: PositionSizing | None = None
    benchmark: str = Field(default="000300")
    advanced: AdvancedOptions | None = None

    @field_validator("start", "end")
    @classmethod
    def _check_date_format(cls, v: str) -> str:
        try:
            datetime.strptime(v[:10], "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError(f"Invalid date format: {v!r}, expected YYYY-MM-DD") from exc
        return v[:10]


class QuickFactorRequest(BaseModel):
    factor_id: str = Field(..., min_length=1)
    start: str
    end: str
    universe: str | list[str] = "hs300"
    benchmark: str = "000300"


# ──────────────────────────────────────────
# 结果 schema
# ──────────────────────────────────────────
class BacktestSummary(BaseModel):
    total_return: float
    annual_return: float
    benchmark_return: float
    excess_return: float
    sharpe: float
    sortino: float
    calmar: float
    max_drawdown: float
    max_drawdown_period: tuple[str, str]
    volatility: float
    win_rate: float
    profit_loss_ratio: float
    turnover_rate: float
    total_trades: int
    ic: float | None = None
    ir: float | None = None


class EquityCurve(BaseModel):
    dates: list[str]
    portfolio: list[float]
    benchmark: list[float]
    drawdown: list[float]
    cash: list[float]
    positions_count: list[int]


class FeatureImportance(BaseModel):
    feature: str
    importance: float
    shap_abs_mean: float


class Trade(BaseModel):
    id: str
    symbol: str
    side: Literal["BUY", "SELL"]
    datetime: str
    price: float
    quantity: int
    amount: float
    commission: float
    reason: str | None = None
    pnl: float | None = None
