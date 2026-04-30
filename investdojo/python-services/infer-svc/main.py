"""infer-svc 主入口"""

from common import create_app, get_logger, settings

logger = get_logger("infer-svc")

app = create_app(
    service_name="infer-svc",
    version="0.1.0",
    description="推理服务 · 批量/单次/流式（对应 docs/api/05_推理API.md）",
)


@app.get("/", tags=["system"])
async def root() -> dict:
    return {
        "service": "infer-svc",
        "message": "骨架就位。具体接口见 Epic 6（T-6.05 起）。",
        "docs": "/docs",
        "health": "/health",
        "port": settings.infer_svc_port,
    }
