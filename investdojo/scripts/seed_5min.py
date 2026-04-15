#!/usr/bin/env python3
"""
BaoStock 5分钟K线数据采集 → Supabase
采集 4 个场景中所有股票的 5 分钟 K 线数据
"""

import baostock as bs
import json
import os
import sys
import time
from datetime import datetime, timedelta

# Supabase 配置
SUPABASE_URL = "https://adqznqsciqtepzimcvsg.supabase.co"
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# 如果没设置环境变量，尝试从 .env 文件读取
if not SUPABASE_KEY:
    env_path = os.path.join(os.path.dirname(__file__), "..", "apps", "server", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
                    SUPABASE_KEY = line.strip().split("=", 1)[1]

# 场景配置
SCENARIOS = {
    "covid_2020": {
        "symbols": [
            ("sz.000001", "000001"),  # 平安银行
            ("sh.600519", "600519"),  # 贵州茅台
            ("sz.300750", "300750"),  # 宁德时代
        ],
        "start": "2020-01-02",
        "end": "2020-06-30",
    },
    "bull_2014": {
        "symbols": [
            ("sz.000001", "000001"),
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
    "new_energy_2020": {
        "symbols": [
            ("sz.300750", "300750"),
            ("sz.002594", "002594"),  # 比亚迪
            ("sh.601012", "601012"),  # 隆基绿能
        ],
        "start": "2020-07-01",
        "end": "2021-12-31",
    },
}


def fetch_5min_klines(bs_code: str, start_date: str, end_date: str):
    """从 BaoStock 获取 5 分钟 K 线"""
    all_rows = []
    
    # BaoStock 5分钟数据需要按月查询（数据量大）
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    
    current = start
    while current <= end:
        # 每次查一个月
        month_end = min(
            datetime(current.year, current.month + 1, 1) - timedelta(days=1)
            if current.month < 12
            else datetime(current.year, 12, 31),
            end,
        )
        
        rs = bs.query_history_k_data_plus(
            bs_code,
            "date,time,open,high,low,close,volume,amount",
            start_date=current.strftime("%Y-%m-%d"),
            end_date=month_end.strftime("%Y-%m-%d"),
            frequency="5",
            adjustflag="2",  # 前复权
        )
        
        if rs.error_code != "0":
            print(f"  ⚠️ BaoStock 错误 ({bs_code} {current.strftime('%Y-%m')}): {rs.error_msg}")
        else:
            while rs.next():
                row = rs.get_row_data()
                if row[2] and float(row[2]) > 0:  # open > 0
                    all_rows.append(row)
        
        # 下个月
        if current.month == 12:
            current = datetime(current.year + 1, 1, 1)
        else:
            current = datetime(current.year, current.month + 1, 1)
        
        time.sleep(0.3)  # 避免频率限制
    
    return all_rows


def upload_to_supabase(rows: list, scenario_id: str, symbol: str):
    """批量上传到 Supabase klines_5min 表"""
    import urllib.request
    
    batch_size = 500
    total_uploaded = 0
    
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        records = []
        
        for row in batch:
            # row: [date, time, open, high, low, close, volume, amount]
            date_str = row[0]  # 2020-01-02
            time_str = row[1]  # 20200102150000000 → 需要转换
            
            # 转换时间格式: 20200102093500000 → 2020-01-02 09:35:00
            if len(time_str) >= 14:
                formatted_time = f"{time_str[0:4]}-{time_str[4:6]}-{time_str[6:8]} {time_str[8:10]}:{time_str[10:12]}:00"
            else:
                formatted_time = f"{date_str} 00:00:00"
            
            try:
                records.append({
                    "scenario_id": scenario_id,
                    "symbol": symbol,
                    "date": date_str,
                    "datetime": formatted_time,
                    "open": float(row[2]) if row[2] else 0,
                    "high": float(row[3]) if row[3] else 0,
                    "low": float(row[4]) if row[4] else 0,
                    "close": float(row[5]) if row[5] else 0,
                    "volume": int(float(row[6])) if row[6] else 0,
                    "turnover": float(row[7]) if row[7] else 0,
                })
            except (ValueError, IndexError) as e:
                continue
        
        if not records:
            continue
        
        # 上传到 Supabase
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/klines_5min",
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


def create_5min_table():
    """在 Supabase 中创建 klines_5min 表"""
    import urllib.request
    
    sql = """
    CREATE TABLE IF NOT EXISTS klines_5min (
        id BIGSERIAL PRIMARY KEY,
        scenario_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        date TEXT NOT NULL,
        datetime TIMESTAMPTZ NOT NULL,
        open NUMERIC(12,4) NOT NULL,
        high NUMERIC(12,4) NOT NULL,
        low NUMERIC(12,4) NOT NULL,
        close NUMERIC(12,4) NOT NULL,
        volume BIGINT DEFAULT 0,
        turnover NUMERIC(20,2) DEFAULT 0
    );
    
    CREATE INDEX IF NOT EXISTS idx_klines_5min_scenario_symbol 
        ON klines_5min(scenario_id, symbol, datetime);
    
    CREATE INDEX IF NOT EXISTS idx_klines_5min_date 
        ON klines_5min(scenario_id, symbol, date);
    
    ALTER TABLE klines_5min ENABLE ROW LEVEL SECURITY;
    
    DO $$ BEGIN
        CREATE POLICY "klines_5min_anon_read" ON klines_5min
            FOR SELECT TO anon USING (true);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    """
    
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    
    # 使用 SQL 直接执行
    # 先通过 Management API 执行 SQL
    mgmt_token = os.environ.get("SUPABASE_MGMT_TOKEN", "sbp_49f115d18e5688f3cd06618081cc22f26c343086")
    
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/adqznqsciqtepzimcvsg/database/query",
        data=json.dumps({"query": sql}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {mgmt_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    
    try:
        resp = urllib.request.urlopen(req)
        print("✅ klines_5min 表创建成功")
        return True
    except Exception as e:
        error_body = ""
        if hasattr(e, "read"):
            error_body = e.read().decode("utf-8", errors="replace")
        print(f"⚠️ 建表: {e} {error_body[:300]}")
        return False


def main():
    print("=" * 60)
    print("InvestDojo — 5 分钟 K 线数据采集")
    print("=" * 60)
    
    # 1. 创建表
    print("\n[Step 1] 创建 klines_5min 表...")
    create_5min_table()
    
    # 2. 登录 BaoStock
    print("\n[Step 2] 登录 BaoStock...")
    lg = bs.login()
    if lg.error_code != "0":
        print(f"❌ BaoStock 登录失败: {lg.error_msg}")
        sys.exit(1)
    print("✅ BaoStock 登录成功")
    
    # 3. 逐场景采集
    total_all = 0
    for scenario_id, config in SCENARIOS.items():
        print(f"\n{'─' * 50}")
        print(f"📊 场景: {scenario_id}")
        print(f"   时间: {config['start']} ~ {config['end']}")
        
        for bs_code, symbol in config["symbols"]:
            print(f"\n  🔍 {symbol} ({bs_code})...")
            
            # 采集
            rows = fetch_5min_klines(bs_code, config["start"], config["end"])
            print(f"     获取 {len(rows)} 条 5 分钟 K 线")
            
            if rows:
                # 上传
                uploaded = upload_to_supabase(rows, scenario_id, symbol)
                print(f"     ✅ 上传 {uploaded} 条")
                total_all += uploaded
            else:
                print(f"     ⚠️ 无数据")
            
            time.sleep(0.5)
    
    # 4. 完成
    bs.logout()
    print(f"\n{'=' * 60}")
    print(f"✅ 采集完成！共上传 {total_all} 条 5 分钟 K 线")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
