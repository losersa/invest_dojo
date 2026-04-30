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
