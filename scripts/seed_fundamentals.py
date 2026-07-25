#!/usr/bin/env python3
"""T-1.05 · 财报采集（5 大报表）

数据源：BaoStock
目标：fundamentals 表（本地 PostgreSQL，直连）

采集范围：全 A 股 × 2019Q1 ~ 2024Q4（可调，默认 2021Q1 ~ 2026Q1）
5 大报表：profit / balance / cashflow / growth / operation

每支股票 × 每季度 × 5 报表 = 5 条记录

特性：
  - signal.SIGALRM 超时保护
  - 断点续传（查已有的 symbol+report_date+statement 组合）
  - 批量 upsert 到本地 PostgreSQL（get_supabase_client）

用法:
    python scripts/seed_fundamentals.py                      # 全量（默认 2021~2026）
    python scripts/seed_fundamentals.py --limit 50           # 只跑前 50 支（先验证）
    python scripts/seed_fundamentals.py --start-year 2023    # 只采 2023 起
"""

import argparse
import os
import signal
import sys
import time
from pathlib import Path

# ── 0. 先准备环境（必须在 import common 之前）──
# 脚本位于 <repo>/scripts/，仓库根在上一级。
_repo = Path(__file__).resolve().parent.parent
# 本地 PG 凭据在 infra/supabase-lite/.env 的 POSTGRES_PASSWORD。
_infra = _repo / "infra" / "supabase-lite" / ".env"
if _infra.exists() and not os.environ.get("PG_PASSWORD"):
    for line in _infra.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("POSTGRES_PASSWORD="):
            os.environ["PG_PASSWORD"] = line.split("=", 1)[1].strip()

# 把 python-services 加入 path，使 `from common...` 可用
_ps = _repo / "python-services"
sys.path.insert(0, str(_ps))

import baostock as bs  # noqa: E402

from common.supabase_client import get_supabase_client  # noqa: E402


# ── 超时保护 ──

class TimeoutError(Exception):
    pass


def _th(s, f):
    raise TimeoutError()


signal.signal(signal.SIGALRM, _th)


def with_timeout(seconds, func, *args, **kwargs):
    signal.alarm(seconds)
    try:
        return func(*args, **kwargs)
    finally:
        signal.alarm(0)


# ── 本地 PG 读写封装 ──

def _client():
    return get_supabase_client()


def fetch_symbols() -> list[str]:
    """返回全部在市股票代码（status='active'）"""
    rows = _client().select_all(
        "symbols",
        columns="code",
        filters={"status": "eq.active"},
        order="code.asc",
        page_size=1000,
    )
    return [r["code"] for r in rows if r.get("code")]


def fetch_existing_keys() -> set:
    """返回已有的 (symbol, report_date, statement) 组合，用于断点续传"""
    rows = _client().select_all(
        "fundamentals",
        columns="symbol,report_date,statement",
        page_size=1000,
    )
    return {(r["symbol"], r["report_date"], r["statement"]) for r in rows}


def insert_rows(rows: list) -> tuple[bool, str]:
    """批量 upsert 到 fundamentals（按 symbol,report_date,statement 冲突覆盖）"""
    if not rows:
        return True, "empty"
    try:
        _client().insert(
            "fundamentals",
            rows,
            on_conflict="symbol,report_date,statement",
        )
        return True, "OK"
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:200]


def bs_code(symbol: str) -> str:
    if symbol.startswith(("6", "9")):
        return f"sh.{symbol}"
    if symbol.startswith(("0", "2", "3")):
        return f"sz.{symbol}"
    return f"bj.{symbol}"


# ── BaoStock ──

def bs_login_safe(max_retries=3) -> bool:
    for attempt in range(max_retries):
        try:
            try:
                with_timeout(5, bs.logout)
            except Exception:
                pass
            lg = with_timeout(15, bs.login)
            if lg.error_code == '0':
                return True
            print(f"    ⚠ login {attempt+1}: {lg.error_code} {lg.error_msg}")
        except TimeoutError:
            print(f"    ⚠ login {attempt+1}: 超时")
        except Exception as e:
            print(f"    ⚠ login {attempt+1}: {e}")
        time.sleep(5)
    return False


def fetch_one(query_fn, bs_sym: str, year: int, quarter: int) -> tuple[list, list]:
    """调用单个 BaoStock 接口，返回 (rows, fields)"""
    def _do():
        rs = query_fn(code=bs_sym, year=year, quarter=quarter)
        rows = []
        while rs.error_code == '0' and rs.next():
            rows.append(rs.get_row_data())
        return rows, rs.fields

    try:
        return with_timeout(20, _do)
    except TimeoutError:
        return [], []
    except Exception:
        return [], []


def zip_to_dict(fields: list, row: list) -> dict:
    """把 BaoStock 返回行转 dict，自动清理空字符串"""
    d = {}
    for k, v in zip(fields, row):
        if v == "" or v is None:
            d[k] = None
        else:
            # 尝试转数字
            try:
                d[k] = float(v) if "." in str(v) or "e" in str(v).lower() else int(v)
            except (ValueError, TypeError):
                d[k] = v
    return d


# ── 主逻辑 ──

STATEMENTS = [
    ("profit", "query_profit_data"),
    ("balance", "query_balance_data"),
    ("cashflow", "query_cash_flow_data"),
    ("growth", "query_growth_data"),
    ("operation", "query_operation_data"),
]


def process_stock(symbol: str, years_quarters: list, existing_keys: set) -> tuple[int, bool]:
    """处理单支股票，返回 (新增行数, 是否全空)"""
    bs_sym = bs_code(symbol)
    new_rows = []
    queries_done = 0

    for year, quarter in years_quarters:
        report_date = f"{year}-Q{quarter}"

        for stmt_name, fn_name in STATEMENTS:
            key = (symbol, report_date, stmt_name)
            if key in existing_keys:
                continue

            query_fn = getattr(bs, fn_name)
            rows, fields = fetch_one(query_fn, bs_sym, year, quarter)
            queries_done += 1

            if not rows:
                continue

            row = rows[0]
            d = zip_to_dict(fields, row)

            pub_date = d.get("pubDate")
            if not pub_date:
                continue

            new_rows.append({
                "symbol": symbol,
                "report_date": report_date,
                "announce_date": str(pub_date),
                "statement": stmt_name,
                "data": d,
                "source": "baostock",
            })

    # 批量上传
    if new_rows:
        ok, msg = insert_rows(new_rows)
        if not ok:
            time.sleep(2)
            ok, msg = insert_rows(new_rows)
            if not ok:
                print(f"\n    ❌ {symbol} 上传失败: {msg[:120]}")
                return 0, False

    # 判断是否应该"全空"（该股票上市时间覆盖这些季度，但一条都没拿到）
    # 通常 2021-2026 × 5 报表 × 24 季度 ≥ 60 条，小于这个阈值算异常
    is_all_empty = len(new_rows) == 0 and queries_done > 60
    return len(new_rows), is_all_empty


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--start-year", type=int, default=2021)
    parser.add_argument("--end-year", type=int, default=2026)
    args = parser.parse_args()

    print(f"📊 范围: {args.start_year}Q1 ~ {args.end_year}Q4")
    print("🔌 登录 BaoStock...")

    if not bs_login_safe():
        print("❌ 登录失败")
        sys.exit(1)
    print("  ✅ 登录成功")

    # 1. 股票列表
    all_codes = fetch_symbols()
    if args.limit > 0:
        all_codes = all_codes[:args.limit]
    print(f"📋 待处理: {len(all_codes)} 支股票\n")

    # 2. 已有数据（断点续传）
    print("📋 查询已有财报...")
    existing_keys = fetch_existing_keys()
    print(f"  已有 {len(existing_keys)} 条记录")

    # 3. 季度列表
    years_quarters = [(y, q) for y in range(args.start_year, args.end_year + 1) for q in range(1, 5)]

    # 4. 逐支处理
    print(f"\n🚀 开始采集（{len(years_quarters)} 季度 × 5 报表 / 支）...")
    start_ts = time.monotonic()
    total_new = 0
    total_done = 0
    total_fail = 0
    consecutive_empty = 0  # 连续全空计数（检测 BaoStock 断连）

    for idx, code in enumerate(all_codes):
        try:
            n, is_empty = process_stock(code, years_quarters, existing_keys)
            total_new += n
            total_done += 1

            # 检测异常：连续多支"全查空"说明 BaoStock 断连
            if is_empty:
                consecutive_empty += 1
                if consecutive_empty >= 3:
                    print(f"\n    ⚠ 连续 {consecutive_empty} 支全空，疑似 BaoStock 断连，尝试重连...")
                    if bs_login_safe():
                        print("    ✅ 重连成功，继续")
                        consecutive_empty = 0
                    else:
                        print("    ❌ 重连失败，终止（下次重跑可补）")
                        break
            else:
                consecutive_empty = 0
        except Exception as e:
            total_fail += 1
            print(f"\n    ❌ {code}: {e}")
            bs_login_safe()

        elapsed = time.monotonic() - start_ts
        rate_stocks = (idx + 1) / elapsed * 60
        remain = (len(all_codes) - idx - 1) / rate_stocks if rate_stocks > 0 else 0
        print(
            f"\r  [{idx+1}/{len(all_codes)}] {code}: +{n} 条 | "
            f"总新增:{total_new:,} | {rate_stocks:.0f}支/min | ~{remain:.0f}min剩余",
            end="", flush=True,
        )

    bs.logout()

    elapsed_total = time.monotonic() - start_ts
    print(f"\n\n🏁 完成!")
    print(f"  处理: {total_done}/{len(all_codes)} 支")
    print(f"  失败: {total_fail}")
    print(f"  新增: {total_new:,} 条")
    print(f"  耗时: {elapsed_total/60:.1f} 分钟")


if __name__ == "__main__":
    main()
