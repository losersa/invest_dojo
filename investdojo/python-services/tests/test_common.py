"""common 库基础测试"""

import pytest

from common import (
    RedisChannel,
    RedisKey,
    create_app,
    get_logger,
    get_supabase_client,
    settings,
)


def test_settings_loaded():
    """配置能正常加载"""
    assert settings.env == "development"
    assert settings.supabase_url.startswith("https://")
    assert 8001 <= settings.feature_svc_port <= 8005


def test_logger():
    """logger 能正常获取"""
    logger = get_logger("test")
    assert logger is not None
    # 确保能调用不报错
    logger.info("test.message", foo="bar")


def test_redis_key_naming():
    """Redis key 命名约定"""
    assert RedisKey.factor_stats("ma_cross_20_60") == "factor:stats:ma_cross_20_60"
    assert RedisKey.model_meta("model_abc") == "model:model_abc:meta"
    assert RedisKey.session_state("sess_xyz") == "session:sess_xyz:state"


def test_redis_channel_naming():
    """Redis Pub/Sub 频道约定"""
    assert RedisChannel.FACTOR_UPDATED == "factor:updated"
    assert RedisChannel.session_tick("sess_1") == "session:sess_1:tick"


def test_create_app():
    """create_app 能正常工作"""
    app = create_app("test-svc", version="0.0.1")
    assert app.title == "InvestDojo · test-svc"
    assert app.version == "0.0.1"

    # 验证路由已注册
    paths = [route.path for route in app.routes]
    assert "/health" in paths
    assert "/health/ready" in paths
    assert "/metrics" in paths


@pytest.mark.integration
def test_supabase_client_healthy():
    """Supabase 连接正常（需真实网络）"""
    client = get_supabase_client()
    assert client.health_check() is True
