"""data-svc · 单元测试与契约测试

测试重点：
1. as_of 注入正确（klines 查询带 dt < as_of）
2. 分页契约（超过 1000 行必须分页）
3. market/snapshot 未来函数拒绝
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SVC_DIR = Path(__file__).parent.parent / "data-svc"


def _load_module(path: Path, name: str):
    """按绝对路径加载模块（避免与 feature-svc 同名文件冲突）"""
    if name in sys.modules:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# 加载 data-svc 的 common_utils
_cu = _load_module(SVC_DIR / "common_utils.py", "data_svc_common_utils")
parse_as_of = _cu.parse_as_of
parse_date = _cu.parse_date
split_symbols = _cu.split_symbols
as_of_to_utc_iso = _cu.as_of_to_utc_iso
paginate_response = _cu.paginate_response

# 加载 routers.klines —— 它用 `from common_utils import ...`
# 所以先把 common_utils 注入到 sys.modules
sys.modules["common_utils"] = _cu
if str(SVC_DIR) not in sys.path:
    sys.path.insert(0, str(SVC_DIR))
_klines = _load_module(SVC_DIR / "routers" / "klines.py", "data_svc_routers_klines")
_build_klines_filters = _klines._build_klines_filters
_date_to_beijing_utc = _klines._date_to_beijing_utc
_normalize_dt = _klines._normalize_dt


# ──────────────────────────────────────────
# as_of 解析
# ──────────────────────────────────────────
def test_parse_as_of_none():
    assert parse_as_of(None) is None
    assert parse_as_of("") is None


def test_parse_as_of_date_only():
    v = parse_as_of("2024-01-02")
    # 纯日期默认 UTC 0 点
    assert v.startswith("2024-01-02T00:00:00+00:00")


def test_parse_as_of_iso():
    v = parse_as_of("2024-01-02T08:00:00+08:00")
    # 转成 UTC
    assert v.startswith("2024-01-02T00:00:00+00:00")


def test_parse_as_of_invalid():
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        parse_as_of("not-a-date")


# ──────────────────────────────────────────
# 北京时区转换
# ──────────────────────────────────────────
def test_date_to_beijing_utc_midnight():
    # 北京 2024-01-02 00:00 == UTC 2024-01-01 16:00
    v = _date_to_beijing_utc("2024-01-02")
    assert v == "2024-01-01T16:00:00+00:00"


def test_date_to_beijing_utc_endofday():
    # 北京 2024-01-02 23:59:59 == UTC 2024-01-02 15:59:59
    v = _date_to_beijing_utc("2024-01-02", hour=23, minute=59, second=59)
    assert v == "2024-01-02T15:59:59+00:00"


def test_as_of_to_utc_iso_date_to_beijing():
    # as_of="2024-01-05" 视为北京时间该日 00:00
    v = as_of_to_utc_iso("2024-01-05")
    assert v == "2024-01-04T16:00:00+00:00"


# ──────────────────────────────────────────
# split_symbols
# ──────────────────────────────────────────
def test_split_symbols_basic():
    assert split_symbols("600519,000001") == ["600519", "000001"]


def test_split_symbols_dedupe():
    assert split_symbols("600519,600519,000001") == ["600519", "000001"]


def test_split_symbols_empty():
    assert split_symbols("") == []
    assert split_symbols(None) == []


def test_split_symbols_too_many():
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        split_symbols(",".join([str(i) for i in range(100)]), max_count=50)


# ──────────────────────────────────────────
# klines filter 组装（防未来函数核心）
# ──────────────────────────────────────────
def test_klines_filter_as_of_injected():
    """as_of 必须被注入到 filter 里"""
    filters = _build_klines_filters(
        symbols=["600519"],
        timeframe="1d",
        start=None,
        end=None,
        as_of_iso="2024-01-05T00:00:00+00:00",
        scenario_id=None,
    )
    # as_of 要么以独立 dt 字段出现，要么在 and=(...) 里出现
    has_in_dt = filters.get("dt") == "lt.2024-01-05T00:00:00+00:00"
    has_in_and = "and" in filters and "dt.lt.2024-01-05T00:00:00+00:00" in filters["and"]
    assert has_in_dt or has_in_and, f"as_of 未被注入到 filter：{filters}"


def test_klines_filter_scenario_null():
    """默认场景为 NULL（全市场）"""
    filters = _build_klines_filters(
        symbols=["600519"],
        timeframe="1d",
        start=None,
        end=None,
        as_of_iso=None,
        scenario_id=None,
    )
    assert filters["scenario_id"] == "is.null"


def test_klines_filter_scenario_specific():
    """指定场景会生成 eq.xxx"""
    filters = _build_klines_filters(
        symbols=["600519"],
        timeframe="5m",
        start=None,
        end=None,
        as_of_iso=None,
        scenario_id="crisis_2022",
    )
    assert filters["scenario_id"] == "eq.crisis_2022"


def test_klines_filter_start_end_and_as_of_combined():
    """start + end + as_of 三者合并到 and=(...) 条件"""
    filters = _build_klines_filters(
        symbols=["600519"],
        timeframe="1d",
        start="2024-01-02",
        end="2024-01-10",
        as_of_iso="2024-01-05T00:00:00+00:00",
        scenario_id=None,
    )
    # 三个约束都应在 and= 里
    assert "and" in filters, f"未合并到 and： {filters}"
    and_clause = filters["and"]
    assert "gte." in and_clause
    assert "lte." in and_clause
    assert "lt.2024-01-05" in and_clause


def test_normalize_dt_daily_converts_to_date_string():
    """日 K 展示为 YYYY-MM-DD（北京日期）"""
    rows = [{"dt": "2024-01-01T16:00:00+00:00"}]  # UTC 16:00 == 北京 00:00 次日
    _normalize_dt(rows, "1d")
    assert rows[0]["dt"] == "2024-01-02"


def test_normalize_dt_minute_preserves_iso():
    """分钟 K 保留完整 ISO"""
    rows = [{"dt": "2024-01-02T07:30:00+00:00"}]
    _normalize_dt(rows, "5m")
    assert "T" in rows[0]["dt"]  # ISO 格式未变


# ──────────────────────────────────────────
# 契约：分页
# ──────────────────────────────────────────
def test_paginate_response_total_pages():
    resp = paginate_response([], page=1, page_size=100, total=251)
    assert resp["pagination"]["total_pages"] == 3  # ceil(251/100) = 3


def test_paginate_response_zero():
    resp = paginate_response([], page=1, page_size=100, total=0)
    assert resp["pagination"]["total_pages"] == 0
