/**
 * DataClient · 对应 data-svc（:8000）
 *
 * 示例：
 *   const c = new DataClient({ baseURL: "http://localhost:8000" });
 *   const { data } = await c.getSymbol("600519");
 */
import { BaseClient, type ClientOptions } from "./base-client";
import type {
  Fundamental,
  FundamentalStatement,
  Industry,
  KLine,
  MarketSnapshot,
  NewsCategory,
  NewsItem,
  PaginatedResponse,
  Scenario,
  SingleResponse,
  Symbol as StockSymbol,
  Timeframe,
} from "./types";

export class DataClient extends BaseClient {
  constructor(opts: ClientOptions) {
    super(opts);
  }

  // ─── symbols ────
  listSymbols(params: {
    codes?: string[];
    market?: "SH" | "SZ" | "BJ";
    industry?: string;
    status?: string;
    universe?: "hs300" | "zz500" | "zz1000" | "all";
    search?: string;
    page?: number;
    page_size?: number;
  } = {}): Promise<PaginatedResponse<StockSymbol>> {
    return this.get("/api/v1/data/symbols", params);
  }

  getSymbol(code: string): Promise<SingleResponse<StockSymbol>> {
    return this.get(`/api/v1/data/symbols/${encodeURIComponent(code)}`);
  }

  listIndustries(level?: 1 | 2): Promise<{ data: Industry[] }> {
    return this.get("/api/v1/data/industries", { level });
  }

  // ─── klines ────
  getKlines(params: {
    symbols: string[];
    timeframe?: Timeframe;
    start?: string;
    end?: string;
    as_of?: string;
    scenario_id?: string;
    format?: "long" | "wide";
    page?: number;
    page_size?: number;
  }): Promise<PaginatedResponse<KLine> & { meta: Record<string, unknown> }> {
    return this.get("/api/v1/data/klines", params);
  }

  getLatestKlines(params: {
    symbols: string[];
    timeframe?: Timeframe;
    as_of?: string;
  }): Promise<{ data: KLine[]; meta: Record<string, unknown> }> {
    return this.get("/api/v1/data/klines/latest", params);
  }

  // ─── news ────
  listNews(params: {
    start?: string;
    end?: string;
    as_of?: string;
    category?: NewsCategory;
    symbol?: string;
    scenario_id?: string;
    page?: number;
    page_size?: number;
  } = {}): Promise<PaginatedResponse<NewsItem> & { meta: Record<string, unknown> }> {
    return this.get("/api/v1/data/news", params);
  }

  // ─── fundamentals ────
  listFundamentals(params: {
    symbols: string[];
    statement?: FundamentalStatement;
    start?: string;
    end?: string;
    as_of?: string;
    page?: number;
    page_size?: number;
  }): Promise<PaginatedResponse<Fundamental> & { meta: Record<string, unknown> }> {
    return this.get("/api/v1/data/fundamentals", params);
  }

  // ─── market snapshots ────
  getMarketSnapshot(params: {
    date: string;
    as_of?: string;
  }): Promise<SingleResponse<MarketSnapshot>> {
    return this.get("/api/v1/data/market/snapshot", params);
  }

  listMarketSnapshots(params: {
    start: string;
    end: string;
    as_of?: string;
  }): Promise<{ data: MarketSnapshot[]; meta: Record<string, unknown> }> {
    return this.get("/api/v1/data/market/snapshots", params);
  }

  // ─── scenarios ────
  listScenarios(params: {
    category?: string;
    difficulty?: "easy" | "medium" | "hard";
  } = {}): Promise<{ data: Scenario[] }> {
    return this.get("/api/v1/data/scenarios", params);
  }

  getScenario(scenarioId: string): Promise<SingleResponse<Scenario>> {
    return this.get(`/api/v1/data/scenarios/${encodeURIComponent(scenarioId)}`);
  }
}
