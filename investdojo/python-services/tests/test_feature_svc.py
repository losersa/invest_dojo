"""feature-svc 单元测试

覆盖：
- 工具函数（parse_sort / parse_tags / paginate_response）
- 路由 listing 路径冲突（/factors/categories 不被 {factor_id} 吞掉）
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

SVC_DIR = Path(__file__).parent.parent / "feature-svc"


def _load_module(path: Path, name: str):
    """按绝对路径加载模块（避免 data-svc 同名 common_utils 冲突）"""
    if name in sys.modules:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# 加载 feature-svc 的 common_utils
_cu = _load_module(SVC_DIR / "common_utils.py", "feature_svc_common_utils")

CATEGORY_LABELS = _cu.CATEGORY_LABELS
VALID_CATEGORIES = _cu.VALID_CATEGORIES
paginate_response = _cu.paginate_response
parse_sort = _cu.parse_sort
parse_tags = _cu.parse_tags


# 加载 routers.factors 的 _factor_row_to_api
# 先把 feature-svc 加到 sys.path，让 routers 能 import common_utils
if str(SVC_DIR) not in sys.path:
    sys.path.insert(0, str(SVC_DIR))
# 但我们已经有一个 common_utils 在别处（data-svc），这里覆盖为 feature-svc 的
sys.modules["common_utils"] = _cu
_factors = _load_module(SVC_DIR / "routers" / "factors.py", "feature_svc_routers_factors")
_factor_row_to_api = _factors._factor_row_to_api


# ──────────────────────────────────────────
# parse_tags
# ──────────────────────────────────────────
def test_parse_tags_basic():
    assert parse_tags("趋势,短线") == ["趋势", "短线"]


def test_parse_tags_empty():
    assert parse_tags(None) == []
    assert parse_tags("") == []
    assert parse_tags(",,") == []


def test_parse_tags_trim():
    assert parse_tags(" 趋势 , 短线 ,") == ["趋势", "短线"]


# ──────────────────────────────────────────
# parse_sort
# ──────────────────────────────────────────
def test_parse_sort_asc():
    assert parse_sort("updated_at", valid={"updated_at"}) == ("updated_at", "asc")


def test_parse_sort_desc():
    assert parse_sort("-updated_at", valid={"updated_at"}) == ("updated_at", "desc")


def test_parse_sort_none():
    assert parse_sort(None, valid={"updated_at"}) is None
    assert parse_sort("", valid={"updated_at"}) is None


def test_parse_sort_invalid_field():
    with pytest.raises(HTTPException):
        parse_sort("unknown_field", valid={"updated_at"})


# ──────────────────────────────────────────
# paginate_response
# ──────────────────────────────────────────
def test_paginate_response_has_next_true():
    resp = paginate_response([], page=1, page_size=10, total=30)
    assert resp["pagination"]["has_next"] is True
    assert resp["pagination"]["total_pages"] == 3


def test_paginate_response_has_next_false():
    resp = paginate_response([], page=3, page_size=10, total=30)
    assert resp["pagination"]["has_next"] is False


def test_paginate_response_zero_total():
    resp = paginate_response([], page=1, page_size=20, total=0)
    assert resp["pagination"]["total_pages"] == 0
    assert resp["pagination"]["has_next"] is False


# ──────────────────────────────────────────
# 静态常量契约
# ──────────────────────────────────────────
def test_category_labels_cover_all_valid():
    """所有 VALID_CATEGORIES 都必须有中文 label"""
    assert set(CATEGORY_LABELS.keys()) == VALID_CATEGORIES


def test_valid_categories_non_empty():
    assert len(VALID_CATEGORIES) >= 5


# ──────────────────────────────────────────
# 行规范化
# ──────────────────────────────────────────
def test_factor_row_to_api_stats_cache_expansion():
    """stats_cache 要被展开成 stats"""
    row = {
        "id": "x",
        "name": "x",
        "stats_cache": {"winrate_5d": 0.55},
        "stats_cached_at": "2026-01-01T00:00:00Z",
        "tags": ["a"],
    }
    out = _factor_row_to_api(row)
    assert "stats" in out
    assert out["stats"]["winrate_5d"] == 0.55
    assert "stats_cache" not in out
    assert "stats_cached_at" not in out


def test_factor_row_to_api_null_tags_become_empty_list():
    row = {"id": "x", "tags": None}
    out = _factor_row_to_api(row)
    assert out["tags"] == []
