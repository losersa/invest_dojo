/**
 * InferenceClient · 对应 infer-svc（:8003）
 *
 * 核心：`as_of` 必填，违反会抛 ApiError（MISSING_AS_OF / FUTURE_AS_OF）。
 */
import { BaseClient, type ClientOptions } from "./base-client";
import type {
  InferenceRequest,
  InferenceResponse,
  MockModel,
} from "./types";

export class InferenceClient extends BaseClient {
  constructor(opts: ClientOptions) {
    super(opts);
  }

  listMockModels(): Promise<{ data: MockModel[]; meta: Record<string, unknown> }> {
    return this.get("/api/v1/inference/models");
  }

  predict(req: InferenceRequest): Promise<InferenceResponse> {
    if (!req.as_of) {
      // 前端防护一层，避免无 as_of 打到后端
      throw new Error("InferenceClient.predict: as_of is required");
    }
    return this.post("/api/v1/inference/predict", req);
  }

  /**
   * 打开流式推理 WebSocket（Epic 6 完善）
   *
   * @example
   *   const ws = client.openStream();
   *   ws.onmessage = (e) => console.log(JSON.parse(e.data));
   */
  openStream(): WebSocket {
    const base = this.baseURL.replace(/^http/, "ws");
    const url = `${base}/ws/v1/inference/stream`;
    if (typeof WebSocket === "undefined") {
      throw new Error("WebSocket not available in this runtime");
    }
    return new WebSocket(url);
  }
}
