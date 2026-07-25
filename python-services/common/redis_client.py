"""Redis 客户端（同步 + 异步）"""

import redis
import redis.asyncio as aioredis

from common.config import settings
from common.logging import get_logger

logger = get_logger(__name__)

_sync_client: redis.Redis | None = None
_async_client: aioredis.Redis | None = None


def get_redis() -> redis.Redis:
    """同步 Redis 客户端"""
    global _sync_client
    if _sync_client is None:
        _sync_client = redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=5,
        )
        logger.info("redis.sync.connected", url=settings.redis_url)
    return _sync_client


async def get_async_redis() -> aioredis.Redis:
    """异步 Redis 客户端（用于 FastAPI）"""
    global _async_client
    if _async_client is None:
        _async_client = aioredis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=5,
        )
        logger.info("redis.async.connected", url=settings.redis_url)
    return _async_client


def redis_health_check() -> bool:
    """Redis 健康检查"""
    try:
        return bool(get_redis().ping())
    except Exception as e:
        logger.warning("redis.health_check.failed", error=str(e))
        return False


async def async_redis_health_check() -> bool:
    """异步 Redis 健康检查"""
    try:
        client = await get_async_redis()
        return bool(await client.ping())
    except Exception as e:
        logger.warning("redis.async.health_check.failed", error=str(e))
        return False


# 通用命名规范（参考 architecture/01_数据层 §8.1）
class RedisKey:
    """Redis key 命名规范集中管理"""

    @staticmethod
    def factor_stats(factor_id: str) -> str:
        return f"factor:stats:{factor_id}"

    @staticmethod
    def feature_latest(symbol: str, factor_id: str) -> str:
        return f"feature:{symbol}:{factor_id}:latest"

    @staticmethod
    def model_meta(model_id: str) -> str:
        return f"model:{model_id}:meta"

    @staticmethod
    def session_state(session_id: str) -> str:
        return f"session:{session_id}:state"

    @staticmethod
    def session_events_queue(session_id: str) -> str:
        return f"session:{session_id}:events:queue"

    @staticmethod
    def infer_signal(model_id: str, symbol: str, as_of: str) -> str:
        return f"infer:signal:{model_id}:{symbol}:{as_of}"

    @staticmethod
    def rate_limit(user_id: str, bucket: str, window: str) -> str:
        return f"ratelimit:{user_id}:{bucket}:{window}"


# Pub/Sub 频道
class RedisChannel:
    FACTOR_UPDATED = "factor:updated"
    MODEL_STATUS = "model:status"

    @staticmethod
    def session_tick(session_id: str) -> str:
        return f"session:{session_id}:tick"
