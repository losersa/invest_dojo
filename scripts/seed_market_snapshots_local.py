#!/usr/bin/env python3
"""市场快照采集 - 本地栈版本

数据来源：
- BaoStock：5 个指数（上证/深证/创业板/沪深300/中证500）
- AKShare：北向资金（沪股通+深股通）
- 涨跌家数：跳过（本地只有 5m K线，无 1d 数据）

用法：
    cd investdojo/python-services
    python ../scripts/seed_market_snapshots_local.py
    python ../scripts/seed_market_snapshots_local.py --from 2024-01-01 --to 2026-04-30
"""
import argparse
import json
import os
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import baostock as bs
import pandas as pd
import requests

try:
    import akshare as ak
except ImportError:
    ak = None
    print("⚠ akshare 未安装，北向资金将跳过")

# ── 配置（本地 Supabase Lite）──
SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://localhost:8000")
SUPABASE_SERVICE_KEY = os.environ.get(
    "SUPABASE_SERVICE_ROLE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoiaW52ZXN0ZG9qby1zdXBhYmFzZS1saXRlIiwiaWF0IjoxNzc3NjYwMzYyLCJleHAiOjIwOTMwMjAzNjJ9.fcNS9vkbGydIjrQxAx55gdq4ubC08BwA1aQA6C8LcQM",
)

HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=minimal",
}

REST_URL = f"{SUPABASE_URL}/rest/v1/market_snapshots?on_conflict=date"

INDEX_CODES = {
    "sh000001": "sh.000001",  # 上证综指
    "sz399001": "sz.399001",  # 深证成指
    "sz399006": "sz.399006",  # 创业板指
    "sh000300": "sh.000300",  # 沪深300
    "sh000905": "sh.000905",  # 中证500
}


# ─── 1. 拉指数 ────────────────────────────────────────────
def fetch_indexes(start_date: str, end_date: str) -> dict:
    """返回 {date: {index_code: {close, change_pct, volume, amount, preclose}}}"""
    print("  📈 拉 5 个指数...")
    bs.login()
    result = {}
    for key, code in INDEX_CODES.items():
        rs = bs.query_history_k_data_plus(
            code,
            "date,close,preclose,volume,amount,pctChg",
            start_date=start_date,
            end_date=end_date,
            frequency="d",
            adjustflag="3",
        )
        cnt = 0
        while rs.error_code == "0" and rs.next():
            row = rs.get_row_data()
            d = row[0]
            if d not in result:
                result[d] = {}
            try:
                result[d][key] = {
                    "close": float(row[1]) if row[1] else None,
                    "preclose": float(row[2]) if row[2] else None,
                    "volume": float(row[3]) if row[3] else None,
                    "amount": float(row[4]) if row[4] else None,
                    "change_pct": float(row[5]) if row[5] else None,
                }
                cnt += 1
            except ValueError:
                pass
        print(f"    {code}: {cnt} 行")
    bs.logout()
    print(f"  ✅ 指数 {len(result)} 个交易日")
    return result


# ─── 2. 拉北向资金 ─────────────────────────────────────
def fetch_north_capital() -> dict:
    """返回 {date: 当日净买入万元（沪+深）}"""
    if ak is None:
        print("  ⚠ akshare 未安装，跳过北向资金")
        return {}

    print("  💰 拉北向资金（沪+深）...")
    result = {}
    backoff = [2, 4, 8, 16, 32]

    for name in ["沪股通", "深股通"]:
        df = None
        for retry, wait in enumerate(backoff):
            try:
                df = ak.stock_hsgt_hist_em(symbol=name)
                if df is not None and len(df) > 0:
                    break
                raise RuntimeError("empty result")
            except Exception as e:
                err_type = type(e).__name__
                if retry == len(backoff) - 1:
                    print(f"    ❌ {name} 失败（{err_type}）: {e}")
                    df = None
                    break
                print(f"    ⚠ {name} 第 {retry + 1} 次失败（{err_type}），{wait}s 后重试")
                time.sleep(wait)
        if df is None or len(df) == 0:
            continue
        print(f"    {name}: {len(df)} 行")
        for _, row in df.iterrows():
            d = str(row["日期"])
            amt = row["当日成交净买额"]
            try:
                amt = float(amt)
                if pd.isna(amt):
                    amt = 0
            except (ValueError, TypeError):
                amt = 0
            if d not in result:
                result[d] = 0
            result[d] += amt

    print(f"  ✅ 北向资金 {len(result)} 个交易日")
    return result


# ─── 3. 上传 ─────────────────────────────────────────────
def upsert_snapshots(snapshots: list):
    """批量 upsert 到 market_snapshots（本地 PostgREST）"""
    BATCH = 500
    total = 0
    fail = 0
    for i in range(0, len(snapshots), BATCH):
        chunk = snapshots[i : i + BATCH]
        try:
            resp = requests.post(REST_URL, headers=HEADERS, json=chunk, timeout=60)
            if resp.status_code in (200, 201, 204):
                total += len(chunk)
            else:
                print(f"\n  ❌ 批次 {i // BATCH}: {resp.status_code} {resp.text[:200]}")
                fail += len(chunk)
        except Exception as e:
            print(f"\n  ❌ 批次 {i // BATCH}: {e}")
            fail += len(chunk)
        sys.stdout.write(f"\r  ↑ 已上传 {total}/{len(snapshots)}")
        sys.stdout.flush()
    print()
    return total, fail


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--from", dest="start", default="2014-01-01")
    parser.add_argument("--to", dest="end", default="2026-04-30")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-north", action="store_true", help="跳过北向资金（加速）")
    args = parser.parse_args()

    print("══════════════════════════════════════════")
    print("  📸 市场快照采集（本地栈版本）")
    print(f"  范围: {args.start} ~ {args.end}")
    print("══════════════════════════════════════════\n")

    t0 = time.time()

    # 1. 指数
    idx = fetch_indexes(args.start, args.end)

    # 2. 北向资金
    if args.skip_north:
        print("  ⏭ 跳过北向资金")
        nc = {}
    else:
        nc = fetch_north_capital()

    # 3. 组装（涨跌家数暂跳过，因为本地没有 1d K 线数据）
    all_dates = sorted(set(idx) | set(nc))
    all_dates = [d for d in all_dates if args.start <= d <= args.end]
    print(f"\n  🧩 合并：共 {len(all_dates)} 个不重复日期")

    snapshots = []
    for d in all_dates:
        nc_val = nc.get(d)
        if nc_val is not None and pd.isna(nc_val):
            nc_val = None
        snap = {
            "date": d,
            "indexes": idx.get(d) or None,
            "north_capital": nc_val,
            "advance_decline": None,
            "money_flow": None,
            "top_industries": None,
        }
        snapshots.append(snap)

    # 打印样本
    if snapshots:
        print(f"\n  📝 样本（最新 1 条）:")
        print(json.dumps(snapshots[-1], ensure_ascii=False, indent=2, default=str))

    if args.dry_run:
        print(f"\n  🧪 dry-run，已生成 {len(snapshots)} 条，不入库")
        return

    # 4. 上传
    print(f"\n  💾 上传到 market_snapshots...")
    total, fail = upsert_snapshots(snapshots)

    elapsed = time.time() - t0
    print(f"\n  🏁 完成! 成功 {total} 行，失败 {fail} 行，耗时 {elapsed:.1f}s")


if __name__ == "__main__":
    main()
