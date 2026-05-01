/**
 * FactorClient · 对应 feature-svc（:8001）
 *
 * T-3.06 完整版：CRUD + 校验 + 计算 + 历史 + 表现 + 对比 + 批量查
 */
import { BaseClient, type ClientOptions } from "./base-client";
import type {
  Factor,
  FactorBatchQueryResponse,
  FactorCategory,
  FactorCategoryCount,
  FactorCompareResponse,
  FactorCreatePayload,
  FactorHistoryLong,
  FactorHistoryWide,
  FactorPerformance,
  FactorTagCount,
  FactorUpdatePayload,
  FactorValidateResponse,
  PaginatedResponse,
  SingleResponse,
} from "./types";

export interface FactorClientOptions extends ClientOptions {
  /** 当前用户 id，写接口会带到 X-User-Id header。MVP 用，生产改走 Supabase JWT */
  userId?: string | (() => string | undefined);
}

export class FactorClient extends BaseClient {
  private readonly userIdProvider?: FactorClientOptions["userId"];

  constructor(opts: FactorClientOptions) {
    super(opts);
    this.userIdProvider = opts.userId;
  }

  private userHeaders(): Record<string, string> {
    const uid =
      typeof this.userIdProvider === "function"
        ? this.userIdProvider()
        : this.userIdProvider;
    return uid ? { "X-User-Id": uid } : {};
  }

  // ── 读 ─────────────────────────────────────
  listFactors(
    params: {
      category?: FactorCategory;
      tags?: string[];
      owner?: "platform" | "user" | "all";
      visibility?: "public" | "private" | "all";
      search?: string;
      sort?: string;
      include_stats?: boolean;
      page?: number;
      page_size?: number;
    } = {},
  ): Promise<PaginatedResponse<Factor>> {
    return this.get("/api/v1/factors", params);
  }

  getFactor(
    id: string,
    params: { include_stats?: boolean } = {},
  ): Promise<SingleResponse<Factor>> {
    return this.get(`/api/v1/factors/${encodeURIComponent(id)}`, params);
  }

  listCategories(): Promise<{ data: FactorCategoryCount[] }> {
    return this.get("/api/v1/factors/categories");
  }

  listTags(): Promise<{ data: FactorTagCount[] }> {
    return this.get("/api/v1/factors/tags");
  }

  // ── 历史值 / 表现 / 对比 ──────────────────────
  getFactorHistory(
    factorId: string,
    params: { symbols: string[]; start?: string; end?: string; format?: "long" },
  ): Promise<FactorHistoryLong>;
  getFactorHistory(
    factorId: string,
    params: { symbols: string[]; start?: string; end?: string; format: "wide" },
  ): Promise<FactorHistoryWide>;
  getFactorHistory(
    factorId: string,
    params: {
      symbols: string[];
      start?: string;
      end?: string;
      format?: "long" | "wide";
    },
  ): Promise<FactorHistoryLong | FactorHistoryWide> {
    return this.get(
      `/api/v1/factors/${encodeURIComponent(factorId)}/history`,
      params,
    );
  }

  getFactorPerformance(
    factorId: string,
    params: { start?: string; end?: string } = {},
  ): Promise<SingleResponse<FactorPerformance>> {
    return this.get(
      `/api/v1/factors/${encodeURIComponent(factorId)}/performance`,
      params,
    );
  }

  compareFactors(body: {
    factor_ids: string[];
    start: string;
    end: string;
    metrics?: string[];
  }): Promise<SingleResponse<FactorCompareResponse>> {
    return this.post("/api/v1/factors/compare", body);
  }

  batchQuery(body: {
    factor_ids: string[];
    symbols: string[];
    date: string;
  }): Promise<SingleResponse<FactorBatchQueryResponse>> {
    return this.post("/api/v1/factors/batch-query", body);
  }

  // ── 校验 / 计算 ────────────────────────────
  validateFormula(body: {
    formula: string;
    formula_type?: "dsl" | "python";
    preview?: { symbols: string[]; start?: string; end?: string };
  }): Promise<SingleResponse<FactorValidateResponse>> {
    return this.post("/api/v1/factors/validate", body);
  }

  computeFactor(body: {
    factor_id?: string;
    formula?: string;
    formula_type?: "dsl" | "python";
    symbols: string[];
    start: string;
    end: string;
    scenario_id?: string;
    format?: "long" | "wide";
  }): Promise<{ data: unknown; meta: Record<string, unknown> }> {
    return this.post("/api/v1/factors/compute", body);
  }

  // ── 写（X-User-Id header） ──────────────────
  createFactor(body: FactorCreatePayload): Promise<SingleResponse<Factor>> {
    return this.request<SingleResponse<Factor>>("POST", "/api/v1/factors", {
      body,
      headers: this.userHeaders(),
    });
  }

  updateFactor(
    id: string,
    body: FactorUpdatePayload,
  ): Promise<SingleResponse<Factor>> {
    return this.request<SingleResponse<Factor>>(
      "PUT",
      `/api/v1/factors/${encodeURIComponent(id)}`,
      { body, headers: this.userHeaders() },
    );
  }

  deleteFactor(id: string): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/api/v1/factors/${encodeURIComponent(id)}`,
      { headers: this.userHeaders() },
    );
  }

  publishFactor(
    id: string,
    body: { long_description?: string; license?: string } = {},
  ): Promise<SingleResponse<Factor>> {
    return this.request<SingleResponse<Factor>>(
      "POST",
      `/api/v1/factors/${encodeURIComponent(id)}/publish`,
      { body, headers: this.userHeaders() },
    );
  }
}
