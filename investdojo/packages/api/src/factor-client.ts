/**
 * FactorClient · 对应 feature-svc（:8001）
 */
import { BaseClient, type ClientOptions } from "./base-client";
import type {
  Factor,
  FactorCategory,
  FactorCategoryCount,
  FactorTagCount,
  PaginatedResponse,
  SingleResponse,
} from "./types";

export class FactorClient extends BaseClient {
  constructor(opts: ClientOptions) {
    super(opts);
  }

  listFactors(params: {
    category?: FactorCategory;
    tags?: string[];
    owner?: "platform" | "user" | "all";
    visibility?: "public" | "private" | "all";
    search?: string;
    sort?: string;
    include_stats?: boolean;
    page?: number;
    page_size?: number;
  } = {}): Promise<PaginatedResponse<Factor>> {
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

  /** 因子历史值（Epic 3 完善，当前占位） */
  getFactorHistory(
    factorId: string,
    params: { symbols: string[]; start?: string; end?: string; format?: "long" | "wide" },
  ): Promise<{ data: unknown; meta: Record<string, unknown> }> {
    return this.get(
      `/api/v1/factors/${encodeURIComponent(factorId)}/history`,
      params,
    );
  }
}
