"""数据管理后台 API（仅内部员工可访问）

提供：
- 数据概览（各表行数、最近更新时间）
- 手动触发数据更新任务
- 查看任务执行状态（含历史记录持久化）
"""

from __future__ import annotations

import json as _json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException
import psycopg2
import psycopg2.errors
from pydantic import BaseModel, Field

from common import get_logger
from common.supabase_client import get_supabase_client

logger = get_logger(__name__)
router = APIRouter()

# 管理员角色白名单（MVP：硬编码；生产用 Supabase 的 user_metadata.role）
ADMIN_ROLES = {"admin", "staff", "employee"}

# 脚本目录：admin.py → routers/ → data-svc/ → python-services/ → investdojo/
#   __file__.parent × 3 = python-services/
#   __file__.parent × 4 = investdojo/  (scripts/ 在这一层)
_PYTHON_SERVICES = Path(__file__).parent.parent.parent
SCRIPTS_DIR = _PYTHON_SERVICES.parent / "scripts"
VENV_PYTHON = _PYTHON_SERVICES / ".venv" / "Scripts" / "python.exe"
if not VENV_PYTHON.exists():
    VENV_PYTHON = _PYTHON_SERVICES / ".venv" / "bin" / "python"
if not VENV_PYTHON.exists():
    VENV_PYTHON = Path(sys.executable)

# ── 历史日志持久化目录 ──
_TASK_HISTORY_DIR = _PYTHON_SERVICES / ".task_history"
_TASK_HISTORY_DIR.mkdir(parents=True, exist_ok=True)
MAX_HISTORY_RECORDS = 20  # 每个任务最多保存最近 20 条历史


def _admin_error(message: str, status: int = 403) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": {"code": "PERMISSION_DENIED", "message": message}})


def _param_error(message: str, status: int = 400) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": {"code": "INVALID_PARAM", "message": message}})


def _require_admin(x_user_id: str | None, x_user_role: str | None) -> str:
    """验证是否为管理员"""
    if not x_user_id or not x_user_role or x_user_role not in ADMIN_ROLES:
        raise _admin_error("Admin access required")
    return x_user_id


# ── 数据任务状态（内存 + 持久化） ──
_task_status: dict[str, dict[str, Any]] = {}
# 任务日志（最近 500 行），独立存储避免 status JSON 太大
_task_logs: dict[str, list[str]] = {}
MAX_LOG_LINES = 500


# ── 持久化辅助函数 ──

def _task_dir(task_name: str) -> Path:
    """获取某任务的持久化目录"""
    d = _TASK_HISTORY_DIR / task_name
    d.mkdir(parents=True, exist_ok=True)
    return d


def _save_task_result(task_name: str) -> None:
    """将当前任务的状态 + 日志持久化为一条历史记录"""
    status = _task_status.get(task_name)
    if not status:
        return
    logs = _task_logs.get(task_name, [])

    record = {
        **status,
        "logs": logs[-MAX_LOG_LINES:],
    }

    # 按时间戳命名，写入历史文件
    ts = (status.get("started_at") or datetime.utcnow().isoformat() + "Z").replace(":", "-")
    d = _task_dir(task_name)
    record_file = d / f"{ts}.json"
    try:
        record_file.write_text(_json.dumps(record, ensure_ascii=False, default=str), encoding="utf-8")
    except Exception as exc:
        logger.warning("task_history.save_failed", task=task_name, error=str(exc))

    # 同时更新 latest.json（方便快速读取最新状态）
    latest_file = d / "latest.json"
    try:
        latest_file.write_text(_json.dumps(record, ensure_ascii=False, default=str), encoding="utf-8")
    except Exception:
        pass

    # 清理超出 MAX_HISTORY_RECORDS 的旧记录
    history_files = sorted(d.glob("202*.json"))  # 只匹配时间戳文件
    if len(history_files) > MAX_HISTORY_RECORDS:
        for old in history_files[:-MAX_HISTORY_RECORDS]:
            old.unlink(missing_ok=True)


def _load_latest_status(task_name: str) -> dict[str, Any] | None:
    """从磁盘加载最新一条历史状态"""
    latest_file = _task_dir(task_name) / "latest.json"
    if not latest_file.exists():
        return None
    try:
        data = _json.loads(latest_file.read_text(encoding="utf-8"))
        return data
    except Exception:
        return None


def _load_task_history(task_name: str, limit: int = 10) -> list[dict]:
    """加载某任务的历史记录列表（不含日志内容，轻量）"""
    d = _task_dir(task_name)
    files = sorted(d.glob("202*.json"), reverse=True)[:limit]
    records = []
    for f in files:
        try:
            data = _json.loads(f.read_text(encoding="utf-8"))
            # 不返回完整日志，只返回摘要
            records.append({
                "status": data.get("status"),
                "label": data.get("label"),
                "started_at": data.get("started_at"),
                "finished_at": data.get("finished_at"),
                "error": data.get("error"),
                "progress": data.get("progress"),
                "last_line": data.get("last_line"),
                "log_lines": len(data.get("logs", [])),
            })
        except Exception:
            continue
    return records


# ── 启动时恢复：从磁盘恢复最近一次的任务状态（非 running） ──
def _restore_task_status() -> None:
    """服务启动时从磁盘恢复每个任务的最新状态到内存"""
    for task_name_dir in _TASK_HISTORY_DIR.iterdir():
        if not task_name_dir.is_dir():
            continue
        task_name = task_name_dir.name
        latest = _load_latest_status(task_name)
        if latest:
            # 如果上次是 running（说明服务中途崩了），标记为 interrupted
            if latest.get("status") == "running":
                latest["status"] = "interrupted"
                latest["error"] = "服务重启，任务被中断"
                latest["finished_at"] = datetime.utcnow().isoformat() + "Z"
            # 恢复到内存
            _task_status[task_name] = {
                k: v for k, v in latest.items() if k != "logs"
            }
            _task_logs[task_name] = latest.get("logs", [])


_restore_task_status()


@router.get("/admin/data/overview", summary="数据概览（各表统计）")
async def data_overview(
    x_user_id: str | None = Header(None, alias="X-User-Id"),
    x_user_role: str | None = Header(None, alias="X-User-Role"),
):
    """返回所有数据表的行数和最近更新时间"""
    _require_admin(x_user_id, x_user_role)

    client = get_supabase_client()

    tables = [
        {"name": "klines_all", "label": "K 线数据"},
        {"name": "symbols", "label": "股票代码"},
        {"name": "industries", "label": "行业分类"},
        {"name": "factor_definitions", "label": "因子定义"},
        {"name": "feature_values", "label": "因子预计算值"},
        {"name": "market_snapshots", "label": "市场快照"},
        {"name": "fundamentals", "label": "基本面数据"},
    ]

    result = []
    for t in tables:
        try:
            count = client.count(t["name"])
            # 尝试获取最近更新时间
            latest = None
            if t["name"] == "klines_all":
                rows = client.select(t["name"], columns="dt", order="dt.desc", limit=1)
                latest = rows[0]["dt"] if rows else None
            elif t["name"] in ("market_snapshots",):
                rows = client.select(t["name"], columns="date", order="date.desc", limit=1)
                latest = rows[0]["date"] if rows else None
            elif t["name"] == "factor_definitions":
                rows = client.select(t["name"], columns="updated_at", order="updated_at.desc", limit=1)
                latest = rows[0]["updated_at"] if rows else None

            result.append({
                "table": t["name"],
                "label": t["label"],
                "count": count,
                "latest": latest,
            })
        except Exception as exc:
            result.append({
                "table": t["name"],
                "label": t["label"],
                "count": -1,
                "latest": None,
                "error": str(exc),
            })

    return {"data": result, "tasks": _task_status}


@router.post("/admin/data/tasks/{task_name}", summary="触发数据更新任务")
async def trigger_task(
    task_name: str,
    background_tasks: BackgroundTasks,
    x_user_id: str | None = Header(None, alias="X-User-Id"),
    x_user_role: str | None = Header(None, alias="X-User-Role"),
):
    """手动触发数据更新任务

    支持的 task_name:
    - update_klines: 增量更新 K 线
    - update_snapshots: 更新市场快照
    - seed_fundamentals: 采集基本面数据
    - seed_symbols: 同步股票代码
    - backfill_factors: 回填因子值（最近90天）
    """
    _require_admin(x_user_id, x_user_role)

    task_map = {
        "update_klines": {
            "script": "update_daily_klines.py",
            "label": "增量更新 K 线",
        },
        "update_snapshots": {
            "script": "update_market_snapshots.py",
            "label": "更新市场快照",
        },
        "seed_fundamentals": {
            "script": "seed_fundamentals.py",
            "label": "采集基本面数据",
        },
        "seed_symbols": {
            "script": "seed_symbols_local.py",
            "label": "同步股票代码",
        },
        "backfill_factors": {
            "script": "backfill_factors.py",
            "args": ["--from", (datetime.utcnow().replace(day=1)).strftime("%Y-%m-%d"),
                     "--to", datetime.utcnow().strftime("%Y-%m-%d")],
            "label": "回填因子值",
        },
    }

    if task_name not in task_map:
        raise _param_error(f"Unknown task: {task_name}. Available: {list(task_map.keys())}")

    # 检查是否已在运行
    if task_name in _task_status and _task_status[task_name].get("status") == "running":
        return {
            "message": f"Task '{task_name}' is already running",
            "task": _task_status[task_name],
        }

    task_info = task_map[task_name]
    _task_status[task_name] = {
        "status": "running",
        "label": task_info["label"],
        "started_at": datetime.utcnow().isoformat() + "Z",
        "finished_at": None,
        "error": None,
        "progress": None,  # 进度百分比（0~100），脚本输出中解析
        "last_line": None,  # 最后一行输出
    }
    _task_logs[task_name] = []

    background_tasks.add_task(_run_script_task, task_name, task_info)

    return {
        "message": f"Task '{task_name}' started",
        "task": _task_status[task_name],
    }


@router.get("/admin/data/tasks", summary="查看所有任务状态")
async def list_tasks(
    x_user_id: str | None = Header(None, alias="X-User-Id"),
    x_user_role: str | None = Header(None, alias="X-User-Role"),
):
    """返回所有任务的当前状态"""
    _require_admin(x_user_id, x_user_role)
    return {"tasks": _task_status}


@router.get("/admin/data/tasks/{task_name}/logs", summary="查看任务实时日志")
async def get_task_logs(
    task_name: str,
    tail: int = 50,
    x_user_id: str | None = Header(None, alias="X-User-Id"),
    x_user_role: str | None = Header(None, alias="X-User-Role"),
):
    """返回任务最近 N 行日志（运行中实时返回 / 已完成返回最终日志）"""
    _require_admin(x_user_id, x_user_role)
    logs = _task_logs.get(task_name, [])
    status = _task_status.get(task_name, {})
    return {
        "task_name": task_name,
        "status": status.get("status"),
        "progress": status.get("progress"),
        "last_line": status.get("last_line"),
        "logs": logs[-tail:],
        "total_lines": len(logs),
    }


@router.get("/admin/data/tasks/{task_name}/history", summary="查看任务历史执行记录")
async def get_task_history(
    task_name: str,
    limit: int = 10,
    x_user_id: str | None = Header(None, alias="X-User-Id"),
    x_user_role: str | None = Header(None, alias="X-User-Role"),
):
    """返回某任务的最近 N 次历史执行记录（不含完整日志）"""
    _require_admin(x_user_id, x_user_role)
    records = _load_task_history(task_name, limit=min(limit, 50))
    return {"task_name": task_name, "history": records}


@router.get("/admin/data/tasks/{task_name}/history/{index}/logs", summary="查看历史某次执行的日志")
async def get_task_history_logs(
    task_name: str,
    index: int,
    tail: int = 200,
    x_user_id: str | None = Header(None, alias="X-User-Id"),
    x_user_role: str | None = Header(None, alias="X-User-Role"),
):
    """查看历史第 N 次执行的完整日志（index=0 为最近一次）"""
    _require_admin(x_user_id, x_user_role)
    d = _task_dir(task_name)
    files = sorted(d.glob("202*.json"), reverse=True)
    if index >= len(files):
        raise _param_error(f"History index {index} not found, only {len(files)} records")
    try:
        data = _json.loads(files[index].read_text(encoding="utf-8"))
        logs = data.get("logs", [])
        return {
            "task_name": task_name,
            "index": index,
            "status": data.get("status"),
            "started_at": data.get("started_at"),
            "finished_at": data.get("finished_at"),
            "logs": logs[-tail:],
            "total_lines": len(logs),
        }
    except Exception as exc:
        raise _param_error(f"Failed to read history: {exc}") from exc


def _run_script_task(task_name: str, task_info: dict) -> None:
    """后台执行脚本，实时捕获输出，完成后持久化结果"""
    import re as _re
    script_path = SCRIPTS_DIR / task_info["script"]
    args = task_info.get("args", [])
    proc = None

    try:
        env_path = str(_PYTHON_SERVICES)
        cmd = [str(VENV_PYTHON), str(script_path)] + args

        logger.info("admin.task_start", task=task_name, cmd=" ".join(cmd))

        proc = subprocess.Popen(
            cmd,
            cwd=env_path,
            env={**__import__("os").environ, "PYTHONPATH": env_path, "PYTHONIOENCODING": "utf-8"},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            bufsize=1,  # 行缓冲
        )

        # 实时读取输出
        for line in iter(proc.stdout.readline, ""):
            line = line.rstrip("\n\r")
            if not line:
                continue

            # 存日志（保留最近 MAX_LOG_LINES 行）
            logs = _task_logs.get(task_name, [])
            logs.append(line)
            if len(logs) > MAX_LOG_LINES:
                logs = logs[-MAX_LOG_LINES:]
            _task_logs[task_name] = logs

            # 更新最后一行
            _task_status[task_name]["last_line"] = line

            # 尝试解析进度（匹配常见格式）
            # 格式1: [50%] 或 50% 或 (50%)
            m = _re.search(r"(\d{1,3})%", line)
            if m:
                pct = int(m.group(1))
                if 0 <= pct <= 100:
                    _task_status[task_name]["progress"] = pct

            # 格式2: 100/5000 或 batch 10/50
            m = _re.search(r"(\d+)\s*/\s*(\d+)", line)
            if m:
                current, total = int(m.group(1)), int(m.group(2))
                if total > 0:
                    _task_status[task_name]["progress"] = min(100, int(current / total * 100))

        proc.wait(timeout=3600)

        if proc.returncode == 0:
            _task_status[task_name]["status"] = "success"
            _task_status[task_name]["progress"] = 100
            logger.info("admin.task_done", task=task_name)
        else:
            _task_status[task_name]["status"] = "failed"
            last_lines = "\n".join((_task_logs.get(task_name) or [])[-5:])
            _task_status[task_name]["error"] = last_lines or "Unknown error"
            logger.error("admin.task_failed", task=task_name)

    except subprocess.TimeoutExpired:
        _task_status[task_name]["status"] = "timeout"
        _task_status[task_name]["error"] = "Task timed out (1h)"
        if proc:
            proc.kill()
        logger.error("admin.task_timeout", task=task_name)
    except Exception as exc:
        _task_status[task_name]["status"] = "failed"
        _task_status[task_name]["error"] = str(exc)
        logger.error("admin.task_error", task=task_name, error=str(exc))
    finally:
        _task_status[task_name]["finished_at"] = datetime.utcnow().isoformat() + "Z"
        # 持久化结果到磁盘
        _save_task_result(task_name)


# ═══════════════════════════════════════════════════════════════
# SQL 查询 + 表结构
# ═══════════════════════════════════════════════════════════════


class SQLQueryRequest(BaseModel):
    sql: str = Field(..., max_length=5000, description="SQL 查询语句")
    limit: int = Field(100, ge=1, le=1000, description="最大返回行数")


# 禁止的 SQL 关键字（只允许 SELECT）
_FORBIDDEN_PATTERNS = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|EXECUTE|CALL)\b",
    re.IGNORECASE,
)


def _get_pg_conn():
    """直连 PostgreSQL（不走 PostgREST，支持任意 SQL）"""
    import os
    pg_host = os.environ.get("PG_HOST", "127.0.0.1")
    pg_port = int(os.environ.get("PG_PORT", "5432"))
    pg_user = os.environ.get("PG_USER", "postgres")
    pg_password = os.environ.get("PG_PASSWORD", "")
    if not pg_password:
        # 向上查找 infra/supabase-lite/.env
        search = Path(__file__).resolve().parent
        for _ in range(10):
            candidate = search / "infra" / "supabase-lite" / ".env"
            if candidate.exists():
                for line in candidate.read_text(encoding="utf-8").splitlines():
                    if line.startswith("POSTGRES_PASSWORD="):
                        pg_password = line.split("=", 1)[1].strip()
                        break
                break
            search = search.parent
    if not pg_password:
        raise _param_error("Cannot find POSTGRES_PASSWORD. Set PG_PASSWORD env var.")
    return psycopg2.connect(
        host=pg_host,
        port=pg_port,
        user=pg_user,
        password=pg_password,
        dbname="postgres",
        connect_timeout=5,
        options="-c statement_timeout=10000",
    )


@router.post("/admin/data/sql", summary="执行只读 SQL 查询")
async def execute_sql(
    payload: SQLQueryRequest,
    x_user_id: str | None = Header(None, alias="X-User-Id"),
    x_user_role: str | None = Header(None, alias="X-User-Role"),
):
    """仅允许 SELECT 查询，结果最多返回 limit 行。"""
    _require_admin(x_user_id, x_user_role)

    sql = payload.sql.strip().rstrip(";")

    # 安全检查
    if _FORBIDDEN_PATTERNS.search(sql):
        raise _param_error("Only SELECT queries are allowed")

    # 强制加 LIMIT
    if not re.search(r"\bLIMIT\b", sql, re.IGNORECASE):
        sql = f"{sql} LIMIT {payload.limit}"

    try:
        conn = _get_pg_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(sql)
                columns = [desc[0] for desc in cur.description] if cur.description else []
                rows = cur.fetchall()
                # 转为 JSON 友好格式
                data = []
                for row in rows:
                    obj = {}
                    for i, col in enumerate(columns):
                        v = row[i]
                        # 转换不可 JSON 序列化的类型
                        if isinstance(v, (datetime,)):
                            obj[col] = v.isoformat()
                        elif hasattr(v, "__str__") and not isinstance(v, (str, int, float, bool, type(None), list, dict)):
                            obj[col] = str(v)
                        else:
                            obj[col] = v
                    data.append(obj)
                return {
                    "columns": columns,
                    "rows": data,
                    "row_count": len(data),
                    "truncated": len(data) >= payload.limit,
                }
        finally:
            conn.close()
    except psycopg2.errors.QueryCanceled:
        raise _param_error("Query timed out (10s limit)") from None
    except psycopg2.Error as exc:
        raise _param_error(f"SQL error: {exc.pgerror or str(exc)}") from exc


@router.get("/admin/data/schema", summary="获取数据库表结构")
async def get_schema(
    x_user_id: str | None = Header(None, alias="X-User-Id"),
    x_user_role: str | None = Header(None, alias="X-User-Role"),
):
    """返回 public schema 的所有表和列信息"""
    _require_admin(x_user_id, x_user_role)

    try:
        conn = _get_pg_conn()
        try:
            with conn.cursor() as cur:
                # 获取所有表
                cur.execute("""
                    SELECT table_name
                    FROM information_schema.tables
                    WHERE table_schema = 'public'
                      AND table_type = 'BASE TABLE'
                    ORDER BY table_name
                """)
                table_names = [r[0] for r in cur.fetchall()]

                # 获取所有列信息
                cur.execute("""
                    SELECT table_name, column_name, data_type, is_nullable,
                           column_default, ordinal_position
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                    ORDER BY table_name, ordinal_position
                """)
                col_rows = cur.fetchall()

                # 按表分组
                tables = {}
                for tn in table_names:
                    tables[tn] = {"name": tn, "columns": []}

                for row in col_rows:
                    tn = row[0]
                    if tn in tables:
                        tables[tn]["columns"].append({
                            "name": row[1],
                            "type": row[2],
                            "nullable": row[3] == "YES",
                            "default": row[4],
                        })

                # 获取行数估算（pg_stat 快速近似值，不扫全表）
                cur.execute("""
                    SELECT relname, n_live_tup
                    FROM pg_stat_user_tables
                    WHERE schemaname = 'public'
                """)
                for row in cur.fetchall():
                    if row[0] in tables:
                        tables[row[0]]["row_estimate"] = row[1]

                return {"tables": list(tables.values())}
        finally:
            conn.close()
    except Exception as exc:
        raise _param_error(f"Schema query failed: {str(exc)}") from exc
