/** 训练任务 */
export type TrainJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** 同板块横截面特征 / 多股票预测单只配置 */
export interface PeerConfig {
  enabled?: boolean; // 是否开启同板块横截面特征
  group_by?: "industry" | "industry_level2" | "market"; // 分组维度（同业/同板块）
  modes?: Array<"rank" | "relative" | "sector_mean" | "sector_return">; // 特征类型组合
  peer_symbols?: string[]; // 显式指定同业股票池（不传则按 group_by 自动取同板块）
}

export interface TrainJobConfig {
  algorithm: string; // "dummy" | "lightgbm" | "xgboost"
  features?: string[]; // 显式指定因子 ID（有信息量）；不传则自动选 scalar/rank 因子
  target?: string;
  train_start?: string | null;
  train_end?: string | null;
  as_of?: string | null;
  symbols?: string[] | null; // 限定股票池；不传则自动取样
  model_name?: string | null; // 模型展示名；不传自动生成唯一名
  target_symbol?: string | null; // 指定「预测哪一只」；不传则全市场面板各自预测
  peer?: PeerConfig | null; // 同板块横截面特征 / 多股票输入预测单只
  params?: {
    selection?: { method: "importance" | "variance"; max_features?: number };
    label?: Record<string, unknown>;
    num_boost_round?: number;
    split_method?: "time" | "random"; // 训练/验证切分方式；默认 time（按时间，杜绝未来函数）
    [k: string]: unknown;
  };
  simulated_duration_sec?: number;
}

export interface TrainJobCreate {
  model_id?: string | null;
  config: TrainJobConfig;
}

export interface TrainJobCreateResponse {
  job_id: string;
  status: "pending";
  celery_task_id: string;
  queued_at: string;
}

export interface TrainingJob {
  job_id: string;
  model_id?: string | null;
  user_id?: string | null;
  status: TrainJobStatus;
  progress?: number | null;
  stage?: string | null;
  config: TrainJobConfig;
  metrics_preview?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
}

/** 单一切分（train / valid）的评估指标 */
export interface SplitMetrics {
  auc: number | null; // 单类时可能为 null
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  confusion: [[number, number], [number, number]]; // [[TN,FP],[FN,TP]]
  n: number;
}

/** 训练完成后的「一站式结果产物」 */
export interface TrainingResult {
  job_id: string;
  status: string;
  ready: boolean;
  model_id?: string;
  model_name?: string;
  algorithm?: string;
  target?: string;
  version?: string;
  model_file: {
    file_path: string | null;
    file_size?: number | null;
    download_url: string | null; // 预签名下载链接
  };
  input_features?: string[]; // 特征输入顺序（predict 必须严格对齐）
  feature_importance?: Record<string, number>; // 完整重要度（与 input_features 同序）
  metrics_table?: { train: SplitMetrics; valid: SplitMetrics }; // 评估指标表
  training_range?: { start?: string | null; end?: string | null } | null;
  config?: {
    label_spec?: Record<string, unknown>;
    target_symbol?: string | null;
    peer?: PeerConfig | null;
    split_method?: "time" | "random";
  };
  metrics_preview?: Record<string, unknown> | null;
  message?: string;
}

export interface ModelDownloadUrl {
  model_id: string;
  name?: string | null;
  file_path: string;
  file_size?: number | null;
  download_url: string;
  expires_in_seconds: number;
}
