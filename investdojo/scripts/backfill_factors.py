#!/usr/bin/env python3
"""全量回填因子值到 feature_values 表（T-3.05）

用法：
    # dry-run 看看会写多少
    python scripts/backfill_factors.py --from 2024-01-01 --to 2024-12-31 --dry-run

    # 完整全量（耗时很长，分年跑）
    python scripts/backfill_factors.py --from 2014-01-01 --to 2024-12-31

    # 小样本试试
    python scripts/backfill_factors.py --from 2024-11-01 --to 2024-12-31 \
        --symbols 600519,000001,000858 --factor-ids pe_ttm_scalar,roe_scalar

    # 按年分片
    python scripts/backfill_factors.py --year 2023

策略：
- 每年一个大 batch，年内按股票批次切（100 只/批）
- feature_values 有分区表（feature_values_2014 .. _2024），写入自动路由
- 断点续传：已存在的 (factor_id, symbol, date) 会被 upsert 覆盖（幂等）
- 推荐逐年跑，方便监控 + 断点
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "python-services"))
sys.path.insert(0, str(Path(__file__).parent.parent / "python-services" / "feature-svc"))

from factors.batch_compute import compute_and_save  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--from", dest="start", help="YYYY-MM-DD")
    parser.add_argument("--to", dest="end", help="YYYY-MM-DD")
    parser.add_argument("--year", type=int, help="整年回填（覆盖 --from/--to）")
    parser.add_argument("--factor-ids", help="逗号分隔，默认全部 platform 因子")
    parser.add_argument("--symbols", help="逗号分隔，默认 symbols 表全量")
    parser.add_argument("--batch-size", type=int, default=100, help="每批股票数")
    parser.add_argument("--symbol-limit", type=int, help="只取前 N 支（调试用）")
    parser.add_argument("--dry-run", action="store_true", help="不写库")
    args = parser.parse_args()

    # 日期解析
    if args.year:
        start = f"{args.year}-01-01"
        end = f"{args.year}-12-31"
    elif args.start and args.end:
        start = args.start
        end = args.end
    else:
        parser.error("需要 --year 或 --from/--to")

    factor_ids = args.factor_ids.split(",") if args.factor_ids else None
    symbols = args.symbols.split(",") if args.symbols else None

    # 如果没指定 symbols 但指定了 --symbol-limit，就从 DB 取前 N 支
    if symbols is None and args.symbol_limit:
        from factors.batch_compute import _load_active_symbols  # noqa: PLC0415

        symbols = _load_active_symbols(limit=args.symbol_limit)

    print("═" * 58)
    print("  📊 InvestDojo 因子值全量回填")
    print(f"  区间: {start} ~ {end}")
    print(f"  因子: {'全部 platform' if factor_ids is None else f'{len(factor_ids)} 个'}")
    print(f"  股票: {'symbols 全部' if symbols is None else f'{len(symbols)} 个'}")
    print(f"  每批: {args.batch_size} 只股票")
    print(f"  模式: {'🧪 DRY-RUN' if args.dry_run else '✍️  实际写入'}")
    print("═" * 58)

    t0 = time.perf_counter()
    result = compute_and_save(
        start=start,
        end=end,
        factor_ids=factor_ids,
        symbols=symbols,
        batch_size=args.batch_size,
        dry_run=args.dry_run,
    )
    duration = time.perf_counter() - t0

    print()
    print("══════════════════════════════════════════")
    print(f"  ✅ 写入 {result['records_written']:,} 条")
    print(f"  📋 因子: {result['factors_computed']}")
    print(f"  📋 股票: {result['symbols']}")
    print(f"  📋 批次: {result['batches']}")
    print(f"  ⏱  耗时: {duration:.1f} 秒（{duration / 60:.1f} 分钟）")
    if result["errors"]:
        print(f"  ⚠  错误: {len(result['errors'])}（前 5 条）")
        for e in result["errors"][:5]:
            print(f"     {e}")
    print("══════════════════════════════════════════")


if __name__ == "__main__":
    main()
