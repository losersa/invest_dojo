/** 因子相关类型 */
export type FactorCategory =
  | "technical"
  | "valuation"
  | "growth"
  | "sentiment"
  | "fundamental"
  | "macro"
  | "custom";

export interface FactorStats {
  total_triggers?: number;
  winrate_5d?: number;
  winrate_20d?: number;
  avg_return_5d?: number;
  avg_return_20d?: number;
  last_triggered_at?: string;
  sample_period?: [string, string];
  triggers_by_year?: Record<string, number>;
}

export interface Factor {
  id: string;
  name: string;
  name_en?: string | null;
  description?: string | null;
  long_description?: string | null;
  category: FactorCategory;
  tags: string[];
  formula: string;
  formula_type: "dsl" | "python";
  output_type: "boolean" | "scalar" | "rank";
  output_range?: [number, number] | null;
  lookback_days: number;
  update_frequency: "daily" | "realtime";
  version: number;
  owner: string | "platform";
  visibility: "public" | "private" | "unlisted";
  stats?: FactorStats;
  created_at: string;
  updated_at: string;
  deprecated_at?: string | null;
}

export interface FactorCategoryCount {
  category: FactorCategory;
  label: string;
  count: number;
}

export interface FactorTagCount {
  tag: string;
  count: number;
}

// ── T-3.06 API 补充 ──

export interface FactorPreviewRow {
  symbol: string;
  date: string;
  value: number | boolean;
}

export interface FactorValidateResponse {
  valid: boolean;
  parsed_ast?: Record<string, unknown> | null;
  inferred_output_type?: "boolean" | "scalar" | "rank";
  inferred_lookback?: number;
  preview_result?: FactorPreviewRow[];
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
  };
}

export interface FactorPerformance {
  factor_id: string;
  output_type: "boolean" | "scalar" | "rank";
  total_records: number;
  coverage_symbols: number;
  coverage_days: number;
  window: { start: string | null; end: string | null };
  // boolean
  trigger_count?: number;
  trigger_rate?: number;
  // scalar
  min?: number;
  max?: number;
  mean?: number;
  std?: number;
}

export interface FactorHistoryLong {
  data: FactorPreviewRow[];
  meta: {
    factor_id: string;
    output_type: string;
    rows: number;
    status: "ok" | "not_computed";
  };
}

export interface FactorHistoryWide {
  data: {
    dates: string[];
    symbols: Record<string, Array<number | boolean | null>>;
  };
  meta: {
    factor_id: string;
    output_type: string;
    dates: number;
    status: "ok" | "not_computed";
  };
}

export interface FactorCompareRow {
  factor_id: string;
  name?: string;
  output_type?: string;
  total?: number;
  coverage_symbols?: number;
  trigger_count?: number;
  trigger_rate?: number;
  avg_value?: number | null;
  error?: string;
}

export interface FactorCompareResponse {
  comparison: FactorCompareRow[];
  winner_by_metric: Record<string, string>;
  window: { start: string; end: string };
}

export interface FactorBatchQueryResponse {
  date: string;
  factors: string[];
  symbols: string[];
  values: Array<Array<number | boolean | null>>;
}

export interface FactorCreatePayload {
  name: string;
  name_en?: string | null;
  description?: string | null;
  long_description?: string | null;
  category?: FactorCategory;
  tags?: string[];
  formula: string;
  formula_type?: "dsl" | "python";
  output_type?: "boolean" | "scalar" | "rank";
  output_range?: [number, number] | null;
  lookback_days?: number;
  update_frequency?: "daily" | "realtime";
  visibility?: "public" | "private" | "unlisted";
}

export type FactorUpdatePayload = Partial<FactorCreatePayload>;
