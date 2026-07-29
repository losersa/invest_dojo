/**
 * TrainClient · 对应 train-svc（:8002）
 */
import { BaseClient, type ClientOptions } from "./base-client";
import type {
  ModelDownloadUrl,
  PaginatedResponse,
  SingleResponse,
  TrainingJob,
  TrainingResult,
  TrainingTargetGroup,
  TrainJobCreate,
  TrainJobCreateResponse,
} from "./types";

export interface TrainClientOptions extends ClientOptions {
  /** 当前用户 id，写接口 / 归属查询会带到 X-User-Id header（自建鉴权，由前端 auth 模块注入） */
  userId?: string | (() => string | undefined | Promise<string | undefined>);
}

export class TrainClient extends BaseClient {
  private readonly userIdProvider?: TrainClientOptions["userId"];

  constructor(opts: TrainClientOptions) {
    super(opts);
    this.userIdProvider = opts.userId;
  }

  /** 解析当前用户 id；兼容同步 / 异步 provider（如等待自建鉴权会话就绪后再返回） */
  private async resolveUserId(): Promise<string | undefined> {
    const p = this.userIdProvider;
    if (typeof p === "function") return await p();
    return p;
  }

  private async userHeaders(): Promise<Record<string, string>> {
    const uid = await this.resolveUserId();
    return uid ? { "X-User-Id": uid } : {};
  }

  /** 提交训练任务（带 X-User-Id，使参数 / 结果归属该用户主键 id） */
  async createJob(req: TrainJobCreate): Promise<{ data: TrainJobCreateResponse }> {
    const headers = await this.userHeaders();
    return this.request<{ data: TrainJobCreateResponse }>("POST", "/api/v1/training/jobs", {
      body: req,
      headers,
    });
  }

  listJobs(params: {
    status?: string;
    user_id?: string;
    /** 按预测目标股票过滤；传 "__none__" 只取全市场面板任务 */
    target_symbol?: string;
    page?: number;
    page_size?: number;
  } = {}): Promise<PaginatedResponse<TrainingJob>> {
    return this.get("/api/v1/training/jobs", params);
  }

  /** 按预测目标股票聚合任务（训练首页分模块用）；不传 user_id 则回退到当前用户 */
  async listTargets(params: { user_id?: string } = {}): Promise<{ data: TrainingTargetGroup[] }> {
    const user_id = params.user_id ?? (await this.resolveUserId());
    return this.get("/api/v1/training/targets", user_id ? { user_id } : {});
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
