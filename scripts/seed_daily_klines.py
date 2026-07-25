#!/usr/bin/env python3
"""T-1.03 · 全 A 股日 K 采集（PostgREST 版，快 10x）

通过 Supabase REST API (PostgREST) 直接 POST JSON 数据，
比 Management API SQL 快很多（无 SQL 解析开销）。

用法：
    cd investdojo/python-services
    PYTHONPATH=. .venv/bin/python ../scripts/seed_daily_klines.py [--limit N]
"""

import argparse
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

socket.setdefaulttimeout(30)

import baostock as bs  # noqa: E402

START_DATE = "2020-01-01"
END_DATE = datetime.now().strftime("%Y-%m-%d")

# 读配置
SUPABASE_URL = ""
SERVICE_KEY = ""

for ef in [
    Path(__file__).parent / ".." / "apps" / "server" / ".env",
    Path(__file__).parent / ".." / "python-services" / ".env",
]:
    if ef.exists():
        for line in ef.read_text().splitlines():
            line = line.strip()
            if line.startswith("SUPABASE_URL="):
                SUPABASE_URL = line.split("=", 1)[1].strip()
            elif line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
                SERVICE_KEY = line.split("=", 1)[1].strip()

SUPABASE_URL = os.environ.get("SUPABASE_URL", SUPABASE_URL)
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY)

if not SUPABASE_URL or not SERVICE_KEY:
    print("❌ 需要 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

REST_URL = f"{SUPABASE_URL}/rest/v1/klines_all"
HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}


def post_rows(rows: list[dict], retry: int = 2) -> tuple[bool, str]:
    """通过 PostgREST 批量 POST"""
    data = json.dumps(rows).encode()
    for attempt in range(retry + 1):
        req = urllib.request.Request(REST_URL, data=data, method="POST", headers=HEADERS)
        try:
            urllib.request.urlopen(req, timeout=60)
            return True, "OK"
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:200]
            if e.code == 409:
                # 唯一约束冲突 → 改为 upsert
                h2 = {**HEADERS, "Prefer": "return=minimal,resolution=merge-duplicates"}
                req2 = urllib.request.Request(REST_URL, data=data, method="POST", headers=h2)
                try:
                    urllib.request.urlopen(req2, timeout=60)
                    return True, "OK (upsert)"
                except urllib.error.HTTPError as e2:
                    return False, f"upsert HTTP {e2.code}: {e2.read().decode()[:200]}"
            if attempt < retry:
                time.sleep(2)
                continue
            return False, f"HTTP {e.code}: {body}"
        except Exception as e:
            if attempt < retry:
                time.sleep(2)
                continue
            return False, str(e)[:200]
    return False, "max retries"


def fetch_existing_symbols() -> set[str]:
    """查询已有日K的股票代码"""
    url = f"{SUPABASE_URL}/rest/v1/klines_all?timeframe=eq.1d&scenario_id=is.null&select=symbol"
    req = urllib.request.Request(url, headers={
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Prefer": "count=exact",
        "Range": "0-0",
    })
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        # 只需要去重的 symbol 列表，这里用另一种方式
        pass
    except:
        pass

    # 更可靠：直接 SQL 查
    import subprocess
    TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
    if not TOKEN:
        for ef in [Path(__file__).parent / ".." / "apps" / "server" / ".env"]:
            if ef.exists():
                for line in ef.read_text().splitlines():
                    if line.startswith("SUPABASE_ACCESS_TOKEN="):
                        TOKEN = line.split("=", 1)[1].strip()

    if TOKEN:
        REF = "adqznqsciqtepzimcvsg"
        r = subprocess.run(
            ["curl", "-sS", "-X", "POST",
             f"https://api.supabase.com/v1/projects/{REF}/database/query",
             "-H", f"Authorization: Bearer {TOKEN}",
             "-H", "Content-Type: application/json",
             "-d", json.dumps({"query":
                 "SELECT DISTINCT symbol FROM klines_all WHERE timeframe='1d' AND scenario_id IS NULL"
             }),
             "--max-time", "30"],
            capture_output=True, text=True
        )
        try:
            rows = json.loads(r.stdout.strip())
            return {row["symbol"] for row in rows}
        except:
            pass
    return set()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--start", type=str, default=START_DATE)
    args = parser.parse_args()

    print(f"📊 范围: {args.start} ~ {END_DATE}")
    print(f"📡 PostgREST: {REST_URL}")
    print("🔌 登录 BaoStock...")

    lg = bs.login()
    if lg.error_code != '0':
        print(f"❌ 登录失败: {lg.error_msg}")
        sys.exit(1)

    # 获取股票列表
    rs = bs.query_stock_basic()
    all_codes = []
    while rs.error_code == '0' and rs.next():
        row = rs.get_row_data()
        code, name, ipo, out, typ, status = row
        if typ != '1':
            continue
        if ipo and ipo > END_DATE:
            continue
        if out and out < args.start:
            continue
        all_codes.append((code, name))

    if args.limit > 0:
        all_codes = all_codes[:args.limit]
    print(f"  待采集: {len(all_codes)} 支\n")

    # 已有数据（断点续传）
    print("📋 检查已有数据...")
    existing = fetch_existing_symbols()
    print(f"  已有日K: {len(existing)} 支\n")

    total_uploaded = 0
    total_skipped = 0
    total_failed = 0
    start_time = time.monotonic()

    for idx, (bs_code, name) in enumerate(all_codes):
        code = bs_code.split(".")[-1]

        if code in existing:
            total_skipped += 1
            continue

        # BaoStock 拉数据
        try:
            rs = bs.query_history_k_data_plus(
                bs_code,
                "date,open,high,low,close,volume,amount,pctChg",
                start_date=args.start, end_date=END_DATE,
                frequency="d", adjustflag="2"
            )
        except Exception as e:
            total_failed += 1
            continue

        rows_data = []
        while rs.error_code == '0' and rs.next():
            rows_data.append(rs.get_row_data())

        if not rows_data:
            continue

        # 构造 JSON 行
        json_rows = []
        for r in rows_data:
            dt, op, hi, lo, cl, vol, amt, pct = r
            op_f = float(op) if op else 0
            cl_f = float(cl) if cl else 0
            if op_f == 0 and cl_f == 0:
                continue
            json_rows.append({
                "symbol": code,
                "timeframe": "1d",
                "dt": f"{dt}T00:00:00+08:00",
                "open": float(op) if op else None,
                "high": float(hi) if hi else None,
                "low": float(lo) if lo else None,
                "close": float(cl) if cl else None,
                "volume": int(float(vol)) if vol else 0,
                "turnover": float(amt) if amt else 0,
                "change_percent": float(pct) if pct else 0,
                "adj_factor": 1,
            })

        if not json_rows:
            continue

        # PostgREST 批量 POST（一次最多 2000 行）
        batch_size = 2000
        stock_ok = True
        for i in range(0, len(json_rows), batch_size):
            batch = json_rows[i:i + batch_size]
            ok, msg = post_rows(batch)
            if ok:
                total_uploaded += len(batch)
            else:
                print(f"\n  ❌ {code} {name}: {msg}")
                total_failed += 1
                stock_ok = False
                break

        elapsed = time.monotonic() - start_time
        progress = idx + 1
        rate = total_uploaded / elapsed if elapsed > 0 else 0
        remaining = ((len(all_codes) - total_skipped - progress) * (elapsed / max(progress - total_skipped, 1))) if progress > total_skipped else 0

        print(
            f"\r  [{progress}/{len(all_codes)}] {code} {name}: {len(rows_data)}行 | "
            f"总: {total_uploaded:,} | 跳过: {total_skipped} | "
            f"{rate:.0f}行/s | ~{remaining/60:.0f}min剩余",
            end="", flush=True
        )

    bs.logout()

    elapsed_total = time.monotonic() - start_time
    print(f"\n\n🏁 完成！")
    print(f"  上传: {total_uploaded:,} 行")
    print(f"  跳过: {total_skipped}")
    print(f"  失败: {total_failed}")
    print(f"  耗时: {elapsed_total/60:.1f} 分钟")


if __name__ == "__main__":
    main()
