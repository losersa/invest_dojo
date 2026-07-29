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
  modes?: Array<"rank" | "relative" | "sector_mean">; // 特征类型组合
  peer_symbols?: string[]; // 显式指定同业股票池（不传则按 group_by 自动取同板块）
  /** 池用途开关：reference=横截面参照系(A，算目标股在池中的 rank/rel/mean)；
   *  features=池特征输入(B，算跨池横截面统计块 pool__{factor}__{stat})。默认 reference。 */
  pool_mode?: "reference" | "features";
  /** B 模式专用：池特征仅用 technical(K线/价格成交量) 因子，避开基本面因子的低频噪声。默认 false。 */
  pool_kline_only?: boolean;
}

export interface TrainJobConfig {
  algorithm: string; // "dummy" | "lightgbm" | "xgboost"
  features?: string[]; // 显式指定因子 ID（有信息量）；不传则自动选 scalar/rank 因子
  target?: string;
  train_start?: string | null;
  train_end?: string | null;
  /** 预留测试集（用户手里的「未来数据」）：不参与训练/调参，仅最终评估，用于与验证集对比泛化漂移 */
  test_start?: string | null;
  test_end?: string | null;
  /** 最终模型训练模式：true=并入验证集全量训练(train+valid)；false=只在 train 上训练(验证集保留为干净评估) */
  refit_on_valid?: boolean;
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
  target_symbol?: string | null; // 预测目标股票（独立列，冗余自 config.target_symbol）
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
  pos?: number; // 正样本数（旧任务无此字段）
  pos_ratio?: number | null; // 正样本占比
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
  metrics_table?: {
    train: SplitMetrics;
    valid: SplitMetrics;
    test?: SplitMetrics; // 预留测试集指标（不参与训练/调参，仅最终评估）
    cls_threshold?: number; // 自适应分类阈值（Youden J）
    split_range?: {
      train: { start: string; end: string };
      valid: { start: string; end: string };
      test?: { start: string; end: string }; // 预留测试集实际时间范围
    }; // 训练/验证/测试实际时间范围
    tuned_params?: Record<string, unknown> | null; // 自动调参选中的超参（用验证集）
    cv_auc?: number | null; // 调参验证集最优得分（字段名兼容旧数据，实际指标见 cv_metric）
    cv_metric?: string | null; // 调参目标指标：auc / pr_auc / logloss / f1（旧任务无此字段=auc）
    degenerate?: boolean; // 退化标记：双 AUC≈0.5，模型未学到有效信号
    final_train_on_valid?: boolean; // 最终模型是否并入验证集全量训练
  }; // 评估指标表
  training_range?: { start?: string | null; end?: string | null } | null;
  n_final_train?: number; // 最终模型实际训练样本数（含验证集时=训练+验证）
  config?: {
    label_spec?: Record<string, unknown>;
    target_symbol?: string | null;
    peer?: PeerConfig | null;
    split_method?: "time" | "random";
    test_start?: string | null;
    test_end?: string | null;
    refit_on_valid?: boolean;
  };
  metrics_preview?: Record<string, unknown> | null;
  message?: string;
}

/** 按预测目标股票聚合的训练任务分组（训练首页分模块用） */
export interface TrainingTargetGroup {
  target_symbol: string | null; // null=全市场面板
  job_count: number;
  completed_count: number;
  latest_status?: string | null;
  latest_created_at?: string | null;
  latest_target?: string | null; // 最近任务的预测周期，如 return_5d
  latest_algorithm?: string | null;
}

export interface ModelDownloadUrl {
  model_id: string;
  name?: string | null;
  file_path: string;
  file_size?: number | null;
  download_url: string;
  expires_in_seconds: number;
}
