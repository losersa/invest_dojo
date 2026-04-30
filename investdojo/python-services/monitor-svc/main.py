"""monitor-svc · FastAPI 主入口

启动：uvicorn main:app --app-dir monitor-svc --port 8005

接口：
- GET /api/v1/monitor/overview · 系统总览
- GET /api/v1/monitor/services · 各 svc 健康
- GET /api/v1/monitor/stats · 业务指标
- GET /api/v1/monitor/ping · 自身快速探活
- GET /metrics · Prometheus（common 自动挂）
"""

from __future__ import annotations

import time
from datetime import UTC, datetime

from common_utils import (
    collect_stats,
    probe_all_services,
    probe_infra,
    summarize_status,
)
from fastapi import APIRouter

from common import create_app, get_logger, settings

logger = get_logger("monitor-svc")

app = create_app(
    service_name="monitor-svc",
    version="0.1.0",
    description="监控聚合服务（Prometheus /metrics + 业务总览 API）",
)


@app.get("/", tags=["system"])
async def root() -> dict:
    return {
        "service": "monitor-svc",
        "docs": "/docs",
        "metrics": "/metrics",
        "port": settings.monitor_svc_port,
        "endpoints": [
            "GET /api/v1/monitor/ping",
            "GET /api/v1/monitor/overview",
            "GET /api/v1/monitor/services",
            "GET /api/v1/monitor/stats",
            "GET /metrics (Prometheus)",
        ],
        "status": "Epic 2 骨架 · 聚合 5 个兄弟 svc + 3 个基础设施 + 业务计数；Grafana 接入见 Epic 5",
    }


router = APIRouter(prefix="/api/v1/monitor", tags=["monitor"])


@router.get("/ping", summary="快速探活")
async def ping() -> dict:
    """零外部依赖的探活接口。用于 LB/K8s 的 liveness probe。"""
    return {
        "ok": True,
        "service": "monitor-svc",
        "timestamp": datetime.now(UTC).isoformat(),
    }


@router.get("/services", summary="各 svc 健康检查聚合")
async def services():
    """并发打 data/feature/train/infer/backtest 的 /health"""
    t = time.perf_counter()
    probed = await probe_all_services()
    elapsed = int((time.perf_counter() - t) * 1000)
    return {
        "data": probed,
        "meta": {
            "total": len(probed),
            "ok": sum(1 for s in probed if s.get("status") == "ok"),
            "probe_elapsed_ms": elapsed,
        },
    }


@router.get("/stats", summary="业务指标（DB 实时 count）")
async def stats():
    t = time.perf_counter()
    counts = await collect_stats()
    elapsed = int((time.perf_counter() - t) * 1000)
    return {
        "data": counts,
        "meta": {
            "source": "supabase.postgrest.count_exact",
            "elapsed_ms": elapsed,
            "timestamp": datetime.now(UTC).isoformat(),
        },
    }


@router.get("/overview", summary="系统总览（一锅端）")
async def overview():
    """并发取 infra + services + stats，一次性返回所有重要指标"""
    t = time.perf_counter()
    import asyncio

    infra_task = asyncio.create_task(probe_infra())
    services_task = asyncio.create_task(probe_all_services())
    stats_task = asyncio.create_task(collect_stats())

    infra, services_list, stats_data = await asyncio.gather(infra_task, services_task, stats_task)
    elapsed = int((time.perf_counter() - t) * 1000)

    summary = summarize_status(infra, services_list)

    return {
        "data": {
            "summary": summary,
            "infrastructure": infra,
            "services": services_list,
            "stats": stats_data,
        },
        "meta": {
            "elapsed_ms": elapsed,
            "timestamp": datetime.now(UTC).isoformat(),
            "monitor_svc_port": settings.monitor_svc_port,
        },
    }


app.include_router(router)
