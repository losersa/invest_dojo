/**
 * 通用分页/响应类型
 */
export interface Pagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  has_next?: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: Pagination;
  meta?: Record<string, unknown>;
}

export interface SingleResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface ListResponse<T> {
  data: T[];
  meta?: Record<string, unknown>;
}

/**
 * API 错误响应格式（所有 SVC 统一）
 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: Record<string, unknown>;

  constructor(status: number, body: ApiErrorBody | string) {
    const parsed: ApiErrorBody =
      typeof body === "string"
        ? { error: { code: "unknown", message: body } }
        : body;
    super(parsed.error.message);
    this.name = "ApiError";
    this.status = status;
    this.code = parsed.error.code;
    this.detail = parsed.error.detail;
  }
}
