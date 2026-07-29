"""train-svc 专属工具：job_id 生成、状态流转、响应封装"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

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
    """训练任务配置（Epic 4 大扩充）"""

    # extra="allow"：保留未显式声明的扩展字段（历史配置向后兼容），
    # 否则 model_dump() 会静默丢弃 target_symbol/peer 等，导致「预测单只」失效。
    model_config = ConfigDict(extra="allow")

    algorithm: str = Field(default="dummy", description="算法：dummy/lightgbm/xgboost")
    features: list[str] = Field(default_factory=list, description="使用的因子 ID 列表")
    target: str = Field(default="return_5d", description="预测目标")
    train_start: str | None = Field(default=None, description="训练开始日期")
    train_end: str | None = Field(default=None, description="训练结束日期（训练窗口上界；其后的测试集不参与训练）")
    # 预留测试集（用户手里的「未来数据」）：不参与训练/调参，仅最终评估，
    # 用于与验证集效果对比泛化漂移。dt 落在 [test_start, test_end] 的样本即为测试集。
    test_start: str | None = Field(default=None, description="预留测试集开始日期")
    test_end: str | None = Field(default=None, description="预留测试集结束日期")
    # 最终模型训练模式：false=只在 train 上训练（验证集保留为干净评估、损失约 20% 数据）；
    # true=在 train+valid 上全量训练（用更多数据，但验证集变为样本内、仅测试集可作泛化锚点）。
    refit_on_valid: bool = Field(default=False, description="最终模型是否并入验证集全量训练")
    as_of: str | None = Field(default=None, description="防未来函数截断时间")
    symbols: list[str] | None = Field(
        default=None, description="限定训练股票池；不传则自动取样（防止全表扫描）"
    )
    model_name: str | None = Field(default=None, description="模型展示名（不传自动生成唯一名）")
    # 多股票输入预测单只：指定「预测哪一只」；NULL=全市场面板各自预测
    target_symbol: str | None = Field(default=None, description="预测目标股票代码")
    # 同板块横截面特征配置（rank/relative/sector_mean）
    peer: dict[str, Any] | None = Field(default=None, description="同板块横截面特征配置")
    # 模型归属：user_id（用主键 id）或 'platform'；由 API 层按 X-User-Id 注入
    owner: str | None = Field(default=None, description="模型归属 owner（用户主键 id 或 platform）")
    visibility: str | None = Field(default=None, description="模型可见性 public/private")
    # 额外参数（algorithm-specific）
    params: dict[str, Any] = Field(default_factory=dict)
    # dummy 任务专用
    simulated_duration_sec: int = Field(
        default=2, ge=0, le=60, description="dummy 任务模拟耗时（秒）"
    )


class TrainJobCreate(BaseModel):
    model_id: str | None = Field(default=None, description="模型 ID，留空自动生成")
    config: TrainJobConfig
