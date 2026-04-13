// ============================================================
// @investdojo/core — 模拟状态管理 (Zustand Store)
// 可在各端复用的核心状态逻辑
// ============================================================

import type {
  ScenarioData,
  ScenarioMeta,
  SimulationProgress,
  Portfolio,
  Order,
  KLine,
  NewsItem,
  PerformanceMetrics,
} from "./types";
import { SimulationEngine } from "./engine";
import { ScenarioManager } from "./scenario";

// ------ Store 状态类型 ------

export interface SimulationState {
  // 场景
  scenarioData: ScenarioData | null;
  scenarioMeta: ScenarioMeta | null;

  // 模拟进度
  progress: SimulationProgress | null;
  currentDate: string;
  isLastDay: boolean;

  // 当前可见数据
  visibleKlines: Record<string, KLine[]>; // symbol → 截止当前日期的 K 线
  visibleNews: NewsItem[];
  todayNews: NewsItem[];
  todayKlines: Record<string, KLine>;     // symbol → 当日 K 线

  // 交易
  tradeHistory: Order[];
  dailyPortfolioValues: { date: string; totalAssets: number }[];

  // AI 复盘
  aiReviewLoading: boolean;
  aiReview: string | null;

  // 绩效
  metrics: PerformanceMetrics | null;

  // 操作状态
  isLoading: boolean;
  error: string | null;
}

// ------ Store Actions 类型 ------

export interface SimulationActions {
  /** 加载场景数据并初始化 */
  loadScenario: (data: ScenarioData) => void;

  /** 推进到下一天 */
  advanceDay: () => void;

  /** 执行买入 */
  buy: (symbol: string, symbolName: string, quantity: number) => Order;

  /** 执行卖出 */
  sell: (symbol: string, symbolName: string, quantity: number) => Order;

  /** 获取绩效指标 */
  calculateMetrics: () => PerformanceMetrics;

  /** 重置模拟 */
  reset: () => void;
}

// ------ 初始状态 ------

export const initialSimulationState: SimulationState = {
  scenarioData: null,
  scenarioMeta: null,
  progress: null,
  currentDate: "",
  isLastDay: false,
  visibleKlines: {},
  visibleNews: [],
  todayNews: [],
  todayKlines: {},
  tradeHistory: [],
  dailyPortfolioValues: [],
  aiReviewLoading: false,
  aiReview: null,
  metrics: null,
  isLoading: false,
  error: null,
};

// ------ Store 创建逻辑（框架无关） ------

/**
 * 创建模拟 Store 的核心逻辑
 * 与 Zustand 解耦，可在任意状态管理中复用
 *
 * 使用方式（在 apps/web 中通过 Zustand 包装）：
 * ```ts
 * const useSimulationStore = create<SimulationState & SimulationActions>((set, get) => ({
 *   ...initialSimulationState,
 *   ...createSimulationActions(set, get),
 * }));
 * ```
 */
export function createSimulationActions(
  set: (partial: Partial<SimulationState>) => void,
  get: () => SimulationState,
): SimulationActions {
  const engine = new SimulationEngine();
  const scenarioMgr = new ScenarioManager();

  // 追踪昨日买入的股票（T+1 可卖）
  let yesterdayBuys: string[] = [];
  let todayBuys: string[] = [];

  return {
    loadScenario(data: ScenarioData) {
      scenarioMgr.initFromData(data);
      const progress = scenarioMgr.createInitialProgress(
        data.meta.id,
        data.meta.initialCapital,
      );
      const firstDate = progress.currentDate;

      // 计算首日可见数据
      const visibleKlines: Record<string, KLine[]> = {};
      for (const symbol of data.meta.symbols) {
        visibleKlines[symbol] = scenarioMgr.getKlinesUntil(symbol, firstDate);
      }

      set({
        scenarioData: data,
        scenarioMeta: data.meta,
        progress,
        currentDate: firstDate,
        isLastDay: scenarioMgr.isLastDay(firstDate),
        visibleKlines,
        visibleNews: scenarioMgr.getNewsUntil(firstDate),
        todayNews: scenarioMgr.getNewsOnDate(firstDate),
        todayKlines: scenarioMgr.getAllKlinesOnDate(firstDate),
        tradeHistory: [],
        dailyPortfolioValues: [{
          date: firstDate,
          totalAssets: data.meta.initialCapital,
        }],
        aiReview: null,
        metrics: null,
        isLoading: false,
        error: null,
      });

      yesterdayBuys = [];
      todayBuys = [];
    },

    advanceDay() {
      const state = get();
      if (!state.progress || state.isLastDay) return;

      const nextDate = scenarioMgr.getNextTradingDate(state.currentDate);
      if (!nextDate) return;

      // 获取新一天的 K 线
      const newDayKlines = scenarioMgr.getAllKlinesOnDate(nextDate);

      // T+1: 昨日买入变为可卖
      yesterdayBuys = [...todayBuys];
      todayBuys = [];

      // 推进引擎
      const updatedPortfolio = engine.advanceDay(
        state.progress.portfolio,
        newDayKlines,
        yesterdayBuys,
      );

      // 更新可见数据
      const visibleKlines: Record<string, KLine[]> = {};
      for (const symbol of state.scenarioMeta!.symbols) {
        visibleKlines[symbol] = scenarioMgr.getKlinesUntil(symbol, nextDate);
      }

      const isLast = scenarioMgr.isLastDay(nextDate);
      const dayIndex = scenarioMgr.getDayIndex(nextDate);

      set({
        currentDate: nextDate,
        isLastDay: isLast,
        visibleKlines,
        visibleNews: scenarioMgr.getNewsUntil(nextDate),
        todayNews: scenarioMgr.getNewsOnDate(nextDate),
        todayKlines: newDayKlines,
        progress: {
          ...state.progress,
          currentDate: nextDate,
          portfolio: updatedPortfolio,
          dayIndex,
          status: isLast ? "completed" : "in_progress",
        },
        dailyPortfolioValues: [
          ...state.dailyPortfolioValues,
          { date: nextDate, totalAssets: updatedPortfolio.totalAssets },
        ],
      });
    },

    buy(symbol: string, symbolName: string, quantity: number): Order {
      const state = get();
      if (!state.progress) throw new Error("No active simulation");

      const kline = state.todayKlines[symbol];
      if (!kline) throw new Error(`No kline data for ${symbol} on ${state.currentDate}`);

      const result = engine.buy(
        state.progress.portfolio,
        symbol,
        symbolName,
        quantity,
        kline,
        state.currentDate,
      );

      if (result.order.status === "filled") {
        todayBuys.push(symbol);
      }

      set({
        progress: {
          ...state.progress,
          portfolio: result.updatedPortfolio,
          tradeHistory: [...state.progress.tradeHistory, result.order],
        },
        tradeHistory: [...state.tradeHistory, result.order],
      });

      return result.order;
    },

    sell(symbol: string, symbolName: string, quantity: number): Order {
      const state = get();
      if (!state.progress) throw new Error("No active simulation");

      const kline = state.todayKlines[symbol];
      if (!kline) throw new Error(`No kline data for ${symbol} on ${state.currentDate}`);

      const result = engine.sell(
        state.progress.portfolio,
        symbol,
        symbolName,
        quantity,
        kline,
        state.currentDate,
      );

      set({
        progress: {
          ...state.progress,
          portfolio: result.updatedPortfolio,
          tradeHistory: [...state.progress.tradeHistory, result.order],
        },
        tradeHistory: [...state.tradeHistory, result.order],
      });

      return result.order;
    },

    calculateMetrics(): PerformanceMetrics {
      const state = get();
      if (!state.progress) throw new Error("No active simulation");

      const metrics = engine.calcPerformanceMetrics(
        state.tradeHistory,
        state.dailyPortfolioValues,
        state.progress.portfolio.initialCapital,
      );

      set({ metrics });
      return metrics;
    },

    reset() {
      yesterdayBuys = [];
      todayBuys = [];
      set(initialSimulationState);
    },
  };
}
