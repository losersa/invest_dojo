"""Supabase 客户端测试（验证之前踩的分页坑已修复）

PostgREST 过滤器格式约定：
  filters = {"column": "operator.value"}
例如：
  {"symbol": "eq.600519"}       → ?symbol=eq.600519
  {"dt": "gte.2024-01-01"}       → ?dt=gte.2024-01-01

注意：本文件所有测试都是 integration（需要真实 Supabase 网络）。
CI 默认不跑，本地或 secrets 配置后才跑。
"""

import pytest

from common.supabase_client import get_supabase_client

# 整个文件标记为 integration
pytestmark = pytest.mark.integration


def test_supabase_select_with_filters():
    """单页查询"""
    client = get_supabase_client()
    rows = client.select(
        "klines_all",
        columns="symbol,dt,close",
        filters={"symbol": "eq.600519", "timeframe": "eq.1d"},
        order="dt.desc",
        limit=5,
    )
    assert len(rows) <= 5
    if rows:
        assert "symbol" in rows[0]
        assert rows[0]["symbol"] == "600519"


def test_supabase_count():
    """计数"""
    client = get_supabase_client()
    count = client.count(
        "klines_all",
        filters={"symbol": "eq.600519", "timeframe": "eq.1d"},
    )
    # 600519 茅台的日 K 应该有数据
    assert count > 0


def test_supabase_select_all_pagination():
    """分页查询 — 这是之前踩坑的地方

    Supabase PostgREST 单次硬限制 1000 行。
    select_all 必须每页重建 query，才能拿到超过 1000 行的数据。
    """
    client = get_supabase_client()

    # 目标：查 new_energy_2020 的 5m K 线（53136 条），明显超过 1000
    filters = {"scenario_id": "eq.new_energy_2020", "timeframe": "eq.5m"}

    total_count = client.count("klines_all", filters=filters)
    assert total_count > 1000, f"期望 > 1000 行，实际 {total_count}"

    rows = client.select_all(
        "klines_all",
        columns="symbol,dt",
        filters=filters,
        order="dt.asc",
        page_size=1000,
    )

    # 必须和 count 一致，证明分页真的生效
    assert len(rows) == total_count, (
        f"分页结果 {len(rows)} 条，期望 {total_count} 条。分页 bug 回归！"
    )


def test_supabase_select_all_with_no_data():
    """查询空结果"""
    client = get_supabase_client()
    rows = client.select_all(
        "klines_all",
        filters={"symbol": "eq.NONEXISTENT_999"},
        page_size=100,
    )
    assert rows == []
