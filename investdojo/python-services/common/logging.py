"""结构化日志

开发环境用彩色 pretty 输出，生产环境用 JSON。
所有服务通过 `get_logger(__name__)` 获取 logger。
"""

import logging
import sys

import structlog

from common.config import settings


def setup_logging() -> None:
    """初始化结构化日志"""

    # 基础 logging 配置
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
    )

    # 降低第三方库的噪音
    for noisy in ("httpx", "urllib3", "asyncio", "watchfiles"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    # 共享处理器
    shared_processors: list = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    # 根据环境选择渲染器
    if settings.log_format == "json" or settings.is_production:
        shared_processors.append(structlog.processors.JSONRenderer())
    else:
        shared_processors.append(structlog.dev.ConsoleRenderer(colors=True))

    structlog.configure(
        processors=shared_processors,
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, settings.log_level.upper(), logging.INFO)
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """获取 logger 实例"""
    return structlog.get_logger(name or "investdojo")
