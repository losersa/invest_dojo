/**
 * InvestDojo TypeScript SDK
 *
 * Base URL 约定（开发环境）：
 * - data-svc:     http://localhost:10006
 * - feature-svc:  http://localhost:10001
 * - train-svc:    http://localhost:10002
 * - infer-svc:    http://localhost:10003
 * - backtest-svc: http://localhost:10004
 * - monitor-svc:  http://localhost:10005
 *
 * 注意：Windows WinNAT 保留了 7981-8080 端口段，原 8001-8006 无法被原生进程绑定，
 * 故本地开发统一使用 10001-10006。
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
  data: 10006,
  feature: 10001,
  train: 10002,
  infer: 10003,
  backtest: 10004,
  monitor: 10005,
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
  /** 当前用户 id，写接口（因子 CRUD / 发布等）会带到 X-User-Id header */
  userId?: string | (() => string | undefined);
  timeoutMs?: number;
  /** 自定义 fetch（浏览器内用于同源代理重写） */
  fetchImpl?: typeof fetch;
}

export function createInvestDojoClient(opts: SDKOptions = {}): InvestDojoSDK {
  const urls = resolveBaseURLs(opts.baseURLs);
  const common = { token: opts.token, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl };
  return {
    data: new DataClient({ baseURL: urls.data, ...common }),
    factors: new FactorClient({ baseURL: urls.feature, ...common, userId: opts.userId }),
    training: new TrainClient({ baseURL: urls.train, ...common }),
    inference: new InferenceClient({ baseURL: urls.infer, ...common }),
    backtests: new BacktestClient({ baseURL: urls.backtest, ...common }),
    monitor: new MonitorClient({ baseURL: urls.monitor, ...common }),
    sessions: new SessionClient({ baseURL: urls.session, ...common }),
  };
}
