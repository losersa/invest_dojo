/** 监控类型 */
export interface ServiceHealth {
  name: string;
  url: string;
  port: number;
  role: string;
  status: "ok" | "down" | "timeout" | "error";
  status_code?: number;
  latency_ms?: number;
  version?: string;
  env?: string;
  error?: string;
  message?: string;
}

export interface InfraHealth {
  redis: { status: "ok" | "down" };
  minio: { status: "ok" | "down" };
  supabase: { status: "ok" | "down" };
}

export interface StatsData {
  symbols?: number;
  industries?: number;
  scenarios?: number;
  news?: number;
  market_snapshots?: number;
  factor_definitions?: number;
  training_jobs_total?: number;
  training_jobs_running?: number;
  training_jobs_completed?: number;
  backtests_total?: number;
  backtests_completed?: number;
  fundamentals?: number;
  [key: string]: number | undefined;
}

export interface SystemOverview {
  summary: {
    overall: "ok" | "degraded" | "down";
    infra_down: string[];
    services_down: string[];
    services_total: number;
    services_ok: number;
  };
  infrastructure: InfraHealth;
  services: ServiceHealth[];
  stats: StatsData;
}
