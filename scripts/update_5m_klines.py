#!/usr/bin/env python3
"""增量更新 5 分钟 K 线 + 同步聚合出日 K 落库（每个交易日盘后例行跑）

管线（替代原 update_daily_klines.py 的独立日 K 拉取）：
1. 查每股 5m 最新日期（klines_all timeframe='5m', scenario_id IS NULL）
2. BaoStock 拉 5m（frequency="5"，注意：分钟级接口不支持 pctChg 字段）
   → upsert klines_all(timeframe='5m')
3. 内存聚合 5m→1d（open/high/low/close/volume/turnover + pre_close/change_percent）
   → upsert klines_all(timeframe='1d')

约定（与 update_daily_klines.py 一致，保证 upsert 冲突键命中、不产生重复行）：
- 日 K dt = `{date}T00:00:00+08:00`
- 5m dt 由 BaoStock time 字段（yyyyMMddHHmmssmmm，北京时间）解析为 ISO+08:00
- 聚合窗口首日的 pre_close：查库取该股前一交易日 1d close（窗口内其余日 shift 得出）

增量模式的交易日自检：end 回退到最近交易日（上证指数日K探测），
周末/法定节假日零空跑（否则会对全部股票白打一轮 BaoStock 请求 → 限流）。

用法：
    python scripts/update_5m_klines.py                          # 增量：MAX(5m)+1 → 今天
    python scripts/update_5m_klines.py --from 2026-05-01 --to 2026-07-24   # 回补空缺段
    python scripts/update_5m_klines.py --limit 10 --dry-run     # 测试
"""

import argparse
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

# ── 0. 先准备环境（必须在 import common 之前）──
_repo = Path(__file__).resolve().parent.parent
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

BACKFILL_DEFAULT_START = "2026-01-01"  # 全新股票的 5m 拉取起点（5m 数据量大，不从 2020 拉）


def _client():
    return get_supabase_client()


def _pg_conn():
    """聚合/点查用直连（select_all 不支持 GROUP BY / LIMIT 1 点查也更快）"""
    import psycopg2
    return psycopg2.connect(
        host=os.environ.get("PG_HOST", "127.0.0.1"),
        port=int(os.environ.get("PG_PORT", "5432")),
        user=os.environ.get("PG_USER", "postgres"),
        password=os.environ.get("PG_PASSWORD", ""),
        dbname=os.environ.get("PG_DATABASE", "postgres"),
        connect_timeout=10,
        keepalives=1,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=5,
    )


def fetch_latest_5m_map() -> dict:
    """{symbol: 'YYYY-MM-DD' 最新 5m 日期（北京日）}"""
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT symbol, MAX((dt AT TIME ZONE 'Asia/Shanghai')::date) "
            "FROM klines_all WHERE timeframe='5m' AND scenario_id IS NULL "
            "GROUP BY symbol"
        )
        return {sym: d.isoformat() if hasattr(d, "isoformat") else str(d) for sym, d in cur.fetchall()}
    finally:
        conn.close()


def fetch_prev_close(cur, symbol: str, before_date: str) -> float | None:
    """before_date 之前最近的 1d 收盘价（聚合窗口首日 pre_close 用）。

    走 idx_klines_symbol_timeframe (symbol, timeframe, dt DESC) 索引，点查毫秒级。
    """
    cur.execute(
        "SELECT close FROM klines_all "
        "WHERE symbol=%s AND timeframe='1d' AND scenario_id IS NULL "
        "AND dt < %s::timestamptz ORDER BY dt DESC LIMIT 1",
        (symbol, f"{before_date}T00:00:00+08:00"),
    )
    row = cur.fetchone()
    return float(row[0]) if row and row[0] is not None else None


def fetch_active_stocks() -> list[tuple[str, str]]:
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


def _bs_code(code: str) -> str:
    if code.startswith(("6", "9")):
        return f"sh.{code}"
    if code.startswith(("0", "2", "3")):
        return f"sz.{code}"
    return f"bj.{code}"


def bs_login_retry(max_retries: int = 5) -> bool:
    """BaoStock 登录带重试：限流会间歇返回 10001011「黑名单用户」，退避后多可恢复。"""
    for attempt in range(max_retries):
        lg = bs.login()
        if lg.error_code == "0":
            return True
        wait = 3 * (attempt + 1)
        print(f"  ⚠ login 失败(尝试{attempt+1}/{max_retries}): {lg.error_msg}，{wait}s 后重试")
        time.sleep(wait)
    print("❌ BaoStock 登录持续失败（可能真被限流/封禁，稍后再跑）")
    return False


def is_trade_day(date_str: str) -> bool:
    """date_str 是否 A 股交易日：拉上证指数当天日 K，有数据=交易日。

    用于增量模式在周末/法定节假日直接退出——否则会对 5200 只股票白打一轮空请求
    （BaoStock 限流风险，见 docs/ops/dev-troubleshooting.md ## 16）。
    """
    rs = bs.query_history_k_data_plus(
        "sh.000001", "date",
        start_date=date_str, end_date=date_str,
        frequency="d", adjustflag="2",
    )
    return rs.error_code == "0" and rs.next()


def fetch_5m(bs_code: str, start: str, end: str, max_retries: int = 3) -> list | None:
    """BaoStock 拉 5m，带重试。返回行列表（None=失败，[]=无数据/非交易日）。"""
    # 分钟级不支持 pctChg（报 10004012）；返回字段：date,time,open,high,low,close,volume,amount
    fields = "date,time,open,high,low,close,volume,amount"
    for attempt in range(max_retries):
        try:
            rs = bs.query_history_k_data_plus(
                bs_code, fields,
                start_date=start, end_date=end,
                frequency="5", adjustflag="2",
            )
            rows = []
            while rs.error_code == "0" and rs.next():
                rows.append(rs.get_row_data())
            return rows
        except Exception as e:  # noqa: BLE001
            print(f"\n  ⚠ {bs_code} BaoStock 异常(尝试{attempt+1}/{max_retries}): {e}")
            time.sleep(2 * (attempt + 1))
            bs_login_retry(max_retries=2)  # 断线重连
    return None


def parse_5m_rows(raw: list, code: str) -> list[dict]:
    """BaoStock 5m 行 → klines_all 行。time 格式：20230201093500000（北京时间）。"""
    out = []
    for r in raw:
        t = r[1]
        dt_ts = f"{t[:4]}-{t[4:6]}-{t[6:8]}T{t[8:10]}:{t[10:12]}:{t[12:14]}+08:00"
        op, hi, lo, cl = r[2], r[3], r[4], r[5]
        op_f = float(op) if op else 0
        cl_f = float(cl) if cl else 0
        if op_f == 0 and cl_f == 0:
            continue
        out.append({
            "symbol": code,
            "timeframe": "5m",
            "dt": dt_ts,
            "open": float(op), "high": float(hi), "low": float(lo), "close": float(cl),
            "volume": int(float(r[6])) if r[6] else 0,
            "turnover": float(r[7]) if r[7] else 0,
        })
    return out


def aggregate_to_1d(rows_5m: list[dict], code: str, prev_close: float | None) -> list[dict]:
    """5m 行 → 1d 行（按北京日聚合；dt 约定 {date}T00:00:00+08:00）。"""
    by_date: dict[str, list[dict]] = {}
    for r in rows_5m:
        by_date.setdefault(r["dt"][:10], []).append(r)

    out = []
    pc = prev_close
    for d in sorted(by_date):
        bars = by_date[d]
        op = bars[0]["open"]
        cl = bars[-1]["close"]
        hi = max(b["high"] for b in bars)
        lo = min(b["low"] for b in bars)
        vol = sum(b["volume"] for b in bars)
        amt = sum(b["turnover"] for b in bars)
        change_percent = round((cl - pc) / pc * 100, 4) if pc else 0
        out.append({
            "symbol": code,
            "timeframe": "1d",
            "dt": f"{d}T00:00:00+08:00",
            "open": op, "high": hi, "low": lo, "close": cl,
            "volume": vol,
            "turnover": round(amt, 2),
            "pre_close": pc,
            "change_percent": change_percent,
        })
        pc = cl  # 下一交易日的 pre_close
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--from", dest="from_date", default=None, help="回补起点 YYYY-MM-DD")
    parser.add_argument("--to", dest="to_date", default=None, help="回补终点 YYYY-MM-DD")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    today = datetime.now().strftime("%Y-%m-%d")
    backfill = bool(args.from_date)
    end_date = args.to_date or today

    print(f"📅 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} — 5m K线更新 + 聚合日K")
    mode = f"回补 {args.from_date} ~ {end_date}" if backfill else f"增量 → {end_date}"
    print(f"📊 模式: {mode}")

    print("\n📋 查询数据库现状...")
    active_stocks = fetch_active_stocks()
    print(f"   在市股票 {len(active_stocks)} 支")

    if args.limit > 0:
        active_stocks = active_stocks[: args.limit]
        print(f"   --limit {args.limit}，只跑前 {len(active_stocks)} 支")

    if backfill:
        need_update = [(c, n, args.from_date) for c, n in active_stocks]
    else:
        # 交易日自检（增量模式）：把 end 回退到最近交易日——周末/法定节假日
        # 空跑会对全部股票白打一轮 BaoStock 空请求（限流风险，手册 ## 16）。
        print("\n🔌 登录 BaoStock（交易日自检）...")
        if not bs_login_retry():
            sys.exit(1)
        d = end_date
        trade_end = None
        for _ in range(10):  # 最多回看 10 天（覆盖春节/国庆长假）
            if is_trade_day(d):
                trade_end = d
                break
            d = (datetime.strptime(d, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
        if trade_end is None:
            print("❌ 近 10 天无交易日（数据源异常？），退出")
            bs.logout()
            sys.exit(1)
        if trade_end != end_date:
            print(f"📆 {end_date} 非交易日，end 回退到最近交易日 {trade_end}")
            end_date = trade_end

        last_dt_map = fetch_latest_5m_map()
        print(f"   已有 {len(last_dt_map)} 支股票的 5m 数据")
        need_update = []
        for code, name in active_stocks:
            last_dt = last_dt_map.get(code)
            if last_dt is None:
                if BACKFILL_DEFAULT_START <= end_date:
                    need_update.append((code, name, BACKFILL_DEFAULT_START))
            elif last_dt < end_date:
                start = (datetime.strptime(last_dt, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
                if start <= end_date:  # start > end（如周末回退后）= 无活干
                    need_update.append((code, name, start))

    print(f"   需要更新: {len(need_update)} 支")

    if args.dry_run:
        print("\n📋 [DRY-RUN] 前 5 支:")
        for code, name, start in need_update[:5]:
            print(f"   {code} {name}: {start} → {end_date}")
        return

    if not need_update:
        print("\n✅ 全部最新，无需更新")
        return

    if backfill:
        print("\n🔌 登录 BaoStock...")
        if not bs_login_retry():
            sys.exit(1)

    # 每股起点不同，pre_close 在循环内按 (code, start_date) 逐股查（复用同一连接）
    prev_conn = _pg_conn()
    prev_cur = prev_conn.cursor()

    start_time = time.monotonic()
    total_5m = 0
    total_1d = 0
    total_no_data = 0
    total_failed = 0

    for idx, (code, name, start_date) in enumerate(need_update):
        raw = fetch_5m(_bs_code(code), start_date, end_date)
        if raw is None:
            total_failed += 1
            print(f"\n  ❌ {code} 拉取失败")
            continue
        if not raw:
            total_no_data += 1
        else:
            rows_5m = parse_5m_rows(raw, code)
            prev_close = fetch_prev_close(prev_cur, code, start_date)
            rows_1d = aggregate_to_1d(rows_5m, code, prev_close)

            ok, msg = insert_rows(rows_5m)
            if ok:
                total_5m += len(rows_5m)
            else:
                total_failed += 1
                print(f"\n  ❌ {code} 5m 上传失败: {msg}")

            ok, msg = insert_rows(rows_1d)
            if ok:
                total_1d += len(rows_1d)
            else:
                total_failed += 1
                print(f"\n  ❌ {code} 1d 上传失败: {msg}")

        progress = idx + 1
        elapsed = time.monotonic() - start_time
        rate = progress / elapsed * 60 if elapsed else 0
        print(
            f"\r  [{progress}/{len(need_update)}] {code} {name}: "
            f"5m+{total_5m} 1d+{total_1d} | {rate:.0f}支/min",
            end="", flush=True,
        )

    bs.logout()
    prev_conn.close()

    elapsed_total = time.monotonic() - start_time
    print(f"\n\n🏁 完成")
    print(f"   5m 上传: {total_5m} 行")
    print(f"   1d 聚合上传: {total_1d} 行")
    print(f"   无新数据: {total_no_data} 支（非交易日 / 停牌）")
    print(f"   失败: {total_failed}")
    print(f"   耗时: {elapsed_total/60:.1f} 分钟")


if __name__ == "__main__":
    main()
