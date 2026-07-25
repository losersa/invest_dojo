/**
 * TrainClient · 对应 train-svc（:8002）
 */
import { BaseClient, type ClientOptions } from "./base-client";
import type {
  ModelDownloadUrl,
  PaginatedResponse,
  SingleResponse,
  TrainJobCreate,
  TrainJobCreateResponse,
  TrainingJob,
  TrainingResult,
} from "./types";

export class TrainClient extends BaseClient {
  constructor(opts: ClientOptions) {
    super(opts);
  }

  createJob(req: TrainJobCreate): Promise<{ data: TrainJobCreateResponse }> {
    return this.post("/api/v1/training/jobs", req);
  }

  listJobs(params: {
    status?: string;
    user_id?: string;
    page?: number;
    page_size?: number;
  } = {}): Promise<PaginatedResponse<TrainingJob>> {
    return this.get("/api/v1/training/jobs", params);
  }

  getJob(jobId: string): Promise<SingleResponse<TrainingJob>> {
    return this.get(`/api/v1/training/jobs/${encodeURIComponent(jobId)}`);
  }

  cancelJob(jobId: string): Promise<{ data: { job_id: string; status: "cancelled" } }> {
    return this.delete(`/api/v1/training/jobs/${encodeURIComponent(jobId)}`);
  }

  /** 训练完成后的「一站式结果产物」（模型文件 / 特征顺序 / 重要度 / 指标表） */
  getJobResult(jobId: string): Promise<SingleResponse<TrainingResult>> {
    return this.get(`/api/v1/training/jobs/${encodeURIComponent(jobId)}/result`);
  }

  /** 获取模型文件预签名下载链接 */
  getModelDownloadUrl(modelId: string): Promise<SingleResponse<ModelDownloadUrl>> {
    return this.get(`/api/v1/models/${encodeURIComponent(modelId)}/download`);
  }
}
