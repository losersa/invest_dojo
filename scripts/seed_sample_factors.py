#!/usr/bin/env python3
"""播种示范因子（T-2.01 MVP 展示用）

放 5 个代表性因子：
- 趋势类：MA 金叉 / MACD 金叉
- 反转类：RSI 超卖
- 估值类：PE 百分位
- 量价类：放量上涨

Epic 3（T-3.04）会播 120+ 完整因子。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "python-services"))

from common.supabase_client import get_supabase_client


FACTORS = [
    {
        "id": "ma_cross_5_20",
        "name": "5日均线金叉20日均线",
        "name_en": "MA5 cross up MA20",
        "description": "短期均线（5日）向上穿越中期均线（20日），经典短线趋势启动信号",
        "long_description": (
            "# 因子说明\n\n"
            "当 5 日均线从下方向上穿越 20 日均线时触发，输出 `true`。\n\n"
            "## 适用场景\n- 短线交易（持有 5-10 天）\n- 趋势启动确认\n\n"
            "## 注意事项\n- 震荡市容易出现假信号\n- 建议配合成交量放大确认"
        ),
        "category": "technical",
        "tags": ["趋势", "短线", "经典"],
        "formula": "MA(close,5) cross_up MA(close,20)",
        "formula_type": "dsl",
        "output_type": "boolean",
        "lookback_days": 30,
        "update_frequency": "daily",
        "version": 1,
        "owner": "platform",
        "visibility": "public",
    },
    {
        "id": "ma_cross_20_60",
        "name": "20日均线金叉60日均线",
        "name_en": "MA20 cross up MA60",
        "description": "中期均线向上穿越长期均线，中线趋势启动信号",
        "long_description": (
            "# 因子说明\n\n20 日中期均线上穿 60 日长期均线时触发。\n\n"
            "## 适用场景\n- 中线趋势确认（持有 20-60 天）\n- 波段操作入场"
        ),
        "category": "technical",
        "tags": ["趋势", "中线", "经典"],
        "formula": "MA(close,20) cross_up MA(close,60)",
        "formula_type": "dsl",
        "output_type": "boolean",
        "lookback_days": 80,
        "update_frequency": "daily",
        "version": 1,
        "owner": "platform",
        "visibility": "public",
    },
    {
        "id": "macd_golden_cross",
        "name": "MACD 金叉",
        "name_en": "MACD golden cross",
        "description": "DIF 线向上穿越 DEA 线，经典动量启动信号",
        "long_description": (
            "# 因子说明\n\nMACD(12,26,9) 中 DIF 上穿 DEA 时触发。\n\n"
            "## 经典变体\n- 零轴上方金叉：更强趋势信号\n- 零轴下方金叉：反弹信号，较弱"
        ),
        "category": "technical",
        "tags": ["动量", "经典", "短线"],
        "formula": "MACD_DIF cross_up MACD_DEA",
        "formula_type": "dsl",
        "output_type": "boolean",
        "lookback_days": 40,
        "update_frequency": "daily",
        "version": 1,
        "owner": "platform",
        "visibility": "public",
    },
    {
        "id": "rsi_oversold",
        "name": "RSI 超卖反弹",
        "name_en": "RSI oversold bounce",
        "description": "RSI(14) 从 30 以下向上突破 30，超卖反弹信号",
        "long_description": (
            "# 因子说明\n\n14 日 RSI 从低于 30 的超卖区间向上突破 30 时触发。\n\n"
            "## 风险提示\n- 下跌趋势中容易钝化，建议配合支撑位使用"
        ),
        "category": "technical",
        "tags": ["反转", "超卖", "短线"],
        "formula": "RSI(14) cross_up 30",
        "formula_type": "dsl",
        "output_type": "boolean",
        "output_range": [0, 100],
        "lookback_days": 20,
        "update_frequency": "daily",
        "version": 1,
        "owner": "platform",
        "visibility": "public",
    },
    {
        "id": "volume_breakout_3x",
        "name": "成交量放大 3 倍",
        "name_en": "Volume 3x breakout",
        "description": "当日成交量超过 20 日均量 3 倍，且价格收阳",
        "long_description": (
            "# 因子说明\n\n`volume > MA(volume, 20) * 3 AND close > open`\n\n"
            "## 典型场景\n- 主力资金介入\n- 突破平台初期"
        ),
        "category": "technical",
        "tags": ["量能", "突破", "短线"],
        "formula": "volume > MA(volume,20) * 3 AND close > open",
        "formula_type": "dsl",
        "output_type": "boolean",
        "lookback_days": 25,
        "update_frequency": "daily",
        "version": 1,
        "owner": "platform",
        "visibility": "public",
    },
]


def main():
    client = get_supabase_client()

    # 清空示例因子（仅针对这几个 id，不影响其他数据）
    ids = [f["id"] for f in FACTORS]
    print(f"🧹 清理已有示例因子: {ids}")
    for fid in ids:
        try:
            client.delete("factor_definitions", filters={"id": f"eq.{fid}"})
        except Exception as e:
            print(f"  删 {fid} 失败（可能不存在）: {e}")

    # 插入
    print(f"📥 插入 {len(FACTORS)} 个示范因子...")
    try:
        inserted = client.insert("factor_definitions", FACTORS)
    except Exception as e:
        # 详细错误
        import httpx
        if isinstance(e, httpx.HTTPStatusError):
            print(f"  ❌ HTTP {e.response.status_code}")
            print(f"     body: {e.response.text[:500]}")
        # 退化为逐条插入定位问题
        print(f"  ⚠ 批量失败，改为逐条插入...")
        inserted = []
        for f in FACTORS:
            try:
                r = client.insert("factor_definitions", [f])
                inserted.extend(r)
                print(f"  ✅ {f['id']}")
            except httpx.HTTPStatusError as ee:
                print(f"  ❌ {f['id']} → {ee.response.status_code}: {ee.response.text[:200]}")
    print(f"  ✅ 成功插入 {len(inserted)} 条")
    for r in inserted:
        print(f"     - {r['id']:25}  {r['name']}")


if __name__ == "__main__":
    main()
