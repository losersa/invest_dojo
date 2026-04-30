"""train-svc 专属工具：job_id 生成、状态流转、响应封装"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, Field

# ── 状态 ──
STATUS_PENDING = "pending"
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"

VALID_STATUSES = {
    STATUS_PENDING,
    STATUS_RUNNING,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_CANCELLED,
}

TERMINAL_STATUSES = {STATUS_COMPLETED, STATUS_FAILED, STATUS_CANCELLED}


class ErrorCode:
    INVALID_PARAM = "invalid_param"
    JOB_NOT_FOUND = "job_not_found"
    JOB_ALREADY_TERMINAL = "job_already_terminal"


def api_error(code: str, message: str, status: int = 400, **detail: Any) -> HTTPException:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if detail:
        body["error"]["detail"] = detail
    return HTTPException(status_code=status, detail=body)


def new_job_id() -> str:
    """生成短 job_id：`train_` + 12 位 base32 from uuid4"""
    raw = uuid.uuid4().hex[:12]
    return f"train_{raw}"


def utc_now_iso() -> str:
    """UTC now ISO 8601"""
    return datetime.now(UTC).isoformat()


# ── 请求/响应模型 ──
class TrainJobConfig(BaseModel):
    """训练任务配置（Epic 3 会大扩充）"""

    algorithm: str = Field(default="dummy", description="算法：dummy/lightgbm/xgboost")
    features: list[str] = Field(default_factory=list, description="使用的因子 ID 列表")
    target: str = Field(default="return_5d", description="预测目标")
    train_start: str | None = Field(default=None, description="训练开始日期")
    train_end: str | None = Field(default=None, description="训练结束日期")
    as_of: str | None = Field(default=None, description="防未来函数截断时间")
    # 额外参数（algorithm-specific）
    params: dict[str, Any] = Field(default_factory=dict)
    # dummy 任务专用
    simulated_duration_sec: int = Field(
        default=2, ge=0, le=60, description="dummy 任务模拟耗时（秒）"
    )


class TrainJobCreate(BaseModel):
    model_id: str | None = Field(default=None, description="模型 ID，留空自动生成")
    config: TrainJobConfig
