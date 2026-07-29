"""monitor-svc · 分模块数据报表 + 告警聚合

GET /api/v1/monitor/alerts 的数据来源。

模块划分：
- infra     基础设施（Redis / MinIO / PostgreSQL / 磁盘）
- services  微服务健康（data/feature/train/infer/backtest）
- data      行情与基本面数据（klines_all / fundamentals / symbols / market_snapshots）
- feature   因子库与因子值（factor_definitions / feature_values）
- train     训练任务（training_jobs）
- backtest  回测任务（backtests）

每个模块返回：
    {
        "module": "data",
        "label": "数据",
        "status": "ok | warning | critical | unknown",
        "report": {...},            # 该模块的实时数据报表
        "alerts": [                 # 该模块当前触发的告警
            {"level": "warning", "message": "...", "hint": "..."},
        ],
    }

设计原则：
- 全部实时计算，不落库（第一版无告警历史需求）；
- DB 查询均为同步 client，统一 _run_db（run_in_executor + Semaphore 限流）；
- 单模块失败不影响其他模块（兜底 unknown + error 信息）；
- feature_values 是分区大表（5000w+ 行），不做全表 count，
  新鲜度用"逐天等值探测"（分区裁剪 + limit 1），最多回看 7 天。
"""

from __future__ import annotations

import asyncio
import shutil
import time
from datetime import UTC, date, datetime, timedelta
from typing import Any

from common import get_logger, get_pg_client

from common_utils import probe_all_services, probe_infra

logger = get_logger(__name__)

# DB 并发限流：alerts 聚合会并发跑多个模块的查询，
# 超过 PG 连接池上限（maxconn）会直接抛 PoolError，统一限到 6。
_DB_SEM = asyncio.Semaphore(6)


async def _run_db(fn):
    """在连接池安全并发度内执行同步 DB 调用。"""
    loop = asyncio.get_event_loop()
    async with _DB_SEM:
        return await loop.run_in_executor(None, fn)


# 数据新鲜度容忍天数：1d K线最迟与今天相差不超过该值（周末/假期粗容忍）
KLINE_STALE_DAYS = 3
# feature_values 逐天探测的最大回看天数
FEATURE_LOOKBACK_DAYS = 7
# 任务失败告警的回看窗口
JOB_FAILURE_WINDOW_HOURS = 24
# 磁盘告警阈值（2026-07-25 PG 因 /data 写满 WAL 失败崩溃循环的教训，手册 ## 17）
DISK_WATCH_PATH = "/data"
DISK_WARN_PCT = 85
DISK_CRIT_PCT = 95

Alert = dict[str, Any]
ModuleResult = dict[str, Any]


def _alert(level: str, message: str, hint: str | None = None) -> Alert:
    a: Alert = {"level": level, "message": message}
    if hint:
        a["hint"] = hint
    return a


def _status_of(alerts: list[Alert]) -> str:
    if any(a["level"] == "critical" for a in alerts):
        return "critical"
    if any(a["level"] == "warning" for a in alerts):
        return "warning"
    return "ok"


def _module(module: str, label: str, report: dict[str, Any], alerts: list[Alert]) -> ModuleResult:
    return {
        "module": module,
        "label": label,
        "status": _status_of(alerts),
        "report": report,
        "alerts": alerts,
    }


def _error_module(module: str, label: str, exc: Exception) -> ModuleResult:
    logger.warning("monitor.alerts_module_failed", module=module, error=str(exc))
    return {
        "module": module,
        "label": label,
        "status": "unknown",
        "report": {},
        "alerts": [
            _alert("warning", f"{label}模块巡检失败：{type(exc).__name__}", str(exc)[:200])
        ],
    }


# ──────────────────────────────────────────
# infra / services（复用现有探测 + 磁盘监控）
# ──────────────────────────────────────────
async def collect_infra() -> ModuleResult:
    try:
        infra = await probe_infra()
        alerts = [
            _alert("critical", f"基础设施 {name} 不可用", "请检查对应容器/进程状态")
            for name, v in infra.items()
            if v.get("status") != "ok"
        ]
        report = {name: v.get("status") for name, v in infra.items()}

        # 磁盘使用率（PG/镜像/日志都在 /data，写满 = 数据库崩溃）
        try:
            usage = shutil.disk_usage(DISK_WATCH_PATH)
            pct = round(usage.used / usage.total * 100, 1)
            report["disk_pct"] = pct
            report["disk_free_gb"] = round(usage.free / 1e9, 1)
            if pct >= DISK_CRIT_PCT:
                alerts.append(
                    _alert(
                        "critical",
                        f"磁盘 {DISK_WATCH_PATH} 已用 {pct}%（剩 {report['disk_free_gb']}GB）",
                        "PG 写 WAL 失败会崩溃循环！先 docker system df 查可回收镜像。",
                    )
                )
            elif pct >= DISK_WARN_PCT:
                alerts.append(
                    _alert(
                        "warning",
                        f"磁盘 {DISK_WATCH_PATH} 已用 {pct}%（剩 {report['disk_free_gb']}GB）",
                        "建议清理：docker image prune / 旧构建产物 / 日志轮转。",
                    )
                )
        except Exception:  # noqa: BLE001
            pass

        return _module("infra", "基础设施", report, alerts)
    except Exception as e:  # noqa: BLE001
        return _error_module("infra", "基础设施", e)


async def collect_services() -> ModuleResult:
    try:
        services = await probe_all_services()
        alerts = []
        for s in services:
            st = s.get("status")
            if st != "ok":
                alerts.append(
                    _alert(
                        "critical",
                        f"服务 {s['name']}（{s.get('role', '')}）状态异常：{st}",
                        f"url={s.get('url')} error={s.get('error', '')}".strip(),
                    )
                )
        report = {
            "total": len(services),
            "ok": sum(1 for s in services if s.get("status") == "ok"),
            "services": [
                {
                    "name": s["name"],
                    "role": s.get("role"),
                    "status": s.get("status"),
                    "latency_ms": s.get("latency_ms"),
                }
                for s in services
            ],
        }
        return _module("services", "微服务", report, alerts)
    except Exception as e:  # noqa: BLE001
        return _error_module("services", "微服务", e)


# ──────────────────────────────────────────
# data 模块：行情 / 基本面 / 快照
# ──────────────────────────────────────────
def _latest_kline_date(client, timeframe: str) -> date | None:
    rows = client.select(
        "klines_all",
        columns="dt",
        filters={"timeframe": f"eq.{timeframe}"},
        order="dt.desc",
        limit=1,
    )
    if not rows:
        return None
    dt_val = rows[0]["dt"]
    if isinstance(dt_val, str):
        return datetime.fromisoformat(dt_val.replace("Z", "+00:00")).date()
    if isinstance(dt_val, datetime):
        return dt_val.date()
    return dt_val  # already a date


def _latest_snapshot_date(client) -> date | None:
    rows = client.select("market_snapshots", columns="date", order="date.desc", limit=1)
    if not rows:
        return None
    v = rows[0]["date"]
    if isinstance(v, str):
        return date.fromisoformat(v)
    return v


def _latest_feature_value_date(client) -> tuple[date | None, list[dict[str, Any]]]:
    """逐天等值探测 feature_values 最新日期（分区大表不做 order desc 全扫）。

    返回 (最新有数据的日期, 近几天的逐日写入量)。
    """
    today = datetime.now(UTC).date()
    recent: list[dict[str, Any]] = []
    latest: date | None = None
    for i in range(FEATURE_LOOKBACK_DAYS):
        d = today - timedelta(days=i)
        rows = client.select(
            "feature_values",
            columns="date",
            filters={"date": f"eq.{d.isoformat()}"},
            limit=1,
        )
        has = bool(rows)
        if has and latest is None:
            latest = d
        # 统计最近 3 个探测日的写入量（有数据才 count，避免无意义的全分区扫描）
        if i < 3 and has:
            try:
                n = client.count("feature_values", filters={"date": f"eq.{d.isoformat()}"})
            except Exception:  # noqa: BLE001
                n = -1
            recent.append({"date": d.isoformat(), "rows": n})
    return latest, recent


async def collect_data() -> ModuleResult:
    try:
        client = get_pg_client()

        symbols_n, klines_1d_latest, klines_5m_latest, fund_n, snapshots_latest = (
            await asyncio.gather(
                _run_db(lambda: client.count("symbols")),
                _run_db(lambda: _latest_kline_date(client, "1d")),
                _run_db(lambda: _latest_kline_date(client, "5m")),
                _run_db(lambda: client.count("fundamentals")),
                _run_db(lambda: _latest_snapshot_date(client)),
            )
        )

        today = datetime.now(UTC).date()
        alerts: list[Alert] = []

        if klines_1d_latest is None:
            alerts.append(
                _alert("critical", "klines_all 无 1d K线数据", "运行 scripts/update_5m_klines.py")
            )
        else:
            lag = (today - klines_1d_latest).days
            if lag > KLINE_STALE_DAYS:
                alerts.append(
                    _alert(
                        "warning",
                        f"1d K线数据陈旧：最新 {klines_1d_latest}，落后今天 {lag} 天",
                        "K线未刷新会导致因子增量计算 date_mask 全裁掉（records_written=0）。"
                        "请运行 scripts/update_5m_klines.py 刷新数据。",
                    )
                )
        if fund_n == 0:
            alerts.append(
                _alert("warning", "fundamentals 无数据", "基本面类因子将无法计算")
            )
        if snapshots_latest is None:
            alerts.append(
                _alert("warning", "market_snapshots 无数据", "跑 scripts/seed_market_snapshots.py")
            )
        else:
            snap_lag = (today - snapshots_latest).days
            if snap_lag > KLINE_STALE_DAYS:
                alerts.append(
                    _alert(
                        "warning",
                        f"市场快照陈旧：最新 {snapshots_latest}，落后今天 {snap_lag} 天",
                        "每日 17:45 的 celery 例行任务可能失败，或手动跑 update_market_snapshots.py。",
                    )
                )

        report = {
            "symbols": symbols_n,
            "klines_1d_latest": klines_1d_latest.isoformat() if klines_1d_latest else None,
            "klines_5m_latest": klines_5m_latest.isoformat() if klines_5m_latest else None,
            "fundamentals_rows": fund_n,
            "market_snapshots_latest": snapshots_latest.isoformat() if snapshots_latest else None,
        }
        return _module("data", "数据", report, alerts)
    except Exception as e:  # noqa: BLE001
        return _error_module("data", "数据", e)


# ──────────────────────────────────────────
# feature 模块：因子定义 / 因子值
# ──────────────────────────────────────────
async def collect_feature(klines_1d_latest: date | None) -> ModuleResult:
    try:
        client = get_pg_client()

        factor_n, (fv_latest, fv_recent) = await asyncio.gather(
            _run_db(
                lambda: client.count(
                    "factor_definitions",
                    filters={"visibility": "eq.public", "deprecated_at": "is.null"},
                ),
            ),
            _run_db(lambda: _latest_feature_value_date(client)),
        )

        alerts: list[Alert] = []
        if fv_latest is None:
            alerts.append(
                _alert(
                    "critical",
                    f"近 {FEATURE_LOOKBACK_DAYS} 天 feature_values 无因子值写入",
                    "训练将报 “feature_values 为空”。请检查 K线覆盖区间后跑 "
                    "scripts/backfill_factors.py 回填，并查看 celery-worker.log 的 "
                    "batch_compute.zero_records_written 告警。",
                )
            )
        elif klines_1d_latest is not None and fv_latest < klines_1d_latest:
            lag = (klines_1d_latest - fv_latest).days
            alerts.append(
                _alert(
                    "warning",
                    f"因子值落后于 K线：因子最新 {fv_latest}，K线最新 {klines_1d_latest}（差 {lag} 天）",
                    "增量因子计算可能失败或目标区间无 K线，请查看 celery-worker.log。",
                )
            )
        # 提示写入量异常低（<1000 行/天，正常约 45w 行/天）
        for day in fv_recent:
            if 0 <= day["rows"] < 1000:
                alerts.append(
                    _alert(
                        "warning",
                        f"{day['date']} 因子值仅 {day['rows']} 行（正常约数十万行/天）",
                        "当日因子计算可能大面积失败，请查看 celery-worker.log 的 errors。",
                    )
                )

        report = {
            "factor_definitions_public": factor_n,
            "feature_values_latest": fv_latest.isoformat() if fv_latest else None,
            "feature_values_recent": fv_recent,
        }
        return _module("feature", "因子", report, alerts)
    except Exception as e:  # noqa: BLE001
        return _error_module("feature", "因子", e)


# ──────────────────────────────────────────
# train / backtest 模块：任务失败巡检
# ──────────────────────────────────────────
def _recent_failed_jobs(client, table: str, id_col: str) -> list[dict[str, Any]]:
    since = (datetime.now(UTC) - timedelta(hours=JOB_FAILURE_WINDOW_HOURS)).isoformat()
    rows = client.select(
        table,
        columns=f"{id_col},status,stage,error,created_at" if table == "training_jobs"
        else f"{id_col},status,error,created_at",
        filters={"status": "eq.failed", "created_at": f"gte.{since}"},
        order="created_at.desc",
        limit=5,
    )
    out = []
    for r in rows:
        err = r.get("error")
        if isinstance(err, dict):
            err_msg = err.get("message") or err.get("error") or str(err)[:200]
        else:
            err_msg = str(err)[:200] if err else ""
        out.append(
            {
                "id": r.get(id_col),
                "created_at": r.get("created_at"),
                "stage": r.get("stage"),
                "error": err_msg,
            }
        )
    return out


async def _collect_jobs_module(
    module: str,
    label: str,
    table: str,
    id_col: str,
) -> ModuleResult:
    try:
        client = get_pg_client()

        total, running, completed, failed_total, recent_failed = await asyncio.gather(
            _run_db(lambda: client.count(table)),
            _run_db(lambda: client.count(table, filters={"status": "eq.running"})),
            _run_db(lambda: client.count(table, filters={"status": "eq.completed"})),
            _run_db(lambda: client.count(table, filters={"status": "eq.failed"})),
            _run_db(lambda: _recent_failed_jobs(client, table, id_col)),
        )

        alerts: list[Alert] = []
        if recent_failed:
            alerts.append(
                _alert(
                    "warning",
                    f"最近 {JOB_FAILURE_WINDOW_HOURS}h 有 {len(recent_failed)} 个{label}任务失败",
                    "详见下方失败列表；常见原因：feature_values 为空 / 数据区间无因子值。",
                )
            )

        report = {
            "total": total,
            "running": running,
            "completed": completed,
            "failed_total": failed_total,
            "recent_failed": recent_failed,
        }
        return _module(module, label, report, alerts)
    except Exception as e:  # noqa: BLE001
        return _error_module(module, label, e)


# ──────────────────────────────────────────
# 聚合一锅端
# ──────────────────────────────────────────
async def collect_alerts_overview() -> dict[str, Any]:
    t = time.perf_counter()

    infra_mod, services_mod, data_mod = await asyncio.gather(
        collect_infra(), collect_services(), collect_data()
    )

    # feature 模块需要 K线最新日期做对比（data 模块已查出，直接复用避免重复查询）
    klines_latest_str = data_mod["report"].get("klines_1d_latest")
    klines_latest = date.fromisoformat(klines_latest_str) if klines_latest_str else None

    feature_mod, train_mod, backtest_mod = await asyncio.gather(
        collect_feature(klines_latest),
        _collect_jobs_module("train", "训练", "training_jobs", "job_id"),
        _collect_jobs_module("backtest", "回测", "backtests", "id"),
    )

    modules = [infra_mod, services_mod, data_mod, feature_mod, train_mod, backtest_mod]

    rank = {"ok": 0, "unknown": 1, "warning": 2, "critical": 3}
    overall = max((m["status"] for m in modules), key=lambda s: rank.get(s, 1))
    total_alerts = sum(len(m["alerts"]) for m in modules)

    return {
        "overall": overall,
        "alert_counts": {
            "critical": sum(
                1 for m in modules for a in m["alerts"] if a["level"] == "critical"
            ),
            "warning": sum(
                1 for m in modules for a in m["alerts"] if a["level"] == "warning"
            ),
            "total": total_alerts,
        },
        "modules": modules,
        "generated_at": datetime.now(UTC).isoformat(),
        "elapsed_ms": int((time.perf_counter() - t) * 1000),
    }
