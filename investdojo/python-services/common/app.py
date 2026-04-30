"""统一的 FastAPI 服务底座

每个服务 main.py 通过 `create_app(service_name, ...)` 构造 app，
自动包含：
- /health 健康检查
- /metrics Prometheus 指标
- /docs OpenAPI 文档
- 统一的 CORS / 日志中间件
- 启动/关闭钩子
"""

from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from common.config import settings
from common.logging import get_logger, setup_logging
from common.minio_client import minio_health_check
from common.redis_client import async_redis_health_check
from common.supabase_client import get_supabase_client

logger = get_logger(__name__)

# ── Prometheus 指标 ──
REQUEST_COUNT = Counter(
    "investdojo_request_total",
    "HTTP 请求总数",
    ["service", "method", "endpoint", "status"],
)
REQUEST_LATENCY = Histogram(
    "investdojo_request_duration_seconds",
    "HTTP 请求耗时",
    ["service", "method", "endpoint"],
)


class LoggingMiddleware(BaseHTTPMiddleware):
    """记录每个请求"""

    def __init__(self, app: Any, service_name: str):
        super().__init__(app)
        self.service_name = service_name

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        import time

        start = time.perf_counter()

        try:
            response = await call_next(request)
            duration = time.perf_counter() - start

            REQUEST_COUNT.labels(
                service=self.service_name,
                method=request.method,
                endpoint=request.url.path,
                status=response.status_code,
            ).inc()
            REQUEST_LATENCY.labels(
                service=self.service_name,
                method=request.method,
                endpoint=request.url.path,
            ).observe(duration)

            # 记录慢请求
            if duration > 1.0:
                logger.warning(
                    "http.slow",
                    service=self.service_name,
                    method=request.method,
                    path=request.url.path,
                    duration_ms=int(duration * 1000),
                    status=response.status_code,
                )

            return response
        except Exception as e:
            logger.exception(
                "http.error",
                service=self.service_name,
                method=request.method,
                path=request.url.path,
                error=str(e),
            )
            raise


def create_app(
    service_name: str,
    *,
    version: str = "0.1.0",
    description: str = "",
    on_startup: list[Callable] | None = None,
    on_shutdown: list[Callable] | None = None,
) -> FastAPI:
    """工厂函数：构造带默认中间件的 FastAPI 应用"""

    # 初始化日志
    setup_logging()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        """启动/关闭钩子"""
        logger.info("service.startup", service=service_name, version=version, env=settings.env)

        for fn in on_startup or []:
            try:
                result = fn()
                if hasattr(result, "__await__"):
                    await result
            except Exception:
                logger.exception("service.startup.hook_failed", hook=fn.__name__)

        yield

        logger.info("service.shutdown", service=service_name)

        for fn in on_shutdown or []:
            try:
                result = fn()
                if hasattr(result, "__await__"):
                    await result
            except Exception:
                logger.exception("service.shutdown.hook_failed", hook=fn.__name__)

    app = FastAPI(
        title=f"InvestDojo · {service_name}",
        version=version,
        description=description or f"{service_name} microservice",
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
    )

    # 中间件
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"] if not settings.is_production else ["https://investdojo.com"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(LoggingMiddleware, service_name=service_name)

    # ── 健康检查 ──
    @app.get("/health", tags=["system"])
    async def health() -> dict[str, Any]:
        """基础健康检查（liveness）"""
        return {
            "status": "ok",
            "service": service_name,
            "version": version,
            "env": settings.env,
        }

    @app.get("/health/ready", tags=["system"])
    async def ready() -> JSONResponse:
        """就绪检查（readiness）- 验证所有依赖可用"""
        checks = {
            "redis": await async_redis_health_check(),
            "minio": minio_health_check(),
            "supabase": get_supabase_client().health_check(),
        }
        all_ok = all(checks.values())
        status_code = 200 if all_ok else 503
        return JSONResponse(
            status_code=status_code,
            content={
                "status": "ready" if all_ok else "not_ready",
                "service": service_name,
                "checks": checks,
            },
        )

    # ── Prometheus 指标 ──
    @app.get("/metrics", tags=["system"], include_in_schema=False)
    async def metrics() -> Response:
        return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)

    return app
