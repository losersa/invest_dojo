"""infer-svc 工具：pydantic 模型、as_of 校验、错误响应"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator


# ──────────────────────────────────────────
# 错误码
# ──────────────────────────────────────────
class ErrorCode:
    INVALID_PARAM = "invalid_param"
    MISSING_AS_OF = "missing_as_of"
    FUTURE_AS_OF = "future_as_of"
    MODEL_NOT_FOUND = "model_not_found"
    TOO_MANY_SYMBOLS = "too_many_symbols"


def api_error(code: str, message: str, status: int = 400, **detail: Any) -> HTTPException:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if detail:
        body["error"]["detail"] = detail
    return HTTPException(status_code=status, detail=body)


# ──────────────────────────────────────────
# 请求模型
# ──────────────────────────────────────────
class InferenceRequest(BaseModel):
    """单次推理请求（对应 docs/api/05_推理API.md §2.2）"""

    model_id: str = Field(..., min_length=1, description="模型 ID（MVP 用 'mock_*' 占位）")
    model_version: str | None = Field(default=None, description="版本，不填用当前版本")
    symbols: list[str] = Field(..., min_length=1, max_length=50, description="股票代码（1-50）")
    as_of: str = Field(
        ...,
        description="ISO 8601 时间戳，防未来函数必填。示例 '2024-03-15T15:00:00Z'",
    )
    include_explanation: bool = Field(default=False)
    feature_overrides: dict[str, dict[str, float]] | None = Field(
        default=None,
        description="自定义特征值（用于测试/回测）。格式：{symbol: {feature: value}}",
    )

    @field_validator("symbols")
    @classmethod
    def _dedupe_symbols(cls, v: list[str]) -> list[str]:
        seen: set[str] = set()
        uniq = []
        for s in v:
            s = s.strip()
            if s and s not in seen:
                seen.add(s)
                uniq.append(s)
        if not uniq:
            raise ValueError("symbols cannot be empty")
        return uniq


class EnsembleSubModel(BaseModel):
    model_id: str
    weight: float = Field(ge=0, le=1)


class EnsembleRequest(BaseModel):
    """集成推理"""

    models: list[EnsembleSubModel] = Field(..., min_length=2, max_length=10)
    symbols: list[str] = Field(..., min_length=1, max_length=50)
    as_of: str
    aggregation: Literal["weighted_avg", "majority_vote", "max_confidence"] = "weighted_avg"


# ──────────────────────────────────────────
# 响应模型（Signal）
# ──────────────────────────────────────────
class SignalExplanation(BaseModel):
    top_positive_factors: list[dict[str, Any]] = Field(default_factory=list)
    top_negative_factors: list[dict[str, Any]] = Field(default_factory=list)
    thesis: str | None = None


class SignalMetadata(BaseModel):
    model_id: str
    model_version: str
    inference_time_ms: int
    seed: int | None = None


class Signal(BaseModel):
    """统一信号格式（对应 docs/api/05_推理API.md §2.1）"""

    timestamp: str
    as_of: str
    symbol: str
    action: Literal["BUY", "SELL", "HOLD"]
    confidence: float = Field(ge=0, le=1)

    score: float | None = None
    target_position: float | None = Field(default=None, ge=0, le=1)
    holding_horizon_days: int | None = None

    features: dict[str, float] = Field(default_factory=dict)
    explanation: SignalExplanation | None = None
    metadata: SignalMetadata


# ──────────────────────────────────────────
# as_of 校验（防未来函数）
# ──────────────────────────────────────────
def parse_and_validate_as_of(as_of: str) -> datetime:
    """把 as_of 字符串解析成 UTC datetime 并校验不能是未来时间

    Raises:
        HTTPException 400 MISSING_AS_OF: 空
        HTTPException 400 INVALID_PARAM: 格式错
        HTTPException 403 FUTURE_AS_OF: 未来时间
    """
    if not as_of or not as_of.strip():
        raise api_error(
            ErrorCode.MISSING_AS_OF,
            "as_of is required for future-leak prevention",
        )

    s = as_of.strip()
    try:
        if "T" not in s:
            s = f"{s}T00:00:00+00:00"
        elif not (s.endswith("Z") or "+" in s[-6:] or "-" in s[10:]):
            s += "+00:00"
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
    except Exception as exc:
        raise api_error(
            ErrorCode.INVALID_PARAM,
            f"Invalid as_of format: {as_of!r}. Expected ISO 8601.",
        ) from exc

    now = datetime.now(UTC)
    # 允许宽 60 秒 clock skew（联动时钟可能稍领先）
    if dt > now.replace(second=0, microsecond=0):
        # 严格一点：as_of 不能领先当前墙钟超过 60 秒
        delta = (dt - now).total_seconds()
        if delta > 60:
            raise api_error(
                ErrorCode.FUTURE_AS_OF,
                f"as_of is in the future (by {int(delta)}s). Possible future leak.",
                status=403,
                as_of=as_of,
                server_now=now.isoformat(),
            )

    return dt
