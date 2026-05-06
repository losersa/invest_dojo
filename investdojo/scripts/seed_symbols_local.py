#!/usr/bin/env python3
"""股票元数据采集（symbols + industries）- 本地栈版本

数据源：BaoStock
目标表：symbols, industries (通过 PostgREST)
用法：
    cd investdojo/python-services
    python ../scripts/seed_symbols_local.py
"""

import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

import baostock as bs
import requests

# ── 配置 ──
SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://investdojo.local:8000")
SUPABASE_SERVICE_KEY = os.environ.get(
    "SUPABASE_SERVICE_ROLE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoiaW52ZXN0ZG9qby1zdXBhYmFzZS1saXRlIiwiaWF0IjoxNzc3NjYwMzYyLCJleHAiOjIwOTMwMjAzNjJ9.fcNS9vkbGydIjrQxAx55gdq4ubC08BwA1aQA6C8LcQM"
)

HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}

REST_URL = f"{SUPABASE_URL}/rest/v1"


def postgrest_insert(table: str, rows: list[dict], batch_size: int = 100):
    """通过 PostgREST 批量插入数据"""
    url = f"{REST_URL}/{table}"
    success = 0
    fail = 0
    
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        try:
            resp = requests.post(url, headers=HEADERS, json=batch, timeout=30)
            if resp.status_code in (200, 201, 204):
                success += len(batch)
            else:
                print(f"  ❌ 批次 {i // batch_size}: {resp.status_code} {resp.text[:200]}")
                fail += len(batch)
        except Exception as e:
            print(f"  ❌ 批次 {i // batch_size}: {e}")
            fail += len(batch)
    
    return success, fail


def main():
    print("🔌 登录 BaoStock...")
    lg = bs.login()
    if lg.error_code != '0':
        print(f"❌ BaoStock 登录失败: {lg.error_msg}")
        sys.exit(1)
    print("✅ 登录成功\n")

    # 1. 获取全 A 股列表
    print("📊 获取股票列表...")
    rs = bs.query_stock_basic()
    all_stocks = []
    while rs.error_code == '0' and rs.next():
        all_stocks.append(rs.get_row_data())

    # 过滤：只要 type=1（股票）
    stocks = [r for r in all_stocks if r[4] == '1']
    print(f"  全量 {len(all_stocks)}，A股 {len(stocks)}")

    # 2. 获取行业分类
    print("📊 获取行业分类...")
    rs_ind = bs.query_stock_industry()
    ind_map: dict[str, str] = {}  # code -> industry
    while rs_ind.error_code == '0' and rs_ind.next():
        row = rs_ind.get_row_data()
        code, industry = row[1], row[3]
        if industry:
            ind_map[code] = industry

    print(f"  行业映射 {len(ind_map)} 条")
    bs.logout()
    print("✅ BaoStock 数据采集完成\n")

    # ── 3. 构造 industries 数据 ──
    print("📦 整理行业数据...")
    industry_names = sorted(set(ind_map.values()))
    
    # 提取一级行业（行业代码的第一个字母）
    level1_map: dict[str, str] = {}
    for name in industry_names:
        if name and name[0].isalpha() and name[0].isupper():
            level1_map[name[0]] = name[0]

    # 构造行业数据
    industries_data = []
    ind_id = 1

    # 一级行业
    level1_ids: dict[str, int] = {}
    for letter in sorted(level1_map.keys()):
        level1_ids[letter] = ind_id
        industries_data.append({
            "id": ind_id,
            "name": letter,
            "level": 1,
            "parent_id": None,
            "code": letter,
            "symbol_count": 0,
        })
        ind_id += 1

    # 二级行业
    for name in industry_names:
        if not name:
            continue
        letter = name[0] if name[0].isalpha() and name[0].isupper() else None
        parent = level1_ids.get(letter) if letter else None
        code = "".join(ch for ch in name if ch.isalnum())[:10]
        industries_data.append({
            "id": ind_id,
            "name": name,
            "level": 2,
            "parent_id": parent,
            "code": code,
            "symbol_count": 0,
        })
        ind_id += 1

    print(f"  一级行业 {len(level1_ids)} 个，二级 {len(industry_names)} 个，总 {len(industries_data)} 条")

    # ── 4. 上传 industries ──
    print("\n⬆ 上传 industries...")
    success, fail = postgrest_insert("industries", industries_data, batch_size=50)
    print(f"  ✅ 成功 {success}，失败 {fail}")

    # ── 5. 上传 symbols ──
    print("\n⬆ 上传 symbols...")
    
    symbols_data = []
    for r in stocks:
        bs_code, name, ipo, out, typ, status = r
        code = bs_code.split(".")[-1]
        market = "A"
        
        industry = ind_map.get(bs_code, "")
        industry_l1 = ""
        if industry:
            for ch in industry:
                if ch.isalpha() or ch.isdigit():
                    industry_l1 += ch
                else:
                    break

        symbols_data.append({
            "code": code,
            "market": market,
            "name": name,
            "short_name": name,
            "industry": industry or None,
            "industry_level2": industry_l1 or None,
            "listed_at": ipo if ipo else None,
            "delisted_at": out if out else None,
            "status": "active" if status == '1' else "delisted",
        })

    print(f"  准备上传 {len(symbols_data)} 条...")
    success, fail = postgrest_insert("symbols", symbols_data, batch_size=100)
    print(f"  ✅ 成功 {success}，失败 {fail}")

    # ── 6. 更新 industries 的 symbol_count ──
    print("\n📊 更新行业股票计数...")
    # 通过 RPC 函数更新（如果有的话），否则用 SQL
    # 这里我们先查询再更新
    try:
        # 查询每个行业的股票数
        resp = requests.get(
            f"{REST_URL}/symbols?select=industry&industry=not.is.null",
            headers=HEADERS,
            timeout=30,
        )
        if resp.status_code == 200:
            sym_data = resp.json()
            industry_count = defaultdict(int)
            for s in sym_data:
                if s.get("industry"):
                    industry_count[s["industry"]] += 1
            
            # 更新每个行业
            for ind_name, cnt in industry_count.items():
                update_resp = requests.patch(
                    f"{REST_URL}/industries?name=eq.{ind_name}",
                    headers=HEADERS,
                    json={"symbol_count": cnt},
                    timeout=10,
                )
            print(f"  ✅ 更新了 {len(industry_count)} 个行业的股票计数")
    except Exception as e:
        print(f"  ⚠️ 更新计数失败: {e}")

    print("\n🏁 完成!")


if __name__ == "__main__":
    main()
