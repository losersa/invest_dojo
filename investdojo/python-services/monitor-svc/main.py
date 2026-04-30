"""monitor-svc 主入口"""

from common import create_app, get_logger, settings

logger = get_logger("monitor-svc")

app = create_app(
    service_name="monitor-svc",
    version="0.1.0",
    description="监控服务（对应 docs/architecture/03_量化模块.md §8）",
)


@app.get("/", tags=["system"])
async def root() -> dict:
    return {
        "service": "monitor-svc",
        "message": "骨架就位。具体接口见 Epic 8（T-8.03）。",
        "docs": "/docs",
        "health": "/health",
        "port": settings.monitor_svc_port,
    }
