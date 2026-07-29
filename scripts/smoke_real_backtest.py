#!/usr/bin/env python3
"""真实回测引擎最小冒烟脚本。

链路：PostgREST 找一个带 target_symbol 的模型 → 调 backtest-svc /run-fast
（strategy.type=model）→ 校验返回 engine=real、净值曲线非空、指标齐全。

用法（需 backtest-svc 及本地 Supabase 栈已启动）：
    python scripts/smoke_real_backtest.py                  # 自动选最新的单只预测模型
    python scripts/smoke_real_backtest.py <model_id>       # 指定模型
    python scripts/smoke_real_backtest.py <model_id> 2025-01-01 2025-06-30

环境变量：SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BACKTEST_URL
退出码：0 通过；1 失败。
"""

import json
import os
import sys
from datetime import date, timedelta

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://localhost:8000")
SUPABASE_SERVICE_KEY = os.environ.get(
    "SUPABASE_SERVICE_ROLE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoiaW52ZXN0ZG9qby1zdXBhYmFzZS1saXRlIiwiaWF0IjoxNzc3NjYwMzYyLCJleHAiOjIwOTMwMjAzNjJ9.fcNS9vkbGydIjrQxAx55gdq4ubC08BwA1aQA6C8LcQM",
)
BACKTEST_URL = os.environ.get("BACKTEST_URL", "http://localhost:8004")

HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
}


def fail(msg: str) -> None:
    print(f"❌ FAIL: {msg}")
    sys.exit(1)


def pick_model(model_id: str | None) -> dict:
    """取指定模型；未指定则自动选最新的带 target_symbol 的模型。"""
    url = f"{SUPABASE_URL}/rest/v1/models"
    params = {
        "select": "id,name,target,status,metadata,created_at",
        "order": "created_at.desc",
        "limit": "20",
    }
    if model_id:
        params["id"] = f"eq.{model_id}"
    resp = requests.get(url, headers=HEADERS, params=params, timeout=15)
    if resp.status_code != 200:
        fail(f"查询 models 失败：{resp.status_code} {resp.text[:200]}")
    rows = resp.json()
    if model_id:
        if not rows:
            fail(f"模型不存在：{model_id}")
        return rows[0]
    for r in rows:
        if (r.get("metadata") or {}).get("target_symbol"):
            return r
    fail("未找到任何带 metadata.target_symbol 的模型（请先训练一个单只预测模型）")
    raise SystemExit  # unreachable


def main() -> None:
    model_id = sys.argv[1] if len(sys.argv) > 1 else None
    start = sys.argv[2] if len(sys.argv) > 2 else str(date.today() - timedelta(days=240))
    end = sys.argv[3] if len(sys.argv) > 3 else str(date.today())

    # ── 1. 选模型 ──
    model = pick_model(model_id)
    target_symbol = (model.get("metadata") or {}).get("target_symbol")
    print(f"→ 模型: {model['id']}  name={model.get('name')}  target_symbol={target_symbol}")
    if not target_symbol:
        fail("该模型无 metadata.target_symbol（非单只预测模型），真实引擎不支持")

    # ── 2. 调 run-fast ──
    config = {
        "mode": "fast",
        "strategy": {"type": "model", "model_id": model["id"]},
        "start": start,
        "end": end,
        "universe": "__model__",
        "initial_capital": 1_000_000,
        "advanced": {"include_trade_log": True},
    }
    print(f"→ POST {BACKTEST_URL}/api/v1/backtests/run-fast  [{start} ~ {end}]")
    resp = requests.post(
        f"{BACKTEST_URL}/api/v1/backtests/run-fast", json=config, timeout=300
    )
    if resp.status_code != 200:
        fail(f"run-fast 返回 {resp.status_code}：{resp.text[:500]}")
    body = resp.json()
    # 响应结构：{"data": {...结果...}, "meta": {...engine 等...}}（meta 与 data 平级）
    result = body.get("data") if isinstance(body.get("data"), dict) else body

    # ── 3. 校验 ──
    meta = body.get("meta") or result.get("meta") or {}
    summary = result.get("summary") or {}
    curve = result.get("equity_curve") or {}
    trades = result.get("trades")

    checks = [
        ("engine == real", meta.get("engine") == "real"),
        ("meta.target_symbol 与模型一致", meta.get("target_symbol") == target_symbol),
        ("净值曲线非空", len(curve.get("portfolio") or []) > 0),
        ("日期与净值等长", len(curve.get("dates") or []) == len(curve.get("portfolio") or [])),
        ("summary 含 total_return", "total_return" in summary),
        ("summary 含 sharpe", "sharpe" in summary),
        ("summary 含 max_drawdown", "max_drawdown" in summary),
    ]
    ok = True
    for name, passed in checks:
        print(f"  {'✅' if passed else '❌'} {name}")
        ok = ok and passed

    n_trades = len(trades) if isinstance(trades, list) else 0
    print(
        f"→ 样本={meta.get('n_samples')}  信号={meta.get('n_signals')}  "
        f"交易={n_trades}  阈值={meta.get('cls_threshold')}"
    )
    print(
        f"→ 总收益={summary.get('total_return')}  年化={summary.get('annual_return')}  "
        f"夏普={summary.get('sharpe')}  最大回撤={summary.get('max_drawdown')}"
    )
    if meta.get("n_signals") == 0:
        print("⚠️  区间内无买入信号（净值应为纯现金水平线），链路本身正常")

    if not ok:
        print(json.dumps(result, ensure_ascii=False, default=str)[:1000])
        fail("部分校验未通过")
    print("✅ SMOKE PASS")


if __name__ == "__main__":
    main()
