#!/usr/bin/env python3
"""增量更新日K数据（每日定时跑）

策略：
1. 查每支在市股票的 MAX(dt)
2. 从 MAX(dt)+1 到今天，只拉新数据
3. 如果已是最新，跳过
4. 跳过非交易日（BaoStock 返回空就是非交易日）

通常每天 19:00 后跑（A 股收盘 15:00 + 数据源同步）。
非交易日（周末/假日）跑也无害 —— 只是白跑没数据。

用法：
    python scripts/update_daily_klines.py
    python scripts/update_daily_klines.py --dry-run     # 只显示计划
    python scripts/update_daily_klines.py --limit 10    # 只跑前 10 支（测试）
"""

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

socket.setdefaulttimeout(30)

import baostock as bs  # noqa: E402

# ── 配置 ──
SUPABASE_URL = ""
SERVICE_KEY = ""
TOKEN = ""  # access token（查询用）

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
            elif line.startswith("SUPABASE_ACCESS_TOKEN="):
                TOKEN = line.split("=", 1)[1].strip()

SUPABASE_URL = os.environ.get("SUPABASE_URL", SUPABASE_URL)
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY)
TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN", TOKEN)

if not all([SUPABASE_URL, SERVICE_KEY, TOKEN]):
    print("❌ 需要 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ACCESS_TOKEN")
    sys.exit(1)

REST_URL = f"{SUPABASE_URL}/rest/v1/klines_all"
REF = SUPABASE_URL.replace("https://", "").replace(".supabase.co", "")
MGMT_API = f"https://api.supabase.com/v1/projects/{REF}/database/query"


def mgmt_query(sql: str, timeout: int = 30):
    """通过 Management API 执行 SQL 并返回结果"""
    r = subprocess.run(
        ["curl", "-sS", "-X", "POST", MGMT_API,
         "-H", f"Authorization: Bearer {TOKEN}",
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"query": sql}),
         "--max-time", str(timeout)],
        capture_output=True, text=True,
    )
    body = r.stdout.strip()
    if body.startswith("["):
        return json.loads(body)
    return []


def post_rows(rows: list[dict]) -> tuple[bool, str]:
    """通过 PostgREST POST 上传行"""
    if not rows:
        return True, "empty"
    data = json.dumps(rows).encode()
    req = urllib.request.Request(
        REST_URL, data=data, method="POST",
        headers={
            "apikey": SERVICE_KEY,
            "Authorization": f"Bearer {SERVICE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal,resolution=merge-duplicates",
        }
    )
    try:
        urllib.request.urlopen(req, timeout=60)
        return True, "OK"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode()[:150]}"
    except Exception as e:
        return False, str(e)[:150]


# ── 主逻辑 ──

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    today = datetime.now().strftime("%Y-%m-%d")
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    print(f"📅 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} — 增量更新日K")
    print(f"📊 目标日期: ≤ {today}")

    # 1. 查每支在市股票的最新日期（按北京时间取 date）
    print("\n📋 查询数据库现状...")
    rows = mgmt_query("""
        SELECT symbol, MAX((dt AT TIME ZONE 'Asia/Shanghai')::date) as last_dt
        FROM klines_all
        WHERE timeframe = '1d' AND scenario_id IS NULL
        GROUP BY symbol
    """)
    last_dt_map = {r["symbol"]: r["last_dt"] for r in rows}
    print(f"   已有 {len(last_dt_map)} 支股票的日K数据")

    # 2. 获取所有在市股票
    rows = mgmt_query(
        "SELECT code, name FROM symbols WHERE status = 'active' ORDER BY code"
    )
    active_stocks = [(r["code"], r["name"]) for r in rows]
    print(f"   在市股票 {len(active_stocks)} 支")

    if args.limit > 0:
        active_stocks = active_stocks[:args.limit]
        print(f"   --limit {args.limit}，只跑前 {len(active_stocks)} 支")

    # 3. 筛选需要更新的股票
    need_update = []
    for code, name in active_stocks:
        last_dt = last_dt_map.get(code)
        if last_dt is None:
            # 完全没有数据，从 2020 开始拉（第一次遇到新股时）
            need_update.append((code, name, "2020-01-01"))
        elif last_dt < today:
            # 从 last_dt + 1 天开始
            start = (datetime.strptime(last_dt, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
            need_update.append((code, name, start))

    up_to_date = len(active_stocks) - len(need_update)
    print(f"\n📊 统计:")
    print(f"   已是最新: {up_to_date} 支")
    print(f"   需要更新: {len(need_update)} 支")

    if args.dry_run:
        print("\n📋 [DRY-RUN] 前 5 支待更新:")
        for code, name, start in need_update[:5]:
            print(f"   {code} {name}: 从 {start} 开始拉到 {today}")
        return

    if not need_update:
        print("\n✅ 全部最新，无需更新")
        return

    # 4. 登录 BaoStock
    print("\n🔌 登录 BaoStock...")
    lg = bs.login()
    if lg.error_code != '0':
        print(f"❌ {lg.error_msg}")
        sys.exit(1)

    # 5. 逐支更新
    start_time = time.monotonic()
    total_uploaded = 0
    total_no_data = 0
    total_failed = 0

    for idx, (code, name, start_date) in enumerate(need_update):
        bs_code = f"sh.{code}" if code.startswith(("6", "9")) else f"sz.{code}" if code.startswith(("0", "2", "3")) else f"bj.{code}"

        try:
            rs = bs.query_history_k_data_plus(
                bs_code,
                "date,open,high,low,close,volume,amount,pctChg",
                start_date=start_date, end_date=today,
                frequency="d", adjustflag="2"
            )
        except Exception as e:
            total_failed += 1
            print(f"\n  ⚠ {code} BaoStock 错误: {e}")
            continue

        rows_data = []
        while rs.error_code == '0' and rs.next():
            rows_data.append(rs.get_row_data())

        if not rows_data:
            total_no_data += 1
            progress = idx + 1
            elapsed = time.monotonic() - start_time
            rate = (idx + 1) / elapsed * 60
            print(
                f"\r  [{progress}/{len(need_update)}] {code} 无新数据 | 更新:{total_uploaded} | {rate:.0f}支/min",
                end="", flush=True,
            )
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
                "open": float(op), "high": float(hi), "low": float(lo), "close": float(cl),
                "volume": int(float(vol)) if vol else 0,
                "turnover": float(amt) if amt else 0,
                "change_percent": float(pct) if pct else 0,
                "adj_factor": 1,
            })

        if not json_rows:
            continue

        ok, msg = post_rows(json_rows)
        if ok:
            total_uploaded += len(json_rows)
        else:
            total_failed += 1
            print(f"\n  ❌ {code} 上传失败: {msg}")

        progress = idx + 1
        elapsed = time.monotonic() - start_time
        rate = (idx + 1) / elapsed * 60
        print(
            f"\r  [{progress}/{len(need_update)}] {code} {name}: +{len(json_rows)}行 | 总:{total_uploaded} | {rate:.0f}支/min",
            end="", flush=True,
        )

    bs.logout()

    elapsed_total = time.monotonic() - start_time
    print(f"\n\n🏁 完成")
    print(f"   上传: {total_uploaded} 行")
    print(f"   无新数据: {total_no_data} 支（非交易日 / 停牌）")
    print(f"   失败: {total_failed}")
    print(f"   耗时: {elapsed_total/60:.1f} 分钟")


if __name__ == "__main__":
    main()
