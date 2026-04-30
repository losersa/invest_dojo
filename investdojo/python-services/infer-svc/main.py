"""infer-svc · FastAPI 主入口

启动：uvicorn main:app --app-dir infer-svc --port 8003
"""
from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from common import create_app, get_logger, settings

from common_utils import (
    ErrorCode,
    InferenceRequest,
    Signal,
    api_error,
    parse_and_validate_as_of,
)
from mock_model import KNOWN_MOCK_MODELS, predict_one

logger = get_logger("infer-svc")

app = create_app(
    service_name="infer-svc",
    version="0.1.0",
    description="推理服务（MVP 用 mock 模型；Epic 3 接真实模型）",
)


@app.get("/", tags=["system"])
async def root() -> dict:
    return {
        "service": "infer-svc",
        "docs": "/docs",
        "health": "/health",
        "port": settings.infer_svc_port,
        "endpoints": [
            "POST /api/v1/inference/predict",
            "GET /api/v1/inference/models",
            "WS   /ws/v1/inference/stream (Epic 6 占位)",
        ],
        "status": "Epic 2 骨架 · mock 模型；真实模型见 Epic 3 T-3.03",
        "known_mock_models": list(KNOWN_MOCK_MODELS.keys()),
    }


# ──────────────────────────────────────────
# 业务路由
# ──────────────────────────────────────────
router = APIRouter(prefix="/api/v1/inference", tags=["inference"])


@router.get("/models", summary="列出可用的 mock 模型")
async def list_mock_models():
    data = [
        {"model_id": k, **v} for k, v in KNOWN_MOCK_MODELS.items()
    ]
    return {"data": data, "meta": {"source": "mock", "count": len(data)}}


@router.post("/predict", summary="请求响应推理")
async def predict(req: InferenceRequest):
    """单次推理（一个模型，一批股票）

    核心契约：
    - `as_of` 必填（防未来函数）
    - `as_of` 不能是未来时间（超出服务器当前时钟 60 秒即拒绝）
    - 同 (model_id, symbol, as_of) 组合 → 同输出（决定性）
    """
    # 1. 校验 as_of（防未来函数）
    parse_and_validate_as_of(req.as_of)

    # 2. 逐股推理
    overrides = req.feature_overrides or {}
    signals = []
    for sym in req.symbols:
        sig = predict_one(
            req.model_id,
            sym,
            req.as_of,
            include_explanation=req.include_explanation,
            feature_override=overrides.get(sym),
        )
        # pydantic 校验 + 规范化
        signals.append(Signal(**sig).model_dump(exclude_none=False))

    logger.info(
        "infer.predict",
        model_id=req.model_id,
        symbol_count=len(req.symbols),
        as_of=req.as_of,
        include_explanation=req.include_explanation,
    )

    return {
        "data": {"signals": signals},
        "meta": {
            "model_id": req.model_id,
            "model_version": req.model_version or "current",
            "as_of_applied": req.as_of,
            "count": len(signals),
        },
    }


# ──────────────────────────────────────────
# WebSocket 占位（Epic 6 T-6.03 完善）
# ──────────────────────────────────────────
@app.websocket("/ws/v1/inference/stream")
async def ws_stream(websocket: WebSocket):
    """流式推理占位

    MVP：连接建立 → 立即返回占位消息 → 等待客户端断开。
    Epic 6 会接入：订阅联动会话 `session_tick` → 每 tick 触发推理 → 推送 Signal。
    """
    await websocket.accept()
    await websocket.send_json({
        "type": "info",
        "code": "skeleton_only",
        "message": (
            "WebSocket stream is a skeleton (T-2.03). "
            "Real streaming inference will be implemented in Epic 6 (T-6.03). "
            "Use POST /api/v1/inference/predict for now."
        ),
    })
    try:
        # 消费客户端消息但不做实际工作
        while True:
            msg = await websocket.receive_text()
            await websocket.send_json({
                "type": "echo",
                "received": msg[:200],
                "note": "skeleton",
            })
    except WebSocketDisconnect:
        logger.info("infer.ws.disconnected")


app.include_router(router)
