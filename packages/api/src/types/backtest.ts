/** 回测类型 */
export type BacktestMode = "fast" | "realistic";
export type StrategyType = "factor" | "composite" | "model" | "signal_file";
export type BacktestStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface StrategySpec {
  type: StrategyType;
  factor_id?: string | null;
  composite_id?: string | null;
  model_id?: string | null;
  model_version?: string | null;
  signal_file_id?: string | null;
}

export interface TradeRules {
  commission_rate?: number;
  stamp_tax?: number;
  slippage?: number;
  min_commission?: number;
  t_plus_1?: boolean;
  allow_limit_order?: boolean;
}

export interface PositionSizing {
  method: "equal_weight" | "signal_weight" | "fixed_amount" | "custom";
  max_positions?: number;
  single_stock_pct?: number;
  rebalance_frequency?: "daily" | "weekly" | "monthly" | "signal_triggered";
}

export interface BacktestConfig {
  mode: BacktestMode;
  strategy: StrategySpec;
  start: string;
  end: string;
  universe?: string | string[];
  initial_capital?: number;
  rules?: TradeRules | null;
  position_sizing?: PositionSizing | null;
  benchmark?: string;
  advanced?: {
    include_feature_importance?: boolean;
    include_trade_log?: boolean;
    include_daily_positions?: boolean;
  } | null;
}

export interface BacktestSummary {
  total_return: number;
  annual_return: number;
  benchmark_return: number;
  excess_return: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  max_drawdown: number;
  max_drawdown_period: [string, string];
  volatility: number;
  win_rate: number;
  profit_loss_ratio: number;
  turnover_rate: number;
  total_trades: number;
  ic?: number | null;
  ir?: number | null;
}

export interface EquityCurve {
  dates: string[];
  portfolio: number[];
  benchmark: number[];
  benchmark_price?: number[];
  drawdown: number[];
  cash: number[];
  positions_count: number[];
}

/** 横截面策略（factor/composite/signal_file）的期末 Top-N 持仓 */
export interface HoldingInfo {
  symbol: string;
  weight: number;
  ret: number;
}

/** 回测结果附带元信息（样本内/外、持仓、基准名等） */
export interface BacktestMeta {
  engine?: string;
  strategy_type?: string | null;
  benchmark_name?: string;
  in_sample?: boolean | null;
  training_range?: { start: string; end: string } | null;
  overlap_days?: number | null;
  holdings?: HoldingInfo[];
  n_symbols?: number;
  universe_resolved?: string;
  source?: string;
  [k: string]: unknown;
}

export interface PeriodStats {
  start: string;
  end: string;
  return: number;
  volatility: number;
  sharpe: number;
  max_drawdown: number;
}

export interface FeatureImportance {
  feature: string;
  importance: number;
  shap_abs_mean: number;
}

export interface Trade {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  datetime: string;
  price: number;
  quantity: number;
  amount: number;
  commission: number;
  reason?: string | null;
  pnl?: number | null;
}

export interface BacktestResult {
  id: string;
  config: BacktestConfig;
  status: BacktestStatus;
  progress?: { pct: number; stage: string } | null;
  summary: BacktestSummary;
  equity_curve: EquityCurve;
  segment_performance?: Record<string, PeriodStats> | null;
  feature_importance?: FeatureImportance[] | null;
  trades?: Trade[] | null;
  duration_ms?: number;
  created_at: string;
  completed_at?: string | null;
  /** 附带元信息：样本内/外、Top-N 持仓、基准名等 */
  meta?: BacktestMeta;
}

export interface QuickFactorRequest {
  factor_id: string;
  start: string;
  end: string;
  universe?: string | string[];
  benchmark?: string;
}
