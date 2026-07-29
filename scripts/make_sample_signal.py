"""生成并上传一个示例信号文件到 MinIO，用于 signal_file 类型回测的冒烟测试。

用法（在 python-services 目录下执行）：
    PYTHONPATH=/data/home/studyinguo/investdojo/python-services \
        python ../scripts/make_sample_signal.py \
        --signal-id sig_demo --start 2026-01-01 --end 2026-07-27 \
        --symbols 000001,000002,000063,000100,000333,000651,000858,002594,600000,600036,600276,600519 \
        --top 5

输出 signal_file_id（即传给回测 strategy.signal_file_id 的值）。
回测引擎会按 signals/{signal_id}.csv 从 MinIO 读取，文件需含列：date,symbol,score。
"""
from __future__ import annotations

import argparse
import csv
import io
import math
import random

from common.minio_client import upload_bytes

DEFAULT_SYMBOLS = [
    "000001", "000002", "000063", "000100", "000333", "000651",
    "000858", "002594", "600000", "600036", "600276", "600519",
]


def build_csv(start: str, end: str, symbols: list[str], seed: int = 42) -> bytes:
    import pandas as pd

    dates = pd.bdate_range(start, end)
    rng = random.Random(seed)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["date", "symbol", "score"])
    for d in dates:
        # 每只股票一个随日期缓慢漂移的“信号”，制造轮动，使 Top-N 持仓随时间变化
        for i, sym in enumerate(symbols):
            base = math.sin((d.dayofyear + i * 7) / 18.0)
            noise = rng.uniform(-0.3, 0.3)
            score = round(base + noise, 4)
            w.writerow([d.strftime("%Y-%m-%d"), sym, score])
    return buf.getvalue().encode("utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--signal-id", default="sig_demo")
    ap.add_argument("--start", default="2026-01-01")
    ap.add_argument("--end", default="2026-07-27")
    ap.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    data = build_csv(args.start, args.end, symbols, args.seed)
    object_name = f"signals/{args.signal_id}.csv"
    path = upload_bytes(object_name, data, content_type="text/csv")
    print(f"uploaded: {path}")
    print(f"signal_file_id (传给回测 strategy.signal_file_id): {args.signal_id}")


if __name__ == "__main__":
    main()
