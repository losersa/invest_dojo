"""infer-svc 真实模型推理（Epic 3 T-3.03 落地）

严格复用训练侧 `train_svc.pipeline.build_dataset` 复现与训练**完全相同**的
特征工程（含 target_symbol 单只预测模式 + 同板块横截面 peer/pool 特征），
并还原训练时的股票池/同业映射，确保「线上输入 == 训练输入」，杜绝特征错位。

关键不变量（对应「线上拿不到的数据不得出现在训练特征」红线）：
- 推理快照严格取 as_of 当日（train_start == train_end == as_of_date），
  只用当日及以前已存在的因子值，绝不触碰未来数据。
- peer/pool 横截面特征使用训练时的股票池快照（metadata.symbols）作为参照系，
  与训练时一致。
- 预测口径与训练评估一致：proba >= cls_threshold → BUY。
"""
from __future__ import annotations

import os
import re
import sys
import time
from datetime import UTC, datetime
from typing import Any

import numpy as np
import pandas as pd

from common import get_logger, get_pg_client
from common.minio_client import download_bytes
from common_utils import (
    InferenceRequest,
    Signal,
    SignalExplanation,
    SignalMetadata,
)

logger = get_logger("infer.real_predict")


# ── 跨服务复用 train-svc 的特征工程（保证与训练特征严格一致）──
_TRAIN_SVC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "train-svc"
)
if _TRAIN_SVC not in sys.path:
    sys.path.insert(0, _TRAIN_SVC)


def _parse_horizon(target: str) -> int | None:
    m = re.search(r"_(\d+)d$", str(target))
    return int(m.group(1)) if m else None


def _fetch_model_record(model_id: str) -> dict:
    client = get_pg_client()
    rows = client.select("models", columns="*", filters={"id": f"eq.{model_id}"})
    if not rows:
        raise ValueError(f"模型不存在：{model_id}")
    return rows[0]


def _fetch_training_symbols(model: dict) -> list[str] | None:
    client = get_pg_client()
    metadata = model.get("metadata") or {}
    train_symbols = metadata.get("symbols")
    if train_symbols is None and model.get("training_job_id"):
        job_rows = client.select(
            "training_jobs",
            columns="config",
            filters={"job_id": f"eq.{model['training_job_id']}"},
        )
        if job_rows:
            train_symbols = (job_rows[0].get("config") or {}).get("symbols")
    return train_symbols


def predict_real(req: InferenceRequest) -> list[dict]:
    """真实模型单次推理，返回与 mock 同构的 Signal 列表（单 target_symbol）。"""
    t0 = time.perf_counter()

    # 延迟导入重依赖，避免影响 mock 路径 / 无 lightgbm 的部署
    import lightgbm as lgb  # noqa: E402
    from pipeline import build_dataset  # noqa: E402

    # 1. 拉取模型元数据
    model = _fetch_model_record(req.model_id)
    metadata = model.get("metadata") or {}
    file_path = model.get("file_path")
    input_features = model.get("input_features") or []
    target = model.get("target") or "return_5d"
    target_symbol = metadata.get("target_symbol")
    if not target_symbol:
        raise ValueError(
            f"模型 {req.model_id} 未记录 target_symbol（非单只预测模型），"
            "真实推理暂仅支持预测单只股票的模型"
        )
    cls_threshold = metadata.get("cls_threshold")
    label_spec = metadata.get("label_spec") or {"kind": "return", "threshold": 0.0}
    peer = metadata.get("peer") or {"enabled": False}

    train_symbols = _fetch_training_symbols(model)
    if not file_path:
        raise ValueError(f"模型 {req.model_id} 缺少 file_path，无法加载 Booster")

    # 2. as_of → 当日快照（严格 point-in-time）
    as_of_dt = datetime.fromisoformat(req.as_of.replace("Z", "+00:00"))
    if as_of_dt.tzinfo is None:
        as_of_dt = as_of_dt.replace(tzinfo=UTC)
    as_of_date = as_of_dt.date().isoformat()

    # 3. 加载 Booster
    raw = download_bytes(file_path)
    booster = lgb.Booster(model_str=raw.decode("utf-8"))

    n_expect = booster.num_feature()
    if len(input_features) != n_expect:
        raise ValueError(
            f"模型特征数不一致：input_features={len(input_features)}，"
            f"booster 期望 {n_expect}，无法安全对齐"
        )

    # 4. 复现训练特征工程（与训练严格一致，仅取 as_of 当日快照）
    df, _used = build_dataset(
        factor_ids=list(input_features),
        target=target,
        train_start=as_of_date,
        train_end=as_of_date,
        symbols=list(train_symbols) if train_symbols else None,
        label_spec=label_spec,
        target_symbol=target_symbol,
        peer=peer,
        feature_page_size=1_000_000,
    )
    if df.empty:
        raise ValueError(
            f"目标股票 {target_symbol} 在 {as_of_date} 无可用因子样本"
            f"（可能当日因子尚未入库，或不在训练池中）"
        )

    # 只取 target_symbol 在 as_of 当日的那一行
    row = df[df["symbol"] == target_symbol]
    if row.empty:
        raise ValueError(
            f"目标股票 {target_symbol} 不在 build_dataset 输出中"
            f"（训练池={train_symbols}）"
        )
    row = row.iloc[[0]].copy()

    # feature_overrides（测试/回测用，覆盖特征值）
    overrides = req.feature_overrides or {}
    if target_symbol in overrides:
        for feat, val in overrides[target_symbol].items():
            if feat in row.columns:
                row[feat] = float(val)
            else:
                logger.warning(
                    "infer.real_predict.override_unknown_feature", feature=feat
                )

    # 5. 预测
    pred = np.asarray(booster.predict(row[list(input_features)].astype(float).values),
                     dtype=float).ravel()[0]

    if cls_threshold is not None:
        thr = float(cls_threshold)
        is_buy = pred >= thr
        confidence = float(np.clip(pred, 0.0, 1.0))
    else:
        # 回归模型：sign 决策，概率做 sigmoid 压缩
        thr = 0.0
        is_buy = pred > 0
        confidence = float(np.clip(1.0 / (1.0 + np.exp(-pred)), 0.0, 1.0))
    action = "BUY" if is_buy else "HOLD"

    # 6. 解释（可选）
    explanation: SignalExplanation | None = None
    if req.include_explanation:
        try:
            contrib = np.asarray(
                booster.predict(
                    row[list(input_features)].astype(float).values, pred_contrib=True
                ),
                dtype=float,
            )
            if contrib.ndim == 2:
                contrib = contrib[0]
            contrib = contrib[:-1]  # 去掉 base value
            pairs = sorted(
                zip(input_features, contrib), key=lambda x: abs(x[1]), reverse=True
            )[:10]
            explanation = SignalExplanation(
                top_positive_factors=[
                    {"feature": f, "contribution": float(c)}
                    for f, c in pairs
                    if c > 0
                ],
                top_negative_factors=[
                    {"feature": f, "contribution": float(c)}
                    for f, c in pairs
                    if c < 0
                ],
                thesis=(
                    f"模型 {req.model_id} 在 {as_of_date} 对 {target_symbol} "
                    f"预测概率 {confidence:.3f}，阈值 {thr:.3f} → {action}"
                ),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("infer.real_predict.explanation_failed", error=str(exc))

    # 实际特征值（透明化，NaN 不进字典避免 JSON 序列化问题）
    features: dict[str, float] = {}
    for f in input_features:
        v = row[f].iloc[0]
        if pd.isna(v):
            continue
        features[f] = round(float(v), 6)

    horizon = _parse_horizon(target) or (metadata.get("label_spec") or {}).get("horizon")
    sig = Signal(
        timestamp=datetime.now(UTC).isoformat(),
        as_of=req.as_of,
        symbol=target_symbol,
        action=action,
        confidence=confidence,
        score=round(float(pred), 6),
        target_position=round(confidence, 4) if is_buy else 0.0,
        holding_horizon_days=int(horizon) if horizon else None,
        features=features,
        explanation=explanation,
        metadata=SignalMetadata(
            model_id=req.model_id,
            model_version=req.model_version or "current",
            inference_time_ms=int((time.perf_counter() - t0) * 1000),
            seed=None,
        ),
    )
    return [sig.model_dump(exclude_none=False)]
