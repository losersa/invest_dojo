/** 训练任务 */
export type TrainJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TrainJobConfig {
  algorithm: string; // "dummy" | "lightgbm" | "xgboost"
  features?: string[];
  target?: string;
  train_start?: string | null;
  train_end?: string | null;
  as_of?: string | null;
  params?: Record<string, unknown>;
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
