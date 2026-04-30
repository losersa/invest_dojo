/**
 * BaseClient · 所有 REST Client 的基类
 *
 * 职责：
 * - baseURL 拼接 + query string 序列化
 * - 统一错误抛出（解析 ApiError）
 * - JSON 序列化/反序列化
 * - 可选 Bearer token 注入（Supabase JWT，Epic 7 接入 Auth）
 */
import type { ApiErrorBody } from "./types/common";
import { ApiError } from "./types/common";

export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | string[]
  | number[];

export interface ClientOptions {
  baseURL: string;
  /** 可选 Bearer token（Supabase JWT / service key） */
  token?: string | (() => string | Promise<string>);
  /** 超时（ms），默认 30s */
  timeoutMs?: number;
  /** 自定义 fetch（便于 node/jest/mock） */
  fetchImpl?: typeof fetch;
}

export class BaseClient {
  readonly baseURL: string;
  protected readonly timeoutMs: number;
  protected readonly tokenProvider?: ClientOptions["token"];
  protected readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.tokenProvider = opts.token;
    this.fetchImpl =
      opts.fetchImpl ??
      (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined as unknown as typeof fetch);
    if (!this.fetchImpl) {
      throw new Error("No fetch available; pass fetchImpl in ClientOptions");
    }
  }

  // ──────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────
  private async resolveToken(): Promise<string | null> {
    if (!this.tokenProvider) return null;
    if (typeof this.tokenProvider === "string") return this.tokenProvider;
    const v = await this.tokenProvider();
    return v || null;
  }

  private buildURL(path: string, query?: Record<string, QueryValue>): string {
    const p = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(this.baseURL + p);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          if (v.length === 0) continue;
          // 逗号分隔数组（符合各 svc 约定，如 symbols=600519,000001）
          url.searchParams.set(k, v.join(","));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  /**
   * 核心请求方法
   */
  protected async request<T>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, QueryValue>;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const url = this.buildURL(path, opts.query);
    const token = await this.resolveToken();

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(opts.headers ?? {}),
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (e: unknown) {
      clearTimeout(timer);
      if (e instanceof Error && e.name === "AbortError") {
        throw new ApiError(0, {
          error: { code: "timeout", message: `Request timeout after ${this.timeoutMs}ms: ${method} ${url}` },
        });
      }
      throw new ApiError(0, {
        error: { code: "network_error", message: e instanceof Error ? e.message : String(e) },
      });
    } finally {
      clearTimeout(timer);
    }

    // 非 2xx 统一抛 ApiError
    if (!resp.ok) {
      let body: ApiErrorBody | string;
      const text = await resp.text();
      try {
        const parsed = JSON.parse(text);
        // FastAPI 422 返回 { detail: [...] }，需要兜底
        if (parsed?.detail?.error) {
          body = { error: parsed.detail.error };
        } else if (Array.isArray(parsed?.detail)) {
          body = {
            error: {
              code: "validation_error",
              message: parsed.detail.map((d: { msg?: string }) => d.msg ?? "").join("; "),
              detail: { validation: parsed.detail },
            },
          };
        } else if (parsed?.detail) {
          body = {
            error: { code: "http_error", message: String(parsed.detail) },
          };
        } else {
          body = parsed;
        }
      } catch {
        body = text || `HTTP ${resp.status}`;
      }
      throw new ApiError(resp.status, body);
    }

    // 204 No Content
    if (resp.status === 204) {
      return undefined as unknown as T;
    }

    return (await resp.json()) as T;
  }

  protected get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  protected post<T>(path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>("POST", path, { body, query });
  }

  protected put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }

  protected delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}
