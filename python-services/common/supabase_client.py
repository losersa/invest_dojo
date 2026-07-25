"""直连 PostgreSQL 客户端（替代原 Supabase PostgREST 封装）

【重构说明】
原 SupabaseClient 通过 HTTP 打 PostgREST（:8000/rest/v1）访问数据库。
现改为 **Python 微服务直连 PostgreSQL**（localhost:5432），去掉一层网络开销，
且不再依赖 PostgREST / Kong。

**对外接口完全保持不变**（`select` / `select_all` / `count` / `insert` /
`update` / `delete` / `health_check` / 上下文管理器），所有调用方无需改动。
原先直接调用 `client._http.patch(...)` 的代码请改用新增的 `client.update(...)`。

原先的 PostgREST 过滤器语法（`{"col": "op.value"}`）被原样翻译为 SQL，
支持：eq / neq / gt / gte / lt / lte / like / ilike / in / is / cs，
以及特殊键 `or` / `and`（值为 `(a.op.v,b.op.v)` 组合）。

连接以 `postgres` 超级用户身份建立，天然绕过 RLS，等价于原先 service_role key 的行为。
"""

from __future__ import annotations

import re
import threading
from typing import Any

import psycopg2
import psycopg2.extras
from psycopg2 import pool

from common.config import settings
from common.logging import get_logger

logger = get_logger(__name__)

# 标识符白名单（表名 / 列名），防止注入
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# 列/排序片段白名单
_COL_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _ident(name: str) -> str:
    """校验并转义 SQL 标识符（表名/列名）。"""
    if not _IDENT_RE.match(name):
        raise ValueError(f"非法的 SQL 标识符: {name!r}")
    return f'"{name}"'


def _validate_columns(columns: str) -> str:
    """校验 SELECT 列清单，返回逗号分隔的安全片段。"""
    if columns.strip() == "*":
        return "*"
    cols = [c.strip() for c in columns.split(",") if c.strip()]
    if not cols:
        raise ValueError(f"非法的列清单: {columns!r}")
    for c in cols:
        if not _COL_RE.match(c):
            raise ValueError(f"非法的列名: {c!r}")
    return ", ".join(cols)


def _validate_order_token(token: str) -> str:
    """校验单段 order（col.dir），返回 'col ASC'。"""
    col, _, direction = token.strip().partition(".")
    if not _COL_RE.match(col):
        raise ValueError(f"非法的排序列: {col!r}")
    direction = (direction or "asc").lower()
    if direction not in ("asc", "desc"):
        raise ValueError(f"非法的排序方向: {direction!r}")
    return f'{_ident(col)} {direction.upper()}'


def _translate_order(order: str) -> str:
    return ", ".join(_validate_order_token(t) for t in order.split(",") if t.strip())


class PGClient:
    """直连 PostgreSQL 的轻量客户端，接口兼容原 SupabaseClient。"""

    def __init__(
        self,
        *,
        host: str | None = None,
        port: int | None = None,
        user: str | None = None,
        password: str | None = None,
        database: str | None = None,
        timeout: float = 30.0,
    ):
        self.host = host or settings.pg_host
        self.port = port or settings.pg_port
        self.user = user or settings.pg_user
        self.password = password if password is not None else settings.pg_password
        self.database = database or settings.pg_database
        self.timeout = timeout
        self.url = f"pg://{self.host}:{self.port}/{self.database}"
        self._pool: pool.ThreadedConnectionPool | None = None
        self._pool_lock = threading.Lock()
        self._col_type_cache: dict[tuple[str, str], str] = {}

    # ── 连接池 ──
    def _get_pool(self) -> pool.ThreadedConnectionPool:
        # ThreadedConnectionPool：asyncio run_in_executor 会让查询跑在多个 worker
        # 线程，SimpleConnectionPool 非线程安全（会抛 "trying to put unkeyed
        # connection"），必须用 ThreadedConnectionPool。
        if self._pool is None:
            with self._pool_lock:  # 双重检查：防多线程首次并发建池
                if self._pool is None:
                    dsn = (
                        f"host={self.host} port={self.port} user={self.user} "
                        f"password={self.password} dbname={self.database} "
                        f"connect_timeout={int(self.timeout)} "
                        # TCP keepalive：DB 重启/空闲断链后尽快探活，
                        # 避免拿到 "server closed the connection" 的死连接
                        f"keepalives=1 keepalives_idle=30 "
                        f"keepalives_interval=10 keepalives_count=5"
                    )
                    self._pool = pool.ThreadedConnectionPool(
                        minconn=1,
                        maxconn=20,  # 并发 API 请求 × run_in_executor 线程，10 易耗尽
                        dsn=dsn,
                    )
        return self._pool

    def _conn(self):
        return self._get_pool().getconn()

    def _put(self, conn) -> None:
        self._get_pool().putconn(conn)

    # ── 类型探测（用于数值/时间/布尔列的强制转型）──
    def _col_type(self, table: str, col: str) -> str:
        key = (table, col)
        if key in self._col_type_cache:
            return self._col_type_cache[key]
        try:
            conn = self._conn()
            try:
                cur = conn.cursor()
                cur.execute(
                    "SELECT data_type FROM information_schema.columns "
                    "WHERE table_name = %s AND column_name = %s",
                    (table, col),
                )
                row = cur.fetchone()
                dtype = (row[0] if row else "") or ""
            finally:
                self._put(conn)
        except Exception as e:  # noqa: BLE001 - 探测失败降级为文本
            logger.warning("pg.col_type.failed", table=table, col=col, error=str(e))
            dtype = ""
        self._col_type_cache[key] = dtype
        return dtype

    @staticmethod
    def _param_cast(dtype: str) -> str:
        """根据列类型返回参数的转型后缀（如 ::numeric），文本类返回空串。"""
        d = dtype.lower()
        if any(k in d for k in ("int", "numeric", "decimal", "real", "double", "float", "money")):
            return "::numeric"
        if any(k in d for k in ("timestamp", "date", "time")):
            return "::timestamptz"
        if "boolean" in d:
            return "::boolean"
        if "uuid" in d:
            return "::uuid"
        return ""

    # ── 过滤器翻译 ──
    def _translate_one(self, col: str, val: str, table: str) -> tuple[str, list[Any]]:
        col_sql = _ident(col)
        op, _, raw = val.partition(".")
        params: list[Any] = []

        if op in ("eq", "neq"):
            sym = "=" if op == "eq" else "<>"
            cast = self._param_cast(self._col_type(table, col))
            return (f"{col_sql} {sym} %s{cast}", [raw])
        if op in ("gt", "gte", "lt", "lte"):
            sym = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
            cast = self._param_cast(self._col_type(table, col))
            return (f"{col_sql} {sym} %s{cast}", [raw])
        if op == "like":
            return (f"{col_sql}::text LIKE %s", [raw.replace("*", "%")])
        if op == "ilike":
            return (f"{col_sql}::text ILIKE %s", [raw.replace("*", "%")])
        if op == "is":
            if raw == "null":
                return (f"{col_sql} IS NULL", [])
            if raw == "true":
                return (f"{col_sql} IS TRUE", [])
            if raw == "false":
                return (f"{col_sql} IS FALSE", [])
            return (f"{col_sql} IS NULL", [])
        if op == "in":
            items = [i.strip() for i in raw.strip("()").split(",") if i.strip() != ""]
            cast = self._param_cast(self._col_type(table, col))
            placeholders = ", ".join(f"%s{cast}" for _ in items)
            return (f"{col_sql} IN ({placeholders})", list(items))
        if op == "cs":
            # JSONB 包含：col @> '["a","b"]'::jsonb
            return (f"{col_sql} @> %s::jsonb", [raw])
        # 未知操作符：降级为等值比较
        logger.warning("pg.unknown_op", op=op, col=col, raw=raw)
        return (f"{col_sql} = %s", [raw])

    def _translate_filter(self, filters: dict[str, Any] | None, table: str) -> tuple[str, list[Any]]:
        if not filters:
            return ("TRUE", [])
        clauses: list[str] = []
        params: list[Any] = []
        for key, val in filters.items():
            if key in ("or", "and"):
                joiner = " OR " if key == "or" else " AND "
                inner = str(val).strip()
                if inner.startswith("("):
                    inner = inner[1:]
                if inner.endswith(")"):
                    inner = inner[:-1]
                sub_clauses: list[str] = []
                for part in inner.split(","):
                    part = part.strip()
                    if not part:
                        continue
                    pcol, _, prest = part.partition(".")
                    c, p = self._translate_one(pcol, f"{prest}", table)
                    sub_clauses.append(c)
                    params.extend(p)
                clauses.append("(" + joiner.join(sub_clauses) + ")")
            else:
                c, p = self._translate_one(key, str(val), table)
                clauses.append(c)
                params.extend(p)
        return (" AND ".join(clauses), params)

    # ── 公共查询方法 ──
    def select(
        self,
        table: str,
        *,
        columns: str = "*",
        filters: dict[str, Any] | None = None,
        order: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> list[dict[str, Any]]:
        where_sql, params = self._translate_filter(filters, table)
        col_sql = _validate_columns(columns)
        sql = f"SELECT {col_sql} FROM {_ident(table)}"
        if where_sql != "TRUE":
            sql += f" WHERE {where_sql}"
        if order:
            sql += f" ORDER BY {_translate_order(order)}"
        if limit is not None:
            sql += f" LIMIT {int(limit)}"
        if offset is not None:
            sql += f" OFFSET {int(offset)}"

        conn = self._conn()
        try:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]
        finally:
            self._put(conn)

    def select_all(
        self,
        table: str,
        *,
        columns: str = "*",
        filters: dict[str, Any] | None = None,
        order: str | None = None,
        page_size: int = 1000,
        max_pages: int = 10_000,
    ) -> list[dict[str, Any]]:
        """自动分页查询所有行（基于 LIMIT/OFFSET）。"""
        all_rows: list[dict[str, Any]] = []
        offset = 0
        where_sql, params = self._translate_filter(filters, table)
        col_sql = _validate_columns(columns)
        base_sql = f"SELECT {col_sql} FROM {_ident(table)}"
        if where_sql != "TRUE":
            base_sql += f" WHERE {where_sql}"
        if order:
            base_sql += f" ORDER BY {_translate_order(order)}"

        for _ in range(max_pages):
            sql = f"{base_sql} LIMIT {int(page_size)} OFFSET {int(offset)}"
            conn = self._conn()
            try:
                cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
                cur.execute(sql, params)
                rows = [dict(r) for r in cur.fetchall()]
            finally:
                self._put(conn)

            if not rows:
                break
            all_rows.extend(rows)
            if len(rows) < page_size:
                break
            offset += page_size

        logger.debug("pg.select_all", table=table, total=len(all_rows))
        return all_rows

    def count(self, table: str, *, filters: dict[str, Any] | None = None) -> int:
        where_sql, params = self._translate_filter(filters, table)
        sql = f"SELECT count(*) AS n FROM {_ident(table)}"
        if where_sql != "TRUE":
            sql += f" WHERE {where_sql}"
        conn = self._conn()
        try:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(sql, params)
            return int(cur.fetchone()["n"])
        finally:
            self._put(conn)

    def _adapt_param(self, table: str, col: str, value: Any) -> Any:
        """根据列类型适配参数：jsonb 列用 psycopg2.extras.Json 序列化。"""
        if value is None:
            return None
        if "jsonb" in self._col_type(table, col).lower():
            return psycopg2.extras.Json(value)
        return value

    def insert(
        self,
        table: str,
        data: dict[str, Any] | list[dict[str, Any]],
        *,
        on_conflict: str | None = None,
    ) -> list[dict[str, Any]]:
        """插入一行或多行，可选 upsert（on_conflict 形如 "symbol,dt"）。"""
        rows = data if isinstance(data, list) else [data]
        if not rows:
            return []
        cols = list(rows[0].keys())
        params: list[Any] = []
        value_rows: list[str] = []
        for r in rows:
            value_rows.append("(" + ", ".join(["%s"] * len(cols)) + ")")
            for c in cols:
                params.append(self._adapt_param(table, c, r.get(c)))

        col_sql = ", ".join(_ident(c) for c in cols)
        sql = f"INSERT INTO {_ident(table)} ({col_sql}) VALUES {', '.join(value_rows)}"
        if on_conflict:
            conflict_cols = [c.strip() for c in on_conflict.split(",") if c.strip()]
            conflict_sql = ", ".join(_ident(c) for c in conflict_cols)
            update_cols = [c for c in cols if c not in conflict_cols]
            if update_cols:
                set_sql = ", ".join(f"{_ident(c)} = EXCLUDED.{_ident(c)}" for c in update_cols)
                sql += f" ON CONFLICT ({conflict_sql}) DO UPDATE SET {set_sql}"
            else:
                sql += f" ON CONFLICT ({conflict_sql}) DO NOTHING"
        sql += " RETURNING *"

        conn = self._conn()
        try:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(sql, params)
            result = [dict(r) for r in cur.fetchall()]
            conn.commit()
            return result
        except Exception:
            conn.rollback()
            raise
        finally:
            self._put(conn)

    def update(
        self,
        table: str,
        data: dict[str, Any],
        *,
        filters: dict[str, Any] | None = None,
        return_representation: bool = True,
    ) -> list[dict[str, Any]] | None:
        """更新匹配行（等价于原 _http.patch）。"""
        set_cols = list(data.keys())
        if not set_cols:
            raise ValueError("update 需要至少一个字段")
        set_sql = ", ".join(f"{_ident(c)} = %s" for c in set_cols)
        params: list[Any] = [self._adapt_param(table, c, data[c]) for c in set_cols]
        where_sql, wparams = self._translate_filter(filters, table)
        params.extend(wparams)

        sql = f"UPDATE {_ident(table)} SET {set_sql}"
        if where_sql != "TRUE":
            sql += f" WHERE {where_sql}"
        if return_representation:
            sql += " RETURNING *"

        conn = self._conn()
        try:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(sql, params)
            result = [dict(r) for r in cur.fetchall()] if return_representation else None
            conn.commit()
            return result
        except Exception:
            conn.rollback()
            raise
        finally:
            self._put(conn)

    def delete(self, table: str, *, filters: dict[str, Any]) -> None:
        """删除（必须带 filter，避免清空全表）。"""
        if not filters:
            raise ValueError("delete 必须指定 filters，拒绝清空全表")
        where_sql, params = self._translate_filter(filters, table)
        sql = f"DELETE FROM {_ident(table)}"
        if where_sql != "TRUE":
            sql += f" WHERE {where_sql}"

        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(sql, params)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            self._put(conn)

    def health_check(self) -> bool:
        """健康检查"""
        try:
            conn = self._conn()
            try:
                cur = conn.cursor()
                cur.execute("SELECT 1")
                return cur.fetchone()[0] == 1
            finally:
                self._put(conn)
        except Exception as e:
            logger.warning("pg.health_check.failed", error=str(e))
            return False

    def close(self) -> None:
        if self._pool is not None:
            self._pool.closeall()
            self._pool = None

    def __enter__(self) -> "PGClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()


# 向后兼容别名：原代码里 `SupabaseClient` / `get_supabase_client` 继续可用
SupabaseClient = PGClient


# 单例（按需初始化）
_client: PGClient | None = None


def get_supabase_client() -> PGClient:
    """获取单例客户端"""
    global _client
    if _client is None:
        _client = PGClient()
    return _client
