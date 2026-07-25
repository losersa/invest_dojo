#!/usr/bin/env python3
"""增量更新日K数据（每日定时跑）

策略：
1. 查每支在市股票的 MAX(dt)
2. 从 MAX(dt)+1 到今天，只拉新数据
3. 如果已是最新，跳过
4. 跳过非交易日（BaoStock 返回空就是非交易日）

通常每天 19:00 后跑（A 股收盘 15:00 + 数据源同步）。
非交易日（周末/假日）跑也无害 —— 只是白跑没数据。

数据写入：本地 PostgreSQL（直连），按 (symbol, timeframe, dt) upsert。

用法：
    python scripts/update_daily_klines.py
    python scripts/update_daily_klines.py --dry-run     # 只显示计划
    python scripts/update_daily_klines.py --limit 10    # 只跑前 10 支（测试）
"""

import argparse
import os
import sys
import time
from datetime import datetime, timedelta
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

_ps = _repo / "python-services"
sys.path.insert(0, str(_ps))

import baostock as bs  # noqa: E402
from common.supabase_client import get_supabase_client  # noqa: E402


def _client():
    return get_supabase_client()


def _pg_conn():
    """用于聚合查询的直连（select_all 不支持 GROUP BY）"""
    import psycopg2
    return psycopg2.connect(
        host=os.environ.get("PG_HOST", "127.0.0.1"),
        port=int(os.environ.get("PG_PORT", "5432")),
        user=os.environ.get("PG_USER", "postgres"),
        password=os.environ.get("PG_PASSWORD", ""),
        dbname=os.environ.get("PG_DATABASE", "postgres"),
        connect_timeout=10,
    )


def fetch_latest_dt_map() -> dict:
    """返回 {symbol: 'YYYY-MM-DD' 最新日K日期}（聚合 SQL，避免拉全表）"""
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT symbol, MAX((dt AT TIME ZONE 'Asia/Shanghai')::date) "
            "FROM klines_all WHERE timeframe='1d' AND scenario_id IS NULL "
            "GROUP BY symbol"
        )
        return {sym: d.isoformat() if hasattr(d, "isoformat") else str(d) for sym, d in cur.fetchall()}
    finally:
        conn.close()


def fetch_active_stocks() -> list[tuple[str, str]]:
    """返回 [(code, name), ...]"""
    rows = _client().select_all(
        "symbols",
        columns="code,name",
        filters={"status": "eq.active"},
        order="code.asc",
        page_size=1000,
    )
    return [(r["code"], r.get("name", "")) for r in rows]


def insert_rows(rows: list) -> tuple[bool, str]:
    if not rows:
        return True, "empty"
    try:
        _client().insert("klines_all", rows, on_conflict="symbol,timeframe,dt")
        return True, "OK"
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:150]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    today = datetime.now().strftime("%Y-%m-%d")
    print(f"📅 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} — 增量更新日K")
    print(f"📊 目标日期: ≤ {today}")

    # 1. 查每支在市股票的最新日期
    print("\n📋 查询数据库现状...")
    last_dt_map = fetch_latest_dt_map()
    print(f"   已有 {len(last_dt_map)} 支股票的日K数据")

    # 2. 获取所有在市股票
    active_stocks = fetch_active_stocks()
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
            rate = (idx + 1) / elapsed * 60 if elapsed else 0
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
            })

        if not json_rows:
            continue

        ok, msg = insert_rows(json_rows)
        if ok:
            total_uploaded += len(json_rows)
        else:
            total_failed += 1
            print(f"\n  ❌ {code} 上传失败: {msg}")

        progress = idx + 1
        elapsed = time.monotonic() - start_time
        rate = (idx + 1) / elapsed * 60 if elapsed else 0
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
