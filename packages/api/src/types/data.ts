/** Symbol / 股票元数据 */
export interface Symbol {
  code: string;
  market: string; // 'SH' | 'SZ' | 'BJ' | 'A'（DB 里有 'A'，前端兼容）
  name: string;
  short_name?: string | null;
  industry?: string | null;
  industry_level2?: string | null;
  listed_at?: string | null;
  delisted_at?: string | null;
  total_share?: number | null;
  float_share?: number | null;
  status: "normal" | "active" | "suspended" | "delisted";
  tags?: string[] | null;
}

export interface Industry {
  id: number;
  name: string;
  level: 1 | 2;
  parent_id?: number | null;
  code?: string | null;
  symbol_count: number;
}

/** K 线 */
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "1d" | "1w" | "1M";

export interface KLine {
  symbol: string;
  timeframe: Timeframe;
  dt: string; // "YYYY-MM-DD"（日 K）或 ISO 8601（分钟 K）
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover?: number;
  pre_close?: number | null;
  change_amount?: number | null;
  change_percent?: number | null;
  adj_factor?: number;
}

/** 新闻 */
export type NewsCategory =
  | "macro"
  | "policy"
  | "industry"
  | "company"
  | "market"
  | "international";

export interface NewsItem {
  id: string;
  scenario_id?: string | null;
  published_at: string;
  title: string;
  content?: string | null;
  source: string;
  category: NewsCategory;
  sentiment?: "positive" | "neutral" | "negative" | null;
  sentiment_score?: number | null;
  impact_level?: number | null;
  related_symbols?: string[] | null;
  tags?: string[] | null;
  url?: string | null;
}

/** 财报 */
export type FundamentalStatement =
  | "profit"
  | "balance"
  | "cashflow"
  | "growth"
  | "operation";

export interface Fundamental {
  symbol: string;
  report_date: string; // "2024-Q1"
  announce_date: string; // "2024-04-29"
  statement: FundamentalStatement;
  data: Record<string, unknown>;
  derived?: Record<string, unknown> | null;
  source?: string | null;
}

/** 市场快照 */
export interface IndexSnapshot {
  close?: number | null;
  preclose?: number | null;
  volume?: number | null;
  amount?: number | null;
  change_pct?: number | null;
}

export interface AdvanceDecline {
  advance: number;
  decline: number;
  unchanged: number;
  limit_up: number;
  limit_down: number;
  total: number;
}

export interface MarketSnapshot {
  date: string;
  indexes: Record<string, IndexSnapshot> | null;
  north_capital?: number | null;
  money_flow?: Record<string, number> | null;
  advance_decline?: AdvanceDecline | null;
  top_industries?: Array<{ industry: string; change_percent: number }> | null;
}

/** 场景 */
export interface Scenario {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  difficulty?: "easy" | "medium" | "hard" | null;
  date_start: string;
  date_end: string;
  symbols: string[];
  initial_capital?: number | null;
  tags?: string[] | null;
  cover_image?: string | null;
}
