#!/usr/bin/env python3
"""补充拉取失败的 K 线数据（带重试 + 更长间隔）"""

import time
import requests
import akshare as ak
import pandas as pd

SUPABASE_URL = "https://adqznqsciqtepzimcvsg.supabase.co"
SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkcXpucXNjaXF0ZXB6aW1jdnNnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTk3NDQ2MSwiZXhwIjoyMDkxNTUwNDYxfQ.t5piNqJLo_tj-hQ_V7aalmOp2g7KuVnRqgPQgejbMAw"

HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal,resolution=merge-duplicates",
}

# 需要补充的数据
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


def fetch_and_insert(symbol, scenario_id, start, end, retries=3):
    for attempt in range(retries):
        try:
            print(f"  📊 [{attempt+1}/{retries}] 拉取 {symbol} K线: {start} ~ {end}")
            df = ak.stock_zh_a_hist(
                symbol=symbol, period="daily",
                start_date=start.replace("-", ""),
                end_date=end.replace("-", ""),
                adjust="qfq",
            )
            if df.empty:
                print(f"  ⚠️ {symbol} 无数据")
                return 0
            
            df = df.rename(columns={
                "日期": "date", "开盘": "open", "收盘": "close",
                "最高": "high", "最低": "low", "成交量": "volume",
                "成交额": "turnover", "涨跌幅": "change_percent", "涨跌额": "change_amount",
            })
            df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
            df["pre_close"] = df["close"].shift(1)
            df.loc[df.index[0], "pre_close"] = df.iloc[0]["open"]
            
            rows = []
            for _, row in df.iterrows():
                rows.append({
                    "scenario_id": scenario_id, "symbol": symbol, "date": row["date"],
                    "open": float(row["open"]), "high": float(row["high"]),
                    "low": float(row["low"]), "close": float(row["close"]),
                    "volume": int(row["volume"]),
                    "turnover": float(row["turnover"]) if pd.notna(row.get("turnover")) else 0,
                    "pre_close": float(row["pre_close"]) if pd.notna(row["pre_close"]) else None,
                    "change_amount": float(row["change_amount"]) if pd.notna(row.get("change_amount")) else None,
                    "change_percent": float(row["change_percent"]) if pd.notna(row.get("change_percent")) else None,
                })
            
            # 分批插入
            batch_size = 500
            for i in range(0, len(rows), batch_size):
                batch = rows[i:i+batch_size]
                resp = requests.post(f"{SUPABASE_URL}/rest/v1/klines", headers=HEADERS, json=batch)
                if resp.status_code not in (200, 201):
                    print(f"  ❌ 插入失败: {resp.status_code} {resp.text[:200]}")
                    return 0
            
            print(f"  ✅ {symbol} ({scenario_id}): 已插入 {len(rows)} 条")
            return len(rows)
            
        except Exception as e:
            print(f"  ⚠️ 失败: {e}")
            if attempt < retries - 1:
                wait = 5 * (attempt + 1)
                print(f"  ⏳ 等待 {wait} 秒后重试...")
                time.sleep(wait)
    return 0


def main():
    print("=" * 50)
    print("补充拉取失败的 K 线数据")
    print("=" * 50)
    
    total = 0
    for symbol, scenario_id, start, end in TASKS:
        count = fetch_and_insert(symbol, scenario_id, start, end)
        total += count
        time.sleep(3)  # 每个请求间隔 3 秒
    
    print(f"\n✅ 补充完成，新增 {total} 条 K 线数据")


if __name__ == "__main__":
    main()
