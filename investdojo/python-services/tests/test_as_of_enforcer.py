"""AsOf Enforcer · 防未来函数的契约测试

⚠️ 关键测试：这些测试保证防未来函数的红线不被破坏。
Epic 6 (T-6.04) 真正实现 DataClientProxy 时，测试会扩展。
现在先保证基础契约。
"""

from datetime import UTC, datetime

import pytest

from common.as_of_enforcer import (
    AsOfContext,
    FutureLeakError,
    check_no_future_leak,
)


def test_as_of_context_parse_iso():
    """as_of 支持多种 ISO 格式"""
    ctx = AsOfContext(as_of="2024-01-02T15:00:00Z")
    dt = ctx.parse_as_of()
    assert dt.year == 2024
    assert dt.month == 1
    assert dt.day == 2


def test_as_of_context_parse_date_only():
    """纯日期也能解析"""
    ctx = AsOfContext(as_of="2024-01-02")
    dt = ctx.parse_as_of()
    assert dt.year == 2024
    assert dt.hour == 0


def test_no_leak_when_requested_before_as_of():
    """请求过去时间，不应抛异常"""
    ctx = AsOfContext(as_of="2024-01-10T00:00:00Z")
    check_no_future_leak(ctx, "2024-01-05T00:00:00Z")
    check_no_future_leak(ctx, "2024-01-09T23:59:59Z")


def test_future_leak_detected_when_equal():
    """严格小于：请求 == as_of 也算未来（防时钟精度歧义）"""
    ctx = AsOfContext(as_of="2024-01-10T00:00:00Z")
    with pytest.raises(FutureLeakError) as exc_info:
        check_no_future_leak(ctx, "2024-01-10T00:00:00Z")
    assert exc_info.value.as_of == "2024-01-10T00:00:00Z"


def test_future_leak_detected_when_greater():
    """请求 > as_of 必须抛异常"""
    ctx = AsOfContext(as_of="2024-01-10T00:00:00Z")
    with pytest.raises(FutureLeakError):
        check_no_future_leak(ctx, "2024-01-15T00:00:00Z")


def test_future_leak_error_carries_context():
    """异常应携带足够的调试信息"""
    ctx = AsOfContext(as_of="2024-01-10T00:00:00Z")
    try:
        check_no_future_leak(
            ctx,
            "2024-02-15T00:00:00Z",
            where="klines_all:600519",
        )
        pytest.fail("应抛出 FutureLeakError")
    except FutureLeakError as e:
        assert "2024-01-10" in str(e)
        assert "2024-02-15" in str(e)
        assert "klines_all:600519" in str(e)


def test_datetime_input_supported():
    """直接传 datetime 对象也能工作"""
    ctx = AsOfContext(as_of="2024-01-10T00:00:00Z")
    dt = datetime(2024, 1, 5, tzinfo=UTC)
    check_no_future_leak(ctx, dt)  # 不应抛

    dt_future = datetime(2024, 2, 1, tzinfo=UTC)
    with pytest.raises(FutureLeakError):
        check_no_future_leak(ctx, dt_future)


def test_non_strict_mode_does_not_raise():
    """宽松模式不抛异常（用于仅日志告警场景）"""
    ctx = AsOfContext(as_of="2024-01-10T00:00:00Z", strict=False)
    # 不应抛，即使访问未来
    check_no_future_leak(ctx, "2024-02-15T00:00:00Z")


def test_session_id_carried():
    """AsOfContext 可以携带 session_id"""
    ctx = AsOfContext(
        as_of="2024-01-10T00:00:00Z",
        session_id="sess_abc",
    )
    assert ctx.session_id == "sess_abc"
