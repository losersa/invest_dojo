#!/usr/bin/env python3
"""T-1.06 市场快照每日增量更新.

每日收盘后（19:00 之后）跑一次，追加最新交易日的快照。
调用同一个 seed 脚本，但只跑 "今天" 这一天。

用法：
    python scripts/update_market_snapshots.py           # 更新今天
    python scripts/update_market_snapshots.py 2026-04-29  # 指定日期
"""
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).parent.parent

if len(sys.argv) > 1:
    target = sys.argv[1]
else:
    # 默认今天；若今天还没 15:00 收盘就用昨天
    from datetime import datetime
    now = datetime.now()
    if now.hour < 15:
        target = (now.date() - timedelta(days=1)).isoformat()
    else:
        target = now.date().isoformat()

print(f"🔄 更新 market_snapshots：{target}")

result = subprocess.run([
    sys.executable,
    str(ROOT / "scripts" / "seed_market_snapshots.py"),
    "--from", target, "--to", target,
])
sys.exit(result.returncode)
