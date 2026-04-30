"""mock 模型：根据 model_id 和 as_of 做可决定性的假推理

MVP 用途：
- 给前端/副驾联调提供稳定、可预测的输出
- Epic 3 T-3.03 后替换为真实 LightGBM 模型加载

决定性：
- 同 (model_id, symbol, as_of) 组合 → 同输出
- 用 hash 驱动随机数，保证可重现
"""
from __future__ import annotations

import hashlib
import random
import time
from datetime import datetime, timezone
from typing import Any


# 内置 mock 模型白名单（避免用户随便写个 id 都能跑通）
KNOWN_MOCK_MODELS = {
    "mock_momentum_v1": {"version": "1.0.0", "description": "趋势动量（mock）"},
    "mock_reversal_v1": {"version": "1.0.0", "description": "反转（mock）"},
    "mock_random_v1": {"version": "1.0.0", "description": "随机基线（mock）"},
    "mock_platform_default": {"version": "1.0.0", "description": "平台默认（mock）"},
}

# ↑ Epic 3 换成从 models 表读取


def _seed_from(*parts: str) -> int:
    """拼接后 sha256，取前 8 字节做 seed"""
    joined = "|".join(parts)
    h = hashlib.sha256(joined.encode()).digest()
    return int.from_bytes(h[:8], byteorder="big", signed=False)


def _pick_action(score: float) -> str:
    """score ∈ [-1, 1]"""
    if score > 0.2:
        return "BUY"
    if score < -0.2:
        return "SELL"
    return "HOLD"


def predict_one(
    model_id: str,
    symbol: str,
    as_of: str,
    *,
    include_explanation: bool,
    feature_override: dict[str, float] | None,
) -> dict[str, Any]:
    """返回 dict，外层会喂给 pydantic Signal 做格式化"""
    t_start = time.perf_counter()

    info = KNOWN_MOCK_MODELS.get(model_id)
    if info is None:
        # 未知模型直接走 mock_platform_default 的权重
        info = {"version": "1.0.0", "description": f"unknown (fallback) {model_id}"}

    # ── 可决定性随机 ─────
    seed = _seed_from(model_id, symbol, as_of)
    rng = random.Random(seed)

    # 随机特征（保持和示范因子一致）
    features = {
        "ma_cross_5_20": rng.choice([0.0, 1.0]),
        "rsi_14": round(rng.uniform(10, 90), 2),
        "macd_hist": round(rng.uniform(-2, 2), 3),
        "volume_ratio": round(rng.uniform(0.5, 3.5), 2),
        "pb": round(rng.uniform(0.5, 8), 2),
        "roe_ttm": round(rng.uniform(-0.1, 0.3), 3),
    }

    # 合并 override
    if feature_override:
        features.update(feature_override)

    # ── 假打分逻辑 ─────
    # mock_momentum：正向依赖 ma_cross + volume_ratio，反向依赖 rsi_14 过高
    # mock_reversal：rsi_14 越低越看多
    # 其他：纯随机
    if "momentum" in model_id:
        score = (
            features["ma_cross_5_20"] * 0.4
            + (features["volume_ratio"] - 1) * 0.2
            + (50 - features["rsi_14"]) / 100
        )
    elif "reversal" in model_id:
        score = (50 - features["rsi_14"]) / 50 * 0.6 - features["macd_hist"] * 0.1
    else:
        score = rng.uniform(-0.9, 0.9)

    # normalize to [-1, 1]
    score = max(-1.0, min(1.0, score))
    confidence = abs(score) * 0.7 + 0.2  # 0.2~0.9
    confidence = round(min(0.95, confidence), 3)
    action = _pick_action(score)

    target_position = None
    if action == "BUY":
        target_position = round(min(0.5, confidence), 3)
    elif action == "SELL":
        target_position = 0.0

    explanation = None
    if include_explanation:
        # 简单粗暴：正/负贡献就是 feature value * 系数
        contribs = [
            ("ma_cross_5_20", features["ma_cross_5_20"] * 0.4),
            ("volume_ratio", (features["volume_ratio"] - 1) * 0.2),
            ("rsi_14", (50 - features["rsi_14"]) / 100),
            ("macd_hist", features["macd_hist"] * 0.1),
        ]
        pos = sorted([c for c in contribs if c[1] > 0], key=lambda x: -x[1])[:3]
        neg = sorted([c for c in contribs if c[1] < 0], key=lambda x: x[1])[:3]
        if action == "BUY":
            thesis = "正向因子占优（mock）"
        elif action == "SELL":
            thesis = "负向因子占优（mock）"
        else:
            thesis = "因子混合，信号不明确（mock）"
        explanation = {
            "top_positive_factors": [{"name": n, "contribution": round(c, 3)} for n, c in pos],
            "top_negative_factors": [{"name": n, "contribution": round(c, 3)} for n, c in neg],
            "thesis": thesis,
        }

    elapsed_ms = max(1, int((time.perf_counter() - t_start) * 1000))

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "as_of": as_of,
        "symbol": symbol,
        "action": action,
        "confidence": confidence,
        "score": round(score, 4),
        "target_position": target_position,
        "holding_horizon_days": 5,
        "features": features,
        "explanation": explanation,
        "metadata": {
            "model_id": model_id,
            "model_version": info["version"],
            "inference_time_ms": elapsed_ms,
            "seed": seed & 0xFFFFFFFF,  # 截断到 32 位便于展示
        },
    }
