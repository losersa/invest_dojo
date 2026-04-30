/**
 * InvestDojo TypeScript SDK
 *
 * Base URL 约定（开发环境）：
 * - data-svc:     http://localhost:8000
 * - feature-svc:  http://localhost:8001
 * - train-svc:    http://localhost:8002
 * - infer-svc:    http://localhost:8003
 * - backtest-svc: http://localhost:8004
 * - monitor-svc:  http://localhost:8005
 *
 * 基本用法：
 * ```ts
 * import { DataClient } from "@investdojo/api";
 * const c = new DataClient({ baseURL: "http://localhost:8000" });
 * const { data } = await c.getKlines({ symbols: ["600519"], start: "2024-01-01" });
 * ```
 *
 * 或使用工厂：
 * ```ts
 * import { createInvestDojoClient } from "@investdojo/api";
 * const sdk = createInvestDojoClient();
 * const { data } = await sdk.data.getSymbol("600519");
 * ```
 */

// ── 旧 exports（保留兼容） ──
export { getSupabase, type SupabaseClient } from "./supabase";
export { RealtimeSync, type RealtimeCallbacks, type RealtimeEvent } from "./realtime";
export {
  fetchScenarioList,
  fetchScenarioData,
  saveProgress,
  streamAIReview,
} from "./scenario-api";

// ── 新：SDK ──
export { BaseClient, type ClientOptions, type QueryValue } from "./base-client";
export * from "./types";

export { DataClient } from "./data-client";
export { FactorClient } from "./factor-client";
export { InferenceClient } from "./inference-client";
export { BacktestClient } from "./backtest-client";
export { TrainClient } from "./train-client";
export { MonitorClient } from "./monitor-client";
export { SessionClient, type SessionCreateRequest, type Session } from "./session-client";

// ── 一站式工厂 ──
import { DataClient } from "./data-client";
import { FactorClient } from "./factor-client";
import { InferenceClient } from "./inference-client";
import { BacktestClient } from "./backtest-client";
import { TrainClient } from "./train-client";
import { MonitorClient } from "./monitor-client";
import { SessionClient } from "./session-client";

export interface SDKBaseURLs {
  data?: string;
  feature?: string;
  train?: string;
  infer?: string;
  backtest?: string;
  monitor?: string;
  session?: string;
}

const DEFAULT_HOST = "http://localhost";
const DEFAULT_PORTS = {
  data: 8000,
  feature: 8001,
  train: 8002,
  infer: 8003,
  backtest: 8004,
  monitor: 8005,
} as const;

function resolveBaseURLs(overrides?: SDKBaseURLs): Required<SDKBaseURLs> {
  // 环境变量优先级最高（方便 Next.js 前端配置）
  const envBase = (globalThis as unknown as { process?: { env?: Record<string, string> } })
    ?.process?.env;
  const defaultBase =
    envBase?.NEXT_PUBLIC_INVESTDOJO_API_BASE ?? `${DEFAULT_HOST}`;

  const build = (svc: keyof typeof DEFAULT_PORTS) =>
    overrides?.[svc] ??
    envBase?.[`NEXT_PUBLIC_${svc.toUpperCase()}_SVC_URL`] ??
    `${defaultBase}:${DEFAULT_PORTS[svc]}`;

  return {
    data: build("data"),
    feature: build("feature"),
    train: build("train"),
    infer: build("infer"),
    backtest: build("backtest"),
    monitor: build("monitor"),
    session: overrides?.session ?? build("data"), // Epic 6 完善后单独配
  };
}

export interface InvestDojoSDK {
  data: DataClient;
  factors: FactorClient;
  training: TrainClient;
  inference: InferenceClient;
  backtests: BacktestClient;
  monitor: MonitorClient;
  sessions: SessionClient;
}

export interface SDKOptions {
  baseURLs?: SDKBaseURLs;
  token?: string | (() => string | Promise<string>);
  timeoutMs?: number;
}

export function createInvestDojoClient(opts: SDKOptions = {}): InvestDojoSDK {
  const urls = resolveBaseURLs(opts.baseURLs);
  const common = { token: opts.token, timeoutMs: opts.timeoutMs };
  return {
    data: new DataClient({ baseURL: urls.data, ...common }),
    factors: new FactorClient({ baseURL: urls.feature, ...common }),
    training: new TrainClient({ baseURL: urls.train, ...common }),
    inference: new InferenceClient({ baseURL: urls.infer, ...common }),
    backtests: new BacktestClient({ baseURL: urls.backtest, ...common }),
    monitor: new MonitorClient({ baseURL: urls.monitor, ...common }),
    sessions: new SessionClient({ baseURL: urls.session, ...common }),
  };
}
