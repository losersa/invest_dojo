"""AsOf Enforcer · 防未来函数核心组件

确保任何参与者在 `current_ts = T` 时，都绝对不能看到 `dt > T` 的数据。

这个模块是 InvestDojo 最核心的"红线"，违反这条红线就是实验失效。

【当前状态】
占位实现（骨架），Epic 6（T-6.04）会真正实现 DataClientProxy。
现在只保证：
- 接口稳定
- CI 能跑基础契约测试

对应文档：
- docs/architecture/04_联动机制.md §8
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any


class FutureLeakError(RuntimeError):
    """试图访问未来数据时抛出"""

    def __init__(self, as_of: str, requested_dt: str, context: str = ""):
        self.as_of = as_of
        self.requested_dt = requested_dt
        self.context = context
        super().__init__(
            f"Future leak detected: requested dt={requested_dt} > as_of={as_of}"
            + (f" (context: {context})" if context else "")
        )


@dataclass
class AsOfContext:
    """当前会话的 as_of 上下文

    所有数据查询必须绑定一个 AsOfContext，
    AsOfEnforcer 会强制 params['as_of'] = context.as_of。
    """

    as_of: str  # ISO 8601 时间戳
    session_id: str | None = None  # 关联的会话（若在联动模式中）
    strict: bool = True  # True = 严格模式，违反直接抛异常

    def parse_as_of(self) -> datetime:
        """解析 as_of 为 datetime"""
        # 兼容 "2024-01-02T15:00:00Z" / "2024-01-02" 两种格式
        s = self.as_of
        if "T" not in s:
            s = f"{s}T00:00:00+00:00"
        elif not (s.endswith("Z") or "+" in s[-6:]):
            s += "+00:00"
        return datetime.fromisoformat(s.replace("Z", "+00:00"))


def check_no_future_leak(
    context: AsOfContext,
    requested_dt: str | datetime,
    *,
    where: str = "",
) -> None:
    """校验请求的时间戳 < context.as_of

    Args:
        context: 当前 as_of 上下文
        requested_dt: 试图访问的时间戳
        where: 上下文描述（哪个调用、哪张表）

    Raises:
        FutureLeakError: 当 requested_dt >= context.as_of 时
    """
    if isinstance(requested_dt, str):
        requested_str = requested_dt
        # 同样容错处理
        s = requested_dt
        if "T" not in s:
            s = f"{s}T00:00:00+00:00"
        elif not (s.endswith("Z") or "+" in s[-6:]):
            s += "+00:00"
        req_dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    else:
        requested_str = requested_dt.isoformat()
        req_dt = requested_dt
        if req_dt.tzinfo is None:
            from datetime import UTC

            req_dt = req_dt.replace(tzinfo=UTC)

    as_of_dt = context.parse_as_of()

    # 严格小于（详见架构 04 §8.3）
    if req_dt >= as_of_dt:
        if context.strict:
            raise FutureLeakError(
                as_of=context.as_of,
                requested_dt=requested_str,
                context=where,
            )


# ─── 占位：未来 Epic 6 (T-6.04) 的完整实现 ───


class DataClientProxy:
    """数据客户端的 as_of 强制注入代理（占位）

    TODO (T-6.04)：
    - 包装 SupabaseClient 的所有查询方法
    - 自动在 filters 里加入 as_of 约束
    - 拦截绕过 as_of 的调用
    """

    def __init__(self, underlying: Any, context: AsOfContext):
        self.underlying = underlying
        self.context = context

    def __getattr__(self, name: str) -> Any:
        # 骨架：直接透传（真正的 Enforcer 会拦截）
        return getattr(self.underlying, name)
