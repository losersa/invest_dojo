"""infer-svc 单元测试

覆盖：
1. as_of 必填 / 格式校验 / 未来时间拒绝
2. mock 模型决定性
3. Signal 格式契约
4. InferenceRequest 校验（symbols 去重 / 上限 50）
"""
from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException

SVC_DIR = Path(__file__).parent.parent / "infer-svc"


def _load_module(path: Path, name: str):
    if name in sys.modules:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# 分别加载，避免与其他 svc 的 common_utils 冲突
_cu = _load_module(SVC_DIR / "common_utils.py", "infer_svc_common_utils")
parse_and_validate_as_of = _cu.parse_and_validate_as_of
InferenceRequest = _cu.InferenceRequest
Signal = _cu.Signal
ErrorCode = _cu.ErrorCode

_mock = _load_module(SVC_DIR / "mock_model.py", "infer_svc_mock_model")
predict_one = _mock.predict_one
KNOWN_MOCK_MODELS = _mock.KNOWN_MOCK_MODELS


# ──────────────────────────────────────────
# as_of 校验
# ──────────────────────────────────────────
def test_as_of_required_missing():
    with pytest.raises(HTTPException) as ei:
        parse_and_validate_as_of("")
    assert ei.value.status_code == 400
    assert ei.value.detail["error"]["code"] == ErrorCode.MISSING_AS_OF


def test_as_of_invalid_format():
    with pytest.raises(HTTPException) as ei:
        parse_and_validate_as_of("not-a-date")
    assert ei.value.status_code == 400
    assert ei.value.detail["error"]["code"] == ErrorCode.INVALID_PARAM


def test_as_of_past_ok():
    dt = parse_and_validate_as_of("2024-03-15T15:00:00Z")
    assert dt.year == 2024


def test_as_of_date_only():
    dt = parse_and_validate_as_of("2024-03-15")
    assert dt.year == 2024


def test_as_of_future_rejected():
    future = (datetime.now(timezone.utc) + timedelta(days=365)).isoformat()
    with pytest.raises(HTTPException) as ei:
        parse_and_validate_as_of(future)
    assert ei.value.status_code == 403
    assert ei.value.detail["error"]["code"] == ErrorCode.FUTURE_AS_OF


def test_as_of_within_60s_skew_allowed():
    """允许 60 秒 clock skew（联动时钟可能稍领先）"""
    near_future = (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat()
    # 不应抛异常
    parse_and_validate_as_of(near_future)


# ──────────────────────────────────────────
# InferenceRequest 校验
# ──────────────────────────────────────────
def test_request_symbols_dedup():
    req = InferenceRequest(
        model_id="mock_momentum_v1",
        symbols=["600519", "600519", "000001"],
        as_of="2024-03-15T15:00:00Z",
    )
    assert req.symbols == ["600519", "000001"]


def test_request_symbols_max_50():
    with pytest.raises(Exception):
        InferenceRequest(
            model_id="mock_momentum_v1",
            symbols=[f"0000{i:02d}" for i in range(51)],
            as_of="2024-03-15T15:00:00Z",
        )


def test_request_model_id_required():
    with pytest.raises(Exception):
        InferenceRequest(
            model_id="",
            symbols=["600519"],
            as_of="2024-03-15T15:00:00Z",
        )


# ──────────────────────────────────────────
# mock 模型
# ──────────────────────────────────────────
def test_predict_one_deterministic():
    """同 (model_id, symbol, as_of) → 同输出"""
    args = ("mock_momentum_v1", "600519", "2024-03-15T15:00:00Z")
    kw = {"include_explanation": False, "feature_override": None}
    r1 = predict_one(*args, **kw)
    r2 = predict_one(*args, **kw)
    # 抹掉非决定性字段
    for r in (r1, r2):
        r.pop("timestamp")
        r["metadata"].pop("inference_time_ms")
    assert r1 == r2


def test_predict_one_different_symbol_different_seed():
    """不同 symbol 应拿到不同 seed"""
    r1 = predict_one("mock_momentum_v1", "600519", "2024-03-15T15:00:00Z",
                     include_explanation=False, feature_override=None)
    r2 = predict_one("mock_momentum_v1", "000001", "2024-03-15T15:00:00Z",
                     include_explanation=False, feature_override=None)
    assert r1["metadata"]["seed"] != r2["metadata"]["seed"]


def test_predict_one_signal_validates():
    """输出能喂给 Signal pydantic 并通过校验"""
    r = predict_one("mock_momentum_v1", "600519", "2024-03-15T15:00:00Z",
                    include_explanation=True, feature_override=None)
    sig = Signal(**r)
    assert sig.action in {"BUY", "SELL", "HOLD"}
    assert 0 <= sig.confidence <= 1
    assert sig.metadata.model_id == "mock_momentum_v1"
    if sig.action == "BUY":
        assert sig.target_position is not None and sig.target_position > 0


def test_predict_one_feature_override():
    """override 应覆盖 mock 生成值"""
    override = {"rsi_14": 20.0, "ma_cross_5_20": 1.0}
    r = predict_one("mock_momentum_v1", "600519", "2024-03-15T15:00:00Z",
                    include_explanation=False, feature_override=override)
    assert r["features"]["rsi_14"] == 20.0
    assert r["features"]["ma_cross_5_20"] == 1.0


def test_predict_one_unknown_model_fallback():
    """未登记模型也能跑，不会抛异常"""
    r = predict_one("some_unknown_model", "600519", "2024-03-15T15:00:00Z",
                    include_explanation=False, feature_override=None)
    assert r["action"] in {"BUY", "SELL", "HOLD"}
    assert r["metadata"]["model_id"] == "some_unknown_model"


# ──────────────────────────────────────────
# Signal 契约
# ──────────────────────────────────────────
def test_signal_confidence_bounds():
    """confidence 必须在 [0, 1]"""
    with pytest.raises(Exception):
        Signal(
            timestamp="2026-01-01T00:00:00Z",
            as_of="2024-03-15",
            symbol="600519",
            action="BUY",
            confidence=1.5,
            metadata={
                "model_id": "m",
                "model_version": "v1",
                "inference_time_ms": 10,
            },
        )


def test_signal_action_enum():
    """action 只能是 BUY/SELL/HOLD"""
    with pytest.raises(Exception):
        Signal(
            timestamp="2026-01-01T00:00:00Z",
            as_of="2024-03-15",
            symbol="600519",
            action="YOLO",
            confidence=0.5,
            metadata={
                "model_id": "m",
                "model_version": "v1",
                "inference_time_ms": 10,
            },
        )


# ──────────────────────────────────────────
# mock 模型白名单契约
# ──────────────────────────────────────────
def test_known_mock_models_nonempty():
    assert len(KNOWN_MOCK_MODELS) >= 3
    for k, v in KNOWN_MOCK_MODELS.items():
        assert "version" in v
        assert "description" in v
