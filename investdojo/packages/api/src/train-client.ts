/**
 * TrainClient · 对应 train-svc（:8002）
 */
import { BaseClient, type ClientOptions } from "./base-client";
import type {
  PaginatedResponse,
  SingleResponse,
  TrainJobCreate,
  TrainJobCreateResponse,
  TrainingJob,
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
}
