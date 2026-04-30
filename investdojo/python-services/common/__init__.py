"""InvestDojo 共享库

提供配置、日志、客户端、FastAPI 底座、as_of enforcer 等基础设施。
所有 Python 微服务都应该从这里导入。
"""

from common.app import create_app
from common.as_of_enforcer import (
    AsOfContext,
    DataClientProxy,
    FutureLeakError,
    check_no_future_leak,
)
from common.config import settings
from common.logging import get_logger, setup_logging
from common.minio_client import get_minio, minio_health_check
from common.redis_client import (
    RedisChannel,
    RedisKey,
    async_redis_health_check,
    get_async_redis,
    get_redis,
    redis_health_check,
)
from common.supabase_client import SupabaseClient, get_supabase_client

__all__ = [
    # config
    "settings",
    # logging
    "get_logger",
    "setup_logging",
    # supabase
    "SupabaseClient",
    "get_supabase_client",
    # redis
    "RedisKey",
    "RedisChannel",
    "get_redis",
    "get_async_redis",
    "redis_health_check",
    "async_redis_health_check",
    # minio
    "get_minio",
    "minio_health_check",
    # app
    "create_app",
    # as_of enforcer
    "AsOfContext",
    "DataClientProxy",
    "FutureLeakError",
    "check_no_future_leak",
]
