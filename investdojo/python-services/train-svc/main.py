"""train-svc 主入口"""

from common import create_app, get_logger, settings

logger = get_logger("train-svc")

app = create_app(
    service_name="train-svc",
    version="0.1.0",
    description="模型训练服务（对应 docs/api/03_模型API.md §4）",
)


@app.get("/", tags=["system"])
async def root() -> dict:
    return {
        "service": "train-svc",
        "message": "骨架就位。具体接口见 Epic 4（T-4.01 起）。",
        "docs": "/docs",
        "health": "/health",
        "port": settings.train_svc_port,
    }
