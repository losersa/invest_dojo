"""Supabase PostgREST 客户端

封装常用操作，**修复已知的分页坑**：
- PostgREST 默认单次查询硬限制 1000 行
- 分页必须每页重建 query，不能复用同一 query 对象
"""

from typing import Any

import httpx

from common.config import settings
from common.logging import get_logger

logger = get_logger(__name__)


class SupabaseClient:
    """轻量级 Supabase REST 客户端，支持分页"""

    def __init__(
        self,
        url: str | None = None,
        key: str | None = None,
        timeout: float = 30.0,
    ):
        self.url = (url or settings.supabase_url).rstrip("/")
        self.key = key or settings.supabase_service_role_key
        self._http = httpx.Client(
            timeout=timeout,
            headers={
                "apikey": self.key,
                "Authorization": f"Bearer {self.key}",
                "Content-Type": "application/json",
            },
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "SupabaseClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def select(
        self,
        table: str,
        *,
        columns: str = "*",
        filters: dict[str, Any] | None = None,
        order: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """单页查询（默认 1000 行上限）

        Args:
            table: 表名
            columns: 字段，如 "id,name" 或 "*"
            filters: {"symbol": "eq.600519"} 或 {"dt": "gte.2024-01-01"}
                    格式遵循 PostgREST：{"column": "operator.value"}
                    operator：eq/neq/gt/gte/lt/lte/like/ilike/in/is
            order: "dt.asc" 或 "dt.desc"
            limit: 单次返回上限
        """
        params: dict[str, Any] = {"select": columns}
        if filters:
            for k, v in filters.items():
                params[k] = v
        if order:
            params["order"] = order
        if limit:
            params["limit"] = limit

        resp = self._http.get(f"{self.url}/rest/v1/{table}", params=params)
        resp.raise_for_status()
        return resp.json()

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
        """自动分页查询所有行

        关键：每页重建 query，通过 Range header 分页。
        修复之前踩过的坑：不能复用同一 query 对象做分页。
        """
        all_rows: list[dict[str, Any]] = []
        offset = 0
        page_idx = 0

        for page_idx in range(max_pages):  # noqa: B007  - 我们在循环后用到 page_idx
            params: dict[str, Any] = {"select": columns}
            if filters:
                for k, v in filters.items():
                    params[k] = v
            if order:
                params["order"] = order

            headers = {
                "Range-Unit": "items",
                "Range": f"{offset}-{offset + page_size - 1}",
            }

            resp = self._http.get(
                f"{self.url}/rest/v1/{table}",
                params=params,
                headers=headers,
            )
            resp.raise_for_status()
            rows = resp.json()

            if not rows:
                break

            all_rows.extend(rows)

            # 如果本页不满 page_size，说明已经拿完
            if len(rows) < page_size:
                break

            offset += page_size

        logger.debug(
            "supabase.select_all",
            table=table,
            total=len(all_rows),
            pages=page_idx + 1 if all_rows else 0,
        )
        return all_rows

    def count(self, table: str, *, filters: dict[str, Any] | None = None) -> int:
        """获取总行数（利用 Prefer: count=exact）"""
        params: dict[str, Any] = {"select": "*"}
        if filters:
            for k, v in filters.items():
                params[k] = v

        resp = self._http.head(
            f"{self.url}/rest/v1/{table}",
            params=params,
            headers={"Prefer": "count=exact"},
        )
        resp.raise_for_status()
        content_range = resp.headers.get("content-range", "")
        if "/" in content_range:
            return int(content_range.split("/")[-1])
        return 0

    def insert(
        self,
        table: str,
        data: dict[str, Any] | list[dict[str, Any]],
        *,
        on_conflict: str | None = None,
    ) -> list[dict[str, Any]]:
        """插入一行或多行

        Args:
            on_conflict: 冲突字段，如 "symbol,dt"（配合 upsert）
        """
        headers = {"Prefer": "return=representation"}
        params: dict[str, Any] = {}
        if on_conflict:
            headers["Prefer"] += ",resolution=merge-duplicates"
            params["on_conflict"] = on_conflict

        resp = self._http.post(
            f"{self.url}/rest/v1/{table}",
            json=data if isinstance(data, list) else [data],
            params=params,
            headers=headers,
        )
        resp.raise_for_status()
        return resp.json()

    def delete(self, table: str, *, filters: dict[str, Any]) -> None:
        """删除（必须带 filter，避免清空全表）"""
        if not filters:
            raise ValueError("delete 必须指定 filters，拒绝清空全表")

        params: dict[str, Any] = {}
        for k, v in filters.items():
            params[k] = v

        resp = self._http.delete(f"{self.url}/rest/v1/{table}", params=params)
        resp.raise_for_status()

    def health_check(self) -> bool:
        """健康检查"""
        try:
            resp = self._http.get(f"{self.url}/rest/v1/", timeout=5.0)
            return resp.status_code in (200, 400)
        except Exception as e:
            logger.warning("supabase.health_check.failed", error=str(e))
            return False


# 单例（按需初始化）
_client: SupabaseClient | None = None


def get_supabase_client() -> SupabaseClient:
    """获取单例客户端"""
    global _client
    if _client is None:
        _client = SupabaseClient()
    return _client
