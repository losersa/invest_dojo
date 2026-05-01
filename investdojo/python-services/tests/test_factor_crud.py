"""T-3.06 因子库 API CRUD 单元测试

覆盖：
- Pydantic 模型：FactorCreateRequest / FactorUpdateRequest / BatchQueryRequest / CompareRequest
- _infer_from_formula: 解析失败抛 HTTPException
- _gen_custom_factor_id: 唯一性 + 格式
- 辅助函数（_get_user_id 默认值等）

不覆盖：完整 E2E（需 Supabase，属于集成测试，CI 里默认 deselect）
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

SVC_DIR = Path(__file__).parent.parent / "feature-svc"


# 加载 feature-svc 的 common_utils
def _load_cu():
    if "common_utils" in sys.modules and getattr(
        sys.modules["common_utils"], "__file__", ""
    ).endswith("feature-svc/common_utils.py"):
        return sys.modules["common_utils"]
    if "common_utils" in sys.modules:
        del sys.modules["common_utils"]
    spec = importlib.util.spec_from_file_location("common_utils", SVC_DIR / "common_utils.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["common_utils"] = mod
    spec.loader.exec_module(mod)
    return mod


def _load_routers():
    """确保 factors 包和 common_utils 都加载 OK 后 import routers.factors"""
    # factors
    if "factors" not in sys.modules or not hasattr(sys.modules["factors"], "compute_factor_batch"):
        factors_dir = SVC_DIR / "factors"
        for key in list(sys.modules.keys()):
            if key == "factors" or key.startswith("factors."):
                del sys.modules[key]
        spec = importlib.util.spec_from_file_location(
            "factors",
            factors_dir / "__init__.py",
            submodule_search_locations=[str(factors_dir)],
        )
        mod = importlib.util.module_from_spec(spec)
        sys.modules["factors"] = mod
        spec.loader.exec_module(mod)

    _load_cu()

    # 加 feature-svc 到 path 让 routers.factors 能被 import
    sv_str = str(SVC_DIR)
    if sv_str not in sys.path:
        sys.path.insert(0, sv_str)

    if "routers" in sys.modules:
        del sys.modules["routers"]
    if "routers.factors" in sys.modules:
        del sys.modules["routers.factors"]

    spec = importlib.util.spec_from_file_location(
        "routers.factors", SVC_DIR / "routers" / "factors.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["routers.factors"] = mod
    spec.loader.exec_module(mod)
    return mod


_rf = _load_routers()


# ═══════════════════════════════════════════════════════════════
# Pydantic 模型
# ═══════════════════════════════════════════════════════════════


class TestFactorCreateRequest:
    def test_minimal_valid(self):
        req = _rf.FactorCreateRequest(name="my", formula="close > 0")
        assert req.name == "my"
        assert req.category == "custom"  # 默认
        assert req.formula_type == "dsl"
        assert req.visibility == "private"

    def test_name_empty_rejected(self):
        with pytest.raises(Exception):
            _rf.FactorCreateRequest(name="", formula="close > 0")

    def test_visibility_pattern(self):
        with pytest.raises(Exception):
            _rf.FactorCreateRequest(name="x", formula="close > 0", visibility="weird")


class TestFactorUpdateRequest:
    def test_all_optional(self):
        req = _rf.FactorUpdateRequest()  # 允许空 patch
        assert req.name is None
        assert req.formula is None

    def test_partial(self):
        req = _rf.FactorUpdateRequest(description="new desc", tags=["a", "b"])
        assert req.description == "new desc"
        assert req.tags == ["a", "b"]


class TestBatchQueryRequest:
    def test_limits(self):
        _rf.BatchQueryRequest(factor_ids=["a", "b"], symbols=["x"], date="2024-10-01")

    def test_factor_ids_min_length(self):
        with pytest.raises(Exception):
            _rf.BatchQueryRequest(factor_ids=[], symbols=["x"], date="2024-10-01")

    def test_max_length(self):
        # 51 个因子应该被拒
        with pytest.raises(Exception):
            _rf.BatchQueryRequest(
                factor_ids=[f"f{i}" for i in range(51)],
                symbols=["x"],
                date="2024-10-01",
            )


class TestCompareRequest:
    def test_default_metrics(self):
        r = _rf.CompareRequest(factor_ids=["a", "b"], start="2024-01-01", end="2024-12-31")
        assert "trigger_count" in r.metrics
        assert "trigger_rate" in r.metrics

    def test_min_2_factors(self):
        with pytest.raises(Exception):
            _rf.CompareRequest(factor_ids=["a"], start="x", end="y")


# ═══════════════════════════════════════════════════════════════
# 辅助函数
# ═══════════════════════════════════════════════════════════════


class TestHelpers:
    def test_get_user_id_fallback(self):
        assert _rf._get_user_id(None) == "anon"
        assert _rf._get_user_id("") == "anon"
        assert _rf._get_user_id("abc") == "abc"

    def test_gen_custom_factor_id_uniqueness(self):
        ids = {_rf._gen_custom_factor_id("x", "user01") for _ in range(100)}
        assert len(ids) == 100  # uuid4 几乎不可能碰撞

    def test_gen_custom_factor_id_format(self):
        fid = _rf._gen_custom_factor_id("my factor", "user01xxx")
        assert fid.startswith("custom_user01xx_")
        assert len(fid.split("_")) == 3  # custom / user / short_uuid


class TestInferFromFormula:
    def test_dsl_valid(self):
        out, lb, ast = _rf._infer_from_formula("MA(close, 20) > 100", "dsl")
        assert out == "boolean"
        assert lb == 20
        assert ast is not None
        assert ast["type"] == "binop"

    def test_dsl_invalid_formula_raises(self):
        with pytest.raises(HTTPException) as exc_info:
            _rf._infer_from_formula("MA(close", "dsl")
        # HTTPException 里 error.code 埋在 detail
        assert exc_info.value.status_code == 422
        body = exc_info.value.detail
        assert body["error"]["code"] in ("invalid_formula", "INVALID_FORMULA")

    def test_dsl_unknown_function_raises(self):
        with pytest.raises(HTTPException) as exc_info:
            _rf._infer_from_formula("UNKNOWN_FN(close)", "dsl")
        assert exc_info.value.status_code == 422
        body = exc_info.value.detail
        assert body["error"]["code"] in ("unknown_function", "UNKNOWN_FUNCTION")

    def test_python_returns_defaults(self):
        """Python 类型暂不支持解析，返回默认"""
        out, lb, ast = _rf._infer_from_formula("df['close'] > 0", "python")
        assert out == "scalar"
        assert lb == 0
        assert ast is None
