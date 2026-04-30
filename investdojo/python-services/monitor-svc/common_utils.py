"""monitor-svc 工具：聚合各 svc /health/ready + DB 业务计数"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

import httpx

from common import (
    get_logger,
    get_supabase_client,
    redis_health_check,
    settings,
)
from common.minio_client import minio_health_check

logger = get_logger(__name__)


# ──────────────────────────────────────────
# 服务注册表（MVP 硬编码，Epic 5 改成服务发现）
# ──────────────────────────────────────────
@dataclass(frozen=True)
class ServiceEntry:
    name: str
    url: str
    port: int
    role: str  # 简要说明


def get_registered_services() -> list[ServiceEntry]:
    """返回所有兄弟微服务。URL 从 settings.*_svc_port 推导。"""
    host = "http://localhost"
    return [
        ServiceEntry(name="data-svc", url=f"{host}:{settings.data_svc_port}",
                     port=settings.data_svc_port, role="数据 API"),
        ServiceEntry(name="feature-svc", url=f"{host}:{settings.feature_svc_port}",
                     port=settings.feature_svc_port, role="因子库 / 因子计算"),
        ServiceEntry(name="train-svc", url=f"{host}:{settings.train_svc_port}",
                     port=settings.train_svc_port, role="训练任务"),
        ServiceEntry(name="infer-svc", url=f"{host}:{settings.infer_svc_port}",
                     port=settings.infer_svc_port, role="推理"),
        ServiceEntry(name="backtest-svc", url=f"{host}:{settings.backtest_svc_port}",
                     port=settings.backtest_svc_port, role="回测"),
    ]


# ──────────────────────────────────────────
# 单服务健康检查
# ──────────────────────────────────────────
async def _probe_one(client: httpx.AsyncClient, svc: ServiceEntry) -> dict[str, Any]:
    """打一个 svc 的 /health，超时 2s"""
    t = time.perf_counter()
    try:
        resp = await client.get(f"{svc.url}/health", timeout=2.0)
        latency_ms = int((time.perf_counter() - t) * 1000)
        body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
        return {
            "name": svc.name,
            "url": svc.url,
            "port": svc.port,
            "role": svc.role,
            "status": "ok" if resp.status_code == 200 else "down",
            "status_code": resp.status_code,
            "latency_ms": latency_ms,
            "version": body.get("version"),
            "env": body.get("env"),
        }
    except httpx.ConnectError:
        return {
            "name": svc.name,
            "url": svc.url,
            "port": svc.port,
            "role": svc.role,
            "status": "down",
            "error": "connect_refused",
            "latency_ms": int((time.perf_counter() - t) * 1000),
        }
    except httpx.TimeoutException:
        return {
            "name": svc.name,
            "url": svc.url,
            "port": svc.port,
            "role": svc.role,
            "status": "timeout",
            "error": "health_timeout",
            "latency_ms": int((time.perf_counter() - t) * 1000),
        }
    except Exception as e:  # noqa: BLE001
        return {
            "name": svc.name,
            "url": svc.url,
            "port": svc.port,
            "role": svc.role,
            "status": "error",
            "error": type(e).__name__,
            "message": str(e)[:200],
            "latency_ms": int((time.perf_counter() - t) * 1000),
        }


async def probe_all_services() -> list[dict[str, Any]]:
    """并发打所有 svc health"""
    services = get_registered_services()
    async with httpx.AsyncClient() as client:
        tasks = [_probe_one(client, s) for s in services]
        return await asyncio.gather(*tasks)


# ──────────────────────────────────────────
# 基础设施健康
# ──────────────────────────────────────────
async def probe_infra() -> dict[str, Any]:
    """检查 Redis / MinIO / Supabase"""
    loop = asyncio.get_event_loop()
    redis_ok, minio_ok, supabase_ok = await asyncio.gather(
        loop.run_in_executor(None, redis_health_check),
        loop.run_in_executor(None, minio_health_check),
        loop.run_in_executor(None, lambda: get_supabase_client().health_check()),
    )
    return {
        "redis": {"status": "ok" if redis_ok else "down"},
        "minio": {"status": "ok" if minio_ok else "down"},
        "supabase": {"status": "ok" if supabase_ok else "down"},
    }


# ──────────────────────────────────────────
# 业务指标（SQL count）
# ──────────────────────────────────────────
async def collect_stats() -> dict[str, Any]:
    """收集各表的实时 count（用 PostgREST HEAD + count=exact）"""
    client = get_supabase_client()
    loop = asyncio.get_event_loop()

    async def _count(table: str, filters: dict | None = None) -> int:
        try:
            return await loop.run_in_executor(
                None, lambda: client.count(table, filters=filters)
            )
        except Exception as e:
            logger.warning("monitor.count_failed", table=table, error=str(e))
            return -1

    # 并行查所有
    keys_and_calls = [
        ("symbols", _count("symbols")),
        ("industries", _count("industries")),
        ("scenarios", _count("scenarios")),
        ("news", _count("news")),
        ("market_snapshots", _count("market_snapshots")),
        ("factor_definitions", _count("factor_definitions",
                                       {"visibility": "eq.public",
                                        "deprecated_at": "is.null"})),
        ("training_jobs_total", _count("training_jobs")),
        ("training_jobs_running", _count("training_jobs", {"status": "eq.running"})),
        ("training_jobs_completed", _count("training_jobs", {"status": "eq.completed"})),
        ("backtests_total", _count("backtests")),
        ("backtests_completed", _count("backtests", {"status": "eq.completed"})),
        ("fundamentals", _count("fundamentals")),
    ]

    results = await asyncio.gather(*[c for _, c in keys_and_calls])
    return {k: v for (k, _), v in zip(keys_and_calls, results)}


# ──────────────────────────────────────────
# 摘要（overview 专用）
# ──────────────────────────────────────────
def summarize_status(
    infra: dict[str, Any],
    services: list[dict[str, Any]],
) -> dict[str, Any]:
    infra_down = [k for k, v in infra.items() if v.get("status") != "ok"]
    svc_down = [s["name"] for s in services if s.get("status") != "ok"]

    if infra_down:
        overall = "degraded" if len(infra_down) < len(infra) else "down"
    elif svc_down:
        overall = "degraded"
    else:
        overall = "ok"

    return {
        "overall": overall,
        "infra_down": infra_down,
        "services_down": svc_down,
        "services_total": len(services),
        "services_ok": sum(1 for s in services if s.get("status") == "ok"),
    }
