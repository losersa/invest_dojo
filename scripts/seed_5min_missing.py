#!/usr/bin/env python3
"""
补齐缺失场景的 5 分钟 K 线数据 → Supabase (klines_all 表)
只采集 bull_2014 和 trade_war_2018 两个场景
"""

import baostock as bs
import json
import os
import sys
import time
from datetime import datetime, timedelta

SUPABASE_URL = "https://adqznqsciqtepzimcvsg.supabase.co"
SUPABASE_KEY = ""

env_path = os.path.join(os.path.dirname(__file__), "..", "apps", "server", ".env")
with open(env_path) as f:
    for line in f:
        if line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
            SUPABASE_KEY = line.strip().split("=", 1)[1]
            break

# 只采集缺失的场景
SCENARIOS = {
    "bull_2014": {
        "symbols": [
            ("sz.000001", "000001"),  # 平安银行
            ("sh.601318", "601318"),  # 中国平安
            ("sh.600036", "600036"),  # 招商银行
        ],
        "start": "2014-07-01",
        "end": "2015-09-30",
    },
    "trade_war_2018": {
        "symbols": [
            ("sz.000001", "000001"),
            ("sh.600519", "600519"),
            ("sz.000858", "000858"),  # 五粮液
        ],
        "start": "2018-03-01",
        "end": "2018-12-31",
    },
}


def fetch_5min_klines(bs_code: str, start_date: str, end_date: str):
    """从 BaoStock 获取 5 分钟 K 线，按月分片"""
    all_rows = []

    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")

    current = start
    while current <= end:
        if current.month == 12:
            month_end = datetime(current.year, 12, 31)
        else:
            month_end = datetime(current.year, current.month + 1, 1) - timedelta(days=1)
        if month_end > end:
            month_end = end

        rs = bs.query_history_k_data_plus(
            bs_code,
            "date,time,open,high,low,close,volume,amount",
            start_date=current.strftime("%Y-%m-%d"),
            end_date=month_end.strftime("%Y-%m-%d"),
            frequency="5",
            adjustflag="2",
        )

        if rs.error_code != "0":
            print(f"  ⚠️ BaoStock 错误 ({bs_code} {current.strftime('%Y-%m')}): {rs.error_msg}")
        else:
            cnt = 0
            while rs.next():
                row = rs.get_row_data()
                if row[2] and float(row[2]) > 0:
                    all_rows.append(row)
                    cnt += 1
            print(f"     {current.strftime('%Y-%m')}: {cnt} 条")

        if current.month == 12:
            current = datetime(current.year + 1, 1, 1)
        else:
            current = datetime(current.year, current.month + 1, 1)

        time.sleep(0.3)

    return all_rows


def upload_to_klines_all(rows: list, scenario_id: str, symbol: str):
    """批量上传到 klines_all 表（timeframe=5m）"""
    import urllib.request

    batch_size = 500
    total_uploaded = 0

    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        records = []

        for row in batch:
            date_str = row[0]
            time_str = row[1]

            if len(time_str) >= 14:
                # 20200102093500000 → 2020-01-02T09:35:00+08:00 → 转 UTC
                # BaoStock 的时间是北京时间，Supabase 已有数据直接存为北京时间字面量到 UTC 字段
                # 这里保持与既有数据一致：不加时区，让 DB 按 UTC 存
                formatted_time = f"{time_str[0:4]}-{time_str[4:6]}-{time_str[6:8]}T{time_str[8:10]}:{time_str[10:12]}:00"
            else:
                formatted_time = f"{date_str}T00:00:00"

            try:
                records.append({
                    "scenario_id": scenario_id,
                    "symbol": symbol,
                    "timeframe": "5m",
                    "dt": formatted_time,
                    "open": float(row[2]) if row[2] else 0,
                    "high": float(row[3]) if row[3] else 0,
                    "low": float(row[4]) if row[4] else 0,
                    "close": float(row[5]) if row[5] else 0,
                    "volume": int(float(row[6])) if row[6] else 0,
                    "turnover": float(row[7]) if row[7] else 0,
                })
            except (ValueError, IndexError):
                continue

        if not records:
            continue

        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/klines_all",
            data=json.dumps(records).encode("utf-8"),
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            method="POST",
        )

        try:
            urllib.request.urlopen(req)
            total_uploaded += len(records)
        except Exception as e:
            error_body = ""
            if hasattr(e, "read"):
                error_body = e.read().decode("utf-8", errors="replace")
            print(f"  ⚠️ 上传失败 (batch {i//batch_size}): {e} {error_body[:200]}")

    return total_uploaded


def main():
    print("=" * 60)
    print("补齐缺失场景的 5 分钟 K 线 (bull_2014, trade_war_2018)")
    print("=" * 60)

    print("\n[Step 1] 登录 BaoStock...")
    lg = bs.login()
    if lg.error_code != "0":
        print(f"❌ BaoStock 登录失败: {lg.error_msg}")
        sys.exit(1)
    print("✅ BaoStock 登录成功")

    total_all = 0
    for scenario_id, config in SCENARIOS.items():
        print(f"\n{'─' * 50}")
        print(f"📊 场景: {scenario_id}")
        print(f"   时间: {config['start']} ~ {config['end']}")

        for bs_code, symbol in config["symbols"]:
            print(f"\n  🔍 {symbol} ({bs_code})...")
            rows = fetch_5min_klines(bs_code, config["start"], config["end"])
            print(f"     合计 {len(rows)} 条")

            if rows:
                uploaded = upload_to_klines_all(rows, scenario_id, symbol)
                print(f"     ✅ 上传 {uploaded} 条")
                total_all += uploaded
            else:
                print(f"     ⚠️ 无数据")

            time.sleep(0.5)

    bs.logout()
    print(f"\n{'=' * 60}")
    print(f"✅ 完成！共上传 {total_all} 条")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
