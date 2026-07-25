// ============================================================
// @investdojo/core — 类型定义
// 模拟炒股系统的所有共享类型
// ============================================================

// ------ K线数据 ------

/** 单根 K 线 */
export interface KLine {
  date: string;         // 'YYYY-MM-DD'
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;       // 成交量（手）
  turnover: number;     // 成交额（元）
  preClose: number;     // 前收盘价
  change: number;       // 涨跌额
  changePercent: number; // 涨跌幅 (%)
}

// ------ 新闻 & 政策 ------

export interface NewsItem {
  id: string;
  date: string;
  title: string;
  content: string;
  source: string;
  category: 'news' | 'policy' | 'announcement';
  sentiment: 'positive' | 'negative' | 'neutral';
  impactLevel: 1 | 2 | 3; // 1=低 2=中 3=高
  relatedSymbols?: string[];
}

// ------ 场景定义 ------

export interface ScenarioMeta {
  id: string;
  name: string;
  description: string;
  category: ScenarioCategory;
  difficulty: 'easy' | 'medium' | 'hard';
  dateRange: {
    start: string; // 'YYYY-MM-DD'
    end: string;
  };
  symbols: string[];       // 可交易的股票代码
  initialCapital: number;  // 初始资金
  coverImage?: string;
  tags: string[];
}

export type ScenarioCategory =
  | 'black_swan'    // 黑天鹅事件
  | 'bull_market'   // 牛市
  | 'bear_market'   // 熊市
  | 'sector_rotation' // 板块轮动
  | 'policy_driven';  // 政策驱动

/** 完整场景数据包 */
export interface ScenarioData {
  meta: ScenarioMeta;
  klines: Record<string, KLine[]>; // symbol → klines
  news: NewsItem[];
  policies: NewsItem[];
}

// ------ 交易 ------

export type OrderDirection = 'buy' | 'sell';

export interface Order {
  id: string;
  symbol: string;
  symbolName: string;
  direction: OrderDirection;
  quantity: number;     // 股数（必须是 100 的整数倍）
  price: number;        // 委托价格
  orderDate: string;    // 下单日期
  status: OrderStatus;
  executedPrice?: number;
  executedQuantity?: number;
  commission?: number;
  stampTax?: number;    // 印花税（仅卖出）
  createdAt: number;    // timestamp
}

export type OrderStatus =
  | 'pending'     // 待执行（T+0 下单，T+1 生效前的状态 → 本系统简化为当日撮合）
  | 'filled'      // 完全成交
  | 'partial'     // 部分成交
  | 'rejected'    // 拒绝（涨跌停/资金不足等）
  | 'cancelled';  // 已取消

// ------ 持仓 ------

export interface Position {
  symbol: string;
  symbolName: string;
  quantity: number;        // 持有股数
  availableQuantity: number; // 可卖股数（T+1 规则）
  avgCost: number;         // 持仓均价
  currentPrice: number;    // 当前市价
  marketValue: number;     // 市值
  profitLoss: number;      // 浮动盈亏
  profitLossPercent: number; // 浮动盈亏百分比
  buyDate: string;         // 首次买入日期
}

// ------ 投资组合 ------

export interface Portfolio {
  cash: number;              // 可用现金
  frozenCash: number;        // 冻结资金（待成交买单）
  totalAssets: number;       // 总资产 = 现金 + 持仓市值
  totalMarketValue: number;  // 持仓总市值
  totalProfitLoss: number;   // 总浮盈亏
  totalProfitLossPercent: number;
  positions: Position[];
  initialCapital: number;    // 初始资金
}

// ------ 模拟进度 ------

export interface SimulationProgress {
  scenarioId: string;
  currentDate: string;     // 模拟推进到的日期
  status: SimulationStatus;
  portfolio: Portfolio;
  tradeHistory: Order[];   // 所有已执行的交易
  dayIndex: number;        // 当前在场景中的第几天
  totalDays: number;       // 场景总天数
}

export type SimulationStatus =
  | 'not_started'
  | 'in_progress'
  | 'completed';

// ------ 绩效指标 ------

export interface PerformanceMetrics {
  totalReturn: number;           // 总收益率 (%)
  annualizedReturn: number;      // 年化收益率 (%)
  maxDrawdown: number;           // 最大回撤 (%)
  maxDrawdownDate: string;       // 最大回撤发生日期
  sharpeRatio: number;           // 夏普比率
  winRate: number;               // 胜率 (%)
  profitFactor: number;          // 盈亏比
  totalTrades: number;           // 总交易次数
  winTrades: number;             // 盈利交易次数
  lossTrades: number;            // 亏损交易次数
  avgWin: number;                // 平均盈利金额
  avgLoss: number;               // 平均亏损金额
  holdingDays: number;           // 平均持仓天数
  dailyReturns: { date: string; return: number; cumReturn: number }[];
}

// ------ AI 复盘 ------

export interface AIReviewRequest {
  scenarioId: string;
  scenarioName: string;
  tradeHistory: Order[];
  portfolio: Portfolio;
  metrics: PerformanceMetrics;
  keyEvents: NewsItem[];   // 场景期间的关键事件
}

export interface AIReviewResult {
  overallRating: 1 | 2 | 3 | 4 | 5; // 1=差 5=优
  summary: string;
  strengths: string[];
  weaknesses: string[];
  keyDecisions: {
    date: string;
    action: string;
    analysis: string;
    rating: 'good' | 'neutral' | 'bad';
  }[];
  suggestions: string[];
  benchmark: {
    buyAndHold: number;  // 买入持有收益率
    userReturn: number;  // 用户实际收益率
    alpha: number;       // 超额收益
  };
}

// ------ 费用配置 ------

export interface FeeConfig {
  commissionRate: number;   // 佣金费率 (默认 0.0003 = 万三)
  minCommission: number;    // 最低佣金 (默认 5 元)
  stampTaxRate: number;     // 印花税 (默认 0.001 = 千一，仅卖出)
  transferFeeRate: number;  // 过户费 (默认 0.00002 = 万零点二)
}

export const DEFAULT_FEE_CONFIG: FeeConfig = {
  commissionRate: 0.0003,
  minCommission: 5,
  stampTaxRate: 0.001,
  transferFeeRate: 0.00002,
};

// ------ A股交易规则 ------

export const TRADING_RULES = {
  /** 涨跌停幅度（普通股） */
  PRICE_LIMIT: 0.1,
  /** 涨跌停幅度（科创板/创业板） */
  PRICE_LIMIT_STAR: 0.2,
  /** 最小交易单位（手 = 100 股） */
  LOT_SIZE: 100,
  /** T+1 结算 */
  SETTLEMENT_DAYS: 1,
  /** 交易时间 */
  TRADING_HOURS: {
    morning: { start: '09:30', end: '11:30' },
    afternoon: { start: '13:00', end: '15:00' },
  },
} as const;
