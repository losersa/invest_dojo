#!/usr/bin/env python3
"""T-1.02 · 股票元数据采集（symbols + industries）

数据源：BaoStock
目标表：symbols, industries (Supabase)

用法：
    cd investdojo/python-services
    PYTHONPATH=. .venv/bin/python ../scripts/seed_symbols.py
"""

import json
import os
import socket
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

socket.setdefaulttimeout(30)

import baostock as bs  # noqa: E402

# ── 配置 ──
TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
REF = os.environ.get("SUPABASE_PROJECT_REF", "adqznqsciqtepzimcvsg")

if not TOKEN:
    env_file = Path(__file__).parent.parent / "investdojo" / "apps" / "server" / ".env"
    if not env_file.exists():
        env_file = Path(__file__).parent / ".." / "apps" / "server" / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("SUPABASE_ACCESS_TOKEN="):
                TOKEN = line.split("=", 1)[1].strip()

if not TOKEN:
    print("❌ 需要 SUPABASE_ACCESS_TOKEN")
    sys.exit(1)

API_URL = f"https://api.supabase.com/v1/projects/{REF}/database/query"


def exec_sql(sql: str) -> tuple[bool, str]:
    result = subprocess.run(
        ["curl", "-sS", "-X", "POST", API_URL,
         "-H", f"Authorization: Bearer {TOKEN}",
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"query": sql}),
         "--max-time", "60"],
        capture_output=True, text=True,
    )
    body = result.stdout.strip()
    if result.returncode != 0:
        return False, result.stderr
    if body.startswith("[") or body == "":
        return True, body[:200]
    try:
        err = json.loads(body)
        if "message" in err:
            return False, err["message"][:300]
    except json.JSONDecodeError:
        pass
    return True, body[:200]


def escape_sql(s: str) -> str:
    """转义 SQL 字符串"""
    if s is None:
        return "NULL"
    return "'" + s.replace("'", "''") + "'"


# ── 采集 ──

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
    # 提取一级行业（行业代码的第一个字母 + 大类名）
    # 证监会分类格式：C26化学原料..., J66货币金融..., I65软件...
    level1_map: dict[str, str] = {}  # 一级代码 -> 一级名
    for name in industry_names:
        if len(name) >= 1:
            letter = name[0]
            # 一级行业只取字母
            if letter.isalpha() and letter.isupper():
                if letter not in level1_map:
                    # 一级名需要从更长的标准里来，暂用字母
                    level1_map[letter] = letter

    # 构造两级行业表
    industries_data = []
    ind_id = 1

    # 先插一级
    level1_ids: dict[str, int] = {}
    for letter in sorted(level1_map.keys()):
        level1_ids[letter] = ind_id
        industries_data.append((ind_id, letter, 1, None, letter))
        ind_id += 1

    # 再插二级（每个具体行业）
    for name in industry_names:
        if not name:
            continue
        letter = name[0] if name[0].isalpha() and name[0].isupper() else None
        parent = level1_ids.get(letter) if letter else None
        # 提取行业代码（如 C26, J66, I65）
        code = ""
        for i, ch in enumerate(name):
            if ch.isalpha() or ch.isdigit():
                code += ch
            else:
                break
        industries_data.append((ind_id, name, 2, parent, code))
        ind_id += 1

    print(f"  一级行业 {len(level1_ids)} 个，二级 {len(industry_names)} 个，总 {len(industries_data)} 条")

    # ── 4. 上传 industries ──
    print("\n⬆ 上传 industries...")

    # 批量 INSERT，每 50 条一批
    batch_size = 50
    uploaded = 0
    for i in range(0, len(industries_data), batch_size):
        batch = industries_data[i:i+batch_size]
        values = []
        for (iid, name, level, parent, code) in batch:
            parent_str = str(parent) if parent else "NULL"
            values.append(f"({iid}, {escape_sql(name)}, {level}, {parent_str}, {escape_sql(code)})")

        sql = (
            "INSERT INTO industries (id, name, level, parent_id, code) VALUES\n"
            + ",\n".join(values)
            + "\nON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, level=EXCLUDED.level, "
            "parent_id=EXCLUDED.parent_id, code=EXCLUDED.code"
        )
        ok, msg = exec_sql(sql)
        if not ok:
            print(f"  ❌ 批次 {i//batch_size}: {msg}")
        else:
            uploaded += len(batch)
            print(f"  ✅ {uploaded}/{len(industries_data)}", end="\r")

    print(f"\n  industries 上传完成: {uploaded} 条")

    # ── 5. 上传 symbols ──
    print("\n⬆ 上传 symbols...")

    # 构造 symbols 数据
    # BaoStock code 格式：sh.600000 → 我们要 600000
    # market: sh → A / sz → A / bj → A
    uploaded = 0
    batch_size = 100

    for i in range(0, len(stocks), batch_size):
        batch = stocks[i:i+batch_size]
        values = []
        for r in batch:
            bs_code, name, ipo, out, typ, status = r
            # 转换代码：sh.600000 → 600000
            code = bs_code.split(".")[-1]
            market_prefix = bs_code.split(".")[0]  # sh/sz
            market = "A"  # 统一标记为 A 股

            # 行业
            industry = ind_map.get(bs_code, "")
            # 分拆一级行业
            industry_l1 = ""
            if industry:
                for ch in industry:
                    if ch.isalpha() or ch.isdigit():
                        industry_l1 += ch
                    else:
                        break

            # 上市/退市日期
            listed = escape_sql(ipo) if ipo else "NULL"
            delisted = escape_sql(out) if out else "NULL"
            st = "'active'" if status == '1' else "'delisted'"

            values.append(
                f"({escape_sql(code)}, {escape_sql(market)}, {escape_sql(name)}, "
                f"{escape_sql(name)}, {escape_sql(industry)}, {escape_sql(industry_l1)}, "
                f"{listed}, {delisted}, {st})"
            )

        sql = (
            "INSERT INTO symbols (code, market, name, short_name, industry, industry_level2, "
            "listed_at, delisted_at, status) VALUES\n"
            + ",\n".join(values)
            + "\nON CONFLICT (code) DO UPDATE SET "
            "name=EXCLUDED.name, short_name=EXCLUDED.short_name, "
            "industry=EXCLUDED.industry, industry_level2=EXCLUDED.industry_level2, "
            "listed_at=EXCLUDED.listed_at, delisted_at=EXCLUDED.delisted_at, "
            "status=EXCLUDED.status, updated_at=NOW()"
        )
        ok, msg = exec_sql(sql)
        if not ok:
            print(f"  ❌ 批次 {i//batch_size}: {msg[:150]}")
        else:
            uploaded += len(batch)
            print(f"  ✅ {uploaded}/{len(stocks)}", end="\r")

    print(f"\n  symbols 上传完成: {uploaded} 条")

    # ── 6. 更新 industries 的 symbol_count ──
    print("\n📊 更新行业股票计数...")
    sql = """
    UPDATE industries i
    SET symbol_count = sub.cnt
    FROM (
        SELECT industry AS ind_name, COUNT(*) AS cnt
        FROM symbols
        WHERE industry IS NOT NULL AND industry != ''
        GROUP BY industry
    ) sub
    WHERE i.name = sub.ind_name AND i.level = 2
    """
    ok, msg = exec_sql(sql)
    print(f"  {'✅' if ok else '❌'} {msg[:100]}")

    print("\n🏁 T-1.02 完成!")


if __name__ == "__main__":
    main()
