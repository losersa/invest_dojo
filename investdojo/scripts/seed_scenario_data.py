#!/usr/bin/env python3
"""采集场景数据（日K + 5m）· 带超时保护的健壮版

核心改进：
  - signal.SIGALRM 强制单次 BaoStock 调用 15s 超时
  - 每支股票最多重试 3 次
  - 断点续传：查询已有数据，跳过完整的
  - BaoStock 崩溃自动重连

用法:
    python scripts/seed_scenario_data.py                    # 所有场景
    python scripts/seed_scenario_data.py --scenario ai_boom_2023
    python scripts/seed_scenario_data.py --timeframe 1d
    python scripts/seed_scenario_data.py --timeframe 5m
"""

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

socket.setdefaulttimeout(15)

import baostock as bs  # noqa: E402

# ── 超时保护 ──

class TimeoutError(Exception):
    pass


def _timeout_handler(signum, frame):
    raise TimeoutError("BaoStock 调用超时")


def with_timeout(seconds, func, *args, **kwargs):
    """用 SIGALRM 强制超时保护"""
    signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(seconds)
    try:
        return func(*args, **kwargs)
    finally:
        signal.alarm(0)


# ── 配置 ──
SUPABASE_URL = ""
SERVICE_KEY = ""
TOKEN = ""

for ef in [
    Path(__file__).parent / ".." / "apps" / "server" / ".env",
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

if not all([SUPABASE_URL, SERVICE_KEY, TOKEN]):
    print("❌ 缺少 SUPABASE 配置")
    sys.exit(1)

REST_URL = f"{SUPABASE_URL}/rest/v1/klines_all"
REF = SUPABASE_URL.replace("https://", "").replace(".supabase.co", "")
MGMT_API = f"https://api.supabase.com/v1/projects/{REF}/database/query"


def mgmt_query(sql: str) -> list:
    for i in range(3):
        r = subprocess.run(
            ["curl", "-sS", "-X", "POST", MGMT_API,
             "-H", f"Authorization: Bearer {TOKEN}",
             "-H", "Content-Type: application/json",
             "-d", json.dumps({"query": sql}),
             "--max-time", "30"],
            capture_output=True, text=True,
        )
        b = r.stdout.strip()
        if b == "":
            return []
        if b.startswith("["):
            return json.loads(b)
        time.sleep(2)
    return []


def post_rows(rows: list) -> tuple[bool, str]:
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


def bs_code(symbol: str) -> str:
    if symbol.startswith(("6", "9")):
        return f"sh.{symbol}"
    if symbol.startswith(("0", "2", "3")):
        return f"sz.{symbol}"
    return f"bj.{symbol}"


# ── BaoStock 封装（带超时）──

def bs_login_safe(max_retries=3) -> bool:
    """登录 BaoStock，带超时保护和重试"""
    for attempt in range(max_retries):
        try:
            # logout 现有连接（避免 session 泄漏）
            try:
                with_timeout(5, bs.logout)
            except:
                pass
            # login
            lg = with_timeout(15, bs.login)
            if lg.error_code == '0':
                return True
            print(f"    ⚠ login 失败 code={lg.error_code} msg={lg.error_msg}")
        except TimeoutError:
            print(f"    ⚠ login 超时（尝试 {attempt+1}/{max_retries}）")
        except Exception as e:
            print(f"    ⚠ login 异常: {e}")
        time.sleep(5)
    return False


def bs_fetch_safe(bs_sym: str, start: str, end: str, freq: str, max_retries=3):
    """从 BaoStock 拉数据，带超时保护和重试"""
    # BaoStock 字段约束：
    # - 日K 支持 pctChg
    # - 5m/15m/30m/1h 不支持 pctChg（会报 10004012 错误）
    if freq == "d":
        fields = "date,open,high,low,close,volume,amount,pctChg"
    else:
        # 5m 返回：date, time, open, high, low, close, volume, amount
        fields = "date,time,open,high,low,close,volume,amount"

    for attempt in range(max_retries):
        try:
            def _do_query():
                rs = bs.query_history_k_data_plus(
                    bs_sym, fields,
                    start_date=start, end_date=end,
                    frequency=freq, adjustflag="2"
                )
                rows = []
                while rs.error_code == '0' and rs.next():
                    rows.append(rs.get_row_data())
                return rows

            rows = with_timeout(60, _do_query)  # 5 个月 ~4900 行，给足时间
            return rows
        except TimeoutError:
            print(f"    ⚠ 查询超时 {bs_sym} {freq} (尝试 {attempt+1})，重连...")
            if not bs_login_safe():
                return None
        except Exception as e:
            print(f"    ⚠ 查询异常 {bs_sym}: {e}")
            time.sleep(3)
    return None


def build_rows(raw: list, symbol: str, scenario_id: str, timeframe: str) -> list:
    out = []
    for r in raw:
        if timeframe == "1d":
            # 日K 8 字段：date,open,high,low,close,volume,amount,pctChg
            dt_str = r[0]
            dt_ts = f"{dt_str}T00:00:00+08:00"
            op, hi, lo, cl = r[1], r[2], r[3], r[4]
            vol, amt, pct = r[5], r[6], r[7]
        else:
            # 5m 8 字段：date,time,open,high,low,close,volume,amount
            # time 格式：20230201093500000
            t = r[1]
            dt_ts = f"{t[:4]}-{t[4:6]}-{t[6:8]}T{t[8:10]}:{t[10:12]}:{t[12:14]}+08:00"
            op, hi, lo, cl = r[2], r[3], r[4], r[5]
            vol, amt = r[6], r[7]
            pct = 0  # 5m 不支持 pctChg，默认 0

        op_f = float(op) if op else 0
        cl_f = float(cl) if cl else 0
        if op_f == 0 and cl_f == 0:
            continue

        out.append({
            "scenario_id": scenario_id,
            "symbol": symbol,
            "timeframe": timeframe,
            "dt": dt_ts,
            "open": float(op), "high": float(hi), "low": float(lo), "close": float(cl),
            "volume": int(float(vol)) if vol else 0,
            "turnover": float(amt) if amt else 0,
            "change_percent": float(pct) if pct else 0,
            "adj_factor": 1,
        })
    return out


def upload_in_batches(rows: list, batch_size: int = 1000) -> tuple[int, int]:
    ok_cnt = fail_cnt = 0
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        ok, msg = post_rows(batch)
        if ok:
            ok_cnt += len(batch)
        else:
            fail_cnt += len(batch)
            print(f"    ⚠ 批次失败: {msg[:100]}")
    return ok_cnt, fail_cnt


def check_existing(scenario_id: str, symbol: str, timeframe: str) -> int:
    """查已有多少行"""
    r = mgmt_query(
        f"SELECT COUNT(*) as cnt FROM klines_all "
        f"WHERE scenario_id='{scenario_id}' AND symbol='{symbol}' AND timeframe='{timeframe}'"
    )
    return r[0]["cnt"] if r else 0


def process_scenario(sc: dict, timeframes: list) -> None:
    sc_id = sc["id"]
    start = sc["date_start"]
    end = sc["date_end"]
    symbols = sc["symbols"]

    print(f"\n━━━ 场景: {sc_id} ({sc['name']}) ━━━")
    print(f"  时间: {start} ~ {end}  股票: {symbols}")

    for tf in timeframes:
        freq = "d" if tf == "1d" else "5"
        print(f"\n  📊 {tf}:")
        total_ok = 0
        for sym in symbols:
            existing = check_existing(sc_id, sym, tf)
            if existing > 0:
                print(f"    ⏭ {sym}: 已有 {existing} 行，跳过")
                continue

            bs_sym = bs_code(sym)
            t0 = time.monotonic()
            raw = bs_fetch_safe(bs_sym, start, end, freq)
            if raw is None:
                print(f"    ❌ {sym}: 多次超时，放弃（下次重跑可补）")
                continue
            if not raw:
                print(f"    ⚠ {sym}: BaoStock 返回空")
                continue

            rows = build_rows(raw, sym, sc_id, tf)
            if not rows:
                print(f"    ⚠ {sym}: 无有效数据")
                continue

            ok, fail = upload_in_batches(rows)
            dur = time.monotonic() - t0
            total_ok += ok
            print(f"    ✅ {sym}: {ok} 行 ({dur:.1f}s)")
        print(f"  小计 {tf}: {total_ok} 行新增")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", type=str, help="只跑指定场景 id")
    parser.add_argument("--timeframe", choices=["1d", "5m", "all"], default="all")
    args = parser.parse_args()

    if args.scenario:
        scs = mgmt_query(f"SELECT * FROM scenarios WHERE id='{args.scenario}'")
    else:
        scs = mgmt_query("SELECT * FROM scenarios ORDER BY date_start")

    if not scs:
        print("❌ 没有场景")
        sys.exit(1)

    print(f"📋 将处理 {len(scs)} 个场景:")
    for s in scs:
        print(f"  {s['id']}: {s['date_start']} ~ {s['date_end']}")

    timeframes = ["1d", "5m"] if args.timeframe == "all" else [args.timeframe]

    print("\n🔌 登录 BaoStock（带超时保护）...")
    if not bs_login_safe():
        print("❌ 多次登录失败，退出")
        sys.exit(1)
    print("  ✅ 登录成功")

    t_total = time.monotonic()
    try:
        for sc in scs:
            process_scenario(sc, timeframes)
    finally:
        try:
            with_timeout(5, bs.logout)
        except:
            pass

    print(f"\n🏁 总耗时: {(time.monotonic()-t_total)/60:.1f} 分钟")


if __name__ == "__main__":
    main()
