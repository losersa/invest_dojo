#!/usr/bin/env python3
"""T-1.06 市场快照采集.

数据来源：
- BaoStock 指数（上证/深证/创业板/沪深300/中证500）—— 2014-至今 全覆盖
- AKShare 北向资金（沪+深，沪股通 2014-11-17 起；深股通 2016-12-05 起）
- 本地 Supabase 日 K 聚合 advance_decline（涨跌家数/涨跌停）—— 2020-至今（日 K 覆盖范围）
- money_flow / top_industries 暂留 NULL（AKShare 历史源只有近期，后续再补）

字段 JSON schema:
- indexes: {"sh000001": {"close": 3000.0, "change_pct": 0.5, "volume": ..., "amount": ...}, ...}
- north_capital: numeric (当日北向净买入=沪+深, 万元)
- advance_decline: {"advance": N, "decline": N, "unchanged": N, "limit_up": N, "limit_down": N, "total": N}
- money_flow: null (后续)
- top_industries: null (后续)

性能：
- BaoStock 5 个指数一次性拉完（~15 秒）
- AKShare 北向一次性拉完（~3 秒）
- advance_decline 走 Management API，每年一次 SQL 聚合（~2 秒/年 × 13 年 = 30 秒）
- 总耗时 <1 分钟

用法：
    python scripts/seed_market_snapshots.py
    python scripts/seed_market_snapshots.py --from 2014-01-01 --to 2026-04-30
"""
import argparse
import json
import os
import subprocess
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import baostock as bs
import pandas as pd
import akshare as ak

ROOT = Path(__file__).parent.parent

# 读配置
def load_env():
    env = {}
    for p in [ROOT / "apps" / "server" / ".env"]:
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env

ENV = load_env()
SUPABASE_URL = ENV["SUPABASE_URL"]
SUPABASE_KEY = ENV["SUPABASE_SERVICE_ROLE_KEY"]
SUPABASE_TOKEN = ENV.get("SUPABASE_ACCESS_TOKEN", "")
PROJECT_REF = "adqznqsciqtepzimcvsg"


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
    print(f"  📈 拉 5 个指数...")
    bs.login()
    result = {}
    for key, code in INDEX_CODES.items():
        rs = bs.query_history_k_data_plus(
            code, "date,close,preclose,volume,amount,pctChg",
            start_date=start_date, end_date=end_date,
            frequency="d", adjustflag="3"
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
    print(f"  💰 拉北向资金（沪+深）...")
    result = {}

    for name, key in [("沪股通", "sh"), ("深股通", "sz")]:
        for retry in range(3):
            try:
                df = ak.stock_hsgt_hist_em(symbol=name)
                break
            except Exception as e:
                if retry == 2:
                    print(f"    ❌ {name} 失败: {e}")
                    df = None
                    break
                time.sleep(2)
        if df is None or len(df) == 0:
            continue
        print(f"    {name}: {len(df)} 行 ({df.iloc[0, 0]} ~ {df.iloc[-1, 0]})")
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


# ─── 3. 聚合涨跌家数 ───────────────────────────────────
def exec_sql(sql: str) -> list:
    """Management API 执行 SQL."""
    if not SUPABASE_TOKEN:
        print("  ⚠ 无 SUPABASE_ACCESS_TOKEN，跳过 advance_decline 聚合")
        return []
    api_url = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query"
    result = subprocess.run(
        ["curl", "-sS", "-X", "POST", api_url,
         "-H", f"Authorization: Bearer {SUPABASE_TOKEN}",
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"query": sql}),
         "--max-time", "60"],
        capture_output=True, text=True,
    )
    body = result.stdout.strip()
    if result.returncode != 0:
        raise RuntimeError(f"curl err: {result.stderr}")
    try:
        j = json.loads(body)
        if isinstance(j, dict) and "message" in j:
            raise RuntimeError(f"SQL err: {j['message']}")
        return j
    except json.JSONDecodeError:
        raise RuntimeError(f"non-json: {body[:200]}")


def fetch_advance_decline() -> dict:
    """返回 {date: {advance, decline, unchanged, limit_up, limit_down, total}}"""
    print(f"  📊 聚合涨跌家数（本地日 K）...")
    sql = """
    SELECT
      (dt AT TIME ZONE 'Asia/Shanghai')::date AS trade_date,
      COUNT(*) FILTER (WHERE change_percent > 0)::int AS advance,
      COUNT(*) FILTER (WHERE change_percent < 0)::int AS decline,
      COUNT(*) FILTER (WHERE change_percent = 0)::int AS unchanged,
      COUNT(*) FILTER (WHERE change_percent >= 9.9)::int AS limit_up,
      COUNT(*) FILTER (WHERE change_percent <= -9.9)::int AS limit_down,
      COUNT(*)::int AS total
    FROM klines_all
    WHERE scenario_id IS NULL
      AND timeframe = '1d'
      AND change_percent IS NOT NULL
    GROUP BY 1
    ORDER BY 1;
    """
    rows = exec_sql(sql)
    result = {}
    for r in rows:
        d = str(r["trade_date"])
        result[d] = {
            "advance": r["advance"],
            "decline": r["decline"],
            "unchanged": r["unchanged"],
            "limit_up": r["limit_up"],
            "limit_down": r["limit_down"],
            "total": r["total"],
        }
    print(f"  ✅ 涨跌聚合 {len(result)} 个交易日")
    return result


# ─── 4. 组装并入库 ─────────────────────────────────────
def upsert_snapshots(snapshots: list):
    """批量 upsert 到 market_snapshots."""
    import urllib.request
    url = f"{SUPABASE_URL}/rest/v1/market_snapshots"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    BATCH = 500
    total = 0
    for i in range(0, len(snapshots), BATCH):
        chunk = snapshots[i:i + BATCH]
        data = json.dumps(chunk).encode()
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                resp.read()
            total += len(chunk)
            sys.stdout.write(f"\r  ↑ 已上传 {total}/{len(snapshots)}")
            sys.stdout.flush()
        except Exception as e:
            print(f"\n  ❌ 上传第 {i}-{i+BATCH} 批失败: {e}")
            raise
    print()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--from", dest="start", default="2014-01-01")
    parser.add_argument("--to", dest="end", default="2026-04-30")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    print(f"══════════════════════════════════════════")
    print(f"  📸 T-1.06 市场快照采集")
    print(f"  范围: {args.start} ~ {args.end}")
    print(f"══════════════════════════════════════════\n")

    t0 = time.time()

    idx = fetch_indexes(args.start, args.end)
    nc = fetch_north_capital()
    adv = fetch_advance_decline()

    # 组装
    all_dates = set(idx) | set(nc) | set(adv)
    all_dates = sorted(d for d in all_dates if args.start <= d <= args.end)
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
            "advance_decline": adv.get(d) or None,
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

    print(f"\n  💾 上传到 market_snapshots...")
    upsert_snapshots(snapshots)

    elapsed = time.time() - t0
    print(f"\n  🏁 完成! 入库 {len(snapshots)} 行，耗时 {elapsed:.1f}s")


if __name__ == "__main__":
    main()
