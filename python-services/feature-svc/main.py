"""feature-svc 主入口

启动：uvicorn main:app --app-dir feature-svc --port 8001

职责：
- 因子库元数据管理（CRUD）
- 因子值查询（历史触发序列）
- 因子计算任务调度（Epic 3 完善）
- 因子组合 / 对比评估（Epic 3 完善）

对应文档：docs/api/02_因子库API.md
"""

from routers import factors_router

from common import create_app, get_logger, settings

logger = get_logger("feature-svc")

app = create_app(
    service_name="feature-svc",
    version="0.1.0",
    description="因子计算与因子库服务（对应 docs/api/02_因子库API.md）",
)


@app.get("/", tags=["system"])
async def root() -> dict:
    return {
        "service": "feature-svc",
        "docs": "/docs",
        "health": "/health",
        "port": settings.feature_svc_port,
        "endpoints": [
            "/api/v1/factors",
            "/api/v1/factors/categories",
            "/api/v1/factors/tags",
            "/api/v1/factors/validate",
            "/api/v1/factors/{id}",
            "/api/v1/factors/{id}/history",
        ],
        "status": "Epic 3 · T-3.01 DSL 解析器已就位；计算引擎见 T-3.02",
    }


app.include_router(factors_router, prefix="/api/v1", tags=["factors"])
