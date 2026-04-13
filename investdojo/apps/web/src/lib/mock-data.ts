// ============================================================
// Mock 数据生成器
// 用于开发期间生成逼真的模拟 K 线和新闻数据
// ============================================================

import type { ScenarioData, KLine, NewsItem } from "@investdojo/core";

/**
 * 生成 Mock 场景数据
 * 生产环境将替换为真实 AKShare 数据
 */
export function generateMockScenario(scenarioId: string): ScenarioData {
  const configs: Record<string, {
    name: string;
    description: string;
    category: ScenarioData["meta"]["category"];
    start: string;
    end: string;
    symbols: { code: string; name: string; basePrice: number }[];
    initialCapital: number;
    difficulty: "easy" | "medium" | "hard";
  }> = {
    covid_2020: {
      name: "2020 新冠疫情",
      description: "2020年1月-6月，新冠疫情冲击全球市场",
      category: "black_swan",
      start: "2020-01-02",
      end: "2020-06-30",
      symbols: [
        { code: "000001", name: "平安银行", basePrice: 16.5 },
        { code: "600519", name: "贵州茅台", basePrice: 1130 },
        { code: "300750", name: "宁德时代", basePrice: 110 },
      ],
      initialCapital: 1000000,
      difficulty: "medium",
    },
    bull_2014: {
      name: "2014-2015 疯牛行情",
      description: "A股史诗级牛市，从2000到5178",
      category: "bull_market",
      start: "2014-07-01",
      end: "2015-09-30",
      symbols: [
        { code: "000001", name: "平安银行", basePrice: 9.5 },
        { code: "601318", name: "中国平安", basePrice: 38 },
        { code: "600036", name: "招商银行", basePrice: 11 },
      ],
      initialCapital: 500000,
      difficulty: "hard",
    },
    trade_war_2018: {
      name: "2018 中美贸易摩擦",
      description: "中美贸易战全面升级，A股持续调整",
      category: "policy_driven",
      start: "2018-03-01",
      end: "2018-12-31",
      symbols: [
        { code: "000001", name: "平安银行", basePrice: 13 },
        { code: "600519", name: "贵州茅台", basePrice: 720 },
        { code: "000858", name: "五粮液", basePrice: 75 },
      ],
      initialCapital: 500000,
      difficulty: "medium",
    },
    new_energy_2020: {
      name: "2020 新能源板块起飞",
      description: "宁德时代/比亚迪引领新能源大涨",
      category: "sector_rotation",
      start: "2020-07-01",
      end: "2021-12-31",
      symbols: [
        { code: "300750", name: "宁德时代", basePrice: 160 },
        { code: "002594", name: "比亚迪", basePrice: 75 },
        { code: "601012", name: "隆基绿能", basePrice: 35 },
      ],
      initialCapital: 500000,
      difficulty: "easy",
    },
  };

  const config = configs[scenarioId] ?? configs.covid_2020;

  // 生成交易日序列
  const tradingDates = generateTradingDates(config.start, config.end);

  // 为每只股票生成 K 线
  const klines: Record<string, KLine[]> = {};
  for (const sym of config.symbols) {
    klines[sym.code] = generateKlines(tradingDates, sym.basePrice, scenarioId);
  }

  // 生成新闻
  const news = generateNews(scenarioId, tradingDates);

  return {
    meta: {
      id: scenarioId,
      name: config.name,
      description: config.description,
      category: config.category,
      difficulty: config.difficulty,
      dateRange: { start: config.start, end: config.end },
      symbols: config.symbols.map((s) => s.code),
      initialCapital: config.initialCapital,
      tags: [],
    },
    klines,
    news,
    policies: news.filter((n) => n.category === "policy"),
  };
}

// ------ K 线生成 ------

function generateKlines(dates: string[], basePrice: number, scenario: string): KLine[] {
  const klines: KLine[] = [];
  let price = basePrice;
  const seed = hashStr(scenario);

  for (let i = 0; i < dates.length; i++) {
    const rng = seededRandom(seed + i);
    const preClose = price;

    // 场景特定趋势
    let trend = 0;
    if (scenario === "covid_2020") {
      // 1月平稳，2月大跌，3-6月缓慢恢复
      const month = parseInt(dates[i].slice(5, 7));
      if (month <= 1) trend = 0.001;
      else if (month === 2) trend = -0.008;
      else if (month === 3) trend = -0.003;
      else trend = 0.004;
    } else if (scenario === "bull_2014") {
      const month = parseInt(dates[i].slice(5, 7));
      const year = parseInt(dates[i].slice(0, 4));
      if (year === 2014) trend = 0.005;
      else if (year === 2015 && month <= 6) trend = 0.008;
      else trend = -0.012; // 暴跌
    } else if (scenario === "new_energy_2020") {
      trend = 0.004;
    } else {
      trend = -0.002;
    }

    // 日波动
    const dailyChange = trend + (rng() - 0.5) * 0.04;
    const clampedChange = Math.max(-0.1, Math.min(0.1, dailyChange));

    const close = Math.round(price * (1 + clampedChange) * 100) / 100;
    const high = Math.round(Math.max(price, close) * (1 + rng() * 0.015) * 100) / 100;
    const low = Math.round(Math.min(price, close) * (1 - rng() * 0.015) * 100) / 100;
    const open = Math.round((price + (close - price) * (rng() * 0.6)) * 100) / 100;
    const volume = Math.round((50000 + rng() * 200000) * (1 + Math.abs(clampedChange) * 10));
    const turnover = Math.round(volume * ((high + low) / 2) * 100);

    klines.push({
      date: dates[i],
      open,
      high,
      low,
      close,
      volume,
      turnover,
      preClose: Math.round(preClose * 100) / 100,
      change: Math.round((close - preClose) * 100) / 100,
      changePercent: Math.round(((close - preClose) / preClose) * 10000) / 100,
    });

    price = close;
  }

  return klines;
}

// ------ 新闻生成 ------

function generateNews(scenario: string, dates: string[]): NewsItem[] {
  const newsTemplates: Record<string, NewsItem[]> = {
    covid_2020: [
      { id: "n1", date: "2020-01-20", title: "武汉确认新型冠状病毒可人传人", content: "钟南山院士确认新冠病毒存在人传人现象", source: "新华社", category: "news", sentiment: "negative", impactLevel: 3 },
      { id: "n2", date: "2020-01-23", title: "武汉宣布封城", content: "武汉市新型冠状病毒感染的肺炎疫情防控指挥部通告", source: "武汉市政府", category: "policy", sentiment: "negative", impactLevel: 3 },
      { id: "n3", date: "2020-02-03", title: "A股春节后首日开盘 超3000股跌停", content: "受疫情影响，A股大幅低开，上证指数跌7.72%", source: "证券时报", category: "news", sentiment: "negative", impactLevel: 3 },
      { id: "n4", date: "2020-02-04", title: "央行投放1.2万亿流动性 逆回购利率下调", content: "中国人民银行开展逆回购操作，向市场投放大量流动性", source: "央行", category: "policy", sentiment: "positive", impactLevel: 3 },
      { id: "n5", date: "2020-03-01", title: "全国新增确诊病例降至500例以下", content: "疫情防控取得阶段性成果", source: "卫健委", category: "news", sentiment: "positive", impactLevel: 2 },
      { id: "n6", date: "2020-03-16", title: "美联储紧急降息至零利率", content: "美联储将联邦基金利率降至0-0.25%", source: "路透社", category: "policy", sentiment: "positive", impactLevel: 3 },
      { id: "n7", date: "2020-04-01", title: "全国规模以上工业企业复工率达98.6%", content: "中国经济活动快速恢复", source: "工信部", category: "news", sentiment: "positive", impactLevel: 2 },
      { id: "n8", date: "2020-05-22", title: "政府工作报告未设GDP增速目标", content: "\"六稳\"\"六保\"成为工作重点", source: "新华社", category: "policy", sentiment: "neutral", impactLevel: 2 },
    ],
    bull_2014: [
      { id: "n1", date: "2014-07-22", title: "沪港通获批 将于10月开通", content: "沪港通试点正式获批，标志资本市场对外开放迈出重要一步", source: "证监会", category: "policy", sentiment: "positive", impactLevel: 3 },
      { id: "n2", date: "2014-11-21", title: "央行意外降息 A股暴涨", content: "央行宣布降息0.4个百分点，一年期贷款基准利率降至5.6%", source: "央行", category: "policy", sentiment: "positive", impactLevel: 3 },
      { id: "n3", date: "2015-03-05", title: "总理强调\"大众创业万众创新\"", content: "互联网+成为国家战略", source: "新华社", category: "policy", sentiment: "positive", impactLevel: 2 },
      { id: "n4", date: "2015-06-15", title: "证监会严查场外配资", content: "证监会要求证券公司清理场外配资接口", source: "证监会", category: "policy", sentiment: "negative", impactLevel: 3 },
      { id: "n5", date: "2015-06-26", title: "A股暴跌 千股跌停再现", content: "上证指数单日下跌7.4%，市场恐慌情绪蔓延", source: "证券时报", category: "news", sentiment: "negative", impactLevel: 3 },
      { id: "n6", date: "2015-07-04", title: "国家队入场救市", content: "证金公司获批2000亿信贷额度，公募基金承诺不减持", source: "证监会", category: "policy", sentiment: "positive", impactLevel: 3 },
    ],
    trade_war_2018: [
      { id: "n1", date: "2018-03-22", title: "美国对中国商品加征关税", content: "特朗普签署备忘录对600亿美元中国商品加征关税", source: "路透社", category: "policy", sentiment: "negative", impactLevel: 3 },
      { id: "n2", date: "2018-04-04", title: "中国宣布对美反制措施", content: "中国对原产于美国的128项进口商品加征关税", source: "商务部", category: "policy", sentiment: "negative", impactLevel: 3 },
      { id: "n3", date: "2018-07-06", title: "美对华340亿美元商品加征25%关税正式生效", content: "中美贸易战正式打响", source: "新华社", category: "policy", sentiment: "negative", impactLevel: 3 },
      { id: "n4", date: "2018-10-07", title: "央行再次降准1个百分点", content: "释放增量资金约7500亿元，支持实体经济", source: "央行", category: "policy", sentiment: "positive", impactLevel: 2 },
    ],
    new_energy_2020: [
      { id: "n1", date: "2020-07-17", title: "宁德时代发布CTP技术", content: "电池包体积利用率提升15-20%，降低制造成本", source: "宁德时代", category: "announcement", sentiment: "positive", impactLevel: 2 },
      { id: "n2", date: "2020-10-09", title: "国务院发布新能源汽车发展规划", content: "到2025年新能源汽车销量占比达20%", source: "国务院", category: "policy", sentiment: "positive", impactLevel: 3 },
      { id: "n3", date: "2021-03-15", title: "碳达峰碳中和成全国两会热词", content: "\"30·60\"目标推动新能源产业发展", source: "新华社", category: "policy", sentiment: "positive", impactLevel: 3 },
      { id: "n4", date: "2021-06-10", title: "比亚迪5月新能源车销量突破3万辆", content: "同比增长超190%，市场份额持续扩大", source: "比亚迪", category: "announcement", sentiment: "positive", impactLevel: 2 },
    ],
  };

  const templates = newsTemplates[scenario] ?? newsTemplates.covid_2020;
  // 只保留在交易日期范围内的新闻
  return templates.filter((n) => dates.includes(n.date) || dates.some((d) => d >= n.date));
}

// ------ 交易日生成 ------

function generateTradingDates(start: string, end: string): string[] {
  const dates: string[] = [];
  const current = new Date(start);
  const endDate = new Date(end);

  while (current <= endDate) {
    const dayOfWeek = current.getDay();
    // 跳过周末
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      dates.push(current.toISOString().slice(0, 10));
    }
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

// ------ 伪随机 ------

function hashStr(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}
