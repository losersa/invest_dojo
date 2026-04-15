#!/usr/bin/env python3
"""
InvestDojo 数据采集脚本
从 AKShare 拉取真实 A 股 K 线数据和新闻数据，写入 Supabase
"""

import json
import time
import requests
import akshare as ak
import pandas as pd
from datetime import datetime, timedelta

# ============================================================
# Supabase 配置
# ============================================================
SUPABASE_URL = "https://adqznqsciqtepzimcvsg.supabase.co"
SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkcXpucXNjaXF0ZXB6aW1jdnNnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTk3NDQ2MSwiZXhwIjoyMDkxNTUwNDYxfQ.t5piNqJLo_tj-hQ_V7aalmOp2g7KuVnRqgPQgejbMAw"

HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}

# ============================================================
# 四大场景定义
# ============================================================
SCENARIOS = [
    {
        "id": "covid_2020",
        "name": "2020 新冠疫情",
        "description": "2020年1月-6月，新冠疫情冲击全球市场。你能在恐慌中找到机会吗？",
        "category": "black_swan",
        "difficulty": "medium",
        "date_start": "2020-01-02",
        "date_end": "2020-06-30",
        "symbols": ["000001", "600519", "300750"],
        "initial_capital": 1000000,
        "tags": ["黑天鹅", "疫情", "恐慌"],
    },
    {
        "id": "bull_2014",
        "name": "2014-2015 疯牛行情",
        "description": "A股史诗级牛市，从2000到5178。你会在5178点全身而退吗？",
        "category": "bull_market",
        "difficulty": "hard",
        "date_start": "2014-07-01",
        "date_end": "2015-09-30",
        "symbols": ["000001", "601318", "600036"],
        "initial_capital": 500000,
        "tags": ["牛市", "泡沫", "杠杆"],
    },
    {
        "id": "trade_war_2018",
        "name": "2018 中美贸易摩擦",
        "description": "中美贸易战全面升级，A股持续调整。",
        "category": "policy_driven",
        "difficulty": "medium",
        "date_start": "2018-03-01",
        "date_end": "2018-12-31",
        "symbols": ["000001", "600519", "000858"],
        "initial_capital": 500000,
        "tags": ["贸易战", "政策", "防守"],
    },
    {
        "id": "new_energy_2020",
        "name": "2020 新能源板块起飞",
        "description": "宁德时代/比亚迪引领新能源板块大涨。",
        "category": "sector_rotation",
        "difficulty": "easy",
        "date_start": "2020-07-01",
        "date_end": "2021-12-31",
        "symbols": ["300750", "002594", "601012"],
        "initial_capital": 500000,
        "tags": ["新能源", "赛道", "趋势"],
    },
]

# 股票代码 → 名称映射
SYMBOL_NAMES = {
    "000001": "平安银行",
    "600519": "贵州茅台",
    "300750": "宁德时代",
    "601318": "中国平安",
    "600036": "招商银行",
    "000858": "五粮液",
    "002594": "比亚迪",
    "601012": "隆基绿能",
}

# ============================================================
# 新闻数据（精选重大事件）
# ============================================================
NEWS_DATA = {
    "covid_2020": [
        {"date": "2020-01-20", "title": "武汉确认新型冠状病毒可人传人", "content": "钟南山院士确认新冠病毒存在人传人现象，引发市场担忧", "source": "新华社", "category": "news", "sentiment": "negative", "impact_level": 3},
        {"date": "2020-01-23", "title": "武汉宣布封城", "content": "武汉市新型冠状病毒感染的肺炎疫情防控指挥部通告，自1月23日10时起全市城市公交、地铁暂停运营", "source": "武汉市政府", "category": "policy", "sentiment": "negative", "impact_level": 3},
        {"date": "2020-02-03", "title": "A股春节后首日开盘 超3000股跌停", "content": "受疫情影响，A股大幅低开，上证指数跌7.72%，创业板跌6.85%", "source": "证券时报", "category": "news", "sentiment": "negative", "impact_level": 3},
        {"date": "2020-02-04", "title": "央行投放1.2万亿流动性 逆回购利率下调", "content": "中国人民银行开展1.2万亿元逆回购操作，向市场投放大量流动性以稳定金融市场", "source": "中国人民银行", "category": "policy", "sentiment": "positive", "impact_level": 3},
        {"date": "2020-02-14", "title": "再融资新规落地 定增市场迎利好", "content": "证监会发布再融资新规，放宽定增限制，被视为重大资本市场改革", "source": "证监会", "category": "policy", "sentiment": "positive", "impact_level": 2},
        {"date": "2020-03-01", "title": "全国新增确诊降至500例以下", "content": "全国疫情防控取得阶段性成果，湖北以外地区新增确诊持续下降", "source": "国家卫健委", "category": "news", "sentiment": "positive", "impact_level": 2},
        {"date": "2020-03-09", "title": "全球石油价格战爆发 美股熔断", "content": "沙特与俄罗斯原油减产谈判破裂，全球油价暴跌30%，美股触发历史第二次熔断", "source": "路透社", "category": "news", "sentiment": "negative", "impact_level": 3},
        {"date": "2020-03-16", "title": "美联储紧急降息至零利率", "content": "美联储将联邦基金利率降至0-0.25%，并启动7000亿美元量化宽松", "source": "美联储", "category": "policy", "sentiment": "positive", "impact_level": 3},
        {"date": "2020-04-01", "title": "全国规模以上工业企业复工率达98.6%", "content": "中国经济活动快速恢复，工业企业复工率接近正常水平", "source": "工信部", "category": "news", "sentiment": "positive", "impact_level": 2},
        {"date": "2020-04-17", "title": "一季度GDP同比下降6.8%", "content": "国家统计局公布一季度GDP数据，创改革开放以来最低增速", "source": "国家统计局", "category": "news", "sentiment": "negative", "impact_level": 2},
        {"date": "2020-05-22", "title": "政府工作报告未设GDP增速目标", "content": "全国两会召开，政府工作报告首次未设GDP增速目标，\"六稳\"\"六保\"成工作重点", "source": "新华社", "category": "policy", "sentiment": "neutral", "impact_level": 2},
        {"date": "2020-06-01", "title": "海南自由贸易港建设总体方案公布", "content": "中共中央、国务院印发《海南自由贸易港建设总体方案》", "source": "新华社", "category": "policy", "sentiment": "positive", "impact_level": 2},
        {"date": "2020-06-19", "title": "创业板注册制首批企业获受理", "content": "创业板改革并试点注册制正式启动，资本市场改革深化", "source": "深交所", "category": "policy", "sentiment": "positive", "impact_level": 2},
    ],
    "bull_2014": [
        {"date": "2014-07-22", "title": "沪港通获批 将于10月开通", "content": "沪港通试点正式获批，标志资本市场对外开放迈出重要一步", "source": "证监会", "category": "policy", "sentiment": "positive", "impact_level": 3},
        {"date": "2014-09-19", "title": "阿里巴巴在纽交所上市", "content": "阿里巴巴集团在纽约证交所挂牌，创下全球最大IPO纪录", "source": "路透社", "category": "news", "sentiment": "positive", "impact_level": 2},
        {"date": "2014-11-17", "title": "沪港通正式开通", "content": "沪港股票市场交易互联互通机制正式启动运行", "source": "上交所", "category": "policy", "sentiment": "positive", "impact_level": 3},
        {"date": "2014-11-21", "title": "央行意外降息 A股暴涨", "content": "央行宣布降息0.4个百分点，一年期贷款基准利率降至5.6%，市场反应强烈", "source": "中国人民银行", "category": "policy", "sentiment": "positive", "impact_level": 3},
        {"date": "2015-01-19", "title": "两融账户首次突破1000万", "content": "融资融券账户数首次突破1000万，杠杆资金大规模入场", "source": "中国结算", "category": "news", "sentiment": "positive", "impact_level": 2},
        {"date": "2015-03-01", "title": "央行再次降息", "content": "央行宣布降息0.25个百分点，一年期存款利率降至2.5%", "source": "中国人民银行", "category": "policy", "sentiment": "positive", "impact_level": 3},
        {"date": "2015-03-05", "title": "总理强调\"大众创业万众创新\"", "content": "互联网+成为国家战略，政府工作报告多次提及创新驱动", "source": "新华社", "category": "policy", "sentiment": "positive", "impact_level": 2},
        {"date": "2015-04-13", "title": "A股单日成交额突破2万亿", "content": "沪深两市单日成交额突破2万亿元大关，创全球历史纪录", "source": "证券时报", "category": "news", "sentiment": "positive", "impact_level": 2},
        {"date": "2015-06-12", "title": "上证指数触及5178点", "content": "上证指数盘中触及5178.19点，为2008年以来最高点", "source": "上交所", "category": "news", "sentiment": "positive", "impact_level": 3},
        {"date": "2015-06-13", "title": "证监会严查场外配资", "content": "证监会要求证券公司自查自纠场外配资接口，市场情绪骤变", "source": "证监会", "category": "policy", "sentiment": "negative", "impact_level": 3},
        {"date": "2015-06-26", "title": "A股暴跌 千股跌停再现", "content": "上证指数单日下跌7.40%，超千只股票跌停，恐慌情绪蔓延", "source": "证券时报", "category": "news", "sentiment": "negative", "impact_level": 3},
        {"date": "2015-07-04", "title": "国家队入场救市", "content": "证金公司获批2000亿信贷额度，21家券商联合出资1200亿维稳，公募基金承诺不减持", "source": "证监会", "category": "policy", "sentiment": "positive", "impact_level": 3},
        {"date": "2015-07-09", "title": "公安部排查恶意做空", "content": "公安部副部长孟庆丰带队到证监会排查恶意卖空行为", "source": "公安部", "category": "policy", "sentiment": "positive", "impact_level": 2},
        {"date": "2015-08-25", "title": "央行双降 五次降息", "content": "央行宣布降息0.25个百分点并降准0.5个百分点，年内第五次降息", "source": "中国人民银行", "category": "policy", "sentiment": "positive", "impact_level": 3},
    ],
    "trade_war_2018": [
        {"date": "2018-03-22", "title": "美国宣布对中国商品加征关税", "content": "特朗普签署备忘录，宣布将对约600亿美元中国商品加征关税", "source": "路透社", "category": "policy", "sentiment": "negative", "impact_level": 3},
        {"date": "2018-04-04", "title": "中国宣布对美反制措施", "content": "中国对原产于美国的128项进口商品加征15%-25%关税", "source": "商务部", "category": "policy", "sentiment": "negative", "impact_level": 3},
        {"date": "2018-04-17", "title": "美国制裁中兴通讯", "content": "美国商务部宣布禁止美国企业向中兴通讯销售零部件，为期七年", "source": "路透社", "category": "policy", "sentiment": "negative", "impact_level": 3},
        {"date": "2018-06-15", "title": "美对华340亿美元商品加征25%关税", "content": "美国正式公布对中国500亿美元商品加征关税的最终清单", "source": "美国贸易代表办公室", "category": "policy", "sentiment": "negative", "impact_level": 3},
        {"date": "2018-07-06", "title": "中美贸易战正式打响", "content": "美国对340亿美元中国商品加征25%关税正式生效，中国同步反制", "source": "新华社", "category": "policy", "sentiment": "negative", "impact_level": 3},
        {"date": "2018-07-23", "title": "国务院常务会议部署积极财政政策", "content": "国务院常务会议确定更好发挥财政金融政策作用，支持扩内需调结构", "source": "国务院", "category": "policy", "sentiment": "positive", "impact_level": 2},
        {"date": "2018-10-07", "title": "央行再次降准1个百分点", "content": "央行年内第四次降准，释放增量资金约7500亿元", "source": "中国人民银行", "category": "policy", "sentiment": "positive", "impact_level": 2},
        {"date": "2018-10-19", "title": "刘鹤喊话 国务院金融委释放重磅信号", "content": "刘鹤副总理就经济金融热点问题接受采访，强调\"春天已经不远了\"", "source": "新华社", "category": "policy", "sentiment": "positive", "impact_level": 3},
        {"date": "2018-11-01", "title": "民营企业座谈会召开", "content": "最高层召开民营企业座谈会，强调坚持两个\"毫不动摇\"", "source": "新华社", "category": "policy", "sentiment": "positive", "impact_level": 3},
        {"date": "2018-12-01", "title": "G20中美元首会晤 贸易战暂时休战", "content": "中美两国元首在阿根廷G20峰会期间举行会晤，同意暂停加征新关税", "source": "新华社", "category": "policy", "sentiment": "positive", "impact_level": 3},
    ],
    "new_energy_2020": [
        {"date": "2020-07-17", "title": "宁德时代发布CTP技术", "content": "宁德时代发布第一代CTP电池包技术，体积利用率提升15-20%", "source": "宁德时代", "category": "announcement", "sentiment": "positive", "impact_level": 2},
        {"date": "2020-09-22", "title": "中国宣布2060年碳中和目标", "content": "最高领导人在联合国大会上宣布中国将在2060年前实现碳中和", "source": "新华社", "category": "policy", "sentiment": "positive", "impact_level": 3},
        {"date": "2020-10-09", "title": "国务院发布新能源汽车发展规划", "content": "国务院印发《新能源汽车产业发展规划(2021-2035年)》，到2025年新能源汽车销量占比达20%", "source": "国务院", "category": "policy", "sentiment": "positive", "impact_level": 3},
        {"date": "2020-11-02", "title": "蔚来汽车月交付量首破5000辆", "content": "蔚来汽车10月交付5055辆，连续第三个月创纪录", "source": "蔚来汽车", "category": "announcement", "sentiment": "positive", "impact_level": 2},
        {"date": "2021-01-11", "title": "百度宣布组建智能电动汽车公司", "content": "百度宣布以整车制造商身份进军汽车行业，新能源车竞争加剧", "source": "百度", "category": "announcement", "sentiment": "positive", "impact_level": 2},
        {"date": "2021-03-15", "title": "碳达峰碳中和成全国两会热词", "content": "\"30·60\"双碳目标首次写入政府工作报告，推动新能源产业发展", "source": "新华社", "category": "policy", "sentiment": "positive", "impact_level": 3},
        {"date": "2021-05-21", "title": "碳达峰碳中和领导小组成立", "content": "碳达峰碳中和工作领导小组成立，韩正任组长", "source": "新华社", "category": "policy", "sentiment": "positive", "impact_level": 2},
        {"date": "2021-06-10", "title": "比亚迪5月新能源车销量突破3万辆", "content": "比亚迪5月新能源汽车销量31681辆，同比增长超190%", "source": "比亚迪", "category": "announcement", "sentiment": "positive", "impact_level": 2},
        {"date": "2021-07-30", "title": "宁德时代发布钠离子电池", "content": "宁德时代发布第一代钠离子电池及锂钠混搭电池包", "source": "宁德时代", "category": "announcement", "sentiment": "positive", "impact_level": 3},
        {"date": "2021-08-20", "title": "隆基绿能半年报净利润增长21.3%", "content": "隆基绿能2021年上半年营收350.98亿元，同比增长74.26%", "source": "隆基绿能", "category": "announcement", "sentiment": "positive", "impact_level": 2},
        {"date": "2021-10-26", "title": "国务院印发碳达峰行动方案", "content": "国务院印发《2030年前碳达峰行动方案》，新能源产业政策支持加码", "source": "国务院", "category": "policy", "sentiment": "positive", "impact_level": 3},
        {"date": "2021-11-15", "title": "北交所正式开市", "content": "北京证券交易所正式揭牌开市，服务创新型中小企业", "source": "北交所", "category": "policy", "sentiment": "positive", "impact_level": 2},
    ],
}


def supabase_insert(table: str, rows: list[dict]) -> bool:
    """批量插入数据到 Supabase"""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    headers = {**HEADERS, "Prefer": "return=minimal,resolution=merge-duplicates"}
    
    # 分批插入（每批 500 条）
    batch_size = 500
    total = len(rows)
    for i in range(0, total, batch_size):
        batch = rows[i : i + batch_size]
        resp = requests.post(url, headers=headers, json=batch)
        if resp.status_code not in (200, 201):
            print(f"  ❌ 插入 {table} 失败 (batch {i}-{i+len(batch)}): {resp.status_code} {resp.text[:200]}")
            return False
        print(f"  ✅ {table}: 已插入 {min(i + batch_size, total)}/{total} 条")
    return True


def fetch_klines(symbol: str, start_date: str, end_date: str) -> pd.DataFrame:
    """从 AKShare 获取真实 A 股日K线数据"""
    print(f"  📊 拉取 {symbol} ({SYMBOL_NAMES.get(symbol, '?')}) K线: {start_date} ~ {end_date}")
    
    try:
        # AKShare 的 stock_zh_a_hist 接口
        df = ak.stock_zh_a_hist(
            symbol=symbol,
            period="daily",
            start_date=start_date.replace("-", ""),
            end_date=end_date.replace("-", ""),
            adjust="qfq",  # 前复权
        )
        
        if df.empty:
            print(f"  ⚠️ {symbol} 无数据")
            return pd.DataFrame()
        
        # 重命名列
        df = df.rename(columns={
            "日期": "date",
            "开盘": "open",
            "收盘": "close",
            "最高": "high",
            "最低": "low",
            "成交量": "volume",
            "成交额": "turnover",
            "涨跌幅": "change_percent",
            "涨跌额": "change_amount",
        })
        
        # 确保日期格式
        df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
        
        # 计算前收盘价
        df["pre_close"] = df["close"].shift(1)
        df.loc[df.index[0], "pre_close"] = df.iloc[0]["open"]  # 首日用开盘价
        
        print(f"  ✅ {symbol}: 获取 {len(df)} 条K线")
        return df
        
    except Exception as e:
        print(f"  ❌ {symbol} 拉取失败: {e}")
        return pd.DataFrame()


def main():
    print("=" * 60)
    print("InvestDojo 数据采集 — 真实 A 股数据入库")
    print("=" * 60)
    
    # ====== Step 1: 插入场景元信息 ======
    print("\n📋 Step 1: 插入场景元信息")
    scenario_rows = []
    for s in SCENARIOS:
        scenario_rows.append({
            "id": s["id"],
            "name": s["name"],
            "description": s["description"],
            "category": s["category"],
            "difficulty": s["difficulty"],
            "date_start": s["date_start"],
            "date_end": s["date_end"],
            "symbols": s["symbols"],
            "initial_capital": s["initial_capital"],
            "tags": s["tags"],
        })
    supabase_insert("scenarios", scenario_rows)
    
    # ====== Step 2: 拉取 K 线数据 ======
    print("\n📊 Step 2: 拉取 K 线数据（AKShare）")
    
    all_symbols = set()
    for s in SCENARIOS:
        for sym in s["symbols"]:
            all_symbols.add((sym, s["id"], s["date_start"], s["date_end"]))
    
    total_klines = 0
    for symbol, scenario_id, start, end in sorted(all_symbols):
        df = fetch_klines(symbol, start, end)
        if df.empty:
            continue
        
        # 转换为插入格式
        kline_rows = []
        for _, row in df.iterrows():
            kline_rows.append({
                "scenario_id": scenario_id,
                "symbol": symbol,
                "date": row["date"],
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": int(row["volume"]),
                "turnover": float(row["turnover"]) if pd.notna(row.get("turnover")) else 0,
                "pre_close": float(row["pre_close"]) if pd.notna(row["pre_close"]) else None,
                "change_amount": float(row["change_amount"]) if pd.notna(row.get("change_amount")) else None,
                "change_percent": float(row["change_percent"]) if pd.notna(row.get("change_percent")) else None,
            })
        
        supabase_insert("klines", kline_rows)
        total_klines += len(kline_rows)
        time.sleep(1)  # AKShare 频率限制
    
    print(f"\n  📊 K线总计: {total_klines} 条")
    
    # ====== Step 3: 插入新闻数据 ======
    print("\n📰 Step 3: 插入新闻数据")
    
    total_news = 0
    for scenario_id, news_list in NEWS_DATA.items():
        news_rows = []
        for i, n in enumerate(news_list):
            news_rows.append({
                "id": f"{scenario_id}_n{i+1}",
                "scenario_id": scenario_id,
                "date": n["date"],
                "title": n["title"],
                "content": n["content"],
                "source": n["source"],
                "category": n["category"],
                "sentiment": n["sentiment"],
                "impact_level": n["impact_level"],
            })
        supabase_insert("news", news_rows)
        total_news += len(news_rows)
    
    print(f"\n  📰 新闻总计: {total_news} 条")
    
    # ====== 汇总 ======
    print("\n" + "=" * 60)
    print("✅ 数据采集完成!")
    print(f"   场景: {len(SCENARIOS)} 个")
    print(f"   K线: {total_klines} 条")
    print(f"   新闻: {total_news} 条")
    print("=" * 60)


if __name__ == "__main__":
    main()
