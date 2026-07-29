"""backtest-svc · FastAPI 主入口

启动：uvicorn main:app --app-dir backtest-svc --port 8004
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from common_utils import (
    BacktestConfig,
    ErrorCode,
    QuickFactorRequest,
    StrategySpec,
    api_error,
)
from fastapi import APIRouter, Query
from mock_engine import new_backtest_id, run_mock_backtest

from common import create_app, get_logger, get_pg_client, settings

logger = get_logger("backtest-svc")

app = create_app(
    service_name="backtest-svc",
    version="0.1.0",
    description="回测服务（model / factor / composite / signal_file 均接真实引擎）",
)


# ──────────────────────────────────────────
# 估算耗时（fast 模式 30s 上限）
# ──────────────────────────────────────────
def _estimate_seconds(config: BacktestConfig) -> int:
    """粗略估算回测耗时（秒）：
    - universe 股票数 * 时间跨度天数 / 100
    """
    # 股票数
    universe = config.universe
    if isinstance(universe, list):
        stock_count = len(universe)
    else:
        stock_count = {"hs300": 300, "zz500": 500, "zz1000": 1000, "all": 4500}.get(universe, 300)

    # 时间跨度
    try:
        s = datetime.strptime(config.start, "%Y-%m-%d").date()
        e = datetime.strptime(config.end, "%Y-%m-%d").date()
        days = (e - s).days
    except Exception:
        days = 365

    est = max(1, stock_count * days // 2500)  # 2500 = 每秒估算数量
    return est


def _validate_strategy(strategy: StrategySpec) -> None:
    """strategy.type 对应字段必须非空"""
    field = strategy.required_field()
    val = getattr(strategy, field)
    if not val:
        raise api_error(
            ErrorCode.INVALID_STRATEGY,
            f"strategy.{field} is required when strategy.type='{strategy.type}'",
        )


@app.get("/", tags=["system"])
async def root() -> dict:
    return {
        "service": "backtest-svc",
        "docs": "/docs",
        "health": "/health",
        "port": settings.backtest_svc_port,
        "endpoints": [
            "POST /api/v1/backtests (异步提交，轮询 GET /{id})",
            "POST /api/v1/backtests/run-fast",
            "POST /api/v1/backtests/quick-factor",
            "GET  /api/v1/backtests/{id}",
            "GET  /api/v1/backtests",
        ],
        "status": "model 类型接真实回测引擎（复用训练特征工程 + 模型预测）",
    }


# ──────────────────────────────────────────
# 业务路由
# ──────────────────────────────────────────
router = APIRouter(prefix="/api/v1/backtests", tags=["backtests"])


@router.post("", summary="创建回测（异步，提交到任务队列，需轮询 GET /{id}）")
async def create_backtest(config: BacktestConfig):
    """提交异步回测任务，立即返回 {id, status}。

    任意 mode / strategy 类型都走异步：strategy.type=='model' 走真实引擎，
    其余走 mock。前端轮询 GET /api/v1/backtests/{id} 取进度与结果。
    """
    _validate_strategy(config.strategy)
    bt_id = new_backtest_id()
    now = datetime.now(UTC).isoformat()
    config_dict = config.model_dump()
    client = get_pg_client()
    client.insert(
        "backtests",
        {
            "id": bt_id,
            "model_id": config.strategy.model_id if config.strategy.type == "model" else None,
            "user_id": None,
            "mode": config.mode,
            "status": "pending",
            "config": config_dict,
            "created_at": now,
        },
    )
    # 提交到 Celery 的 backtest 队列（懒导入，避免服务启动时强制连 broker）
    from common.celery_app import celery_app as _celery

    _celery.send_task("backtest.run_backtest", args=[bt_id, config_dict])
    return {
        "data": {"id": bt_id, "status": "pending"},
        "meta": {
            "engine": "real" if config.strategy.type == "model" else "real_xsec",
            "poll_url": f"/api/v1/backtests/{bt_id}",
        },
    }


@router.post("/run-fast", summary="快速回测（同步，mock）")
async def run_fast(config: BacktestConfig):
    """立即返回结果（fast 模式，预估 < 30s）"""
    # fast 模式校验
    if config.mode != "fast":
        raise api_error(
            ErrorCode.INVALID_PARAM,
            f"run-fast only accepts mode='fast', got {config.mode!r}. "
            "Use POST /api/v1/backtests for realistic mode.",
        )

    _validate_strategy(config.strategy)

    # 预估耗时
    est = _estimate_seconds(config)
    if est > 30:
        raise api_error(
            ErrorCode.BACKTEST_FAST_MODE_TOO_LARGE,
            "Estimated duration > 30s, please use async API",
            status=413,
            estimated_seconds=est,
            suggested_endpoint="POST /api/v1/backtests",
        )

    # 跑引擎：所有类型统一走真实引擎（model 走模型预测 + 资金模拟；
    # factor/composite/signal_file 走横截面打分 + 组合模拟）。
    config_dict = config.model_dump()
    try:
        from real_engine import run_real_backtest

        # 真实引擎需复现训练特征工程 / 拉因子 / 模拟，耗时数十秒，
        # 放进线程池避免阻塞 event loop（run-fast 是同步接口）。
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, run_real_backtest, config_dict)
    except ValueError as e:
        raise api_error(ErrorCode.INVALID_PARAM, str(e))

    bt_id = new_backtest_id()
    now = datetime.now(UTC).isoformat()

    # 写库（落到 backtests 表）
    # 注意：model_id 有 FK 到 models 表，MVP 阶段 mock 模型未入库，
    # 所以 model_id 统一存 null；真实策略的 model_id 已保存在 config.strategy.model_id
    client = get_pg_client()
    try:
        client.insert(
            "backtests",
            {
                "id": bt_id,
                # 直接调用训练好的模型：strategy.type="model" 时带上训练产出的 model_id
                "model_id": (
                    config.strategy.model_id
                    if config.strategy.type == "model"
                    else None
                ),
                "user_id": None,  # Epic 7 接入 Auth 后补
                "mode": config.mode,
                "status": "completed",
                "config": config_dict,
                "summary": result["summary"],
                "equity_curve": result["equity_curve"],
                "segment_performance": result.get("segment_performance"),
                "feature_importance": result.get("feature_importance"),
                "duration_ms": result["duration_ms"],
                "completed_at": now,
            },
        )
    except Exception as e:
        logger.warning("backtest.insert_failed", id=bt_id, error=str(e))

    logger.info(
        "backtest.run_fast.completed",
        id=bt_id,
        strategy_type=config.strategy.type,
        total_return=result["summary"]["total_return"],
        sharpe=result["summary"]["sharpe"],
    )

    return {
        "data": {
            "id": bt_id,
            "status": "completed",
            "config": config_dict,
            "summary": result["summary"],
            "equity_curve": result["equity_curve"],
            "segment_performance": result.get("segment_performance"),
            "feature_importance": result.get("feature_importance"),
            "trades": result.get("trades"),
            "duration_ms": result["duration_ms"],
            "created_at": now,
            "completed_at": now,
        },
        "meta": {
            "estimated_seconds": est,
            "seed": result.get("_seed", 0),
            "engine": result.get("meta", {}).get("engine", "mock"),
            **(
                {k: v for k, v in result.get("meta", {}).items() if k != "engine"}
                if isinstance(result.get("meta"), dict)
                else {}
            ),
        },
    }


@router.post("/quick-factor", summary="快速测试单因子（mock，不落库）")
async def quick_factor(req: QuickFactorRequest):
    """快速评估单个因子表现，不保存结果"""
    # 构造 config 复用 mock 引擎
    config = BacktestConfig(
        mode="fast",
        strategy=StrategySpec(type="factor", factor_id=req.factor_id),
        start=req.start,
        end=req.end,
        universe=req.universe,
        benchmark=req.benchmark,
    )
    result = run_mock_backtest(config.model_dump())

    return {
        "data": {
            "status": "completed",
            "factor_id": req.factor_id,
            "summary": result["summary"],
            "equity_curve": result["equity_curve"],
            "duration_ms": result["duration_ms"],
        },
        "meta": {"engine": "mock", "persisted": False, "seed": result["_seed"]},
    }


@router.get("", summary="回测历史列表")
async def list_backtests(
    status: str | None = Query(None, description="过滤状态"),
    user_id: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    filters: dict[str, str] = {}
    if status:
        filters["status"] = f"eq.{status}"
    if user_id:
        filters["user_id"] = f"eq.{user_id}"

    client = get_pg_client()
    total = client.count("backtests", filters=filters)
    offset = (page - 1) * page_size
    rows = client.select(
        "backtests",
        columns="id,user_id,model_id,config,mode,status,summary,duration_ms,"
        "created_at,completed_at",
        filters=filters,
        order="created_at.desc",
        limit=page_size,
        offset=offset,
    )
    total_pages = (total + page_size - 1) // page_size if total > 0 else 0
    return {
        "data": rows,
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": total_pages,
            "has_next": page < total_pages,
        },
    }


@router.get("/{backtest_id}", summary="回测详情")
async def get_backtest(backtest_id: str):
    client = get_pg_client()
    rows = client.select(
        "backtests",
        filters={"id": f"eq.{backtest_id}"},
        limit=1,
    )
    if not rows:
        raise api_error(
            ErrorCode.BACKTEST_NOT_FOUND,
            f"Backtest not found: {backtest_id}",
            status=404,
            backtest_id=backtest_id,
        )
    return {"data": rows[0]}


app.include_router(router)
