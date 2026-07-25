#!/usr/bin/env python3
"""批量注册内置因子到 Supabase（T-3.03）

从 feature-svc/factors/builtin/*.yaml 加载所有因子，upsert 到 factor_definitions 表。

用法：
    python scripts/register_builtin_factors.py            # 注册 + 打印
    python scripts/register_builtin_factors.py --dry-run  # 只校验不写 DB
    python scripts/register_builtin_factors.py --verify   # 再跑 engine 校验

做的事：
1. 读 YAML
2. 解析公式 → 推断 lookback/output_type
3. 检查 id 唯一性
4. （可选）跑 engine 验证
5. Upsert 到 DB（id 冲突时合并）
"""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "python-services"))
sys.path.insert(0, str(Path(__file__).parent.parent / "python-services" / "feature-svc"))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from common.supabase_client import get_supabase_client  # noqa: E402
from factors.builtin_loader import (  # noqa: E402
    check_no_duplicate_ids,
    load_all_builtins,
    validate_with_engine,
)


def _make_dummy_panel(n_days: int = 260) -> dict:
    dates = pd.date_range("2024-01-01", periods=n_days, freq="B")
    rng = np.random.default_rng(42)
    syms = ["A", "B", "C"]
    close = pd.DataFrame(
        100 + np.cumsum(rng.standard_normal((n_days, 3)), axis=0),
        index=dates,
        columns=syms,
    )
    return {
        "close": close,
        "open": close.shift(1).fillna(close.iloc[0]),
        "high": close * 1.01,
        "low": close * 0.99,
        "volume": pd.DataFrame(
            rng.integers(1_000_000, 10_000_000, (n_days, 3)), index=dates, columns=syms
        ),
        "preclose": close.shift(1),
        "pct_change": close.pct_change(fill_method=None),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="不写 DB，只打印计划")
    parser.add_argument("--verify", action="store_true", help="跑 engine 验证每个因子可执行")
    args = parser.parse_args()

    print("═" * 58)
    print("  📚 InvestDojo 内置因子批量注册")
    print("═" * 58)

    factors = load_all_builtins()
    print(f"\n✅ 加载 {len(factors)} 个因子")

    check_no_duplicate_ids(factors)
    print("✅ id 唯一性检查通过")

    # 统计
    cats = Counter(f["category"] for f in factors)
    outs = Counter(f["output_type"] for f in factors)
    print(f"\n分类: {dict(cats)}")
    print(f"输出类型: {dict(outs)}")
    print(f"lookback 范围: {min(f['lookback_days'] for f in factors)} ~ {max(f['lookback_days'] for f in factors)}")

    if args.verify:
        print("\n🔬 逐一跑 engine 验证...")
        panel = _make_dummy_panel()
        failures = validate_with_engine(factors, panel)
        if failures:
            print(f"❌ {len(failures)} 个失败：")
            for fid, msg in failures:
                print(f"  {fid}: {msg}")
            sys.exit(1)
        print(f"✅ 所有 {len(factors)} 个因子 engine 执行通过")

    # 展示前 5 个
    print("\n前 5 个示例：")
    for f in factors[:5]:
        print(f"  {f['id']:<30} {f['output_type']:<8} lb={f['lookback_days']:<4} {f['name']}")

    if args.dry_run:
        print("\n🧪 dry-run 模式：不写入 DB")
        return

    # 写 Supabase
    # factor_definitions 的 tags 列是 jsonb 数组；Supabase 允许 list 直接序列化
    client = get_supabase_client()
    print(f"\n📥 upsert {len(factors)} 个因子到 factor_definitions...")

    # PostgREST 批量 upsert 要求所有对象 key 集合一致（踩过的坑 8）
    # 所以先统一补齐字段
    all_keys = set()
    for f in factors:
        all_keys.update(f.keys())
    normalized = []
    for f in factors:
        normalized.append({k: f.get(k) for k in all_keys})

    ok = 0
    fail = 0
    try:
        client.insert("factor_definitions", normalized, on_conflict="id")
        ok = len(normalized)
    except Exception as e:  # noqa: BLE001
        print(f"  ⚠ 批量失败: {e}")
        print("  → 逐条 upsert...")
        for f in normalized:
            try:
                client.insert("factor_definitions", [f], on_conflict="id")
                ok += 1
            except Exception as e2:  # noqa: BLE001
                print(f"    ❌ {f['id']}: {e2}")
                fail += 1

    print(f"\n══════════════════════════════════════════")
    print(f"  ✅ {ok} 成功  ❌ {fail} 失败 / 共 {len(factors)}")
    print(f"══════════════════════════════════════════")

    # 最终确认 DB 里的 platform 因子数
    rows = client.select(
        "factor_definitions", columns="id", filters={"owner": "eq.platform"}, limit=1000
    )
    print(f"\n📊 DB 中 owner=platform 因子总数: {len(rows)}")


if __name__ == "__main__":
    main()
