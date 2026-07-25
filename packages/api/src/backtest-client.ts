/**
 * BacktestClient · 对应 backtest-svc（:8004）
 */
import { BaseClient, type ClientOptions } from "./base-client";
import type {
  BacktestConfig,
  BacktestResult,
  PaginatedResponse,
  QuickFactorRequest,
  SingleResponse,
} from "./types";

export class BacktestClient extends BaseClient {
  constructor(opts: ClientOptions) {
    super(opts);
  }

  runFast(
    config: BacktestConfig,
  ): Promise<{ data: BacktestResult; meta: Record<string, unknown> }> {
    return this.post("/api/v1/backtests/run-fast", config);
  }

  quickFactor(
    req: QuickFactorRequest,
  ): Promise<{ data: Partial<BacktestResult> & { factor_id: string }; meta: Record<string, unknown> }> {
    return this.post("/api/v1/backtests/quick-factor", req);
  }

  getBacktest(id: string): Promise<SingleResponse<BacktestResult>> {
    return this.get(`/api/v1/backtests/${encodeURIComponent(id)}`);
  }

  listBacktests(params: {
    status?: string;
    user_id?: string;
    page?: number;
    page_size?: number;
  } = {}): Promise<PaginatedResponse<BacktestResult>> {
    return this.get("/api/v1/backtests", params);
  }
}
