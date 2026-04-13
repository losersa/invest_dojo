// ============================================================
// @investdojo/core — 场景管理器
// 负责加载场景数据、按日期过滤K线和新闻
// ============================================================

import type {
  ScenarioData,
  ScenarioMeta,
  KLine,
  NewsItem,
  Portfolio,
  SimulationProgress,
} from "./types";

export class ScenarioManager {
  private scenarioData: ScenarioData | null = null;
  private tradingDates: string[] = [];

  /**
   * 加载场景数据包
   */
  async loadScenario(scenarioId: string): Promise<ScenarioData> {
    // 在实际项目中，从 CDN / 本地缓存 / API 加载
    // 这里定义接口，具体数据加载在 apps/web 中实现
    const response = await fetch(`/api/scenarios/${scenarioId}`);
    if (!response.ok) {
      throw new Error(`Failed to load scenario: ${scenarioId}`);
    }
    const data: ScenarioData = await response.json();
    this.scenarioData = data;
    this.tradingDates = this.extractTradingDates(data);
    return data;
  }

  /**
   * 从已有数据初始化（用于从 mock 数据或预打包数据加载）
   */
  initFromData(data: ScenarioData): void {
    this.scenarioData = data;
    this.tradingDates = this.extractTradingDates(data);
  }

  /**
   * 获取截止某日期的 K 线数据
   */
  getKlinesUntil(symbol: string, date: string): KLine[] {
    if (!this.scenarioData) return [];
    const klines = this.scenarioData.klines[symbol] ?? [];
    return klines.filter((k) => k.date <= date);
  }

  /**
   * 获取某一天的 K 线
   */
  getKlineOnDate(symbol: string, date: string): KLine | undefined {
    if (!this.scenarioData) return undefined;
    const klines = this.scenarioData.klines[symbol] ?? [];
    return klines.find((k) => k.date === date);
  }

  /**
   * 获取所有股票在某一天的 K 线
   */
  getAllKlinesOnDate(date: string): Record<string, KLine> {
    if (!this.scenarioData) return {};
    const result: Record<string, KLine> = {};
    for (const [symbol, klines] of Object.entries(this.scenarioData.klines)) {
      const kline = klines.find((k) => k.date === date);
      if (kline) result[symbol] = kline;
    }
    return result;
  }

  /**
   * 获取截止某日期的新闻
   */
  getNewsUntil(date: string): NewsItem[] {
    if (!this.scenarioData) return [];
    return this.scenarioData.news.filter((n) => n.date <= date);
  }

  /**
   * 获取某天的新闻
   */
  getNewsOnDate(date: string): NewsItem[] {
    if (!this.scenarioData) return [];
    return this.scenarioData.news.filter((n) => n.date === date);
  }

  /**
   * 获取截止某日期的政策事件
   */
  getPoliciesUntil(date: string): NewsItem[] {
    if (!this.scenarioData) return [];
    return this.scenarioData.policies.filter((p) => p.date <= date);
  }

  /**
   * 获取场景元信息
   */
  getMeta(): ScenarioMeta | null {
    return this.scenarioData?.meta ?? null;
  }

  /**
   * 获取所有交易日列表
   */
  getTradingDates(): string[] {
    return this.tradingDates;
  }

  /**
   * 获取下一个交易日
   */
  getNextTradingDate(currentDate: string): string | null {
    const idx = this.tradingDates.indexOf(currentDate);
    if (idx < 0 || idx >= this.tradingDates.length - 1) return null;
    return this.tradingDates[idx + 1];
  }

  /**
   * 获取上一个交易日
   */
  getPrevTradingDate(currentDate: string): string | null {
    const idx = this.tradingDates.indexOf(currentDate);
    if (idx <= 0) return null;
    return this.tradingDates[idx - 1];
  }

  /**
   * 当前是否是场景的最后一天
   */
  isLastDay(currentDate: string): boolean {
    return currentDate === this.tradingDates.at(-1);
  }

  /**
   * 获取当前天数索引 (0-based)
   */
  getDayIndex(currentDate: string): number {
    return this.tradingDates.indexOf(currentDate);
  }

  /**
   * 获取总交易天数
   */
  getTotalDays(): number {
    return this.tradingDates.length;
  }

  /**
   * 创建初始模拟进度
   */
  createInitialProgress(scenarioId: string, initialCapital: number): SimulationProgress {
    const firstDate = this.tradingDates[0] ?? "";
    return {
      scenarioId,
      currentDate: firstDate,
      status: "in_progress",
      portfolio: this.createInitialPortfolio(initialCapital),
      tradeHistory: [],
      dayIndex: 0,
      totalDays: this.tradingDates.length,
    };
  }

  /**
   * 创建初始投资组合
   */
  createInitialPortfolio(initialCapital: number): Portfolio {
    return {
      cash: initialCapital,
      frozenCash: 0,
      totalAssets: initialCapital,
      totalMarketValue: 0,
      totalProfitLoss: 0,
      totalProfitLossPercent: 0,
      positions: [],
      initialCapital,
    };
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 从场景数据中提取所有交易日（去重排序）
   */
  private extractTradingDates(data: ScenarioData): string[] {
    const dateSet = new Set<string>();
    for (const klines of Object.values(data.klines)) {
      for (const kline of klines) {
        dateSet.add(kline.date);
      }
    }
    return Array.from(dateSet).sort();
  }
}
