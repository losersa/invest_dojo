/** 推理相关类型（对应 infer-svc） */
export type SignalAction = "BUY" | "SELL" | "HOLD";

export interface SignalExplanation {
  top_positive_factors: Array<{ name: string; contribution: number }>;
  top_negative_factors: Array<{ name: string; contribution: number }>;
  thesis?: string | null;
}

export interface SignalMetadata {
  model_id: string;
  model_version: string;
  inference_time_ms: number;
  seed?: number;
}

export interface Signal {
  timestamp: string;
  as_of: string;
  symbol: string;
  action: SignalAction;
  confidence: number;
  score?: number | null;
  target_position?: number | null;
  holding_horizon_days?: number | null;
  features: Record<string, number>;
  explanation?: SignalExplanation | null;
  metadata: SignalMetadata;
}

export interface InferenceRequest {
  model_id: string;
  model_version?: string;
  symbols: string[];
  as_of: string;
  include_explanation?: boolean;
  feature_overrides?: Record<string, Record<string, number>>;
}

export interface InferenceResponse {
  data: { signals: Signal[] };
  meta: {
    model_id: string;
    model_version: string;
    as_of_applied: string;
    count: number;
  };
}

export interface MockModel {
  model_id: string;
  version: string;
  description: string;
}
