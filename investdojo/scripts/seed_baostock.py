#!/usr/bin/env python3
"""
使用 BaoStock 补充拉取失败的 K 线数据
BaoStock 免费、无频率限制、稳定性高
"""

import time
import requests
import baostock as bs
import pandas as pd

SUPABASE_URL = "https://adqznqsciqtepzimcvsg.supabase.co"
SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkcXpucXNjaXF0ZXB6aW1jdnNnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTk3NDQ2MSwiZXhwIjoyMDkxNTUwNDYxfQ.t5piNqJLo_tj-hQ_V7aalmOp2g7KuVnRqgPQgejbMAw"

HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal,resolution=merge-duplicates",
}

# BaoStock 代码格式: sh.600519 / sz.000001
def to_bs_code(symbol: str) -> str:
    if symbol.startswith("6"):
        return f"sh.{symbol}"
    else:
        return f"sz.{symbol}"

TASKS = [
    ("000001", "trade_war_2018", "2018-03-01", "2018-12-31"),
    ("000858", "trade_war_2018", "2018-03-01", "2018-12-31"),
    ("002594", "new_energy_2020", "2020-07-01", "2021-12-31"),
    ("300750", "covid_2020", "2020-01-02", "2020-06-30"),
    ("300750", "new_energy_2020", "2020-07-01", "2021-12-31"),
    ("600036", "bull_2014", "2014-07-01", "2015-09-30"),
    ("600519", "covid_2020", "2020-01-02", "2020-06-30"),
    ("600519", "trade_war_2018", "2018-03-01", "2018-12-31"),
    ("601012", "new_energy_2020", "2020-07-01", "2021-12-31"),
    ("601318", "bull_2014", "2014-07-01", "2015-09-30"),
]


def fetch_klines_baostock(symbol, start, end):
    bs_code = to_bs_code(symbol)
    print(f"  📊 BaoStock 拉取 {bs_code} ({symbol}): {start} ~ {end}")
    
    rs = bs.query_history_k_data_plus(
        bs_code,
        "date,open,high,low,close,preclose,volume,amount,pctChg,turn",
        start_date=start,
        end_date=end,
        frequency="d",
        adjustflag="2",  # 前复权
    )
    
    if rs.error_code != "0":
        print(f"  ❌ 查询失败: {rs.error_msg}")
        return pd.DataFrame()
    
    rows = []
    while rs.next():
        rows.append(rs.get_row_data())
    
    if not rows:
        print(f"  ⚠️ {symbol} 无数据")
        return pd.DataFrame()
    
    df = pd.DataFrame(rows, columns=rs.fields)
    
    # 转换数值类型
    for col in ["open", "high", "low", "close", "preclose", "volume", "amount", "pctChg"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    
    # 过滤掉无效行（停牌等）
    df = df[df["volume"] > 0].copy()
    
    print(f"  ✅ {symbol}: 获取 {len(df)} 条K线")
    return df


def supabase_insert(rows):
    batch_size = 500
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i+batch_size]
        resp = requests.post(f"{SUPABASE_URL}/rest/v1/klines", headers=HEADERS, json=batch)
        if resp.status_code not in (200, 201):
            print(f"  ❌ 插入失败: {resp.status_code} {resp.text[:200]}")
            return False
    return True


def main():
    print("=" * 50)
    print("BaoStock 补充拉取 K 线数据")
    print("=" * 50)
    
    # 登录 BaoStock
    lg = bs.login()
    print(f"BaoStock 登录: {lg.error_msg}")
    
    total = 0
    for symbol, scenario_id, start, end in TASKS:
        df = fetch_klines_baostock(symbol, start, end)
        if df.empty:
            continue
        
        rows = []
        for _, row in df.iterrows():
            change_amount = row["close"] - row["preclose"] if row["preclose"] > 0 else None
            rows.append({
                "scenario_id": scenario_id,
                "symbol": symbol,
                "date": row["date"],
                "open": round(float(row["open"]), 2),
                "high": round(float(row["high"]), 2),
                "low": round(float(row["low"]), 2),
                "close": round(float(row["close"]), 2),
                "volume": int(row["volume"]),
                "turnover": round(float(row["amount"]), 2) if pd.notna(row["amount"]) else 0,
                "pre_close": round(float(row["preclose"]), 2) if row["preclose"] > 0 else None,
                "change_amount": round(change_amount, 2) if change_amount is not None else None,
                "change_percent": round(float(row["pctChg"]), 4) if pd.notna(row["pctChg"]) else None,
            })
        
        if supabase_insert(rows):
            print(f"  ✅ 已写入 Supabase: {len(rows)} 条")
            total += len(rows)
        
        time.sleep(0.5)
    
    bs.logout()
    print(f"\n✅ 补充完成! 新增 {total} 条 K 线数据")


if __name__ == "__main__":
    main()
